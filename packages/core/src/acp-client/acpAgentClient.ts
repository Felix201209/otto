/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Otto as an ACP *client* (orchestrator): spawns an external ACP-speaking
 * coding agent (e.g. Claude Code via the `claude-code-acp` bridge) over stdio,
 * runs a single delegated task, streams its progress back through an `onUpdate`
 * callback, and returns the agent's final answer.
 *
 * This is the mirror image of the existing ACP *server* in
 * `packages/cli/src/acp/` (where Otto is spawned by acpx/OpenClaw). The two
 * directions share no code: here we own a {@link acp.ClientSideConnection} and
 * implement the {@link acp.Client} side (permission + session updates + fs
 * proxy), driving the remote agent's {@link acp.Agent} methods.
 *
 * The spawn/stream/timeout/abort/kill plumbing mirrors {@link LarkCliTool}.
 */

import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type ExternalAgentType,
  resolveExternalAgentSpec,
} from './externalAgentRegistry.js';

/** Throttle interval for pushing live output to the UI/card. */
const OUTPUT_UPDATE_INTERVAL_MS = 500;

/**
 * Default ceiling for a single delegated task. Coding tasks can legitimately
 * run for many minutes, so we allow a generous window and rely on the caller's
 * AbortSignal for normal cancellation.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How often to push a liveness heartbeat while the agent is starting up or
 * working but quiet. Without this the card looks frozen during the (potentially
 * long) `npx` cold-download + model first-token gap.
 */
const HEARTBEAT_INTERVAL_MS = 10 * 1000;

/**
 * If the agent produces NO session activity for this long after we send the
 * prompt, treat the turn as stalled and fail fast with actionable guidance
 * instead of silently waiting out the full {@link DEFAULT_TIMEOUT_MS}. The
 * common stall is an unauthenticated / first-run / offline bridge that emits
 * `available_commands_update` and then goes silent forever.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

export interface RunTaskOptions {
  /** Which external agent to drive. */
  agentType: ExternalAgentType;
  /** The full instruction handed to the external agent. */
  task: string;
  /** Working directory for the delegated session. Must be an absolute path. */
  cwd: string;
  /**
   * Resume an existing native session instead of starting a fresh one. When
   * set, the client calls ACP `session/load` with this id (the bridge replays
   * prior history via session updates) and then sends `task` as the next
   * prompt. Both the Claude Code bridge and the Codex adapter advertise the
   * `loadSession` capability. If `session/load` fails, the run falls back to a
   * fresh `session/new` so the task still goes through.
   */
  resumeSessionId?: string;
  /** Cancellation signal — aborting cancels the remote turn and kills the child. */
  signal: AbortSignal;
  /**
   * Receives the cumulative transcript (NOT deltas) as it grows, matching the
   * `updateOutput` contract used by tools and the Feishu card streamer.
   */
  onUpdate?: (output: string) => void;
  /**
   * Receives structured progress (current tool, plan, token usage) as the
   * remote agent works. Used by the background task store and Feishu dashboard
   * card to render rich, queryable state instead of a flat transcript blob.
   */
  onProgress?: (progress: DelegateProgress) => void;
  /** Auto-approve all permission requests. Defaults to true (headless). */
  autoApprove?: boolean;
  /** Override the watchdog timeout in ms. */
  timeoutMs?: number;
  /**
   * Override the "no activity" idle watchdog in ms. After the prompt is sent,
   * if no session update arrives within this window the task is reported as
   * failed with startup/login guidance. Defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}.
   */
  idleTimeoutMs?: number;
  /** Environment used to resolve the spawn command (injectable for tests). */
  env?: NodeJS.ProcessEnv;
  /** Directly override the launch command (used by tests). */
  launchOverride?: { command: string; args: string[]; env?: Record<string, string> };
  /**
   * Spawn through a shell. Defaults to true on Windows (so `npx` resolves to
   * `npx.cmd`). Tests that launch a direct binary should pass `false`.
   */
  shell?: boolean;
}

export type DelegateStatus = 'success' | 'failed' | 'cancelled' | 'timed_out';

/** One entry of the remote agent's execution plan / TODO list. */
export interface DelegatePlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Structured snapshot of a delegated turn's progress, distilled from the ACP
 * session updates. Unlike the transcript (a growing string), this is a small,
 * queryable shape suitable for persistence and rich UI (the Feishu dashboard
 * card). All fields are cumulative for the current turn.
 */
