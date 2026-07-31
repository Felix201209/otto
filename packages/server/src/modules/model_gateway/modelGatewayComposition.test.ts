/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createModelGatewayComposition } from './modelGatewayComposition.js';
import { MODEL_GATEWAY_SCHEMA_CONTRIBUTOR } from './modelGatewaySchema.js';
import type {
  ModelUsageAccount,
  ModelUsageOrganization,
} from './modelUsageTypes.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );
    INSERT INTO organizations (id) VALUES ('org-a');
    INSERT INTO accounts (id, organization_id) VALUES ('account-a', 'org-a');
  `);
  applyDatabaseSchemaContributors(database, [MODEL_GATEWAY_SCHEMA_CONTRIBUTOR]);
  return database;
}

function account(
  status: ModelUsageAccount['status'] = 'active',
): ModelUsageAccount {
  return {
    id: 'account-a',
    organizationId: 'org-a',
    name: 'Account A',
    username: 'account-a',
    status,
  };
}

function organization(
  status: ModelUsageOrganization['status'] = 'active',
): ModelUsageOrganization {
  return { id: 'org-a', status };
}

describe('model gateway composition', () => {
  it('records idempotent usage and summarizes it within one organization', () => {
    const database = createDatabase();
    const activeAccount = account();
    const activeOrganization = organization();
    const modelGateway = createModelGatewayComposition({
      db: () => database,
      getAccount: (accountId) =>
        accountId === activeAccount.id ? activeAccount : null,
      getOrganization: (organizationId) =>
        organizationId === activeOrganization.id ? activeOrganization : null,
      listOrganizationAccounts: () => [activeAccount],
      createId: () => 'request-1',
    });
    const usage = {
      accountId: 'account-a',
      sessionId: 'session-a',
      messageId: 'message-a',
      model: 'model-a',
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    };

    try {
      expect(modelGateway.recordTokenUsage(usage)).toBe(true);
      expect(modelGateway.recordTokenUsage(usage)).toBe(false);
      expect(
        database.prepare('SELECT id FROM account_token_usage').get(),
      ).toEqual({ id: 'usage_request-1' });
      expect(modelGateway.getOrganizationUsageSummary('org-a')).toMatchObject({
        organizationId: 'org-a',
        source: 'client_reported',
        totalInputTokens: 12,
        totalOutputTokens: 8,
        totalTokens: 20,
        requestCount: 1,
      });
    } finally {
      database.close();
    }
  });

  it('rejects disabled accounts and organizations before persistence', () => {
    const database = createDatabase();
    try {
      const disabledAccountGateway = createModelGatewayComposition({
        db: () => database,
        getAccount: () => account('disabled'),
        getOrganization: () => organization(),
        listOrganizationAccounts: () => [],
        createId: () => 'disabled-account',
      });
      expect(() =>
        disabledAccountGateway.recordTokenUsage({
          accountId: 'account-a',
          sessionId: 'session-a',
          messageId: 'message-a',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
      ).toThrow('Account is disabled');

      const disabledOrganizationGateway = createModelGatewayComposition({
        db: () => database,
        getAccount: () => account(),
        getOrganization: () => organization('disabled'),
        listOrganizationAccounts: () => [],
        createId: () => 'disabled-organization',
      });
      expect(() =>
        disabledOrganizationGateway.recordTokenUsage({
          accountId: 'account-a',
          sessionId: 'session-a',
          messageId: 'message-b',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
      ).toThrow('Organization is disabled');
    } finally {
      database.close();
    }
  });
});
