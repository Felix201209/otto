/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createParkMembershipFacade,
  type ParkMembershipRepositoryStore,
  type ParkMembershipPark,
} from './modules/park_services/index.js';
import { Database } from './modules/data_platform/index.js';

const INVITE_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      park_id TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      is_admin INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE parks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      invite_secret TEXT NOT NULL,
      admin_organization_id TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE park_invites (
      id TEXT PRIMARY KEY,
      park_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_by_account_id TEXT NOT NULL,
      revoked_at_ms INTEGER,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE park_tenant_profiles (
      organization_id TEXT PRIMARY KEY,
      park_id TEXT NOT NULL,
      address TEXT NOT NULL,
      room_number TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    INSERT INTO organizations (id, park_id) VALUES
      ('park-org', 'park-1'), ('tenant-a', NULL), ('tenant-b', NULL);
    INSERT INTO accounts (id, organization_id, is_admin, status) VALUES
      ('park-admin', 'park-org', 1, 'active'),
      ('park-member', 'park-org', 0, 'active'),
      ('tenant-a-admin', 'tenant-a', 1, 'active'),
      ('tenant-a-member', 'tenant-a', 0, 'active'),
      ('tenant-b-admin', 'tenant-b', 1, 'active');
    INSERT INTO parks
      (id, name, slug, invite_secret, admin_organization_id, brand_name, status)
    VALUES
      ('park-1', '科技园', 'tech-park', 'test-secret', 'park-org', '科技园服务', 'active');
  `);
  return database;
}

function toPark(row: Record<string, unknown>): ParkMembershipPark {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    brandName: String(row.brand_name),
    adminOrganizationId: String(row.admin_organization_id),
    status: row.status as ParkMembershipPark['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function createStore(database: Database): ParkMembershipRepositoryStore {
  let sequence = 0;
  const getPark = (parkId: string): ParkMembershipPark | null => {
    const row = database
      .prepare('SELECT * FROM parks WHERE id = ?')
      .get(parkId) as Record<string, unknown> | undefined;
    return row ? toPark(row) : null;
  };
  return {
    db: () => database,
    getAccount: (accountId, organizationId) => {
      const row = database
        .prepare(
          `SELECT id, organization_id, is_admin, status FROM accounts
           WHERE id = ? AND (? IS NULL OR organization_id = ?)`,
        )
        .get(accountId, organizationId ?? null, organizationId ?? null) as
        Record<string, unknown> | undefined;
      return row
        ? {
            id: String(row.id),
            isAdmin: Boolean(row.is_admin),
            status: String(row.status),
          }
        : null;
    },
    getPark,
    getParkForOrganization: (organizationId) => {
      const row = database
        .prepare(
          `SELECT p.* FROM organizations o
           JOIN parks p ON p.id = o.park_id WHERE o.id = ?`,
        )
        .get(organizationId) as Record<string, unknown> | undefined;
      return row ? toPark(row) : null;
    },
    createInviteId: () => `park-invite-${++sequence}`,
    createInviteNonce: () => `nonce-${sequence}`,
    inviteValidityMs: 60_000,
    inviteAlphabet: INVITE_ALPHABET,
    inviteCodeRawLength: 12,
    normalizeInviteCode: (value) => value.trim().replaceAll('-', ''),
    normalizeOptionalText: (value, _field, maxLength = 200) => {
      const normalized = value.trim();
      if (normalized.length > maxLength) throw new Error('字段过长');
      return normalized || null;
    },
  };
}

describe('park services membership kernel', () => {
  it('joins the whole organization once and persists its tenant profile', () => {
    const database = createDatabase();
    const membership = createParkMembershipFacade(createStore(database));

    try {
      const invite = membership.issueInvite({
        parkId: 'park-1',
        actorAccountId: 'park-admin',
        maxUses: 1,
        now: 1_000,
      });
      expect(invite).toMatchObject({
        status: 'active',
        usedCount: 0,
        maxUses: 1,
      });

      expect(
        membership.joinOrganization({
          organizationId: 'tenant-a',
          actorAccountId: 'tenant-a-admin',
          code: invite.code,
          address: ' A 座 ',
          roomNumber: ' 101 ',
          now: 2_000,
        }),
      ).toMatchObject({ id: 'park-1', adminOrganizationId: 'park-org' });
      expect(membership.getTenantProfile('tenant-a')).toMatchObject({
        parkId: 'park-1',
        address: 'A 座',
        roomNumber: '101',
      });
      expect(
        database
          .prepare('SELECT park_id FROM organizations WHERE id = ?')
          .get('tenant-a'),
      ).toMatchObject({ park_id: 'park-1' });

      expect(() =>
        membership.joinOrganization({
          organizationId: 'tenant-b',
          actorAccountId: 'tenant-b-admin',
          code: invite.code,
          address: 'B 座',
          roomNumber: '201',
          now: 2_001,
        }),
      ).toThrow('产业园邀请码无效或已过期');
    } finally {
      database.close();
    }
  });

  it('enforces active tenant and park administrators at the repository boundary', () => {
    const database = createDatabase();
    const membership = createParkMembershipFacade(createStore(database));

    try {
      expect(() =>
        membership.issueInvite({
          parkId: 'park-1',
          actorAccountId: 'park-member',
        }),
      ).toThrow('只有产业园管理企业管理员可生成邀请码');
      expect(() =>
        membership.issueInvite({
          parkId: 'park-1',
          actorAccountId: 'park-admin',
          maxUses: Number.NaN,
        }),
      ).toThrow('邀请码使用次数必须为 1 到 10000');

      const invite = membership.issueInvite({
        parkId: 'park-1',
        actorAccountId: 'park-admin',
      });
      expect(() =>
        membership.joinOrganization({
          organizationId: 'tenant-a',
          actorAccountId: 'tenant-a-member',
          code: invite.code,
          address: 'A 座',
          roomNumber: '101',
        }),
      ).toThrow('只有企业管理员可让企业加入产业园');
      expect(() =>
        membership.updateTenantProfile({
          organizationId: 'park-org',
          actorAccountId: 'park-admin',
          address: '园区管理处',
          roomNumber: '1',
        }),
      ).toThrow('当前企业不是产业园入驻企业');
    } finally {
      database.close();
    }
  });

  it('rejects expired and revoked invitations without changing tenant state', () => {
    const database = createDatabase();
    const membership = createParkMembershipFacade(createStore(database));

    try {
      const expired = membership.issueInvite({
        parkId: 'park-1',
        actorAccountId: 'park-admin',
        now: 1_000,
      });
      expect(() =>
        membership.joinOrganization({
          organizationId: 'tenant-a',
          actorAccountId: 'tenant-a-admin',
          code: expired.code,
          address: 'A 座',
          roomNumber: '101',
          now: 61_000,
        }),
      ).toThrow('产业园邀请码无效或已过期');

      const revoked = membership.issueInvite({
        parkId: 'park-1',
        actorAccountId: 'park-admin',
        now: 70_000,
      });
      database
        .prepare('UPDATE park_invites SET revoked_at_ms = ? WHERE id = ?')
        .run(70_001, revoked.id);
      expect(() =>
        membership.joinOrganization({
          organizationId: 'tenant-a',
          actorAccountId: 'tenant-a-admin',
          code: revoked.code,
          address: 'A 座',
          roomNumber: '101',
          now: 70_002,
        }),
      ).toThrow('产业园邀请码无效或已过期');
      expect(
        database
          .prepare('SELECT park_id FROM organizations WHERE id = ?')
          .get('tenant-a'),
      ).toMatchObject({ park_id: null });
    } finally {
      database.close();
    }
  });

  it('rolls back invite usage and organization membership when profile persistence fails', () => {
    const database = createDatabase();
    const membership = createParkMembershipFacade(createStore(database));

    try {
      const invite = membership.issueInvite({
        parkId: 'park-1',
        actorAccountId: 'park-admin',
        maxUses: 1,
      });
      database
        .prepare(
          `INSERT INTO park_tenant_profiles
           (organization_id, park_id, address, room_number) VALUES (?, ?, ?, ?)`,
        )
        .run('tenant-a', 'park-1', '旧地址', '旧门牌');

      expect(() =>
        membership.joinOrganization({
          organizationId: 'tenant-a',
          actorAccountId: 'tenant-a-admin',
          code: invite.code,
          address: '新地址',
          roomNumber: '新门牌',
        }),
      ).toThrow();
      expect(
        database
          .prepare('SELECT used_count FROM park_invites WHERE id = ?')
          .get(invite.id),
      ).toMatchObject({ used_count: 0 });
      expect(
        database
          .prepare('SELECT park_id FROM organizations WHERE id = ?')
          .get('tenant-a'),
      ).toMatchObject({ park_id: null });
    } finally {
      database.close();
    }
  });
});
