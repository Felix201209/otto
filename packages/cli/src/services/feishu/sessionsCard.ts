/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure builder for the Feishu `/acp-session` dashboard card — a CardKit 2.0 card
 * that shows, in one place:
 *   - **Running / recent delegate tasks** on this machine (Claude Code / Codex),
 *     with live status: current tool, plan progress, token %, elapsed time.
 *   - **Resumable native sessions** discovered from each CLI's own history,
 *     with a copy-paste hint to continue one (`@cc:resume <id> <task>`).
 *
 * Kept free of any Feishu/runtime dependencies so it can be unit-tested in
 * isolation; the surrounding feishuCommand module gathers the data, sends the
 * card, and live-updates it. Everything renders into a single markdown element
 * (`SESSIONS_CARD_ELEMENT_ID`) so updates are a single whole-card replace.
 */

/** Element id of the dashboard body — stable so the card can be updated. */
export const SESSIONS_CARD_ELEMENT_ID = 'sessions_body';

export type RunningTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** A delegate task (from the background task store) projected for display. */
export interface RunningTaskView {
  id: string;
  agentLabel: string;
  /** Short task description / command preview. */
  title: string;
  status: RunningTaskStatus;
  currentTool?: string;
  toolCallCount?: number;
  planDone?: number;
  planTotal?: number;
  tokenUsed?: number;
  tokenSize?: number;
  startTime: number;
  endTime?: number;
  sessionId?: string;
  /** True when recovered from disk after a daemon restart. */
  restoredFromDisk?: boolean;
}

/** A native session discovered from a CLI's own history, projected for display. */
export interface DiscoveredSessionView {
  agent: 'claude-code' | 'codex';
  agentLabel: string;
  sessionId: string;
  title: string | null;
  cwd: string;
  updatedAt: string | null;
}

export interface SessionsCardData {
  runningTasks: RunningTaskView[];
  discovered: DiscoveredSessionView[];
  /** True while native-session discovery is still in flight. */
  discovering: boolean;
  /** Per-agent discovery errors (e.g. CLI not installed / not logged in). */
  discoverErrors?: string[];
  /** Reference time for elapsed/age formatting (injected for testability). */
  now: number;
}

const STATUS_BADGE: Record<RunningTaskStatus, string> = {
  running: '🟢 运行中',
  completed: '✅ 已完成',
  failed: '❌ 失败',
  cancelled: '⏹️ 已取消',
};

/** Resume-prefix alias per agent, used in the copy-paste hint. */
const RESUME_ALIAS: Record<DiscoveredSessionView['agent'], string> = {
  'claude-code': '@cc',
  codex: '@codex',
};

/** Human-friendly elapsed/age string from a millisecond delta. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

function ageOf(updatedAt: string | null, now: number): string {
  if (!updatedAt) return '未知';
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return '未知';
  return `${formatDuration(now - t)}前`;
}

/** Render one running-task row as markdown. */
function renderRunningTask(t: RunningTaskView, now: number): string {
  const badge = STATUS_BADGE[t.status] ?? t.status;
  const elapsed =
    t.status === 'running'
      ? formatDuration(now - t.startTime)
      : formatDuration((t.endTime ?? now) - t.startTime);

  const parts: string[] = [`**${t.agentLabel}** · ${badge} · ⏱️ ${elapsed}`];

  const detail: string[] = [];
  if (t.status === 'running' && t.currentTool) {
    detail.push(`🔧 ${t.currentTool}`);
  }
  if (typeof t.planDone === 'number' && typeof t.planTotal === 'number' && t.planTotal > 0) {
    detail.push(`📋 ${t.planDone}/${t.planTotal}`);
  }
  if (typeof t.toolCallCount === 'number' && t.toolCallCount > 0) {
    detail.push(`🛠️ ${t.toolCallCount} 次工具`);
  }
  if (typeof t.tokenUsed === 'number' && typeof t.tokenSize === 'number' && t.tokenSize > 0) {
    const pct = Math.round((t.tokenUsed / t.tokenSize) * 100);
    detail.push(`📊 ${pct}%`);
  }

  const lines = [`${parts.join('')}`, `  ${t.title}`];
  if (detail.length) lines.push(`  ${detail.join(' · ')}`);
  if (t.restoredFromDisk && t.status !== 'running') {
    lines.push('  ⚠️ 守护进程重启后恢复的记录');
  }
  lines.push(`  Task \`${t.id}\`${t.sessionId ? ` · 会话 \`${t.sessionId.slice(0, 8)}\`` : ''}`);
  return lines.join('\n');
}

/** Render one discoverable-session row as markdown. */
function renderDiscovered(s: DiscoveredSessionView, now: number): string {
  const title = (s.title ?? '').trim() || `会话 ${s.sessionId.slice(0, 8)}`;
  const resume = `${RESUME_ALIAS[s.agent]}:resume ${s.sessionId} <你的后续任务>`;
  return [
    `**${s.agentLabel}** · 🕒 ${ageOf(s.updatedAt, now)}`,
    `  ${title}`,
    `  继续：\`${resume}\``,
  ].join('\n');
}

/** Render the whole dashboard as a single markdown string. */
export function buildSessionsCardMarkdown(data: SessionsCardData): string {
  const sections: string[] = [];

  // ── Running / recent tasks ────────────────────────────────────────
  const running = data.runningTasks.filter((t) => t.status === 'running');
  const finished = data.runningTasks.filter((t) => t.status !== 'running');
  sections.push(`**🚀 本机任务** (${running.length} 运行中 / ${data.runningTasks.length} 总计)`);
  if (data.runningTasks.length === 0) {
    sections.push('_暂无委派任务。用 `@cc <任务>` 或 `@codex <任务>` 派发一个。_');
  } else {
    const ordered = [...running, ...finished];
    sections.push(ordered.map((t) => renderRunningTask(t, data.now)).join('\n\n'));
  }

  // ── Resumable native sessions ─────────────────────────────────────
  sections.push('---');
  if (data.discovering) {
    sections.push('**🗂️ 可续接的历史会话**\n_正在查询本机 CLI 的会话…_');
  } else {
    sections.push(`**🗂️ 可续接的历史会话** (${data.discovered.length})`);
    if (data.discovered.length === 0) {
      sections.push('_未发现历史会话。_');
    } else {
      sections.push(
        data.discovered.map((s) => renderDiscovered(s, data.now)).join('\n\n'),
      );
    }
    if (data.discoverErrors?.length) {
      sections.push(`> ⚠️ ${data.discoverErrors.join('；')}`);
    }
  }

  return sections.join('\n\n');
}

/**
 * Build the full CardKit 2.0 dashboard card. `streaming` toggles the loading
 * spinner config while discovery is in flight.
 */
export function buildSessionsCard(data: SessionsCardData): Record<string, unknown> {
  const body = buildSessionsCardMarkdown(data);
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: {
        content: `本机 Agent 会话：${data.runningTasks.filter((t) => t.status === 'running').length} 运行中`,
      },
    },
    header: {
      title: { tag: 'plain_text', content: '本机 Agent 会话' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: SESSIONS_CARD_ELEMENT_ID,
          content: body,
          text_align: 'left',
          text_size: 'normal_v2',
        },
      ],
    },
  };
}
