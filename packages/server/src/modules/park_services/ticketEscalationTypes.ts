/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * NSI-11: Park ticket unread-notification escalation queue.
 *
 * A notification job is created when a park ticket produces a notification for
 * a recipient. It is delivered immediately to Otto and Feishu; if the recipient
 * has not acknowledged (read receipt) within five minutes, an SMS is sent as an
 * escalation. The job is durable (persisted), idempotent, retryable, cancellable
 * and reaches a terminal state. Server restart resumes pending timers.
 */

/** Lifecycle state of a persisted escalation notification job. */
export type EscalationJobStatus =
  | 'queued' // 已入队，待立即投递
  | 'delivering' // Otto/飞书投递中
  | 'delivered' // Otto/飞书已投递，等待已读回执或超时
  | 'escalating' // 5 分钟未读，短信升级投递中
  | 'resolved' // 已读回执收到或任务完成（终态）
  | 'cancelled' // 被显式取消（终态）
  | 'failed' // 不可恢复失败（终态）

/** Result of a channel send as recorded on the job. */
export type EscalationChannelResult = 'sent' | 'failed' | 'skipped';

/** A single delivery attempt to one channel. */
export interface EscalationAttempt {
  channel: 'otto' | 'feishu' | 'sms';
  status: EscalationChannelResult;
  detail: string | null;
  attemptedAt: string;
}

/** Durable notification escalation job record. */
export interface EscalationJob {
  /** Unique, caller-provided idempotency key (e.g. ticketId + event + recipient). */
  id: string;
  organizationId: string;
  ticketId: string;
  recipientAccountId: string;
  feishuOpenId: string | null;
  phone: string | null;
  title: string;
  body: string;
  /** Job creation time (ISO). */
  createdAt: string;
  /** Deadline (ISO) after which an unread job escalates to SMS. */
  escalateAt: string;
  status: EscalationJobStatus;
  /** When the recipient acknowledged (read receipt), if ever. */
  readAt: string | null;
  /** When SMS was sent (escalated), if ever. */
  escalatedAt: string | null;
  /** Number of failed delivery attempts so far. */
  retryCount: number;
  /** Terminal failure reason kept for operator inspection. */
  failureReason: string | null;
  attempts: EscalationAttempt[];
}

/** Result returned by the escalation queue facade. */
export interface EscalationSubmitResult {
  /** True when a new job was created; false when an identical idempotent job already existed. */
  accepted: boolean;
  job: EscalationJob;
}

/** Input to create (or dedupe) an escalation notification job. */
export interface SubmitEscalationInput {
  id: string;
  organizationId: string;
  ticketId: string;
  recipientAccountId: string;
  feishuOpenId?: string | null;
  phone?: string | null;
  title: string;
  body: string;
  /** Override default 5-minute escalation window (ms). Defaults to 300_000. */
  escalateAfterMs?: number;
  now?: Date;
}

/** Minimal database surface the escalation repository needs (better-sqlite3/node:sqlite compatible). */
export interface EscalationDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/**
 * Abstraction over a single delivery channel. A channel reports success/failure
 * via the boolean return; `detail` is an optional human-readable reason captured
 * onto the job for operator inspection.
 */
export interface EscalationChannelSender {
  readonly channel: 'otto' | 'feishu' | 'sms';
  /** @returns true when delivered, false when failed (kept for retry), null when skipped (permanent). */
  send(
    job: EscalationJob,
    recipientId: string,
    title: string,
    body: string,
  ): Promise<boolean | null>;
}

/** Opaque store abstraction so the facade is testable without a real DB. */
export interface EscalationRepositoryStore<TJob extends EscalationJob = EscalationJob> {
  db(): EscalationDatabase;
  createJobId(): string;
  now(): Date;
}
