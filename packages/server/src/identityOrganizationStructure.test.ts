/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createOrganizationStructureFacade,
  type OrganizationStructureRepositoryStore,
} from './modules/identity_organization/index.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE organization_departments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      parent_department_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(organization_id, name)
    );
    CREATE TABLE organization_positions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      department_id TEXT NOT NULL,
      title TEXT NOT NULL COLLATE NOCASE,
      role_mapping TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(organization_id, department_id, title)
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      role TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      deleted_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE employees (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      role TEXT
    );
    CREATE TABLE organization_invites (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      default_department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      default_role TEXT
    );
    CREATE TABLE auth_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      revoked_at TEXT
    );
  `);
  return database;
}

function createStore(
  database: Database,
  logAudit = vi.fn(),
): OrganizationStructureRepositoryStore {
  return { db: () => database, logAudit };
}

function insertOrganization(database: Database, id: string): void {
  database
    .prepare('INSERT INTO organizations (id, name) VALUES (?, ?)')
    .run(id, id);
}

describe('identity_organization organization structure kernel', () => {
  it('lists a tenant-only stable tree and counts only active live accounts', () => {
    const database = createDatabase();
    insertOrganization(database, 'org-a');
    insertOrganization(database, 'org-b');
    const structure = createOrganizationStructureFacade(createStore(database));
    const beta = structure.createOrganizationDepartment({
      organizationId: 'org-a',
      name: 'Beta',
    });
    const alpha = structure.createOrganizationDepartment({
      organizationId: 'org-a',
      name: 'alpha',
    });
    structure.createOrganizationPosition({
      organizationId: 'org-a',
      departmentId: alpha.id,
      title: 'Writer',
    });
    structure.createOrganizationPosition({
      organizationId: 'org-a',
      departmentId: alpha.id,
      title: 'analyst',
    });
    const foreign = structure.createOrganizationDepartment({
      organizationId: 'org-b',
      name: 'Foreign',
    });
    database
      .prepare(
        `INSERT INTO accounts
         (id, organization_id, department_id, status, deleted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('active', 'org-a', alpha.id, 'active', null);
    database
      .prepare(
        `INSERT INTO accounts
         (id, organization_id, department_id, status, deleted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('disabled', 'org-a', alpha.id, 'disabled', null);
    database
      .prepare(
        `INSERT INTO accounts
         (id, organization_id, department_id, status, deleted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('deleted', 'org-a', beta.id, 'active', '2026-01-01');
    database
      .prepare(
        `INSERT INTO accounts
         (id, organization_id, department_id, status, deleted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('foreign', 'org-b', foreign.id, 'active', null);

    try {
      const result = structure.listOrganizationStructure('org-a');
      expect(result.map(({ name }) => name)).toEqual(['alpha', 'Beta']);
      expect(result[0]).toMatchObject({ memberCount: 1 });
      expect(result[0]?.positions.map(({ title }) => title)).toEqual([
        'analyst',
        'Writer',
      ]);
      expect(result.some(({ id }) => id === foreign.id)).toBe(false);
    } finally {
      database.close();
    }
  });

  it('renames a department atomically across accounts, employees and invites', () => {
    const database = createDatabase();
    insertOrganization(database, 'org-a');
    insertOrganization(database, 'org-b');
    const structure = createOrganizationStructureFacade(createStore(database));
    const department = structure.createOrganizationDepartment({
      organizationId: 'org-a',
      name: 'Sales',
    });
    database
      .prepare(
        `INSERT INTO accounts (id, organization_id, department, department_id)
         VALUES ('account', 'org-a', 'Sales', ?)`,
      )
      .run(department.id);
    database
      .prepare(
        `INSERT INTO employees (id, organization_id, department, department_id)
         VALUES ('employee', 'org-a', 'Sales', ?)`,
      )
      .run(department.id);
    database
      .prepare(
        `INSERT INTO organization_invites
         (id, organization_id, default_department, department_id)
         VALUES ('invite', 'org-a', 'Sales', ?)`,
      )
      .run(department.id);

    try {
      expect(
        structure.updateOrganizationDepartment({
          organizationId: 'org-a',
          departmentId: department.id,
          name: 'Revenue',
        }),
      ).toMatchObject({ name: 'Revenue' });
      expect(
        database
          .prepare('SELECT department FROM accounts WHERE id = ?')
          .get('account'),
      ).toEqual({ department: 'Revenue' });
      expect(
        database
          .prepare('SELECT department FROM employees WHERE id = ?')
          .get('employee'),
      ).toEqual({ department: 'Revenue' });
      expect(
        database
          .prepare(
            'SELECT default_department FROM organization_invites WHERE id = ?',
          )
          .get('invite'),
      ).toEqual({ default_department: 'Revenue' });
      expect(() =>
        structure.updateOrganizationDepartment({
          organizationId: 'org-b',
          departmentId: department.id,
          name: 'Cross tenant',
        }),
      ).toThrow('部门不存在');
    } finally {
      database.close();
    }
  });

  it('rolls back a department rename when a dependent update fails', () => {
    const database = createDatabase();
    insertOrganization(database, 'org-a');
    const structure = createOrganizationStructureFacade(createStore(database));
    const department = structure.createOrganizationDepartment({
      organizationId: 'org-a',
      name: 'Before',
    });
    database
      .prepare(
        `INSERT INTO accounts (id, organization_id, department, department_id)
         VALUES ('account', 'org-a', 'Before', ?)`,
      )
      .run(department.id);
    database.exec(`
      CREATE TRIGGER fail_department_sync
      BEFORE UPDATE OF department ON accounts
      BEGIN
        SELECT RAISE(ABORT, 'forced department sync failure');
      END;
    `);

    try {
      expect(() =>
        structure.updateOrganizationDepartment({
          organizationId: 'org-a',
          departmentId: department.id,
          name: 'After',
        }),
      ).toThrow('forced department sync failure');
      expect(structure.listOrganizationStructure('org-a')[0]?.name).toBe(
        'Before',
      );
    } finally {
      database.close();
    }
  });

  it('protects referenced nodes and the last active enterprise admin', () => {
    const database = createDatabase();
    insertOrganization(database, 'org-a');
    const structure = createOrganizationStructureFacade(createStore(database));
    const department = structure.createOrganizationDepartment({
      organizationId: 'org-a',
      name: 'Operations',
    });
    const position = structure.createOrganizationPosition({
      organizationId: 'org-a',
      departmentId: department.id,
      title: 'Director',
      roleMapping: 'enterprise_admin',
    });
    database
      .prepare(
        `INSERT INTO accounts
         (id, organization_id, department_id, position_id, is_admin)
         VALUES ('mapped-admin', 'org-a', ?, ?, 1)`,
      )
      .run(department.id, position.id);

    try {
      expect(() =>
        structure.updateOrganizationPosition({
          organizationId: 'org-a',
          positionId: position.id,
          roleMapping: 'member',
        }),
      ).toThrow('企业至少需要保留一名可登录管理员');
      expect(() =>
        structure.deleteOrganizationPosition({
          organizationId: 'org-a',
          positionId: position.id,
        }),
      ).toThrow('职位仍有成员，不能删除');
      expect(() =>
        structure.deleteOrganizationDepartment({
          organizationId: 'org-a',
          departmentId: department.id,
        }),
      ).toThrow(/部门仍有岗位|部门仍有成员/);
    } finally {
      database.close();
    }
  });

  it('updates mapped identities, revokes sessions and rolls back on audit failure', () => {
    const database = createDatabase();
    insertOrganization(database, 'org-a');
    const audit = vi.fn();
    const structure = createOrganizationStructureFacade(
      createStore(database, audit),
    );
    const department = structure.createOrganizationDepartment({
      organizationId: 'org-a',
      name: 'Engineering',
    });
    const position = structure.createOrganizationPosition({
      organizationId: 'org-a',
      departmentId: department.id,
      title: 'Lead',
      roleMapping: 'enterprise_admin',
    });
    database
      .prepare(
        `INSERT INTO accounts
         (id, organization_id, department_id, position_id, position_title, role, is_admin)
         VALUES ('mapped', 'org-a', ?, ?, 'Lead', '企业管理员', 1)`,
      )
      .run(department.id, position.id);
    database
      .prepare(
        `INSERT INTO accounts (id, organization_id, is_admin)
         VALUES ('guard', 'org-a', 1)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO employees
         (id, organization_id, department_id, position_id, position_title, role)
         VALUES ('employee', 'org-a', ?, ?, 'Lead', '企业管理员')`,
      )
      .run(department.id, position.id);
    database
      .prepare(
        `INSERT INTO organization_invites
         (id, organization_id, department_id, position_id, position_title, default_role)
         VALUES ('invite', 'org-a', ?, ?, 'Lead', '企业管理员')`,
      )
      .run(department.id, position.id);
    database
      .prepare(
        `INSERT INTO auth_sessions (id, account_id) VALUES ('session', 'mapped')`,
      )
      .run();

    try {
      expect(
        structure.updateOrganizationPosition({
          organizationId: 'org-a',
          positionId: position.id,
          title: 'Manager',
          roleMapping: 'department_admin',
        }),
      ).toMatchObject({ title: 'Manager', roleMapping: 'department_admin' });
      expect(
        database
          .prepare(
            'SELECT position_title, role, is_admin FROM accounts WHERE id = ?',
          )
          .get('mapped'),
      ).toEqual({
        position_title: 'Manager',
        role: '部门管理员',
        is_admin: 0,
      });
      expect(
        database
          .prepare('SELECT revoked_at FROM auth_sessions WHERE id = ?')
          .get('session'),
      ).toEqual({ revoked_at: expect.any(String) });
      expect(audit).toHaveBeenCalledWith(
        'organization_position_update',
        null,
        expect.stringContaining(position.id),
        'org-a',
      );

      const failing = createOrganizationStructureFacade(
        createStore(database, () => {
          throw new Error('forced audit failure');
        }),
      );
      expect(() =>
        failing.updateOrganizationPosition({
          organizationId: 'org-a',
          positionId: position.id,
          title: 'Should roll back',
        }),
      ).toThrow('forced audit failure');
      expect(
        structure
          .listOrganizationStructure('org-a')[0]
          ?.positions.find(({ id }) => id === position.id)?.title,
      ).toBe('Manager');
    } finally {
      database.close();
    }
  });
});
