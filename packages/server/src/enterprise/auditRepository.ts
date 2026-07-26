/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_ORGANIZATION_ID, getDB } from './db.js';

export function logAudit(
  event: string,
  employeeId: string | null,
  detail: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
): void {
  getDB()
    .prepare(
      `INSERT INTO audit_logs (organization_id, event, employee_id, detail)
     VALUES (?, ?, ?, ?)`,
    )
    .run(organizationId, event, employeeId, detail);
}

export function getAuditLogs(
  limit = 50,
  organizationId = DEFAULT_ORGANIZATION_ID,
): any[] {
  return getDB()
    .prepare(
      `SELECT * FROM audit_logs WHERE organization_id = ?
     ORDER BY created_at DESC LIMIT ?`,
    )
    .all(organizationId, limit);
}
