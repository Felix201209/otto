/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import type { AuditLogRecord, WriteAuditLogInput } from './auditLogTypes.js';

export const MAX_AUDIT_LOG_QUERY_LIMIT = 500;
const MAX_AUDIT_DETAIL_LENGTH = 2_000;

export function redactAuditDetail(detail: string | null): string | null {
  if (detail == null) return null;
  return detail
    .replace(/\b(Authorization\s*:\s*Bearer)\s+[^\s,;]+/giu, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*([^\s,;]+)/giu,
      '$1=[REDACTED]',
    )
    .replace(
      /([?&](?:access_token|api_key|token|secret|password)=)[^&#\s]*/giu,
      '$1[REDACTED]',
    )
    .replace(/\b(?:sk|ghp|github_pat)_[a-z0-9_-]{12,}\b/giu, '[REDACTED]')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, MAX_AUDIT_DETAIL_LENGTH);
}

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
    .run(
      input.organizationId,
      input.event,
      input.employeeId,
      redactAuditDetail(input.detail),
    );
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
