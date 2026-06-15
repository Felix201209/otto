/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Discover the *native* sessions that an external coding CLI (Claude Code,
 * Codex) already has on this machine, so Otto can show "what sessions
 * each CLI has" and offer to resume one.
 *
 * Both the `@agentclientprotocol/claude-agent-acp` bridge and the
 * `@zed-industries/codex-acp` adapter advertise the ACP `loadSession` and
 * `sessionCapabilities.list` capabilities and answer `session/list` directly
 * (verified live — see scripts/probe-acp-caps.mjs). That means we do NOT need
 * to hand-parse `~/.claude/projects/*.jsonl` or `~/.codex/sessions/*` files
 * (the way Paseo does): we spawn the bridge, `initialize`, then call
 * `session/list` over the same ACP connection we already use for delegation.
 *
 * This is a short-lived probe: spawn → initialize → list → kill. It owns a
 * leaner copy of the spawn/stream plumbing in {@link runDelegatedTask}, since
 * it never sends a prompt and must always tear the child down promptly.
 */

import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import {
  type ExternalAgentType,
  resolveExternalAgentSpec,
} from './externalAgentRegistry.js';

/** A single native session reported by an external CLI. */
export interface ExternalSessionDescriptor {
  /** Which external agent owns this session. */
  agent: ExternalAgentType;
  /** Human-readable label for the agent (e.g. "Claude Code"). */
  agentLabel: string;
  /** Provider-native session id — the resume handle. */
  sessionId: string;
  /** Absolute working directory the session ran in. */
  cwd: string;
  /** Session title, if the provider supplies one. */
  title: string | null;
  /** ISO-8601 timestamp of last activity, if known. */
  updatedAt: string | null;
}

export interface ListExternalSessionsOptions {
  /** Which external agent to query. */
  agent: ExternalAgentType;
  /**
   * Restrict to sessions whose cwd matches this absolute path. Passed through
   * to the ACP `session/list` `cwd` filter; also applied client-side as a
   * safety net for bridges that ignore the filter.
   */
  cwd?: string;
  /** Maximum number of sessions to return (most-recent first). Default 20. */
  limit?: number;
  /** Cancellation signal — aborting kills the probe child. */
  signal?: AbortSignal;
  /** Environment used to resolve the spawn command (injectable for tests). */
  env?: NodeJS.ProcessEnv;
  /** Directly override the launch command (used by tests). */
  launchOverride?: { command: string; args: string[]; env?: Record<string, string> };
  /** Spawn through a shell. Defaults to true on Windows (so `npx` resolves). */
  shell?: boolean;
  /** Overall timeout for the probe in ms. Default 60s (npx cold-download). */
  timeoutMs?: number;
}

/** Outcome of a discovery probe — never throws for operational failures. */
export interface ListExternalSessionsResult {
  agent: ExternalAgentType;
  agentLabel: string;
  /** True when the bridge advertised + answered `session/list`. */
  supported: boolean;
  sessions: ExternalSessionDescriptor[];
  /** Populated when the probe failed or the capability is unavailable. */
  error?: string;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_PROBE_TIMEOUT_MS = 60 * 1000;
/** Hard cap on pagination loops, so a misbehaving bridge cannot spin forever. */
const MAX_PAGES = 50;

/** The {@link acp.Client} half of a discovery probe — intentionally inert. */
class ProbeClient implements acp.Client {
  async requestPermission(): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: 'cancelled' } };
  }
  async sessionUpdate(): Promise<void> {
    // Discovery never prompts, so there should be no session updates. Ignore.
  }
  async readTextFile(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    return { content: await fs.readFile(params.path, 'utf8') };
  }
  async writeTextFile(): Promise<acp.WriteTextFileResponse> {
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
 * List the native sessions an external CLI already has on this machine.
 *
 * Never rejects for operational failures (spawn errors, timeouts, missing
 * capability) — those surface via {@link ListExternalSessionsResult.error}
 * and an empty `sessions` array so callers (tools / Feishu cards) can render
 * a clean message.
 */
export async function listExternalSessions(
  opts: ListExternalSessionsOptions,
): Promise<ListExternalSessionsResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const spec = resolveExternalAgentSpec(opts.agent, opts.env);
  const label = spec.label;
  const command = opts.launchOverride?.command ?? spec.command;
  const args = opts.launchOverride?.args ?? [...spec.args];
  const extraEnv = opts.launchOverride?.env ?? spec.env;

  const fail = (error: string, supported = false): ListExternalSessionsResult => ({
    agent: opts.agent,
    agentLabel: label,
    supported,
    sessions: [],
    error,
  });

  if (opts.signal?.aborted) {
    return fail('Session discovery cancelled before start.');
  }

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
      shell: opts.shell ?? os.platform() === 'win32',
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  if (!child.stdin || !child.stdout) {
    killChildProcess(child);
    return fail(`Failed to open stdio pipes for ${label}.`);
  }

  let stderrBuf = '';
  child.stderr?.on('data', (b: Buffer) => {
    if (stderrBuf.length < 8192) stderrBuf += b.toString('utf8');
  });
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
  const connection = new acp.ClientSideConnection(() => new ProbeClient(), stream);

  let settled = false;
  const timeout = setTimeout(() => {
    if (!settled) killChildProcess(child);
  }, timeoutMs);
  const onAbort = () => killChildProcess(child);
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const cleanup = () => {
    settled = true;
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onAbort);
    killChildProcess(child);
  };

  const probe = (async (): Promise<ListExternalSessionsResult> => {
    const init = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });

    const listCap = init.agentCapabilities?.sessionCapabilities?.list;
    if (!listCap) {
      return {
        agent: opts.agent,
        agentLabel: label,
        supported: false,
        sessions: [],
        error: `${label} does not advertise the session/list capability.`,
      };
    }

    const collected: ExternalSessionDescriptor[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const req: acp.ListSessionsRequest = {};
      if (opts.cwd) req.cwd = opts.cwd;
      if (cursor) req.cursor = cursor;
      const res: acp.ListSessionsResponse = await connection.listSessions(req);
      for (const s of res.sessions ?? []) {
        if (opts.cwd && s.cwd && s.cwd !== opts.cwd) continue;
        collected.push({
          agent: opts.agent,
          agentLabel: label,
          sessionId: s.sessionId,
          cwd: s.cwd,
          title: s.title ?? null,
          updatedAt: s.updatedAt ?? null,
        });
      }
      cursor = res.nextCursor ?? null;
      if (!cursor) break;
      if (collected.length >= limit) break;
    }

    collected.sort((a, b) => sortKey(b) - sortKey(a));
    return {
      agent: opts.agent,
      agentLabel: label,
      supported: true,
      sessions: collected.slice(0, limit),
    };
  })();

  try {
    const result = await Promise.race([
      probe,
      childExited.then((): never => {
        throw new Error(
          launchError ??
            `${label} exited before answering session/list.` +
              (stderrBuf.trim() ? `\n${stderrBuf.trim()}` : ''),
        );
      }),
    ]);
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    const raw = launchError ?? (err instanceof Error ? err.message : String(err));
    return fail(raw);
  }
}

/** Sort helper: newer `updatedAt` first; missing timestamps sort last. */
function sortKey(d: ExternalSessionDescriptor): number {
  if (!d.updatedAt) return 0;
  const t = Date.parse(d.updatedAt);
  return Number.isNaN(t) ? 0 : t;
}
