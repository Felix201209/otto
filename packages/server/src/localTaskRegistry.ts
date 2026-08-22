/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export type LocalTaskKind = 'workflow' | 'rpa' | 'proactive' | 'runtime' | 'feishu';
export type LocalTaskCancelReason = 'desktop_hidden' | 'server_shutdown';

export interface LocalTaskAuditEvent {
  taskId: string;
  kind: LocalTaskKind;
  reason: LocalTaskCancelReason;
  outcome: 'cancelled' | 'preserved' | 'failed';
  error?: string;
}

export interface LocalTaskDefinition {
  id: string;
  kind: LocalTaskKind;
  cancel(reason: LocalTaskCancelReason): void | Promise<void>;
  resume?(): void | Promise<void>;
  /** Only trusted background transports such as Feishu may use this exception. */
  desktopSuspendPolicy?: 'cancel' | 'preserve';
}

interface LocalTaskRegistryOptions {
  audit?: (event: LocalTaskAuditEvent) => void | Promise<void>;
}

/**
 * Owns process-level local task cancellation.  A suspended registry also
 * cancels tasks registered during the close/reconnect race before they run on.
 */
export class LocalTaskRegistry {
  private readonly tasks = new Map<string, LocalTaskDefinition>();
  private readonly cancelled = new Set<string>();
  private readonly preservedAudited = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private suspendedReason?: LocalTaskCancelReason;
  private resumePromise?: Promise<void>;

  constructor(private readonly options: LocalTaskRegistryOptions = {}) {}

  register(task: LocalTaskDefinition): () => void {
    if (!task.id.trim()) throw new Error('Local task id is required.');
    if (this.tasks.has(task.id)) {
      throw new Error(`Local task is already registered: ${task.id}`);
    }
    this.tasks.set(task.id, task);
    if (this.suspendedReason) this.cancelOrPreserve(task, this.suspendedReason, false);
    return () => {
      if (this.tasks.get(task.id) !== task) return;
      this.tasks.delete(task.id);
      this.cancelled.delete(task.id);
      this.preservedAudited.delete(task.id);
    };
  }

  isSuspended(): boolean {
    return this.suspendedReason !== undefined;
  }

  async cancelAll(
    reason: LocalTaskCancelReason,
    options: { includePreserved?: boolean } = {},
  ): Promise<void> {
    this.suspendedReason = reason;
    for (const task of this.tasks.values()) {
      this.cancelOrPreserve(task, reason, options.includePreserved === true);
    }
    await this.waitForInFlight();
  }

  async resumeAll(): Promise<void> {
    if (!this.suspendedReason) return;
    if (this.resumePromise) return this.resumePromise;
    const operation = this.performResume();
    this.resumePromise = operation;
    try {
      await operation;
    } finally {
      if (this.resumePromise === operation) this.resumePromise = undefined;
    }
  }

  private async performResume(): Promise<void> {
    await this.waitForInFlight();
    const resumable = [...this.cancelled]
      .map((id) => this.tasks.get(id))
      .filter((task): task is LocalTaskDefinition => Boolean(task?.resume));
    this.suspendedReason = undefined;
    this.cancelled.clear();
    this.preservedAudited.clear();
    await Promise.allSettled(resumable.map((task) => task.resume!()));
  }

  private cancelOrPreserve(
    task: LocalTaskDefinition,
    reason: LocalTaskCancelReason,
    includePreserved: boolean,
  ): void {
    const preserved =
      task.desktopSuspendPolicy === 'preserve' &&
      reason === 'desktop_hidden' &&
      !includePreserved;
    if (preserved) {
      if (!this.preservedAudited.has(task.id)) {
        this.preservedAudited.add(task.id);
        this.audit({ taskId: task.id, kind: task.kind, reason, outcome: 'preserved' });
      }
      return;
    }
    if (this.cancelled.has(task.id)) return;
    this.cancelled.add(task.id);
    let operation: Promise<void>;
    try {
      operation = Promise.resolve(task.cancel(reason));
    } catch (error) {
      operation = Promise.reject(error);
    }
    const tracked = operation.then(
      () => this.audit({ taskId: task.id, kind: task.kind, reason, outcome: 'cancelled' }),
      (error) => this.audit({
        taskId: task.id,
        kind: task.kind,
        reason,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    ).then(() => undefined);
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
  }

  private async waitForInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private audit(event: LocalTaskAuditEvent): Promise<void> {
    return Promise.resolve(this.options.audit?.(event)).catch(() => undefined);
  }
}
