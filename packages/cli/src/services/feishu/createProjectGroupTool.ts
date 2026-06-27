/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `create_project_and_group_chat` tool: lets the main agent set up a local
 * project directory + a dedicated Feishu group chat in one shot, optionally
 * pre-binding the group's default delegate agent (Claude Code or Codex).
 *
 * Extracted to its own module (rather than sitting inline in feishuCommand.ts)
 * so it can be unit-tested with mocked gateway/fs.
 */

import { Type } from '@google/genai';
import { BaseTool, Icon, type ToolResult, isExternalAgentType } from 'otto-core';
import { FeishuGateway } from './gateway.js';
import { probeCredentials } from './registration.js';
import {
  SENSITIVE_GROUP_MSG_SCOPE,
  buildScopeApplyUrl,
  buildEventSubUrl,
  buildPermissionPageUrl,
  type LarkBrand,
} from './scopes.js';
import {
  agentDisplayLabel,
  type FeishuDelegateAgent,
} from './delegateDirective.js';
import { dlog, dwarn } from './logger.js';

export interface CreateProjectGroupParams {
  project_path: string;
  group_name: string;
  /**
   * Optional: when set, the newly created group's default delegate agent is
   * pre-bound to this value. Messages in the group will be forcibly routed
   * to `delegate_to_agent(agent=...)`. Omit to leave the group bound
   * to Otto itself (the default).
   */
  agent?: FeishuDelegateAgent;
}

/**
 * Callback the tool fires after the group is created and the workspace has
 * been bound. The host wires this to persist the route + emit a refresh
 * event. The optional `agent` is the delegate agent to pre-bind.
 */
export type OnProjectGroupCreated = (
  chatId: string,
  path: string,
  agent?: FeishuDelegateAgent,
) => Promise<void>;

export interface CreateProjectGroupToolDeps {
  gateway: FeishuGateway;
  getSenderOpenId: () => string | undefined;
  /** Returns the current private-chat id (for sending follow-up scope warnings). */
  getActiveChatId: () => string | null;
  onProjectCreated: OnProjectGroupCreated;
  /**
   * Filesystem injectable for tests. Defaults to node:fs. Only the two
   * methods we actually use are required.
   */
  fs?: {
    existsSync(p: string): boolean;
    mkdirSync(p: string, opts: { recursive: boolean }): unknown;
  };
}

const TOOL_DESCRIPTION = [
  'Creates a new local project directory AND a dedicated Feishu group chat in one step:',
  'creates the directory, creates the group, invites the current user, binds the workspace route,',
  'and sends a welcome message. Use this tool when the user wants to set up a project workspace',
  'with a bound Feishu group (e.g. "拉个群", "建个项目群", "create a project group").',
  '',
  'AGENT BINDING (optional):',
  '- Omit `agent` to bind the group to Otto itself (default — messages handled by the main agent).',
  '- Pass `agent: "claude-code"` when the user explicitly wants a Claude Code group',
  '  (e.g. "拉个 cc 群 D:\\proj", "拉个 claudecode 群", "建个 claude code 群").',
  '- Pass `agent: "codex"` when the user explicitly wants a Codex group',
  '  (e.g. "拉个 codex 群 D:\\proj", "建个 codex 群").',
  'When an agent is bound, every non-slash message in that group is auto-delegated to the agent.',
  '',
  'For creating a standalone Feishu group chat WITHOUT a local project directory or workspace binding,',
  'use lark_cli with command="im +chat-create" instead. Only available in direct/P2P chat.',
].join(' ');

export class CreateProjectGroupTool extends BaseTool<
  CreateProjectGroupParams,
  ToolResult
