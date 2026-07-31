/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { Database } from '../data_platform/index.js';
import { backfillEnterpriseAccountEmployees } from './enterpriseAccountEmployeeMigration.js';
import {
  normalizeAssignmentName,
  stableAssignmentId,
} from './organizationStructureRepository.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      employee_id TEXT,
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      account_type TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE employees (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      status TEXT NOT NULL,
      onboarded_at TEXT NOT NULL
    );
  `);
  return database;
}

describe('enterprise account employee migration', () => {
  it('creates a stable employee profile once and ignores ineligible accounts', () => {
    const database = createDatabase();
    try {
      database.exec(`
        INSERT INTO accounts
          (id, organization_id, name, role, department, position_title,
           status, created_at, account_type, deleted_at)
        VALUES
          ('account-a', 'org-a', 'Alice', 'member', ' Engineering ', 'Developer',
           'active', '2026-01-02T03:04:05.000Z', 'enterprise', NULL),
          ('personal-a', 'org-a', 'Personal', NULL, NULL, NULL,
           'active', '2026-01-02T03:04:05.000Z', 'personal', NULL),
          ('deleted-a', 'org-a', 'Deleted', NULL, NULL, NULL,
           'disabled', '2026-01-02T03:04:05.000Z', 'enterprise', '2026-02-01');
      `);

      const options = { createEmployeeId: () => 'employee-created' };
      backfillEnterpriseAccountEmployees(database, options);
      backfillEnterpriseAccountEmployees(database, options);

      const departmentId = stableAssignmentId(
        'dept',
        'org-a',
        normalizeAssignmentName(' Engineering '),
      );
      const positionId = stableAssignmentId(
        'pos',
        'org-a',
        departmentId,
        normalizeAssignmentName('Developer'),
      );
      expect(
        database
          .prepare(
            `SELECT employee_id, department_id, position_id
             FROM accounts WHERE id = 'account-a'`,
          )
          .get(),
      ).toEqual({
        employee_id: 'employee-created',
        department_id: departmentId,
        position_id: positionId,
      });
      expect(
        database
          .prepare(
            `SELECT id, organization_id, name, role, department, department_id,
                    position_id, position_title, status, onboarded_at
             FROM employees`,
          )
          .all(),
      ).toEqual([
        {
          id: 'employee-created',
          organization_id: 'org-a',
          name: 'Alice',
          role: 'member',
          department: ' Engineering ',
          department_id: departmentId,
          position_id: positionId,
          position_title: 'Developer',
          status: 'active',
          onboarded_at: '2026-01-02T03:04:05.000Z',
        },
      ]);
      expect(
        database
          .prepare(
            `SELECT employee_id FROM accounts
             WHERE id IN ('personal-a', 'deleted-a') ORDER BY id`,
          )
          .all(),
      ).toEqual([{ employee_id: null }, { employee_id: null }]);
    } finally {
      database.close();
    }
  });

  it('reuses a same-organization employee and fills missing account fields', () => {
    const database = createDatabase();
    try {
      database.exec(`
        INSERT INTO employees
          (id, organization_id, name, role, department, department_id,
           position_id, position_title, status, onboarded_at)
        VALUES
          ('employee-a', 'org-a', 'Old name', 'admin', 'Finance', 'dept-finance',
           'pos-manager', 'Manager', 'active', '2025-01-01');
        INSERT INTO accounts
          (id, organization_id, employee_id, name, status, created_at, account_type)
        VALUES
          ('account-a', 'org-a', 'employee-a', 'New name', 'active',
           '2026-01-01', 'enterprise');
      `);

      backfillEnterpriseAccountEmployees(database, {
        createEmployeeId: () => {
          throw new Error('must not create an employee');
        },
      });

      expect(
        database
          .prepare(
            `SELECT employee_id, role, department, department_id,
                    position_id, position_title
             FROM accounts WHERE id = 'account-a'`,
          )
          .get(),
      ).toEqual({
        employee_id: 'employee-a',
        role: 'admin',
        department: 'Finance',
        department_id: 'dept-finance',
        position_id: 'pos-manager',
        position_title: 'Manager',
      });
      expect(
        database
          .prepare(`SELECT name FROM employees WHERE id = 'employee-a'`)
          .get(),
      ).toEqual({ name: 'New name' });
    } finally {
      database.close();
    }
  });

  it('does not reuse a cross-organization employee link', () => {
    const database = createDatabase();
    try {
      database.exec(`
        INSERT INTO employees
          (id, organization_id, name, status, onboarded_at)
        VALUES ('employee-b', 'org-b', 'Bob', 'active', '2025-01-01');
        INSERT INTO accounts
          (id, organization_id, employee_id, name, status, created_at, account_type)
        VALUES
          ('account-a', 'org-a', 'employee-b', 'Alice', 'disabled',
           '2026-01-01', 'enterprise');
      `);

      backfillEnterpriseAccountEmployees(database, {
        createEmployeeId: () => 'employee-a',
      });

      expect(
        database
          .prepare(`SELECT employee_id FROM accounts WHERE id = 'account-a'`)
          .get(),
      ).toEqual({ employee_id: 'employee-a' });
      expect(
        database
          .prepare(
            `SELECT organization_id, name, status FROM employees
             WHERE id = 'employee-a'`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-a',
        name: 'Alice',
        status: 'offboarded',
      });
      expect(
        database
          .prepare(`SELECT name FROM employees WHERE id = 'employee-b'`)
          .get(),
      ).toEqual({ name: 'Bob' });
    } finally {
      database.close();
    }
  });

  it('rolls back every write when one employee cannot be created', () => {
    const database = createDatabase();
    try {
      database.exec(`
        INSERT INTO accounts
          (id, organization_id, name, department, status, created_at, account_type)
        VALUES
          ('account-a', 'org-a', 'Alice', 'Engineering', 'active',
           '2026-01-01', 'enterprise'),
          ('account-b', 'org-a', 'Bob', 'Finance', 'active',
           '2026-01-01', 'enterprise');
      `);

      expect(() =>
        backfillEnterpriseAccountEmployees(database, {
          createEmployeeId: () => 'duplicate-employee',
        }),
      ).toThrow();

      expect(
        database.prepare('SELECT COUNT(*) AS count FROM employees').get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            `SELECT employee_id, department_id, position_id
             FROM accounts ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { employee_id: null, department_id: null, position_id: null },
        { employee_id: null, department_id: null, position_id: null },
      ]);
    } finally {
      database.close();
    }
  });
});
