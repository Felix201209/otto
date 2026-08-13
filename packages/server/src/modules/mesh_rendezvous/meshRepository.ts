/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * [MESH-05] 存储层：rendezvous 记录、NAT 会话、配额桶、DDoS 决策、路径收据。
 *
 * 存储只保留计数/元数据；relay 密文块由 runtime 在内存中短时驻留，不进数据库。
 */

import { randomUUID } from 'node:crypto';

import type { Database } from '../data_platform/index.js';
import {
  type MeshDdosDecision,
  type MeshNatSession,
  type MeshPathReceipt,
  type MeshPathType,
  type MeshQuotaBucket,
  type SignedMeshRendezvousRecord,
} from './meshContracts.js';

export interface MeshRepositoryStore {
  db(): Database;
  now(): number;
}

interface RendezvousRow {
  node_id: string;
  signed_record_json: string;
  expires_at_ms: number;
}

interface SessionRow {
  session_id: string;
  node_a: string;
  node_b: string;
  tenant_a: string | null;
  tenant_b: string | null;
  path_type: MeshPathType;
  created_at_ms: number;
  expires_at_ms: number;
}

interface QuotaRow {
  scope: string;
  window_started_at_ms: number;
  request_count: number;
  byte_count: number;
  connection_count: number;
}

interface DdosRow {
  source: string;
  decision: MeshDdosDecision['decision'];
  reason: string;
  decided_at_ms: number;
  expires_at_ms: number;
}

interface ReceiptRow {
  receipt_id: string;
  session_id: string;
  path_type: MeshPathType;
  node_a: string;
  node_b: string;
  bytes_forwarded: number;
  chunks_forwarded: number;
  duration_ms: number;
  created_at_ms: number;
}

function parseSignedRecord(value: string): SignedMeshRendezvousRecord {
  const parsed = JSON.parse(value) as SignedMeshRendezvousRecord;
  if (!parsed?.record || typeof parsed.signature !== 'string') {
    throw new Error('persisted rendezvous record is invalid');
  }
  return parsed;
}

// ---------------------------------------------------------------- rendezvous

export function upsertRendezvousRecordInRepository(
  store: MeshRepositoryStore,
  signed: SignedMeshRendezvousRecord,
): void {
  const now = store.now();
  store.db().prepare(
    `INSERT INTO mesh_rendezvous_records
       (node_id, signed_record_json, signing_key_id, expires_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       signed_record_json = excluded.signed_record_json,
       signing_key_id = excluded.signing_key_id,
       expires_at_ms = excluded.expires_at_ms,
       updated_at_ms = excluded.updated_at_ms`,
  ).run(
    signed.record.nodeId,
    JSON.stringify(signed),
    signed.signingKeyId,
    Date.parse(signed.record.expiresAt),
    now,
  );
}

export function getRendezvousRecordInRepository(
  store: MeshRepositoryStore,
  nodeId: string,
): SignedMeshRendezvousRecord | null {
  const now = store.now();
  store.db().prepare(
    `UPDATE mesh_rendezvous_records SET expires_at_ms = 0
     WHERE node_id = ? AND expires_at_ms <= ?`,
  ).run(nodeId, now);
  const row = store.db().prepare(
    `SELECT node_id, signed_record_json, expires_at_ms FROM mesh_rendezvous_records
     WHERE node_id = ? AND expires_at_ms > ?`,
  ).get(nodeId, now) as RendezvousRow | undefined;
  return row ? parseSignedRecord(row.signed_record_json) : null;
}

export function listRendezvousRecordsInRepository(
  store: MeshRepositoryStore,
): SignedMeshRendezvousRecord[] {
  const now = store.now();
  store.db().prepare(
    `DELETE FROM mesh_rendezvous_records WHERE expires_at_ms <= ?`,
  ).run(now);
  const rows = store.db().prepare(
    `SELECT node_id, signed_record_json, expires_at_ms FROM mesh_rendezvous_records
     WHERE expires_at_ms > ? ORDER BY updated_at_ms DESC`,
  ).all(now) as RendezvousRow[];
  return rows.map((row) => parseSignedRecord(row.signed_record_json));
}

// ---------------------------------------------------------------- NAT sessions

