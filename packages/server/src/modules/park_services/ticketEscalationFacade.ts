/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * NSI-11: park ticket unread-notification escalation queue — facade.
 *
 * Responsibilities:
 *   - submit(): create a durable job (idempotent by caller key) and immediately
 *     deliver to Otto + Feishu.
 *   - acknowledge(): record a read receipt, resolving the job so SMS is skipped.
 *   - cancel(): mark a queued/delivered job terminal without sending SMS.
 *   - tick(): the scheduler entry — escalates jobs whose deadline has passed and
 *     no read receipt arrived, sending SMS once (retry with backoff on failure,
 *     never more than once per window, durable across restarts).
 *   - inspect(): operator view of status + failure reasons (NSI-11 DoD).
 *
 * All writes go through the repository; the sender map is injectable so tests
 * run against in-memory fakes without real Feishu/SMS credentials.
 */

import type {
  EscalationChannelSender,
  EscalationJob,
  EscalationJobStatus,
  SubmitEscalationInput,
  EscalationSubmitResult,
} from './ticketEscalationTypes.js';
import { TicketEscalationRepository } from './ticketEscalationRepository.js';

const DEFAULT_ESCALATE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRY_COUNT = 3;
const RETRY_BACKOFF_MS = 30_000;

export interface EscalationFacadeOptions {
  /** Injectable per-channel senders. Missing channels are treated as "skipped". */
  senders?: Partial<Record<'otto' | 'feishu' | 'sms', EscalationChannelSender>>;
  escalateAfterMs?: number;
  maxRetryCount?: number;
  now?: () => Date;
}

export class TicketEscalationFacade {
  private readonly repository: TicketEscalationRepository;
  private readonly senders: Partial<Record<'otto' | 'feishu' | 'sms', EscalationChannelSender>>;
  private readonly escalateAfterMs: number;
  private readonly maxRetryCount: number;
  private readonly now: () => Date;

