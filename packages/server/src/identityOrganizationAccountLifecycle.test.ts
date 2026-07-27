/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createAccountLifecycleFacade,
  type AccountLifecycleAssignment,
  type AccountLifecycleRepositoryStore,
  type AccountLifecycleView,
} from './modules/identity_organization/index.js';

interface TestAccountView extends AccountLifecycleView {
  tags: string[];
}

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE organization_positions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      role_mapping TEXT NOT NULL
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      account_type TEXT NOT NULL,
      employee_id TEXT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT UNIQUE,
      feishu_open_id TEXT,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      avatar_url TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE account_tags (
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (organization_id, account_id, tag)
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
      status TEXT NOT NULL DEFAULT 'active',
      offboarded_at TEXT
    );
    CREATE TABLE auth_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE audit_events (
      action TEXT NOT NULL,
      employee_id TEXT,
      detail TEXT NOT NULL,
      organization_id TEXT NOT NULL
    );
  `);
  return database;
}

function createStore(
  database: Database,
  options: { failAudit?: boolean } = {},
): AccountLifecycleRepositoryStore<TestAccountView> {
  let nextId = 0;
  const getAccount = (
    id: string,
    organizationId?: string,
  ): TestAccountView | null => {
    const row = (
      organizationId
        ? database
            .prepare(
              `SELECT * FROM accounts
               WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
            )
            .get(id, organizationId)
        : database
            .prepare(
              'SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL',
            )
            .get(id)
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    const tags = database
      .prepare(
        `SELECT tag FROM account_tags
         WHERE account_id = ? AND organization_id = ? ORDER BY tag`,
      )
      .all(id, row.organization_id) as Array<{ tag: string }>;
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      accountType: row.account_type === 'personal' ? 'personal' : 'enterprise',
      employeeId: row.employee_id == null ? null : String(row.employee_id),
      username: String(row.username),
      name: String(row.name),
      role: row.role == null ? null : String(row.role),
      department: row.department == null ? null : String(row.department),
      departmentId:
        row.department_id == null ? null : String(row.department_id),
      positionId: row.position_id == null ? null : String(row.position_id),
      positionTitle:
        row.position_title == null ? null : String(row.position_title),
      isAdmin: row.is_admin === 1,
      status: row.status === 'disabled' ? 'disabled' : 'active',
      tags: tags.map(({ tag }) => tag),
    };
  };

  return {
    db: () => database,
    defaultOrganizationId: 'org-a',
    organizationExists: (organizationId) =>
      Boolean(
        database
          .prepare('SELECT 1 FROM organizations WHERE id = ?')
          .get(organizationId),
      ),
    normalizeUsername: (username) => username.trim().toLowerCase(),
    normalizeOptionalPhone(value) {
      if (value == null || !value.trim()) return null;
      return `+86${value.replace(/\D/g, '').replace(/^86/, '')}`;
    },
    normalizeOptionalFeishuOpenId: (value) => value?.trim() || null,
    normalizeOptionalAvatarUrl: (value) => value?.trim() || null,
    normalizeTags: (tags) =>
      [
        ...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
      ].sort(),
    assertPassword(password) {
      if (password.length < 8) throw new Error('password too short');
    },
    hashPassword: (password) => `hash:${password}`,
    createId: (prefix) => `${prefix}_${++nextId}`,
    createDeletionPasswordHash: () => 'hash:deleted-secret',
    resolveAssignment(_database, organizationId, input) {
      const position = input.positionId
        ? (database
            .prepare(
              `SELECT role_mapping FROM organization_positions
               WHERE id = ? AND organization_id = ?`,
            )
            .get(input.positionId, organizationId) as
            | { role_mapping: AccountLifecycleAssignment['roleMapping'] }
            | undefined)
        : undefined;
      return {
        department: input.department?.trim() || null,
        departmentId: input.departmentId || null,
        positionId: input.positionId || null,
        positionTitle: input.positionTitle?.trim() || null,
        roleMapping: position?.role_mapping ?? null,
      };
    },
    createEmployee(input) {
      database
        .prepare(
          `INSERT INTO employees
           (id, organization_id, name, role, department, department_id,
            position_id, position_title)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.organizationId,
          input.name,
          input.role ?? null,
          input.department ?? null,
          input.departmentId ?? null,
          input.positionId ?? null,
          input.positionTitle ?? null,
        );
    },
    getAccount,
    logAudit(action, employeeId, detail, organizationId) {
      if (options.failAudit) throw new Error('forced audit failure');
      database
        .prepare(
          `INSERT INTO audit_events (action, employee_id, detail, organization_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run(action, employeeId, detail, organizationId);
    },
  };
}

function seedOrganization(database: Database, id: string): void {
  database
    .prepare("INSERT INTO organizations (id, status) VALUES (?, 'active')")
    .run(id);
}

describe('identity_organization account lifecycle kernel', () => {
  it('creates an enterprise account and employee atomically from position authority', () => {
    const database = createDatabase();
    seedOrganization(database, 'org-a');
    database
      .prepare(
        `INSERT INTO organization_positions (id, organization_id, role_mapping)
         VALUES ('pos-admin', 'org-a', 'enterprise_admin')`,
      )
      .run();
    const store = createStore(database);
    const accounts = createAccountLifecycleFacade(store);

    try {
      const created = accounts.createAccount({
        username: ' Admin.User ',
        password: 'secure-password',
        name: ' Admin ',
        phone: '13800138000',
        department: '管理部',
        departmentId: 'dept-admin',
        positionId: 'pos-admin',
        positionTitle: '负责人',
        role: '成员',
        isAdmin: false,
        tags: [' CEO ', 'CEO'],
      });

      expect(created).toMatchObject({
        organizationId: 'org-a',
        username: 'admin.user',
        name: 'Admin',
        role: '企业管理员',
        isAdmin: true,
        tags: ['CEO'],
      });
      expect(created.employeeId).toMatch(/^emp_/);
      expect(
        database
          .prepare('SELECT name, role FROM employees WHERE id = ?')
          .get(created.employeeId),
      ).toEqual({ name: 'Admin', role: '企业管理员' });
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM audit_events').get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('rolls back account, employee and tags when creation audit fails', () => {
    const database = createDatabase();
    seedOrganization(database, 'org-a');
    const accounts = createAccountLifecycleFacade(
      createStore(database, { failAudit: true }),
    );

    try {
      expect(() =>
        accounts.createAccount({
          username: 'rollback-user',
          password: 'secure-password',
          name: 'Rollback',
          tags: ['IT'],
        }),
      ).toThrow('forced audit failure');
      for (const table of ['accounts', 'employees', 'account_tags']) {
        expect(
          database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
      }
    } finally {
      database.close();
    }
  });

  it('isolates updates, protects the last admin and revokes changed sessions', () => {
    const database = createDatabase();
    seedOrganization(database, 'org-a');
    seedOrganization(database, 'org-b');
    const accounts = createAccountLifecycleFacade(createStore(database));

    try {
      const admin = accounts.createAccount({
        organizationId: 'org-a',
        username: 'admin-a',
        password: 'secure-password',
        name: 'Admin A',
        isAdmin: true,
      });
      const member = accounts.createAccount({
        organizationId: 'org-a',
        username: 'member-a',
        password: 'secure-password',
        name: 'Member A',
      });
      accounts.createAccount({
        organizationId: 'org-b',
        username: 'admin-b',
        password: 'secure-password',
        name: 'Admin B',
        isAdmin: true,
      });
      database
        .prepare(
          "INSERT INTO auth_sessions (id, account_id) VALUES ('session-member', ?)",
        )
        .run(member.id);

      expect(() =>
        accounts.updateAccount(member.id, { name: 'Cross tenant' }, 'org-b'),
      ).toThrow('Account not found');
      const updated = accounts.updateAccount(
        member.id,
        { name: 'Member Updated', password: 'new-secure-password' },
        'org-a',
      );
      expect(updated.name).toBe('Member Updated');
      expect(
        database
          .prepare('SELECT name FROM employees WHERE id = ?')
          .get(member.employeeId),
      ).toEqual({ name: 'Member Updated' });
      expect(
        database
          .prepare('SELECT revoked_at FROM auth_sessions WHERE id = ?')
          .get('session-member'),
      ).toEqual({ revoked_at: expect.any(String) });
      expect(() =>
        accounts.updateAccount(
          admin.id,
          { status: 'disabled', isAdmin: false },
          'org-a',
        ),
      ).toThrow('企业至少需要保留一名可登录管理员');
    } finally {
      database.close();
    }
  });

  it('soft deletes within the tenant and scrubs identity data', () => {
    const database = createDatabase();
    seedOrganization(database, 'org-a');
    seedOrganization(database, 'org-b');
    const store = createStore(database);
    const accounts = createAccountLifecycleFacade(store);

    try {
      const admin = accounts.createAccount({
        organizationId: 'org-a',
        username: 'admin-a',
        password: 'secure-password',
        name: 'Admin A',
        isAdmin: true,
      });
      const member = accounts.createAccount({
        organizationId: 'org-a',
        username: 'member-a',
        password: 'secure-password',
        name: 'Member A',
        phone: '13800138000',
        tags: ['IT'],
      });
      database
        .prepare(
          "INSERT INTO auth_sessions (id, account_id) VALUES ('session-delete', ?)",
        )
        .run(member.id);

      expect(() =>
        accounts.deleteAccount(member.id, 'org-a', member.id),
      ).toThrow('不能删除当前登录账号');
      expect(() =>
        accounts.deleteAccount(member.id, 'org-b', admin.id),
      ).toThrow('Account not found');
      expect(accounts.deleteAccount(member.id, 'org-a', admin.id)).toEqual({
        id: member.id,
        deleted: true,
      });

      expect(store.getAccount(member.id, 'org-a')).toBeNull();
      expect(
        database
          .prepare(
            `SELECT phone, feishu_open_id, is_admin, status, deleted_at
             FROM accounts WHERE id = ?`,
          )
          .get(member.id),
      ).toEqual({
        phone: null,
        feishu_open_id: null,
        is_admin: 0,
        status: 'disabled',
        deleted_at: expect.any(String),
      });
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM account_tags WHERE account_id = ?',
          )
          .get(member.id),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare('SELECT status FROM employees WHERE id = ?')
          .get(member.employeeId),
      ).toEqual({ status: 'offboarded' });
      expect(
        database
          .prepare('SELECT revoked_at FROM auth_sessions WHERE id = ?')
          .get('session-delete'),
      ).toEqual({ revoked_at: expect.any(String) });
    } finally {
      database.close();
    }
  });
});
