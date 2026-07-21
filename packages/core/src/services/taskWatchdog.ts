/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface TaskWatchdogContext {
  sessionId?: string;
  promptId?: string;
}

export interface TaskStallSnapshot extends TaskWatchdogContext {
  phase: string;
  lastActivityAt: string;
  stalledForMs: number;
}

export interface TaskWatchdogOptions {
  timeoutMs?: number;
  checkIntervalMs?: number;
  now?: () => number;
  onStall(snapshot: TaskStallSnapshot): void | Promise<void>;
}

/**
 * Liveness watchdog that preserves a recovery checkpoint when a task becomes
 * quiet. It deliberately does not kill the model/tool: a long PDF conversion
 * can be legitimately silent, and aborting it would recreate the reported bug.
 */
export class TaskWatchdog {
  private readonly timeoutMs: number;
  private readonly checkIntervalMs: number;
  private readonly now: () => number;
  private readonly onStall: TaskWatchdogOptions['onStall'];
  private timer?: ReturnType<typeof setInterval>;
  private context: TaskWatchdogContext = {};
  private lastActivity = 0;
  private phase = 'starting';
  private stalled = false;

  constructor(options: TaskWatchdogOptions) {
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1_000;
    this.checkIntervalMs =
      options.checkIntervalMs ??
      Math.min(30_000, Math.max(250, this.timeoutMs / 10));
    this.now = options.now ?? Date.now;
    this.onStall = options.onStall;
  }

  start(context: TaskWatchdogContext): void {
    this.stop();
    this.context = context;
    this.lastActivity = this.now();
    this.phase = 'starting';
    this.stalled = false;
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  touch(phase = 'active'): void {
    if (!this.timer) return;
    this.lastActivity = this.now();
    this.phase = phase;
    this.stalled = false;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stalled = false;
  }

  private check(): void {
    if (!this.timer || this.stalled) return;
    const now = this.now();
    const stalledForMs = now - this.lastActivity;
    if (stalledForMs < this.timeoutMs) return;
    this.stalled = true;
    Promise.resolve(
      this.onStall({
        ...this.context,
        phase: this.phase,
        lastActivityAt: new Date(this.lastActivity).toISOString(),
        stalledForMs,
      }),
    ).catch(() => undefined);
  }
}
