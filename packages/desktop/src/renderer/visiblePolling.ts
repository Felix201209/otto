/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface PollingVisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface VisiblePollingOptions {
  visibility?: PollingVisibilitySource;
  runImmediately?: boolean;
}

/**
 * Runs a non-overlapping poll only while the renderer is visible.
 *
 * Electron keeps renderer timers alive when a window is hidden. Centralising this
 * guard prevents idle enterprise clients from continuing to hit IPC, PostgreSQL,
 * federation peers, or the local encrypted message store in the background.
 */
export function startVisiblePolling(
  poll: () => void | Promise<void>,
  intervalMs: number,
  options: VisiblePollingOptions = {},
): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('visible polling interval must be a positive finite number');
  }

  const visibility = options.visibility ?? document;
  let stopped = false;
  let running = false;

  const run = async (): Promise<void> => {
    if (stopped || running || visibility.visibilityState !== 'visible') return;
    running = true;
    try {
      await poll();
    } catch {
      // Individual pollers own user-facing error state. The scheduler must stay alive.
    } finally {
      running = false;
    }
  };
  const onVisibilityChange = (): void => {
    if (visibility.visibilityState === 'visible') void run();
  };

  visibility.addEventListener('visibilitychange', onVisibilityChange);
  const timer = window.setInterval(() => void run(), intervalMs);
  if (options.runImmediately !== false) void run();

  return () => {
    stopped = true;
    window.clearInterval(timer);
    visibility.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
