/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Config, createWorkingStdio } from 'otto-core';
import { runExitCleanup } from '../utils/cleanup.js';
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import type { LoadedSettings } from '../config/settings.js';
import type { CliArgs } from '../config/config.js';
import { OttoAgent } from './acpRpcDispatcher.js';

/**
 * Redirect all process-wide `console.log/info/warn/debug` output to stderr.
 *
 * ACP speaks JSON-RPC over stdout, so ANY stray `process.stdout.write` from
 * deep inside core or its dependencies (HTTP clients printing "Connecting to
 * ...", compression service debug logs, etc.) corrupts the wire format.
 * Strict clients disconnect on bad frames; lenient ones just pay parser cost.
 *
 * We keep `console.error` untouched because it already goes to stderr.
 *
 * This MUST run before any module that captures `console.log` at import
 * time has been loaded. `runAcpClient` is the earliest ACP-specific entry
 * point in the CLI, called from `gemini.tsx` right after arg parsing, so
 * doing it here is safe.
 */
function redirectConsoleToStderrForAcp(): void {
  const toStderr = (
    prefix: string,
    ...args: unknown[]
  ): void => {
    try {
      const msg = args
        .map((a) =>
          typeof a === 'string' ? a : (() => {
            try { return JSON.stringify(a); } catch { return String(a); }
          })(),
        )
        .join(' ');
      process.stderr.write(`${prefix}${msg}\n`);
    } catch {
      // Swallow — a broken logger must never crash the ACP runtime.
    }
  };

   
  console.log = (...args: unknown[]) => toStderr('', ...args);
   
  console.info = (...args: unknown[]) => toStderr('', ...args);
   
  console.warn = (...args: unknown[]) => toStderr('', ...args);
   
  console.debug = (...args: unknown[]) => toStderr('', ...args);
}

/**
 * Start the ACP agent over stdio.
 *
 * Responsibilities:
 * - Redirect `console.*` to stderr so stray logs don't corrupt JSON-RPC.
 * - Capture the "working" stdout (`createWorkingStdio`) so that ink or other
 *   writers that may monkey-patch `process.stdout.write` can't corrupt the
 *   JSON-RPC frames we send.
 * - Convert the Node streams to Web streams for the ACP SDK.
 * - Create the ndjson frame stream and the {@link acp.AgentSideConnection}.
 * - Block on `connection.closed` until the client disconnects, then run the
 *   normal process cleanup (telemetry flush, tmp dir cleanup, etc.).
 */
/**
 * Keep the Node event loop pinned so the process doesn't exit when stdin
 * naturally drains between ACP turns.
 *
 * Background: OpenClaw / acpx spawn `otto --acp` for every session; the
 * initial handshake + first `session/prompt` completes in a bounded time,
 * and if there are no more pending I/O handles by the time the prompt
 * resolves, Node will happily let the process exit. Once the process is
 * gone, acpx records `SessionAcpIdentity` with empty `agentSessionId` /
 * `backendSessionId` and every subsequent `sessions_send` fails with
 * "ACP metadata is missing".
 *
 * We don't want to rely on stdin keeping the loop alive either: stdin
 * end-of-file (the client closes its write side) should still terminate
 * us eventually, but that is already driven by `connection.closed`. An
 * `unref`'d interval here only holds the loop while stdin is still open
 * — when the underlying stream raises `end` the ACP SDK resolves
 * `connection.closed` and we clear the interval below.
 *
 * The interval body is intentionally empty: we just need a `ref`'d timer
 * handle to prevent premature exit.
 */
function pinEventLoopUntilClosed(): { dispose: () => void } {
  // Heartbeat runs once per minute — cheap enough that it won't show up in
  // profiles, but short enough that the process still exits promptly after
  // the connection closes (we `clearInterval` below).
  const handle = setInterval(() => {
    // no-op — the purpose is to keep libuv alive, not to do work.
  }, 60_000);
  return {
    dispose: () => clearInterval(handle),
  };
}

export async function runAcpClient(
  config: Config,
  settings: LoadedSettings,
  argv: CliArgs,
): Promise<void> {
  redirectConsoleToStderrForAcp();

  const { stdout: workingStdout } = createWorkingStdio();
  const stdout = Writable.toWeb(workingStdout) as WritableStream;
  const stdin = Readable.toWeb(process.stdin) as unknown as ReadableStream<
    Uint8Array
  >;

  const stream = acp.ndJsonStream(stdout, stdin);
  const connection = new acp.AgentSideConnection(
    (conn) => new OttoAgent(config, settings, argv, conn),
    stream,
  );

  // Keep libuv busy so the process survives between `session/prompt` turns
  // (see `pinEventLoopUntilClosed` for the full rationale). Without this,
  // a process that finished its first prompt and has no pending tool
  // execution can be GC'd by Node before the parent (acpx / OpenClaw) has
  // a chance to send a follow-up prompt on the same session.
  const pin = pinEventLoopUntilClosed();

  // Treat SIGTERM / SIGINT as a graceful shutdown request rather than an
  // immediate kill. The parent process (acpx) may send SIGTERM when it
  // decides the session is done; we still want our ongoing prompt turn to
  // flush and the `connection.closed` promise to resolve normally so
  // `runExitCleanup` runs. If the parent wants a hard kill it'll escalate
  // to SIGKILL, which we can't catch anyway.
  const onSignal = (signal: NodeJS.Signals) => {
    process.stderr.write(
      `[acp] received ${signal}, closing connection gracefully\n`,
    );
    // Best-effort: close stdin so the ACP SDK resolves `connection.closed`.
    // If stdin is already closed this is a no-op.
    try {
      process.stdin.pause();
      process.stdin.destroy();
    } catch {
      // ignore — we're tearing down anyway.
    }
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // SIGTERM/SIGINT handlers inside the SDK don't fire when stdin simply
  // closes, so we explicitly await the connection close and then flush
  // exit-time cleanup (telemetry, tmp dir, etc.). `finally()` ensures
  // cleanup runs even if the stream faulted.
  try {
    await connection.closed;
  } finally {
    pin.dispose();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    await runExitCleanup();
  }
}
