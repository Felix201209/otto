/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createParkLifecycleFacade,
  type ParkLifecycleRepositoryStore,
} from './modules/park_services/index.js';
import { Database } from './modules/data_platform/index.js';

const DEFAULT_SERVICES = [
  ['renovation', '装修管理'],
  ['parking', '停车办理'],
  ['network-phone', '网络与固话'],
  ['meeting-room', '会议室预约'],
  ['electric-card', '电卡服务'],
  ['repair', '物业报修'],
  ['vehicle-visit', '车辆与访客'],
  ['announcement', '园区公告'],
  ['satisfaction', '满意度调查'],
].map(([id, name]) => ({ id: id!, name: name! }));

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
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
      slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
      invite_secret TEXT NOT NULL,
      admin_organization_id TEXT NOT NULL UNIQUE,
      brand_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE park_services (
      park_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (park_id, id)
    );

    INSERT INTO organizations (id, name) VALUES
      ('org-a', '甲企业'), ('org-b', '乙企业'), ('org-no-admin', '无管理员企业');
    INSERT INTO accounts (id, organization_id, is_admin, status) VALUES
      ('org-a-admin', 'org-a', 1, 'active'),
      ('org-a-member', 'org-a', 0, 'active'),
      ('org-b-admin', 'org-b', 1, 'active'),
      ('org-no-admin-user', 'org-no-admin', 0, 'active');
  `);
  return database;
}

function createStore(
  database: Database,
  services = DEFAULT_SERVICES,
): ParkLifecycleRepositoryStore {
  let sequence = 0;
  return {
    db: () => database,
    getAccount: (accountId, organizationId) => {
      const row = database
        .prepare(
          `SELECT id, is_admin, status FROM accounts
           WHERE id = ? AND (? IS NULL OR organization_id = ?)`,
        )
        .get(accountId, organizationId ?? null, organizationId ?? null) as
        { id: string; is_admin: number; status: string } | undefined;
      return row
        ? { id: row.id, isAdmin: row.is_admin === 1, status: row.status }
        : null;
    },
    getOrganization: (organizationId) => {
      const row = database
        .prepare('SELECT id, name FROM organizations WHERE id = ?')
        .get(organizationId) as { id: string; name: string } | undefined;
      return row ?? null;
    },
    getActiveOrganizationAdmin: (organizationId) => {
      const row = database
        .prepare(
          `SELECT id, is_admin, status FROM accounts
           WHERE organization_id = ? AND is_admin = 1 AND status = 'active'
           ORDER BY id LIMIT 1`,
        )
        .get(organizationId) as
        { id: string; is_admin: number; status: string } | undefined;
      return row
        ? { id: row.id, isAdmin: row.is_admin === 1, status: row.status }
        : null;
    },
    normalizeOptionalText: (value, _field, maxLength = 200) => {
      const normalized = value.trim();
      if (normalized.length > maxLength) throw new Error('字段过长');
      return normalized || null;
    },
    normalizeSlug: (value) => {
      const normalized = value.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(normalized)) {
        throw new Error('slug 格式不正确');
      }
      return normalized;
    },
    createParkId: () => `park-${++sequence}`,
    createDefaultSlug: () => `park-default-${sequence + 1}`,
    createInviteSecret: () => `secret-${sequence}`,
    defaultServices: services,
  };
}

describe('park services lifecycle kernel', () => {
  it('platform certification atomically creates the park and nine default services', () => {
    const database = createDatabase();
    const lifecycle = createParkLifecycleFacade(createStore(database));

    try {
      const park = lifecycle.createParkAsPlatform({
        adminOrganizationId: 'org-a',
        brandName: '甲园区服务',
      });
      expect(park).toMatchObject({
        name: '甲企业',
        brandName: '甲园区服务',
        adminOrganizationId: 'org-a',
        status: 'active',
      });
      expect(lifecycle.getParkForOrganization('org-a')).toEqual(park);
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM park_services WHERE park_id = ?',
          )
          .get(park.id),
      ).toMatchObject({ count: 9 });
      expect(
        database
          .prepare('SELECT park_id FROM organizations WHERE id = ?')
          .get('org-a'),
      ).toMatchObject({ park_id: park.id });
    } finally {
      database.close();
    }
  });

  it('requires active administrators and rejects repeated certification', () => {
    const database = createDatabase();
    const lifecycle = createParkLifecycleFacade(createStore(database));

    try {
      expect(() =>
        lifecycle.createPark({
          adminOrganizationId: 'org-a',
          actorAccountId: 'org-a-member',
          name: '无权园区',
        }),
      ).toThrow('只有企业管理员可注册产业园');
      expect(() =>
        lifecycle.createParkAsPlatform({
          adminOrganizationId: 'org-no-admin',
        }),
      ).toThrow('Park admin organization requires an active admin account');

      lifecycle.createPark({
        adminOrganizationId: 'org-a',
        actorAccountId: 'org-a-admin',
        name: '甲园区',
      });
      expect(() =>
        lifecycle.createPark({
          adminOrganizationId: 'org-a',
          actorAccountId: 'org-a-admin',
          name: '重复园区',
        }),
      ).toThrow('企业已加入产业园');
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM parks').get(),
      ).toMatchObject({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('rolls back park and organization ownership when default service creation fails', () => {
    const database = createDatabase();
    const duplicateServices = [
      { id: 'repair', name: '物业报修' },
      { id: 'repair', name: '重复报修' },
    ];
    const lifecycle = createParkLifecycleFacade(
      createStore(database, duplicateServices),
    );

    try {
      expect(() =>
        lifecycle.createPark({
          adminOrganizationId: 'org-b',
          actorAccountId: 'org-b-admin',
          name: '事务园区',
        }),
      ).toThrow();
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM parks').get(),
      ).toMatchObject({ count: 0 });
      expect(
        database
          .prepare('SELECT park_id FROM organizations WHERE id = ?')
          .get('org-b'),
      ).toMatchObject({ park_id: null });
    } finally {
      database.close();
    }
  });

  it('updates only mutable platform fields and hides disabled parks from organizations', () => {
    const database = createDatabase();
    const lifecycle = createParkLifecycleFacade(createStore(database));

    try {
      const created = lifecycle.createParkAsPlatform({
        adminOrganizationId: 'org-b',
        name: '原园区',
        slug: 'stable-park',
      });
      const updated = lifecycle.updateParkAsPlatform({
        adminOrganizationId: 'org-b',
        name: '新园区',
        brandName: '新服务品牌',
      });
      expect(updated).toMatchObject({
        id: created.id,
        slug: 'stable-park',
        name: '新园区',
        brandName: '新服务品牌',
        adminOrganizationId: 'org-b',
      });
      expect(() =>
        lifecycle.updateParkAsPlatform({
          adminOrganizationId: 'org-b',
          name: ' ',
        }),
      ).toThrow('产业园名称不能为空');

      database
        .prepare("UPDATE parks SET status = 'disabled' WHERE id = ?")
        .run(created.id);
      expect(lifecycle.getPark(created.id)?.status).toBe('disabled');
      expect(lifecycle.getParkForOrganization('org-b')).toBeNull();
      expect(() =>
        lifecycle.updateParkAsPlatform({
          adminOrganizationId: 'org-b',
          name: '不可改名',
        }),
      ).toThrow('Park admin organization not found');
    } finally {
      database.close();
    }
  });
});
