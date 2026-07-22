/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `/feishu` 命令 — otto 飞书 Bot 接入
 *
 * 子命令：
 *   /feishu           — 交互式启动（默认档 1 扫码，可选档 3 手动）
 *   /feishu setup     — 配置凭据（扫码建应用或手动输入）
 *   /feishu start     — 启动飞书 WS 长连接
 *   /feishu stop      — 停止飞书 WS 长连接
 *   /feishu status    — 查看连接状态
 *   /feishu logout    — 清除凭证
 */

import qrcodeTerminal from 'qrcode-terminal';
import { createRequire } from 'node:module';
const requireFn = createRequire(import.meta.url);
import { CommandKind, SlashCommand, SlashCommandActionReturn, CommandContext } from './types.js';
import { MessageType } from '../types.js';
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  isSenderAuthorized,
  CredentialsLoadError,
  FeishuCredentials,
} from '../../services/feishu/credentials.js';
import {
  initRegistration,
  beginRegistration,
  pollRegistration,
  probeCredentials,
} from '../../services/feishu/registration.js';
import { FeishuGateway, FeishuMessage, FeishuFooterMetrics, buildCardKitFinalCard } from '../../services/feishu/gateway.js';
import { SendFeishuFileTool } from '../../services/feishu/feishu-send-file-tool.js';
import {
  type FeishuAgentTarget,
  resolveDelegation,
  buildDelegateDirective,
  parseBindAgentFlag,
  agentDisplayLabel,
} from '../../services/feishu/delegateDirective.js';
import { handleSessionsCommand } from '../../services/feishu/sessionsCommand.js';
import { CreateProjectGroupTool } from '../../services/feishu/createProjectGroupTool.js';
import {
  detectLocalAgents,
  buildLocalAgentWelcomeHints,
} from '../../services/feishu/localAgentDetection.js';
import {
  REQUIRED_APP_SCOPES,
  REQUIRED_BUSINESS_SCOPES,
  SENSITIVE_GROUP_MSG_SCOPE,
  buildScopeApplyUrl,
  buildEventSubUrl,
  buildPermissionPageUrl,
  missingScopes,
} from '../../services/feishu/scopes.js';
import { getEncoding } from 'js-tiktoken';
import {
  executeToolCall,
  ToolRegistry,
  OttoEventType,
  ToolCallRequestInfo,
  SessionManager,
  getProjectTempDir,
  isWithinRoot,
  getVersion,
  tokenLimit,
  uiTelemetryService,
  Config,
  OttoClient,
  AuthType,
  loadServerHierarchicalMemory,
  getFeishuSessionMemoryPath,
  FileDiscoveryService,
  ProxyAuthManager,
  SettingsManager,
  MarketplaceManager,
  SkillLoader,
  getSpecificMimeType,
  AudioReaderTool,
  VideoAnalyzerTool,
  SelfUpdateTool,
  launchRelaunchHelper,
  type RelaunchInstallMode,
  runSideQuestion,
  getWorkLogger,
  type WorkLogSearchResult,
} from 'otto-core';
import { CommandService } from '../../services/CommandService.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { InlineCommandLoader } from '../../services/InlineCommandLoader.js';
import { ExtensionCommandLoader } from '../../services/ExtensionCommandLoader.js';
import { FileCommandLoader } from '../../services/FileCommandLoader.js';
import { PluginCommandLoader } from '../../services/skill/loaders/plugin-command-loader.js';
import { SettingScope } from '../../config/settings.js';
import { getAvailableModels, refreshModelsInBackground } from './modelCommand.js';
import { getCreditsService } from '../../services/creditsService.js';
import { launchGoalMode } from '../hooks/launchGoalMode.js';
import {
  buildGoalPrompt,
  type GoalWizardResult,
} from '../components/GoalWizard.js';
import { normalizeGoalFields } from './feishuGoalForm.js';
import { clampCodeBlock } from './feishuToolDisplay.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import { dlog, dwarn, derror } from '../../services/feishu/logger.js';
import { t, tp } from '../utils/i18n.js';
import { Part, PartListUnion, type Content } from '@google/genai';
import type { LoadedSettings } from '../../config/settings.js';

type UnknownRecord = Record<string, unknown>;

interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  creditsUsage?: number;
}

const WORKLOG_MEMORY_DAYS = 30;
const WORKLOG_MEMORY_LIMIT = 5;
const WORKLOG_MEMORY_CHAR_BUDGET = 1800;

function compactOneLine(value: string | undefined, max = 180): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function formatRelevantExperience(matches: WorkLogSearchResult[]): string {
  const lines = [
    `## Related historical experience`,
    `Found ${matches.length} related item(s). Use these as hints only; prefer the current request when they conflict.`,
  ];

  for (const match of matches) {
    const entry = match.entry;
    const title = compactOneLine(entry.taskTitle || entry.action || entry.toolName, 120);
    const summary = compactOneLine(entry.details || entry.userInput || entry.action, 220);
    const scope = match.scope;
    lines.push(`- [${scope} ${match.date}] ${title}${summary ? `: ${summary}` : ''}`);
  }

  const block = lines.join('\n');
  return block.length > WORKLOG_MEMORY_CHAR_BUDGET
    ? `${block.slice(0, WORKLOG_MEMORY_CHAR_BUDGET - 1)}...`
    : block;
}

function injectRelevantExperience(
  message: PartListUnion,
  experienceBlock: string,
): PartListUnion {
  const prefix = `${experienceBlock}\n\n--- Current user request ---\n`;
  if (typeof message === 'string') {
    return `${prefix}${message}`;
  }
  if (Array.isArray(message)) {
    const parts = [...message];
    const firstTextIndex = parts.findIndex(
      (part) => typeof part !== 'string' && typeof part.text === 'string',
    );
    if (firstTextIndex >= 0) {
      const first = parts[firstTextIndex];
      if (typeof first !== 'string') {
        parts[firstTextIndex] = { ...first, text: `${prefix}${first.text || ''}` };
      }
      return parts;
    }
    return [{ text: prefix }, ...parts];
  }
  return message;
}

export function buildFeishuMemoryHitNotice(matchCount: number): string {
  if (matchCount <= 0) return '';
  return `已参考 ${matchCount} 条相关历史经验。`;
}

interface TaskToolArgs {
  description?: string;
  max_turns?: number;
  todos?: TodoItemLike[];
}

interface SubAgentToolCallLike {
  status?: string;
  toolName?: string;
  description?: string;
}

interface SubAgentDisplayLike {
  stats?: {
    successfulToolCalls?: number;
    totalToolCalls?: number;
    commandsRun?: string[];
    filesCreated?: string[];
  };
  description?: string;
  status?: string;
  currentTurn?: number;
  maxTurns?: number;
  toolCalls?: SubAgentToolCallLike[];
  error?: string;
  finalResult?: string;
  summary?: string;
}

interface TelemetryLike {
  logToolCall?: (config: Config, payload: Record<string, unknown>) => void;
}

interface ConfigWithTelemetry extends Config {
  getTelemetry?: () => TelemetryLike | undefined;
}

interface TodoItemLike {
  status?: string;
  priority?: string;
  content?: string;
}

interface TodoDisplayLike {
  type?: string;
  items?: TodoItemLike[];
}

interface AskQuestionOption {
  label: string;
  description?: string;
}

interface NormalizedAskQuestion {
  question: string;
  header?: string;
  options: AskQuestionOption[];
  multiSelect?: boolean;
}

interface QrCodeTerminalLike {
  generate?: (text: string, options: { small: boolean }, callback: (qr: string) => void) => void;
  default?: QrCodeTerminalLike;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

function unknownErrorStackOrMessage(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  if (isRecord(error)) {
    if (typeof error.stack === 'string') return error.stack;
    if (typeof error.message === 'string') return error.message;
  }
  return String(error);
}

function logFeishuToolCall(config: Config, payload: Record<string, unknown>): void {
  (config as ConfigWithTelemetry).getTelemetry?.()?.logToolCall?.(config, payload);
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' ||
      error.message.includes('aborted') ||
      error.message.includes('cancelled') ||
      error.message.includes('canceled');
  }
  if (isRecord(error)) {
    const name = typeof error.name === 'string' ? error.name : '';
    const message = typeof error.message === 'string' ? error.message : '';
    return name === 'AbortError' ||
      message.includes('aborted') ||
      message.includes('cancelled') ||
      message.includes('canceled');
  }
  return false;
}

/**
 * 工具名 → 飞书展示用短名。模块级纯函数，便于单测。
 */
export function feishuGetToolShortName(name: string): string {
  switch (name) {
    case 'run_shell_command': return 'Bash';
    case 'read_file': return 'ReadFile';
    case 'read_many_files': return 'ReadManyFiles';
    case 'write_file': return 'WriteFile';
    case 'delete_file': return 'DeleteFile';
    case 'replace': return 'Replace';
    case 'multiedit': return 'MultiEdit';
    case 'patch': return 'Patch';
    case 'batch': return 'Batch';
    case 'ppt_outline': return 'PPTOutline';
    case 'ppt_generate': return 'PPTGenerate';
    case 'codesearch': return 'CodeSearch';
    case 'lsp': return 'LSP';
    case 'glob': return 'Glob';
    case 'grep': return 'Grep';
    case 'search_file_content': return 'SearchContent';
    case 'web_search': return 'WebSearch';
    case 'web_fetch': return 'WebFetch';
    case 'todo_write': return 'TodoWrite';
    case 'task': return 'SubAgentTask';
    case 'use_skill': return 'UseSkill';
    case 'delegate_to_agent': return 'DelegateAgent';
    default: {
      return name.split(/[-_]+/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
    }
  }
}

/**
 * 把项目路径缩短为「.../<父目录>/<目录>」，跨平台（兼容 Windows 反斜杠）。
 *
 * 路径段 <= 2 时原样返回；空输入返回空串。模块级纯函数，便于单测，
 * 同时供 /feishu status 文本与 TUI Dashboard 复用同一套缩短逻辑。
 */
export function shortenProjectPath(p?: string): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p;
}

/**
 * 安全截断日志中文本，防止超长系统提示词/契约泄露在 TUI 终端，同时保持日志可读性并避免多行打乱排版。
 */
export function safeTruncateForLog(text?: string, limit = 150): string {
  if (!text) return '';
  const trimmed = text.trim();
  // 替换换行符为空格，避免多行输出破坏终端排版，并截断
  const singleLine = trimmed.replace(/\r?\n/g, ' ');
  if (singleLine.length <= limit) return singleLine;
  return singleLine.slice(0, limit) + `... (truncated, total ${trimmed.length} chars)`;
}

/**
 * 把异常清洗成可安全展示给飞书终端用户的简短消息：取首行、去掉绝对文件系统路径
 * （POSIX `/a/b/c` 与 Windows `C:\a\b`）等可能泄露服务端内部结构 / 栈细节的片段，
 * 并截断长度。完整错误（含栈）请在调用处用 derror 落服务端日志，不外发给用户。
 *
 * 模块级纯函数，便于单测。
 */
export function sanitizeErrorForUser(err: unknown, limit = 200): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : unknownErrorMessage(err);
  // 仅取首行，丢弃多行栈痕迹
  let msg = (raw || '').split(/\r?\n/)[0].trim();
  // 抹去疑似绝对路径，避免泄露服务端目录结构
  msg = msg
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>') // Windows 绝对路径
    .replace(/(?<![\w-])\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>'); // POSIX 绝对路径
  if (!msg) return '未知错误';
  return msg.length > limit ? msg.slice(0, limit) + '…' : msg;
}

/**
 * 渲染 /feishu status 里的「绑定项目」段落（纯文本行数组）。
 *
 * 设计为模块级纯函数，便于单测，且不依赖运行时网关/凭证状态。群名解析
 * 由调用方提前完成后通过 `chatNames` 传入：
 *  - p2p 单聊（与 Bot 的私聊）→ 显示「与机器人 X 的私聊」友好文案；
 *  - 有群名 → 主显示群名，并在括号内补充 chatId 方便排查；
 *  - 无群名（无权限 / 未解析的群）→ 直接显示 chatId（fallback）。
 *
 * 关于 p2p 判定：飞书 p2p 单聊与群聊的 chatId 都是 `oc_` 前缀，且 p2p 无群名，
 * 仅靠"群名是否解析得出"会把无名群/无权限群误判为私聊。因此 p2p 集合由调用方
 * 通过飞书 chat_mode 字段精确判定后传入（`p2pChatIds`），此处不做任何猜测。
 *
 * 活跃语义 = 「当前正在干活（Agent 仍在处理）」的群，可同时有多个。通过
 * `activeChatIds` 集合传入，命中的群以 🟢 前缀 + (Active) 后缀高亮。
 *
 * @param routes      feishu-projects.json 的路由表（chatId → { projectRoot }）
 * @param options.activeChatIds 当前正在干活的群 chatId 集合（Set 或数组，可空）
 * @param options.chatNames    chatId → 群名 的解析结果（可空）
 * @param options.p2pChatIds   经 chat_mode 判定为 p2p 单聊的 chatId 集合（Set 或数组，可空）
 * @param options.botName      Bot 名称，用于私聊文案「与机器人 X 的私聊」（可空）
 * @returns 可直接 join('\n') 的文本行数组
 */
export function buildBoundProjectsLines(
  routes: Record<string, { projectRoot?: string }>,
  options?: {
    activeChatIds?: Set<string> | string[] | null;
    chatNames?: Record<string, string>;
    p2pChatIds?: Set<string> | string[] | null;
    botName?: string;
  },
): string[] {
  const entries = Object.entries(routes || {});
  const activeSet =
    options?.activeChatIds instanceof Set
      ? options.activeChatIds
      : new Set(options?.activeChatIds ?? []);
  const p2pSet =
    options?.p2pChatIds instanceof Set
      ? options.p2pChatIds
      : new Set(options?.p2pChatIds ?? []);
  const chatNames = options?.chatNames ?? {};
  const botName = options?.botName?.trim();

  const lines: string[] = [tp('feishu.status.bound_projects_title', { count: entries.length })];

  if (entries.length === 0) {
    lines.push(t('feishu.status.bound_projects_none'));
    return lines;
  }

  lines.push('');
  lines.push(`| ${t('feishu.status.col_chat')} | ${t('feishu.status.col_path')} |`);
  lines.push('| :--- | :--- |');

  for (const [chatId, route] of entries) {
    const isActive = activeSet.has(chatId);
    const name = chatNames[chatId];
    // 主显示名优先级：p2p 单聊文案 > 群名(附 chatId) > 裸 chatId。
    // p2p 判定优先于群名，避免上游误传 name 时把私聊显示成群名。
    let display: string;
    if (p2pSet.has(chatId)) {
      display = botName
        ? tp('feishu.status.p2p_chat_label', { bot: botName })
        : t('feishu.status.p2p_chat_label_unknown');
    } else if (name) {
      display = `${name} (${chatId})`;
    } else {
      display = chatId;
    }
    if (isActive) {
      display = `🟢 ${display} ${t('feishu.status.bound_active_suffix')}`;
    }
    const pathPart = route?.projectRoot
      ? `\`${shortenProjectPath(route.projectRoot)}\``
      : '-';
    lines.push(`| ${display} | ${pathPart} |`);
  }

  return lines;
}

/**
 * 拦截飞书侧发来的 `/feishu start` 和 `/feishu stop` 生命周期命令。
 *
 * 这两个命令管理的是「本地终端里那个正在转发飞书消息的网关进程」本身：
 *  - `/feishu stop` 会停掉转发当前消息的网关 → 自断连接，且无法再从飞书侧重启；
 *  - `/feishu start` 在已运行时无意义，且飞书端拿不到扫码 / TUI 交互。
 *
 * 因此它们只应在 **本地 otto 终端** 执行。在飞书里收到时直接拦截并给友好提示，
 * 不透传给 CLI 命令处理器真正执行。
 *
 * 命中（start/stop）返回提示文本；否则（含 `/feishu status` 等其它子命令）返回 null。
 *
 * @param messageText 已剥除 @bot 提及前缀的消息文本
 * @returns 友好提示字符串；非生命周期命令时为 null
 */
export function interceptFeishuLifecycleCommand(messageText: string): string | null {
  const m = messageText.trim().match(/^\/(?:feishu|飞书)\s+(start|stop)\b/i);
  if (!m) return null;
  const sub = m[1].toLowerCase();
  return sub === 'stop'
    ? t('feishu.lifecycle.stop_blocked')
    : t('feishu.lifecycle.start_blocked');
}

/**
 * 构建子代理（task 工具）在飞书卡片中的进度/结果展示框。
 *
 * 对齐主 CLI/TUI 行为：展示任务状态、轮次、工具调用次数、当前执行工具，
 * 任务结束后展示最终摘要。
 *
 * 安全约束：**绝不展示 taskDescription（其实为完整 prompt，含子代理系统规则）
 * 或 args.prompt**，仅使用简短的 description。
 *
 * @param subagentData 解析自 subagent_update / subagent_display 的 SubAgentDisplay 对象，可能为空
 * @param args task 工具调用参数（description / prompt / max_turns）
 * @param isLive 是否运行中（true 时不展示最终摘要，避免刷屏）
 */
export function buildSubAgentDisplayBox(
  subagentData: SubAgentDisplayLike | null | undefined,
  args: TaskToolArgs | null | undefined,
  isLive: boolean,
): string {
  if (!subagentData) {
    // 尚无结构化进度数据（task 刚启动）：显示占位进度，绝不显示 prompt。
    const desc = (args && args.description) || '无';
    return `\n📊 **子代理任务 (Sub-Agent Task)**\n────────────────────────\n• 任务状态: **🔄 启动中**\n• 任务描述: ${desc}\n────────────────────────`;
  }

  const stats = subagentData.stats || {};
  // ⚠️ taskDescription 实为完整 prompt（含子代理系统规则），绝不展示；
  //    仅用简短的 description（3-5 词）。对齐主 CLI/TUI 行为。
  const desc = subagentData.description || (args && args.description) || '无';
  // status 取值: starting | running | completed | failed | cancelled
  const status = subagentData.status;
  const statusText =
    status === 'completed' ? '✅ 成功'
    : status === 'failed' ? '❌ 失败'
    : status === 'cancelled' ? '🚫 已取消'
    : status === 'starting' ? '🔄 启动中'
    : '⏳ 运行中';
  // 运行中时，找出当前正在执行的子工具，给出"实时感"
  const toolCalls: SubAgentToolCallLike[] = Array.isArray(subagentData.toolCalls) ? subagentData.toolCalls : [];
  const executing = toolCalls.find(
    (tc) => tc.status === 'Executing' || tc.status === 'Pending' || tc.status === 'SubAgentRunning',
  );

  const statsLines = [
    `📊 **子代理执行报告 (Sub-Agent Task Report)**`,
    `────────────────────────`,
    `• 任务状态: **${statusText}**`,
    `• 任务描述: ${desc}`,
    `• 执行轮数: ${subagentData.currentTurn || 0} / ${subagentData.maxTurns || (args && args.max_turns) || 10}`,
    `• 工具调用: 成功 ${stats.successfulToolCalls || 0} 次 / 共 ${stats.totalToolCalls || 0} 次`,
    executing ? `• 当前工具: ⏳ ${executing.toolName ? feishuGetToolShortName(executing.toolName) : '未知工具'}${executing.description ? ` (${executing.description})` : ''}` : '',
    stats.commandsRun && stats.commandsRun.length > 0 ? `• 运行命令: \`${stats.commandsRun.join(', ')}\`` : '',
    stats.filesCreated && stats.filesCreated.length > 0 ? `• 创建文件: \`${stats.filesCreated.join(', ')}\`` : '',
  ];
  if (subagentData.error) {
    statsLines.push(`• 错误信息: <font color='red'>${subagentData.error}</font>`);
  }
  statsLines.push(`────────────────────────`);
  // 最终摘要存于 summary（非 report）；仅在任务结束时展示，运行中不刷屏。
  const summary = subagentData.summary || '';
  if (!isLive && summary) {
    statsLines.push(`📝 **最终研究分析报告**:`, `\`\`\`markdown\n${summary}\n\`\`\``);
  }
  return `\n${statsLines.filter(Boolean).join('\n')}`;
}

/** 当前全局网关实例（进程内单例） */
let activeGateway: FeishuGateway | null = null;
let feishuLoopInterval: NodeJS.Timeout | null = null;

/**
 * 飞书 bot 是否真正在运行（网关已构建且 /feishu start 成功，连接已建立）。
 * 供 daemon 子进程在自启完成后回报真实健康状态，避免「进程活着但 bot 没连上」
 * 被 daemon status 谎报为运行中。
 */
export function isFeishuRunning(): boolean {
  return activeGateway !== null;
}

/**
 * handleStart 的并发互斥守卫。activeGateway 只在 gateway.connect() 完成后才被赋值，
 * 单凭 `if (activeGateway)` 无法防止两次并发 start 都通过检查、各自打开一条 WS
 * 长连接（第一条被孤立，导致消息双发）。此标志在进入连接流程前置位、在 finally 中清除，
 * 确保同一时刻只有一个 start 真正进行连接。
 */
let startInFlight = false;

/** 正在处理的飞书消息计数器 */
let activeProcessingCount = 0;
/** 当前正在处理的群组 Chat ID 集合 */
const processingChatIds = new Set<string>();

function incrementProcessingCount(chatId?: string) {
  activeProcessingCount++;
  if (chatId && !processingChatIds.has(chatId)) {
    processingChatIds.add(chatId);
    appEvents.emit(AppEvent.FeishuGroupProcessingStart, chatId);
  }
  if (activeProcessingCount === 1) {
    appEvents.emit(AppEvent.FeishuBotProcessingStart);
  }
}

function decrementProcessingCount(chatId?: string) {
  activeProcessingCount = Math.max(0, activeProcessingCount - 1);
  if (chatId && processingChatIds.has(chatId)) {
    processingChatIds.delete(chatId);
    appEvents.emit(AppEvent.FeishuGroupProcessingEnd, chatId);
  }
  if (activeProcessingCount === 0) {
    appEvents.emit(AppEvent.FeishuBotProcessingEnd);
  }
}

function resetProcessingCount() {
  if (activeProcessingCount > 0) {
    // 通知所有活跃群处理结束
    for (const chatId of processingChatIds) {
      appEvents.emit(AppEvent.FeishuGroupProcessingEnd, chatId);
    }
    processingChatIds.clear();
    activeProcessingCount = 0;
    appEvents.emit(AppEvent.FeishuBotProcessingEnd);
  }
}

/** 发送飞书消息日志到仪表板 */
function emitFeishuMessageLog(chatId: string, text: string, direction: 'in' | 'out' | 'tool') {
  appEvents.emit(AppEvent.FeishuMessageLog, chatId, text, direction, Date.now());
}

/** 发送项目路由更新事件，并异步解析群名后发送群名事件 */
function emitFeishuProjectRoutesUpdated() {
  loadProjectRoutes().then(routes => {
    appEvents.emit(AppEvent.FeishuProjectRoutesUpdated, routes);
    // 🔗 异步解析群名（Bot 运行中才有 token），解析完成后通知 Dashboard 用群名替代 chatId。
    // 失败/无权限不影响主流程，Dashboard 自动 fallback 到 chatId 展示。
    void resolveAndEmitChatNames(Object.keys(routes));
  }).catch(() => {
    // 静默失败
  });
}

/**
 * 批量解析飞书群名 + 会话类型，并通过事件推给 TUI Dashboard。
 *
 * 仅在 Bot 运行中（activeGateway 存在）时执行；getChatName / getChatMode 共用
 * 进程内缓存（同一次 chats/{id} 请求填充），重复调用开销极小。单个解析失败被
 * allSettled 吞掉，不影响其它会话。
 *
 * 解析结果分两路 emit：
 *  - FeishuChatNamesResolved：chatId → 群名（仅有群名的）
 *  - FeishuP2pChatsResolved：chat_mode='p2p' 的 chatId 列表（与 Bot 的私聊）
 */
async function resolveAndEmitChatNames(chatIds: string[]): Promise<void> {
  if (!activeGateway || chatIds.length === 0) return;
  const chatNames: Record<string, string> = {};
  const p2pChatIds: string[] = [];
  await Promise.allSettled(
    chatIds.map(async (chatId) => {
      const [name, mode] = await Promise.all([
        activeGateway!.getChatName(chatId),
        activeGateway!.getChatMode(chatId),
      ]);
      if (name) chatNames[chatId] = name;
      if (mode === 'p2p') p2pChatIds.push(chatId);
    }),
  );
  if (Object.keys(chatNames).length > 0) {
    appEvents.emit(AppEvent.FeishuChatNamesResolved, chatNames);
  }
  if (p2pChatIds.length > 0) {
    appEvents.emit(AppEvent.FeishuP2pChatsResolved, p2pChatIds);
  }
}

/**
 * ask_user_question 在飞书侧等待用户作答的超时时间（毫秒）。
 *
 * CLI 原生的 ask_user_question 工具无任何超时——终端对话框会无限期等待用户。
 * 飞书侧无法真正无限等待（常驻 Promise 会占内存、AI 任务会僵死），因此给一个
 * 很长但有限的超时：30 分钟，给足用户看消息和思考的时间，同时避免永久挂起。
 */
const FEISHU_ASK_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;

/** TUI 上下文引用（用于同步显示飞书消息到 UI） */
let tuiContext: CommandContext['ui'] | null = null;

/** 当前活跃的飞书会话信息（用于 send_feishu_file 工具发送文件） */
let activeChatId: string | null = null;
let activeReplyToMessageId: string | null = null;

/** 各会话的最新消息 ID (用于文件发送工具，完全线程安全，多群独立) */
const chatLastMessageId = new Map<string, string>();

/** 各会话当前活跃的发送者 OpenID */
const activeSenderOpenIds = new Map<string, string>();

/** 各会话独立运行任务的中止控制器 (完全并发安全，允许不同群独立 /stop 中止) */
const activeAbortControllers = new Map<string, AbortController>();

/** 各会话最后一笔成功交易的 Token 使用量 */
const chatLastTokenUsage = new Map<string, TokenUsageLike>();

/** 全局命令上下文引用 */
let globalCommandContext: CommandContext | null = null;

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface FeishuProjectRoute {
  projectRoot?: string;
  description?: string;
  model?: string;
  thinking?: {
    mode: 'on' | 'off' | 'auto';
    effort?: 'auto' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  };
  /**
   * Default agent for this chat. When 'claude-code' or 'codex', non-slash
   * messages are forcibly delegated to that local agent. Defaults to 'self'
   * (Otto).
   */
  agent?: FeishuAgentTarget;
  /**
   * Most recent native sessionId from the external agent's last completed
   * run in this chat. Used to auto-resume the session on the next message
   * (within the time window), so the agent retains conversation context
   * across turns in a continuous conversation.
   */
  lastSessionId?: string;
  /** Timestamp (Date.now()) when lastSessionId was saved. */
  lastSessionAt?: number;
}

// 路由文件路径（指向 ~/.otto-user/feishu-projects.json）
const ROUTE_CONFIG_FILE = path.join(os.homedir(), '.otto-user', 'feishu-projects.json');

/**
 * 读取多项目路由表
 */
async function loadProjectRoutes(): Promise<Record<string, FeishuProjectRoute>> {
  try {
    const credsDir = path.dirname(ROUTE_CONFIG_FILE);
    if (!fs.existsSync(credsDir)) {
      fs.mkdirSync(credsDir, { recursive: true });
    }
    if (!fs.existsSync(ROUTE_CONFIG_FILE)) {
      return {};
    }
    const data = fs.readFileSync(ROUTE_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(data) as unknown;
    // 基本结构校验：必须是非 null、非数组的纯对象，否则视为损坏回退空配置。
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      dwarn(
        'feishu-projects.json is corrupted (not a JSON object); falling back to empty routes.',
      );
      return {};
    }
    return parsed as Record<string, FeishuProjectRoute>;
  } catch (e) {
    dwarn(`Failed to load feishu-projects.json: ${(e as Error).message}`);
    return {};
  }
}

/**
 * 飞书独立会话加载并过滤项目上下文/记忆 (OTTO.md, AGENTS.md 等)
 */
async function loadFeishuSessionMemory(workspaceRoot: string, settings?: LoadedSettings): Promise<{ userMemory: string; memoryTokenCount: number; geminiMdFileCount: number }> {
  try {
    const fileService = new FileDiscoveryService(workspaceRoot);
    const debugMode = false;

    const fileFiltering = {
      respectGitIgnore: settings?.merged?.fileFiltering?.respectGitIgnore ?? true,
      respectGeminiIgnore: settings?.merged?.fileFiltering?.respectGeminiIgnore ?? true,
      enableRecursiveFileSearch: settings?.merged?.fileFiltering?.enableRecursiveFileSearch ?? true,
    };

    const result = await loadServerHierarchicalMemory(
      workspaceRoot,
      debugMode,
      fileService,
      [], // extensionContextFilePaths
      fileFiltering,
      settings?.merged?.memoryDiscoveryMaxDirs,
    );

    // Apply projectMemoryMode filtering (all / otto-only / none)
    const mode = settings?.merged?.projectMemoryMode || 'all';
    let filtered = result;

    if (mode === 'none') {
      filtered = { memoryContent: '', fileCount: 0, filePaths: [] };
    } else if (mode === 'otto-only') {
      const filteredPaths = result.filePaths.filter((fp: string) => {
        const filename = fp.split(/[\\/]/).pop() || '';
        return !filename.toUpperCase().startsWith('AGENTS');
      });
      if (filteredPaths.length !== result.filePaths.length) {
        const filteredContent = result.memoryContent
          .split('\n\n')
          .filter((block: string) => !block.includes('AGENTS.md ---'))
          .join('\n\n')
          .trim();
        filtered = {
          memoryContent: filteredContent,
          fileCount: filteredPaths.length,
          filePaths: filteredPaths,
        };
      }
    }

    // 计算 memory token
    let memoryTokenCount = 0;
    try {
      const enc = getEncoding('cl100k_base');
      memoryTokenCount = enc.encode(filtered.memoryContent).length;
    } catch {
      // ignore token count error
    }

    return {
      userMemory: filtered.memoryContent,
      memoryTokenCount,
      geminiMdFileCount: filtered.fileCount,
    };
  } catch (err: unknown) {
    dwarn(`Failed to load memory for isolated session on ${workspaceRoot}: ${unknownErrorMessage(err)}`);
    return {
      userMemory: '',
      memoryTokenCount: 0,
      geminiMdFileCount: 0,
    };
  }
}

