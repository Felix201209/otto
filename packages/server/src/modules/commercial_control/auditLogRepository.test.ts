/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { createAuditLogFacade } from './auditLogFacade.js';
import {
  MAX_AUDIT_LOG_QUERY_LIMIT,
  normalizeAuditLogLimit,
} from './auditLogRepository.js';

let database: Database;

function createFacade() {
  return createAuditLogFacade({
    db: () => database,
    defaultOrganizationId: 'org-default',
  });
}

beforeEach(() => {
  database = new Database(':memory:');
  database.exec(`
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL,
      event TEXT NOT NULL,
      employee_id TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
});

afterEach(() => {
  database.close();
});

describe('commercial control audit log repository', () => {
  it('isolates audit rows by organization and preserves the public row shape', () => {
    const audit = createFacade();
    audit.logAudit('org-a-event', 'employee-a', 'detail-a', 'org-a');
    audit.logAudit('org-b-event', 'employee-b', 'detail-b', 'org-b');

    expect(audit.getAuditLogs(50, 'org-a')).toEqual([
      expect.objectContaining({
        organization_id: 'org-a',
        event: 'org-a-event',
        employee_id: 'employee-a',
        detail: 'detail-a',
      }),
    ]);
    expect(audit.getAuditLogs(50, 'org-a')).toHaveLength(1);
  });

  it('bounds invalid and excessive limits without allowing SQLite negative-limit bypasses', () => {
    expect(normalizeAuditLogLimit(Number.NaN)).toBe(50);
    expect(normalizeAuditLogLimit(-1)).toBe(0);
    expect(normalizeAuditLogLimit(0)).toBe(0);
    expect(normalizeAuditLogLimit(10_000)).toBe(MAX_AUDIT_LOG_QUERY_LIMIT);

    const audit = createFacade();
    audit.logAudit('bounded', null, 'detail');
    expect(audit.getAuditLogs(-1)).toEqual([]);
    expect(audit.getAuditLogs(10_000)).toHaveLength(1);
  });

  it('participates in the caller transaction so audit rollback stays atomic', () => {
    const audit = createFacade();
    database.exec('BEGIN IMMEDIATE');
    audit.logAudit('rolled-back', null, 'detail');
    database.exec('ROLLBACK');

    expect(audit.getAuditLogs()).toEqual([]);
  });

  it('redacts credentials before writing durable audit details', () => {
    const audit = createFacade();
    audit.logAudit(
      'security-test',
      null,
      'Authorization: Bearer bearer-value password=hunter2 ' +
        'https://example.test/path?access_token=url-secret sk_1234567890abcdef',
    );

    const detail = audit.getAuditLogs()[0]?.detail || '';
    expect(detail).not.toContain('bearer-value');
    expect(detail).not.toContain('hunter2');
    expect(detail).not.toContain('url-secret');
    expect(detail).not.toContain('sk_1234567890abcdef');
    expect(detail).toContain('[REDACTED]');
  });
});
