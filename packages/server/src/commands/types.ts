/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * server 侧斜杠命令层的类型契约。
 *
 * 为什么单独立一层而不直接塞进 server.ts：
 *   - server.ts 已有 1600+ 行，且其消息帧 handler 是「一帧一能力」的形态；
 *     斜杠命令是「一个入口路由 N 个能力」，需要自己的注册表与解析器。
 *   - 命令实现只依赖 CommandHost 这个窄接口（由 OttoServer 用闭包拼装），
 *     不反向 import OttoServer——单测时用假 host 即可全链路覆盖。
 *
 * 与 CLI 命令层（packages/cli/src/ui/commands/types.ts 的 9 种返回类型）不同，
 * 这里刻意收敛为两种结果：markdown（渲染成聊天区系统气泡）与 submit_prompt
 * （转投喂给模型跑一轮）。dialog/switch_session 等 TUI 交互形态在桌面端由
 * renderer 的本地面板命令承担，不进 server。
 */

import type { Config as CoreConfig } from 'otto-core';
import type { SessionStore } from '../sessions.js';
import type {
  ExtensionSummary,
  McpServerInfo,
  ModelInfo,
  StatsSnapshot,
} from '../protocol.js';

/**
 * 命令执行所需的宿主能力（OttoServer 在 handleRunSlashCommand 里用闭包拼装）。
 * 保持窄接口：命令只拿得到它声明需要的东西，便于测试与防止随手耦合 server 内部。
 */
export interface CommandHost {
  store: SessionStore;
  serverVersion: string;
  protocolVersion: string;
  /** server 已运行时长（ms）。 */
  uptimeMs(): number;
  /** server 的工作目录（项目级 OTTO.md / wiki 等文件的落点）。 */
  cwd(): string;
  /** 取某会话已构建的 core Config；懒构建尚未发生时返回 undefined（不强制初始化）。 */
  getConfig(sessionId: string): CoreConfig | undefined;
  /** 当前生效模型 id（preferredModel → 首个 enabled），无模型时 undefined。 */
  currentModel(): string | undefined;
  /** 可用模型列表（BYO-key）。 */
  modelInfos(): ModelInfo[];
  /** 进程级用量统计（与 get_stats 帧同源）。 */
  statsSnapshot(): StatsSnapshot;
  /** MCP 服务器配置 + 实时连接状态（与 mcp_list 帧同源）。 */
  mcpServerInfos(): McpServerInfo[];
  /** 已安装扩展（项目级 + 全局，与 get_extensions 帧同源）。 */
  extensionSummaries(): Promise<ExtensionSummary[]>;
}

/** 命令执行上下文。 */
export interface CommandContext {
  host: CommandHost;
  sessionId: string;
}

/** 结果一：markdown 文本，渲染成聊天区系统气泡。ok=false 即失败原因。 */
export interface SlashMarkdownOutcome {
  kind: 'markdown';
  ok: boolean;
  markdown: string;
}

/**
 * 结果二：把 content 当作用户消息投喂给模型跑一轮（对齐 CLI submit_prompt
 * 返回类型，如 /init 生成 OTTO.md）。note 是先行回执的 markdown。
 */
export interface SlashSubmitPromptOutcome {
  kind: 'submit_prompt';
  content: string;
  note: string;
}

export type SlashOutcome = SlashMarkdownOutcome | SlashSubmitPromptOutcome;

/** 一条 server 侧斜杠命令（可带子命令；子命令名取 args 的首个空白分隔 token）。 */
export interface ServerSlashCommand {
  /** 命令名（不含前导 `/`，全小写）。 */
  name: string;
  /** 一句话说明（面板右侧灰字 / usage 列表用）。 */
  description: string;
  /** 用法提示，如 'kb add|search|list|remove …'。 */
  usage?: string;
  subCommands?: ServerSlashCommand[];
  /**
   * 执行体。父命令可无 action（纯子命令容器，bare 调用返回用法说明）。
   * args 是已剥掉命令名（及子命令名）后的原始参数串（trim 过）。
   */
  action?: (
    ctx: CommandContext,
    args: string,
  ) => Promise<SlashOutcome> | SlashOutcome;
}

/** 便捷构造：成功 markdown。 */
export function md(markdown: string): SlashMarkdownOutcome {
  return { kind: 'markdown', ok: true, markdown };
}

/** 便捷构造：失败 markdown（人类可读的原因，渲染层加警示样式）。 */
export function fail(markdown: string): SlashMarkdownOutcome {
  return { kind: 'markdown', ok: false, markdown };
}