export function saveNatSessionInRepository(
  store: MeshRepositoryStore,
  session: MeshNatSession,
): void {
  store.db().prepare(
    `INSERT OR REPLACE INTO mesh_nat_sessions
       (session_id, node_a, node_b, tenant_a, tenant_b, path_type, created_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.sessionId,
    session.nodeA,
    session.nodeB,
    session.tenantA,
    session.tenantB,
    session.pathType,
    session.createdAt,
    session.expiresAt,
  );
}

export function getNatSessionInRepository(
  store: MeshRepositoryStore,
  sessionId: string,
): MeshNatSession | null {
  const row = store.db().prepare(
    `SELECT session_id, node_a, node_b, tenant_a, tenant_b, path_type, created_at_ms, expires_at_ms
     FROM mesh_nat_sessions WHERE session_id = ?`,
  ).get(sessionId) as SessionRow | undefined;
  if (!row) return null;
  return {
    sessionId: row.session_id,
    nodeA: row.node_a,
    nodeB: row.node_b,
    tenantA: row.tenant_a,
    tenantB: row.tenant_b,
    pathType: row.path_type,
    createdAt: row.created_at_ms,
    expiresAt: row.expires_at_ms,
  };
}

export function destroyNatSessionInRepository(
  store: MeshRepositoryStore,
  sessionId: string,
): boolean {
  const result = store.db().prepare(
    `DELETE FROM mesh_nat_sessions WHERE session_id = ?`,
  ).run(sessionId);
  return Number(result.changes) > 0;
}

export function sweepExpiredNatSessionsInRepository(
  store: MeshRepositoryStore,
): number {
  const result = store.db().prepare(
    `DELETE FROM mesh_nat_sessions WHERE expires_at_ms <= ?`,
  ).run(store.now());
  return Number(result.changes);
}

// ---------------------------------------------------------------- quota buckets

export function getQuotaBucketInRepository(
  store: MeshRepositoryStore,
  scope: string,
  windowMs: number,
): MeshQuotaBucket {
  const now = store.now();
  const windowStarted = Math.floor(now / windowMs) * windowMs;
  store.db().prepare(
    `DELETE FROM mesh_quota_buckets WHERE scope = ? AND window_started_at_ms < ?`,
  ).run(scope, windowStarted);
  const row = store.db().prepare(
    `SELECT scope, window_started_at_ms, request_count, byte_count, connection_count
     FROM mesh_quota_buckets WHERE scope = ? AND window_started_at_ms = ?`,
  ).get(scope, windowStarted) as QuotaRow | undefined;
  return row
    ? {
        scope: row.scope,
        windowStartedAt: row.window_started_at_ms,
        requestCount: row.request_count,
        byteCount: row.byte_count,
        connectionCount: row.connection_count,
      }
    : { scope, windowStartedAt: windowStarted, requestCount: 0, byteCount: 0, connectionCount: 0 };
}

export function addQuotaUsageInRepository(
  store: MeshRepositoryStore,
  scope: string,
  windowMs: number,
  input: { requests?: number; bytes?: number; connections?: number },
): void {
  const bucket = getQuotaBucketInRepository(store, scope, windowMs);
  store.db().prepare(
    `INSERT INTO mesh_quota_buckets
       (scope, window_started_at_ms, request_count, byte_count, connection_count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, window_started_at_ms) DO UPDATE SET
       request_count = request_count + excluded.request_count,
       byte_count = byte_count + excluded.byte_count,
       connection_count = connection_count + excluded.connection_count`,
  ).run(
    bucket.scope,
    bucket.windowStartedAt,
    input.requests ?? 0,
    input.bytes ?? 0,
    input.connections ?? 0,
  );
}

export function clearQuotaBucketsInRepository(store: MeshRepositoryStore): void {
  store.db().prepare(`DELETE FROM mesh_quota_buckets`).run();
}

// ---------------------------------------------------------------- DDoS decisions

export function getDdosDecisionInRepository(
  store: MeshRepositoryStore,
  source: string,
): MeshDdosDecision | null {
  const now = store.now();
  store.db().prepare(
    `UPDATE mesh_ddos_decisions SET expires_at_ms = 0 WHERE source = ? AND expires_at_ms <= ?`,
  ).run(source, now);
  const row = store.db().prepare(
    `SELECT source, decision, reason, decided_at_ms, expires_at_ms FROM mesh_ddos_decisions
     WHERE source = ? AND expires_at_ms > ?`,
  ).get(source, now) as DdosRow | undefined;
  return row
    ? {
        source: row.source,
        decision: row.decision,
        reason: row.reason,
        decidedAt: row.decided_at_ms,
        expiresAt: row.expires_at_ms,
      }
    : null;
}

export function setDdosDecisionInRepository(
  store: MeshRepositoryStore,
  decision: MeshDdosDecision,
): void {
  store.db().prepare(
    `INSERT OR REPLACE INTO mesh_ddos_decisions
       (source, decision, reason, decided_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    decision.source,
    decision.decision,
    decision.reason,
    decision.decidedAt,
    decision.expiresAt,
  );
}

export function listActiveDdosDecisionsInRepository(
  store: MeshRepositoryStore,
): MeshDdosDecision[] {
  const now = store.now();
  store.db().prepare(
    `DELETE FROM mesh_ddos_decisions WHERE expires_at_ms <= ?`,
  ).run(now);
  const rows = store.db().prepare(
    `SELECT source, decision, reason, decided_at_ms, expires_at_ms FROM mesh_ddos_decisions`,
  ).all() as DdosRow[];
  return rows.map((row) => ({
    source: row.source,
    decision: row.decision,
    reason: row.reason,
    decidedAt: row.decided_at_ms,
    expiresAt: row.expires_at_ms,
  }));
}

// ---------------------------------------------------------------- path receipts

export function savePathReceiptInRepository(
  store: MeshRepositoryStore,
  receipt: MeshPathReceipt,
): void {
  store.db().prepare(
    `INSERT OR REPLACE INTO mesh_path_receipts
       (receipt_id, session_id, path_type, node_a, node_b, bytes_forwarded, chunks_forwarded, duration_ms, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.receiptId,
    receipt.sessionId,
    receipt.pathType,
    receipt.nodeA,
    receipt.nodeB,
    receipt.bytesForwarded,
    receipt.chunksForwarded,
    receipt.durationMs,
    receipt.createdAt,
  );
}

export function listPathReceiptsInRepository(
  store: MeshRepositoryStore,
  limit = 50,
): MeshPathReceipt[] {
  const rows = store.db().prepare(
    `SELECT receipt_id, session_id, path_type, node_a, node_b, bytes_forwarded, chunks_forwarded, duration_ms, created_at_ms
     FROM mesh_path_receipts ORDER BY created_at_ms DESC LIMIT ?`,
  ).all(limit) as ReceiptRow[];
  return rows.map((row) => ({
    receiptId: row.receipt_id,
    sessionId: row.session_id,
    pathType: row.path_type,
    nodeA: row.node_a,
    nodeB: row.node_b,
    bytesForwarded: row.bytes_forwarded,
    chunksForwarded: row.chunks_forwarded,
    durationMs: row.duration_ms,
    createdAt: row.created_at_ms,
  }));
}

export function newReceiptId(): string {
  return `receipt_${randomUUID().replaceAll('-', '')}`;
}