export interface DelegateProgress {
  /** Title of the tool call currently in flight, if any. */
  currentTool?: string;
  /** Number of tool calls started so far this turn. */
  toolCallCount: number;
  /** Latest execution plan reported by the agent, if any. */
  plan?: DelegatePlanEntry[];
  /** Context tokens used, from the latest `usage_update`. */
  tokenUsed?: number;
  /** Context window size, from the latest `usage_update`. */
  tokenSize?: number;
  /** Epoch ms of the last session activity of any kind. */
  lastActivityAt: number;
}

export interface DelegateResult {
  status: DelegateStatus;
  /** Human-readable label of the agent that ran (e.g. "Claude Code"). */
  label: string;
  /** The external agent's final assistant text. */
  answer: string;
  /** Full interleaved transcript (tool calls + assistant text). */
  transcript: string;
  /**
   * The native session id used for this run — a fresh id from `session/new`,
   * or the resumed id when {@link RunTaskOptions.resumeSessionId} was set.
   * Persist this to enable later resume.
   */
  sessionId?: string;
  /** Final structured progress snapshot for the turn. */
  progress?: DelegateProgress;
  /** ACP stop reason, when the turn completed normally. */
  stopReason?: acp.StopReason;
  /** Populated for failed/timed_out/cancelled outcomes. */
  error?: string;
}

/** Extract plain text from an ACP content block, if any. */
function textOfContent(content: acp.ContentBlock): string {
  if (content && typeof content === 'object' && 'type' in content) {
    if (content.type === 'text' && typeof content.text === 'string') {
      return content.text;
    }
  }
  return '';
}

/** Map ACP ToolKind to a compact emoji + label for the transcript. */
const TOOL_KIND_DISPLAY: Record<string, string> = {
  read: '📖',
  edit: '✏️',
  delete: '🗑️',
  move: '📦',
  search: '🔍',
  execute: '⚡',
  think: '💭',
  fetch: '🌐',
  switch_mode: '🔄',
  other: '🔧',
};

function kindIcon(kind?: string): string {
  return TOOL_KIND_DISPLAY[kind ?? 'other'] ?? '🔧';
}

/** Format a ToolCallLocation as a compact "path:line" string. */
function fmtLocation(loc: acp.ToolCallLocation): string {
  return loc.line ? `${loc.path}:${loc.line}` : loc.path;
}

/** Format ToolCallContent items into readable text (truncated). */
function fmtToolCallContent(items: acp.ToolCallContent[], maxLen = 500): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === 'content') {
      const t = textOfContent(item.content);
      if (t) {
        parts.push(t.length > maxLen ? t.slice(0, maxLen) + '…' : t);
      }
    } else if (item.type === 'diff') {
      const diffLabel = item.oldText ? `Edit ${item.path}` : `Write ${item.path}`;
      const preview = item.newText.slice(0, maxLen);
      parts.push(`${diffLabel}\n${preview}${item.newText.length > maxLen ? '…' : ''}`);
    } else if (item.type === 'terminal') {
      // Terminal content is streamed separately via tool_call_update _meta.
      parts.push('[terminal output]');
    }
  }
  return parts.join('\n');
}

/** Pick the most permissive "allow" option from a permission request. */
function pickAllowOption(
  options: acp.PermissionOption[],
): acp.PermissionOption | undefined {
  return (
    options.find((o) => o.kind === 'allow_always') ??
    options.find((o) => o.kind === 'allow_once') ??
    // Fall back to the first non-reject option if kinds are unexpected.
    options.find((o) => o.kind !== 'reject_once' && o.kind !== 'reject_always')
  );
}

/**
 * The {@link acp.Client} half of the connection: handles agent-initiated
 * requests (permissions, file IO) and streams session updates outward.
 */