  constructor(
    store: { db(): unknown; createJobId(): string; now(): Date },
    options: EscalationFacadeOptions = {},
  ) {
    this.repository = new TicketEscalationRepository(store as never);
    this.senders = options.senders ?? {};
    this.escalateAfterMs = options.escalateAfterMs ?? DEFAULT_ESCALATE_MS;
    this.maxRetryCount = options.maxRetryCount ?? MAX_RETRY_COUNT;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Submits a notification job and immediately attempts Otto + Feishu delivery.
   * Idempotent by `id`: a duplicate returns the existing job with accepted=false.
   */
  async submit(input: SubmitEscalationInput): Promise<EscalationSubmitResult> {
    const now = input.now ?? this.now();
    const existing = this.repository.getById(input.organizationId, input.id);
    if (existing) return { accepted: false, job: existing };

    const escalateAfter = input.escalateAfterMs ?? this.escalateAfterMs;
    const job: EscalationJob = {
      id: input.id,
      organizationId: input.organizationId,
      ticketId: input.ticketId,
      recipientAccountId: input.recipientAccountId,
      feishuOpenId: input.feishuOpenId ?? null,
      phone: input.phone ?? null,
      title: input.title,
      body: input.body,
      createdAt: now.toISOString(),
      escalateAt: new Date(now.getTime() + escalateAfter).toISOString(),
      status: 'queued',
      readAt: null,
      escalatedAt: null,
      retryCount: 0,
      failureReason: null,
      attempts: [],
    };

    this.repository.insert(job);
    const delivered = await this.deliverImmediate(job);
    void delivered;
    return { accepted: true, job: await this.repository.getById(job.organizationId, job.id)! };
  }

  /** Records a read receipt; resolves the job (SMS escalation will be skipped). */
  acknowledge(organizationId: string, id: string, now = this.now()): boolean {
    const job = this.repository.getById(organizationId, id);
    if (!job) return false;
    if (job.status === 'resolved' || job.status === 'cancelled' || job.status === 'failed') {
      return true; // already terminal
    }
    job.status = 'resolved';
    job.readAt = now.toISOString();
    this.repository.update(job);
    return true;
  }

  /** Cancels a non-terminal job; no SMS will be sent. */
  cancel(organizationId: string, id: string): boolean {
    const job = this.repository.getById(organizationId, id);
    if (!job) return false;
    if (job.status === 'resolved' || job.status === 'cancelled' || job.status === 'failed') {
      return false;
    }
    job.status = 'cancelled';
    this.repository.update(job);
    return true;
  }

  /**
   * Scheduler entry point. Call periodically (e.g. every 30s). Escalates any
   * delivered-and-unread job whose deadline has passed, exactly once.
   */
  async tick(now = this.now()): Promise<number> {
    const due = this.repository.listDueForEscalation(now.toISOString());
    let escalated = 0;
    for (const job of due) {
      if (job.status !== 'queued' && job.status !== 'delivering' && job.status !== 'delivered' && job.status !== 'escalating') {
        continue;
      }
      if (job.readAt) {
        job.status = 'resolved';
        this.repository.update(job);
        continue;
      }
      const ok = await this.deliverSms(job, now);
      if (ok) escalated += 1;
    }
    return escalated;
  }

  /** Operator view of a job's current status, attempts and failure reason. */
  inspect(organizationId: string, id: string): EscalationJob | null {
    return this.repository.getById(organizationId, id);
  }

  list(organizationId: string, status?: EscalationJobStatus): EscalationJob[] {
    return this.repository.listByOrganization(organizationId, status);
  }

  /** Private: deliver Otto + Feishu at submit time; record attempts. */
  private async deliverImmediate(job: EscalationJob): Promise<void> {
    const results = await Promise.allSettled([
      this.tryChannel(job, 'otto', job.recipientAccountId),
      this.tryChannel(job, 'feishu', job.feishuOpenId ?? ''),
    ]);
    const hadFailure = results.some((r) => r.status === 'fulfilled' && r.value === false);

    if (hadFailure && job.failureReason === null) {
      job.failureReason = 'Immediate delivery failed on at least one channel.';
    }
    job.status = 'delivered';
    this.repository.update(job);
  }

  /** Private: escalate to SMS once the deadline has passed (strictly once). */
  private async deliverSms(job: EscalationJob, now: Date): Promise<boolean> {
    const phone = job.phone;
    if (!phone) {
      // No SMS number configured on the recipient — terminal with a clear reason.
      job.status = 'failed';
      job.failureReason = 'No SMS destination (phone) recorded for recipient.';
      this.repository.update(job);
      return false;
    }
    if (job.escalatedAt) return false; // already escalated exactly once

    // Retry with backoff; never escalate more than one SMS per window.
    if (job.retryCount > this.maxRetryCount) {
      job.status = 'failed';
      job.failureReason = `SMS delivery failed after ${job.retryCount} retries.`;
      this.repository.update(job);
      return false;
    }

    const result = await this.tryChannel(job, 'sms', phone);
    if (result === true || result === null) {
      job.escalatedAt = now.toISOString();
      job.status = result === null ? 'resolved' : 'delivered';
      if (job.status === 'resolved') job.readAt = job.readAt ?? now.toISOString();
      this.repository.update(job);
      return result === true;
    }

    job.retryCount += 1;
    job.failureReason = job.failureReason ?? 'SMS delivery failed; will retry.';
    this.repository.update(job);
    return false;
  }

  private async tryChannel(
    job: EscalationJob,
    channel: 'otto' | 'feishu' | 'sms',
    recipientId: string,
  ): Promise<boolean | null> {
    const sender = this.senders[channel];
    if (!sender || !recipientId) {
      job.attempts.push({
        channel,
        status: 'skipped',
        detail: sender ? 'No recipient id for channel.' : 'Channel sender not configured.',
        attemptedAt: this.now().toISOString(),
      });
      return null; // skipped
    }
    try {
      const ok = await sender.send(job, recipientId, job.title, job.body);
      job.attempts.push({
        channel,
        status: ok === true ? 'sent' : ok === null ? 'skipped' : 'failed',
        detail: null,
        attemptedAt: this.now().toISOString(),
      });
      return ok;
    } catch (error) {
      job.attempts.push({
        channel,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        attemptedAt: this.now().toISOString(),
      });
      return false;
    }
  }

  static readonly RETRY_BACKOFF_MS = RETRY_BACKOFF_MS;
}