/**
 * 写入路由表（增量更新）
 */
async function saveProjectRoute(chatId: string, routeUpdate: Partial<FeishuProjectRoute>): Promise<void> {
  try {
    const routes = await loadProjectRoutes();
    const existing = routes[chatId] || {};
    routes[chatId] = {
      ...existing,
      ...routeUpdate,
    };
    // 原子写：先写同目录临时文件，再 rename 覆盖。rename 在同一文件系统内是原子的，
    // 避免进程中途崩溃留下半截 JSON 损坏全部绑定。
    const tmpFile = `${ROUTE_CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(routes, null, 2), 'utf8');
      fs.renameSync(tmpFile, ROUTE_CONFIG_FILE);
    } catch (writeErr) {
      // 清理可能残留的临时文件，best-effort。
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
      throw writeErr;
    }
    dlog(`[Router] Successfully updated Chat ID '${chatId}' info in feishu-projects.json`);
  } catch (e) {
    derror(`Failed to save feishu-projects.json: ${(e as Error).message}`);
  }
}

/** 当前活跃的发送者 OpenID (用于拉当前交互的人建群) */
let activeSenderOpenId: string | null = null;

/** 隔离的运行时环境缓存 (chatId -> { config, geminiClient }) */
const isolatedSessions = new Map<string, { config: Config; geminiClient: OttoClient; lastActivityAt?: number }>();

/**
 * 各 chat 正在创建隔离 session 的"在途"Promise，用于消除 TOCTOU 竞态：
 * onMessage 对同一 chat 会并发触发，若两条首消息同时走到"get→await→set"，
 * 会各自 new 一个 OttoClient（第一个被泄漏，且恢复的历史被覆盖丢失）。
 * 改为：首个创建者写入此 Map，后到者直接 await 同一 Promise，保证每 chat 只建一次。
 */
const isolatedSessionInFlight = new Map<
  string,
  Promise<{ config: Config; geminiClient: OttoClient; lastActivityAt?: number } | null>
>();

/**
 * 把 OttoClient 的 clientHistory（Content[]）派生成"UI 视角"的 history。
 *
 * 仅用于让 SessionManager.getLastActiveSession(true) 的"含 user 消息"判断成立
 * （它检查 history.json 里 type==='user' 的条目）。AI 真正消费的是 context.json
 * 里的 clientHistory，与本派生数据无关。
 *
 * 派生规则：role==='user' 且 parts 中含 text 的条目转成 {type:'user', text}。
 * 其它（model 回复、functionCall/Response、空文本）一律跳过。
 */
export function deriveUiHistoryFromClientHistory(
  clientHistory: unknown,
): Array<{ type: string; text: string }> {
  const out: Array<{ type: string; text: string }> = [];
  if (!Array.isArray(clientHistory)) return out;
  for (const entry of clientHistory) {
    if (!isRecord(entry) || entry.role !== 'user' || !Array.isArray(entry.parts)) continue;
    const text = entry.parts
      .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!text) continue;
    out.push({ type: 'user', text });
  }
  return out;
}

/**
 * 确保飞书自定义 sessionId 在 SessionManager 索引体系中已注册。
 *
 * 飞书侧使用稳定的 `feishu-${chatId}-${ts}` 格式 sessionId，绕过了
 * SessionManager.createNewSession()，所以 metadata.json / index.json 都不会被
 * 自动创建。本函数补这个缺口：若 metadata.json 不存在则写入一份，使后续
 * saveSessionHistory → updateSessionMetadata → updateSessionIndex 链路能把该
 * session 注册进 index.json，让 getLastActiveSession 找得到。
 *
 * 已存在则直接跳过，避免覆盖业务字段（messageCount、lastActiveAt 等）。
 */
async function ensureFeishuSessionMetadata(
  projectRoot: string,
  sessionId: string,
): Promise<void> {
  const fsp = await import('node:fs/promises');
  const sessionDir = path.join(
    getProjectTempDir(projectRoot),
    'sessions',
    sessionId,
  );
  const metadataPath = path.join(sessionDir, 'metadata.json');
  try {
    await fsp.access(metadataPath);
    return; // 已存在，不覆盖
  } catch {
    // fall through
  }
  await fsp.mkdir(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  const metadata = {
    sessionId,
    title: `Feishu ${sessionId}`,
    createdAt: now,
    lastActiveAt: now,
    messageCount: 0,
    totalTokens: 0,
    hasCheckpoint: false,
  };
  await fsp.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

/**
 * 解析某项目"最后一个有内容的会话"，用于 /feishu start 续接上次对话。
 *
 * getLastActiveSession(true) 会跳过没有用户消息的空壳 session；
 * 找到后用 loadSession 读取其 AI 客户端历史（context.json → clientHistory）。
 *
 * @returns sessionId 为可续接的会话 id（无可续接时为 undefined）；
 *          clientHistory 为该会话的 AI 客户端历史（用于 setHistory）。
 */
export async function resolveResumableSessionId(
  workspaceRoot: string,
): Promise<{ sessionId?: string; clientHistory?: Content[]; lastActiveAt?: string }> {
  try {
    const sessionManager = new SessionManager(workspaceRoot);
    const lastSessionId = await sessionManager.getLastActiveSession(true);
    if (!lastSessionId) return {};

    const sessionData = await sessionManager.loadSession(lastSessionId);
    if (!sessionData) return {};

    const clientHistory = sessionData.clientHistory;
    const hasContent =
      Array.isArray(clientHistory) && clientHistory.length > 0;
    if (!hasContent) {
      // 有 session 记录但无 AI 客户端历史可注入：不作为可续接（避免恢复空壳）。
      return {};
    }

    return {
      sessionId: lastSessionId,
      clientHistory,
      lastActiveAt: sessionData.metadata?.lastActiveAt,
    };
  } catch (e) {
    dwarn(
      `[Router] resolveResumableSessionId failed for '${workspaceRoot}': ${(e as Error).message}`,
    );
    return {};
  }
}

/**
 * 持久化某个飞书隔离会话的 AI 客户端历史到该项目的 SessionManager。
 *
 * 对齐 CLI useSessionAutoSave 的保存路径：用 config 的 sessionId + projectRoot
 * 定位，把 geminiClient.getHistory() 存为 clientHistory，使下次能续接。
 *
 * 关键点（修复 /feishu start 无法恢复会话）：
 *   1. 主动确保 metadata.json 存在 —— 否则 SessionManager 静默跳过 index 更新，
 *      导致 getLastActiveSession 永远看不到飞书 session。
 *   2. 把 clientHistory 派生成 UI history 一并写入 —— 让 getLastActiveSession(true)
 *      的"含 user 消息"判断成立。
 *
 * 容错：参数缺失、历史为空、保存失败均静默跳过/告警，绝不抛出（fire-and-forget）。
 */
export async function saveFeishuSessionHistory(
  sessionConfig?: Config,
  sessionClient?: OttoClient,
): Promise<void> {
  try {
    if (!sessionConfig || !sessionClient) return;
    const projectRoot = sessionConfig.getProjectRoot?.();
    const sessionId = sessionConfig.getSessionId?.();
    if (!projectRoot || !sessionId) return;

    const clientHistory = await sessionClient.getHistory?.();
    if (!Array.isArray(clientHistory) || clientHistory.length === 0) {
      // 空历史不保存：避免把刚初始化的空 session 落盘成"可续接"。
      return;
    }

    // 修复 1：先确保 metadata.json 存在，这样 updateSessionIndex 才会被触发。
    await ensureFeishuSessionMetadata(projectRoot, sessionId);

    // 修复 2：派生 UI history，让 getLastActiveSession(true) 找得到该 session。
    const uiHistory = deriveUiHistoryFromClientHistory(clientHistory);

    const sessionManager = new SessionManager(projectRoot);
    await sessionManager.saveSessionHistory(sessionId, uiHistory, clientHistory);
    dlog(
      `[Router] Saved ${clientHistory.length} client-history items (${uiHistory.length} UI items) for session '${sessionId}'`,
    );
  } catch (e) {
    dwarn(`[Router] saveFeishuSessionHistory failed: ${(e as Error).message}`);
  }
}

interface QueuedMessage {
  msg: FeishuMessage;
  resolve: (value: string | null) => void;
  reject: (err: unknown) => void;
  /** 排队提示消息的 message_id，用于后续更新/撤回 */
  queueTipMessageId?: string | null;
  /** 已接收提示消息的 message_id；进入处理后保留，作为用户可见的过程起点 */
  receiptMessageId?: string | null;
}

// 群聊独立的队列容器
const messageQueues = new Map<string, QueuedMessage[]>();
const isProcessingQueues = new Map<string, boolean>();

/**
 * Per-chat AbortController for in-flight `/btw` side questions. A new
 * `/btw` in the same chat cancels the previous one. Cleared on resolve.
 */
const sideQuestionControllers = new Map<string, AbortController>();

/**
 * Export-only-for-tests: 把 messageQueues map 暴露出来供 mid-turn 注入单测
 * 直接装填初始队列。生产代码不应使用这个出口。
 */
export const __testing_messageQueues = messageQueues;

/**
 * Export-only-for-tests: 把 isProcessingQueues / activeAbortControllers 暴露出来
 * 供 /stop 竞态 bug 的单测验证状态流转。生产代码不应使用这些出口。
 */
export const __testing_isProcessingQueues = isProcessingQueues;
export const __testing_activeAbortControllers = activeAbortControllers;
export const __testing_decrementProcessingCount = decrementProcessingCount;
export const __testing_activeProcessingCount = { get: () => activeProcessingCount };
export const __testing_processingChatIds = processingChatIds;

/**
 * Detect a `/btw` side-question command in raw Feishu message text.
 * Returns the trimmed question (without the `/btw` prefix) if matched,
 * otherwise null. Exported so unit tests can lock the matcher behavior
 * independently from the running Feishu loop.
 */
export function parseBtwCommand(text: string): string | null {
  if (!text) return null;
  const m = text.match(/^\/btw(?:\s+([\s\S]+))?$/i);
  if (!m) return null;
  const question = (m[1] ?? '').trim();
  return question.length > 0 ? question : '';
}

/**
 * Handle a `/btw <question>` side question in Feishu mode. MUST be called
 * BEFORE any slash-command dispatcher (otherwise `btwCommand.action` from
 * BuiltinCommandLoader will fire first and just return the usage hint).
 *
 * Forks a tool-less single-turn agent on the chat's own OttoClient,
 * cancels any previous in-flight `/btw` for the same chat, and sends the
 * answer back as a single standalone message. Does NOT enter
 * `messageQueues` and does NOT touch the running task card.
 *
 * Returns true if the message was a `/btw` command and was handled (caller
 * should `return null` to short-circuit); false otherwise (caller should
 * continue normal processing).
 */
async function handleFeishuBtwCommand(
  msg: FeishuMessage,
  gateway: FeishuGateway,
  currentClient: OttoClient,
  currentConfig: Config | undefined | null,
  messageText: string,
): Promise<boolean> {
  const btwQuestion = parseBtwCommand(messageText);
  if (btwQuestion === null) return false;

  if (!btwQuestion) {
    await gateway.sendMessage(
      msg.chatId,
      '💡 用法: `/btw <你的问题>` — 派一个轻量旁路 agent 回答这个问题，主任务不受影响。',
      msg.messageId,
    );
    return true;
  }

  // Cancel any previous in-flight /btw for this chat — only the latest matters.
  // abort 后立即 delete 旧条目，避免被取消的 controller 残留在 map 里泄漏。
  // 紧接着的 set 会写入新 ctrl，delete/set 之间无 await，无并发窗口。
  const prevCtrl = sideQuestionControllers.get(msg.chatId);
  if (prevCtrl) {
    prevCtrl.abort();
    sideQuestionControllers.delete(msg.chatId);
  }
  const ctrl = new AbortController();
  sideQuestionControllers.set(msg.chatId, ctrl);

  void (async () => {
    try {
      const contentGenerator = currentClient.getContentGenerator();
      // Best-effort snapshot read — cold-start fallback is fine.
      let snapshot = null;
      try {
        snapshot = currentClient.getChat().cacheSafeParams.get();
      } catch {
        // No chat yet — cold start is acceptable.
      }
      const model = currentConfig?.getModel() ?? 'auto';

      const result = await runSideQuestion({
        contentGenerator,
        model,
        question: btwQuestion,
        cacheSafeSnapshot: snapshot,
        signal: ctrl.signal,
      });

      if (sideQuestionControllers.get(msg.chatId) === ctrl) {
        sideQuestionControllers.delete(msg.chatId);
      }

      const header = '🅱️ **旁路问答（/btw，主任务不受影响）**\n\n';
      let body: string;
      if (result.status === 'success') {
        body = result.text.trim() || '（fork agent 未返回任何内容）';
      } else if (result.status === 'cancelled') {
        body = '⏹️ 已取消。' + (result.text ? `\n\n（已生成部分内容）\n${result.text}` : '');
      } else {
        body = `❌ 旁路问答失败：${result.error ?? '未知错误'}`;
      }
      await gateway.sendMessage(msg.chatId, header + body, msg.messageId);
    } catch (err: unknown) {
      const message = unknownErrorMessage(err);
      dwarn(`[Feishu] /btw failed: ${message}`);
      await gateway
        .sendMessage(msg.chatId, `❌ 旁路问答失败：${message}`, msg.messageId)
        .catch(() => {/* best effort */});
    }
  })();

  return true;
}

/**
 * 🎯 Mid-turn injection drain (Feishu 端的对应实现，对称 App.tsx 里同名 callback)。
 *
 * 在当前群的 agent loop 处于 tool-call 间隙时调用，原子取走该群 `messageQueues`
 * 里所有等待中的消息，并立即 resolve 它们的 Promise（防止 gateway 一端永远等
 * 待）。返回 *仅包含消息文本* 的数组，调用方负责把它们拼成附加 user text part
 * 跟随下一次 continuation 一起送给模型。
 *
 * 副作用：每条被 mid-turn 消耗掉的消息会通过 `notify` 回调向飞书群发一条
 * "已合并到当前任务" 提示，纠正之前 enqueue 时发的 "排队第 X 位" UX。
 *
 * 仅取出"消息内容"（msg.text）；多模态附件不在 mid-turn 注入路径里支持（图
 * 片/文件需要单独 between-turn 处理）。带附件的消息会被跳过并保留在队列中。
 */
export function drainChatQueueForMidTurnInjection(
  chatId: string,
  notify?: (item: QueuedMessage) => Promise<void> | void,
): string[] {
  const queue = messageQueues.get(chatId);
  if (!queue || queue.length === 0) return [];

  const drained: QueuedMessage[] = [];
  const remaining: QueuedMessage[] = [];
  for (const item of queue) {
    const text = (item.msg.text ?? '').trim();
    const hasPendingImages =
      Array.isArray(item.msg.pendingImages) && item.msg.pendingImages.length > 0;
    const hasPendingFiles =
      Array.isArray(item.msg.pendingFiles) && item.msg.pendingFiles.length > 0;
    if (!text || hasPendingImages || hasPendingFiles) {
      // 没有文本，或携带图片/文件 → 不走 mid-turn 注入路径，留给 between-turn 处理
      // （多模态附件需要先下载到 projectRoot 才能让模型用，绕开这条快路径）
      remaining.push(item);
      continue;
    }
    drained.push(item);
  }

  if (drained.length === 0) return [];

  // 原子替换队列剩余项
  messageQueues.set(chatId, remaining);

  // resolve 已注入项的 Promise（不再走独立 agent loop），并更新排队提示消息
  for (const item of drained) {
    try {
      item.resolve(null);
    } catch {
      // ignore — resolver only ever observed once anyway
    }
    if (notify) {
      void Promise.resolve(notify(item)).catch(() => {/* best effort */});
    }
  }

  return drained.map((item) => (item.msg.text ?? '').trim()).filter(Boolean);
}

/**
 * 更新指定群聊中剩余排队消息的排队位置提示。
 * 当某条消息出队（被处理或被合并）后，排在其后的消息位置号需要前移。
 * 此函数遍历剩余队列，对每条有 queueTipMessageId 的消息调用
 * gateway.updateMessage 更新其排队提示文案。
 */
async function refreshQueuePositions(
  gateway: FeishuGateway,
  chatId: string,
): Promise<void> {
  const queue = messageQueues.get(chatId);
  if (!queue || queue.length === 0) return;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (item.queueTipMessageId) {
      const position = i + 1;
      const updatedTip = `⏳ *当前项目任务正在执行中，您的新请求已放入项目队列排队（当前排在第 ${position} 位）...*`;
      await gateway.updateMessage(item.queueTipMessageId, updatedTip).catch(() => {/* best effort */});
    }
  }
}

function clearMessageQueue() {
  for (const queue of messageQueues.values()) {
    for (const item of queue) {
      item.resolve(null);
    }
  }
  messageQueues.clear();
  isProcessingQueues.clear();
  isolatedSessions.clear();
  // 清掉在途 session 创建标记，避免 stop/restart 后残留指向旧 chat 的 Promise。
  isolatedSessionInFlight.clear();
  chatLastMessageId.clear();
  activeSenderOpenIds.clear();
  for (const controller of activeAbortControllers.values()) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }
  activeAbortControllers.clear();
  activeSenderOpenId = null;
}

/**
 * 优雅重启：中止 AI → 清理队列 → 断开 WS → spawn 外挂 → 延迟退出。
 * 统一 /feishu restart 和 self_update 的退出流程，确保飞书 SDK 有充足时间
 * 完成 { code:0 } 确认，避免消息被飞书服务端重推。
 */
async function gracefulRestartThenExit(install: RelaunchInstallMode): Promise<void> {
  // 1) 中止所有正在进行的 AI 生成
  for (const controller of activeAbortControllers.values()) {
    try { controller.abort(); } catch { /* ignore */ }
  }
  activeAbortControllers.clear();

  // 2) 清理消息队列
  clearMessageQueue();

  // 3) 优雅关闭飞书网关（发送 WebSocket close frame，而非硬断）
  if (activeGateway) {
    try { await activeGateway.disconnect(); } catch { /* ignore */ }
    activeGateway = null;
  }

  // 4) spawn 外挂脚本（等父进程退出后接管重启）
  launchRelaunchHelper(install);

  // 5) 非 Windows 提示：飞书模式下新进程在后台静默启动，用户看不到界面
  if (process.platform !== 'win32') {
    console.log(
      '\n💡 Otto 飞书网关已在新进程中后台启动（无界面），' +
      '可通过 `ps aux | grep otto` 查看进程状态。\n'
    );
  }

  // 6) 延迟退出：给飞书侧充足时间完成消息投递确认
  setTimeout(() => {
    process.exit(0);
  }, 1500).unref?.();
}

/**
 * Wrapper around loadCredentials that surfaces decryption / parse errors
 * as a typed result instead of throwing — handlers can produce a friendly
 * actionable message instead of a stack trace.
 */
async function loadCredsSafe(): Promise<
  | { ok: true; creds: FeishuCredentials | null }
  | { ok: false; error: string }
> {
  try {
    const creds = await loadCredentials();
    return { ok: true, creds };
  } catch (e) {
    if (e instanceof CredentialsLoadError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 构建帮助文本
 */
function helpText(): string {
  return t('feishu.help.text');
}

async function handleSetup(args: string, ctx?: CommandContext): Promise<string> {
  const trimmed = args.trim();
  // 手动检测 --manual 模式，不走 parseArgs（避免 flag 值吃掉后续参数）
  const manualMatch = trimmed.match(/^--manual\s+(.+)$/s);
  if (manualMatch) {
    // --manual 之后的所有非空参数，以空格分割
    const rest = manualMatch[1].trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    const appId = parts[0];
    const appSecret = parts[1];
    return await handleManualSetup(appId, appSecret, ctx);
  }

  // 没有 --manual 则走 QR
  return await handleQrSetup(ctx);
}

/**
 * 渲染一个 ASCII 二维码（紧凑模式，TUI 友好）。
 *
 * qrcode-terminal 默认会用空格 + █ 字符渲染，small 模式用半角块字符
 * 让二维码体积减半，更适合 TUI 窗口显示。
 *
 * 注意：qrcode-terminal 的 generate 是**同步** 调用 callback 的（没有任何 IO），
 * 所以可以直接通过闭包变量收集结果。
 *
 * 失败时返回 null，调用方可以降级到"只展示链接"。
 */
function renderQrCode(text: string): string | null {
  try {
    let output = '';
    const qt = qrcodeTerminal as QrCodeTerminalLike;

    // 🎯 1. 尝试直接以方法调用的形式在原始对象上调用，以保留正确的 `this` 上下文（否则会因 this 丢失导致 this.error 变成 undefined 进而报错）
    if (qt && typeof qt.generate === 'function') {
      qt.generate(text, { small: true }, (qr: string) => {
        output = qr;
      });
      return output || null;
    }

    if (qt && qt.default && typeof qt.default.generate === 'function') {
      qt.default.generate(text, { small: true }, (qr: string) => {
        output = qr;
      });
      return output || null;
    }

    // 🎯 2. 兜底尝试使用 requireFn 并以方法调用形式执行
    try {
      const cjsQt = requireFn('qrcode-terminal') as QrCodeTerminalLike;
      if (cjsQt && typeof cjsQt.generate === 'function') {
        cjsQt.generate(text, { small: true }, (qr: string) => {
          output = qr;
        });
        return output || null;
      }
      if (cjsQt && cjsQt.default && typeof cjsQt.default.generate === 'function') {
        cjsQt.default.generate(text, { small: true }, (qr: string) => {
          output = qr;
        });
        return output || null;
      }
    } catch {
      // 忽略 require 失败
    }

    dwarn('[Feishu] qrcodeTerminal.generate is not a function');
    return null;
  } catch (e: unknown) {
    dwarn(`[Feishu] renderQrCode failed: ${unknownErrorMessage(e)}`);
    return null;
  }
}

/**
 * 档 1：扫码自动建应用
 *
 * 两阶段返回：
 *  阶段 1（同步返回）：立刻渲染二维码 + 链接 + 等待提示，让用户**马上**看见可扫码内容。
 *  阶段 2（后台异步）：等用户扫码后，通过 ctx.ui.addItem 把后续状态/结果一条一条 push 到
 *                      history。这样 TUI 不会卡住等 60+ 秒，扫码体验非常流畅。
 *
 * 没有 ctx（被非交互式 CLI 调用，如 `otto -p`）时退化回单次同步返回。
 */
async function handleQrSetup(ctx?: CommandContext): Promise<string> {
  const lines: string[] = [t('feishu.setup.qr.title')];
  lines.push(t('feishu.setup.qr.connecting'));

  try {
    await initRegistration('feishu');
    const begin = await beginRegistration('feishu');
    const qrUrl = begin.qrUrl;

    // ============= 阶段 1：立刻拼好「二维码 + 链接 + 扫码提示」一并返回 =============
    lines.push(t('feishu.setup.qr.generated'));
    lines.push('');

    // ASCII QR 码 — 紧凑模式，适合 TUI 窗口
    const qrAscii = renderQrCode(qrUrl);
    if (qrAscii) {
      lines.push(qrAscii);
    }

    lines.push('');
    lines.push('  📱 ' + t('feishu.setup.qr.scan_hint'));
    lines.push('');
    lines.push('  🔗 备选：在浏览器打开此链接登录授权');
    lines.push(`     ${qrUrl}`);
    lines.push('');
    lines.push(t('feishu.setup.qr.waiting'));
    lines.push(t('feishu.setup.qr.cancel_hint'));

    // 没有 ctx → 非交互式调用，必须用旧的同步等待逻辑
    if (!ctx) {
      const pollResult = await pollRegistration(
        begin.deviceCode,
        begin.interval,
        begin.expireIn,
        'feishu',
      );
      if (!pollResult) {
        lines.push('');
        lines.push(t('feishu.setup.qr.timeout'));
        lines.push(t('feishu.setup.qr.retry_hint'));
        return lines.join('\n');
      }
      const result = await finalizeQrSetup(pollResult);
      lines.push('');
      lines.push(result);
      return lines.join('\n');
    }

    // ============= 阶段 2：交互模式 — 后台 await，扫码完成后 push 到 history =============
    void (async () => {
      try {
        const pollResult = await pollRegistration(
          begin.deviceCode,
          begin.interval,
          begin.expireIn,
          'feishu',
        );
        if (!pollResult) {
          ctx.ui.addItem(
            {
              type: MessageType.INFO,
              text: [
                '',
                t('feishu.setup.qr.timeout'),
                t('feishu.setup.qr.retry_hint'),
              ].join('\n'),
            },
            Date.now(),
          );
          return;
        }
        const result = await finalizeQrSetup(pollResult, ctx);
        ctx.ui.addItem(
          { type: MessageType.INFO, text: result },
          Date.now(),
        );
      } catch (err: unknown) {
        ctx.ui.addItem(
          {
            type: MessageType.ERROR,
            text: `❌ Feishu setup 后台轮询失败：${unknownErrorMessage(err)}`,
          },
          Date.now(),
        );
      }
    })();

    return lines.join('\n');
  } catch (err: unknown) {
    return [
      t('feishu.setup.qr.failed_title'),
      `  ${unknownErrorMessage(err)}`,
      '',
      t('feishu.setup.qr.fallback_hint'),
    ].join('\n');
  }
}

/**
 * 阶段 2 的收尾：拿到 device-code 轮询结果后，做 probe + 保存凭证 + 拼最终提示。
 * 提取成独立函数是为了让交互式与非交互式两条调用路径共享同一段逻辑。
 */
async function finalizeQrSetup(
  pollResult: {
    appId: string;
    appSecret: string;
    domain: string;
    openId?: string;
  },
  ctx?: CommandContext,
): Promise<string> {
  const lines: string[] = [];
  const botInfo = await probeCredentials(
    pollResult.appId, pollResult.appSecret, pollResult.domain,
  );

  const creds: FeishuCredentials = {
    appId: pollResult.appId,
    appSecret: pollResult.appSecret,
    domain: pollResult.domain as 'feishu' | 'lark',
    botName: botInfo?.botName,
    botOpenId: botInfo?.botOpenId,
    // The user who scanned the QR code becomes the Bot owner — only they
    // (and entries in `allowlist`) may invoke the agent. See B1 in MR review.
    ownerOpenId: pollResult.openId,
  };

  await saveCredentials(creds);

  lines.push(t('feishu.setup.qr.success'));
  lines.push(`  App ID:      ${creds.appId}`);
  if (creds.botName) lines.push(tp('feishu.setup.qr.bot_name', { name: creds.botName }));
  lines.push(t('feishu.setup.qr.creds_saved'));

  // ✨ 关键升级：检测应用已开通的 scope，输出"一键申请缺失权限"链接
  appendPostSetupGuidance(lines, creds, botInfo?.grantedScopes);

  // 🚀 自动帮用户执行 start 逻辑以启动监听服务
  try {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🚀 **正在为您自动开启飞书 Bot 监听服务...**');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const startMsg = await handleStart(ctx);
    lines.push(startMsg);
  } catch (err: unknown) {
    lines.push(`❌ 自动启动服务失败：${unknownErrorMessage(err)}`);
  }

  lines.push('');
  lines.push(t('feishu.setup.qr.next_step_start'));
  return lines.join('\n');
}

/**
 * 在 setup 流程结束时附加「下一步配置」引导：
 *  1. 一键申请缺失的应用 scope（飞书开放平台原生支持 q= 参数预选 scope）
 *  2. 事件订阅页（im.message.receive_v1 等）
 *  3. 权限管理总览页（兜底）
 *
 * 这一段对齐 openclaw-lark `commands/doctor.ts` 的逻辑，但内嵌在 setup 成功
 * 时直接输出，而不是单独的 doctor 命令。
 */
function appendPostSetupGuidance(
  lines: string[],
  creds: FeishuCredentials,
  grantedScopes?: string[],
): void {
  const requiredAll = [...REQUIRED_APP_SCOPES];
  const missing = grantedScopes
    ? missingScopes(grantedScopes, requiredAll)
    : requiredAll; // 没拿到已开通列表（首次扫码很正常）→ 假定全部缺失

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('🔧 **一键完成下一步配置（强烈建议）**');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (grantedScopes !== undefined && missing.length === 0) {
    lines.push('  ✅ 应用已开通全部 otto 必需的 scope，无需额外申请。');
  } else {
    const scopeApplyUrl = buildScopeApplyUrl({
      appId: creds.appId,
      scopes: missing,
      brand: creds.domain,
      tokenType: 'tenant',
    });
    if (grantedScopes === undefined) {
      lines.push('  📋 **第 1 步：一键申请应用所需权限**（自动预选 scope）');
    } else {
      lines.push(`  📋 **第 1 步：一键申请缺失的 ${missing.length} 项权限**（自动预选 scope）`);
    }
    lines.push(`     👉 ${scopeApplyUrl}`);
    if (missing.length > 0 && missing.length <= 12) {
      lines.push('     需申请的 scope：');
      for (const s of missing) lines.push(`       - ${s}`);
    }
  }

  lines.push('');
  lines.push('  📡 **第 2 步：在事件订阅页勾选必要事件**');
  lines.push(`     👉 ${buildEventSubUrl({ appId: creds.appId, brand: creds.domain })}`);
  lines.push('     需订阅事件：');
  lines.push('       - im.message.receive_v1（接收消息）');
  lines.push('       - im.chat.member.bot.added_v1（被拉入群通知）');
  lines.push('       - card.action.trigger（卡片按钮回调）');
  lines.push('');
  lines.push('  🔄 **第 3 步：申请发布版本**');
  lines.push('     在权限管理页申请版本发布，让 scope 生效：');
  lines.push(`     👉 ${buildPermissionPageUrl({ appId: creds.appId, brand: creds.domain })}`);
  lines.push('');

  // 🔔 重要提示：群里免 @ 必须额外申请敏感权限
  const hasGroupMsgScope = grantedScopes?.includes(SENSITIVE_GROUP_MSG_SCOPE) ?? false;
  if (!hasGroupMsgScope) {
    const sensitiveApplyUrl = buildScopeApplyUrl({
      appId: creds.appId,
      scopes: [SENSITIVE_GROUP_MSG_SCOPE],
      brand: creds.domain,
      tokenType: 'tenant',
    });
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('💬 **想让 Bot 在群里"免 @ 直接响应所有消息"？**');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('  默认：群里只有 @bot 时才会收到事件（飞书平台层硬规则）。');
    lines.push('  要免 @ 直接响应，必须额外申请「敏感权限」：');
    lines.push(`     👉 ${sensitiveApplyUrl}`);
    lines.push(`     权限：\`${SENSITIVE_GROUP_MSG_SCOPE}\` —— "读取关联群聊内所有消息"`);
    lines.push('  ⚠️ 这是飞书的敏感权限，需要人工审核（一般 1-3 天）。');
    lines.push('  在申请页填写"使用场景说明"时，可以参考填写：');
    lines.push('     用于 AI 编程助手在专属项目协作群中无需 @ 即可响应团队成员的');
    lines.push('     编程请求和问题，提升协作效率。');
    lines.push('');
  }
  lines.push('  💡 步骤 1-3 完成后，回到 otto 执行 `/feishu start` 即可使用！');
}