> {
  static readonly Name = 'create_project_and_group_chat';

  constructor(private readonly deps: CreateProjectGroupToolDeps) {
    super(
      CreateProjectGroupTool.Name,
      'CreateProjectAndGroupChat',
      TOOL_DESCRIPTION,
      Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          project_path: {
            type: Type.STRING,
            description:
              'The absolute local physical path to create or bind, e.g. D:\\my-project',
          },
          group_name: {
            type: Type.STRING,
            description: 'The name for the newly created group chat',
          },
          agent: {
            type: Type.STRING,
            enum: ['claude-code', 'codex'],
            description:
              'Optional delegate agent to pre-bind. Use "claude-code" for Claude Code, "codex" for Codex. Omit for the default (Otto self).',
          },
        },
        required: ['project_path', 'group_name'],
      },
    );
  }

  validateToolParams(params: CreateProjectGroupParams): string | null {
    if (!params?.project_path || typeof params.project_path !== 'string') {
      return 'Parameter "project_path" must be a non-empty string.';
    }
    if (!params?.group_name || typeof params.group_name !== 'string') {
      return 'Parameter "group_name" must be a non-empty string.';
    }
    if (params.agent !== undefined) {
      if (!isExternalAgentType(params.agent)) {
        return 'Parameter "agent" must be "claude-code" or "codex" when provided.';
      }
    }
    return null;
  }

  async execute(
    params: CreateProjectGroupParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: ${validationError}`,
        returnDisplay: `Error: ${validationError}`,
      };
    }

    const { gateway, getSenderOpenId, getActiveChatId, onProjectCreated } =
      this.deps;
    const senderOpenId = getSenderOpenId();
    if (!senderOpenId) {
      return {
        llmContent:
          'Error: Cannot create group chat because the sender openId is unknown.',
        returnDisplay: 'Error: Sender unknown',
      };
    }

    try {
      const fs = this.deps.fs ?? (await import('node:fs'));
      const path = await import('node:path');

      // 1. Resolve and ensure the local project directory exists.
      //
      // 防目录穿越：project_path 的契约是「绝对物理路径」（如 D:\my-project 或
      // /home/me/proj）。但模型可能传入含 ".." 的相对路径，path.resolve 会把它
      // 锚定到 process.cwd() 之上从而逃逸出工作目录。因此：
      //   - 接受 POSIX 或 Windows 任一约定下的绝对路径（跨平台原样放行，
      //     不破坏「在任意指定绝对路径建项目」这一既有功能）；
      //   - 其余视为相对路径，解析后必须落在工作目录（intended root）之内，
      //     否则拒绝，避免在预期根目录外创建目录。
      const rawPath = params.project_path;
      const isAbsoluteInput =
        path.win32.isAbsolute(rawPath) || path.posix.isAbsolute(rawPath);

      let absPath: string;
      if (isAbsoluteInput) {
        absPath = path.resolve(rawPath);
      } else {
        const root = path.resolve(process.cwd());
        const resolved = path.resolve(root, rawPath);
        const rel = path.relative(root, resolved);
        const escapesRoot =
          rel === '..' ||
          rel.startsWith(`..${path.sep}`) ||
          path.isAbsolute(rel);
        if (escapesRoot) {
          return {
            llmContent: `Error: project_path '${rawPath}' resolves outside the working directory and was rejected. Provide an absolute path (e.g. D:\\my-project) or a path within the workspace.`,
            returnDisplay: 'Error: invalid project_path (path traversal)',
          };
        }
        absPath = resolved;
      }

      if (!fs.existsSync(absPath)) {
        fs.mkdirSync(absPath, { recursive: true });
        dlog(`[CreateProjectGroupTool] Created folder: ${absPath}`);
      }

      // 2. Create the Feishu group and invite the current user.
      const newChatId = await gateway.createGroupChat(
        params.group_name,
        senderOpenId,
      );
      if (!newChatId) {
        return {
          llmContent: `Error: Feishu open platform failed to create group chat '${params.group_name}'.`,
          returnDisplay: 'Error creating Feishu chat',
        };
      }

      // 3. Persist the route (path + optional pre-bound agent).
      await onProjectCreated(newChatId, absPath, params.agent);

      // 4. Send a welcome message to the new group, mentioning the bound
      //    delegate agent when present so users know messages will route
      //    elsewhere.
      const agentLine = params.agent
        ? `\n🤖 默认派发方：**${agentDisplayLabel(params.agent)}**（本群所有非命令消息都将自动派发到该 agent 执行）。`
        : '';
      const welcomeMsg =
        `👋 您好！本群项目工作目录 \`${absPath}\` 已经成功就绪。${agentLine}\n` +
        `现在您可以随时在这个专属项目群里直接提问，我将全力为您服务！`;
      await gateway.sendMessage(newChatId, welcomeMsg);

      // 5. Async scope check + warning DM if the bot lacks group-msg scope.
      const privateChatId = getActiveChatId();
      if (privateChatId) {
        void (async () => {
          try {
            const brand = gateway.getDomain() as LarkBrand;
            const probe = await probeCredentials(
              gateway.getAppId(),
              gateway.getAppSecret(),
              gateway.getDomain(),
            );
            if (
              probe &&
              (!probe.grantedScopes ||
                !probe.grantedScopes.includes(SENSITIVE_GROUP_MSG_SCOPE))
            ) {
              const applyUrl = buildScopeApplyUrl({
                appId: gateway.getAppId(),
                scopes: [SENSITIVE_GROUP_MSG_SCOPE],
                brand,
                tokenType: 'tenant',
              });
              const eventSubUrl = buildEventSubUrl({
                appId: gateway.getAppId(),
                brand,
              });
              const permissionPageUrl = buildPermissionPageUrl({
                appId: gateway.getAppId(),
                brand,
              });

              const warningMsg =
                `💬 **【重要体验提示 — 免 @ 权限】**\n\n` +
                `您刚才成功创建了项目群「${params.group_name}」。\n\n` +
                `⚠️ **检测到您的 Bot 尚未开通「读取关联群聊内所有消息」敏感权限（\`${SENSITIVE_GROUP_MSG_SCOPE}\`）。**\n` +
                `由于飞书平台限制，如果您不开通此权限，您在此群里提问时**每次消息都必须强制 @ 机器人**，体验较为繁琐。\n\n` +
                `💡 **建议您一键申请开通此免 @ 权限（无需中断当前体验）：**\n` +
                `  1️⃣ **第一步：一键申请权限（自动预选）**\n` +
                `     👉 ${applyUrl}\n` +
                `  2️⃣ **第二步：在事件订阅页确认订阅 \`im.message.receive_v1\`**\n` +
                `     👉 ${eventSubUrl}\n` +
                `  3️⃣ **第三步：在权限管理页申请发布一个版本**\n` +
                `     👉 ${permissionPageUrl}\n\n` +
                `开通后即可在群内直接对话，实现无缝协作！`;

              await gateway.sendMessage(privateChatId, warningMsg);
            }
          } catch (err: unknown) {
            dwarn(
              `[CreateProjectGroupTool] Check scopes or send warning failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
      }

      const agentSuffix = params.agent ? ` (bound to ${params.agent})` : '';
      return {
        llmContent:
          `Successfully created project directory at '${absPath}', and created dedicated Feishu group chat '${params.group_name}' with ID '${newChatId}'${agentSuffix}. ` +
          `Invited user and sent setup ready notification into the group successfully.`,
        returnDisplay: `Successfully created project and group chat ${params.group_name}${agentSuffix}`,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        llmContent: `Error during project creation and binding: ${message}`,
        returnDisplay: `Error: ${message}`,
      };
    }
  }
}
