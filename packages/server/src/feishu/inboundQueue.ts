/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type FeishuInboundStatus =
  | 'queued'
  | 'running'
  | 'failed'
  | 'completed'
  | 'dead';

export interface FeishuInboundRecord {
  eventId: string;
  chatId: string;
  sessionId: string;
  sessionMessageId: string;
  replyToMessageId: string | null;
  status: FeishuInboundStatus;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
  nextAttemptAtMs: number | null;
  completedAtMs: number | null;
  lastError: string | null;
}

interface FeishuInboundQueueFile {
  version: 1;
  records: FeishuInboundRecord[];
}

export interface FeishuInboundQueueSummary {
  queued: number;
  running: number;
  failed: number;
  dead: number;
  lastError: string | null;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 5_000;

function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 5_000 * 2 ** Math.min(attempts, 10));
}

function safeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n\t]+/gu, ' ').slice(0, 500);
}

/**
 * Small durable inbox for the desktop-hosted Feishu adapter. It stores only
 * routing identifiers and execution state; message text remains in the
 * existing persistent SessionStore and is never duplicated into this file.
 */
export class FeishuInboundQueue {
  private readonly records = new Map<string, FeishuInboundRecord>();

  constructor(private readonly filePath: string | null) {
    this.load();
    this.recoverInterrupted();
  }

  get(eventId: string): FeishuInboundRecord | undefined {
    const record = this.records.get(eventId);
    return record ? { ...record } : undefined;
  }

  enqueue(
    input: Pick<
      FeishuInboundRecord,
      | 'eventId'
      | 'chatId'
      | 'sessionId'
      | 'sessionMessageId'
      | 'replyToMessageId'
    >,
    now = Date.now(),
  ): { record: FeishuInboundRecord; inserted: boolean } {
    const existing = this.records.get(input.eventId);
    if (existing) return { record: { ...existing }, inserted: false };
    const record: FeishuInboundRecord = {
      ...input,
      status: 'queued',
      attempts: 0,
      createdAtMs: now,
      updatedAtMs: now,
      nextAttemptAtMs: null,
      completedAtMs: null,
      lastError: null,
    };
    this.records.set(record.eventId, record);
    this.prune(now);
    this.persist();
    return { record: { ...record }, inserted: true };
  }

  nextDue(now = Date.now()): FeishuInboundRecord | undefined {
    const pending = [...this.records.values()]
      .filter((item) => item.status === 'queued' || item.status === 'failed')
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.eventId.localeCompare(b.eventId));
    const blockedSessions = new Set<string>();
    const due: FeishuInboundRecord[] = [];
    for (const item of pending) {
      if (blockedSessions.has(item.sessionId)) continue;
      blockedSessions.add(item.sessionId);
      if (item.nextAttemptAtMs === null || item.nextAttemptAtMs <= now) due.push(item);
    }
    const record = due[0];
    return record ? { ...record } : undefined;
  }

  nextRetryAt(): number | null {
    const values = [...this.records.values()]
      .filter((item) => item.status === 'failed' && item.nextAttemptAtMs !== null)
      .map((item) => item.nextAttemptAtMs as number);
    return values.length > 0 ? Math.min(...values) : null;
  }

  hasPendingForSession(sessionId: string): boolean {
    return [...this.records.values()].some((item) => (
      item.sessionId === sessionId &&
      (item.status === 'queued' || item.status === 'running' || item.status === 'failed')
    ));
  }

  markRunning(eventId: string, now = Date.now()): FeishuInboundRecord {
    return this.update(eventId, {
      status: 'running',
      updatedAtMs: now,
      nextAttemptAtMs: null,
      lastError: null,
    });
  }

  markCompleted(eventId: string, now = Date.now()): FeishuInboundRecord {
    const result = this.update(eventId, {
      status: 'completed',
      updatedAtMs: now,
      completedAtMs: now,
      nextAttemptAtMs: null,
      lastError: null,
    });
    this.prune(now);
    this.persist();
    return result;
  }

  markFailed(
    eventId: string,
    error: unknown,
    maxAttempts = 8,
    now = Date.now(),
  ): FeishuInboundRecord {
    const current = this.required(eventId);
    const attempts = current.attempts + 1;
    return this.update(eventId, {
      status: attempts >= maxAttempts ? 'dead' : 'failed',
      attempts,
      updatedAtMs: now,
      nextAttemptAtMs: attempts >= maxAttempts ? null : now + retryDelayMs(attempts),
      lastError: safeErrorMessage(error),
    });
  }

  summary(): FeishuInboundQueueSummary {
    const summary: FeishuInboundQueueSummary = {
      queued: 0,
      running: 0,
      failed: 0,
      dead: 0,
      lastError: null,
    };
    const rows = [...this.records.values()]
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    for (const row of rows) {
      if (row.status === 'queued') summary.queued += 1;
      if (row.status === 'running') summary.running += 1;
      if (row.status === 'failed') summary.failed += 1;
      if (row.status === 'dead') summary.dead += 1;
      if (!summary.lastError && row.lastError) summary.lastError = row.lastError;
    }
    return summary;
  }

  private recoverInterrupted(now = Date.now()): void {
    let changed = false;
    for (const record of this.records.values()) {
      if (record.status !== 'running') continue;
      record.status = 'queued';
      record.updatedAtMs = now;
      record.nextAttemptAtMs = null;
      record.lastError = 'Otto restarted before this Feishu task completed';
      changed = true;
    }
    if (changed) this.persist();
  }

  private required(eventId: string): FeishuInboundRecord {
    const record = this.records.get(eventId);
    if (!record) throw new Error(`Feishu inbound event ${eventId} was not found`);
    return record;
  }

  private update(
    eventId: string,
    patch: Partial<FeishuInboundRecord>,
  ): FeishuInboundRecord {
    const record = { ...this.required(eventId), ...patch };
    this.records.set(eventId, record);
    this.persist();
    return { ...record };
  }

  private prune(now: number): void {
    for (const [eventId, record] of this.records) {
      if (
        record.status === 'completed' &&
        record.completedAtMs !== null &&
        now - record.completedAtMs > RETENTION_MS
      ) {
        this.records.delete(eventId);
      }
    }
    if (this.records.size <= MAX_RECORDS) return;
    const removable = [...this.records.values()]
      .filter((item) => item.status === 'completed')
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    while (this.records.size > MAX_RECORDS && removable.length > 0) {
      this.records.delete(removable.shift()!.eventId);
    }
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as FeishuInboundQueueFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return;
      for (const record of parsed.records) {
        if (!record?.eventId || !record.sessionId || !record.sessionMessageId) continue;
        this.records.set(record.eventId, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[feishu] inbound queue load failed: ${safeErrorMessage(error)}`);
      }
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const payload: FeishuInboundQueueFile = {
      version: 1,
      records: [...this.records.values()],
    };
    writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}
