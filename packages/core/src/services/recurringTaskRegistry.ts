/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface RecurringTaskDefinition {
  name: string;
  source: string;
  intervalMs: number;
  initialDelayMs?: number;
  estimatedCostUsdPerRun: number;
  getInputVersion: () => string | undefined;
  run: () => void | Promise<void>;
}

export interface RegisteredRecurringTask {
  name: string;
  source: string;
  intervalMs: number;
  estimatedCostUsdPerRun: number;
  paid: boolean;
  inputVersion?: string;
  lastCompletedInputVersion?: string;
  running: boolean;
  stop: () => void;
}

export interface RecurringTaskRegistryOptions {
  /** Paid background work is opt-in. Personal/default installations leave this false. */
  allowPaidBackground?: boolean;
  onError?: (taskName: string, error: unknown) => void;
}

/**
 * The sole scheduler for recurring product work. It uses self-rescheduling
 * timeouts so a slow run cannot overlap with its successor.
 */
export class RecurringTaskRegistry {
  private readonly tasks = new Map<string, RegisteredRecurringTask>();
  private readonly allowPaidBackground: boolean;
  private readonly onError: (taskName: string, error: unknown) => void;

  constructor(options: RecurringTaskRegistryOptions = {}) {
    this.allowPaidBackground = options.allowPaidBackground === true;
    this.onError = options.onError ?? (() => undefined);
  }

  register(definition: RecurringTaskDefinition): (() => void) | undefined {
    if (!definition.name.trim() || !definition.source.trim()) throw new Error('recurring task name and source are required');
    if (!Number.isFinite(definition.intervalMs) || definition.intervalMs <= 0) throw new Error('recurring task interval must be positive');
    if (!Number.isFinite(definition.estimatedCostUsdPerRun) || definition.estimatedCostUsdPerRun < 0) throw new Error('recurring task cost must be non-negative');
    if (this.tasks.has(definition.name)) throw new Error(`recurring task already registered: ${definition.name}`);
    const paid = definition.estimatedCostUsdPerRun > 0;
    if (paid && !this.allowPaidBackground) return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const task: RegisteredRecurringTask = {
      name: definition.name,
      source: definition.source,
      intervalMs: definition.intervalMs,
      estimatedCostUsdPerRun: definition.estimatedCostUsdPerRun,
      paid,
      inputVersion: definition.getInputVersion(),
      running: false,
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        this.tasks.delete(definition.name);
      },
    };
    const schedule = () => {
      timer = setTimeout(() => void tick(), definition.intervalMs);
      timer.unref?.();
    };
    const tick = async () => {
      if (stopped) return;
      const version = definition.getInputVersion();
      task.inputVersion = version;
      if (version === undefined || version === task.lastCompletedInputVersion) {
        schedule();
        return;
      }
      task.running = true;
      try {
        await definition.run();
        task.lastCompletedInputVersion = version;
      } catch (error) {
        this.onError(definition.name, error);
      } finally {
        task.running = false;
        if (!stopped) schedule();
      }
    };
    this.tasks.set(definition.name, task);
    timer = setTimeout(() => void tick(), definition.initialDelayMs ?? definition.intervalMs);
    timer.unref?.();
    return task.stop;
  }

  list(): RegisteredRecurringTask[] {
    return [...this.tasks.values()];
  }

  stopAll(): void {
    for (const task of [...this.tasks.values()]) task.stop();
  }
}

export const recurringTaskRegistry = new RecurringTaskRegistry();