/**
 * 档 3：手动输入凭据
 */
async function handleManualSetup(
  appId?: string,
  appSecret?: string,
  ctx?: CommandContext,
): Promise<string> {
  if (!appId || !appSecret) {
    return [
      t('feishu.setup.manual.title'),
      '',
      t('feishu.setup.manual.usage'),
      '',
      t('feishu.setup.manual.example'),
      '',
      t('feishu.setup.manual.where_to_find'),
      '',
      t('feishu.setup.manual.tip_qr'),
    ].join('\n');
  }

  // 校验凭证
  const lines: string[] = [t('feishu.setup.manual.validating')];
  const botInfo = await probeCredentials(appId, appSecret, 'feishu');

  const creds: FeishuCredentials = {
    appId,
    appSecret,
    domain: 'feishu',
    botName: botInfo?.botName,
    botOpenId: botInfo?.botOpenId,
  };

  await saveCredentials(creds);

  lines.push(botInfo ? t('feishu.setup.manual.creds_valid') : t('feishu.setup.manual.creds_invalid'));
  if (creds.botName) lines.push(tp('feishu.setup.qr.bot_name', { name: creds.botName }));
  lines.push(t('feishu.setup.qr.creds_saved'));
  lines.push('');
  lines.push(t('feishu.setup.manual.owner_warning'));
  lines.push(t('feishu.setup.manual.owner_warning_2'));

  // ✨ 与 QR setup 一致，附加「一键开权限」+ 事件订阅引导
  appendPostSetupGuidance(lines, creds, botInfo?.grantedScopes);

  // 🚀 手动配置成功后，也自动帮用户执行 start 逻辑以启动监听服务
  try {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🚀 **正在为您自动开启飞书 Bot 监听服务...**');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const startMsg = await handleStart(ctx);
    lines.push(startMsg);
  } catch (err: unknown) {
    lines.push(`❌ 自动启动服务失败：${unknownErrorMessage(err)}`);
  }

  lines.push('');
  lines.push(t('feishu.setup.qr.next_step_start'));

  return lines.join('\n');
}

/**
 * 从文本中提取文件路径，上传并发送到飞书
 *
 * 安全约束（B2）：仅发送项目根目录内、且扩展名在白名单中的文件。
 * 跨平台支持：同时识别 POSIX 路径（/foo/bar.ext, ./foo.ext）和 Windows 路径
 *   （C:\foo\bar.ext, .\foo.ext）。
 *
 * 不在白名单内的扩展名一律不发送，可疑路径（绝对路径但不在 projectRoot 内）
 * 也会被忽略，避免文本中提及的路径被自动外发到飞书。
 */
async function sendDetectedFiles(
  gateway: FeishuGateway,
  chatId: string,
  replyToMessageId: string | undefined,
  text: string,
  projectRoot: string,
): Promise<void> {
  // 文件路径正则 — 同时匹配 POSIX 与 Windows 风格：
  //   POSIX：/abs/path/file.ext, ./rel/path/file.ext
  //   Windows：C:\abs\path\file.ext, .\rel\path\file.ext
  // 反斜杠在 JSON/markdown 中常被双写为 \\，正则用 [\\\\/] 匹配 / 或 \。
  const filePathRegex =
    /(?:^|[\s"'`])((?:[A-Za-z]:[\\/][\w\-./\\]+)|(?:\/[\w\-./]+)|(?:\.[\\/][\w\-./\\]+))\.(png|jpe?g|gif|webp|svg|bmp|pdf|txt|csv|json|zip|tar\.gz|py|js|ts|tsx|jsx|md|html|css|yaml|yml|toml)(?=["'`\s,;.)]|$)/gim;

  type Match = { path: string; ext: string };
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = filePathRegex.exec(text)) !== null) {
    const filePath = m[1] + '.' + m[2];
    if (!matches.some((x) => x.path === filePath)) {
      matches.push({ path: filePath, ext: m[2].toLowerCase() });
    }
  }
  if (matches.length === 0) return;

  const fs = await import('node:fs');
  const path = await import('node:path');

  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
  const REJECTED_EXTS = new Set([
    'exe', 'dll', 'bat', 'cmd', 'ps1', 'msi', 'scr', 'com',
    'so', 'dylib', 'sh', 'bash', 'zsh', 'fish',
    'jar', 'class', 'msp', 'msc',
  ]);

  for (const { path: rawPath, ext } of matches) {
    if (REJECTED_EXTS.has(ext)) {
      dwarn(`Rejected suspicious extension .${ext}: ${rawPath}`);
      continue;
    }

    // Resolve to absolute, then enforce project-root sandbox.
    const abs = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(projectRoot, rawPath);
    if (!isWithinRoot(abs, projectRoot)) {
      dwarn(`Rejected file outside project root: ${abs}`);
      continue;
    }

    try {
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      // 50 MiB cap; matches send_feishu_file tool.
      if (stat.size > 50 * 1024 * 1024) {
        dwarn(`Rejected file > 50 MiB: ${abs} (${stat.size} bytes)`);
        continue;
      }

      if (IMAGE_EXTS.has(ext)) {
        const imageKey = await gateway.uploadImage(abs);
        await gateway.sendImage(chatId, imageKey, replyToMessageId);
        tuiContext?.addItem(
          { type: 'info', text: tp('feishu.send.image', { path: abs }) },
          Date.now(),
        );
      } else {
        const fileKey = await gateway.uploadFile(abs);
        await gateway.sendFile(chatId, fileKey, replyToMessageId);
        tuiContext?.addItem(
          { type: 'info', text: tp('feishu.send.file', { path: abs }) },
          Date.now(),
        );
      }
    } catch (err: unknown) {
      derror(`Failed to send file to Feishu (${abs}):`, (err as Error)?.message);
      // 文件发送失败不影响主流程
    }
  }
}

/**
 * 归一化 ask_user_question 的工具入参，彻底防止
 * `(args.questions || []).map is not a function` 这类崩溃。
 *
 * 背景：飞书网关拦截 ask_user_question 时，args / args.questions 有时不是
 * 期望的对象/数组，而是被序列化成了 JSON 字符串（模型偶发行为或链路序列化）。
 * 直接 `.map` 会因为字符串没有 map 方法而抛错。
 *
 * 本函数把以下各种形态都安全收敛为 `{ questions: AskUserQuestion[] }`：
 *   - 正常对象 { questions: [...] }                        → 原样
 *   - { questions: "<json array string>" }                → parse 出数组
 *   - "<整个 args 的 json 字符串>"                          → 先 parse 再递归归一
 *   - 双重编码（args 字符串 → questions 仍是字符串）         → 逐层 parse
 *   - 直接传单个问题对象 { question, options }             → 包成单元素数组
 *   - null / undefined / 垃圾 / 非数组                      → { questions: [] }
 *
 * 该函数是纯函数、绝不抛异常，便于单测与防御性兜底。
 */
export function normalizeAskUserQuestionArgs(args: unknown): {
  questions: Array<Record<string, unknown> | string>;
} {
  // 1) 整个 args 是字符串：尝试 parse（失败则视为空）
  if (typeof args === 'string') {
    try {
      return normalizeAskUserQuestionArgs(JSON.parse(args));
    } catch {
      return { questions: [] };
    }
  }

  if (!args || typeof args !== 'object') {
    return { questions: [] };
  }

  const obj = args as Record<string, unknown>;
  let questions: unknown = obj['questions'];

  // 2) questions 是字符串：尝试 parse
  if (typeof questions === 'string') {
    try {
      questions = JSON.parse(questions);
    } catch {
      return { questions: [] };
    }
  }

  // 3) questions 是数组：直接采用
  if (Array.isArray(questions)) {
    return { questions: questions.filter((item): item is Record<string, unknown> | string => isRecord(item) || typeof item === 'string') };
  }

  // 4) 没有 questions，但 args 本身看起来就是单个问题对象 → 包一层
  if ('question' in obj || 'options' in obj) {
    return { questions: [obj] };
  }

  // 5) 其余一律安全兜底
  return { questions: [] };
}

/**
 * 飞书模式下拦截 ask_user_question：发送交互「表单卡片」，等用户提交
 *
 * 主路径：用 gateway.askQuestionsViaForm() 发一张 schema 2.0 表单卡片，
 *   每个问题 = 下拉单选（含「其他」）+ 自定义填空框，底部统一提交按钮。
 *   用户点提交后通过长连接 card.action.trigger 一次性带回所有答案。
 *
 * 兜底：当表单卡片发送失败时，回退到逐题文本序号选择模式（waitForCardAction
 *   内部也会在普通卡片失败时再退到纯文本）。
 *
 * 超时（30 分钟）→ 对应问题答案为空，提示"用户未回答"。
 */
async function handleAskUserQuestionViaCard(
  gateway: FeishuGateway,
  chatId: string,
  replyToMessageId: string | undefined,
  args: unknown,
  callId: string,
): Promise<Part> {
  // 🚀 数据容错与自愈：先把 args 归一化（防止 args/questions 是 JSON 字符串
  //    导致 `.map is not a function` 崩溃），再处理每个 question 的字段。
  const safeArgs = normalizeAskUserQuestionArgs(args);
  const normalizedQuestions: NormalizedAskQuestion[] = safeArgs.questions.map((item) => {
    if (typeof item === 'string') {
      return {
        question: item,
        header: 'Question',
        options: [],
      };
    }
    const question = String(item.question || '').trim() || 'Question';
    let header = String(item.header || 'Question').trim();
    if (header.length > 12) {
      header = header.substring(0, 12);
    }
    let options: AskQuestionOption[] = [];
    if (Array.isArray(item.options)) {
      options = item.options.map((opt) => {
        if (typeof opt === 'string') {
          return { label: opt, description: '' };
        }
        if (isRecord(opt)) {
          const rawLabel = opt.label || opt.value || 'Option';
          return {
            label: String(rawLabel).trim() || 'Option',
            description: opt.description ? String(opt.description).trim() : '',
          };
        }
        return { label: 'Option', description: '' };
      });
    }
    return {
      question,
      header,
      options,
      multiSelect: Boolean(item.multiSelect),
    };
  });

  const answers: Record<string, string> = {};

  // 过滤出有选项的问题（无选项的无法用卡片收集）
  const answerableQuestions = normalizedQuestions.filter(
    (q) => (q.options || []).length > 0,
  );
  for (const q of normalizedQuestions) {
    if ((q.options || []).length === 0) {
      answers[q.question] = '(无选项)';
    }
  }

  // 🎯 主路径：一张表单卡片一次性收集全部答案
  let formSucceeded = false;
  if (answerableQuestions.length > 0) {
    const result = await gateway.askQuestionsViaForm(
      chatId,
      answerableQuestions.map((q) => ({
        question: q.question,
        header: q.header,
        options: q.options || [],
        multiSelect: q.multiSelect,
      })),
      FEISHU_ASK_QUESTION_TIMEOUT_MS,
      replyToMessageId,
    );

    if (result.ok && 'otherIdeas' in result && result.otherIdeas) {
      formSucceeded = true;
      for (const q of answerableQuestions) {
        answers[q.question] = '用户选择直接提供其他想法，不回答预设选项。请向用户询问其想法并退出当前工具执行等待用户消息。';
      }
      // 回执：告诉用户可以发送想法了
      await gateway.sendMessage(
        chatId,
        '💡 已记录：你选择直接提供其他想法，请直接在聊天框中发送你的要求。',
      );
    } else if (result.ok && result.answers) {
      formSucceeded = true;
      for (const q of answerableQuestions) {
        const ans = result.answers[q.question] || '';
        if (ans) {
          answers[q.question] = ans;
        } else {
          answers[q.question] = '用户未回答，请自行决策';
        }
      }
      // 原表单卡片已在 askQuestionsViaForm 内通过 PATCH 更新为"已收到回答"，无需再发新消息
    }
  }

  // 🛟 兜底：表单卡片失败 → 逐题文本/按钮选择
  if (!formSucceeded) {
    for (const q of answerableQuestions) {
      const options = q.options || [];

      // 构建卡片正文：列出选项及其描述
      const contentLines = options.map((opt) => {
        const line = `**${opt.label}**`;
        return opt.description ? `${line}: ${opt.description}` : line;
      });

      if (q.multiSelect) {
        let selectedLabels: string[] = [];
        let done = false;

        while (!done) {
          const currentSelectionsStr = selectedLabels.length > 0
            ? `当前已选: **${selectedLabels.join(', ')}**`
            : '（尚未选择任何选项，请点击下方选项进行选择）';
          const content = `${contentLines.join('\n\n')}\n\n💡 **${currentSelectionsStr}**`;

          // 构建按钮
          const buttons = options.map((opt) => ({
            label: selectedLabels.includes(opt.label) ? `✅ ${opt.label}` : opt.label,
            value: opt.label,
          }));
          buttons.push({ label: '🆗 确定提交', value: '__submit__' });
          buttons.push({ label: '⏭ 跳过', value: '__skip__' });

          const title = q.header ? `[多选] ${q.header}: ${q.question}` : `[多选] ${q.question}`;

          const userChoice = await gateway.waitForCardAction(
            chatId,
            title,
            content,
            buttons,
            '__timeout__',
            FEISHU_ASK_QUESTION_TIMEOUT_MS,
            replyToMessageId,
          );

          if (userChoice === '__timeout__') {
            await gateway.sendMessage(chatId, '⏰ 等待超时 — 未收到回答');
            answers[q.question] = '用户未在规定时间内回答，请自行决策';
            done = true;
          } else if (userChoice === '__skip__') {
            await gateway.sendMessage(chatId, '⏭ 已跳过');
            answers[q.question] = '用户选择跳过，请自行决策';
            done = true;
          } else if (userChoice === '__submit__') {
            if (selectedLabels.length === 0) {
              await gateway.sendMessage(chatId, '⚠️ 你尚未选择任何选项，请先选择至少一个选项，或点击“跳过”。');
              // 继续循环，不退出
            } else {
              const resultStr = selectedLabels.join(', ');
              await gateway.sendMessage(chatId, `✅ 已选择: ${resultStr}`);
              answers[q.question] = resultStr;
              done = true;
            }
          } else {
            // 点击了选项按钮
            if (selectedLabels.includes(userChoice)) {
              selectedLabels = selectedLabels.filter(l => l !== userChoice);
            } else {
              selectedLabels.push(userChoice);
            }
            // 继续循环
          }
        }
      } else {
        const content = contentLines.join('\n\n');

        // 构建按钮
        const buttons = options.map((opt) => ({
          label: opt.label,
          value: opt.label,
        }));
        buttons.push({ label: '⏭ 跳过', value: '__skip__' });

        const title = q.header ? `${q.header}: ${q.question}` : q.question;

        const userChoice = await gateway.waitForCardAction(
          chatId,
          title,
          content,
          buttons,
          '__timeout__',
          FEISHU_ASK_QUESTION_TIMEOUT_MS,
          replyToMessageId,
        );

        // 发送新消息提示用户的选择结果
        {
          let feedbackText: string;
          if (userChoice === '__timeout__') {
            feedbackText = '⏰ 等待超时 — 未收到回答';
          } else if (userChoice === '__skip__') {
            feedbackText = '⏭ 已跳过';
          } else {
            feedbackText = `✅ 已选择: ${userChoice}`;
          }
          await gateway.sendMessage(chatId, feedbackText);
        }

        if (userChoice === '__timeout__') {
          answers[q.question] = '用户未在规定时间内回答，请自行决策';
        } else if (userChoice === '__skip__') {
          answers[q.question] = '用户选择跳过，请自行决策';
        } else {
          answers[q.question] = userChoice;
        }
      }
    }
  }

  // 构造和 AskUserQuestionTool.execute() 相同格式的 functionResponse
  const parts = Object.entries(answers).map(
    ([questionText, answer]) => `"${questionText}"="${answer}"`,
  );
  const answersText = parts.join(', ');
  const llmContent = answersText
    ? `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`
    : 'User has answered your questions (no answers provided).';

  return {
    functionResponse: {
      id: callId,
      name: 'ask_user_question',
      response: { output: llmContent },
    },
  } as Part;
}

/** 飞书支持的斜杠命令列表（用于 /help 展示） */
const FEISHU_SLASH_COMMANDS: Record<string, string> = {
  '/new':              '新建会话（重置对话历史，保留工具能力）',
  '/compress':         '压缩对话历史（释放上下文窗口）',
  '/stop':             '中止当前正在运行的 AI 任务',
  '/status':           '查看当前的 CLI 版本、积分剩余、当前模型、思考模式及上下文大小',
  '/thinking':         '切换/配置 AI 思考模式与深度',
  '/model':            '查看可用模型，或输入 `/model <模型ID>` 切换 AI 模型',
  '/bind':             '绑定本群到本地项目目录，格式：`/bind <项目绝对路径>`；可加 `--agent claude-code` 或 `--agent codex` 设默认派发方（或在消息前加 `@cc` / `@codex` 单条派发）',
  '/goal':             '启动目标驱动模式（`/goal clear` 结束）',
  '/acp-session':      '查看本机外部 Agent（Claude Code / Codex）的运行任务和历史会话',
  '/feishu restart':   '热重启飞书机器人（AI 卡死时使用）',
  '/help':             '显示此帮助',
};

/**
 * 格式化精美的飞书端纯英文 /status 状态卡片内容
 */
async function formatStatusMessage(config: Config, _geminiClient: OttoClient, chatId?: string): Promise<string> {
  const cliVersion = await getVersion().catch(() => 'unknown');
  const currentModel = config?.getModel() || '未选择';
  const cloudModelInfo = config?.getCloudModelInfo?.(currentModel);
  const modelName = cloudModelInfo?.displayName || currentModel;

  const currentConfig = config?.getThinkingConfig() || { mode: 'auto', effort: 'auto' };

  const proxyAuthManager = ProxyAuthManager.getInstance();
  const userInfo = proxyAuthManager.getUserInfo();
  const userName = userInfo?.name || 'Not Available';

  const lastTokenUsage = chatId ? chatLastTokenUsage.get(chatId) : null;
  const input = lastTokenUsage?.inputTokens || uiTelemetryService.getLastPromptTokenCount() || 0;
  const output = lastTokenUsage?.outputTokens || 0;
  const cacheRead = lastTokenUsage?.cacheReadInputTokens || 0;
  const total = input + output;
  const cacheHitRate = input > 0 ? ((cacheRead / input) * 100).toFixed(1) + '%' : '0.0%';

  let remainingCredits = 'Not Available';
  try {
    const creditsInfo = await getCreditsService().getCreditsInfo(true);
    if (creditsInfo) {
      remainingCredits = creditsInfo.remainingCredits.toLocaleString();
    }
  } catch {
    // ignore
  }

  const maxTokens = tokenLimit(currentModel, config || undefined);
  const contextK = input > 0 ? (input / 1000).toFixed(1) + 'k' : '0k';
  const maxM = maxTokens > 0 ? (maxTokens / 1000000).toFixed(1) + 'm' : 'Unknown';
  const contextPct = maxTokens > 0 ? ((input / maxTokens) * 100).toFixed(0) + '%' : '0%';

  return [
    `Ⓥ **Otto** v${cliVersion}`,
    `🧠 **Model**: ${modelName}`,
    `⚙️ **Auth**: ${userName}`,
    `🧮 **Token Usage**`,
    `  Input: ${input.toLocaleString()}`,
    `  Cache Read: ${cacheRead.toLocaleString()}`,
    `  Output: ${output.toLocaleString()}`,
    `  Total: ${total.toLocaleString()}`,
    `  Cache Hit Rate: ${cacheHitRate}`,
    `  Credits: ${lastTokenUsage?.creditsUsage != null ? lastTokenUsage.creditsUsage : 0} / ${remainingCredits}`,
    `📚 **Context**: ${contextK}/${maxM} (${contextPct})`,
    `🧵 **Session**: feishu_${chatId || 'unknown'}`,
    `⚙️ **Think**: ${currentConfig.mode === 'off' ? 'off' : (currentConfig.effort || 'auto')}`,
  ].join('\n');
}

/**
 * 从当前状态生成 FeishuFooterMetrics。
 * @param config 配置对象
 * @param geminiClient Gemini 客户端
 * @param lastRequestTokenUsage 最近一笔请求的真实 token 使用状况
 * @returns FeishuFooterMetrics 对象
 */
async function getFeishuStatusMetrics(
  config: Config,
  _geminiClient: OttoClient,
  lastRequestTokenUsage?: TokenUsageLike | null,
): Promise<FeishuFooterMetrics> {
  const metrics: FeishuFooterMetrics = {};

  try {
    const currentModel = config?.getModel() || '未选择';
    const cloudModelInfo = config?.getCloudModelInfo?.(currentModel);
    metrics.model = cloudModelInfo?.displayName || currentModel;

    const currentConfig = config?.getThinkingConfig() || { mode: 'auto', effort: 'auto' };
    if (currentConfig.mode !== 'off') {
      metrics.status = `思考级别: ${currentConfig.effort || 'auto'}`;
    }

    const maxTokens = tokenLimit(currentModel, config || undefined);

    if (lastRequestTokenUsage) {
      const input = lastRequestTokenUsage.inputTokens || 0;
      const output = lastRequestTokenUsage.outputTokens || 0;
      const cacheReadInputTokens = lastRequestTokenUsage.cacheReadInputTokens || 0;
      const creditsUsage = lastRequestTokenUsage.creditsUsage || 0;
      metrics.tokens = { input, output };

      if (cacheReadInputTokens > 0) {
        metrics.cacheRead = cacheReadInputTokens;
        metrics.cacheHitRate = input > 0 ? (cacheReadInputTokens / input) * 100 : 0;
      }
      if (creditsUsage > 0) {
        metrics.credits = creditsUsage;
      }
      if (input > 0 && maxTokens && maxTokens > 0) {
        metrics.contextPercentage = (input / maxTokens) * 100;
      }
    } else {
      const actualPromptTokens = uiTelemetryService.getLastPromptTokenCount();
      metrics.tokens = {
        input: actualPromptTokens || 0,
        output: 0, // Output tokens are not directly available here without full stream completion
      };

      // Calculate context percentage if possible (assuming actualPromptTokens is current context size)
      if (actualPromptTokens && maxTokens && maxTokens > 0) {
        metrics.contextPercentage = (actualPromptTokens / maxTokens) * 100;
      }
    }

  } catch (err: unknown) {
    dwarn(`Failed to get Feishu status metrics: ${unknownErrorMessage(err)}`);
  }

  return metrics;
}

/**
 * 处理飞书端的斜杠命令（不发给 LLM，本地执行）
 *
 * 返回 null 表示不是命令，应走 LLM agent 流程
 */
async function handleFeishuCommand(
  messageText: string,
  geminiClient: OttoClient,
  config: Config,
  chatId?: string,
): Promise<string | null> {
  const cmd = messageText.split(/\s+/)[0].toLowerCase();

  switch (cmd) {
    case '/new': {
      try {
        await geminiClient.resetChat();
        // 同时创建新的 session 记录
        const sessionManager = new SessionManager(config?.getProjectRoot() || process.cwd());
        const newSession = await sessionManager.createNewSession(undefined, process.cwd());
        return `✅ 新会话已创建\n📝 Session ID: ${newSession.sessionId}\n💬 可以开始新的对话了`;
      } catch (err: unknown) {
        return `❌ 创建新会话失败: ${sanitizeErrorForUser(err)}`;
      }
    }

    case '/compress':
    case '/compact': {
      try {
        const promptId = `feishu-compress-${Date.now()}`;
        const result = await geminiClient.tryCompressChat(
          promptId,
          new AbortController().signal,
          true,
        );
        if (result) {
          return `✅ 对话已压缩\n📦 原始 token: ${result.originalTokenCount}\n📦 压缩后 token: ${result.newTokenCount}`;
        }
        return '⚠️ 没有需要压缩的内容';
      } catch (err: unknown) {
        return `❌ 压缩失败: ${sanitizeErrorForUser(err)}`;
      }
    }

    case '/stop': {
      // 只用 per-chat Map（每个群独立中止），不再有可能误中止无关请求的全局标量控制器。
      const controller = chatId ? activeAbortControllers.get(chatId) : undefined;
      if (controller && chatId) {
        controller.abort();
        activeAbortControllers.delete(chatId);
        // FIX: /stop 必须同步递减处理计数，否则 UI 状态（如飞书卡片 footer）
        // 仍显示「处理中」，且旧 finally 块的 decrementProcessingCount 会
        // 误减新任务的计数
        decrementProcessingCount(chatId);
        // FIX: 清除该 chat 的队列处理状态，防止 /stop 后新消息被错误入队
        // （/stop 只做了 abort + delete controller，遗漏了 isProcessingQueues 和
        //  messageQueues 的清理，导致竞态窗口期间新消息看到 isProcessing=true
        //  被错误入队且无法自愈。详见 docs/bug-report-stop-queue-race-condition.md）
        isProcessingQueues.set(chatId, false);
        // FIX: 清空该 chat 的消息队列（拒绝任何排队中的消息）
        // 注意：必须同时清空数组内容（splice(0)），否则旧 processMessageQueueForChat
        // 的 while 循环仍持有数组引用，会继续处理已被 resolve(null) 的消息。
        const pendingQueue = messageQueues.get(chatId);
        if (pendingQueue) {
          for (const item of pendingQueue) {
            item.resolve(null);
          }
          pendingQueue.splice(0); // 清空数组内容，让旧 while 循环看到 length=0 后自然退出
          messageQueues.delete(chatId);
        }
        return '🛑 已中止当前正在运行的 AI 任务。';
      }
      return '⚠️ 当前没有正在运行的 AI 任务。';
    }

    case '/status': {
      try {
        const statusMsg = await formatStatusMessage(config, geminiClient, chatId);
        return statusMsg;
      } catch (err: unknown) {
        return `❌ 获取状态信息失败: ${sanitizeErrorForUser(err)}`;
      }
    }

    case '/thinking': {
      const parts = messageText.split(/\s+/);
      if (parts.length === 1) {
        const currentConfig = config?.getThinkingConfig() || { mode: 'auto', effort: 'auto' };
        return [
          `💭 **思考配置状态**`,
          `───────────────────────`,
          `当前思考模式: **${currentConfig.mode === 'on' ? '开启' : currentConfig.mode === 'off' ? '关闭' : '自动'}**`,
          `思考强度力度: **${currentConfig.effort || 'auto'}**`,
          `───────────────────────`,
          `💡 **使用以下命令进行切换**:`,
          `  /thinking off  - 关闭思考模式`,
          `  /thinking auto - 设为自动模式`,
          `  /thinking low|medium|high|max - 开启并设置思考强度`,
        ].join('\n');
      }

      const sub = parts[1].toLowerCase();
      const currentConfig = config?.getThinkingConfig() || { mode: 'auto', effort: 'auto' };

      if (['on', 'off', 'auto'].includes(sub)) {
        const newMode = sub as 'on' | 'off' | 'auto';
        const updated = {
          ...currentConfig,
          mode: newMode,
          effort: newMode === 'auto' ? 'auto' : (currentConfig.effort ?? 'auto')
        };
        config?.setThinkingConfig?.(updated);
        globalCommandContext?.services?.settings?.setValue?.(SettingScope.User, 'thinking', updated);
        if (chatId) {
          await saveProjectRoute(chatId, { thinking: updated });
        }
        if (config) {
          appEvents.emit(AppEvent.ModelChanged, config.getModel() || '');
        }
        return `✨ 已成功将思考模式切换为: **${newMode === 'on' ? '开启' : newMode === 'off' ? '关闭' : '自动'}** (力度: ${updated.effort})`;
      } else if (['low', 'medium', 'high', 'max', 'xhigh'].includes(sub)) {
        const newEffort = sub as NonNullable<FeishuProjectRoute['thinking']>['effort'];
        const updated = {
          ...currentConfig,
          mode: 'on' as const,
          effort: newEffort
        };
        config?.setThinkingConfig?.(updated);
        globalCommandContext?.services?.settings?.setValue?.(SettingScope.User, 'thinking', updated);
        if (chatId) {
          await saveProjectRoute(chatId, { thinking: updated });
        }
        if (config) {
          appEvents.emit(AppEvent.ModelChanged, config.getModel() || '');
        }
        return `✨ 已成功开启思考模式，并设置思考力度为: **${newEffort}**`;
      } else {
        return `❌ 未知的思考参数: ${parts[1]}\n请使用 off / auto / low / medium / high / max`;
      }
    }

    case '/model': {
      const parts = messageText.split(/\s+/);
      const settings = globalCommandContext?.services?.settings;
      if (!settings) {
        return '❌ settings 服务不可用，无法更改模型。';
      }

      try {
        const { modelInfos } = await getAvailableModels(settings, config || undefined);

        if (parts.length === 1) {
          // 列出可用模型列表
          const lines = ['🤖 **可用模型列表:**', ''];
          modelInfos.forEach((m) => {
            let modelLine = `• **${m.name}** (${m.displayName})`;
            if (m.creditsPerRequest) {
              modelLine += ` - ${m.creditsPerRequest}x credits`;
            }
            lines.push(modelLine);
          });
          lines.push('');
          lines.push('💡 **提示**: 输入 `/model <模型名>` 即可在线切换 AI 模型');
          return lines.join('\n');
        }

        const targetModelName = parts[1].trim();
        // 查找最匹配的模型
        const exactMatch = modelInfos.find((m) => m.name.toLowerCase() === targetModelName.toLowerCase() || m.displayName.toLowerCase() === targetModelName.toLowerCase());

        if (!exactMatch) {
          return `❌ 未能找到模型 "${targetModelName}"，请通过输入 \`/model\` 查看可用模型列表。`;
        }

        const actualModelName = exactMatch.name;

        if (config) {
          const geminiClient = config.getOttoClient();
          if (geminiClient) {
            await geminiClient.waitForChatInitialized();
            const switchResult = await geminiClient.switchModel(actualModelName, new AbortController().signal);

            if (!switchResult.success) {
              return `❌ 切换到模型 **${exactMatch.displayName}** 失败: ${switchResult.error || '可能由于上下文压缩失败'}`;
            }

            // switchModel 内部已调用 config.setModel + chat.setSpecifiedModel，切换成功后再持久化
            settings.setValue(SettingScope.User, 'preferredModel', actualModelName);
            if (chatId) {
              await saveProjectRoute(chatId, { model: actualModelName });
            }

            let responseMsg = `✨ 已成功切换 AI 模型为: **${exactMatch.displayName}** (${actualModelName})`;
            if (switchResult.compressionInfo) {
              responseMsg += `\n📦 上下文已自动压缩: ${switchResult.compressionInfo.originalTokenCount} → ${switchResult.compressionInfo.newTokenCount} tokens`;
            } else if (switchResult.compressionSkipReason) {
              responseMsg += `\n✓ ${switchResult.compressionSkipReason}`;
            }

            // 🎯 发出 ModelChanged 事件，强制通知并更新 CLI 终端的 Footer 状态显示
            appEvents.emit(AppEvent.ModelChanged, actualModelName);
            return responseMsg;
          }
        }

        // 无 config/client 时（理论上不应发生），也先尝试持久化
        settings.setValue(SettingScope.User, 'preferredModel', actualModelName);
        if (chatId) {
          await saveProjectRoute(chatId, { model: actualModelName });
        }
        return `✨ 已成功切换 AI 模型为: **${exactMatch.displayName}** (${actualModelName})`;
      } catch (err: unknown) {
        return `❌ 切换模型失败: ${sanitizeErrorForUser(err)}`;
      }
    }

    case '/help': {
      const lines = ['📖 飞书可用命令:', ''];
      for (const [name, desc] of Object.entries(FEISHU_SLASH_COMMANDS)) {
        lines.push(`  ${name.padEnd(20)} ${desc}`);
      }
      lines.push('');
      lines.push('💡 此外还支持 CLI 内置斜杠命令（如 /ask、/wiki 等）');
      lines.push('💡 其他任何消息都会发送给 AI Agent 处理（支持工具调用）');
      return lines.join('\n');
    }

    default:
      return null; // 不是命令，走 LLM
  }
}

