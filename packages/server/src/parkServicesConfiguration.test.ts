/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createParkServiceConfigurationFacade,
  type ParkServiceConfigurationRepositoryStore,
} from './modules/park_services/index.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE parks (
      id TEXT PRIMARY KEY,
      admin_organization_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_admin INTEGER NOT NULL,
      status TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE park_services (
      park_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (park_id, id)
    );
    CREATE TABLE park_service_specialists (
      park_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      PRIMARY KEY (park_id, service_id, account_id)
    );

    INSERT INTO parks (id, admin_organization_id, status) VALUES
      ('park-active', 'park-org', 'active'),
      ('park-disabled', 'park-org', 'disabled');
    INSERT INTO accounts
      (id, organization_id, name, is_admin, status, deleted_at) VALUES
      ('park-admin', 'park-org', '园区管理员', 1, 'active', NULL),
      ('park-member', 'park-org', '普通成员', 0, 'active', NULL),
      ('specialist-a', 'park-org', '维修甲', 0, 'active', NULL),
      ('specialist-b', 'park-org', '维修乙', 0, 'active', NULL),
      ('specialist-disabled', 'park-org', '停用专员', 0, 'disabled', NULL),
      ('external-admin', 'tenant-org', '外部管理员', 1, 'active', NULL),
      ('external-specialist', 'tenant-org', '外部专员', 0, 'active', NULL);
    INSERT INTO park_services
      (park_id, id, name, enabled, config_json) VALUES
      ('park-active', 'repair', '物业报修', 1, '{"sla":"2h"}'),
      ('park-active', 'parking', '停车办理', 0, '{}'),
      ('park-disabled', 'repair', '物业报修', 1, '{}');
  `);
  return database;
}

function createStore(
  database: Database,
): ParkServiceConfigurationRepositoryStore {
  return {
    db: () => database,
    getAccount: (accountId, organizationId) => {
      const row = database
        .prepare(
          `SELECT id, is_admin, status FROM accounts
           WHERE id = ? AND (? IS NULL OR organization_id = ?) AND deleted_at IS NULL`,
        )
        .get(accountId, organizationId ?? null, organizationId ?? null) as
        { id: string; is_admin: number; status: string } | undefined;
      return row
        ? { id: row.id, isAdmin: row.is_admin === 1, status: row.status }
        : null;
    },
    getPark: (parkId) => {
      const row = database
        .prepare(
          `SELECT id, admin_organization_id, status FROM parks WHERE id = ?`,
        )
        .get(parkId) as
        | {
            id: string;
            admin_organization_id: string;
            status: 'active' | 'disabled';
          }
        | undefined;
      return row
        ? {
            id: row.id,
            adminOrganizationId: row.admin_organization_id,
            status: row.status,
          }
        : null;
    },
    normalizeOptionalText: (value, _field, maxLength = 200) => {
      const normalized = value.trim();
      if (normalized.length > maxLength) throw new Error('字段过长');
      return normalized || null;
    },
  };
}

describe('park service configuration kernel', () => {
  it('updates service state and keeps compatible bounded string config', () => {
    const database = createDatabase();
    const configuration = createParkServiceConfigurationFacade(
      createStore(database),
    );

    try {
      const service = configuration.updateService({
        parkId: 'park-active',
        actorAccountId: 'park-admin',
        serviceId: ' repair ',
        name: ' 工程报修 ',
        enabled: false,
        config: {
          sla: '4h',
          ['x'.repeat(65)]: 'ignored',
          invalid: 1,
        } as unknown as Record<string, string>,
      });
      expect(service).toMatchObject({
        id: 'repair',
        name: '工程报修',
        enabled: false,
        config: { sla: '4h' },
      });
      expect(configuration.listServices('park-active')).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('rejects non-admin, cross-organization, and disabled-park writes', () => {
    const database = createDatabase();
    const configuration = createParkServiceConfigurationFacade(
      createStore(database),
    );

    try {
      for (const actorAccountId of ['park-member', 'external-admin']) {
        expect(() =>
          configuration.updateService({
            parkId: 'park-active',
            actorAccountId,
            serviceId: 'repair',
            enabled: false,
          }),
        ).toThrow('只有产业园管理员可配置服务');
      }
      expect(() =>
        configuration.updateService({
          parkId: 'park-disabled',
          actorAccountId: 'park-admin',
          serviceId: 'repair',
          enabled: false,
        }),
      ).toThrow('产业园不存在或已停用');
    } finally {
      database.close();
    }
  });

  it('supports multiple specialists while rejecting unsafe assignments', () => {
    const database = createDatabase();
    const configuration = createParkServiceConfigurationFacade(
      createStore(database),
    );

    try {
      for (const accountId of ['specialist-a', 'specialist-b']) {
        configuration.setSpecialist({
          parkId: 'park-active',
          actorAccountId: 'park-admin',
          serviceId: 'repair',
          accountId,
        });
      }
      configuration.setSpecialist({
        parkId: 'park-active',
        actorAccountId: 'park-admin',
        serviceId: 'repair',
        accountId: 'specialist-a',
      });
      expect(configuration.listSpecialists('park-active')).toHaveLength(2);

      expect(() =>
        configuration.setSpecialist({
          parkId: 'park-active',
          actorAccountId: 'park-admin',
          serviceId: 'repair',
          accountId: 'external-specialist',
        }),
      ).toThrow('专员必须属于产业园管理企业');
      expect(() =>
        configuration.setSpecialist({
          parkId: 'park-active',
          actorAccountId: 'park-admin',
          serviceId: 'repair',
          accountId: 'specialist-disabled',
        }),
      ).toThrow('专员必须属于产业园管理企业');
      expect(() =>
        configuration.setSpecialist({
          parkId: 'park-active',
          actorAccountId: 'park-admin',
          serviceId: 'parking',
          accountId: 'specialist-a',
        }),
      ).toThrow('园区服务已停用');

      database
        .prepare(
          `INSERT INTO park_service_specialists
           (park_id, service_id, account_id) VALUES (?, ?, ?)`,
        )
        .run('park-active', 'repair', 'external-specialist');
      expect(configuration.listSpecialists('park-active')).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('removes assignments idempotently with the same execution-layer guard', () => {
    const database = createDatabase();
    const configuration = createParkServiceConfigurationFacade(
      createStore(database),
    );

    try {
      configuration.setSpecialist({
        parkId: 'park-active',
        actorAccountId: 'park-admin',
        serviceId: 'repair',
        accountId: 'specialist-a',
      });
      expect(() =>
        configuration.removeSpecialist({
          parkId: 'park-active',
          actorAccountId: 'park-member',
          serviceId: 'repair',
          accountId: 'specialist-a',
        }),
      ).toThrow('只有产业园管理员可设置服务专员');

      for (let attempt = 0; attempt < 2; attempt += 1) {
        configuration.removeSpecialist({
          parkId: 'park-active',
          actorAccountId: 'park-admin',
          serviceId: 'repair',
          accountId: 'specialist-a',
        });
      }
      expect(configuration.listSpecialists('park-active')).toEqual([]);
      expect(() =>
        configuration.removeSpecialist({
          parkId: 'park-disabled',
          actorAccountId: 'park-admin',
          serviceId: 'repair',
          accountId: 'specialist-a',
        }),
      ).toThrow('产业园不存在或已停用');
    } finally {
      database.close();
    }
  });
});
