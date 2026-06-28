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
} from 'otto-server';
import { parseDiff, type DiffLine } from './diff.js';
import {
  IconFile,
  IconTerminal,
  IconCheck,
  IconChevron,
} from './icons.js';

type ToolKind = 'edit' | 'exec' | 'generic';

interface ResolvedTool {
  kind: ToolKind;
  label: string;
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

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function resolveTool(tc: ToolCall): ResolvedTool {
  const name = (tc.toolName || '').toLowerCase();
  const d: ToolCallConfirmationDetails = tc.confirmationDetails ?? {};
  const p = tc.parameters ?? {};

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
      label: '编辑文件',
      target: filePath ?? '',
      diff: d.fileDiff ?? str(p.diff) ?? str(p.patch),
    };
  }

  // —— 终端运行 —— //
  const isExec = d.type === 'exec' || EXEC_TOOLS.has(name) || Boolean(d.command);
  if (isExec) {
    const command =
      d.command ??
      str(p.command) ??
      str(p.cmd) ??
      tc.description ??
      tc.toolName;
    return {
      kind: 'exec',
      label: '终端运行',
      target: command ?? '',
      output: tc.liveOutput ?? str(tc.result?.data),
    };
  }

  // —— 通用 —— //
  return {
    kind: 'generic',
    label: tc.displayName ?? tc.toolName,
    target: tc.description ?? '',
    output: tc.liveOutput ?? str(tc.result?.data),
  };
}

function statusInfo(status: ToolCallStatus): {
  cls: string;
  text: string;
  running: boolean;
  error: boolean;
} {
  // 用字符串字面量比较（值与 protocol ToolCallStatus 枚举一致），
  // 避免在渲染层 import 枚举「值」而把 otto-server 运行时拖进 bundle。
  switch (status as string) {
    case 'success':
      return { cls: 'otto-tool__status--done', text: '已完成', running: false, error: false };
    case 'error':
      return { cls: 'otto-tool__status--error', text: '失败', running: false, error: true };
    case 'cancelled':
      return { cls: 'otto-tool__status--error', text: '已取消', running: false, error: true };
    case 'awaiting_approval':
      return { cls: 'otto-tool__status--running', text: '待确认', running: false, error: false };
    default:
      return { cls: 'otto-tool__status--running', text: '运行中', running: true, error: false };
  }
}

export function ToolCallsCard({
  toolCalls,
}: {
  toolCalls: ToolCall[];
}): React.JSX.Element | null {
  // 顶层「调用了 N 个工具」折叠卡：有运行中的默认展开，否则默认展开（spec 截图为展开态）。
  const [open, setOpen] = useState(true);
  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div className="otto-tools">
      <button
        type="button"
        className="otto-tools__summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        调用了 {toolCalls.length} 个工具
        <IconChevron
          size={16}
          className={`otto-tools__chev${open ? ' otto-tools__chev--open' : ''}`}
        />
      </button>
      <div className={`otto-collapse${open ? ' otto-collapse--open' : ''}`}>
        <div className="otto-collapse__inner">
          <div className="otto-tools__list">
            {toolCalls.map((tc) => (
              <ToolItem key={tc.id} tool={tc} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolItem({ tool }: { tool: ToolCall }): React.JSX.Element {
  const resolved = resolveTool(tool);
  const st = statusInfo(tool.status);
  // 编辑文件卡默认展开看 diff（spec 截图）；终端 / 通用默认折叠。
  const [open, setOpen] = useState(resolved.kind === 'edit');

  const Icon = resolved.kind === 'exec' ? IconTerminal : IconFile;
  const hasBody =
    (resolved.kind === 'edit' && Boolean(resolved.diff)) ||
    (resolved.kind !== 'edit' && Boolean(resolved.output));

  return (
    <div className="otto-tool">
      <button
        type="button"
        className="otto-tool__head"
        onClick={() => hasBody && setOpen((v) => !v)}
        aria-expanded={hasBody ? open : undefined}
      >
        <span className="otto-tool__icon">
          <Icon size={16} />
        </span>
        <span className="otto-tool__kind">{resolved.label}</span>
        <span className="otto-tool__target" title={resolved.target || undefined}>
          {resolved.target}
        </span>
        <span className={`otto-tool__status ${st.cls}`}>
          {st.running ? (
            <span className="otto-spin" role="img" aria-label="运行中" />
          ) : st.error ? null : (
            <IconCheck size={14} />
          )}
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
      </button>

      {/* grid 折叠动画包裹 body（diff / 终端输出） */}
      {hasBody ? (
        <div className={`otto-collapse${open ? ' otto-collapse--open' : ''}`}>
          <div className="otto-collapse__inner">
            {resolved.kind === 'edit' && resolved.diff ? (
              <DiffView diff={resolved.diff} path={resolved.target} />
            ) : resolved.output ? (
              <pre className="otto-tool__output">{resolved.output}</pre>
            ) : null}
          </div>
        </div>
      ) : null}
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
      {(stats.added > 0 || stats.removed > 0 || path) ? (
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
      ? line.newLine ?? ''
      : line.type === 'del'
        ? line.oldLine ?? ''
        : line.newLine ?? '';
  return (
    <div className={`otto-diff__row otto-diff__row--${line.type}`}>
      <span className="otto-diff__gutter">{gutter}</span>
      <span className="otto-diff__sign">{sign}</span>
      <span className="otto-diff__code">{line.content}</span>
    </div>
  );
}
