/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createAccountRegistrationFacade,
  type AccountRegistrationRepositoryStore,
  type AccountRegistrationView,
} from './modules/identity_organization/index.js';

interface TestAccountView extends AccountRegistrationView {
  phone: string | null;
  tags: string[];
}

interface TestOrganizationView {
  id: string;
  name: string;
  status: 'active' | 'disabled';
}

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL
    );
    CREATE TABLE organization_departments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE organization_positions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      department_id TEXT NOT NULL,
      title TEXT NOT NULL,
      role_mapping TEXT NOT NULL
    );
    CREATE TABLE organization_invites (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      department_id TEXT,
      position_id TEXT,
      default_role TEXT,
      revoked_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0
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
      invite_code TEXT
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      account_type TEXT NOT NULL,
      employee_id TEXT,
      username TEXT NOT NULL UNIQUE,
      phone TEXT UNIQUE,
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      deleted_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE account_tags (
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (organization_id, account_id, tag)
    );
    CREATE TABLE auth_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
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
  options: { failAccountCreation?: boolean } = {},
): AccountRegistrationRepositoryStore<TestAccountView, TestOrganizationView> {
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
      phone: row.phone == null ? null : String(row.phone),
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
  const normalizePhone = (phone: string): string => {
    const digits = phone.replace(/\D/g, '').replace(/^86/, '');
    if (!/^1[3-9]\d{9}$/.test(digits)) throw new Error('invalid phone');
    return `+86${digits}`;
  };

  return {
    db: () => database,
    now: () => 1_000,
    normalizePhone,
    findAccountByPhone(phone) {
      const normalized = normalizePhone(phone);
      const row = database
        .prepare(
          'SELECT id FROM accounts WHERE phone = ? AND deleted_at IS NULL',
        )
        .get(normalized) as { id: string } | undefined;
      return row ? getAccount(row.id) : null;
    },
    createId: (prefix) => `${prefix}_${++nextId}`,
    createUsernameSuffix: () => `suffix${++nextId}`,
    createPersonalSlugSuffix: () => `personal${++nextId}`,
    resolveAssignmentIdentity(_database, _organizationId, input) {
      return {
        departmentId: input.departmentId || null,
        positionId: input.positionId || null,
      };
    },
    createEmployee(input) {
      database
        .prepare(
          `INSERT INTO employees
           (id, organization_id, name, role, department, department_id,
            position_id, position_title, invite_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.inviteCode ?? null,
        );
    },
    createAccount(input) {
      if (options.failAccountCreation) {
        throw new Error('forced account creation failure');
      }
      const id = `account_${++nextId}`;
      database
        .prepare(
          `INSERT INTO accounts
           (id, organization_id, account_type, employee_id, username, phone,
            name, role, department, department_id, position_id, position_title,
            is_admin, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.organizationId,
          input.accountType ?? 'enterprise',
          input.employeeId ?? null,
          input.username,
          input.phone ? normalizePhone(input.phone) : null,
          input.name,
          input.role ?? null,
          input.department ?? null,
          input.departmentId ?? null,
          input.positionId ?? null,
          input.positionTitle ?? null,
          input.isAdmin ? 1 : 0,
          input.status ?? 'active',
        );
      for (const tag of input.tags ?? []) {
        database
          .prepare(
            `INSERT INTO account_tags (organization_id, account_id, tag)
             VALUES (?, ?, ?)`,
          )
          .run(input.organizationId, id, tag);
      }
      return getAccount(id, input.organizationId)!;
    },
    createOrganization(input) {
      const organization = {
        id: `organization_${++nextId}`,
        name: input.name,
        status: 'active' as const,
      };
      database
        .prepare(
          `INSERT INTO organizations (id, name, slug, status)
           VALUES (?, ?, ?, 'active')`,
        )
        .run(organization.id, organization.name, input.slug);
      return organization;
    },
    getAccount,
    resolveOrganizationInviteWithDefaults(code, now) {
      const row = database
        .prepare(
          `SELECT i.*, o.name AS organization_name, o.status AS organization_status
           FROM organization_invites i
           JOIN organizations o ON o.id = i.organization_id
           WHERE i.code = ? AND i.revoked_at_ms IS NULL AND i.expires_at_ms > ?
             AND (i.max_uses IS NULL OR i.used_count < i.max_uses)
             AND o.status = 'active'`,
        )
        .get(code.trim().toUpperCase(), now) as
        Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        organization: {
          id: String(row.organization_id),
          name: String(row.organization_name),
          status: 'active',
        },
        inviteId: String(row.id),
        defaultDepartment: null,
        departmentId:
          row.department_id == null ? null : String(row.department_id),
        positionId: row.position_id == null ? null : String(row.position_id),
        positionTitle: null,
        defaultRole: row.default_role == null ? null : String(row.default_role),
      };
    },
    normalizeOrganizationInviteCode: (code) => code.trim().toUpperCase(),
    replaceMigratedAccountTags(accountId, organizationId, tags) {
      database
        .prepare('DELETE FROM account_tags WHERE account_id = ?')
        .run(accountId);
      const insert = database.prepare(
        `INSERT INTO account_tags (organization_id, account_id, tag)
         VALUES (?, ?, ?)`,
      );
      for (const tag of tags) insert.run(organizationId, accountId, tag);
    },
    logAudit(action, employeeId, detail, organizationId) {
      database
        .prepare(
          `INSERT INTO audit_events (action, employee_id, detail, organization_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run(action, employeeId, detail, organizationId);
    },
  };
}

function seedEnterprise(database: Database): void {
  database.exec(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES ('org-enterprise', 'Enterprise', 'enterprise', 'active');
    INSERT INTO organization_departments (id, organization_id, name)
    VALUES ('dept-admin', 'org-enterprise', 'Management');
    INSERT INTO organization_positions
      (id, organization_id, department_id, title, role_mapping)
    VALUES
      ('pos-admin', 'org-enterprise', 'dept-admin', 'CEO', 'enterprise_admin');
    INSERT INTO organization_invites
      (id, organization_id, code, department_id, position_id, default_role,
       expires_at_ms, max_uses, used_count)
    VALUES
      ('invite-1', 'org-enterprise', 'INVITE-CODE', 'dept-admin', 'pos-admin',
       'Member', 10000, 1, 0);
  `);
}

describe('identity_organization account registration kernel', () => {
  it('creates each ordinary registration in an isolated personal organization', () => {
    const database = createDatabase();
    const registrations = createAccountRegistrationFacade(
      createStore(database),
    );

    try {
      const first = registrations.createPersonalRegisteredAccount({
        phone: '13800138000',
        name: 'Alice',
        password: 'secure-password',
      });
      const second = registrations.createPersonalRegisteredAccount({
        phone: '13900139000',
        name: 'Bob',
        password: 'secure-password',
      });
      expect(first).toMatchObject({
        accountType: 'personal',
        role: '个人用户',
      });
      expect(second.accountType).toBe('personal');
      expect(first.organizationId).not.toBe(second.organizationId);
      expect(() =>
        registrations.createPersonalRegisteredAccount({
          phone: '13800138000',
          name: 'Duplicate',
          password: 'secure-password',
        }),
      ).toThrow('该手机号已注册，请直接登录');
    } finally {
      database.close();
    }
  });

  it('revalidates invitation assignment and consumes capacity atomically', () => {
    const database = createDatabase();
    seedEnterprise(database);
    const registrations = createAccountRegistrationFacade(
      createStore(database),
    );

    try {
      const account = registrations.createSelfRegisteredAccount({
        organizationId: 'org-enterprise',
        phone: '13800138000',
        name: 'Invited Admin',
        password: 'secure-password',
        organizationInviteId: 'invite-1',
      });
      expect(account).toMatchObject({
        organizationId: 'org-enterprise',
        departmentId: 'dept-admin',
        positionId: 'pos-admin',
        role: '企业管理员',
        isAdmin: true,
      });
      expect(
        database
          .prepare(
            'SELECT used_count AS usedCount FROM organization_invites WHERE id = ?',
          )
          .get('invite-1'),
      ).toEqual({ usedCount: 1 });
    } finally {
      database.close();
    }
  });

  it('rolls back the employee when invited account creation fails', () => {
    const database = createDatabase();
    seedEnterprise(database);
    const registrations = createAccountRegistrationFacade(
      createStore(database, { failAccountCreation: true }),
    );

    try {
      expect(() =>
        registrations.createSelfRegisteredAccount({
          organizationId: 'org-enterprise',
          phone: '13800138000',
          name: 'Rollback',
          password: 'secure-password',
          organizationInviteId: 'invite-1',
        }),
      ).toThrow('forced account creation failure');
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM employees').get(),
      ).toEqual({
        count: 0,
      });
      expect(
        database
          .prepare(
            'SELECT used_count AS usedCount FROM organization_invites WHERE id = ?',
          )
          .get('invite-1'),
      ).toEqual({ usedCount: 0 });
    } finally {
      database.close();
    }
  });

  it('moves a personal account, active session and tags into the invited tenant', () => {
    const database = createDatabase();
    seedEnterprise(database);
    const store = createStore(database);
    const registrations = createAccountRegistrationFacade(store);

    try {
      const personal = registrations.createPersonalRegisteredAccount({
        phone: '13800138000',
        name: 'Future Member',
        password: 'secure-password',
      });
      database
        .prepare(
          `INSERT INTO account_tags (organization_id, account_id, tag)
           VALUES (?, ?, 'personal-tag')`,
        )
        .run(personal.organizationId, personal.id);
      database
        .prepare(
          `INSERT INTO auth_sessions (id, organization_id, account_id)
           VALUES ('session-1', ?, ?)`,
        )
        .run(personal.organizationId, personal.id);

      const joined = registrations.joinOrganizationWithInvite(
        personal.id,
        'invite-code',
        1_000,
      );
      expect(joined).toMatchObject({
        accountType: 'enterprise',
        organizationId: 'org-enterprise',
        role: '企业管理员',
        tags: ['普通成员'],
      });
      expect(
        database
          .prepare('SELECT organization_id FROM auth_sessions WHERE id = ?')
          .get('session-1'),
      ).toEqual({ organization_id: 'org-enterprise' });
      expect(
        database
          .prepare(
            `SELECT organization_id AS organizationId, tag
             FROM account_tags WHERE account_id = ? ORDER BY tag`,
          )
          .all(personal.id),
      ).toEqual([{ organizationId: 'org-enterprise', tag: '普通成员' }]);
    } finally {
      database.close();
    }
  });
});
