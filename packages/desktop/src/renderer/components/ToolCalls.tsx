/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 工具调用展示。spec §主聊天区 2：
 *   「调用了 N 个工具」折叠卡 → 内部每个工具卡（编辑文件 / 终端运行）。
 *   编辑文件卡展开为红/绿 diff 视图；终端运行卡默认折叠，展开看输出。
 *   状态：运行中（转圈/amber）→ 已完成（绿勾）。
 *
 * 数据来自协议 ToolCall（packages/server/src/protocol.ts）。工具类型分类靠
 * toolName / confirmationDetails 启发式判断，覆盖 spec 的两类卡，其余归通用卡。
 */

import React, { useState } from 'react';
import type {
  ToolCallStatus,
  ToolCall,
  ToolCallConfirmationDetails,
  ToolConfirmationResponsePayload,
} from 'otto-server';
import { parseDiff, type DiffLine } from './diff.js';
import { createQrMatrix } from '../lib/qrMatrix.js';
import {
  IconFile,
  IconTerminal,
  IconCheck,
  IconChevron,
  IconClose,
} from './icons.js';

/**
 * 回传工具确认应答（AskUserQuestion 提交答案 / 跳过）。透传自 store 的
 * respondToolConfirmation；callId = 工具卡 id。
 */
export type RespondQuestionFn = (
  callId: string,
  outcome: 'approved' | 'rejected' | 'always_approve',
  payload?: ToolConfirmationResponsePayload,
  /** 普通问答省略；执行型确认带上原始工具，供 App 的可信中继复核。 */
  tool?: ToolCall,
) => void;

type ToolKind =
  | 'edit'
  | 'exec'
  | 'read'
  | 'search'
  | 'web'
  | 'document'
  | 'skill'
  | 'audio'
  | 'agent'
  | 'automation'
  | 'generic';

interface ResolvedTool {
  kind: ToolKind;
  label: string;
  action: string;
  /** 编辑文件路径 / 终端命令 / 工具描述。 */
  target: string;
  diff?: string;
  output?: string;
}

const EDIT_TOOLS = new Set([
  'edit',
  'edit_file',
  'editfile',
  'write_file',
  'writefile',
  'apply_patch',
  'applypatch',
  'replace',
  'str_replace',
]);
const EXEC_TOOLS = new Set([
  'run_shell_command',
  'shell',
  'bash',
  'terminal',
  'exec',
  'run_command',
  'execute',
]);

const READ_TOOLS = new Set([
  'read_file',
  'read_many_files',
  'list_directory',
  'list_dir',
  'ls',
]);
const SEARCH_TOOLS = new Set([
  'glob',
  'search_files',
  'search_file_content',
  'grep',
  'rg',
  'find',
]);
const WEB_TOOLS = new Set([
  'web_fetch',
  'web_search',
  'web_search_query',
  'fetch_url',
]);
const SKILL_TOOLS = new Set([
  'find-skills',
  'use_skill',
  'read_skill',
  'skill',
]);
const AUDIO_TOOLS = new Set([
  'audio_reader',
  'transcribe_audio',
  'whisper',
  'meeting_transcribe',
]);
const AGENT_TOOLS = new Set(['task', 'subagent', 'multi_agent', 'workflow']);

const DOCUMENT_TOOL_PATTERNS = [
  'doc',
  'word',
  'ppt',
  'pdf',
  'excel',
  'spreadsheet',
  'presentation',
  'slides',
  'document',
];

/**
 * lark-cli 目前会输出三类授权入口：设备码页、CLI 配置页、旧版 authen 页。
 * 这里只接受飞书/Lark 官方 HTTPS 主机上的已知路径，避免把工具输出中的任意
 * 链接制作成二维码或交给系统浏览器。
 */
const FEISHU_AUTH_TOOL_NAMES = new Set(['lark_cli', 'lark-cli']);
const FEISHU_ACCOUNTS_HOSTS = new Set([
  'accounts.feishu.cn',
  'accounts.larksuite.com',
]);
const FEISHU_OPEN_HOSTS = new Set(['open.feishu.cn', 'open.larksuite.com']);
const USER_CODE_RE = /^[a-z0-9][a-z0-9_-]{3,63}$/i;
const APP_ID_RE = /^[a-z0-9_-]{3,128}$/i;
const ANSI_ESCAPE = String.fromCharCode(27);

interface FeishuAuthorization {
  url: string;
  userCode?: string;
}

