/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BaseTool, ToolResult, Icon, isWithinRoot } from 'otto-core';
import { Type } from '@google/genai';
import { FeishuGateway } from './gateway.js';

/** Maximum allowed upload size: 50 MiB. Beyond this we refuse. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Reject extensions that are almost never legitimate to share via Feishu and
 * are common attack vectors (executables, dynamic libraries, scripts).
 */
const REJECTED_EXTS = new Set<string>([
  // Windows executables / installers
  'exe', 'dll', 'bat', 'cmd', 'ps1', 'msi', 'scr', 'com',
  // Unix executables / scripts
  'so', 'dylib', 'sh', 'bash', 'zsh', 'fish',
  // Other attack-prone formats
  'jar', 'class', 'msp', 'msc',
]);

const IMAGE_EXTS = new Set<string>([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp',
]);

export interface SendFeishuFileParams {
  /**
   * Path to the file to send. Must be inside the project root (the directory
   * otto was launched from). Relative paths are resolved against the project
   * root. Absolute paths must lie inside the project root.
   */
  file_path: string;

  /**
   * The chat_id to send the file to. If not provided, sends to the current
   * active chat that triggered the agent loop. Restricted by authorization
   * rules upstream.
   */
  chat_id?: string;

  /**
   * Whether the user explicitly confirmed sending this file.
   */
  user_confirmed?: boolean;
}

/**
 * Dynamically registered tool: send_feishu_file
 *
 * Only registered when /feishu start runs, unregistered on /feishu stop.
 * Sandboxed to the project root, with size and extension restrictions, to
 * avoid the Bot becoming a remote file exfiltration channel.
 */
export class SendFeishuFileTool extends BaseTool<SendFeishuFileParams, ToolResult> {
  static readonly Name: string = 'send_feishu_file';

  constructor(
    private readonly gateway: FeishuGateway,
    private readonly getActiveChatId: () => string | undefined,
    private readonly getActiveReplyToMessageId: () => string | undefined,
    private readonly getProjectRoot: () => string,
  ) {
    super(
      SendFeishuFileTool.Name,
      'SendFeishuFile',
      'Sends a local file from the current project directory to the active Feishu chat. ' +
        'CRITICAL RULE: DO NOT automatically call this tool just because you read, wrote, or modified a file. ' +
        'Only use this tool when the user EXPLICITLY asks you to send, download, or transfer a file (e.g. "send me the file..."). ' +
        'For standard file reading/writing operations, just report the completion in text, do NOT call this tool.',
      Icon.Globe,
      {
        properties: {
          file_path: {
            description:
              "Path to the file to send. Either an absolute path inside the project root " +
              "or a path relative to the project root (e.g. 'docs/report.pdf').",
            type: Type.STRING,
          },
          user_confirmed: {
            description:
              "Whether the user explicitly confirmed sending this file.",
            type: Type.BOOLEAN,
          },
        },
        required: ['file_path'],
        type: Type.OBJECT,
      },
    );
  }

  validateToolParams(params: SendFeishuFileParams): string | null {
    if (!params.file_path || typeof params.file_path !== 'string') {
      return 'file_path is required and must be a string';
    }
    if (!params.user_confirmed) {
      return 'user_confirmed parameter must be true to send file. Ask user for confirmation and set this to true.';
    }
    return null;
  }

  getDescription(params: SendFeishuFileParams): string {
    return `Sending file to Feishu: ${params.file_path}`;
  }