class DelegateClient implements acp.Client {
  /** The agent's final assistant text (concatenated message chunks). */
  answer = '';
  /** Interleaved transcript of tool calls + assistant text for live display. */
  transcript = '';
  /**
   * Soft cap on the transcript length. When exceeded, older content is
   * pruned to keep memory bounded during long-running tasks. The cap is
   * deliberately generous so the UI still shows rich context, but prevents
   * unbounded growth from multi-hour sessions.
   */
  static readonly TRANSCRIPT_SOFT_CAP = 100_000;
  /** Marker inserted when old transcript content is pruned. */
  static readonly PRUNE_MARKER = '\n…[earlier output pruned]…\n';
  /**
   * Timestamp (ms) of the last session activity of ANY kind. Used by the idle
   * watchdog to distinguish "working quietly" from "stalled forever".
   */
  lastActivityAt = Date.now();

  /** Structured, queryable progress for the current turn (Tier 2 / dashboard). */
  progress: DelegateProgress = { toolCallCount: 0, lastActivityAt: Date.now() };

  private lastFlush = 0;
  private lastProgressFlush = 0;

  constructor(
    private readonly opts: {
      autoApprove: boolean;
      cwd: string;
      onUpdate?: (output: string) => void;
      onProgress?: (progress: DelegateProgress) => void;
    },
  ) {}

  /** Record that the agent did something — resets the idle watchdog. */
  private markActivity(): void {
    this.lastActivityAt = Date.now();
    this.progress.lastActivityAt = this.lastActivityAt;
  }

