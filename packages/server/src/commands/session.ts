/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话类命令：/compress /init。
 *   - /compress：手动压缩当前会话上下文（与 compress_context 帧同一 core 能力：
 *     OttoClient.tryCompressChat）。
 *   - /init：项目无 OTTO.md 时复用 core AcpCommands.performInit 的分析 prompt，
 *     以 submit_prompt 形态转投给模型跑一轮（真实生成文件的是 agent 本身）。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AcpCommands } from 'otto-core';
import { md, fail, type ServerSlashCommand } from './types.js';

export const compressCommand: ServerSlashCommand = {
  name: 'compress',
  description: '压缩当前会话的上下文（腾出 token 空间）',
  action: async ({ host, sessionId }) => {
    const cfg = host.getConfig(sessionId);
    const client = cfg?.getOttoClient?.();
    if (!client) {
      return fail(
        '会话运行时尚未初始化，无法压缩——先发一条消息让会话跑起来。',
      );
    }
    if (client.isCompressionInProgress()) {
      return md('已有压缩任务在进行中，请稍候。');
    }
    const info = await client.tryCompressChat(
      `${sessionId}-slash-compress-${Date.now()}`,
      new AbortController().signal,
      true,
    );
    if (!info) return md('当前上下文较小，无需压缩。');
    return md(
      `已压缩：${info.originalTokenCount.toLocaleString()} → ${info.newTokenCount.toLocaleString()} tokens`,
    );
  },
};

export const initCommand: ServerSlashCommand = {
  name: 'init',
  description: '分析当前目录并生成 OTTO.md 项目记忆',
  action: async ({ host }) => {
    const memoryPath = path.join(host.cwd(), 'OTTO.md');
    const exists = await fs
      .access(memoryPath)
      .then(() => true)
      .catch(() => false);
    const result = AcpCommands.performInit(exists);
    if (result.type === 'message') {
      // 已存在 OTTO.md：core 返回「未做改动」的说明，如实转达。
      return md(result.content);
    }
    if (result.type === 'submit_prompt') {
      return {
        kind: 'submit_prompt',
        content: result.content,
        note: `已提交项目分析任务：Otto 正在分析 \`${host.cwd()}\` 并生成 OTTO.md……`,
      };
    }
    // core 目前只会返回 message / submit_prompt；tool 形态在 server 侧无工具管线可挂。
    return fail('/init 返回了 server 侧暂不支持的动作类型。');
  },
};

export const sessionCommands: ServerSlashCommand[] = [
  compressCommand,
  initCommand,
];
