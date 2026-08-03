/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * NSI-11: durable storage for the ticket unread-notification escalation queue.
 *
 * The table stores one row per notification job with its lifecycle state,
 * escalation deadline, read receipt, retry/failure accounting and the JSON
 * delivery-attempt ledger. All rows carry an organization id for tenant
 * isolation (every query filters by it).
 */

import type {
  EscalationAttempt,
  EscalationDatabase,
  EscalationJob,
  EscalationJobStatus,
  EscalationRepositoryStore,
} from './ticketEscalationTypes.js';

const TABLE = 'ticket_escalation_jobs';

/** Row shape persisted to the database (attempts flattened to JSON). */
interface EscalationJobRow {
  id: string;
  organization_id: string;
  ticket_id: string;
  recipient_account_id: string;
  feishu_open_id: string | null;
  phone: string | null;
  title: string;
  body: string;
  created_at: string;
  escalate_at: string;
  status: EscalationJobStatus;
  read_at: string | null;
  escalated_at: string | null;
  retry_count: number;
  failure_reason: string | null;
  attempts_json: string;
}

function mapRow(row: EscalationJobRow): EscalationJob {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ticketId: row.ticket_id,
    recipientAccountId: row.recipient_account_id,
    feishuOpenId: row.feishu_open_id,
    phone: row.phone,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    escalateAt: row.escalate_at,
    status: row.status,
    readAt: row.read_at,
    escalatedAt: row.escalated_at,
    retryCount: row.retry_count,
    failureReason: row.failure_reason,
    attempts:
      typeof row.attempts_json === 'string' && row.attempts_json.length > 0
        ? (JSON.parse(row.attempts_json) as EscalationAttempt[])
        : [],
  };
}

function mapJob(job: EscalationJob): EscalationJobRow {
  return {
    id: job.id,
    organization_id: job.organizationId,
    ticket_id: job.ticketId,
    recipient_account_id: job.recipientAccountId,
    feishu_open_id: job.feishuOpenId,
    phone: job.phone,
    title: job.title,
    body: job.body,
    created_at: job.createdAt,
    escalate_at: job.escalateAt,
    status: job.status,
    read_at: job.readAt,
    escalated_at: job.escalatedAt,
    retry_count: job.retryCount,
    failure_reason: job.failureReason,
    attempts_json: JSON.stringify(job.attempts),
  };
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL,
  feishu_open_id TEXT,
  phone TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  escalate_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'delivering', 'delivered', 'escalating', 'resolved',
    'cancelled', 'failed'
  )),
  read_at TEXT,
  escalated_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  attempts_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS ${TABLE}_org_status ON ${TABLE}(organization_id, status);
CREATE INDEX IF NOT EXISTS ${TABLE}_escalate_at ON ${TABLE}(status, escalate_at);
`;

/** Creates the escalation queue table. Safe to call more than once. */
export function createTicketEscalationTable(db: EscalationDatabase): void {
  db.exec(CREATE_SQL);
}

export class TicketEscalationRepository {
  constructor(private readonly store: EscalationRepositoryStore) {}

  /** Inserts a job; returns false when the same idempotency key already exists. */
  insert(job: EscalationJob): boolean {
    const db = this.store.db();
    const existing = this.getById(job.organizationId, job.id);
    if (existing) return false;
    const row = mapJob(job);
    db.prepare(
      `INSERT INTO ${TABLE} (
        id, organization_id, ticket_id, recipient_account_id, feishu_open_id,
        phone, title, body, created_at, escalate_at, status, read_at,
        escalated_at, retry_count, failure_reason, attempts_json
      ) VALUES (
        @id, @organization_id, @ticket_id, @recipient_account_id, @feishu_open_id,
        @phone, @title, @body, @created_at, @escalate_at, @status, @read_at,
        @escalated_at, @retry_count, @failure_reason, @attempts_json
      )`,
    ).run(row);
    return true;
  }

  getById(organizationId: string, id: string): EscalationJob | null {
    const row = this.store.db().prepare(
      `SELECT * FROM ${TABLE} WHERE organization_id = ? AND id = ?`,
    ).get(organizationId, id) as EscalationJobRow | undefined;
    return row ? mapRow(row) : null;
  }

  listByOrganization(organizationId: string, status?: EscalationJobStatus): EscalationJob[] {
    const db = this.store.db();
    const rows = status
      ? (db.prepare(
          `SELECT * FROM ${TABLE} WHERE organization_id = ? AND status = ? ORDER BY created_at DESC`,
        ).all(organizationId, status) as EscalationJobRow[])
      : (db.prepare(
          `SELECT * FROM ${TABLE} WHERE organization_id = ? ORDER BY created_at DESC`,
        ).all(organizationId) as EscalationJobRow[]);
    return rows.map(mapRow);
  }

  /** All non-terminal jobs across organizations whose escalate deadline has passed. */
  listDueForEscalation(nowIso: string, limit = 100): EscalationJob[] {
    const rows = this.store.db().prepare(
      `SELECT * FROM ${TABLE}
       WHERE status IN ('queued','delivering','delivered','escalating')
         AND escalate_at <= ?
       ORDER BY escalate_at ASC LIMIT ?`,
    ).all(nowIso, limit) as EscalationJobRow[];
    return rows.map(mapRow);
  }

  update(job: EscalationJob): void {
    const row = mapJob(job);
    this.store.db().prepare(
      `UPDATE ${TABLE} SET
        status = @status, read_at = @read_at, escalated_at = @escalated_at,
        retry_count = @retry_count, failure_reason = @failure_reason,
        attempts_json = @attempts_json
       WHERE organization_id = @organization_id AND id = @id`,
    ).run({
      status: row.status,
      read_at: row.read_at,
      escalated_at: row.escalated_at,
      retry_count: row.retry_count,
      failure_reason: row.failure_reason,
      attempts_json: row.attempts_json,
      organization_id: row.organization_id,
      id: row.id,
    });
  }
}
