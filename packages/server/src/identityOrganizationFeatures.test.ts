/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createOrganizationFeatureFacade,
  type OrganizationFeatureRepositoryStore,
} from './modules/identity_organization/index.js';
import {
  createOrganizationFeatureAccessFacade,
  OrganizationFeatureDeniedError,
} from './modules/authorization/index.js';
import type { OrganizationFeatureKey } from './productModules.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE organization_features (
      organization_id TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (organization_id, feature_key)
    );
  `);
  return database;
}

function createStore(
  database: Database,
  audit = vi.fn(),
): OrganizationFeatureRepositoryStore {
  return { db: () => database, audit };
}

function insertOrganization(database: Database, id: string): void {
  database
    .prepare('INSERT INTO organizations (id, name) VALUES (?, ?)')
    .run(id, id);
}

describe('identity_organization feature configuration kernel', () => {
  it('returns tenant configuration over strict known defaults', () => {
    const database = createDatabase();
    insertOrganization(database, 'org-a');
    insertOrganization(database, 'org-b');
    database
      .prepare(
        `INSERT INTO organization_features (organization_id, feature_key, enabled)
         VALUES ('org-a', 'knowledge', 0), ('org-a', 'unknown_feature', 1),
                ('org-b', 'park_service', 0)`,
      )
      .run();
    const features = createOrganizationFeatureFacade(createStore(database));

    try {
      expect(features.getConfiguredOrganizationFeatures('org-a')).toEqual({
        enterprise_tree: true,
        park_service: true,
        feishu_auto_reply: true,
        direct_messages: true,
        atoa: true,
        knowledge: false,
      });
      expect(
        features.getConfiguredOrganizationFeatures('org-a'),
      ).not.toHaveProperty('unknown_feature');
      expect(() =>
        features.getConfiguredOrganizationFeatures('missing'),
      ).toThrow('企业不存在');
    } finally {
      database.close();
    }
  });

  it('updates only known booleans and commits configuration with audit atomically', () => {
    const database = createDatabase();
    insertOrganization(database, 'org-a');
    const audit = vi.fn();
    const features = createOrganizationFeatureFacade(
      createStore(database, audit),
    );

    try {
      expect(
        features.updateConfiguredOrganizationFeatures('org-a', {
          knowledge: false,
          park_service: false,
          unknown_feature: true,
        } as never),
      ).toMatchObject({ knowledge: false, park_service: false });
      expect(audit).toHaveBeenCalledWith(
        'organization_features_update',
        null,
        expect.stringContaining('knowledge=false'),
        'org-a',
      );
      expect(() =>
        features.updateConfiguredOrganizationFeatures('org-a', {
          knowledge: 'yes',
        } as never),
      ).toThrow('至少需要一个有效功能开关');
    } finally {
      database.close();
    }
  });

  it('rolls back all feature rows when audit persistence fails', () => {
    const database = createDatabase();
    insertOrganization(database, 'org-a');
    const features = createOrganizationFeatureFacade(
      createStore(database, () => {
        throw new Error('forced audit failure');
      }),
    );

    try {
      expect(() =>
        features.updateConfiguredOrganizationFeatures('org-a', {
          knowledge: false,
          park_service: false,
        }),
      ).toThrow('forced audit failure');
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM organization_features WHERE organization_id = ?',
          )
          .get('org-a'),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});

describe('authorization organization feature access policy', () => {
  it('combines configured values with license capabilities fail-closed', () => {
    const database = createDatabase();
    insertOrganization(database, 'org-a');
    const configuration = createOrganizationFeatureFacade(
      createStore(database),
    );
    configuration.updateConfiguredOrganizationFeatures('org-a', {
      park_service: false,
    });
    const allowed = new Set<OrganizationFeatureKey>([
      'enterprise_tree',
      'direct_messages',
      'atoa',
      'knowledge',
    ]);
    const access = createOrganizationFeatureAccessFacade({
      configuration,
      isLicenseUsable: (feature) => {
        if (feature === 'feishu_auto_reply')
          throw new Error('license unavailable');
        return allowed.has(feature);
      },
    });

    try {
      expect(access.getOrganizationFeatures('org-a')).toEqual({
        enterprise_tree: true,
        park_service: false,
        feishu_auto_reply: false,
        direct_messages: true,
        atoa: true,
        knowledge: true,
      });
      expect(access.isOrganizationFeatureEnabled('org-a', 'park_service')).toBe(
        false,
      );
      expect(() =>
        access.requireOrganizationFeature('org-a', 'park_service'),
      ).toThrow(OrganizationFeatureDeniedError);
    } finally {
      database.close();
    }
  });

  it('persists desired configuration while unlicensed and restores it automatically', () => {
    const database = createDatabase();
    insertOrganization(database, 'org-a');
    const configuration = createOrganizationFeatureFacade(
      createStore(database),
    );
    let licensed = false;
    const access = createOrganizationFeatureAccessFacade({
      configuration,
      isLicenseUsable: () => licensed,
    });

    try {
      expect(
        access.updateOrganizationFeatures('org-a', { knowledge: true })
          .knowledge,
      ).toBe(false);
      expect(
        configuration.getConfiguredOrganizationFeatures('org-a').knowledge,
      ).toBe(true);
      licensed = true;
      expect(access.getOrganizationFeatures('org-a').knowledge).toBe(true);
    } finally {
      database.close();
    }
  });
});
