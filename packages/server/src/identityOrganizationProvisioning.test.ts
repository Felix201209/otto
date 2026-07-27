/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createOrganizationProvisioningFacade,
  type AccountLifecycleView,
  type OrganizationProvisioningOrganizationView,
  type OrganizationProvisioningRepositoryStore,
} from './modules/identity_organization/index.js';

interface TestOrganizationView extends OrganizationProvisioningOrganizationView {
  inviteSecret: string;
}

interface TestAccountView extends AccountLifecycleView {
  tags: string[];
}

interface TestInviteView {
  id: string;
  organizationId: string;
  createdByAccountId: string;
  issuedAtMs: number;
}

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      invite_secret TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      phone TEXT UNIQUE,
      role TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE account_tags (
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (organization_id, account_id, tag)
    );
    CREATE TABLE organization_invites (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      created_by_account_id TEXT NOT NULL,
      issued_at_ms INTEGER NOT NULL
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
  options: { failAudit?: boolean; failInvite?: boolean } = {},
): OrganizationProvisioningRepositoryStore<
  TestOrganizationView,
  TestAccountView,
  TestInviteView
> {
  let organizationSequence = 0;
  let accountSequence = 0;
  let inviteSequence = 0;

  const getOrganization = (id: string): TestOrganizationView | null => {
    const row = database
      .prepare('SELECT * FROM organizations WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
      inviteSecret: String(row.invite_secret),
      status: row.status === 'disabled' ? 'disabled' : 'active',
    };
  };

  return {
    db: () => database,
    now: () => 1_000,
    createOrganizationId: () => `org_${++organizationSequence}`,
    createInviteSecret: () => `secret_${organizationSequence}`,
    createDefaultSlugSuffix: () => `generated-${organizationSequence + 1}`,
    getOrganization,
    createAccount(input) {
      const id = `acc_${++accountSequence}`;
      database
        .prepare(
          `INSERT INTO accounts
           (id, organization_id, username, name, phone, role, is_admin, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.organizationId,
          input.username,
          input.name,
          input.phone ?? null,
          input.role ?? null,
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
      return {
        id,
        organizationId: input.organizationId!,
        accountType: 'enterprise',
        employeeId: null,
        username: input.username,
        name: input.name,
        role: input.role ?? null,
        department: null,
        departmentId: null,
        positionId: null,
        positionTitle: null,
        isAdmin: Boolean(input.isAdmin),
        status: input.status ?? 'active',
        tags: [...(input.tags ?? [])],
      };
    },
    issueOrganizationInvite(organizationId, now, createdByAccountId) {
      if (options.failInvite) throw new Error('forced invite failure');
      const invite = {
        id: `invite_${++inviteSequence}`,
        organizationId,
        createdByAccountId,
        issuedAtMs: now,
      };
      database
        .prepare(
          `INSERT INTO organization_invites
           (id, organization_id, created_by_account_id, issued_at_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run(invite.id, organizationId, createdByAccountId, now);
      return invite;
    },
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

function tableCount(database: Database, table: string): number {
  return Number(
    (
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );
}

describe('identity_organization organization provisioning kernel', () => {
  it('creates a normalized organization with an independent secret and audit', () => {
    const database = createDatabase();
    const organizations = createOrganizationProvisioningFacade(
      createStore(database),
    );

    try {
      const created = organizations.createOrganization({
        name: '  Acme 科技  ',
        slug: ' Acme-Labs ',
      });
      expect(created).toMatchObject({
        id: 'org_1',
        name: 'Acme 科技',
        slug: 'acme-labs',
        inviteSecret: 'secret_1',
        status: 'active',
      });
      expect(
        database
          .prepare(
            'SELECT action, organization_id AS organizationId FROM audit_events',
          )
          .get(),
      ).toEqual({
        action: 'organization_create',
        organizationId: 'org_1',
      });
      expect(() =>
        organizations.createOrganization({ name: 'Acme', slug: '***' }),
      ).toThrow('企业标识只能使用字母、数字和连字符');
    } finally {
      database.close();
    }
  });

  it('rolls back standalone organization creation when audit fails', () => {
    const database = createDatabase();
    const organizations = createOrganizationProvisioningFacade(
      createStore(database, { failAudit: true }),
    );

    try {
      expect(() =>
        organizations.createOrganization({ name: 'Rollback Ltd' }),
      ).toThrow('forced audit failure');
      expect(tableCount(database, 'organizations')).toBe(0);
    } finally {
      database.close();
    }
  });

  it('provisions the organization, first admin and invite atomically', () => {
    const database = createDatabase();
    const organizations = createOrganizationProvisioningFacade(
      createStore(database),
    );

    try {
      const provisioned = organizations.provisionOrganization({
        name: 'Tenant One',
        slug: 'Tenant-One',
        admin: {
          username: 'ceo',
          password: 'secure-password',
          name: 'CEO',
          phone: '13800138000',
        },
        now: 2_000,
      });
      expect(provisioned.organization.slug).toBe('tenant-one');
      expect(provisioned.admin).toMatchObject({
        organizationId: provisioned.organization.id,
        role: '企业管理员',
        isAdmin: true,
        tags: ['企业管理员'],
      });
      expect(provisioned.invite).toMatchObject({
        organizationId: provisioned.organization.id,
        createdByAccountId: provisioned.admin.id,
        issuedAtMs: 2_000,
      });
    } finally {
      database.close();
    }
  });

  it('does not leave an orphan organization when the admin conflicts', () => {
    const database = createDatabase();
    database
      .prepare(
        `INSERT INTO accounts
         (id, organization_id, username, name, role, is_admin, status)
         VALUES ('existing', 'other', 'ceo', 'Existing', NULL, 0, 'active')`,
      )
      .run();
    const organizations = createOrganizationProvisioningFacade(
      createStore(database),
    );

    try {
      expect(() =>
        organizations.provisionOrganization({
          name: 'Conflict Tenant',
          admin: {
            username: 'ceo',
            password: 'secure-password',
            name: 'CEO',
          },
        }),
      ).toThrow();
      expect(tableCount(database, 'organizations')).toBe(0);
      expect(tableCount(database, 'organization_invites')).toBe(0);
      expect(tableCount(database, 'audit_events')).toBe(0);
    } finally {
      database.close();
    }
  });

  it('rolls back the organization, admin, tags and audit when invite issuance fails', () => {
    const database = createDatabase();
    const organizations = createOrganizationProvisioningFacade(
      createStore(database, { failInvite: true }),
    );

    try {
      expect(() =>
        organizations.provisionOrganization({
          name: 'Invite Failure Tenant',
          admin: {
            username: 'failure-ceo',
            password: 'secure-password',
            name: 'CEO',
          },
        }),
      ).toThrow('forced invite failure');
      expect(tableCount(database, 'organizations')).toBe(0);
      expect(tableCount(database, 'accounts')).toBe(0);
      expect(tableCount(database, 'account_tags')).toBe(0);
      expect(tableCount(database, 'audit_events')).toBe(0);
    } finally {
      database.close();
    }
  });
});