function isAllowedFeishuAuthorizationUrl(url: URL): boolean {
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    return false;
  }

  const userCode = url.searchParams.get('user_code') ?? '';
  if (FEISHU_ACCOUNTS_HOSTS.has(url.hostname)) {
    return (
      url.pathname === '/oauth/v1/device/verify' && USER_CODE_RE.test(userCode)
    );
  }

  if (!FEISHU_OPEN_HOSTS.has(url.hostname)) return false;
  if (url.pathname === '/page/cli' || url.pathname === '/page/launcher') {
    return USER_CODE_RE.test(userCode);
  }
  if (url.pathname === '/open-apis/authen/v1/index') {
    return APP_ID_RE.test(url.searchParams.get('app_id') ?? '');
  }
  return false;
}

function extractFeishuAuthorization(
  tool: ToolCall,
  output?: string,
): FeishuAuthorization | null {
  if (
    !output ||
    !FEISHU_AUTH_TOOL_NAMES.has((tool.toolName ?? '').trim().toLowerCase())
  ) {
    return null;
  }

  // ESC 也作为终止符，兼容 lark-cli 的彩色终端输出。
  const candidates =
    output
      .split(ANSI_ESCAPE)
      .join('\n')
      .match(/https:\/\/[^\s<>"'`]+/gi) ?? [];
  for (const candidate of candidates) {
    const clean = candidate.replace(/[\])},.;，。；]+$/u, '');
    if (clean.length > 4096) continue;
    try {
      const parsed = new URL(clean);
      if (!isAllowedFeishuAuthorizationUrl(parsed)) continue;
      const userCode = parsed.searchParams.get('user_code') ?? undefined;
      return { url: clean, userCode };
    } catch {
      // 工具输出可能包含截断中的 URL；继续寻找下一条完整候选。
    }
  }
  return null;
}

/** 使用项目已有的本地 QR 编码器生成矩阵，不把授权 URL 发给第三方服务。 */
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function normalizeToolName(toolName?: string): string {
  return (toolName ?? '').trim().toLowerCase();
}

function isDocumentTool(name: string): boolean {
  return DOCUMENT_TOOL_PATTERNS.some((pattern) => name.includes(pattern));
}

function automationAction(action: string | undefined): string {
  switch (action) {
    case 'start': return '创建自动流程';
    case 'run_next': return '执行下一步';
    case 'approve': return '记录执行批准';
    case 'recover': return '检查中断状态';
    case 'take_over': return '人工接管流程';
    case 'status': return '查看流程状态';
    default: return '处理自动流程';
  }
}

function automationSafetyNotice(tool: ToolCall, output?: string): string | undefined {
  if (!output || !['rpa_run', 'durable_workflow'].includes(normalizeToolName(tool.toolName))) return undefined;
  if (/unknown_outcome|browser context is unavailable/iu.test(output)) {
    return '执行结果未知，Otto 不会自动重试。请核对外部系统，再让 Otto 记录人工接管或从导航检查点重新开始。';
  }
  if (/awaiting_approval|"approvalId"/u.test(output)) {
    return '此流程在等待独立批准；批准记录写入后才会继续执行。';
  }
  if (/"state":"paused"|"status":"cancelled"/u.test(output)) {
    return '流程已暂停或由人工接管结束；不会自行恢复。';
  }
  return undefined;
}

