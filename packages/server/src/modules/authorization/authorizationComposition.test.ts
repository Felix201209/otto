/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { createAuthorizationComposition } from './authorizationComposition.js';
import { OrganizationFeatureDeniedError } from './organizationFeatureAccess.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE organization_features (
      organization_id TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (organization_id, feature_key)
    );
    INSERT INTO organizations (id) VALUES ('org-a');
  `);
  return database;
}

describe('authorization composition', () => {
  it('combines configured switches and license capabilities fail-closed', () => {
    const database = createDatabase();
    const auditEvents: string[] = [];
    const authorization = createAuthorizationComposition({
      db: () => database,
      audit: (event) => auditEvents.push(event),
      isLicenseUsable(feature) {
        if (feature === 'knowledge') throw new Error('license unavailable');
        return feature === 'direct_messages' || feature === 'enterprise_tree';
      },
    });

    try {
      expect(authorization.getOrganizationFeatures('org-a')).toMatchObject({
        enterprise_tree: true,
        direct_messages: true,
        atoa: false,
        knowledge: false,
      });
      expect(
        authorization.updateOrganizationFeatures('org-a', {
          direct_messages: false,
        }),
      ).toMatchObject({ direct_messages: false });
      expect(auditEvents).toContain('organization_features_update');
      expect(
        authorization.isOrganizationFeatureEnabled('org-a', 'direct_messages'),
      ).toBe(false);
      expect(() =>
        authorization.requireOrganizationFeature('org-a', 'direct_messages'),
      ).toThrow(OrganizationFeatureDeniedError);
    } finally {
      database.close();
    }
  });
});
