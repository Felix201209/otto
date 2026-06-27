/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `/acp-session` (alias `/acp-会话`) — the Feishu multi-session dashboard.
 *
 * Sends a CardKit 2.0 card that combines two data sources:
 *   1. Running / recent **delegate tasks** from the in-process background task
 *      store (instant) — with live status while they run.
 *   2. Resumable **native sessions** discovered from each CLI's own history via
 *      ACP `session/list` (filled in asynchronously, since it spawns bridges).
 *
 * The card is updated in place: first an instant snapshot with a "discovering…"
 * placeholder, then a full render once discovery returns, then throttled
 * re-renders while any task is still running (bounded so we never leak the
 * subscription).
 */

import {
  getBackgroundTaskManager,
  listExternalSessions,
  type BackgroundTask,
  type ExternalAgentType,
  type ListExternalSessionsOptions,
  type ListExternalSessionsResult,
} from 'otto-core';
import {
  buildSessionsCard,
  buildSessionsCardMarkdown,
  type DiscoveredSessionView,
  type RunningTaskView,
  type SessionsCardData,
} from './sessionsCard.js';

/** The subset of {@link FeishuGateway} this handler needs (keeps it testable). */
export interface SessionsCardGateway {
  createCardKitCard(card: Record<string, unknown>): Promise<string | null>;
  sendCardKitMessage(
    chatId: string,
    cardId: string,
    replyToMessageId?: string,
  ): Promise<string | null>;
  updateCardKitCard(
    cardId: string,
    card: Record<string, unknown>,
    sequence: number,
  ): Promise<boolean>;
  sendMessage(
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<unknown>;
}

export interface HandleSessionsOptions {
  gateway: SessionsCardGateway;
  chatId: string;
  replyToMessageId?: string;
  /** Bound project cwd — filters native-session discovery to this directory. */
  cwd?: string;
  /** Max number of discovered sessions per agent. Default 8. */
  limit?: number;
  /** Upper bound on live-refresh duration in ms. Default 5 minutes. */
  liveWindowMs?: number;
  /** Discovery function (injectable for tests). Defaults to {@link listExternalSessions}. */
  discover?: (opts: ListExternalSessionsOptions) => Promise<ListExternalSessionsResult>;
  /** Disable the bounded live-refresh subscription (used by tests). */
  disableLiveRefresh?: boolean;
}

const DEFAULT_DISCOVER_LIMIT = 8;
const DEFAULT_LIVE_WINDOW_MS = 5 * 60 * 1000;
const LIVE_REFRESH_THROTTLE_MS = 1500;
const DISCOVER_AGENTS: ExternalAgentType[] = ['claude-code', 'codex'];

/** Map a stored background task to the card's running-task view shape. */
export function taskToRunningView(task: BackgroundTask): RunningTaskView {
  const agentLabel = task.kind === 'codex' ? 'Codex' : 'Claude Code';
  // Strip a leading "[Label] " prefix from the command for a cleaner title.
  const title = task.command.replace(/^\[[^\]]+\]\s*/, '').slice(0, 100) || '(无描述)';
  const planTotal = task.plan?.length;
  const planDone = task.plan?.filter((p) => p.status === 'completed').length;
  return {
    id: task.id,
    agentLabel,
    title,
    status: task.status,
    currentTool: task.currentTool,
    toolCallCount: task.toolCallCount,
    planDone,
    planTotal,
    tokenUsed: task.tokenUsed,
    tokenSize: task.tokenSize,
    startTime: task.startTime,
    endTime: task.endTime,
    sessionId: task.sessionId,
    restoredFromDisk: task.restoredFromDisk,
  };
}

/** Collect the current delegate tasks (newest first), excluding plain shell tasks. */
function collectRunningTasks(): RunningTaskView[] {
  const all = getBackgroundTaskManager()
    .getAllTasks()
    .filter((t) => t.kind === 'claude-code' || t.kind === 'codex');
  all.sort((a, b) => {
    // Running first, then by start time desc.
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return b.startTime - a.startTime;
  });
  return all.map(taskToRunningView);
}

/**
 * Handle the `/acp-session` command: send the dashboard card and keep it fresh.
 * Resolves once the card has been sent (discovery + live refresh continue in
 * the background). Never throws — falls back to a plain text message on error.
 */