function resolveTool(tc: ToolCall): ResolvedTool {
  const name = normalizeToolName(tc.toolName);
  const d: ToolCallConfirmationDetails = tc.confirmationDetails ?? {};
  const p = tc.parameters ?? {};

  if (name === 'rpa_run' || name === 'durable_workflow') {
    const action = str(p.action);
    const target = str(p.run_id) ?? str(p.workflow_id) ?? str(p.definition_id) ?? tc.description ?? '';
    return {
      kind: 'automation',
      label: name === 'rpa_run' ? '网页自动化流程' : '可恢复工作流',
      action: automationAction(action),
      target,
      output: tc.liveOutput ?? str(tc.result?.data),
    };
  }

  // —— 编辑文件 —— //
  const isEdit =
    d.type === 'edit' || EDIT_TOOLS.has(name) || Boolean(d.fileDiff);
  if (isEdit) {
    const filePath =
      d.filePath ??
      d.fileName ??
      str(p.file_path) ??
      str(p.path) ??
      str(p.filename) ??
      tc.displayName ??
      tc.toolName;
    return {
      kind: 'edit',
      label: '修改文件',
      action: '修改文件',
      target: filePath ?? '',
      diff: d.fileDiff ?? str(p.diff) ?? str(p.patch),
    };
  }

  // —— 终端运行 —— //
  const isExec =
    d.type === 'exec' || EXEC_TOOLS.has(name) || Boolean(d.command);
  if (isExec) {
    const command =
      d.command ??
      str(p.command) ??
      str(p.cmd) ??
      tc.description ??
      tc.toolName;
    return {
      kind: 'exec',
      label: '运行检查',
      action: '执行本地命令',
      target: command ?? '',
      output: tc.liveOutput ?? str(tc.result?.data),
    };
  }

  if (READ_TOOLS.has(name)) {
    const target =
      str(p.absolute_path) ??
      str(p.file_path) ??
      str(p.path) ??
      str(p.directory) ??
      str(p.dir) ??
      tc.description ??
      '';
    return {
      kind: 'read',
      label:
        name === 'list_directory' || name === 'list_dir' || name === 'ls'
          ? '查看目录'
          : '查看文件',
      action: '查看相关资料',
      target,
      output: tc.liveOutput ?? str(tc.result?.data),
    };
  }

  if (SEARCH_TOOLS.has(name)) {
    const target =
      str(p.pattern) ??
      str(p.query) ??
      str(p.path) ??
      str(p.include) ??
      tc.description ??
      '';
    return {
      kind: 'search',
      label: '查找内容',
      action: '查找相关内容',
      target,
      output: tc.liveOutput ?? str(tc.result?.data),
    };
  }

  if (WEB_TOOLS.has(name)) {
    const target =
      str(p.url) ?? str(p.query) ?? str(p.prompt) ?? tc.description ?? '';
    return {
      kind: 'web',
      label: name.includes('search') ? '查找资料' : '读取网页',
      action: name.includes('search') ? '查找网上资料' : '读取网页内容',
      target,
      output: tc.liveOutput ?? str(tc.result?.data),
    };
  }

  if (SKILL_TOOLS.has(name)) {
    return {
      kind: 'skill',
      label: '加载能力',
      action: '准备合适的处理方式',
      target: tc.description ?? str(p.name) ?? str(p.skill) ?? '',
      output: tc.liveOutput ?? str(tc.result?.data),
    };
  }

  if (AUDIO_TOOLS.has(name) || name.includes('transcrib')) {
    return {
      kind: 'audio',
      label: '处理音频',
      action: '转写音频内容',
      target:
        str(p.path) ??
        str(p.file_path) ??
        str(p.fileName) ??
        tc.description ??
        '',
      output: tc.liveOutput ?? str(tc.result?.data),
    };
  }

  if (AGENT_TOOLS.has(name)) {
    return {
      kind: 'agent',
      label: '协同分析',
      action: '安排更细的分析任务',
      target: str(p.description) ?? str(p.prompt) ?? tc.description ?? '',
      output: tc.liveOutput ?? str(tc.result?.data),
    };
  }

  if (isDocumentTool(name)) {
    return {
      kind: 'document',
      label: '处理文档',
      action: '整理文档内容',
      target:
        str(p.path) ??
        str(p.file_path) ??
        str(p.filename) ??
        str(p.title) ??
        tc.description ??
        '',
      output: tc.liveOutput ?? str(tc.result?.data),
    };
  }

  // —— 通用 —— //
  const target =
    tc.description ??
    str(p.absolute_path) ??
    str(p.file_path) ??
    str(p.path) ??
    str(p.url) ??
    str(p.query) ??
    str(p.command) ??
    '';
  return {
    kind: 'generic',
    label: '处理步骤',
    action: tc.description ? '处理当前步骤' : '继续处理',
    target,
    output: tc.liveOutput ?? str(tc.result?.data),
  };
}

/**
 * 将工具名与目标收敛成适合聊天正文的单行摘要：
 * 不把多行命令/长 URL 整段倒进对话，也避免空正文时只剩「N 项过程」。
 */
function compactSummaryText(value: string, maxLength = 80): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function basename(value: string): string {
  const clean = value.trim().replace(/^["']|["']$/gu, '');
  return clean.split(/[\\/]/u).filter(Boolean).pop() ?? clean;
}

function describeFileTarget(value: string): string {
  const name = basename(value);
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return `PDF：${name}`;
  if (lower.endsWith('.docx') || lower.endsWith('.doc'))
    return `Word 文档：${name}`;
  if (lower.endsWith('.pptx') || lower.endsWith('.ppt')) return `PPT：${name}`;
  if (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    lower.endsWith('.csv')
  ) {
    return `表格：${name}`;
  }
  if (
    /\.(ts|tsx|js|jsx|py|go|rs|java|cs|cpp|c|h|css|scss|html|json|md)$/iu.test(
      lower,
    )
  ) {
    return `代码文件：${name}`;
  }
  return name || value;
}

function describeCommand(command: string): { action: string; target: string } {
  const compact = compactSummaryText(command, 90);
  const lower = compact.toLowerCase();
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)\b/u.test(lower)) {
    return { action: '运行测试', target: compact };
  }
  if (/\b(vitest|jest|pytest|cargo test|go test)\b/u.test(lower)) {
    return { action: '运行测试', target: compact };
  }
  if (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(typecheck|tsc|lint|check)\b/u.test(lower)
  ) {
    return { action: '检查代码质量', target: compact };
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|package|dist)\b/u.test(lower)) {
    return { action: '构建项目', target: compact };
  }
  if (/^git\s+status\b/u.test(lower))
    return { action: '检查提交状态', target: compact };
  if (/^git\s+(diff|show|log)\b/u.test(lower))
    return { action: '查看代码变更', target: compact };
  if (/^git\s+(push|pull|fetch)\b/u.test(lower))
    return { action: '同步代码仓库', target: compact };
  if (/^git\s+(commit|add)\b/u.test(lower))
    return { action: '整理提交内容', target: compact };
  return { action: '执行本地命令', target: compact };
}

