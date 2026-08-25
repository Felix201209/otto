/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Cancellable process boundary used only by desktop/web automation tools.
 */

import { exec, spawn, type ChildProcess } from 'node:child_process';

export interface AutomationProcessOptions {
  command: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBuffer?: number;
  killGraceMs?: number;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    signal.reason === undefined ? 'The operation was aborted' : String(signal.reason),
  );
  error.name = 'AbortError';
  return error;
}

function terminateTree(child: ChildProcess, force: boolean): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      const args = ['/PID', String(child.pid), '/T'];
      if (force) args.push('/F');
      const killer = spawn('taskkill', args, {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.unref();
    } catch {
      // child.kill remains the fallback.
    }
  } else {
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // child.kill remains the fallback.
    }
  }
  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // It may already have exited.
  }
}

export function executeAutomationProcess(
  options: AutomationProcessOptions,
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const killGraceMs = options.killGraceMs ?? 1_000;
  const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal));

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopReason: 'abort' | 'timeout' | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const child = exec(
      options.command,
      {
        maxBuffer,
        timeout: 0,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (settled) return;
        if (stopReason) {
          finishReject(
            stopReason === 'abort' && options.signal
              ? abortError(options.signal)
              : new Error(`Automation process timed out after ${timeoutMs}ms`),
          );
          return;
        }
        if (error) {
          finishReject(error);
          return;
        }
        finishResolve({ stdout, stderr });
      },
    );

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishResolve = (result: { stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const requestStop = (reason: 'abort' | 'timeout'): void => {
      if (settled || stopReason) return;
      stopReason = reason;
      terminateTree(child, false);
      forceTimer = setTimeout(() => terminateTree(child, true), killGraceMs);
      settleTimer = setTimeout(() => {
        finishReject(
          reason === 'abort' && options.signal
            ? abortError(options.signal)
            : new Error(`Automation process timed out after ${timeoutMs}ms`),
        );
      }, killGraceMs + 1_000);
    };
    const onAbort = (): void => requestStop('abort');
    const timeoutTimer = setTimeout(() => requestStop('timeout'), timeoutMs);

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}
