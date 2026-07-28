/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import type { AuditLogRecord, WriteAuditLogInput } from './auditLogTypes.js';

export const MAX_AUDIT_LOG_QUERY_LIMIT = 500;

export interface AuditLogRepositoryStore {
  db(): Database;
  defaultOrganizationId: string;
}

export function normalizeAuditLogLimit(limit: number, fallback = 50): number {
  const numericLimit = Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(MAX_AUDIT_LOG_QUERY_LIMIT, Math.max(0, numericLimit));
}

export function logAuditInRepository(
  store: AuditLogRepositoryStore,
  input: WriteAuditLogInput,
): void {
  store
    .db()
    .prepare(
      `INSERT INTO audit_logs (organization_id, event, employee_id, detail)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.organizationId, input.event, input.employeeId, input.detail);
}

export function getAuditLogsFromRepository(
  store: AuditLogRepositoryStore,
  limit = 50,
  organizationId = store.defaultOrganizationId,
): AuditLogRecord[] {
  const safeLimit = normalizeAuditLogLimit(limit);
  if (safeLimit === 0) return [];

  return store
    .db()
    .prepare(
      `SELECT id, organization_id, event, employee_id, detail, created_at
       FROM audit_logs
       WHERE organization_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(organizationId, safeLimit) as AuditLogRecord[];
}