function refineResolvedTool(tool: ResolvedTool): ResolvedTool {
  if (!tool.target) return tool;
  if (
    tool.kind === 'read' ||
    tool.kind === 'edit' ||
    tool.kind === 'document'
  ) {
    return { ...tool, target: describeFileTarget(tool.target) };
  }
  if (tool.kind === 'exec') {
    const command = describeCommand(tool.target);
    return {
      ...tool,
      label: command.action,
      action: command.action,
      target: command.target,
    };
  }
  return tool;
}

function toolErrorText(tool: ToolCall): string {
  const error =
    str(tool.result?.error) ??
    (tool.result?.success === false ? str(tool.result?.data) : undefined) ??
    (tool.status === 'cancelled' ? '已取消' : undefined) ??
    '';
  return compactSummaryText(error, 96);
}

function summarizeToolAction(tool: ToolCall): string {
  const resolved = refineResolvedTool(resolveTool(tool));
  const target = compactSummaryText(resolved.target, 56);
  return target ? `${resolved.action}（${target}）` : resolved.action;
}

function summarizeCompletedWork(toolCalls: readonly ToolCall[]): string {
  const meaningful = toolCalls
    .map(summarizeToolAction)
    .filter(Boolean)
    .slice(0, 3);
  if (meaningful.length === 0) return '相关处理已完成。';
  if (meaningful.length === 1) return `${meaningful[0]}已完成。`;
  const suffix =
    toolCalls.length > meaningful.length ? '等处理已完成。' : '已完成。';
  return `${meaningful.join('、')}${suffix}`;
}

function summarizeFailedWork(failedTools: readonly ToolCall[]): string {
  const first = failedTools[0];
  if (!first) return '';
  const action = summarizeToolAction(first);
  const reason = toolErrorText(first);
  if (failedTools.length === 1) {
    return reason ? `${action}没有完成：${reason}。` : `${action}没有完成。`;
  }
  return reason
    ? `${failedTools.length} 个步骤没有完成，最先卡在 ${action}：${reason}。`
    : `${failedTools.length} 个步骤没有完成，最先卡在 ${action}。`;
}

/**
 * 当模型最终没有返回正文时，由 UI 生成确定性的最小交付总结。
 * 最多列出 3 个关键步骤，防止长工具链刷屏。
 */
export function buildToolCompletionSummary(
  toolCalls: readonly ToolCall[],
): string {
  if (toolCalls.length === 0) return '';

  const completedTools = toolCalls.filter((tool) => tool.status === 'success');
  const failedTools = toolCalls.filter(
    (tool) => tool.status === 'error' || tool.status === 'cancelled',
  );
  const pendingTools = toolCalls.filter(
    (tool) =>
      tool.status !== 'success' &&
      tool.status !== 'error' &&
      tool.status !== 'cancelled',
  );
  const completed = completedTools.length;
  const pending = pendingTools.length;

  if (failedTools.length > 0) {
    const completedText =
      completedTools.length > 0
        ? `已完成：${completedTools.slice(0, 2).map(summarizeToolAction).join('、')}。`
        : '';
    const pendingText = pending > 0 ? `还有 ${pending} 个步骤在等待处理。` : '';
    return `${summarizeFailedWork(failedTools)}${completedText}${pendingText}`;
  }

  if (pending > 0) {
    return `我还在处理：${pendingTools
      .slice(0, 2)
      .map(summarizeToolAction)
      .join('、')}。`;
  }

  const steps = toolCalls
    .slice(0, 3)
    .map((tool) => {
      const resolved = refineResolvedTool(resolveTool(tool));
      const label = compactSummaryText(resolved.action || resolved.label, 24);
      const target = compactSummaryText(resolved.target);
      return target && target !== label ? `${label}（${target}）` : label;
    })
    .filter(Boolean);

  if (completed === 0) return '';
  if (toolCalls.length <= 3) return summarizeCompletedWork(toolCalls);
  return `${summarizeCompletedWork(toolCalls)}主要处理了：${steps.join('；')}。`;
}

