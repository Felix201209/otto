/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface AuditLogRecord {
  id: number;
  organization_id: string;
  event: string;
  employee_id: string | null;
  detail: string | null;
  created_at: string;
}

export interface WriteAuditLogInput {
  event: string;
  employeeId: string | null;
  detail: string;
  organizationId: string;
}