export async function handleSessionsCommand(
  opts: HandleSessionsOptions,
): Promise<void> {
  const { gateway, chatId, replyToMessageId } = opts;
  const limit = opts.limit ?? DEFAULT_DISCOVER_LIMIT;
  const liveWindowMs = opts.liveWindowMs ?? DEFAULT_LIVE_WINDOW_MS;
  const discover = opts.discover ?? listExternalSessions;

  const initial: SessionsCardData = {
    runningTasks: collectRunningTasks(),
    discovered: [],
    discovering: true,
    now: Date.now(),
  };

  // 1. Send the instant snapshot.
  const cardId = await gateway.createCardKitCard(buildSessionsCard(initial));
  if (!cardId) {
    // CardKit unavailable — degrade to a plain markdown message.
    await gateway.sendMessage(
      chatId,
      buildSessionsCardMarkdown({ ...initial, discovering: false }),
      replyToMessageId,
    );
    return;
  }
  await gateway.sendCardKitMessage(chatId, cardId, replyToMessageId);

  let sequence = 1;
  let discovered: DiscoveredSessionView[] = [];
  const discoverErrors: string[] = [];

  const render = async (discovering: boolean): Promise<void> => {
    const data: SessionsCardData = {
      runningTasks: collectRunningTasks(),
      discovered,
      discovering,
      discoverErrors: discoverErrors.length ? discoverErrors : undefined,
      now: Date.now(),
    };
    try {
      await gateway.updateCardKitCard(cardId, buildSessionsCard(data), sequence++);
    } catch {
      // best effort — a dropped update just means a slightly stale card
    }
  };

  // 2. Discover native sessions from both CLIs in parallel, then re-render.
  const results = await Promise.all(
    DISCOVER_AGENTS.map((agent) =>
      discover({ agent, cwd: opts.cwd, limit }).catch((e) => ({
        agent,
        agentLabel: agent,
        supported: false,
        sessions: [],
        error: e instanceof Error ? e.message : String(e),
      })),
    ),
  );
  for (const r of results) {
    for (const s of r.sessions) {
      discovered.push({
        agent: s.agent as DiscoveredSessionView['agent'],
        agentLabel: s.agentLabel,
        sessionId: s.sessionId,
        title: s.title,
        cwd: s.cwd,
        updatedAt: s.updatedAt,
      });
    }
    if (!r.supported && r.error) {
      discoverErrors.push(`${r.agentLabel}: ${shortError(r.error)}`);
    }
  }
  discovered = discovered.sort((a, b) => ageMs(b.updatedAt) - ageMs(a.updatedAt));
  await render(false);

  // 3. Bounded live refresh while any delegate task is still running.
  if (opts.disableLiveRefresh) return;
  if (!collectRunningTasks().some((t) => t.status === 'running')) return;
  startLiveRefresh(render, liveWindowMs);
}

/**
 * Subscribe to background-task events and re-render the card (throttled) until
 * no task is running or the live window elapses. Always tears the listener
 * down — no leaked subscriptions.
 */
function startLiveRefresh(
  render: (discovering: boolean) => Promise<void>,
  liveWindowMs: number,
): void {
  const mgr = getBackgroundTaskManager();
  let lastRender = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const stop = (unsub: () => void) => {
    if (stopped) return;
    stopped = true;
    if (pending) clearTimeout(pending);
    unsub();
    void render(false); // final authoritative render
  };

  const unsubscribe = mgr.onTaskEvent(() => {
    if (stopped) return;
    const stillRunning = mgr
      .getAllTasks()
      .some(
        (t) =>
          (t.kind === 'claude-code' || t.kind === 'codex') &&
          t.status === 'running',
      );
    const now = Date.now();
    const sinceLast = now - lastRender;
    if (sinceLast >= LIVE_REFRESH_THROTTLE_MS) {
      lastRender = now;
      void render(false);
    } else if (!pending) {
      pending = setTimeout(() => {
        pending = null;
        lastRender = Date.now();
        void render(false);
      }, LIVE_REFRESH_THROTTLE_MS - sinceLast);
    }
    if (!stillRunning) stop(unsubscribe);
  });

  // Hard upper bound so the subscription can never outlive the window.
  setTimeout(() => stop(unsubscribe), liveWindowMs);
}

function ageMs(updatedAt: string | null): number {
  if (!updatedAt) return 0;
  const t = Date.parse(updatedAt);
  return Number.isNaN(t) ? 0 : t;
}

function shortError(msg: string): string {
  const first = msg.split('\n')[0].trim();
  return first.length > 80 ? first.slice(0, 80) + '…' : first;
}
