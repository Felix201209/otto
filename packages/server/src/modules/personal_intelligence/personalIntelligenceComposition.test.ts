/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { createPersonalIntelligenceComposition } from './personalIntelligenceComposition.js';
import { PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR } from './personalIntelligenceSchema.js';
import { createWorklogSchemaContributor } from './worklogSchema.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE accounts (id TEXT PRIMARY KEY);
    CREATE TABLE employees (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      department TEXT,
      status TEXT NOT NULL
    );
    INSERT INTO organizations (id, status) VALUES ('org-a', 'active');
    INSERT INTO accounts (id) VALUES ('account-a');
    INSERT INTO employees
      (id, organization_id, department, status)
    VALUES ('employee-a', 'org-a', 'Engineering', 'active');
  `);
  createWorklogSchemaContributor({ defaultOrganizationId: 'org-a' }).apply(
    database,
  );
  PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR.apply(database);
  return database;
}

describe('personal intelligence composition', () => {
  it('shares active identity rules across encrypted restoration and worklogs', () => {
    const database = createDatabase();
    let accountStatus: 'active' | 'disabled' = 'active';
    let now = 1_000;
    const auditEvents: string[] = [];
    const organization = { id: 'org-a', status: 'active' as const };
    const employee = {
      id: 'employee-a',
      organization_id: 'org-a',
      department: 'Engineering',
      status: 'active',
    };
    const personalIntelligence = createPersonalIntelligenceComposition({
      db: () => database,
      defaultOrganizationId: 'org-a',
      keyProvider: {
        getKey: () => Buffer.alloc(32, 7),
        clear: () => undefined,
      },
      getAccount: (accountId) =>
        accountId === 'account-a'
          ? {
              id: 'account-a',
              organizationId: 'org-a',
              status: accountStatus,
            }
          : null,
      getOrganization: (organizationId) =>
        organizationId === organization.id ? organization : null,
      getEmployee: (employeeId, organizationId) =>
        employeeId === employee.id && organizationId === organization.id
          ? employee
          : null,
      listActiveEmployees: () => [employee],
      audit: (event) => auditEvents.push(event),
      now: () => now,
    });

    try {
      const snapshot = personalIntelligence.putAccountSyncSnapshot({
        accountId: 'account-a',
        scope: 'personal_memory',
        expectedVersion: 0,
        payload: {
          schemaVersion: 1,
          generatedAt: '2026-07-29T00:00:00.000Z',
          files: [],
        },
        deviceId: 'desktop-a',
      });
      expect(snapshot).toMatchObject({
        scope: 'personal_memory',
        version: 1,
        deviceId: 'desktop-a',
        updatedAtMs: now,
      });
      expect(
        personalIntelligence.listAccountSyncSnapshots('account-a'),
      ).toEqual([snapshot]);

      personalIntelligence.logTask({
        organizationId: 'org-a',
        employee_id: employee.id,
        task_type: 'code-review',
        duration_min: 15,
        tokens_used: 120,
      });
      expect(personalIntelligence.listWorklogsForBackup('org-a')).toEqual([
        expect.objectContaining({
          organization_id: 'org-a',
          employee_id: employee.id,
          task_type: 'code-review',
        }),
      ]);
      expect(auditEvents).toContain('learn');

      now += 1_000;
      accountStatus = 'disabled';
      expect(() =>
        personalIntelligence.listAccountSyncSnapshots('account-a'),
      ).toThrow('account not found');
    } finally {
      database.close();
    }
  });
});