function buildToolGroupSummary(toolCalls: readonly ToolCall[]): string {
  const running = toolCalls.filter(
    (tool) =>
      tool.status === 'executing' ||
      tool.status === 'validating' ||
      tool.status === 'scheduled',
  );
  const awaiting = toolCalls.filter(
    (tool) => tool.status === 'awaiting_approval',
  );
  const failed = toolCalls.filter(
    (tool) => tool.status === 'error' || tool.status === 'cancelled',
  );

  if (awaiting.length > 0) return '需要你确认下一步';

  const current = running[0];
  if (current) {
    const resolved = refineResolvedTool(resolveTool(current));
    const target = compactSummaryText(resolved.target, 36);
    return target
      ? `正在${resolved.action}：${target}`
      : `正在${resolved.action}`;
  }

  if (failed.length > 0) {
    return failed.length === toolCalls.length
      ? '这一步没有完成'
      : `有 ${failed.length} 个步骤需要处理`;
  }

  if (toolCalls.length === 1) {
    const resolved = refineResolvedTool(resolveTool(toolCalls[0]));
    return `已完成：${resolved.action}`;
  }
  return `已完成 ${toolCalls.length} 个步骤`;
}

/** 状态图标语义位：驱动渲染选哪个图标，避免用 running/error 双布尔反推。 */
type StatusIconKind = 'pending' | 'queued' | 'running' | 'done' | 'error';

function statusInfo(status: ToolCallStatus): {
  cls: string;
  text: string;
  running: boolean;
  error: boolean;
  kind: StatusIconKind;
} {
  // 用字符串字面量比较（值与 protocol ToolCallStatus 枚举一致），
  // 避免在渲染层 import 枚举「值」而把 otto-server 运行时拖进 bundle。
  switch (status as string) {
    case 'success':
      return {
        cls: 'otto-tool__status--done',
        text: '已完成',
        running: false,
        error: false,
        kind: 'done',
      };
    case 'error':
      return {
        cls: 'otto-tool__status--error',
        text: '失败',
        running: false,
        error: true,
        kind: 'error',
      };
    case 'cancelled':
      return {
        cls: 'otto-tool__status--error',
        text: '已取消',
        running: false,
        error: true,
        kind: 'error',
      };
    case 'awaiting_approval':
      // 待确认：不转圈也不渲染成功勾，用中性暂停语义（琥珀点）。
      return {
        cls: 'otto-tool__status--pending',
        text: '待确认',
        running: false,
        error: false,
        kind: 'pending',
      };
    case 'scheduled':
      // 排队中：尚未开始，用静态点而非转圈，区别于真正在跑。
      return {
        cls: 'otto-tool__status--running',
        text: '排队中',
        running: false,
        error: false,
        kind: 'queued',
      };
    case 'validating':
      // 校验中：已在动，保留转圈。
      return {
        cls: 'otto-tool__status--running',
        text: '校验中',
        running: true,
        error: false,
        kind: 'running',
      };
    default:
      // executing 及其它未列举态：执行中转圈。
      return {
        cls: 'otto-tool__status--running',
        text: '运行中',
        running: true,
        error: false,
        kind: 'running',
      };
  }
}

/**
 * 状态图标：按语义位选图标，让每种终态/进行态都有对齐的图标。
 *   done → 完成；error → 错误；running → 转圈；queued/pending → 静态圆点。
 */
function StatusIcon({
  kind,
  label,
}: {
  kind: StatusIconKind;
  label: string;
}): React.JSX.Element {
  switch (kind) {
    case 'running':
      return <span className="otto-spin" role="img" aria-label={label} />;
    case 'done':
      return <IconCheck size={14} />;
    case 'error':
      return <IconClose size={14} />;
    case 'queued':
    case 'pending':
    default:
      // 静态圆点：不动，区别于转圈的「在跑」。
      return <span className="otto-tool__dot" role="img" aria-label={label} />;
  }
}