  /** Push the structured progress snapshot to the caller, throttled. */
  private flushProgress(force = false): void {
    const { onProgress } = this.opts;
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - this.lastProgressFlush < OUTPUT_UPDATE_INTERVAL_MS) return;
    this.lastProgressFlush = now;
    onProgress({ ...this.progress, plan: this.progress.plan ? [...this.progress.plan] : undefined });
  }

  /** Push the cumulative transcript to the caller, throttled. */
  flush(force = false): void {
    const { onUpdate } = this.opts;
    if (!onUpdate) return;

    // Prune old transcript content if it exceeds the soft cap.
    if (this.transcript.length > DelegateClient.TRANSCRIPT_SOFT_CAP) {
      const pruneTo = Math.floor(DelegateClient.TRANSCRIPT_SOFT_CAP * 0.7);
      this.transcript =
        DelegateClient.PRUNE_MARKER +
        this.transcript.slice(this.transcript.length - pruneTo);
    }

    const now = Date.now();
    if (!force && now - this.lastFlush < OUTPUT_UPDATE_INTERVAL_MS) return;
    this.lastFlush = now;
    onUpdate(this.transcript);
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    this.markActivity();
    if (!this.opts.autoApprove) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const option = pickAllowOption(params.options);
    if (!option) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const title = params.toolCall?.title ?? 'tool call';
    this.transcript += `\n✅ ${title}\n`;
    this.flush();
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.markActivity();
    const u = params.update;
    switch (u.sessionUpdate) {
      // ── Model text output ──────────────────────────────────────
      case 'agent_message_chunk': {
        const t = textOfContent(u.content);
        if (t) {
          this.answer += t;
          this.transcript += t;
          this.flush();
        }
        break;
      }

      // ── Model thinking/reasoning ───────────────────────────────
      case 'agent_thought_chunk': {
        const t = textOfContent(u.content);
        if (t) {
          this.transcript += t;
          this.flush();
        }
        break;
      }

      // ── Tool call started ──────────────────────────────────────
      case 'tool_call': {
        const icon = kindIcon(u.kind);
        let line = `\n${icon} ${u.title}`;
        if (u.locations?.length) {
          line += `  (${u.locations.map(fmtLocation).join(', ')})`;
        }
        this.transcript += line + '\n';
        // Show any initial content (e.g. command preview, diff).
        if (u.content?.length) {
          const detail = fmtToolCallContent(u.content);
          if (detail) {
            this.transcript += `${detail}\n`;
          }
        }
        // Structured progress: track the in-flight tool + a running count.
        this.progress.currentTool = u.title ?? this.progress.currentTool;
        this.progress.toolCallCount += 1;
        this.flush();
        this.flushProgress();
        break;
      }

      // ── Tool call progress / completion ────────────────────────
      case 'tool_call_update': {
        const title = u.title;
        const status = u.status;
        if (status === 'completed') {
          const label = title ?? 'tool';
          let detail = '';
          if (u.content?.length) {
            const formatted = fmtToolCallContent(u.content);
            if (formatted) detail = `\n${formatted}`;
          }
          this.transcript += `✅ ${label}${detail}\n`;
          this.flush();
        } else if (status === 'in_progress') {
          // In-progress updates with content (e.g. streaming terminal output).
          if (u.content?.length) {
            const formatted = fmtToolCallContent(u.content);
            if (formatted) {
              this.transcript += `  ${formatted}\n`;
              this.flush();
            }
          }
        } else if (status === 'failed') {
          this.transcript += `\n⚠️ ${title ?? 'tool'} failed\n`;
          this.flush();
        }
        // status === 'pending' → no-op (already shown in tool_call).
        break;
      }

      // ── Execution plan / TODO list ─────────────────────────────
      case 'plan': {
        const entries = (u.entries ?? [])
          .map((e) => {
            const statusIcon =
              e.status === 'completed' ? '✅' :
              e.status === 'in_progress' ? '⏳' : '⬜';
            return `  ${statusIcon} ${e.content}`;
          })
          .join('\n');
        if (entries) {
          this.transcript += `\n📋 Plan:\n${entries}\n`;
          this.flush();
        }
        // Structured progress: keep the latest plan for the dashboard card.
        this.progress.plan = (u.entries ?? []).map((e) => ({
          content: e.content,
          status:
            e.status === 'completed' || e.status === 'in_progress'
              ? e.status
              : 'pending',
        }));
        this.flushProgress();
        break;
      }

      // ── Usage / token consumption ──────────────────────────────
      case 'usage_update': {
        const pct = u.size > 0 ? Math.round((u.used / u.size) * 100) : 0;
        this.transcript += `📊 Context: ${u.used}/${u.size} tokens (${pct}%)\n`;
        this.progress.tokenUsed = u.used;
        this.progress.tokenSize = u.size;
        this.flush();
        this.flushProgress();
        break;
      }

      // ── Mode / config / commands updates (lightweight) ─────────
      case 'current_mode_update': {
        this.transcript += `🔄 Mode: ${u.currentModeId}\n`;
        this.flush();
        break;
      }

      case 'available_commands_update': {
        // Only log command names; skip verbose details.
        const names = (u.availableCommands ?? []).map((c: acp.AvailableCommand) => c.name).join(', ');
        if (names) {
          this.transcript += `💡 Commands: ${names}\n`;
          this.flush();
        }
        break;
      }

      case 'config_option_update': {
        // Lightweight — just note it happened.
        break;
      }

      case 'session_info_update': {
        // Lightweight — just note it happened.
        break;
      }

      default:
        // Future sessionUpdate types: ignore gracefully.
        break;
    }
  }

  async readTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    let content = await fs.readFile(params.path, 'utf8');
    // Honor optional line windowing if requested.
    if (
      (params.line != null && params.line > 1) ||
      (params.limit != null && params.limit >= 0)
    ) {
      const lines = content.split('\n');
      const start = params.line != null ? Math.max(0, params.line - 1) : 0;
      const end =
        params.limit != null ? start + params.limit : lines.length;
      content = lines.slice(start, end).join('\n');
    }
    return { content };
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    await fs.mkdir(path.dirname(params.path), { recursive: true });
    await fs.writeFile(params.path, params.content, 'utf8');
    return {};
  }
}