  /**
   * Resolve and validate the requested path. Returns either a sanitized
   * absolute path or an error message describing why the request was refused.
   */
  private resolveAndValidatePath(
    rawPath: string,
  ): { abs: string } | { error: string } {
    const projectRoot = this.getProjectRoot();
    const absolute = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(projectRoot, rawPath);

    if (!fs.existsSync(absolute)) {
      return { error: `File not found: ${absolute}` };
    }

    // 关键安全修复：在做"是否在项目根目录内"的校验前，先用 realpath 解析符号
    // 链接（symlink）。否则项目内一个指向 /etc/passwd 的软链接就能绕过校验、
    // 把任意文件外泄出去。同时把项目根目录也 realpath，避免根目录本身是软链接时
    // 出现误判。
    let realAbsolute: string;
    let realProjectRoot: string;
    try {
      realAbsolute = fs.realpathSync(absolute);
      realProjectRoot = fs.realpathSync(projectRoot);
    } catch (e: unknown) {
      return { error: `Cannot resolve real path: ${(e as Error).message}` };
    }

    if (!isWithinRoot(realAbsolute, realProjectRoot)) {
      return {
        error:
          `Refused to send file outside the project root. ` +
          `Project root: ${realProjectRoot}; requested: ${realAbsolute}`,
      };
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(realAbsolute);
    } catch (e: unknown) {
      return { error: `Cannot stat file: ${(e as Error).message}` };
    }

    if (stat.isDirectory()) {
      return { error: `Path is a directory, not a file: ${realAbsolute}` };
    }
    if (!stat.isFile()) {
      return { error: `Path is not a regular file: ${realAbsolute}` };
    }
    if (stat.size > MAX_UPLOAD_BYTES) {
      const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
      return {
        error: `File too large to send (${sizeMb} MiB > 50 MiB limit): ${realAbsolute}`,
      };
    }

    const ext = path.extname(realAbsolute).slice(1).toLowerCase();
    if (REJECTED_EXTS.has(ext)) {
      return {
        error:
          `Refused to send file with executable/script extension '.${ext}'. ` +
          `Rename or repackage if you really need to share it.`,
      };
    }

    return { abs: realAbsolute };
  }

  async execute(
    params: SendFeishuFileParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    // 关键安全修复：在 agent-loop（非交互）路径上，框架不会先调用
    // validateToolParams，因此 user_confirmed 确认闸门会被绕过，模型可以
    // 在未经确认的情况下直接外泄文件。这里在 execute 内部再次强制校验，
    // 保证任何调用路径下未确认的发送都会被拒绝。
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: ${validationError}`,
        returnDisplay: `Error: ${validationError}`,
      };
    }

    const chatId = params.chat_id || this.getActiveChatId();
    if (!chatId) {
      return {
        llmContent:
          'Error: No active Feishu chat to send the file to. ' +
          'Make sure the Feishu bot is running and has received a message.',
        returnDisplay: 'Error: No active Feishu chat',
      };
    }

    const validation = this.resolveAndValidatePath(params.file_path);
    if ('error' in validation) {
      return {
        llmContent: `Error: ${validation.error}`,
        returnDisplay: `Error: ${validation.error}`,
      };
    }
    const abs = validation.abs;

    const replyToMessageId = this.getActiveReplyToMessageId();
    const ext = path.extname(abs).slice(1).toLowerCase();
    const isImage = IMAGE_EXTS.has(ext);

    try {
      if (isImage) {
        const imageKey = await this.gateway.uploadImage(abs);
        const msgId = await this.gateway.sendImage(
          chatId,
          imageKey,
          replyToMessageId,
        );
        return {
          llmContent: `Successfully sent image to Feishu: ${abs}${msgId ? ` (message_id: ${msgId})` : ''}`,
          returnDisplay: `Image sent: ${abs}`,
        };
      }
      const fileKey = await this.gateway.uploadFile(abs);
      const msgId = await this.gateway.sendFile(
        chatId,
        fileKey,
        replyToMessageId,
      );
      return {
        llmContent: `Successfully sent file to Feishu: ${abs}${msgId ? ` (message_id: ${msgId})` : ''}`,
        returnDisplay: `File sent: ${abs}`,
      };
    } catch (err: unknown) {
      const errorMsg = (err as Error)?.message || String(err);
      return {
        llmContent: `Error sending file to Feishu: ${errorMsg}`,
        returnDisplay: `Error: ${errorMsg}`,
      };
    }
  }
}