export function ToolCallsCard({
  toolCalls,
  onRespondQuestion,
}: {
  toolCalls: ToolCall[];
  /** AskUserQuestion 作答回传；缺省时问答卡以只读态渲染（无交互按钮）。 */
  onRespondQuestion?: RespondQuestionFn;
}): React.JSX.Element | null {
  // 顶层展示给普通用户看的行动进度，具体技术工具名保留在单项 tooltip 里。
  const [open, setOpen] = useState(true);
  if (!toolCalls || toolCalls.length === 0) return null;
  const summary = buildToolGroupSummary(toolCalls);

  return (
    <div className="otto-tools">
      <button
        type="button"
        className="otto-tools__summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {summary}
        <IconChevron
          size={16}
          className={`otto-tools__chev${open ? ' otto-tools__chev--open' : ''}`}
        />
      </button>
      <div className={`otto-collapse${open ? ' otto-collapse--open' : ''}`}>
        <div className="otto-collapse__inner">
          <div className="otto-tools__list">
            {toolCalls.map((tc) =>
              isPendingQuestion(tc) ? (
                // 待作答的 AskUserQuestion：整卡换成交互式问答卡。
                <QuestionCard
                  key={tc.id}
                  tool={tc}
                  onRespond={onRespondQuestion}
                />
              ) : isPendingConfirmation(tc) ? (
                <ConfirmationCard
                  key={tc.id}
                  tool={tc}
                  onRespond={onRespondQuestion}
                />
              ) : (
                <ToolItem key={tc.id} tool={tc} />
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function isPendingConfirmation(tc: ToolCall): boolean {
  return (
    tc.status === 'awaiting_approval' &&
    tc.confirmationDetails?.type !== 'question'
  );
}

function ConfirmationCard({
  tool,
  onRespond,
}: {
  tool: ToolCall;
  onRespond?: RespondQuestionFn;
}): React.JSX.Element {
  const [sent, setSent] = useState(false);
  const details = tool.confirmationDetails ?? {};
  const target =
    details.command ??
    details.filePath ??
    details.fileName ??
    str(tool.parameters.command) ??
    str(tool.parameters.path) ??
    tool.toolName;
  const highRisk = details.riskLevel === 'high' || details.type === 'delete';
  const respond = (outcome: 'approved' | 'rejected'): void => {
    if (!onRespond || sent) return;
    setSent(true);
    onRespond(tool.id, outcome, undefined, tool);
  };
  return (
    <div className="otto-tool otto-ask otto-confirm">
      <div className="otto-ask__head">
        <span
          className={`otto-ask__badge${highRisk ? ' otto-confirm__badge--danger' : ''}`}
        >
          {highRisk ? '高风险操作' : '需要你确认'}
        </span>
        <span className="otto-ask__title">
          {details.title ?? '允许 Otto 执行此操作？'}
        </span>
      </div>
      <div className="otto-confirm__target">{target}</div>
      <div className="otto-ask__actions">
        <button
          type="button"
          className="otto-ask__skip"
          disabled={sent || !onRespond}
          onClick={() => respond('rejected')}
        >
          拒绝
        </button>
        <button
          type="button"
          className="otto-ask__submit"
          disabled={sent || !onRespond}
          onClick={() => respond('approved')}
        >
          {sent ? '已提交' : '允许执行'}
        </button>
      </div>
    </div>
  );
}

/** 该工具卡是否是「待用户作答的 AskUserQuestion」（需渲染交互式问答卡）。 */
function isPendingQuestion(tc: ToolCall): boolean {
  return (
    tc.status === 'awaiting_approval' &&
    tc.confirmationDetails?.type === 'question' &&
    (tc.confirmationDetails.questions?.length ?? 0) > 0
  );
}

async function copyToolOutput(text: string): Promise<boolean> {
  try {
    // Desktop 通过 main 进程写系统剪贴板，避免 renderer 权限和焦点状态导致复制失败。
    const desktopWriter = window.otto?.writeClipboard;
    if (typeof desktopWriter === 'function') return await desktopWriter(text);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // 浏览器预览/旧版 WebView 的兼容路径。
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

function ToolItem({ tool }: { tool: ToolCall }): React.JSX.Element {
  const resolved = refineResolvedTool(resolveTool(tool));
  const st = statusInfo(tool.status);
  const feishuAuthorization = extractFeishuAuthorization(tool, resolved.output);
  const safetyNotice = automationSafetyNotice(tool, resolved.output);
  // 编辑文件卡默认展开看 diff（spec 截图）；exec/generic 运行中默认展开露实时输出，
  // 否则默认折叠。
  const [open, setOpen] = useState(resolved.kind === 'edit' || st.running);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );

  const Icon = resolved.kind === 'exec' ? IconTerminal : IconFile;
  const hasBody =
    Boolean(feishuAuthorization) ||
    Boolean(safetyNotice) ||
    (resolved.kind === 'edit' && Boolean(resolved.diff)) ||
    (resolved.kind !== 'edit' && Boolean(resolved.output));
  const rawName = tool.toolName || tool.displayName || '';
  const rawTitle = rawName ? `内部能力：${rawName}` : undefined;

  const headInner = (
    <>
      <span className="otto-tool__icon">
        <Icon size={16} />
      </span>
      <span className="otto-tool__kind" title={rawTitle}>
        {resolved.label}
      </span>
      <span className="otto-tool__target" title={resolved.target || undefined}>
        {resolved.target}
      </span>
      <span className={`otto-tool__status ${st.cls}`}>
        <StatusIcon kind={st.kind} label={st.text} />
        {/* key 绑文案：运行中→已完成 切换时触发淡入，不再硬切。 */}
        <span key={st.text} className="otto-tool__statustext">
          {st.text}
        </span>
      </span>
      {hasBody ? (
        <IconChevron
          size={15}
          className={`otto-tool__chev${open ? ' otto-tool__chev--open' : ''}`}
        />
      ) : null}
    </>
  );

  return (
    <div className="otto-tool">
      {hasBody ? (
        <button
          type="button"
          className="otto-tool__head"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {headInner}
        </button>
      ) : (
        // 无可展开内容：不挂点击/展开语义，避免假可点性（cursor/hover 归 CSS 的 --static）。
        <div className="otto-tool__head otto-tool__head--static">
          {headInner}
        </div>
      )}

      {/* grid 折叠动画包裹 body（diff / 终端输出） */}
      {hasBody ? (
        <div className={`otto-collapse${open ? ' otto-collapse--open' : ''}`}>
          <div className="otto-collapse__inner">
            {feishuAuthorization ? (
              <FeishuAuthorizationCard authorization={feishuAuthorization} />
            ) : resolved.kind === 'edit' && resolved.diff ? (
              <DiffView diff={resolved.diff} path={resolved.target} />
            ) : safetyNotice || resolved.output ? (
              <div className="otto-tool__output-wrap">
                {safetyNotice ? <div className="otto-tool__safety-notice" role="status">{safetyNotice}</div> : null}
                <div className="otto-tool__output-actions">
                  <button
                    type="button"
                    className="otto-tool__copy"
                    onClick={async () => {
                      const copied = await copyToolOutput(resolved.output!);
                      setCopyState(copied ? 'copied' : 'failed');
                      if (copied)
                        window.setTimeout(() => setCopyState('idle'), 1600);
                    }}
                  >
                    {copyState === 'copied'
                      ? '已复制'
                      : copyState === 'failed'
                        ? '复制失败'
                        : '复制结果'}
                  </button>
                </div>
                <pre className="otto-tool__output">{resolved.output}</pre>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FeishuAuthorizationCard({
  authorization,
}: {
  authorization: FeishuAuthorization;
}): React.JSX.Element {
  const matrix = createQrMatrix(authorization.url);
  const size = matrix?.length ?? 0;
  const pathParts: string[] = [];
  matrix?.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      if (row[x] && start < 0) start = x;
      if ((!row[x] || x === row.length) && start >= 0) {
        const width = x - start;
        pathParts.push(`M${start} ${y}h${width}v1H${start}z`);
        start = -1;
      }
    }
  });

  return (
    <div className="otto-feishu-auth">
      <div className="otto-feishu-auth__copy">
        <span className="otto-feishu-auth__eyebrow">飞书授权</span>
        <strong className="otto-feishu-auth__title">用飞书扫码继续</strong>
        <span className="otto-feishu-auth__hint">
          扫码并确认后，Otto 会自动继续当前工作。
        </span>
        {authorization.userCode ? (
          <code className="otto-feishu-auth__code">
            授权码：{authorization.userCode}
          </code>
        ) : null}
        <button
          type="button"
          className="otto-feishu-auth__open"
          onClick={() => {
            void window.otto
              .openExternal(authorization.url)
              .catch(() => undefined);
          }}
        >
          在浏览器中打开授权页面
        </button>
      </div>
      {matrix ? (
        <svg
          className="otto-feishu-auth__qr"
          role="img"
          aria-label="飞书授权二维码"
          viewBox={`-3 -3 ${size + 6} ${size + 6}`}
          shapeRendering="crispEdges"
        >
          <rect x={-3} y={-3} width={size + 6} height={size + 6} fill="#fff" />
          <path d={pathParts.join('')} fill="#111" />
        </svg>
      ) : null}
    </div>
  );
}

/** UI 自动追加的自由文本选项 label（与 core 约定一致，不由模型给出）。 */
const OTHER_LABEL = 'Other';

/**
 * AskUserQuestion 交互式问答卡：渲染 1-4 个问题，每题选项按钮 + 自动追加的
 * 「其它」自由文本；答齐后「提交」把 answers 回传 server，「跳过」以拒答收口。
 * 提交/跳过后卡进入 pending 态（等 server 回 tool_calls_update 收口成成功）。
 */
function QuestionCard({
  tool,
  onRespond,
}: {
  tool: ToolCall;
  onRespond?: RespondQuestionFn;
}): React.JSX.Element {
  const questions = tool.confirmationDetails?.questions ?? [];
  // 每题已选 label 列表（单选恒为 0/1 个；多选可多个）。
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  // 每题「其它」输入框文本。
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);

  function toggle(qText: string, label: string, multi: boolean): void {
    setSelections((prev) => {
      const cur = prev[qText] ?? [];
      if (multi) {
        const next = cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label];
        return { ...prev, [qText]: next };
      }
      // 单选：再点已选项则取消，否则替换为该项。
      return { ...prev, [qText]: cur[0] === label ? [] : [label] };
    });
  }

  /** 某题最终答案文本（Other → 输入框内容）；未答 / Other 空 → null。 */
  function answerFor(qText: string): string | null {
    const sel = selections[qText] ?? [];
    if (sel.length === 0) return null;
    const parts = sel.map((l) =>
      l === OTHER_LABEL ? (otherText[qText] ?? '').trim() : l,
    );
    if (parts.some((p) => !p)) return null;
    return parts.join(', ');
  }

  const allAnswered =
    questions.length > 0 &&
    questions.every((q) => answerFor(q.question) !== null);

  function submit(): void {
    if (!onRespond || sent || !allAnswered) return;
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const a = answerFor(q.question);
      if (a !== null) answers[q.question] = a;
    }
    setSent(true);
    onRespond(tool.id, 'approved', { answers });
  }

  function skip(): void {
    if (!onRespond || sent) return;
    setSent(true);
    onRespond(tool.id, 'rejected');
  }

  return (
    <div className="otto-tool otto-ask">
      <div className="otto-ask__head">
        <span className="otto-ask__badge">需要你确认</span>
        <span className="otto-ask__title">
          {tool.confirmationDetails?.title ?? '请选择'}
        </span>
      </div>

      {questions.map((q) => {
        const multi = Boolean(q.multiSelect);
        const sel = selections[q.question] ?? [];
        const opts = [
          ...q.options,
          { label: OTHER_LABEL, description: '自定义回答' },
        ];
        const otherOn = sel.includes(OTHER_LABEL);
        return (
          <div className="otto-ask__q" key={q.question}>
            <div className="otto-ask__qtop">
              {q.header ? (
                <span className="otto-ask__chip">{q.header}</span>
              ) : null}
              <span className="otto-ask__qtext">{q.question}</span>
            </div>
            <div className="otto-ask__opts">
              {opts.map((opt) => {
                const active = sel.includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    className={`otto-ask__opt${active ? ' otto-ask__opt--on' : ''}`}
                    aria-pressed={active}
                    disabled={sent}
                    onClick={() => toggle(q.question, opt.label, multi)}
                  >
                    <span className="otto-ask__optmark" aria-hidden>
                      {active ? <IconCheck size={13} /> : null}
                    </span>
                    <span className="otto-ask__optbody">
                      <span className="otto-ask__optlabel">{opt.label}</span>
                      {opt.description ? (
                        <span className="otto-ask__optdesc">
                          {opt.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
            {otherOn ? (
              <input
                type="text"
                className="otto-ask__other"
                placeholder="输入你的回答…"
                value={otherText[q.question] ?? ''}
                disabled={sent}
                autoFocus
                onChange={(e) =>
                  setOtherText((prev) => ({
                    ...prev,
                    [q.question]: e.target.value,
                  }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && allAnswered) submit();
                }}
              />
            ) : null}
          </div>
        );
      })}

      <div className="otto-ask__actions">
        <button
          type="button"
          className="otto-ask__skip"
          disabled={sent || !onRespond}
          onClick={skip}
        >
          跳过
        </button>
        <button
          type="button"
          className="otto-ask__submit"
          disabled={sent || !allAnswered || !onRespond}
          onClick={submit}
        >
          {sent ? '已提交' : '提交'}
        </button>
      </div>
    </div>
  );
}

function DiffView({
  diff,
  path,
}: {
  diff: string;
  path?: string;
}): React.JSX.Element {
  const { lines, stats } = parseDiff(diff);
  return (
    <div className="otto-diff">
      {stats.added > 0 || stats.removed > 0 || path ? (
        <div className="otto-diff__stat">
          {path ? (
            <span className="otto-diff__stat-path" title={path}>
              {path}
            </span>
          ) : (
            <span className="otto-diff__stat-path" />
          )}
          <span className="otto-diff__stat-counts">
            <span className="otto-diff__stat-add">+{stats.added}</span>
            <span className="otto-diff__stat-del">−{stats.removed}</span>
          </span>
        </div>
      ) : null}
      <div className="otto-diff__scroll">
        {lines.map((line, i) => (
          <DiffRow key={i} line={line} />
        ))}
      </div>
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }): React.JSX.Element {
  if (line.type === 'hunk') {
    return (
      <div className="otto-diff__row otto-diff__row--hunk">
        <span className="otto-diff__gutter" />
        <span className="otto-diff__sign" />
        <span className="otto-diff__code">{line.content}</span>
      </div>
    );
  }
  const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  const gutter =
    line.type === 'add'
      ? (line.newLine ?? '')
      : line.type === 'del'
        ? (line.oldLine ?? '')
        : (line.newLine ?? '');
  return (
    <div className={`otto-diff__row otto-diff__row--${line.type}`}>
      <span className="otto-diff__gutter">{gutter}</span>
      <span className="otto-diff__sign">{sign}</span>
      <span className="otto-diff__code">{line.content}</span>
    </div>
  );
}