function killChildProcess(child: ChildProcess): void {
  if (child.killed) return;
  try {
    if (os.platform() === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // best effort
  }
}

/**
 * Run a single task on an external ACP agent and return its final result.
 *
 * Never rejects for operational failures (spawn errors, timeouts, cancellation,
 * remote errors) — those are reported via {@link DelegateResult.status} so
 * callers (tools) can surface a readable message instead of crashing the turn.
 */
export async function runDelegatedTask(
  opts: RunTaskOptions,
): Promise<DelegateResult> {
  const { agentType, task, cwd, signal } = opts;
  const autoApprove = opts.autoApprove ?? true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  const baseSpec = resolveExternalAgentSpec(agentType, opts.env);
  const label = baseSpec.label;
  const command = opts.launchOverride?.command ?? baseSpec.command;
  const args = opts.launchOverride?.args ?? [...baseSpec.args];
  const extraEnv = opts.launchOverride?.env ?? baseSpec.env;

  if (signal.aborted) {
    return {
      status: 'cancelled',
      label,
      answer: '',
      transcript: '',
      error: 'Delegation cancelled before start.',
    };
  }

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
      // npx on Windows resolves to npx.cmd, which requires a shell.
      shell: opts.shell ?? os.platform() === 'win32',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: 'failed',
      label,
      answer: '',
      transcript: '',
      error: launchGuidance(msg, command, label),
    };
  }

  if (!child.stdin || !child.stdout) {
    killChildProcess(child);
    return {
      status: 'failed',
      label,
      answer: '',
      transcript: '',
      error: `Failed to open stdio pipes for ${label}.`,
    };
  }

  let stderrBuf = '';
  child.stderr?.on('data', (b: Buffer) => {
    // Cap to avoid unbounded growth on a chatty agent.
    if (stderrBuf.length < 16_384) stderrBuf += b.toString('utf8');
  });
  // Swallow EPIPE etc. on the write side when the child has already died, so a
  // dead bridge surfaces as a clean failed result instead of an unhandled error.
  child.stdin.on('error', () => undefined);

  let launchError: string | undefined;
  const childExited = new Promise<void>((resolve) => {
    child.on('error', (err: Error) => {
      launchError = err.message;
      resolve();
    });
    child.on('exit', () => resolve());
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );

  const handler = new DelegateClient({
    autoApprove,
    cwd,
    onUpdate: opts.onUpdate,
    onProgress: opts.onProgress,
  });
  const connection = new acp.ClientSideConnection(() => handler, stream);

  let settled = false;
  let timedOut = false;
  let stalled = false;
  let aborted = false;
  let sessionId: string | undefined;
  let promptSentAt = 0;
  // Human-readable startup phase, shown in heartbeats until real output streams.
  let phase = `正在启动本机 ${label}（首次运行需下载依赖，请稍候）…`;
  const startedAt = Date.now();

  // Emit an immediate status so the UI/card shows life before the (potentially
  // slow) npx cold-download + model first-token gap. Without this, a healthy but
  // slow startup is indistinguishable from a hang.
  opts.onUpdate?.(`🚀 ${phase}`);

  // Liveness heartbeat: while the transcript is still empty (or quiet) push an
  // elapsed-time line plus the tail of the child's stderr (npm/npx download
  // progress lands here), so the card never looks frozen.
  const heartbeat = setInterval(() => {
    if (settled || !opts.onUpdate) return;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (handler.transcript.trim()) {
      opts.onUpdate(`${handler.transcript}\n\n⏳ ${label} 运行中 … ${elapsed}s`);
      return;
    }
    const tail = stderrBuf.trim().split('\n').slice(-3).join('\n');
    opts.onUpdate(
      `🚀 ${phase} ${elapsed}s` + (tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''),
    );
  }, HEARTBEAT_INTERVAL_MS);

  const timeout = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    killChildProcess(child);
  }, timeoutMs);

  // Idle watchdog: once the prompt is in flight, fail fast if the agent goes
  // completely silent. Catches the unauthenticated / first-run / offline bridge
  // that emits one update and then hangs forever, instead of waiting out the
  // full task timeout.
  const idleWatch = setInterval(() => {
    if (settled || promptSentAt === 0) return;
    const sinceActivity = Date.now() - handler.lastActivityAt;
    const sincePrompt = Date.now() - promptSentAt;
    if (sinceActivity >= idleTimeoutMs && sincePrompt >= idleTimeoutMs) {
      stalled = true;
      killChildProcess(child);
    }
  }, Math.min(HEARTBEAT_INTERVAL_MS, Math.max(1000, Math.floor(idleTimeoutMs / 4))));

  const onAbort = () => {
    if (settled) return;
    aborted = true;
    if (sessionId) {
      connection.cancel({ sessionId }).catch(() => undefined);
    }
    killChildProcess(child);
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const finish = (result: DelegateResult): DelegateResult => {
    settled = true;
    clearTimeout(timeout);
    clearInterval(heartbeat);
    clearInterval(idleWatch);
    signal.removeEventListener('abort', onAbort);
    handler.flush(true);
    killChildProcess(child);
    // Stamp the resolved native session id + final structured progress onto
    // every outcome so callers can persist/resume and render rich status.
    return {
      ...result,
      sessionId: result.sessionId ?? sessionId,
      progress: result.progress ?? { ...handler.progress },
    };
  };

  // Drive the whole turn as one unit so a child that dies/never starts at ANY
  // stage (initialize / newSession|loadSession / prompt) is caught by the
  // childExited race rather than hanging on an unanswered request.
  const turn = (async () => {
    const init = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });

    // Resume an existing native session when asked (and the bridge supports
    // it), otherwise start fresh. session/load replays prior history via
    // session updates, so the resumed turn keeps full context.
    const canResume = Boolean(init.agentCapabilities?.loadSession);
    if (opts.resumeSessionId && canResume) {
      phase = `已连接 ${label}，正在恢复会话 ${opts.resumeSessionId.slice(0, 8)}…`;
      try {
        await connection.loadSession({
          sessionId: opts.resumeSessionId,
          cwd,
          mcpServers: [],
        });
        sessionId = opts.resumeSessionId;
      } catch {
        // Resume failed (stale id, bridge quirk) — fall back to a fresh
        // session so the task still runs rather than hard-failing.
        sessionId = undefined;
      }
    }

    if (!sessionId) {
      phase = `已连接 ${label}，正在创建会话…`;
      const session = await connection.newSession({ cwd, mcpServers: [] });
      sessionId = session.sessionId;
    }

    phase = `已连接 ${label}，等待响应…`;
    handler.lastActivityAt = Date.now();
    promptSentAt = Date.now();

    return connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: task }],
    });
  })();

  try {
    const response = await Promise.race([
      turn,
      childExited.then((): never => {
        throw new Error(
          launchError ??
            `${label} process exited before completing the task.${
              stderrBuf.trim() ? `\n${stderrBuf.trim()}` : ''
            }`,
        );
      }),
    ]);

    const stopReason = response.stopReason;
    const status: DelegateStatus =
      aborted || stopReason === 'cancelled' ? 'cancelled' : 'success';
    return finish({
      status,
      label,
      answer: handler.answer.trim(),
      transcript: handler.transcript.trim(),
      stopReason,
      error:
        status === 'cancelled' ? 'Delegated task was cancelled.' : undefined,
    });
  } catch (err) {
    if (stalled) {
      const tail = stderrBuf.trim();
      return finish({
        status: 'timed_out',
        label,
        answer: handler.answer.trim(),
        transcript: handler.transcript.trim(),
        error:
          `${label} 启动后 ${Math.round(idleTimeoutMs / 1000)} 秒内没有任何响应，已中止。\n` +
          `常见原因：本机 ${label} 未登录（请在终端运行 \`claude /login\`）、` +
          `首次运行依赖仍在下载、或网络无法访问模型服务。` +
          (tail ? `\n\n--- ${label} stderr ---\n${tail}` : ''),
      });
    }
    if (timedOut) {
      return finish({
        status: 'timed_out',
        label,
        answer: handler.answer.trim(),
        transcript: handler.transcript.trim(),
        error: `${label} timed out after ${Math.round(timeoutMs / 60000)} minutes.`,
      });
    }
    if (aborted) {
      return finish({
        status: 'cancelled',
        label,
        answer: handler.answer.trim(),
        transcript: handler.transcript.trim(),
        error: 'Delegated task was cancelled.',
      });
    }
    const raw = launchError ?? (err instanceof Error ? err.message : String(err));
    return finish({
      status: 'failed',
      label,
      answer: handler.answer.trim(),
      transcript: handler.transcript.trim(),
      error: launchGuidance(raw, command, label),
    });
  }
}

/**
 * Turn a raw spawn/runtime error into actionable guidance. The common failure
 * is the bridge not being installed / `npx` unavailable.
 */
function launchGuidance(rawMessage: string, command: string, label: string): string {
  const lower = rawMessage.toLowerCase();
  if (
    lower.includes('enoent') ||
    lower.includes('not found') ||
    lower.includes('command not found') ||
    lower.includes('exited before completing')
  ) {
    return (
      `${rawMessage}\n\n` +
      `Could not launch ${label}. Make sure ${label} is installed and logged in ` +
      `on this machine, and that "${command}" is available on PATH. ` +
      `Otto drives ${label} via the @agentclientprotocol/claude-agent-acp bridge ` +
      `(run on demand with npx); override the command with the ` +
      `EASYCODE_CLAUDE_CODE_ACP_CMD environment variable if needed.`
    );
  }
  return rawMessage;
}
