/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  ORGANIZATION_FEATURE_KEYS,
  type OrganizationFeatureKey,
} from '../../productModules.js';
import type { Database } from '../data_platform/index.js';

export type OrganizationFeatures = Record<OrganizationFeatureKey, boolean>;

export const DEFAULT_ORGANIZATION_FEATURES: Readonly<OrganizationFeatures> = {
  enterprise_tree: true,
  park_service: true,
  feishu_auto_reply: true,
  direct_messages: true,
  atoa: true,
  knowledge: true,
};

export interface OrganizationFeatureRepositoryStore {
  db(): Database;
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

function assertOrganizationExists(
  database: Database,
  organizationId: string,
): void {
  const organization = database
    .prepare('SELECT 1 FROM organizations WHERE id = ?')
    .get(organizationId);
  if (!organization) throw new Error('企业不存在');
}

export function getConfiguredOrganizationFeaturesFromRepository(
  store: OrganizationFeatureRepositoryStore,
  organizationId: string,
): OrganizationFeatures {
  const database = store.db();
  assertOrganizationExists(database, organizationId);
  const result: OrganizationFeatures = { ...DEFAULT_ORGANIZATION_FEATURES };
  const rows = database
    .prepare(
      `SELECT feature_key, enabled FROM organization_features
       WHERE organization_id = ?`,
    )
    .all(organizationId) as Array<{ feature_key: string; enabled: number }>;
  for (const row of rows) {
    if (
      ORGANIZATION_FEATURE_KEYS.includes(
        row.feature_key as OrganizationFeatureKey,
      )
    ) {
      result[row.feature_key as OrganizationFeatureKey] = row.enabled === 1;
    }
  }
  return result;
}

export function updateConfiguredOrganizationFeaturesInRepository(
  store: OrganizationFeatureRepositoryStore,
  organizationId: string,
  patch: Partial<OrganizationFeatures>,
): OrganizationFeatures {
  const allowed = new Set<string>(ORGANIZATION_FEATURE_KEYS);
  const entries = Object.entries(patch).filter(
    (entry): entry is [OrganizationFeatureKey, boolean] =>
      allowed.has(entry[0]) && typeof entry[1] === 'boolean',
  );
  if (entries.length === 0) throw new Error('至少需要一个有效功能开关');
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    assertOrganizationExists(database, organizationId);
    const statement = database.prepare(
      `INSERT INTO organization_features
       (organization_id, feature_key, enabled, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(organization_id, feature_key)
       DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    );
    for (const [key, enabled] of entries) {
      statement.run(organizationId, key, enabled ? 1 : 0);
    }
    store.audit(
      'organization_features_update',
      null,
      `Feature switches updated: ${entries
        .map(([key, enabled]) => `${key}=${enabled}`)
        .join(', ')}`,
      organizationId,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return getConfiguredOrganizationFeaturesFromRepository(store, organizationId);
}