interface CliSlashCommandResult {
  type: 'text' | 'submit_prompt';
  content: string;
}

/**
 * 载入并执行通用的 CLI 斜杠命令
 */
async function handleCliSlashCommandInFeishu(
  messageText: string,
  config: Config,
  _chatId: string,
): Promise<CliSlashCommandResult | null> {
  const settingsManager = new SettingsManager();
  const marketplaceManager = new MarketplaceManager(settingsManager);
  const skillLoader = new SkillLoader(settingsManager, marketplaceManager);

  // 1. 初始化 loaders
  const loaders = [
    new McpPromptLoader(config),
    new BuiltinCommandLoader(config),
    new InlineCommandLoader(config),
    new ExtensionCommandLoader(config),
    new FileCommandLoader(config),
    new PluginCommandLoader(skillLoader, settingsManager),
  ];

  // 2. 加载所有的 CLI SlashCommand
  const abortController = new AbortController();
  const commandService = await CommandService.create(loaders, abortController.signal);
  const commands = commandService.getCommands();

  // 3. 解析用户输入的命令
  const trimmed = messageText.trim();
  const parts = trimmed.substring(1).trim().split(/\s+/);
  const commandPath = parts.filter((p) => p);

  if (commandPath.length === 0) {
    return null;
  }

  // 4. 寻找匹配的命令
  let currentCommands: readonly SlashCommand[] = commands;
  let commandToExecute: SlashCommand | undefined;
  let pathIndex = 0;

  for (const part of commandPath) {
    let foundCommand = currentCommands.find((cmd) => cmd.name === part);
    if (!foundCommand) {
      foundCommand = currentCommands.find((cmd) =>
        cmd.altNames?.includes(part),
      );
    }

    if (foundCommand) {
      commandToExecute = foundCommand;
      pathIndex++;
      if (foundCommand.subCommands) {
        currentCommands = foundCommand.subCommands;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  if (!commandToExecute) {
    return null; // 不是有效 CLI 斜杠命令
  }

  // 5. 提取参数
  const args = parts.slice(pathIndex).join(' ');

  // 6. 构造 CommandContext 并执行
  const collectedTexts: string[] = [];
  const context: CommandContext = {
    invocation: {
      raw: trimmed,
      name: commandToExecute.name,
      args,
    },
    isNonInteractive: true,
    services: {
      config,
      settings: globalCommandContext?.services?.settings || ({} as unknown as LoadedSettings),
      git: globalCommandContext?.services?.git,
      logger: console as unknown as CommandContext['services']['logger'],
    },
    ui: {
      addItem: (item) => {
        if (item && item.text) {
          collectedTexts.push(item.text);
        }
        return Date.now();
      },
      clear: () => {
        collectedTexts.push('🧹 (屏幕已清空)');
      },
      setDebugMessage: () => {},
      pendingItem: null,
      setPendingItem: () => {},
      loadHistory: () => {},
      toggleCorgiMode: () => {},
      toggleVimEnabled: async () => false,
    },
    session: {
      stats: {
        sessionStartTime: new Date(),
        lastPromptTokenCount: 0,
        promptCount: 0,
        subAgentStats: {
          totalApiCalls: 0,
          totalErrors: 0,
          totalLatencyMs: 0,
          totalTokens: 0,
          promptTokens: 0,
          candidatesTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          thoughtsTokens: 0,
          toolTokens: 0,
        },
        metrics: {
          models: {},
          tools: {
            totalCalls: 0,
            totalSuccess: 0,
            totalFail: 0,
            totalDurationMs: 0,
            totalDecisions: {
              accept: 0,
              reject: 0,
              modify: 0,
            },
            byName: {},
          },
        },
      },
      cumulativeCredits: 0,
      totalSessionCredits: 0,
    },
  };

  if (commandToExecute.action) {
    const actionResult = await commandToExecute.action(context, args);

    // 如果命令执行返回了结果
    if (actionResult) {
      if (actionResult.type === 'message') {
        collectedTexts.push(actionResult.content);
      } else if (actionResult.type === 'submit_prompt') {
        return {
          type: 'submit_prompt',
          content: actionResult.content,
        };
      } else if (actionResult.type === 'dialog') {
        // 提供极致贴心的飞书端 TUI 交互拦截友好提示
        const dialogType = actionResult.dialog;
        let hint = `⚠️ **该命令需要终端（TUI）交互界面支持。**\n\n您当前正在通过【飞书机器人远程模式】进行操作，无法打开本地 TUI 设置浮窗。`;

        if (dialogType === 'settings-menu' || dialogType === 'theme' || dialogType === 'editor') {
          hint += `\n\n💡 **您可以通过输入具体的配置子命令来直接配置（免交互）**:\n` +
                  `  • \`/model <模型名>\` - 在线直接切换 AI 模型\n` +
                  `  • \`/thinking <off|auto|high>\` - 配置 AI 思考模式与力度`;
        } else if (dialogType === 'debate-wizard') {
          hint += `\n\n💡 **您可以通过以下免交互的辩论子命令来进行管理**:\n` +
                  `  • \`/debate status\` - 查看当前辩论详情\n` +
                  `  • \`/debate continue\` - 继续暂停的辩论\n` +
                  `  • \`/debate end\` - 强制结束当前辩论`;
        } else if (dialogType === 'goal-wizard') {
          hint += `\n\n💡 **目标驱动模式（飞书端已支持）**:\n` +
                  `  • \`/goal\` 或 \`/goal new\` - 弹出目标表单卡片，填写后启动目标模式\n` +
                  `  • \`/goal clear\` - 结束当前 goal 模式，释放契约约束`;
        }

        collectedTexts.push(hint);
      } else if (actionResult.type === 'select_session') {
        collectedTexts.push(
          `⚠️ **该命令需要 TUI 列表光标交互支持。**\n\n` +
          `您当前处于飞书端，无法进行光标选择。建议您通过 \`/new\` 直接开始一个干净的新会话。`
        );
      } else if (actionResult.type === 'quit') {
        collectedTexts.push(
          `⚠️ **无法在远程模式下终止服务端进程。**\n\n` +
          `如果您想中断当前的 AI 生成任务，请使用 \`/stop\` 命令。`
        );
      }
    }
  }

  // 返回收集到的所有输出文本
  return {
    type: 'text',
    content: collectedTexts.join('\n'),
  };
}

/**
 * 清理消息文本中多余的首部 @机器人 提及。
 *
 * 飞书群聊消息由于必须通过 @机器人 触发，因此传入的消息通常包含 `@otto2`、`@_user_1` 等前缀。
 * 本函数自动匹配并剥除这些提及前缀，使得：
 *  1. 群聊中的斜杠命令（例如 `@otto2 /new` 变成 `/new`）能被正确识别和拦截。
 *  2. 群聊中的绑定指令（例如 `@otto2 /bind d:\123` 变成 `/bind d:\123`）能顺畅执行。
 *  3. LLM 接收到纯净的提问，不易产生 @ 前缀造成的格式幻觉。
 */
function stripBotMention(text: string, botName?: string): string {
  let cleaned = text.trim();

  // 1. 剥除飞书常用的 @_user_xxx 格式提及
  cleaned = cleaned.replace(/^@_user_\d+\s*/, '');

  // 2. 剥除指定 botName 形式的提及
  if (botName) {
    const escapedName = botName.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`^@${escapedName}\\s*`, 'i');
    cleaned = cleaned.replace(regex, '');
  }

  // 3. 兜底剥除通用的 @otto 提及
  cleaned = cleaned.replace(/^@otto2?\s*/i, '');
  cleaned = cleaned.replace(/^@智能体\s*/i, ''); // 飞书自带的应用标签前缀

  return cleaned.trim();
}

export type FeishuAutoReplyTriggerReason =
  | 'private'
  | 'bot_mention'
  | 'slash_command'
  | 'ignored_group';

export interface FeishuAutoReplyDecision {
  shouldHandle: boolean;
  reason: FeishuAutoReplyTriggerReason;
  text: string;
}

export function decideFeishuAutoReply(input: {
  chatType: FeishuMessage['chatType'];
  rawText: string;
  cleanedText: string;
  mentions?: Array<{ key?: string; openId?: string }>;
  botName?: string;
  botOpenId?: string;
}): FeishuAutoReplyDecision {
  const rawText = input.rawText.trim();
  const cleanedText = input.cleanedText.trim();
  const botName = input.botName?.trim().toLowerCase();
  const botOpenId = input.botOpenId?.trim();
  const mentions = input.mentions || [];

  if (input.chatType === 'p2p') {
    return { shouldHandle: true, reason: 'private', text: cleanedText };
  }

  if (cleanedText.startsWith('/')) {
    return { shouldHandle: true, reason: 'slash_command', text: cleanedText };
  }

  const strippedLeadingMention = rawText !== cleanedText && /^@/.test(rawText);
  const mentionedByOpenId = !!botOpenId && mentions.some(m => m.openId === botOpenId);
  const mentionedByName = !!botName && mentions.some(m => (m.key || '').toLowerCase().includes(botName));
  const mentionedByKnownAlias = mentions.some(m => /otto|智能体/i.test(m.key || ''));

  if (strippedLeadingMention || mentionedByOpenId || mentionedByName || mentionedByKnownAlias) {
    return { shouldHandle: true, reason: 'bot_mention', text: cleanedText };
  }

  return { shouldHandle: false, reason: 'ignored_group', text: cleanedText };
}

export function buildFeishuProcessingReceipt(reason: FeishuAutoReplyTriggerReason): string {
  const triggerLabel =
    reason === 'private'
      ? '私聊自动触发'
      : reason === 'slash_command'
        ? '命令触发'
        : '群聊 @ 触发';

  return [
    `✅ 已收到（${triggerLabel}），我会开始处理。`,
    '',
    '过程会尽量用人能看懂的方式更新：读取资料 → 分析问题 → 调用工具（如需要） → 汇总结果。',
  ].join('\n');
}

export function appendFeishuProcessSummary(
  markdown: string,
  executedToolNames: string[],
): string {
  const base = markdown.trim() || '（无回复）';
  if (base.includes('**本次处理总结**')) {
    return base;
  }

  const uniqueToolNames = Array.from(new Set(
    executedToolNames.map(name => name.trim()).filter(Boolean),
  ));
  const toolLine = uniqueToolNames.length > 0
    ? `调用了 ${uniqueToolNames.slice(0, 4).join('、')}${uniqueToolNames.length > 4 ? ` 等 ${uniqueToolNames.length} 个工具` : ''}。`
    : '没有调用额外工具。';

  return `${base}\n\n---\n**本次处理总结**\n- 做了什么：已读取本次问题并完成分析，${toolLine}\n- 结果是什么：见上方回复。\n- 还差什么：如上方已列出待补充信息，请继续补充；否则本轮已完成。`;
}

/**
 * 启动网关（从已保存的凭证）
 */
async function handleStart(context?: CommandContext): Promise<string> {
  const result = await loadCredsSafe();
  if (!result.ok) {
    return tp('feishu.start.creds_load_failed', { error: result.error });
  }
  const creds = result.creds;
  if (!creds) {
    return [
      t('feishu.start.no_creds_title'),
      '',
      t('feishu.start.no_creds_setup'),
      t('feishu.start.no_creds_qr'),
      t('feishu.start.no_creds_or'),
      t('feishu.start.no_creds_manual'),
    ].join('\n');
  }

  if (activeGateway) {
    return t('feishu.start.already_running');
  }

  // 互斥守卫：防止两次并发 start 在 gateway.connect() 期间都通过 activeGateway 检查，
  // 各自打开一条 WS 长连接（第一条被孤立 → 消息双发）。
  if (startInFlight) {
    return t('feishu.start.already_running');
  }
  startInFlight = true;

  const gateway = new FeishuGateway(creds.appId, creds.appSecret, creds.domain);

  // 保存 TUI 上下文（用于同步消息到 UI）
  if (context?.ui) {
    tuiContext = context.ui;
  }
  globalCommandContext = context || null;

  // 获取 OttoClient
  const config = context?.services?.config;
  const geminiClient = config?.getOttoClient?.();

  // 设置消息处理 — 使用主会话的 agent 模式（带工具执行能力）
  gateway.onMessage = async (msg: FeishuMessage): Promise<string | null> => {
    const rawMessageText = typeof msg.text === 'string' ? msg.text.trim() : '';
    let messageText = rawMessageText;
    if (!messageText) {
      return null;
    }

    // 🧹 清理消息文本中由于群聊 @ 产生的提及前缀，使群内斜杠命令（如 /new, /bind）能够正常拦截执行
    messageText = stripBotMention(messageText, creds.botName);
    if (!messageText) {
      return null;
    }

    const autoReplyDecision = decideFeishuAutoReply({
      chatType: msg.chatType,
      rawText: rawMessageText,
      cleanedText: messageText,
      mentions: msg.mentions,
      botName: creds.botName,
      botOpenId: creds.botOpenId,
    });
    if (!autoReplyDecision.shouldHandle) {
      dlog(
        `[Feishu] Ignored non-trigger group/topic message in chat ${msg.chatId}: ` +
        safeTruncateForLog(messageText, 80),
      );
      return null;
    }

    // 🛡️ 授权检查（B1）：只允许 ownerOpenId 或 allowlist 中的 senderOpenId
    // 触发 LLM/工具调用。任何其他人发送的消息直接拒绝，绝不会进入 agent 循环
    // 或访问本地文件系统，避免 Bot 成为远程 RCE 入口。
    if (!isSenderAuthorized(creds, msg.senderOpenId)) {
      const reply = creds.ownerOpenId
        ? `🛡️ 此 Bot 仅响应授权用户。如需使用，请联系 Bot 拥有者用 \`/feishu allow ${msg.senderOpenId}\` 添加你。`
        : `🛡️ 此 Bot 尚未配置授权用户。请 Bot 拥有者在 otto 中执行 \`/feishu allow ${msg.senderOpenId}\` 后再试。`;
      tuiContext?.addItem(
        {
          type: 'info',
          text: tp('feishu.tui.unauthorized_log', {
            openId: msg.senderOpenId,
            text: messageText.slice(0, 60),
          }),
        },
        Date.now(),
      );
      return reply;
    }

    // 🚫 拦截飞书侧的 /feishu start | /feishu stop 生命周期命令：
    // 这两个命令管理的是本地正在转发消息的网关进程本身，只能在本地终端执行，
    // 在飞书里执行会自断连接或无意义。给友好提示后直接返回，不透传给 CLI 处理器。
    const lifecycleHint = interceptFeishuLifecycleCommand(messageText);
    if (lifecycleHint) {
      return lifecycleHint;
    }

    // 🆘 拦截 `/feishu restart`（或 /飞书 restart）：热重启网关进程，用于 AI 卡死/
    //    失去响应时的兜底恢复。由网关在 AI 处理之前直接处理（不经过 agent 循环，
    //    因为 AI 可能已经卡住）。复用 self_update 的同一套跨平台外挂脚本，仅重启不更新。
    const restartMatch = messageText.trim().match(/^\/(?:feishu|飞书)\s+restart\b/i);
    if (restartMatch) {
      try {
        // 优雅重启：中止 AI → 断开 WS → spawn 外挂 → 延迟退出
        gracefulRestartThenExit({ type: 'none' });
        return process.platform === 'win32'
          ? '🔄 收到重启指令，正在热重启飞书机器人（不更新版本），稍候我就回来。'
          : '🔄 收到重启指令，正在热重启飞书机器人（不更新版本）。根据您的操作系统限制，重启后将以后台进程（无界面）运行，使用 `ps -ef | grep otto` 即可查看。';
      } catch (e: unknown) {
        return `❌ 重启失败：${unknownErrorMessage(e)}`;
      }
    }

    // 拦截群内自助绑定的 `/bind` 命令
    // 支持：`/bind <路径>`、`/bind <路径> --agent claude-code|codex|self`、`/bind --agent codex`
    if (messageText.startsWith('/bind')) {
      // 🛡️ 安全收紧：/bind 会在服务端任意路径创建目录并改写工作区路由，属于特权操作，
      //    仅限 Bot 拥有者执行，白名单用户无权（避免被授权用户在任意路径建目录 / 改绑工作区）。
      if (!creds.ownerOpenId || msg.senderOpenId !== creds.ownerOpenId) {
        return '🛡️ `/bind` 仅限 Bot 拥有者使用（会在服务端创建目录并改写工作区绑定）。请联系 Bot 拥有者代为绑定。';
      }
      const argString = messageText.slice('/bind'.length).trim();
      const { agent, rest } = parseBindAgentFlag(argString);
      const targetPath = rest.split(/\s+/).filter(Boolean)[0]?.trim();

      // 仅切换默认 agent（不带路径）：用于给已绑定的群改派发目标
      if (!targetPath && agent) {
        try {
          await saveProjectRoute(msg.chatId, { agent });
          emitFeishuProjectRoutesUpdated();
          return `✅ 已将本群的默认执行方切换为 **${agentDisplayLabel(agent)}**。`;
        } catch (e: unknown) {
          return `❌ 切换默认执行方失败: ${sanitizeErrorForUser(e)}`;
        }
      }

      if (!targetPath) {
        return '❌ 绑定命令格式不正确。\n格式：`/bind <您本地项目的绝对物理路径>`（可选 `--agent claude-code|codex|self`）';
      }
      try {
        const path = await import('node:path');
        const fs = await import('node:fs');
        const absPath = path.resolve(targetPath);
        if (!fs.existsSync(absPath)) {
          fs.mkdirSync(absPath, { recursive: true });
        }
        const routeUpdate: Partial<FeishuProjectRoute> = { projectRoot: absPath };
        if (agent) routeUpdate.agent = agent;
        await saveProjectRoute(msg.chatId, routeUpdate);
        // 📡 通知仪表板路由已更新
        emitFeishuProjectRoutesUpdated();
        const agentTip = agent
          ? `\n🤖 **默认执行方**: ${agentDisplayLabel(agent)}`
          : '';
        return `✅ 恭喜！本群已成功绑定本地项目工作区！\n📂 **工作目录**: \`${absPath}\`${agentTip}\n💬 您现在可以直接在群里向我提问，我将全力协助您！`;
      } catch (e: unknown) {
        return `❌ 绑定目录失败: ${sanitizeErrorForUser(e)}`;
      }
    }

    // 📊 拦截 `/acp-session`（或 `/acp会话`）：推送一张多会话 Dashboard 卡片，展示
    //    本机正在运行/最近的委派任务（实时状态：当前工具/计划进度/token%/耗时）
    //    + 各 CLI 可续接的历史会话（含 `@cc:resume <id>` 续接提示）。
    //    直接由网关发卡并异步刷新，不经过 LLM 队列。
    //    注：不使用 /sessions 是因为 CLI 自带 /session 命令会抢先匹配。
    if (/^\/acp-(session|会话)\b/i.test(messageText.trim())) {
      try {
        const boundCwd = (await loadProjectRoutes())[msg.chatId]?.projectRoot;
        await handleSessionsCommand({
          gateway,
          chatId: msg.chatId,
          replyToMessageId: msg.messageId,
          cwd: boundCwd,
        });
      } catch (e) {
        await gateway.sendMessage(
          msg.chatId,
          `❌ 获取会话列表失败：${e instanceof Error ? e.message : String(e)}`,
          msg.messageId,
        );
      }
      return null;
    }

    // 🎯 更新全局活跃发送人 (让建群工具可以拉当前发消息的人进新群)
    activeSenderOpenId = msg.senderOpenId;

    // 🎯 实时、动态拉取最新的 config 和 geminiClient，防止闭包在启动后变化而未感知
    const activeConfigCandidate = globalCommandContext?.services?.config || config;
    if (!activeConfigCandidate) {
      return '❌ AI 客户端尚未就绪，请稍后重试。';
    }
    const activeConfig: Config = activeConfigCandidate;
    let activeClient: OttoClient | null = null;
    let initErrorMsg = '';
    const debugTrail: string[] = [];

    if (activeConfig) {
      try {
        activeClient = activeConfig.getOttoClient?.();
        debugTrail.push(`step1=${activeClient ? 'gotClient' : 'nullClient'}`);
      } catch (e: unknown) {
        initErrorMsg = unknownErrorMessage(e);
        debugTrail.push(`step1=threw:${initErrorMsg.slice(0, 80)}`);
        dwarn(`[Feishu] getOttoClient threw: ${initErrorMsg}`);
      }

      // 🚀 关键：CLI 启动延迟认证策略 — 用户首次在 TUI 发消息时才会 refreshAuth 初始化 geminiClient。
      // 但飞书这边并不会等用户在 TUI 发消息，所以我们必须在这里主动 lazy 触发首次认证刷新，
      // 拿到一个真正可用的 geminiClient 实例。
      if (!activeClient) {
        try {
          const settings = globalCommandContext?.services?.settings;
          const authType = settings?.merged?.selectedAuthType || AuthType.USE_PROXY_AUTH;
          debugTrail.push(`step2=lazyRefreshAuth(${authType})`);
          dlog(`[Feishu] geminiClient is not initialized. Triggering lazy refreshAuth(${authType})...`);
          await activeConfig.refreshAuth(authType);
          activeClient = activeConfig.getOttoClient?.();
          debugTrail.push(`step3=${activeClient ? 'lazyOk' : 'lazyStillNull'}`);
          if (activeClient) {
            dlog(`[Feishu] Lazy refreshAuth succeeded; geminiClient is ready.`);
            initErrorMsg = '';

            // 🔄 异步刷新云端模型列表（与 CLI useOttoStream 行为对齐）
            // 飞书用户可能从不使用 CLI 交互，若不在消息处理时同步，
            // 模型列表会一直停留在进程启动时的快照，无法感知服务端增删。
            const feishuSettings = globalCommandContext?.services?.settings;
            if (feishuSettings && activeConfig) {
              refreshModelsInBackground(feishuSettings, activeConfig).catch(() => {
                // 静默失败，不阻塞飞书消息处理
              });
            }
          }
        } catch (e: unknown) {
          const message = unknownErrorMessage(e);
          initErrorMsg = `Lazy refreshAuth failed: ${message}`;
          debugTrail.push(`step2=threw:${message.slice(0, 80)}`);
          dwarn(`[Feishu] ${initErrorMsg}`);
        }
      }
    } else {
      debugTrail.push(`step0=noActiveConfig`);
    }

    // 🎯 拦截 `/goal` 或 `/goal new`：发送目标表单卡片收集字段，提交后启动目标驱动模式。
    //    （`/goal clear` 不在此拦截，继续走下方通用 CLI 斜杠命令处理。）
    //    复用 CLI 已有内核：buildGoalPrompt 组装 prompt（此处），launchGoalMode
    //    的 YOLO+setGoalContext 延迟到隔离 session 就绪后执行（见下方）。
    const goalMatch = messageText.trim().match(/^\/(?:goal|目标)(?:\s+(new|新建))?\s*$/i);
    // ⚠️ 暂存本次 /goal 表单结果。launchGoalMode 必须延迟到隔离 session 的
    //    config/client 就绪后再执行——否则 setGoalContext + YOLO 会错误地
    //    落到【主 TUI 的共享 config】上，触发 App.tsx 的 goal watchdog 在
    //    TUI 大厅里 submitQuery，把本应发往飞书卡片的输出泄漏到终端。
    //    详见下方 currentConfig 就绪后的延迟启动逻辑。
    let pendingGoalResult: GoalWizardResult | null = null;
    if (goalMatch) {
      if (!activeConfig) {
        return '❌ 目标模式暂不可用：AI 客户端尚未就绪，请稍后重试。';
      }
      try {
        // 发表单卡片并等待用户提交
        const formResult = await gateway.askGoalFormViaCard(
          msg.chatId,
          10 * 60 * 1000,
          msg.messageId,
        );
        if (!formResult.ok || !formResult.fields) {
          return formResult.timedOut
            ? '⏰ 目标表单等待超时，已取消。需要时请重新发送 `/goal`。'
            : '❌ 目标表单发送失败，请稍后重新发送 `/goal`。';
        }

        // 校验 + 归一化（失败提示重填）
        const normalized = normalizeGoalFields(formResult.fields);
        if (!normalized.ok || !normalized.result) {
          return `❌ ${normalized.error}`;
        }

        // 组装 goal prompt（buildGoalPrompt 是纯函数，不依赖 config）。
        // ⚠️ 必须同时更新 messageText 与 msg.text：本条消息最终是以 `msg`
        //    为载体入队（queue.push({ msg })），由队列消费者 handleSingleFeishuMessage
        //    重新读取 msg.text 作为喂给 agent 的内容。只改局部 messageText 而不改
        //    msg.text，goal prompt 会在入队边界丢失，agent 收到的仍是 "/goal"。
        // YOLO + setGoalContext 的真正启动推迟到 currentConfig 就绪后执行。
        pendingGoalResult = normalized.result;
        messageText = buildGoalPrompt(normalized.result);
        msg = { ...msg, text: messageText };
      } catch (e: unknown) {
        return `❌ 启动目标模式失败：${unknownErrorMessage(e)}`;
      }
    }

    // 🎯 1. 实时更新当前会话上下文辅助数据（供 session 隔离下的工具调用读取最新状态）
    chatLastMessageId.set(msg.chatId, msg.messageId);
    activeSenderOpenIds.set(msg.chatId, msg.senderOpenId);

    // 🚀 多项目路由环境拦截
    const routes = await loadProjectRoutes();
    const route = routes[msg.chatId];

    // 如果当前是群聊消息，且完全没有绑定任何本地项目，提示绑定并拦截
    if (msg.chatType === 'group' && (!route || !route.projectRoot)) {
      const bindTip = `⏳ **本飞书群尚未绑定任何本地项目工作区。**\n\n` +
        `请群管理员或 Bot 拥有者在此群发送：\n` +
        `  \`/bind <您本地项目的绝对路径>\`\n` +
        `*(例如：\`/bind D:\\projects\\my-great-app\`)*\n\n` +
        `绑定成功后，我将在此专属群里为您提供该项目的 AI 远程控制和代码读写服务！\n\n` +
        `💡 **提示**: 您也可以在单聊私信中，直接对我说：“创建一个新项目 工作目录是 d:\\123”，让我为您自动建群并绑定工作区哦！`;
      await gateway.sendMessage(msg.chatId, bindTip, msg.messageId);
      return null;
    }

    // 🚀 确保每一笔会话（私聊或绑定的群聊）都具有完整、彻底隔离的环境！
    let session = isolatedSessions.get(msg.chatId);
    if (session) session.lastActivityAt = Date.now();
    let currentConfig = activeConfig;
    let currentClient = activeClient;

    // 🔒 TOCTOU 守卫：同一 chat 的两条首消息会并发进入此处。若已有"在途"创建
    //    Promise，直接 await 复用，避免各建一个 OttoClient（泄漏 + 覆盖恢复历史）。
    if (!session) {
      const inFlight = isolatedSessionInFlight.get(msg.chatId);
      if (inFlight) {
        debugTrail.push('isolatedAwaitInFlight');
        session = (await inFlight) ?? session;
      }
    }

    if (!session) {
      // 本次调用成为该 chat 的唯一创建者：把创建逻辑包进一个 Promise 存入在途 Map，
      // 后到的并发消息会 await 同一个 Promise（见上方守卫）。
      let resolveInFlight!: (
        s: { config: Config; geminiClient: OttoClient; lastActivityAt?: number } | null,
      ) => void;
      const inFlightPromise = new Promise<
        { config: Config; geminiClient: OttoClient; lastActivityAt?: number } | null
      >((res) => {
        resolveInFlight = res;
      });
      isolatedSessionInFlight.set(msg.chatId, inFlightPromise);

      try {
      // 决定此会话的目标工作区路径
      const workspaceRoot = (route && route.projectRoot)
        ? route.projectRoot
        : ((typeof activeConfig?.getProjectRoot === 'function' && activeConfig.getProjectRoot()) || process.cwd());

      // Router 诊断。不完全去掉、但精简：普通模式只显示一行短目录（保留"消息路由到
      // 哪个工作目录"的信息），不再每条都刷一长串绝对路径；debug 模式打完整。
      if (activeConfig?.getDebugMode?.()) {
        tuiContext?.addItem({
          type: 'info',
          text: `🔍 [Router] Chat \`${msg.chatId}\` → \`${workspaceRoot}\`${route ? '' : ' (未绑定)'}`,
        }, Date.now());
      } else {
        const shortDir = workspaceRoot.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
        tuiContext?.addItem({
          type: 'info',
          text: `📂 ${shortDir}${route ? '' : ' (未绑定)'}`,
        }, Date.now());
      }

      const settings = globalCommandContext?.services?.settings;

      // 🚀 加载独立会话的项目级/全局指令记忆 (OTTO.md / AGENTS.md)，确保 AI 在独立会话中继承完整的行为规范约束
      const sessionMemory = await loadFeishuSessionMemory(workspaceRoot, settings);

      // 🧠 护城河:叠加该飞书 chat 专属的【按会话隔离个人记忆】(每 chat 一个文件,
      //    跨会话/跨用户不串味)。save_memory 也会写入同一文件(见下方 feishuSessionMemoryFile)。
      const feishuSessionMemFile = getFeishuSessionMemoryPath(msg.chatId);
      let mergedUserMemory = sessionMemory.userMemory;
      try {
        const fsp = await import('node:fs/promises');
        const sessMem = await fsp
          .readFile(feishuSessionMemFile, 'utf-8')
          .catch(() => '');
        if (sessMem.trim()) {
          // 限大小,避免无界记忆撑爆 prompt(审计:记忆无上限)。
          const capped = sessMem.slice(0, 32 * 1024);
          mergedUserMemory =
            `${mergedUserMemory}\n\n## 本会话记忆 (Otto session memory)\n${capped.trim()}`.trim();
        }
      } catch {
        /* best effort:个人记忆读取失败不阻断会话 */
      }

      // 🎯 会话续接（对齐标准 CLI 的 /session 恢复机制）：优先复用该项目"最后一个有
      //    内容的 session"，使飞书重启 / 再次聊天时能接续上次对话。找不到（从没聊过）
      //    才用稳定的新 sessionId。getLastActiveSession(true) 会跳过没有用户消息的空壳。
      const resumed = await resolveResumableSessionId(workspaceRoot);
      const effectiveSessionId =
        resumed.sessionId || `feishu-${msg.chatId}-${Date.now()}`;
      if (resumed.sessionId) {
        dlog(`[Router] Resuming last session '${resumed.sessionId}' for chatId '${msg.chatId}' on '${workspaceRoot}'`);
      }

      dlog(`[Router] Instantiating isolated environment for chatId '${msg.chatId}' on root '${workspaceRoot}' with ${sessionMemory.geminiMdFileCount} memory file(s)`);
      const isolatedConfig = new Config({
        sessionId: effectiveSessionId,
        cwd: workspaceRoot,
        feishuMode: true,
        debugMode: config?.getDebugMode() || false,
        targetDir: workspaceRoot,
        model: route?.model || settings?.merged?.preferredModel || 'auto',
        userMemory: mergedUserMemory,
        feishuSessionMemoryFile: feishuSessionMemFile,
        memoryTokenCount: sessionMemory.memoryTokenCount,
        geminiMdFileCount: sessionMemory.geminiMdFileCount,
        customModels: activeConfig?.getCustomModels() || [],
        cloudModels: activeConfig?.getCloudModels() || [],
        proxy: activeConfig?.getProxy(),
        customProxyServerUrl: activeConfig?.getCustomProxyServerUrl(),
        mcpServers: activeConfig?.getMcpServers(),
      });

      try {
        // 🚀 关键：必须先对全新的 Config 实例执行 initialize()，否则内部的 toolRegistry、
        // hookSystem 等核心组件不会被构建，导致 refreshAuth 抛错或 fallback 回主环境，
        // 从而引发“群聊工作目录依旧是 D:\projects\ottocode\DeepCode”的安全状态漂移 Bug。
        dlog(`[Router] Initializing isolatedConfig on '${workspaceRoot}'...`);
        await isolatedConfig.initialize();

        // 🚀 回放持久化的思考模式与力度
        if (route?.thinking) {
          dlog(`[Router] Replaying thinking config for chatId '${msg.chatId}': ${JSON.stringify(route.thinking)}`);
          isolatedConfig.setThinkingConfig(route.thinking);
        }

        // 主动 refreshAuth 初始化 OttoClient
        const settings = globalCommandContext?.services?.settings;
        const isolatedAuthType = settings?.merged?.selectedAuthType || AuthType.USE_PROXY_AUTH;
        dlog(`[Router] Calling refreshAuth(${isolatedAuthType}) on isolatedConfig...`);
        await isolatedConfig.refreshAuth(isolatedAuthType);
        const isolatedClient = isolatedConfig.getOttoClient();
        if (!isolatedClient) {
          throw new Error('refreshAuth completed but isolatedConfig.getOttoClient() still returns null/undefined.');
        }

        // 🎯 在此会话特定的 toolRegistry 中，专属且精确注册飞书工具，绝不污染或错乱其他群的消息卡片
        const toolRegistry = await isolatedConfig.getToolRegistry();

        // 注册专属于此 chatId 的文件发送工具，彻底杜绝多群并发时发送文件发错群的问题
        toolRegistry.registerTool(new SendFeishuFileTool(
          gateway,
          () => msg.chatId,
          () => chatLastMessageId.get(msg.chatId),
          () => workspaceRoot,
        ));

        // 注册专属于此 chatId 的建群工具
        // ⚠️ 跨群泄漏修复：getActiveChatId / getSenderOpenId 必须绑定到本 session 的
        //    msg.chatId（在工具构造时固化），绝不能读可变全局 activeChatId——否则
        //    A 群发起的建群会把"免@权限"提示私聊发到正在并发处理的 B 群发起人。
        toolRegistry.registerTool(new CreateProjectGroupTool({
          gateway,
          getSenderOpenId: () => activeSenderOpenIds.get(msg.chatId),
          getActiveChatId: () => msg.chatId,
          onProjectCreated: async (newChatId, path, agent) => {
            const update: Partial<FeishuProjectRoute> = { projectRoot: path };
            if (agent) update.agent = agent;
            await saveProjectRoute(newChatId, update);
            emitFeishuProjectRoutesUpdated();
          },
        }));

        // 注册飞书模式专属的音频朗读/转录工具（正常模式下不加载，避免污染和误导模型）
        toolRegistry.registerTool(new AudioReaderTool(isolatedConfig));

        // 注册视频分析工具（飞书模式专属）
        toolRegistry.registerTool(new VideoAnalyzerTool(isolatedConfig));

        // 注册飞书模式专属的自更新重启工具（普通 CLI 模式绝不注册）
        toolRegistry.registerTool(new SelfUpdateTool(isolatedConfig));

        await isolatedClient.setTools();
        dlog(`[Router] Successfully registered session-specific tools for '${msg.chatId}'`);

        // 🎯 注入续接会话的 AI 客户端历史（对齐 CLI useSessionRestore 的 setHistory）。
        //    仅当成功解析到上次有内容的 session 时才注入，空 session 不会有 clientHistory。
        if (resumed.sessionId && resumed.clientHistory && resumed.clientHistory.length > 0) {
          try {
            isolatedClient.setHistory(resumed.clientHistory);
            dlog(`[Router] Restored ${resumed.clientHistory.length} client-history items for chatId '${msg.chatId}'`);
          } catch (histErr: unknown) {
            dwarn(`[Router] Failed to restore client history for '${msg.chatId}': ${unknownErrorMessage(histErr)}`);
          }
        }

        session = { config: isolatedConfig, geminiClient: isolatedClient, lastActivityAt: Date.now() };
        isolatedSessions.set(msg.chatId, session);
        debugTrail.push(`isolatedReady`);
      } catch (e: unknown) {
        const message = unknownErrorMessage(e);
        initErrorMsg = `Isolated session init failed: ${message}`;
        debugTrail.push(`isolatedFail:${message.slice(0, 80)}`);
        dwarn(`[Router] Failed to init isolated session: ${initErrorMsg}`);
        // 回退
        if (activeConfig && activeClient) {
          session = { config: activeConfig, geminiClient: activeClient };
        }
      }
      } finally {
        // 仅当成功落库（isolatedSessions 内有本 chat 的 session）时，把它作为在途结果
        //    交给并发等待者；回退到主环境的 fallback 不入 isolatedSessions，也不作为
        //    在途结果（让等待者各自走自己的 fallback）。无论如何都清掉在途标记。
        resolveInFlight(isolatedSessions.get(msg.chatId) ?? null);
        isolatedSessionInFlight.delete(msg.chatId);
      }
    } else {
      debugTrail.push(`isolatedCached`);
    }

    if (session) {
      currentConfig = session.config;
      currentClient = session.geminiClient;
    }

    if (!currentClient) {
      const detail = initErrorMsg || (debugTrail.length ? `trail=[${debugTrail.join('|')}]` : 'AI client not initialized');
      return `❌ AI 客户端尚未就绪，请稍后重试。${detail ? `\n${detail}` : ''}`;
    }

    // 🎯 延迟启动目标驱动模式：此刻 currentConfig/currentClient（隔离 session）
    //    已就绪，对它们执行 YOLO + setGoalContext。绝不能用主 TUI 的 activeConfig，
    //    否则 App.tsx 的 goal watchdog 会读到共享 client 的 goalContext，在 TUI
    //    大厅里 submitQuery，导致输出泄漏到终端而非飞书卡片。
    if (pendingGoalResult && currentConfig) {
      try {
        const outcome = launchGoalMode(currentConfig, pendingGoalResult);
        const intensityCn =
          pendingGoalResult.intensity === 'steady'
            ? '稳健'
            : pendingGoalResult.intensity === 'intense'
              ? '激进'
              : '标准';
        await gateway.sendMarkdown(
          msg.chatId,
          `🎯 **目标驱动模式已启动**\n` +
            `• 目标：${pendingGoalResult.task}\n` +
            `• 最少持续：${pendingGoalResult.hours} 小时\n` +
            `• 强度：${intensityCn}\n` +
            (outcome.yoloWasEnabled ? `• 已自动开启 YOLO 自动执行\n` : '') +
            `\n我将持续推进直至达成目标。随时可用 \`/goal clear\` 结束。`,
          msg.messageId,
        );
      } catch (e: unknown) {
        return `❌ 启动目标模式失败：${unknownErrorMessage(e)}`;
      }
    }

    // 🎯 /btw side-question — must be intercepted BEFORE any slash-command
    // dispatcher fires. Otherwise the standard CLI `btwCommand` (registered
    // via BuiltinCommandLoader) would handle it first and return only the
    // "Usage: /btw <question>" hint, swallowing the actual question.
    // The handler short-circuits the message: forks a tool-less single-turn
    // agent and replies with the answer as a standalone Feishu message,
    // never entering the chat's message queue.
    if (await handleFeishuBtwCommand(msg, gateway, currentClient, currentConfig, messageText)) {
      return null;
    }

    // 🚀 斜杠命令（/help, /new, /stop, /bind 等）高优先级快速通道拦截：
    // 这些命令完全由系统控制或脚本程序处理，不进入 LLM 上下文，也不存在长耗时。
    // 为了极致的用户体验，它们应该完全绕过异步消息队列，直接高优先级秒速执行响应，绝不参与排队！
    if (messageText.startsWith('/')) {
      dlog(`[Router] High-priority slash command matched: "${safeTruncateForLog(messageText)}"`);
      try {
        // 1. 尝试匹配飞书特定的专用命令
        const cmdResult = await handleFeishuCommand(messageText, currentClient, currentConfig, msg.chatId);
        if (cmdResult !== null) {
          tuiContext?.addItem({ type: 'info', text: cmdResult }, Date.now());

          // 🚀 斜杠命令统一使用 CardKit 2.0 终态卡片规格发送，保证视觉完美统一
          const metrics = await getFeishuStatusMetrics(currentConfig, currentClient, chatLastTokenUsage.get(msg.chatId));
          const card = buildCardKitFinalCard(cmdResult, metrics, 'Otto');
          const cardId = await gateway.createCardKitCard(card);
          if (cardId) {
            await gateway.sendCardKitMessage(msg.chatId, cardId, msg.messageId);
          } else {
            await gateway.sendMessage(msg.chatId, cmdResult, msg.messageId);
          }
          return null; // 🚀 返回 null，防止 gateway.ts 底层二次发送纯文本消息造成重复
        }

        // 2. 如果飞书专有命令未匹配，尝试加载并执行通用的 CLI 斜杠命令
        const cliCmdResult = await handleCliSlashCommandInFeishu(messageText, currentConfig, msg.chatId);
        if (cliCmdResult !== null) {
          if (cliCmdResult.type === 'submit_prompt') {
            // 命令指示重新投喂 prompt 给 LLM agent (例如 /ask 的行为)
            const fakeMsg: FeishuMessage = {
              ...msg,
              text: cliCmdResult.content,
            };
            dlog(`[Router] CLI Slash command redirected to prompt queue: ${cliCmdResult.content}`);

            // 2. 获取或创建 Chat 专属队列并排队
            let queue = messageQueues.get(msg.chatId);
            if (!queue) {
              queue = [];
              messageQueues.set(msg.chatId, queue);
            }
            const isProcessing = isProcessingQueues.get(msg.chatId) || false;

            let queueTipMessageId: string | null = null;
            let receiptMessageId: string | null = null;
            if (isProcessing || queue.length > 0) {
              const queuePosition = queue.length + 1;
              const queueTip = `⏳ *当前项目任务正在执行中，您的新请求已放入项目队列排队（当前排在第 ${queuePosition} 位）...*`;
              queueTipMessageId = await gateway.sendMessage(msg.chatId, queueTip, msg.messageId);
            } else {
              receiptMessageId = await gateway.sendMessage(
                msg.chatId,
                buildFeishuProcessingReceipt('slash_command'),
                msg.messageId,
              );
            }

            return new Promise<string | null>((resolve, reject) => {
              queue!.push({ msg: fakeMsg, resolve, reject, queueTipMessageId, receiptMessageId });
              const richErr = initErrorMsg || (debugTrail.length ? `trail=[${debugTrail.join('|')}]` : '');
              processMessageQueueForChat(gateway, currentConfig, currentClient, creds, msg.chatId, richErr);
            });
          }

          // 常规文本结果输出
          const responseText = cliCmdResult.content || `✅ 命令已成功执行。`;
          tuiContext?.addItem({ type: 'info', text: responseText }, Date.now());

          const metrics = await getFeishuStatusMetrics(currentConfig, currentClient, chatLastTokenUsage.get(msg.chatId));
          const card = buildCardKitFinalCard(responseText, metrics, 'Otto');
          const cardId = await gateway.createCardKitCard(card);
          if (cardId) {
            await gateway.sendCardKitMessage(msg.chatId, cardId, msg.messageId);
          } else {
            await gateway.sendMessage(msg.chatId, responseText, msg.messageId);
          }
          return null; // 🚀 防止 gateway.ts 底层二次发送纯文本消息造成重复
        }

        // 3. 兜底：既不是飞书专用命令，也不是 CLI 的命令，才判为未知斜杠命令
        const hint = `❓ 未知命令: ${messageText.split(/\s+/)[0]}\n\n输入 /help 查看可用命令`;
        tuiContext?.addItem({ type: 'info', text: hint }, Date.now());

        const metrics = await getFeishuStatusMetrics(currentConfig, currentClient, chatLastTokenUsage.get(msg.chatId));
        const card = buildCardKitFinalCard(hint, metrics, 'Otto');
        const cardId = await gateway.createCardKitCard(card);
        if (cardId) {
          await gateway.sendCardKitMessage(msg.chatId, cardId, msg.messageId);
        } else {
          await gateway.sendMessage(msg.chatId, hint, msg.messageId);
        }
        return null; // 🚀 返回 null，防止 gateway.ts 底层二次发送纯文本消息造成重复
      } catch (err: unknown) {
        // 完整错误落服务端日志；发给用户的是清洗后的简短消息。
        derror('Feishu slash-command error:', unknownErrorStackOrMessage(err));
        const errMsg = `❌ 执行命令出错：${sanitizeErrorForUser(err)}`;
        tuiContext?.addItem({ type: 'info', text: errMsg }, Date.now());

        const metrics = await getFeishuStatusMetrics(currentConfig, currentClient, chatLastTokenUsage.get(msg.chatId));
        const card = buildCardKitFinalCard(errMsg, metrics, 'Otto (Error)');
        const cardId = await gateway.createCardKitCard(card);
        if (cardId) {
          await gateway.sendCardKitMessage(msg.chatId, cardId, msg.messageId);
        } else {
          await gateway.sendMessage(msg.chatId, errMsg, msg.messageId);
        }
        return null; // 🚀 返回 null，防止 gateway.ts 底层二次发送纯文本消息造成重复
      }
    }

    // 2. 获取或创建 Chat 专属队列并排队
    let queue = messageQueues.get(msg.chatId);
    if (!queue) {
      queue = [];
      messageQueues.set(msg.chatId, queue);
    }
    const isProcessing = isProcessingQueues.get(msg.chatId) || false;

    let queueTipMessageId: string | null = null;
    let receiptMessageId: string | null = null;
    if (isProcessing || queue.length > 0) {
      const queuePosition = queue.length + 1;
      const queueTip = `⏳ *当前项目任务正在执行中，您的新请求已放入项目队列排队（当前排在第 ${queuePosition} 位）...*`;
      queueTipMessageId = await gateway.sendMessage(msg.chatId, queueTip, msg.messageId);
    } else {
      receiptMessageId = await gateway.sendMessage(
        msg.chatId,
        buildFeishuProcessingReceipt(autoReplyDecision.reason),
        msg.messageId,
      );
    }

    return new Promise<string | null>((resolve, reject) => {
      queue!.push({ msg, resolve, reject, queueTipMessageId, receiptMessageId });
      const richErr = initErrorMsg || (debugTrail.length ? `trail=[${debugTrail.join('|')}]` : '');
      processMessageQueueForChat(gateway, currentConfig, currentClient, creds, msg.chatId, richErr);
    });
  };

  interface MarkdownBlock {
    type: 'text' | 'tool';
    content: string;
  }

  function renderBlocks(blocks: MarkdownBlock[]): string {
    const toolBlocks = blocks.filter(b => b.type === 'tool');
    const totalTools = toolBlocks.length;

    if (totalTools <= 5) {
      return blocks.map(b => b.content).join('\n\n').trim();
    }

    const collapsedCount = totalTools - 5;
    const renderedParts: string[] = [];
    let toolSeenCount = 0;
    let collapsedHeaderAdded = false;

    for (const block of blocks) {
      if (block.type === 'tool') {
        toolSeenCount++;
        if (toolSeenCount <= collapsedCount) {
          if (!collapsedHeaderAdded) {
            renderedParts.push(`*（已折叠 ${collapsedCount} 个历史工具调用）*`);
            collapsedHeaderAdded = true;
          }
          continue;
        }
      }
      renderedParts.push(block.content);
    }

    return renderedParts.join('\n\n').trim();
  }

  function renderCurrentDisplay(
    blocks: MarkdownBlock[],
    activeResponseText: string = '',
    inProgressToolMarkdown: string = '',
  ): string {
    const renderedPast = renderBlocks(blocks);
    let display = renderedPast;

    if (activeResponseText) {
      const separator = display ? (display.endsWith('\n\n') ? '' : (display.endsWith('\n') ? '\n' : '\n\n')) : '';
      display = display + separator + activeResponseText;
    }

    if (inProgressToolMarkdown) {
      const separator = display ? (display.endsWith('\n\n') ? '' : (display.endsWith('\n') ? '\n' : '\n\n')) : '';
      display = display + separator + inProgressToolMarkdown;
    }

    return display;
  }

  async function handleSingleFeishuMessage(
    msg: FeishuMessage,
    gateway: FeishuGateway,
    config: Config,
    geminiClient: OttoClient,
    creds: FeishuCredentials,
    initErrorMsg?: string,
  ): Promise<string | null> {
    const messageText = typeof msg.text === 'string' ? msg.text.trim() : '';

    // 🎯 保存当前会话上下文（供 send_feishu_file 工具使用）
    activeChatId = msg.chatId;
    activeReplyToMessageId = msg.messageId;

    // 注：飞书消息不再回显到主 TUI history —— 已由飞书仪表板的 message log 区域
    // 实时展示（emitFeishuMessageLog(...'in')），避免主屏与仪表板重复刷屏。

    // 🎯 DEBUG: Log the raw messageText to understand image attachment format
    dlog(`[Feishu Debug] Raw messageText from Feishu: "${safeTruncateForLog(messageText)}"`);

    if (!geminiClient || !config) {
      // 🔬 调试细节（状态位 + 原始错误）只落服务端日志，绝不外发给飞书用户
      derror(
        `[Feishu] LLM 未就绪，无法处理消息 [hasConfig=${!!config}, hasClient=${!!geminiClient}, ` +
          `hasGlobalCtx=${!!globalCommandContext}, hasGlobalCfg=${!!globalCommandContext?.services?.config}]` +
          (initErrorMsg ? ` 底层初始化失败原因: ${sanitizeErrorForUser(initErrorMsg, 500)}` : ''),
      );
      // 面向用户：朴素业务话术，不暴露内部状态
      const noLlmReply =
        '⏳ 正在完成初始化，请稍候重试。';
      tuiContext?.addItem({ type: 'info', text: noLlmReply }, Date.now());
      return noLlmReply;
    }

    const toolRegistry: ToolRegistry = await config.getToolRegistry();
    const abortController = new AbortController();
    activeAbortControllers.set(msg.chatId, abortController);
    const promptId = `feishu-${Date.now()}`;

    let activeCardId: string | null = null;
    const blocks: MarkdownBlock[] = [];
    let lastRequestTokenUsage: TokenUsageLike | null = null;
    // CardKit 2.0 流式句柄。为 null 表示流式失败/未启用，会回退到 sendCard 静态卡。
    let streaming: {
      pushContent: (content: string) => Promise<boolean>;
      pushFooter: (metrics: FeishuFooterMetrics) => Promise<boolean>;
      finalize: (finalContent: string, finalFooterMetrics?: FeishuFooterMetrics) => Promise<boolean>;
    } | null = null;

    // 🎯 发送消息日志到仪表板
    emitFeishuMessageLog(msg.chatId, messageText, 'in');

    try {
      incrementProcessingCount(msg.chatId);
      // 确保 chat 已初始化
      await geminiClient.waitForChatInitialized();

      // 🎯 下载飞书消息中的图片/文件到项目的相应目录下
      // 路径以纯文本绝对路径形式拼接到消息中，由工具（如 read_many_files）自动接管读取
      let messageTextForAI = messageText;
      let currentMessage: PartListUnion = messageTextForAI;

      // 1. 处理文件下载 (落盘至 .otto/inbound/)
      if (msg.pendingFiles && msg.pendingFiles.length > 0) {
        const projectRoot = config?.getProjectRoot?.() || process.cwd();
        const fs = await import('node:fs');
        const pathModule = await import('node:path');
        const inboundDir = pathModule.join(projectRoot, '.otto', 'inbound');
        fs.mkdirSync(inboundDir, { recursive: true });

        const filePaths: string[] = [];
        for (const file of msg.pendingFiles) {
          const localPath = await gateway.downloadFileToDir(msg.messageId, file.fileKey, file.fileName, inboundDir);
          if (localPath) {
            filePaths.push(localPath);
            dlog(`[Feishu] File downloaded to inbound: ${localPath}`);
          } else {
            dwarn(`[Feishu] Failed to download file key: ${file.fileKey}`);
            filePaths.push(`[文件下载失败: ${file.fileName}]`);
          }
        }

        // 重建消息文本：把占位符替换为实际绝对路径
        let reconstructedText = msg.text;
        for (let i = 0; i < msg.pendingFiles.length; i++) {
          reconstructedText = reconstructedText.replace(msg.pendingFiles[i].placeholder, filePaths[i]);
        }
        msg.text = reconstructedText;
        messageTextForAI = reconstructedText.trim();
        dlog(`[Feishu] Reconstructed message with file paths: "${safeTruncateForLog(messageTextForAI)}"`);
      }

      // 2. 处理图片下载 (落盘至 .otto/clipboard/)
      if (msg.pendingImages && msg.pendingImages.length > 0) {
        const projectRoot = config?.getProjectRoot?.() || process.cwd();
        const fs = await import('node:fs');
        const pathModule = await import('node:path');
        const clipboardDir = pathModule.join(projectRoot, '.otto', 'clipboard');
        fs.mkdirSync(clipboardDir, { recursive: true });

        const imagePaths: string[] = [];
        for (const img of msg.pendingImages) {
          const localPath = await gateway.downloadImageToDir(msg.messageId, img.imageKey, clipboardDir);
          if (localPath) {
            imagePaths.push(localPath);
            dlog(`[Feishu] Image downloaded to clipboard: ${localPath}`);
          } else {
            dwarn(`[Feishu] Failed to download image key: ${img.imageKey}`);
            imagePaths.push(`[图片下载失败: ${img.imageKey}]`);
          }
        }

        // 重建消息文本：把占位符替换为实际绝对路径
        let reconstructedText = msg.text;
        for (let i = 0; i < msg.pendingImages.length; i++) {
          reconstructedText = reconstructedText.replace(msg.pendingImages[i].placeholder, imagePaths[i]);
        }
        msg.text = reconstructedText;
        messageTextForAI = reconstructedText.trim();
        dlog(`[Feishu] Reconstructed message with image paths: "${safeTruncateForLog(messageTextForAI)}"`);

        // 🎯 完美多模态对齐：既保留文本绝对路径，又在消息中附加实际图片的 base64 作为 inlineData Part
        // 这可以让支持多模态的模型直接读取图片提高效率，同时让非多模态模型依然能利用路径通过工具访问图片，实现自适应！
        const messageParts: Part[] = [{ text: messageTextForAI }];

        for (const localPath of imagePaths) {
          if (localPath && !localPath.startsWith('[图片下载失败') && fs.existsSync(localPath)) {
            try {
              // 🎯 统一走 getSpecificMimeType（基于扩展名的 mime 表），
              // 配合落盘时的真实类型探测，保证 inlineData.mimeType 与图片字节一致。
              // 非图片或无法识别时兜底 image/jpeg，避免传出空 mimeType。
              const detected = getSpecificMimeType(localPath);
              const mimeType = detected && detected.startsWith('image/')
                ? detected
                : 'image/jpeg';
              const base64Data = fs.readFileSync(localPath).toString('base64');
              messageParts.push({
                inlineData: {
                  mimeType,
                  data: base64Data,
                }
              });
              dlog(`[Feishu] Multimodal image part successfully appended for AI from: ${localPath}`);
            } catch (e: unknown) {
              dwarn(`[Feishu] Failed to convert local image to inlineData for AI: ${unknownErrorMessage(e)}`);
            }
          }
        }

        if (messageParts.length > 1) {
          currentMessage = messageParts;
        } else {
          currentMessage = messageTextForAI;
        }
      } else {
        currentMessage = messageTextForAI;
      }
      const originalUserQueryForMemory = messageTextForAI;

      // 🤖 显式派发轨：`@cc` / `@codex` 前缀，或本群默认执行方为 claude-code / codex 时，
      //    将消息改写为强制派发指令，让 agent loop 调用 delegate_to_agent 工具
      //    （并按 delegation.agent 指定 codex 还是 claude-code）。
      //    工具的流式输出会沿用现有 card 通道回传飞书。多模态图片在派发场景下
      //    丢弃（图片/文件的绝对路径已在重建步骤中拼入任务文本，目标 agent 可直接读盘）。
      try {
        const routeForChat = (await loadProjectRoutes())[msg.chatId];
        const routeAgentForChat = routeForChat?.agent;
        const lastSessionId = routeForChat?.lastSessionId;
        const lastSessionAt = routeForChat?.lastSessionAt;
        const delegation = resolveDelegation(messageTextForAI, routeAgentForChat, lastSessionId, lastSessionAt);
        if (delegation.delegate && delegation.task) {
          messageTextForAI = buildDelegateDirective(
            delegation.task,
            delegation.agent,
            'stream',
            delegation.resumeSessionId,
          );
          currentMessage = messageTextForAI;
          dlog(
            `[Feishu] Delegating message to ${delegation.agent} (reason=${delegation.reason}${delegation.resumeSessionId ? `, resume=${delegation.resumeSessionId}` : ''})`,
          );
        }
      } catch (e: unknown) {
        dwarn(`[Feishu] Delegation routing check failed: ${unknownErrorMessage(e)}`);
      }

      try {
        const matches = await getWorkLogger().searchRelevantExperience(
          originalUserQueryForMemory,
          {
            sessionId: config.getSessionId?.(),
            projectRoot: config.getProjectRoot?.(),
            days: WORKLOG_MEMORY_DAYS,
            limit: WORKLOG_MEMORY_LIMIT,
          },
        );
        if (matches.length > 0) {
          const experienceBlock = formatRelevantExperience(matches);
          currentMessage = injectRelevantExperience(currentMessage, experienceBlock);
          const hitNotice = buildFeishuMemoryHitNotice(matches.length);
          if (hitNotice) {
            blocks.push({ type: 'text', content: `*${hitNotice}*` });
          }
          dlog(`[Feishu Memory] Found ${matches.length} related historical experience item(s) for context injection.`);
          tuiContext?.addItem({
            type: 'info',
            text: `Found ${matches.length} related historical experience item(s).`,
          }, Date.now());
        }
      } catch (e: unknown) {
        dwarn(`[Feishu Memory] Failed to search worklog experience: ${unknownErrorMessage(e)}`);
      }

      const MAX_TURNS = 100;

      // Get initial footer metrics
      const initialFooterMetrics = await getFeishuStatusMetrics(config, geminiClient);
      const executedToolNames: string[] = [];

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const stream = geminiClient.sendMessageStream(
          currentMessage,
          abortController.signal,
          promptId,
        );

        let responseText = '';
        let lastUpdateTime = 0;
        const MIN_UPDATE_INTERVAL = 1500; // 节流控制，1.5 秒更新一次
        // 工具执行阶段（开始/结束状态更新）共享节流，防止多工具连续调用触发飞书限流
        let lastToolCardUpdateTime = 0;
        const TOOL_CARD_UPDATE_THROTTLE_MS = 1500;
        const toolCallRequests: ToolCallRequestInfo[] = [];

        for await (const event of stream) {
          switch (event.type) {
            case OttoEventType.Content: {
              responseText += event.value;
              const currentTotalMarkdown = renderCurrentDisplay(blocks, responseText);
              const trimmed = currentTotalMarkdown.trim();
              if (trimmed) {
                const now = Date.now();
                if (!activeCardId) {
                  // 第一次发送：用 CardKit 2.0 创建一张流式卡片
                  const handle = await gateway.sendStreamingCardWithFooter(
                    msg.chatId,
                    trimmed,
                    initialFooterMetrics,
                    msg.messageId,
                  );
                  if (handle.messageId) {
                    activeCardId = handle.messageId;
                    streaming = {
                      pushContent: handle.pushContent,
                      pushFooter: handle.pushFooter,
                      finalize: handle.finalize,
                    };
                  } else {
                    // CardKit 创建失败，回退到老路径：发普通卡片
                    activeCardId = await gateway.sendCard(
                      msg.chatId,
                      'Otto',
                      trimmed,
                      [],
                      initialFooterMetrics,
                      msg.messageId,
                    );
                  }
                  lastUpdateTime = now;
                } else {
                  // 🎯 飞书卡片长度容量防超限保护 & 优雅分割：
                  // 飞书单个卡片数据限制为 30KB 左右（大约相当于 8000-10000 字符）。
                  // 如果当前卡片渲染 of Markdown 超过安全阈值（8500 字符），
                  // 我们在最近一个段落/换行处进行劈裂，将前半部分作为本卡片终态，
                  // 后半部分（多余的）开启一个新卡片继续增量流式更新输出！
                  const MAX_CARD_CHAR_LIMIT = 8500;
                  if (trimmed.length > MAX_CARD_CHAR_LIMIT) {
                    // 在 responseText 中寻找最近的一个段落分割点 (如 \n\n 或 \n)
                    let splitIndex = responseText.lastIndexOf('\n\n');
                    if (splitIndex === -1 || splitIndex < responseText.length - 3000) {
                      splitIndex = responseText.lastIndexOf('\n');
                    }
                    // 兜底：如果实在找不到合适的位置，就从中间偏后位置截断
                    if (splitIndex === -1 || splitIndex < 1000 || splitIndex > responseText.length - 200) {
                      splitIndex = Math.max(1000, responseText.length - 1500);
                    }

                    const left = responseText.slice(0, splitIndex);
                    const right = responseText.slice(splitIndex);

                    const oldCardContent = renderCurrentDisplay(blocks, left);
                    dlog(`[Feishu] Card content size (${trimmed.length} chars) exceeds safety threshold (${MAX_CARD_CHAR_LIMIT}). Splitting card! Left length: ${left.length}, Right length: ${right.length}`);

                    // 1. 本卡片封卷：将其更新为"分段输出中"的终态卡片
                    if (streaming) {
                      const intermediateFooter = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                      intermediateFooter.status = '分段输出中';
                      await streaming.finalize(oldCardContent, intermediateFooter);
                      streaming = null;
                    } else {
                      const intermediateFooter = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                      intermediateFooter.status = '分段输出中';
                      await safeUpdateCardWithRetry(gateway, activeCardId, 'Otto', oldCardContent, intermediateFooter);
                    }

                    // 2. 状态重置：清空历史 blocks，将 responseText 设置为多出的 right，并将 activeCardId 置为 null，
                    // 下一次 event 循环会自动检测到 activeCardId === null 进而创建一个全新的流式卡片！
                    blocks.length = 0;
                    responseText = right;
                    activeCardId = null;
                  } else if (streaming && now - lastUpdateTime >= MIN_UPDATE_INTERVAL) {
                    // CardKit 流式：直接推增量正文，飞书自带打字机动画
                    await streaming.pushContent(trimmed);
                    lastUpdateTime = now;
                  } else if (!streaming && now - lastUpdateTime >= MIN_UPDATE_INTERVAL) {
                    // 老路径回退（CardKit 创建失败时）：im.message.patch 整卡更新
                    const metrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                    metrics.status = '思考中';
                    await gateway.updateCard(activeCardId, 'Otto', trimmed, metrics);
                    lastUpdateTime = now;
                  }
                }
              }
              break;
            }
            case OttoEventType.ToolCallRequest:
              toolCallRequests.push(event.value);
              break;
            case OttoEventType.TokenUsage:
              lastRequestTokenUsage = event.value;
              if (msg && msg.chatId) {
                chatLastTokenUsage.set(msg.chatId, event.value);
              }
              break;
            case OttoEventType.ChatCompressed:
              tuiContext?.addItem({ type: 'info', text: t('feishu.tui.context_compressed') }, Date.now());
              break;
            case OttoEventType.MemoryContext:
              // Memory hits are already injected into the model context; Feishu cards
              // keep the main answer stream uncluttered for now.
              break;
            case OttoEventType.Error:
              throw new Error(event.value?.error?.message || 'unknown error');
            default:
              break;
          }
        }

        // 把当前这轮回复合并进 blocks 中
        if (responseText) {
          blocks.push({ type: 'text', content: responseText });
        }

        const renderedFinalMarkdown = renderCurrentDisplay(blocks);
        const currentFinalMarkdown = toolCallRequests.length === 0
          ? appendFeishuProcessSummary(renderedFinalMarkdown, executedToolNames)
          : renderedFinalMarkdown;

        // 结束流式输出，做最终的、无中间提示的更新
        if (activeCardId && streaming) {
          // CardKit 流式中：只 pushContent 把最终文本推上去，footer 保持流式状态
          await streaming.pushContent(currentFinalMarkdown || '（无回复）');
        } else if (activeCardId && !streaming) {
          // 老路径回退：整卡 patch
          const finalFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          finalFooterMetrics.status = '已完成';
          const success = await safeUpdateCardWithRetry(gateway, activeCardId, 'Otto', currentFinalMarkdown || '（无回复）', finalFooterMetrics);
          if (!success) {
            dwarn('[Feishu Stream] Failed to update final card with retry. Fallback to sending new card.');
            activeCardId = await gateway.sendCard(
              msg.chatId,
              'Otto',
              currentFinalMarkdown || '（无回复）',
              [],
              finalFooterMetrics,
              msg.messageId,
            );
          }
        }

        // 无工具调用 → 最终回复
        if (toolCallRequests.length === 0) {
          const replyText = responseText || '（无回复）';
          // 注：AI 回复不再回显主 TUI，改由飞书仪表板 message log 展示。
          emitFeishuMessageLog(msg.chatId, replyText.slice(0, 120), 'out');

          // 兜底：如果有些特别快的一轮或者流中由于某种原因没有触发 activeCardId 却有最终回复
          if (!activeCardId) {
            const finalFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
            finalFooterMetrics.status = '已完成';
            // 兜底分支文本量不大，直接发个静态卡即可（不必再走 CardKit）
            activeCardId = await gateway.sendCard(
              msg.chatId,
              'Otto',
              currentFinalMarkdown || '（无回复）',
              [],
              finalFooterMetrics,
              msg.messageId,
            );
          } else if (streaming) {
            // 已经走的 CardKit 流式：关闭 streaming_mode 并整卡更新到终态
            const finalFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
            finalFooterMetrics.status = '已完成';
            await streaming.finalize(currentFinalMarkdown || '（无回复）', finalFooterMetrics);
            streaming = null;
          }

          // 检测并发送文件（沙箱化到 projectRoot，扩展名白名单）
          const projectRoot: string =
            (typeof config?.getProjectRoot === 'function' && config.getProjectRoot()) ||
            process.cwd();
          await sendDetectedFiles(
            gateway,
            msg.chatId,
            msg.messageId,
            replyText,
            projectRoot,
          );
          return null; // 自己已发送，不触发 gateway 自动回复
        }

        // 有工具执行
        executedToolNames.push(...toolCallRequests.map(r => r.name || 'unknown'));
        const toolNames = toolCallRequests.map(r => r.name || 'unknown').join(', ');
        // 注：工具调用不再回显主 TUI，改由飞书仪表板 message log 展示。
        emitFeishuMessageLog(msg.chatId, `🔧 ${toolNames}`, 'tool');

        // 发送/更新工具运行进度通知给飞书卡片
        // CardKit 2.0 流式：状态走 footer，正文不再加"运行工具中..."尾巴（loading 动画已表达进度）
        if (activeCardId && streaming) {
          const toolRunningFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          toolRunningFooterMetrics.status = `运行工具中: ${toolNames}`;
          await streaming.pushFooter(toolRunningFooterMetrics);
        } else if (activeCardId && !streaming) {
          // 老路径回退：没有 loading 动画，仍然把提示加在正文里
          const toolRunningText = `\n\n*(🔧 正在运行工具: ${toolNames}...)*`;
          const toolRunningFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          toolRunningFooterMetrics.status = `运行工具中: ${toolNames}`;
          await gateway.updateCard(activeCardId, 'Otto (运行工具中)', renderCurrentDisplay(blocks, '', toolRunningText), toolRunningFooterMetrics);
        } else if (!activeCardId) {
          const toolRunningText = `\n\n*(🔧 正在运行工具: ${toolNames}...)*`;
          activeCardId = await gateway.sendCard(
            msg.chatId,
            'Otto (运行工具中)',
            toolRunningText,
            [],
            await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage),
            msg.messageId,
          );
        }

        // 执行工具调用，收集 functionResponse
        const toolResponseParts: Part[] = [];
        let hasUserAnswered = false;
        for (let i = 0; i < toolCallRequests.length; i++) {
          const req = toolCallRequests[i];
          const isLastTool = i === toolCallRequests.length - 1;
          const toolName = req.name || 'unknown';
          const toolArgsDesc = req.args ? JSON.stringify(req.args).slice(0, 100) : '';
          emitFeishuMessageLog(msg.chatId, `🔧 ${toolName} ${toolArgsDesc}`, 'tool');

          try {
            // 🎯 飞书模式：拦截 ask_user_question，用交互卡片让用户回答
            if (toolName === 'ask_user_question' && req.args) {
              const cardResult = await handleAskUserQuestionViaCard(
                gateway,
                msg.chatId,
                msg.messageId,
                req.args,
                req.callId,
              );
              toolResponseParts.push(cardResult);
              tuiContext?.addItem(
                { type: 'info', text: t('feishu.tui.tool_user_answered') },
                Date.now(),
              );
              hasUserAnswered = true;
              continue;
            }

            let toolResponse;
            if (toolName === 'task') {
              // 🎯 子代理任务：与主 CLI/TUI 对齐，实时展示轮次/工具调用次数/当前工具，
              //    而非阻塞执行后才出结果。通过 updateOutput 回调消费 subagent_update 流。
              const taskTool = toolRegistry.getTool('task');
              if (taskTool) {
                const startTime = Date.now();
                let lastCardUpdateTime = 0;
                let lastKnownStatus = '';
                let lastSubAgentJson = '';
                const SUBAGENT_UPDATE_THROTTLE_MS = 2000;

                const toolResult = await taskTool.execute(
                  req.args,
                  abortController.signal,
                  async (output) => {
                    const now = Date.now();
                    // 检测关键状态变化（starting → running → completed/failed），
                    // 状态切换时跳过节流，确保飞书卡片上的"启动中"→"运行中"及时刷新。
                    let isStatusTransition = false;
                    let isValidUpdate = false;
                    try {
                      const parsed = JSON.parse(output);
                      if (parsed?.type === 'subagent_update' && parsed.data?.status) {
                        isValidUpdate = true;
                        lastSubAgentJson = output;
                        if (parsed.data.status !== lastKnownStatus) {
                          isStatusTransition = true;
                          lastKnownStatus = parsed.data.status;
                        }
                      }
                    } catch { /* ignore */ }

                    // 节流刷新（子代理更新非常频繁），避免触发飞书 API 限流
                    // 但状态切换时跳过节流，确保用户看到"启动中"→"运行中"
                    // 并且只有当获得了有效的 subagent_update 数据时才进行卡片刷新，以避免流式纯文本干扰
                    if (isValidUpdate && activeCardId && (isStatusTransition || now - lastCardUpdateTime >= SUBAGENT_UPDATE_THROTTLE_MS)) {
                      const liveProgressMarkdown = formatToolCallWithBorder('task', req.args, true, lastSubAgentJson, true);
                      const taskFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                      taskFooterMetrics.status = `子代理执行中: ${req.args?.description || ''}`;
                      if (streaming) {
                        await streaming.pushContent(renderCurrentDisplay(blocks, '', liveProgressMarkdown));
                        await streaming.pushFooter(taskFooterMetrics);
                      } else {
                        await gateway.updateCard(activeCardId, 'Otto (子代理执行中)', renderCurrentDisplay(blocks, '', liveProgressMarkdown), taskFooterMetrics);
                      }
                      lastCardUpdateTime = now;
                    }
                  }
                );

                const durationMs = Date.now() - startTime;
                logFeishuToolCall(config, {
                  'event.name': 'tool_call',
                  'event.timestamp': new Date().toISOString(),
                  function_name: 'task',
                  function_args: req.args,
                  duration_ms: durationMs,
                  success: true,
                  prompt_id: req.prompt_id,
                  response_length: typeof toolResult.llmContent === 'string'
                    ? toolResult.llmContent.length
                    : JSON.stringify(toolResult.llmContent).length,
                });

                toolResponse = {
                  callId: req.callId,
                  responseParts: [{
                    functionResponse: {
                      id: req.callId,
                      name: 'task',
                      response: { output: toolResult.llmContent },
                    }
                  }],
                  resultDisplay: toolResult.returnDisplay,
                };
              } else {
                toolResponse = await executeToolCall(config, req, toolRegistry, abortController.signal);
              }
            } else if (toolName === 'run_shell_command') {
              // 精细捕获 run_shell_command 的滚动输出！
              const shellTool = toolRegistry.getTool('run_shell_command');
              if (shellTool) {
                const startTime = Date.now();
                let lastCardUpdateTime = 0;
                const CARD_UPDATE_THROTTLE_MS = 1500;

                const toolResult = await shellTool.execute(
                  req.args,
                  abortController.signal,
                  async (output) => {
                    const now = Date.now();
                    // 节流更新飞书卡片上的控制台滚动输出
                    if (activeCardId && now - lastCardUpdateTime >= CARD_UPDATE_THROTTLE_MS) {
                      const liveProgressMarkdown = formatToolCallWithBorder('run_shell_command', req.args, true, output, true);
                      const shellFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                      shellFooterMetrics.status = '执行命令中';
                      if (streaming) {
                        await streaming.pushContent(renderCurrentDisplay(blocks, '', liveProgressMarkdown));
                        await streaming.pushFooter(shellFooterMetrics);
                      } else {
                        await gateway.updateCard(activeCardId, 'Otto (执行命令中)', renderCurrentDisplay(blocks, '', liveProgressMarkdown), shellFooterMetrics);
                      }
                      lastCardUpdateTime = now;
                    }
                  }
                );

                // 将 toolResult 转换为标准的 ToolCallResponseInfo 格式
                const durationMs = Date.now() - startTime;
                const responseLength = typeof toolResult.llmContent === 'string'
                  ? toolResult.llmContent.length
                  : JSON.stringify(toolResult.llmContent).length;

                // 核心的 telemetry 日志
                logFeishuToolCall(config, {
                  'event.name': 'tool_call',
                  'event.timestamp': new Date().toISOString(),
                  function_name: 'run_shell_command',
                  function_args: req.args,
                  duration_ms: durationMs,
                  success: true,
                  prompt_id: req.prompt_id,
                  response_length: responseLength,
                });

                const response = {
                  functionResponse: {
                    id: req.callId,
                    name: 'run_shell_command',
                    response: { output: toolResult.llmContent },
                  }
                };

                toolResponse = {
                  callId: req.callId,
                  responseParts: [response],
                  resultDisplay: toolResult.returnDisplay,
                };
              } else {
                // 降级使用常规 executeToolCall
                toolResponse = await executeToolCall(config, req, toolRegistry, abortController.signal);
              }
            } else if (toolName === 'lark_cli') {
              const larkCliTool = toolRegistry.getTool('lark_cli');
              if (larkCliTool) {
                const startTime = Date.now();
                let lastCardUpdateTime = 0;
                const CARD_UPDATE_THROTTLE_MS = 1500;

                const toolResult = await larkCliTool.execute(
                  req.args,
                  abortController.signal,
                  async (output) => {
                    const now = Date.now();
                    // 实时滚动更新授权链接与执行状态到飞书卡片上
                    if (activeCardId && (now - lastCardUpdateTime >= CARD_UPDATE_THROTTLE_MS || output.includes('🔑') || output.includes('⚙️'))) {
                      const liveProgressMarkdown = formatToolCallWithBorder('lark_cli', req.args, true, output, true);
                      const larkFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                      larkFooterMetrics.status = output.includes('🔑') ? '等待授权中' : '执行命令中';
                      if (streaming) {
                        await streaming.pushContent(renderCurrentDisplay(blocks, '', liveProgressMarkdown));
                        await streaming.pushFooter(larkFooterMetrics);
                      } else {
                        await gateway.updateCard(activeCardId, 'Otto (执行命令中)', renderCurrentDisplay(blocks, '', liveProgressMarkdown), larkFooterMetrics);
                      }
                      lastCardUpdateTime = now;
                    }
                  }
                );

                const durationMs = Date.now() - startTime;
                const responseLength = typeof toolResult.llmContent === 'string'
                  ? toolResult.llmContent.length
                  : JSON.stringify(toolResult.llmContent).length;

                logFeishuToolCall(config, {
                  'event.name': 'tool_call',
                  'event.timestamp': new Date().toISOString(),
                  function_name: 'lark_cli',
                  function_args: req.args,
                  duration_ms: durationMs,
                  success: true,
                  prompt_id: req.prompt_id,
                  response_length: responseLength,
                });

                const response = {
                  functionResponse: {
                    id: req.callId,
                    name: 'lark_cli',
                    response: { output: toolResult.llmContent },
                  }
                };

                toolResponse = {
                  callId: req.callId,
                  responseParts: [response],
                  resultDisplay: toolResult.returnDisplay,
                };
              } else {
                toolResponse = await executeToolCall(config, req, toolRegistry, abortController.signal);
              }
            } else if (toolName === 'delegate_to_agent') {
              // 🎯 派发给本机 Claude Code / Codex：与 task/shell 对齐，实时把外部
              //    agent 的执行过程（消息 / 工具调用 / 计划 / token）流式推到飞书卡片，
              //    而非只在结束时给结果。通过 updateOutput 消费累计 transcript。
              //    （仅 stream 模式会持续回传；background 模式工具会立即返回 Task ID。）
              const delegateTool = toolRegistry.getTool('delegate_to_agent');
              if (delegateTool) {
                const startTime = Date.now();
                let lastCardUpdateTime = 0;
                // CardKit V2 增量推送轻量，可更低节流；旧版整卡 PATCH 仍需保守节流。
                const CARD_UPDATE_THROTTLE_MS = streaming ? 500 : 1500;

                const delegateArgs = { ...req.args };

                const toolResult = await delegateTool.execute(
                  delegateArgs,
                  abortController.signal,
                  async (output) => {
                    const now = Date.now();
                    // 节流刷新外部 agent 的滚动过程，避免触发飞书 API 限流。
                    if (activeCardId && now - lastCardUpdateTime >= CARD_UPDATE_THROTTLE_MS) {
                      const liveProgressMarkdown = formatToolCallWithBorder('delegate_to_agent', req.args, true, output, true);
                      const delegateFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                      delegateFooterMetrics.status = '外部 Agent 执行中';
                      if (streaming) {
                        await streaming.pushContent(renderCurrentDisplay(blocks, '', liveProgressMarkdown));
                        await streaming.pushFooter(delegateFooterMetrics);
                      } else {
                        await gateway.updateCard(activeCardId, 'Otto (外部 Agent 执行中)', renderCurrentDisplay(blocks, '', liveProgressMarkdown), delegateFooterMetrics);
                      }
                      lastCardUpdateTime = now;
                    }
                  }
                );

                const durationMs = Date.now() - startTime;
                logFeishuToolCall(config, {
                  'event.name': 'tool_call',
                  'event.timestamp': new Date().toISOString(),
                  function_name: 'delegate_to_agent',
                  function_args: req.args,
                  duration_ms: durationMs,
                  success: true,
                  prompt_id: req.prompt_id,
                  response_length: typeof toolResult.llmContent === 'string'
                    ? toolResult.llmContent.length
                    : JSON.stringify(toolResult.llmContent).length,
                });

                // 🎯 将外部 agent 返回的 native sessionId 保存到群路由，
                //    以便下次自动续接（用户自然续聊无需手动 resume）。
                try {
                  const payload = typeof toolResult.llmContent === 'string'
                    ? JSON.parse(toolResult.llmContent) : toolResult.llmContent;
                  if (payload?.sessionId) {
                    await saveProjectRoute(msg.chatId, { lastSessionId: payload.sessionId, lastSessionAt: Date.now() });
                  }
                } catch { /* best-effort */ }

                toolResponse = {
                  callId: req.callId,
                  responseParts: [{
                    functionResponse: {
                      id: req.callId,
                      name: 'delegate_to_agent',
                      response: { output: toolResult.llmContent },
                    }
                  }],
                  resultDisplay: toolResult.returnDisplay,
                };
              } else {
                toolResponse = await executeToolCall(config, req, toolRegistry, abortController.signal);
              }
            } else {
              // 其它非 Shell 工具，直接通过 executeToolCall 执行
              // 在开始执行前，向飞书卡片展示该工具的进行中状态 (⏳)，节流保护
              const nowToolStart = Date.now();
              if (activeCardId && nowToolStart - lastToolCardUpdateTime >= TOOL_CARD_UPDATE_THROTTLE_MS) {
                const liveToolProgress = formatToolCallWithBorder(toolName, req.args, true, '', true);
                if (streaming) {
                  const toolInProgressFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                  toolInProgressFooterMetrics.status = toolName === 'image_reader'
                    ? '正在识别并分析图像内容(请稍候)...'
                    : `执行工具中: ${toolName}`;
                  await streaming.pushContent(renderCurrentDisplay(blocks, '', liveToolProgress));
                  await streaming.pushFooter(toolInProgressFooterMetrics);
                } else {
                  const toolInProgressFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                  toolInProgressFooterMetrics.status = toolName === 'image_reader'
                    ? '正在识别并分析图像内容(请稍候)...'
                    : `执行工具中: ${toolName}`;
                  await gateway.updateCard(activeCardId, `Otto (执行工具中)`, renderCurrentDisplay(blocks, '', liveToolProgress), toolInProgressFooterMetrics);
                }
                lastToolCardUpdateTime = nowToolStart;
              }
              toolResponse = await executeToolCall(config, req, toolRegistry, abortController.signal);
            }

            if (toolResponse.responseParts) {
              const parts = Array.isArray(toolResponse.responseParts) ? toolResponse.responseParts : [toolResponse.responseParts];
              toolResponseParts.push(...(parts as Part[]));
            }

            // 在 blocks 后面追加当前工具的最终精美运行报告
            let finalDisplayOutput: string;
            if (toolName === 'task' && toolResponse.resultDisplay && typeof toolResponse.resultDisplay === 'object') {
              finalDisplayOutput = JSON.stringify(toolResponse.resultDisplay);
            } else if (typeof toolResponse.resultDisplay === 'string') {
              finalDisplayOutput = toolResponse.resultDisplay;
            } else if (toolResponse.resultDisplay && typeof toolResponse.resultDisplay === 'object') {
              // 对象类型的 returnDisplay（如 multiedit 的 { fileDiff, fileName }），
              // 在飞书卡片上做友好摘要，而非 dump 整个 JSON
              const rd = toolResponse.resultDisplay as unknown as Record<string, unknown>;
              if (rd.fileName && rd.fileDiff) {
                // 多文件编辑 / multiedit / patch 等
                const lineCount = String(rd.fileDiff).split('\n').length;
                finalDisplayOutput = `✏️ Edited ${rd.fileName} (${lineCount} diff lines)`;
              } else if (rd.fileName) {
                finalDisplayOutput = `✏️ Edited ${rd.fileName}`;
              } else {
                // 其他对象类型：提取关键信息做摘要
                const keys = Object.keys(rd);
                const summary = keys.slice(0, 3).map(k => `${k}: ${String(rd[k]).slice(0, 60)}`).join(', ');
                finalDisplayOutput = summary || 'done';
              }
            } else {
              finalDisplayOutput = String(toolResponse.resultDisplay ?? 'done');
            }

            const toolReportMarkdown = formatToolCallWithBorder(toolName, req.args, true, finalDisplayOutput, false);

            blocks.push({ type: 'tool', content: toolReportMarkdown });

            // 工具完成后的卡片更新：如果是最后一个工具，或者距离上一次更新超过节流阈值，则执行更新以节省飞书 RPC
            const nowToolEnd = Date.now();
            const shouldUpdateCard = isLastTool || (nowToolEnd - lastToolCardUpdateTime >= TOOL_CARD_UPDATE_THROTTLE_MS);

            if (shouldUpdateCard) {
              if (activeCardId && streaming) {
                const toolDoneFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                toolDoneFooterMetrics.status = toolName === 'image_reader'
                  ? '已完成图像内容读取，正在构思回复...'
                  : `工具已完成: ${toolName}`;
                await streaming.pushContent(renderCurrentDisplay(blocks));
                await streaming.pushFooter(toolDoneFooterMetrics);
                lastToolCardUpdateTime = Date.now();
              } else if (activeCardId && !streaming) {
                const toolDoneFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
                toolDoneFooterMetrics.status = toolName === 'image_reader'
                  ? '已完成图像内容读取，正在构思回复...'
                  : `工具已完成: ${toolName}`;
                await safeUpdateCardWithRetry(gateway, activeCardId, 'Otto', renderCurrentDisplay(blocks), toolDoneFooterMetrics);
                lastToolCardUpdateTime = Date.now();
              }
            }

            emitFeishuMessageLog(msg.chatId, `✅ ${toolName}`, 'tool');
          } catch (toolErr: unknown) {
            // 工具执行失败追加精美样式
            const toolErrorMessage = unknownErrorMessage(toolErr);
            const failedReportMarkdown = formatToolCallWithBorder(toolName, req.args, false, toolErrorMessage || '未知错误', false);
            blocks.push({ type: 'tool', content: failedReportMarkdown });
            if (activeCardId) {
              const failedFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
              failedFooterMetrics.status = '执行失败';
              await gateway.updateCard(activeCardId, 'Otto (执行失败)', renderCurrentDisplay(blocks), failedFooterMetrics);
            }

            emitFeishuMessageLog(msg.chatId, `❌ ${toolName}: ${toolErrorMessage}`, 'tool');
            throw toolErr;
          }
        }

        // 工具执行结束，更新状态。CardKit 2.0 流式有 loading 动画，正文不再加"思考中..."尾巴
        if (activeCardId && streaming) {
          const thinkingFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          thinkingFooterMetrics.status = '思考中';
          await streaming.pushFooter(thinkingFooterMetrics);
        } else if (activeCardId && !streaming) {
          // 老路径回退：没有 loading 动画，把提示加在正文里
          const thinkingFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          thinkingFooterMetrics.status = '思考中';
          await gateway.updateCard(activeCardId, 'Otto (思考中)', renderCurrentDisplay(blocks) + `\n\n*(🤖 Agent is still working... / Agent 正在结合工具结果继续工作...)*`, thinkingFooterMetrics);
        }

        // 🎯 Mid-turn injection：在 tool 结果即将作为下一轮 user message 提交前，
        // 取走本群 messageQueue 里所有等待中的纯文本消息，作为附加 user text part
        // 跟随当前轮的 tool results 一起送给模型。模型在同一 continuation 请求里
        // 就能同时看到 tool 结果 + 用户追加指令，避免要等整轮结束才被处理。
        const injectedTexts = drainChatQueueForMidTurnInjection(
          msg.chatId,
          async (injectedItem) => {
            const preview = (injectedItem.msg.text ?? '').replace(/\s+/g, ' ').slice(0, 60);
            const tail = (injectedItem.msg.text ?? '').length > 60 ? '…' : '';
            const mergedTip = `📥 已合并到当前任务，AI 正在综合处理：「${preview}${tail}」`;
            // 优先更新原排队提示消息，避免发重复消息；更新失败则回退为发送新消息
            if (injectedItem.queueTipMessageId) {
              const updated = await gateway.updateMessage(injectedItem.queueTipMessageId, mergedTip).catch(() => false);
              if (!updated) {
                await gateway.sendMessage(msg.chatId, mergedTip, injectedItem.msg.messageId).catch(() => {/* best effort */});
              }
            } else {
              await gateway.sendMessage(msg.chatId, mergedTip, injectedItem.msg.messageId).catch(() => {/* best effort */});
            }
            // 更新剩余排队消息的位置编号
            await refreshQueuePositions(gateway, msg.chatId);
          },
        );
        if (injectedTexts.length > 0) {
          const header =
            injectedTexts.length === 1
              ? '[Otto - USER MID-TURN MESSAGE] The user sent the following instruction while you were executing tools. Factor it in for the remainder of this turn.'
              : `[Otto - USER MID-TURN MESSAGES] The user sent ${injectedTexts.length} additional instructions while you were executing tools. Factor them in for the remainder of this turn.`;
          const body = injectedTexts
            .map((m, i) => (injectedTexts.length > 1 ? `${i + 1}. ${m}` : m))
            .join('\n');
          toolResponseParts.push({ text: `${header}\n\n${body}` });
          dlog(`[Feishu] Mid-turn injected ${injectedTexts.length} queued message(s) into chat ${msg.chatId}`);
        }

        // 将工具结果（含可能注入的追加指令）作为下一轮输入
        currentMessage = toolResponseParts;

        // 🎯 体验优化：如果用户回答了交互式问题，重置卡片状态，迫使下一轮回复创建全新卡片，避免用户看不到老卡片的更新
        if (hasUserAnswered) {
          if (streaming) {
            const thinkingFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
            thinkingFooterMetrics.status = '等待新输入';
            await streaming.finalize(renderCurrentDisplay(blocks), thinkingFooterMetrics);
            streaming = null;
          }
          activeCardId = null;
          blocks.length = 0;
        }
      }

      // 达到最大轮数
      const limitMarkdown = appendFeishuProcessSummary(
        `${renderCurrentDisplay(blocks)}\n\n*（工具调用次数已达到上限）*`,
        executedToolNames,
      );
      if (activeCardId && streaming) {
        const interruptedFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
        interruptedFooterMetrics.status = '已中断';
        await streaming.finalize(limitMarkdown, interruptedFooterMetrics);
        streaming = null;
      } else if (activeCardId && !streaming) {
        const interruptedFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
        interruptedFooterMetrics.status = '已中断';
        await gateway.updateCard(activeCardId, 'Otto (已中断)', limitMarkdown, interruptedFooterMetrics);
      } else {
        await gateway.sendMessage(msg.chatId, limitMarkdown, msg.messageId);
      }
      return null;
    } catch (err: unknown) {
      if (isAbortLikeError(err)) {
        // 注：不在此处清除 isProcessingQueues，因为 processMessageQueueForChat 的
        // while 循环仍在运行。如果在 catch 中设置 isProcessingQueues=false，会破坏
        // 防重入守卫，允许新消息并发进入同一 chat 的处理循环。
        // isProcessingQueues 的清除统一由 processMessageQueueForChat 的 finally 负责，
        // /stop 命令会提前设置 isProcessingQueues=false 来关闭竞态窗口。
        if (activeCardId && streaming) {
          const abortedFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          abortedFooterMetrics.status = '已中止';
          await streaming.finalize(renderCurrentDisplay(blocks) + '\n\n*🛑 任务已被用户中止。*', abortedFooterMetrics);
          streaming = null;
        } else if (activeCardId && !streaming) {
          const abortedFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
          abortedFooterMetrics.status = '已中止';
          await gateway.updateCard(activeCardId, 'Otto (已中止)', renderCurrentDisplay(blocks) + '\n\n*🛑 任务已被用户中止。*', abortedFooterMetrics);
        }
        return null;
      }
      // 完整错误（含栈/内部路径）只落服务端日志；发给用户的是清洗后的简短消息。
      derror('Feishu Agent processing error:', unknownErrorStackOrMessage(err));
      const userErr = sanitizeErrorForUser(err);
      const errorReply = `❌ 处理消息时出错: ${userErr}`;
      if (activeCardId && streaming) {
        const errorFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
        errorFooterMetrics.status = '出错';
        await streaming.finalize(renderCurrentDisplay(blocks) + `\n\n❌ ${userErr}`, errorFooterMetrics);
        streaming = null;
      } else if (activeCardId && !streaming) {
        const errorFooterMetrics = await getFeishuStatusMetrics(config, geminiClient, lastRequestTokenUsage);
        errorFooterMetrics.status = '出错';
        await gateway.updateCard(activeCardId, 'Otto (出错)', renderCurrentDisplay(blocks) + `\n\n❌ ${userErr}`, errorFooterMetrics);
      }
      // 注：错误信息改由飞书仪表板 message log 展示，不再回显主 TUI。
      emitFeishuMessageLog(msg.chatId, `❌ ${userErr}`, 'tool');
      return errorReply;
    } finally {
      // FIX: 只删除属于本次任务调用的控制器，避免误删新任务的控制器
      // （旧 finally 块异步执行时，新任务可能已注册了同 chatId 的新控制器）
      const currentController = activeAbortControllers.get(msg.chatId);
      if (currentController === abortController) {
        activeAbortControllers.delete(msg.chatId);
      }
      decrementProcessingCount(msg.chatId);

      // 💾 持久化本会话的 AI 客户端历史（对齐 CLI useSessionAutoSave）。飞书无 React
      //    状态，turn 完成后在此统一保存，使下次 /feishu start 能续接。从 isolatedSessions
      //    取该 chat 的权威隔离会话；fire-and-forget，不阻塞返回。
      const persisted = isolatedSessions.get(msg.chatId);
      void saveFeishuSessionHistory(persisted?.config, persisted?.geminiClient);
    }
  }

  async function safeUpdateCardWithRetry(
    gateway: FeishuGateway,
    messageId: string,
    title: string,
    content: string,
    footerMetrics?: FeishuFooterMetrics,
    retries = 3,
    delayMs = 1000
  ): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      const success = await gateway.updateCard(messageId, title, content, footerMetrics);
      if (success) {
        return true;
      }
      dlog(`[Feishu Card Stream] Update failed, retrying ${i + 1}/${retries} in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    return false;
  }

  function getToolShortName(name: string): string {
    return feishuGetToolShortName(name);
  }

  function formatToolCallWithBorder(
    toolName: string,
    args: unknown,
    success: boolean,
    output: string,
    isLive = false
  ): string {
    const shortName = getToolShortName(toolName);
    const statusIcon = success ? '✅️' : '❌';
    const liveStatusIcon = isLive ? '⏳' : statusIcon;

    // 1. 提取参数主信息
    let mainArg = '';
    const argsRecord = isRecord(args) ? args : {};
    const keys = Object.keys(argsRecord);
    const getStringArg = (key: string): string | undefined => {
      const value = argsRecord[key];
      return typeof value === 'string' ? value : undefined;
    };
    const getArrayArg = (key: string): unknown[] | undefined => {
      const value = argsRecord[key];
      return Array.isArray(value) ? value : undefined;
    };

    const commandArg = getStringArg('command');
    const absolutePathArg = getStringArg('absolute_path');
    const filePathArg = getStringArg('file_path') ?? getStringArg('filePath');
    const pathArg = getStringArg('path');
    const patternArg = getStringArg('pattern');

    if (toolName === 'run_shell_command' && commandArg) {
      mainArg = commandArg;
    } else if ((toolName === 'read_file' || toolName === 'write_file') && absolutePathArg) {
      mainArg = absolutePathArg;
    } else if ((toolName === 'replace' || toolName === 'multiedit') && filePathArg) {
      mainArg = filePathArg;
    } else if (toolName === 'patch') {
      mainArg = 'unified diff';
    } else if (toolName === 'batch') {
      const callCount = getArrayArg('tool_calls')?.length ?? 0;
      mainArg = callCount > 0 ? `${callCount} independent operations` : 'operations';
    } else if (toolName === 'ppt_outline') {
      const actionArg = getStringArg('action');
      const topicArg = getStringArg('topic');
      mainArg = actionArg ? `${actionArg}${topicArg ? `: ${topicArg}` : ''}` : '';
    } else if (toolName === 'ppt_generate') {
      mainArg = 'Generate PPT';
    } else if (toolName === 'codesearch' && getStringArg('query')) {
      mainArg = getStringArg('query') ?? '';
    } else if (toolName === 'lsp') {
      const operationArg = getStringArg('operation') ?? 'query';
      const lspFilePathArg = getStringArg('filePath');
      const queryArg = getStringArg('query');
      mainArg = `${operationArg}${lspFilePathArg ? ` on ${lspFilePathArg}` : (queryArg ? `: ${queryArg}` : '')}`;
    } else if (toolName === 'search_file_content' && patternArg) {
      mainArg = `'${patternArg}'`;
      const globArg = getStringArg('glob');
      if (globArg) {
        mainArg += ` in ${globArg}`;
      } else if (pathArg) {
        mainArg += ` in ${pathArg}`;
      }
    } else if (toolName === 'todo_write') {
      const todoCount = getArrayArg('todos')?.length ?? 0;
      mainArg = todoCount > 0 ? `Update ${todoCount} items` : 'Update list';
    } else if (toolName === 'task') {
      // 仅显示简短任务描述，绝不显示完整 prompt（含子代理系统规则，过长且泄露内部细节）
      mainArg = getStringArg('description') ?? '';
    } else if (toolName === 'use_skill' && getStringArg('skillName')) {
      mainArg = getStringArg('skillName') ?? '';
    } else if (toolName === 'lark_cli' && commandArg) {
      const larkArgs = getArrayArg('args') ?? [];
      mainArg = `${commandArg}${larkArgs.length > 0 ? ` ${larkArgs.map(String).join(' ')}` : ''}`;
    } else if (toolName === 'delegate_to_agent') {
      mainArg = getStringArg('agent') === 'codex' ? '›_ Codex' : '✳ Claude Code';
    } else if (pathArg) {
      mainArg = pathArg;
    } else if (patternArg) {
      mainArg = patternArg;
    } else if (keys.length > 0) {
      const firstVal = argsRecord[keys[0]];
      mainArg = typeof firstVal === 'object' && firstVal !== null ? JSON.stringify(firstVal) : String(firstVal);
    }

    // 缩短绝对路径到相对路径（看起来更整洁）
    if (mainArg && mainArg.includes('Otto')) {
      const parts = mainArg.split(/[\\/]Otto[\\/]/);
      if (parts.length > 1) {
        mainArg = parts[1];
      }
    }

    // 2. 提取 description (很多大模型会在工具调用里附带 description)
    const descriptionArg = getStringArg('description');
    const descriptionStr = descriptionArg ? ` (${descriptionArg})` : '';

    // 3. 构建第一行头部
    const headLine = `${liveStatusIcon} **${shortName}** \`${mainArg}\`${descriptionStr}`;

    // 4. 构建树形分支及输出内容
    let branchLine = '';
    let contentBox = '';

    let isSubAgentDisplay = false;
    let subagentData: SubAgentDisplayLike | null = null;
    let isTodoDisplay = false;
    let todoData: TodoDisplayLike | null = null;

    try {
      if (output) {
        const parsed: unknown = JSON.parse(output);
        // 实时态：task 工具通过 updateOutput 推送 { type:'subagent_update', data:{...} }
        // 最终态：task 工具的 returnDisplay 直接是 { type:'subagent_display', ... }
        // 两者都要识别，data 内层即 SubAgentDisplay 对象。
        if (isRecord(parsed) && parsed['type'] === 'subagent_update' && isRecord(parsed['data'])) {
          isSubAgentDisplay = true;
          subagentData = parsed['data'] as SubAgentDisplayLike;
        } else if (isRecord(parsed) && parsed['type'] === 'subagent_display') {
          isSubAgentDisplay = true;
          subagentData = parsed as SubAgentDisplayLike;
        } else if (isRecord(parsed) && parsed['type'] === 'todo_display') {
          isTodoDisplay = true;
          todoData = parsed as TodoDisplayLike;
        }
      }
    } catch {
      // ignore JSON parse error
    }

    if (toolName === 'run_shell_command') {
      const rawOutput = output || '';
      const lines = rawOutput.split('\n');
      const totalLines = lines.length;
      // 取最后 15 行（shell 输出尾部信息更重要，故取尾而非取头）
      const maxLinesToShow = 15;
      let displayedLines = lines;
      if (lines.length > maxLinesToShow) {
        displayedLines = lines.slice(-maxLinesToShow);
      }

      branchLine = `\n └ ( 执行完成，共 ${totalLines} 行输出 )`;

      // 字符数兜底：取尾 15 行后，单行若极长仍可能撑爆卡片，再做字符硬截断。
      // 此处不按行数二次裁剪（已取尾），仅用 clampCodeBlock 的字符上限能力。
      const clampedShell = clampCodeBlock(displayedLines.join('\n'), {
        maxLines: maxLinesToShow,
        maxChars: 2000,
      });
      // 直接使用飞书原生支持的最美观且自适应等宽的代码框组件，确保在任何端上绝不乱行
      contentBox = `\n\`\`\`bash\n${clampedShell.text}\n\`\`\``;
    } else if (toolName === 'read_file') {
      const offsetArg = argsRecord['offset'];
      const limitArg = argsRecord['limit'];
      const startLine = typeof offsetArg === 'number' ? offsetArg + 1 : 1;
      const limit = typeof limitArg === 'number' || typeof limitArg === 'string' ? limitArg : 'all';
      branchLine = `\n └ ( 读取 ${startLine}-${limit === 'all' ? '末行' : startLine + Number(limit) - 1} )`;
    } else if (toolName === 'replace') {
      const oldStr = getStringArg('old_string') ?? '';
      const newStr = getStringArg('new_string') ?? '';
      if (oldStr || newStr) {
        const oldLines = oldStr.split('\n');
        const newLines = newStr.split('\n');

        // Compute line diff using LCS algorithm
        const m = oldLines.length;
        const n = newLines.length;
        const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

        for (let i = 1; i <= m; i++) {
          for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
              dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
              dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
          }
        }

        const diff: string[] = [];
        let i = m;
        let j = n;

        while (i > 0 || j > 0) {
          if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            diff.unshift(`  ${oldLines[i - 1]}`);
            i--;
            j--;
          } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.unshift(`+ ${newLines[j - 1]}`);
            j--;
          } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            diff.unshift(`- ${oldLines[i - 1]}`);
            i--;
          }
        }

        branchLine = `\n └ ( 替换完成 )`;
        // ⚠️ diff 必须裁剪：一个大 replace 的完整 diff 会撑爆整张飞书卡片、
        //    被迫分页。施加行数 + 字符数双重上限。
        const clampedDiff = clampCodeBlock(diff.join('\n'));
        contentBox = `\n\`\`\`diff\n${clampedDiff.text}\n\`\`\``;
      } else {
        branchLine = `\n └ ( 替换完成 )`;
      }
    } else if (toolName === 'write_file') {
      const content = getStringArg('content') ?? '';
      const totalLines = content.split('\n').length;

      const filePath = filePathArg ?? absolutePathArg ?? '';
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const lang = ['js', 'ts', 'jsx', 'tsx', 'py', 'json', 'md', 'html', 'css', 'yaml', 'yml', 'sh', 'bash'].includes(ext) ? ext : 'text';

      // ⚠️ 不能只按行数裁剪：write_file 单行可能极长（压缩 JSON / 长字符串），
      //    15 行也能撑爆卡片。用行数 + 字符数双重上限。
      const clamped = clampCodeBlock(content);
      branchLine = `\n └ ( 写入完成，共 ${totalLines} 行${clamped.truncated ? '，预览已截断' : ''} )`;
      contentBox = `\n\`\`\`${lang}\n${clamped.text}\n\`\`\``;
    } else if (toolName === 'todo_write' || isTodoDisplay) {
      const rawTodos = getArrayArg('todos') ?? todoData?.items;
      if (rawTodos && Array.isArray(rawTodos)) {
        const todos = rawTodos
          .filter(isRecord)
          .map((todo) => todo as TodoItemLike);
        const todoLines = [
          `📝 **${isLive ? '正在规划/更新任务清单' : '任务待办清单已更新'}**`,
          `────────────────────────`,
        ];
        todos.forEach((t) => {
          const statusIcon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '⏳' : '⬜';
          todoLines.push(`${statusIcon} [${t.priority}] ${t.content}`);
        });
        todoLines.push(`────────────────────────`);
        contentBox = `\n${todoLines.join('\n')}`;
      }
      branchLine = `\n └ ( 待办已更新 )`;
    } else if (toolName === 'task' || isSubAgentDisplay) {
      contentBox = isLive ? buildSubAgentDisplayBox(subagentData, argsRecord as TaskToolArgs, isLive) : '';
      branchLine = isLive ? `\n └ ( 子代理执行中... )` : `\n └ ( 子代理任务完成 )`;
    } else if (toolName === 'lark_cli') {
      const hasAuth = output && (output.includes('🔑') || output.includes('🔗'));
      branchLine = isLive
        ? `\n └ ( ${hasAuth ? '等待授权中...' : '正在执行 LARK 命令...'} )`
        : `\n └ ( 执行完成 )`;
      if (output) {
        if (hasAuth) {
          // 直接输出以便飞书客户端能原生解析并高亮点击超链接
          contentBox = `\n${output}`;
        } else {
          const clamped = clampCodeBlock(output, { maxLines: 15, maxChars: 2000 });
          contentBox = `\n\`\`\`bash\n${clamped.text}\n\`\`\``;
        }
      }
    } else if (toolName === 'delegate_to_agent') {
      // 外部 Agent 的 transcript 可能极长（100K+），必须裁剪以防撑爆飞书卡片。
      // 实时态（isLive=true）：取尾部内容（最新进展更重要）+ 字符硬截断。
      // 最终态（isLive=false）：仅显示摘要前100字符。
      if (isLive && output) {
        // 先按行取尾（最新进展在尾部），再做字符截断
        const lines = output.split('\n');
        const tailLines = lines.length > 30 ? lines.slice(-30) : lines;
        const clamped = clampCodeBlock(tailLines.join('\n'), { maxLines: 30, maxChars: 4000 });
        contentBox = `\n\`\`\`\n${clamped.text}\n\`\`\``;
        const totalLines = lines.length;
        const omittedHead = totalLines > 30 ? totalLines - 30 : 0;
        branchLine = (omittedHead > 0 || clamped.truncated)
          ? `\n └ ( 显示最近 ${Math.min(30, totalLines)} 行，${omittedHead > 0 ? `省略前 ${omittedHead} 行` : ''}${clamped.truncated && omittedHead > 0 ? '，' : ''}${clamped.truncated ? '内容过长已截断' : ''} )`
          : `\n └ ( 外部 Agent 执行中... )`;
      } else {
        const summary = output ? (output.length > 100 ? output.slice(0, 100) + '...' : output) : 'success';
        branchLine = `\n └ ( ${summary.replace(/\n/g, ' ')} )`;
      }
    } else {
      const summary = output ? (output.length > 100 ? output.slice(0, 100) + '...' : output) : 'success';
      branchLine = `\n └ ( ${summary.replace(/\n/g, ' ')} )`;
    }

    // 压缩展示(用户要求):普通工具只告诉用户"在用什么工具 + 一行状态",
    // 不再把工具的返回正文(contentBox)糊到飞书里。保留以下例外——它们是
    // "它在做什么"的结构化信息或必须可交互的内容,而非原始数据返回:
    //   · 授权链接(用户必须点开扫码/确认)
    //   · 待办清单(规划/进度)
    //   · 子代理 / 外部 Agent 的实时进度(多 Agent 协作观察)
    const isAuthLink =
      toolName === 'lark_cli' &&
      !!output &&
      (output.includes('🔑') || output.includes('🔗'));
    const keepFullDisplay =
      isAuthLink ||
      isTodoDisplay ||
      isSubAgentDisplay ||
      toolName === 'todo_write' ||
      toolName === 'task' ||
      toolName === 'delegate_to_agent';

    return keepFullDisplay
      ? `${headLine}${branchLine}${contentBox}`
      : `${headLine}${branchLine}`;
  }

  async function processMessageQueueForChat(
    gateway: FeishuGateway,
    config: Config,
    geminiClient: OttoClient,
    creds: FeishuCredentials,
    chatId: string,
    initErrorMsg?: string
  ) {
    if (isProcessingQueues.get(chatId)) return;
    isProcessingQueues.set(chatId, true);

    try {
      const queue = messageQueues.get(chatId);
      while (queue && queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;

        const { msg, resolve, reject } = item;
        // 出队后：更新/清除排队提示消息，并刷新剩余排队位置
        if (item.queueTipMessageId) {
          // 排队提示不再需要，撤回该提示消息以保持对话整洁
          await gateway.recallMessage(item.queueTipMessageId).catch(() => {/* best effort */});
        }
        // 刷新剩余排队消息的位置编号
        await refreshQueuePositions(gateway, chatId);

        try {
          const result = await handleSingleFeishuMessage(msg, gateway, config, geminiClient, creds, initErrorMsg);
          resolve(result);
        } catch (err: unknown) {
          reject(err);
        }
      }
    } finally {
      // 注：isProcessingQueues 的清除在此处完成。/stop 命令会提前设置
      // isProcessingQueues=false 来关闭竞态窗口，此处再次设置 false 是无害的
      // （false → false）。理论上存在旧 finally 清除新处理标志的极窄竞态窗口
      // （/stop 设 false → 新消息 B 设 true → 旧 finally 设 false），但实际概率
      // 极低：旧 finally 在 AbortError 传播后几乎立即执行（微秒级），而新消息 B
      // 需要经过飞书消息接收、入队、processMessageQueueForChat 入口检查等异步步骤
      // 才能设置 true，时间差远大于旧 finally 的执行窗口。
      isProcessingQueues.set(chatId, false);
    }
  }

  gateway.onReady = () => {
    dlog('Feishu Bot ready');
  };

  gateway.onDisconnect = () => {
    dlog('Feishu connection closed');
    resetProcessingCount();
    if (feishuLoopInterval) {
      clearInterval(feishuLoopInterval);
      feishuLoopInterval = null;
    }
  };

  try {
    await gateway.connect();
    activeGateway = gateway;

    // 🔌 注入飞书通道到主动服务、多Agent协作、Skill分享通知
    try {
      const { getProactiveService } = await import('otto-core');
      const { getCollaborationManager, initCollaboration } = await import('otto-core');
      const { getSkillShareManager } = await import('otto-core');

      // 主动服务：注入飞书发送器 + 启动定时器
      const proactive = getProactiveService();
      proactive.setFeishuSender({
        sendCard: async (userId: string, message: string) => {
          if (activeGateway) {
            // 用 open_id 发文本消息（卡片降级为文本，确保送达）
            await activeGateway.sendMessage(userId, message).catch(() => {});
          }
        },
        sendMessage: async (userId: string, message: string) => {
          if (activeGateway) {
            await activeGateway.sendMessage(userId, message).catch(() => {});
          }
        },
      });

      // 🎙️ 会议结束检测：WebSocket 事件（方案A，优先）
      gateway.onMeetingEnded = async (event) => {
        const ctx = {
          userId: (gateway as any).getBotOpenId?.() || 'default',
          userName: 'Otto User',
          currentDay: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()],
          currentTime: `${new Date().getHours()}:${new Date().getMinutes()}`,
          recentActions: [],
          pendingTasks: 0,
          hasUpcomingMeeting: false,
          lastMeetingEnd: event.endTime,
        };
        await proactive.onEvent('meeting_ended', ctx);
        dlog(`[Feishu] Proactive meeting_ended triggered via WebSocket: "${event.topic}"`);
      };

      // 🎙️ 会议结束检测：日历轮询（方案B，fallback）
      try {
        const { spawn } = await import('node:child_process');
        proactive.setCalendarChecker(async () => {
          // 使用 lark-cli 查询最近 10 分钟内结束的会议
          const now = new Date();
          const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
          const startStr = tenMinAgo.toISOString().replace(/\.\d{3}Z$/, '+08:00');
          const endStr = now.toISOString().replace(/\.\d{3}Z$/, '+08:00');

          return new Promise((resolve) => {
            const child = spawn('npx', [
              '--yes', 'lark-cli@1.0.53', 'calendar', '+list',
              '--start', startStr,
              '--end', endStr,
              '--status', 'ended',
            ], {
              timeout: 15000,
              stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdout = '';
            child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
            child.on('close', () => {
              try {
                // 尝试解析 JSON 输出
                const data = JSON.parse(stdout.trim() || '[]');
                const meetings: Array<{
                  meetingId: string; topic: string; endTime: string;
                  hostUserId: string; operatorId: string;
                }> = Array.isArray(data) ? data.filter((m: any) =>
                  m?.status === 'ended' || m?.meeting_id
                ).map((m: any) => ({
                  meetingId: m.meeting_id || m.id || '',
                  topic: m.topic || m.summary || '未知会议',
                  endTime: m.end_time || '',
                  hostUserId: m.host_user_id || '',
                  operatorId: m.operator_id || '',
                })) : [];
                resolve(meetings);
              } catch {
                resolve([]); // 解析失败不报错
              }
            });
            child.on('error', () => resolve([]));
          });
        });
      } catch {
        // lark-cli 不可用不影响主流程
      }

      proactive.startScheduler(() => ({
        userId: (gateway as any).getBotOpenId?.() || 'default',
        userName: 'Otto User',
        currentDay: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()],
        currentTime: `${new Date().getHours()}:${new Date().getMinutes()}`,
        recentActions: [],
        pendingTasks: 0,
        hasUpcomingMeeting: false,
      }));

      // 多Agent协作：注入飞书发送器
      const collab = getCollaborationManager();
      collab.setFeishuSender({
        sendMessageToUser: async (openId: string, text: string) => {
          if (activeGateway) {
            await activeGateway.sendMessage(openId, text).catch(() => {});
          }
        },
        sendMessageToChat: async (chatId: string, text: string) => {
          if (activeGateway) {
            await activeGateway.sendMessage(chatId, text).catch(() => {});
          }
        },
      });

      // Skill分享通知：注入飞书发送器
      const skillShare = getSkillShareManager(config!);
      skillShare.setNotificationSender({
        sendToTeamMembers: async (teamId: string, notification: any) => {
          if (activeGateway) {
            // 通知发到群（teamId 作为 chatId）
            await activeGateway.sendMessage(teamId, notification.message).catch(() => {});
          }
        },
      });

      console.log('[Feishu] 主动服务/多Agent协作/Skill通知 已注入飞书通道');

      // 🔔 多渠道通知服务：飞书 + 短信兜底
      try {
        const { getNotificationService } = await import('otto-core');
        const { AliyunSmsSender, createAliyunSmsFromEnv } = await import('otto-core');

        const notif = getNotificationService();

        // 注册飞书通知通道
        notif.registerSender({
          channel: 'feishu',
          send: async (recipientId: string, title: string, body: string) => {
            if (!activeGateway) return false;
            try {
              await activeGateway.sendMessage(
                recipientId,
                `${title}\n\n${body}`
              );
              return true;
            } catch {
              return false;
            }
          },
        });

        // 注册短信通知通道（阿里云）
        const smsSender = createAliyunSmsFromEnv();
        if (smsSender) {
          notif.registerSender(smsSender);
          console.log('[NotificationService] 短信通道已就绪');
        } else {
          console.log('[NotificationService] 短信通道未配置，仅使用飞书通知');
        }

        // 从环境变量加载服务人员手机号映射
        // 格式: OTTO_STAFF_PHONES=openId1:13800138000,openId2:13900139000
        const phonesEnv = process.env.OTTO_STAFF_PHONES || '';
        if (phonesEnv) {
          for (const pair of phonesEnv.split(',')) {
            const [openId, phone] = pair.split(':');
            if (openId && phone) {
              notif.setPhoneMapping(openId.trim(), phone.trim());
            }
          }
          console.log(`[NotificationService] 已加载 ${notif['phoneMap'].size} 个手机号映射`);
        }

        console.log('[NotificationService] 多渠道通知服务已启动');
      } catch (err) {
        console.warn(`[Feishu] 通知服务初始化失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      console.warn(`[Feishu] 注入编排通道失败（不影响核心功能）: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 🎯 启动飞书看门狗 /loop 周期性任务调度器
    if (feishuLoopInterval) {
      clearInterval(feishuLoopInterval);
    }
    feishuLoopInterval = setInterval(async () => {
      try {
        if (!activeGateway) return;

        // 会话回收:驱逐长时间无活动且无活跃 loop 的隔离会话,防 24/7 常驻内存泄漏/OOM。
        // (mid-processing 的会话即便从 Map 删除,处理中的闭包仍持其引用,GC 安全。)
        {
          const IDLE_EVICT_MS = 60 * 60 * 1000; // 60 分钟无活动
          const MAX_SESSIONS = 200;
          const nowTick = Date.now();
          for (const [cid, s] of isolatedSessions.entries()) {
            const hasLoop = !!s.geminiClient?.getLoopContext?.();
            if (!hasLoop && nowTick - (s.lastActivityAt ?? 0) > IDLE_EVICT_MS) {
              isolatedSessions.delete(cid);
            }
          }
          if (isolatedSessions.size > MAX_SESSIONS) {
            const evictable = [...isolatedSessions.entries()]
              .filter(([, s]) => !s.geminiClient?.getLoopContext?.())
              .sort((a, b) => (a[1].lastActivityAt ?? 0) - (b[1].lastActivityAt ?? 0));
            for (const [cid] of evictable) {
              if (isolatedSessions.size <= MAX_SESSIONS) break;
              isolatedSessions.delete(cid);
            }
          }
        }

        for (const [chatId, session] of isolatedSessions.entries()) {
          const client = session.geminiClient;
          if (!client) continue;

          const loopCtx = client.getLoopContext();
          if (!loopCtx) continue;

          const now = Date.now();

          // 1. 检查是否过期
          if (now > loopCtx.expiresAt) {
            client.clearLoopContext();
            await activeGateway.sendMessage(
              chatId,
              `🔄 *[Loop Watchdog]* Active loop has reached its expiration limit (3 days) and has stopped.`
            ).catch(() => {/* best effort */});
            continue;
          }

          const timeForNextRun = now - loopCtx.lastRunAt >= loopCtx.intervalMs;

          // 2. 如果到时间了，或者存在挂起的任务
          if (timeForNextRun || loopCtx.isPendingRun) {
            const isProcessing = isProcessingQueues.get(chatId) || false;

            if (!isProcessing) {
              // 标志位更新：置为已执行
              loopCtx.lastRunAt = now;
              loopCtx.isPendingRun = false;

              await activeGateway.sendMessage(
                chatId,
                `🔄 *[Loop Run]* Executing scheduled watchdog prompt: "${loopCtx.prompt}"`
              ).catch(() => {/* best effort */});

              // 构造一个模拟的飞书消息来触发队列处理
              const fakeMsg: FeishuMessage = {
                messageId: `loop_${now}`,
                chatId,
                chatType: 'group',
                senderOpenId: creds.ownerOpenId || '', // 模拟拥有者执行
                text: loopCtx.prompt,
                mentions: [],
                messageType: 'text',
              };

              let queue = messageQueues.get(chatId);
              if (!queue) {
                queue = [];
                messageQueues.set(chatId, queue);
              }

              // 模拟将消息加入队列中并触发执行
              const resolve = () => {};
              const reject = () => {};
              queue.push({ msg: fakeMsg, resolve, reject, queueTipMessageId: null });
              processMessageQueueForChat(activeGateway, session.config, client, creds, chatId);
            } else {
              // 正在处理中，将标志位置为挂起，等空闲下来立即补执行
              loopCtx.isPendingRun = true;
            }
          }
        }
      } catch (err) {
        // Prevent background loop error from crashing Feishu Gateway
        void err;
      }
    }, 5000); // 5s 周期，兼顾资源占用与响应速度

    // 📡 携带 botName / platform，供 TUI 仪表板显示（否则 Bot 名显示为 unknown）
    appEvents.emit(AppEvent.FeishuBotStarted, {
      botName: creds.botName,
      platform: creds.domain,
    });
    // 📡 发射初始路由表（已绑定的项目列表）
    emitFeishuProjectRoutesUpdated();

    // 🎯 动态注册 send_feishu_file 工具，让 Agent 可以直接发送文件到飞书
    if (config && geminiClient) {
      try {
        const toolRegistry: ToolRegistry = await config.getToolRegistry();
        const projectRoot: string =
          (typeof config.getProjectRoot === 'function' && config.getProjectRoot()) ||
          process.cwd();
        toolRegistry.registerTool(new SendFeishuFileTool(
          gateway,
          () => activeChatId ?? undefined,
          () => activeReplyToMessageId ?? undefined,
          () => projectRoot,
        ));

        // 🎯 动态注册自动建群及多项目隔离管理工具：create_project_and_group_chat
        toolRegistry.registerTool(new CreateProjectGroupTool({
          gateway,
          getSenderOpenId: () => activeSenderOpenId ?? undefined,
          getActiveChatId: () => activeChatId,
          onProjectCreated: async (chatId, path, agent) => {
            const update: Partial<FeishuProjectRoute> = { projectRoot: path };
            if (agent) update.agent = agent;
            await saveProjectRoute(chatId, update);
            emitFeishuProjectRoutesUpdated();
          },
        }));

        // 🎯 动态注册专属的音频朗读/转录工具（正常模式下不加载，避免污染和误导模型）
        toolRegistry.registerTool(new AudioReaderTool(config));

        // 🎯 动态注册视频分析工具：丢一个网址 → 下载 → 场景检测截帧 → 字幕 → LLM分析 → 知识库
        toolRegistry.registerTool(new VideoAnalyzerTool(config));

        // 🎯 动态注册自更新重启工具（仅飞书模式可见）：模型一调用即升级 otto-ai
        //    到 latest 并以 `otto --feishu` 自动重启。普通 CLI 模式绝不注册。
        const selfUpdateTool = new SelfUpdateTool(config);
        // 注入优雅退出回调：AI 调用 self_update 时，先中止生成、断开 WS、清理队列，再退出。
        SelfUpdateTool.onBeforeRestart = async () => {
          for (const controller of activeAbortControllers.values()) {
            try { controller.abort(); } catch { /* ignore */ }
          }
          activeAbortControllers.clear();
          clearMessageQueue();
          if (activeGateway) {
            try { await activeGateway.disconnect(); } catch { /* ignore */ }
            activeGateway = null;
          }
          // 非 Windows 提示：飞书模式下新进程在后台静默启动，用户看不到界面
          if (process.platform !== 'win32') {
            console.log(
              '\n💡 Otto 飞书网关已在新进程中后台启动（无界面），' +
              '可通过 `ps aux | grep otto` 查看进程状态。\n'
            );
          }
        };
        toolRegistry.registerTool(selfUpdateTool);

        await geminiClient.setTools();
        dlog('Registered Feishu file-send tool and group-chat tool successfully.');
      } catch (toolErr: unknown) {
        dwarn('Failed to register Feishu tool (continuing):', unknownErrorMessage(toolErr));
      }
    }

    const platform = creds.domain === 'lark'
      ? t('feishu.start.platform.lark')
      : t('feishu.start.platform.feishu');

    // 🎯 以飞书应用身份给 Bot 拥有者发送欢迎私聊消息，告知已上线及当前工作目录
    if (creds.ownerOpenId) {
      const ownerOpenId = creds.ownerOpenId;
      void (async () => {
        try {
          const projectRoot = (typeof config?.getProjectRoot === 'function' && config.getProjectRoot()) || process.cwd();
          const welcomeLines: string[] = [
            `👋 你好！我已成功上线，随时为你服务！`,
            ``,
            `📂 当前私聊工作目录："${projectRoot}"`,
            ``,
            `💡 如需使用其他工作目录，请发送：[拉个群 + 文件夹路径]`,
            `   例如：「拉个群 D:\\projects\\my-app」`,
          ];

          // 🤖 本机 agent 检测：发现 claude / codex 时，追加专属群提示
          try {
            const availability = await detectLocalAgents();
            const agentHints = buildLocalAgentWelcomeHints(availability);
            if (agentHints.length > 0) {
              welcomeLines.push('', ...agentHints);
            }
          } catch (detectErr: unknown) {
            dwarn(`[Feishu] detectLocalAgents failed (non-fatal): ${unknownErrorMessage(detectErr)}`);
          }

          welcomeLines.push('', `❓ 需要帮助请发送 /help`);

          // 🔍 检查飞书应用权限状态，将缺失权限的快捷申请链接追加到欢迎消息
          try {
            const probe = await probeCredentials(creds.appId, creds.appSecret, creds.domain);
            if (probe?.grantedScopes) {
              const requiredAll = [...REQUIRED_APP_SCOPES];
              const missing = missingScopes(probe.grantedScopes, requiredAll);
              const hasGroupMsgScope = probe.grantedScopes.includes(SENSITIVE_GROUP_MSG_SCOPE);

              const missingBiz = missingScopes(probe.grantedScopes, [...REQUIRED_BUSINESS_SCOPES]);
              // 核心权限只看必需 scope 是否齐全；「免@响应」是可选敏感权限，缺失属正常，
              // 单独作为 ℹ️ 提示，不应让正确配置的机器人看到刺眼的 ⚠️ 告警。
              if (missing.length === 0) {
                welcomeLines.push('', `✅ 核心权限（消息/群聊）已就绪。`);
              } else {
                welcomeLines.push('', `⚠️ 以下应用权限尚未开通，部分功能可能受限：`);

                const scopeApplyUrl = buildScopeApplyUrl({
                  appId: creds.appId,
                  scopes: missing,
                  brand: creds.domain,
                  tokenType: 'tenant',
                });
                welcomeLines.push(`  📋 缺失 ${missing.length} 项基础权限，一键申请：`);
                welcomeLines.push(`     👉 ${scopeApplyUrl}`);

                welcomeLines.push(`  📡 事件订阅页（勾选 im.message.receive_v1 等）：`);
                welcomeLines.push(`     👉 ${buildEventSubUrl({ appId: creds.appId, brand: creds.domain })}`);
                welcomeLines.push(`  🔄 权限生效需发布版本：`);
                welcomeLines.push(`     👉 ${buildPermissionPageUrl({ appId: creds.appId, brand: creds.domain })}`);
              }

              // 「免@响应」可选敏感权限：未开通时给出可选 ℹ️ 提示（缺失对绝大多数机器人是正常的）。
              if (!hasGroupMsgScope) {
                const sensitiveUrl = buildScopeApplyUrl({
                  appId: creds.appId,
                  scopes: [SENSITIVE_GROUP_MSG_SCOPE],
                  brand: creds.domain,
                  tokenType: 'tenant',
                });
                welcomeLines.push('', `ℹ️ 可选「免@响应」敏感权限未开通（群内需@机器人才会触发，需单独人工审核）：`);
                welcomeLines.push(`     👉 ${sensitiveUrl}`);
              }

              // 业务域权限：诚实告知高级能力尚未授权，避免"全部就绪"的假绿灯。
              if (missingBiz.length > 0) {
                const bizUrl = buildScopeApplyUrl({
                  appId: creds.appId,
                  scopes: missingBiz,
                  brand: creds.domain,
                  tokenType: 'tenant',
                });
                welcomeLines.push('', `ℹ️ 业务域能力（日历/文档/表格/云盘/任务/知识库/妙记/OKR/演示稿/邮件）尚未授权（${missingBiz.length} 项），用到时再申请：`);
                welcomeLines.push(`     👉 ${bizUrl}`);
              }
            }
          } catch (scopeErr: unknown) {
            dwarn(`[Feishu] Failed to check scopes for welcome message: ${unknownErrorMessage(scopeErr)}`);
          }

          const msgId = await gateway.sendPrivateMessage(ownerOpenId, welcomeLines.join('\n'));
          if (msgId) {
            dlog('[Feishu] Welcome private message sent to owner.');
          } else {
            dwarn('[Feishu] Welcome private message could not be delivered — the bot may lack the im:message:send_as_bot permission.');
          }
        } catch (err: unknown) {
          dwarn(`[Feishu] Failed to send welcome private message: ${unknownErrorMessage(err)}`);
        }
      })();
    }

    return [
      t('feishu.dashboard.welcome_title'),
      tp('feishu.start.success_bot', { name: creds.botName || t('feishu.start.bot_unknown') }),
      tp('feishu.start.success_platform', { platform }),
      '',
      t('feishu.start.success_hint_chat'),
      t('feishu.start.success_hint_stop'),
    ].join('\n');
  } catch (err: unknown) {
    return tp('feishu.start.failed', { error: unknownErrorMessage(err) });
  } finally {
    // 无论连接成功或失败，都释放互斥守卫，允许后续 start（失败重试 / stop 后重启）。
    startInFlight = false;
  }
}

/**
 * 停止网关
 */
async function handleStop(context?: CommandContext): Promise<string> {
  if (!activeGateway) {
    return t('feishu.stop.not_running');
  }

  // 🎯 动态注销 send_feishu_file 及 create_project_and_group_chat 工具
  const config = context?.services?.config;
  const geminiClient = config?.getOttoClient?.();
  if (config && geminiClient) {
    try {
      const toolRegistry: ToolRegistry = await config.getToolRegistry();
      const removed = toolRegistry.unregisterTool(SendFeishuFileTool.Name);
      const removedGroupTool = toolRegistry.unregisterTool(CreateProjectGroupTool.Name);
      const removedAudioTool = toolRegistry.unregisterTool(AudioReaderTool.Name);
      const removedSelfUpdate = toolRegistry.unregisterTool(SelfUpdateTool.Name);
      if (removed || removedGroupTool || removedAudioTool || removedSelfUpdate) {
        await geminiClient.setTools();
        dlog('Unregistered Feishu file-send and group-chat tools successfully.');
      }
    } catch (toolErr: unknown) {
      dwarn('Failed to unregister Feishu tool:', unknownErrorMessage(toolErr));
    }
  }

  clearMessageQueue();

  // 中止并清空所有在飞的 /btw 旁路问答 controller，避免停机后残留泄漏。
  for (const controller of sideQuestionControllers.values()) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }
  sideQuestionControllers.clear();

  resetProcessingCount();

  // 显式清除 5s 看门狗定时器，防止每次 stop 泄漏一个常驻 interval。
  // （onDisconnect 也会清，但那是异步/间接的；这里同步兜底确保必清。）
  if (feishuLoopInterval) {
    clearInterval(feishuLoopInterval);
    feishuLoopInterval = null;
  }

  await activeGateway.disconnect();
  activeGateway = null;
  appEvents.emit(AppEvent.FeishuBotStopped);
  tuiContext = null; // 清除 TUI 上下文
  globalCommandContext = null;
  activeChatId = null;
  activeReplyToMessageId = null;
  // 重置最近一笔 token 用量缓存，避免 stop/start 后旧群的用量串味到 /status。
  chatLastTokenUsage.clear();
  return t('feishu.stop.stopped');
}

/**
 * 查看状态
 */
async function handleStatus(): Promise<string> {
  const result = await loadCredsSafe();
  if (!result.ok) {
    return tp('feishu.start.creds_load_failed', { error: result.error });
  }
  const creds = result.creds;
  const lines: string[] = [t('feishu.status.title')];

  if (creds) {
    lines.push(t('feishu.status.creds_configured'));
    lines.push(`  App ID:      ${creds.appId}`);
    lines.push(tp('feishu.status.bot_name', { name: creds.botName || t('feishu.start.bot_unknown') }));
    const platform = creds.domain === 'lark'
      ? t('feishu.start.platform.lark')
      : t('feishu.start.platform.feishu');
    lines.push(tp('feishu.status.platform', { platform }));
    lines.push(tp('feishu.status.owner', {
      owner: creds.ownerOpenId || t('feishu.status.owner_unbound'),
    }));
    if (creds.allowlist && creds.allowlist.length > 0) {
      lines.push(tp('feishu.status.allowlist_count', { count: creds.allowlist.length }));
    }
  } else {
    lines.push(t('feishu.status.creds_missing'));
    lines.push('');
    lines.push(t('feishu.status.run_setup'));
    return lines.join('\n');
  }

  const status = activeGateway
    ? t('feishu.status.bot_status_running')
    : t('feishu.status.bot_status_stopped');
  lines.push(tp('feishu.status.bot_status_label', { status }));

  // 🔗 绑定项目列表：展示「群名(或 chatId) → 本地工作区路径」的转写绑定关系。
  // 群名解析尽力而为：Bot 运行中（有 activeGateway）时调用 getChatName 批量解析，
  // 无权限 / 未运行时自动 fallback 到展示 chatId。
  try {
    const routes = await loadProjectRoutes();
    const chatIds = Object.keys(routes);
    const chatNames: Record<string, string> = {};
    const p2pChatIds: string[] = [];

    if (activeGateway && chatIds.length > 0) {
      // 并发解析所有群名 + 会话类型，单个失败不影响整体；整体加 5s 超时上限，避免 /feishu status 卡住。
      // getChatName 与 getChatMode 共用同一次 chats/{id} 请求结果（进程内缓存），无额外开销。
      const resolveAll = Promise.allSettled(
        chatIds.map(async (chatId) => {
          const [name, mode] = await Promise.all([
            activeGateway!.getChatName(chatId),
            activeGateway!.getChatMode(chatId),
          ]);
          if (name) chatNames[chatId] = name;
          if (mode === 'p2p') p2pChatIds.push(chatId);
        }),
      );
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
      await Promise.race([resolveAll.then(() => undefined), timeout]);
    }

    lines.push('');
    lines.push(
      ...buildBoundProjectsLines(routes, {
        // 活跃 = 当前正在干活（Agent 仍在处理）的群集合，可同时多个。
        activeChatIds: processingChatIds,
        chatNames,
        p2pChatIds,
        botName: creds.botName,
      }),
    );
  } catch (e) {
    dwarn(`[Feishu] Failed to render bound projects in status: ${(e as Error).message}`);
  }

  // ✨ Mini-doctor：检测 scope 健康度，给出修复建议
  try {
    const probe = await probeCredentials(creds.appId, creds.appSecret, creds.domain);
    if (probe?.grantedScopes) {
      const missing = missingScopes(probe.grantedScopes, [...REQUIRED_APP_SCOPES]);
      lines.push('');
      if (missing.length === 0) {
        lines.push('  ✅ 核心权限（消息/群聊/通讯录）：已开通');
      } else {
        const applyUrl = buildScopeApplyUrl({
          appId: creds.appId,
          scopes: missing,
          brand: creds.domain,
          tokenType: 'tenant',
        });
        lines.push(`  ⚠️ 核心权限：缺失 ${missing.length} 项必需 scope`);
        lines.push(`     一键申请：${applyUrl}`);
        if (missing.length <= 8) {
          for (const s of missing) lines.push(`       - ${s}`);
        }
      }

      // 业务域权限（日历/文档/表格/云盘/任务/知识库/妙记/OKR/演示稿/邮件）——这些是宣传的
      // 高级能力，缺了首次使用会被打断去逐域授权。诚实分项列出，不再用核心 scope 冒充"全部就绪"。
      const missingBiz = missingScopes(probe.grantedScopes, [...REQUIRED_BUSINESS_SCOPES]);
      if (missingBiz.length === 0) {
        lines.push('  ✅ 业务域权限：日历/文档/表格/云盘/任务等已全部授权');
      } else {
        const bizUrl = buildScopeApplyUrl({
          appId: creds.appId,
          scopes: missingBiz,
          brand: creds.domain,
          tokenType: 'tenant',
        });
        lines.push(`  ℹ️ 业务域权限：${missingBiz.length} 项高级能力（日历/文档/表格/云盘/任务/知识库/妙记/OKR/演示稿/邮件）尚未授权，用到时需先申请`);
        lines.push(`     一键申请：${bizUrl}`);
      }

      // 检测「群免 @」敏感权限是否已开
      const hasGroupMsgScope = probe.grantedScopes.includes(SENSITIVE_GROUP_MSG_SCOPE);
      lines.push('');
      if (hasGroupMsgScope) {
        lines.push('  ✅ 群消息免 @：已开通（群里所有消息都会推送给 bot）');
      } else {
        const sensitiveUrl = buildScopeApplyUrl({
          appId: creds.appId,
          scopes: [SENSITIVE_GROUP_MSG_SCOPE],
          brand: creds.domain,
          tokenType: 'tenant',
        });
        lines.push('  ℹ️ 群消息免 @：未开通（群里仅 @bot 才响应）');
        lines.push(`     如需"无需 @ 直接响应"功能，申请敏感权限：${sensitiveUrl}`);
      }
    } else {
      // 应用还没开通 application:application:self_manage，无法 probe scope
      lines.push('');
      lines.push('  ℹ️ 无法读取应用 scope 列表（应用尚未开通 `application:application:self_manage`）');
      lines.push(`     一键申请所有必需 scope：${buildScopeApplyUrl({
        appId: creds.appId,
        scopes: [...REQUIRED_APP_SCOPES],
        brand: creds.domain,
        tokenType: 'tenant',
      })}`);
    }
  } catch {
    /* probe 失败不阻塞 status 输出 */
  }

  if (!activeGateway) {
    lines.push('');
    lines.push(t('feishu.status.run_start'));
  }

  return lines.join('\n');
}

/**
 * 添加 open_id 到授权白名单（B1 — 授权管理）
 *
 * 用法：/feishu allow <openId>
 */
async function handleAllow(args: string): Promise<string> {
  const openId = args.trim();
  if (!openId) {
    return [
      t('feishu.allow.usage_title'),
      '',
      t('feishu.allow.usage_body'),
      t('feishu.allow.usage_where'),
    ].join('\n');
  }
  let creds: FeishuCredentials | null;
  try {
    creds = await loadCredentials();
  } catch (e) {
    return tp('feishu.allow.creds_load_failed', { error: (e as Error).message });
  }
  if (!creds) {
    return t('feishu.allow.creds_missing');
  }
  // owner 已是该 openId 时无需再加
  if (creds.ownerOpenId === openId) {
    return tp('feishu.allow.already_owner', { openId });
  }
  // 如果 owner 未绑定，把这个 openId 设为 owner
  if (!creds.ownerOpenId) {
    creds.ownerOpenId = openId;
    await saveCredentials(creds);
    return tp('feishu.allow.set_as_owner', { openId });
  }
  const list = new Set(creds.allowlist ?? []);
  if (list.has(openId)) {
    return tp('feishu.allow.already_in_list', { openId });
  }
  list.add(openId);
  creds.allowlist = [...list];
  await saveCredentials(creds);
  return tp('feishu.allow.added', { openId, count: creds.allowlist.length });
}

/**
 * 从授权白名单移除 open_id（B1 — 授权管理）
 *
 * 用法：/feishu deny <openId>
 */
async function handleDeny(args: string): Promise<string> {
  const openId = args.trim();
  if (!openId) {
    return t('feishu.deny.usage');
  }
  let creds: FeishuCredentials | null;
  try {
    creds = await loadCredentials();
  } catch (e) {
    return tp('feishu.allow.creds_load_failed', { error: (e as Error).message });
  }
  if (!creds) {
    return t('feishu.allow.creds_missing');
  }
  if (creds.ownerOpenId === openId) {
    return tp('feishu.deny.cannot_remove_owner', { openId });
  }
  const before = creds.allowlist?.length ?? 0;
  creds.allowlist = (creds.allowlist ?? []).filter((id) => id !== openId);
  if (creds.allowlist.length === before) {
    return tp('feishu.deny.not_in_list', { openId });
  }
  await saveCredentials(creds);
  return tp('feishu.deny.removed', { openId, count: creds.allowlist.length });
}

/**
 * 列出授权白名单（B1 — 授权管理）
 */
async function handleAllowlist(): Promise<string> {
  let creds: FeishuCredentials | null;
  try {
    creds = await loadCredentials();
  } catch (e) {
    return tp('feishu.allow.creds_load_failed', { error: (e as Error).message });
  }
  if (!creds) {
    return t('feishu.allow.creds_missing');
  }
  const lines = [t('feishu.allowlist.title')];
  lines.push(tp('feishu.allowlist.owner', {
    owner: creds.ownerOpenId || t('feishu.allowlist.owner_unbound'),
  }));
  if (creds.allowlist && creds.allowlist.length > 0) {
    lines.push(t('feishu.allowlist.list_header'));
    for (const id of creds.allowlist) {
      lines.push(`    - ${id}`);
    }
  } else {
    lines.push(t('feishu.allowlist.list_empty'));
  }
  lines.push('');
  lines.push(t('feishu.allowlist.manage_hint'));
  return lines.join('\n');
}

/**
 * 清除凭证
 */
async function handleLogout(context?: CommandContext): Promise<string> {
  if (activeGateway) {
    // 🎯 注销飞书工具
    const config = context?.services?.config;
    const geminiClient = config?.getOttoClient?.();
    if (config && geminiClient) {
      try {
        const toolRegistry: ToolRegistry = await config.getToolRegistry();
        toolRegistry.unregisterTool(SendFeishuFileTool.Name);
        toolRegistry.unregisterTool(CreateProjectGroupTool.Name);
        toolRegistry.unregisterTool(AudioReaderTool.Name);
        toolRegistry.unregisterTool(SelfUpdateTool.Name);
        await geminiClient.setTools();
      } catch {
        // ignore
      }
    }
    // 显式清除 5s 看门狗定时器与队列状态，防止 logout 后残留 interval / 脏状态。
    if (feishuLoopInterval) {
      clearInterval(feishuLoopInterval);
      feishuLoopInterval = null;
    }
    clearMessageQueue();
    resetProcessingCount();
    await activeGateway.disconnect();
    activeGateway = null;
    appEvents.emit(AppEvent.FeishuBotStopped);
  }
  tuiContext = null; // 清除 TUI 上下文
  globalCommandContext = null;
  activeChatId = null;
  activeReplyToMessageId = null;
  chatLastTokenUsage.clear();
  await clearCredentials();
  return t('feishu.logout.cleared');
}

/**
 * 交互式主入口
 */
async function handleInteractive(): Promise<string> {
  const result = await loadCredsSafe();
  if (!result.ok) {
    return tp('feishu.start.creds_load_failed', { error: result.error });
  }
  const creds = result.creds;

  if (!creds) {
    // 未配置，引导 setup
    return [
      t('feishu.interactive.welcome'),
      '',
      t('feishu.interactive.first_time'),
      t('feishu.interactive.setup_qr'),
      t('feishu.interactive.setup_manual'),
      '',
      t('feishu.interactive.help_hint'),
    ].join('\n');
  }

  if (!activeGateway) {
    return [
      t('feishu.interactive.creds_ready'),
      `  App ID: ${creds.appId}`,
      tp('feishu.interactive.creds_bot', { name: creds.botName || t('feishu.start.bot_unknown') }),
      '',
      t('feishu.interactive.start_hint'),
      t('feishu.interactive.logout_hint'),
    ].join('\n');
  }

  return t('feishu.interactive.already_running');
}

/** 通用 MessageActionReturn 包装 */
function msg(content: string): SlashCommandActionReturn {
  return { type: 'message', messageType: 'info', content };
}

export const feishuCommand: SlashCommand = {
  name: 'feishu',
  altNames: ['飞书'],
  description: t('feishu.command.description'),
  kind: CommandKind.BUILT_IN,

  // /feishu（无子命令）→ 显示帮助
  action: async () => msg(await handleInteractive()),

  subCommands: [
    {
      name: 'start',
      description: t('feishu.subcmd.start.description'),
      kind: CommandKind.BUILT_IN,
      action: async (ctx) => msg(await handleStart(ctx)),
    },
    {
      name: 'setup',
      description: t('feishu.subcmd.setup.description'),
      kind: CommandKind.BUILT_IN,
      action: async (ctx, args) => msg(await handleSetup(args, ctx)),
    },
    {
      name: 'stop',
      description: t('feishu.subcmd.stop.description'),
      kind: CommandKind.BUILT_IN,
      action: async (ctx) => msg(await handleStop(ctx)),
    },
    {
      name: 'status',
      description: t('feishu.subcmd.status.description'),
      kind: CommandKind.BUILT_IN,
      action: async () => msg(await handleStatus()),
    },
    {
      name: 'logout',
      description: t('feishu.subcmd.logout.description'),
      kind: CommandKind.BUILT_IN,
      action: async (ctx) => msg(await handleLogout(ctx)),
    },
    {
      name: 'allow',
      description: t('feishu.subcmd.allow.description'),
      kind: CommandKind.BUILT_IN,
      action: async (_ctx, args) => msg(await handleAllow(args)),
    },
    {
      name: 'deny',
      description: t('feishu.subcmd.deny.description'),
      kind: CommandKind.BUILT_IN,
      action: async (_ctx, args) => msg(await handleDeny(args)),
    },
    {
      name: 'allowlist',
      description: t('feishu.subcmd.allowlist.description'),
      kind: CommandKind.BUILT_IN,
      action: async () => msg(await handleAllowlist()),
    },
    {
      name: 'help',
      description: t('feishu.subcmd.help.description'),
      kind: CommandKind.BUILT_IN,
      action: async () => msg(helpText()),
    },
  ],
};
