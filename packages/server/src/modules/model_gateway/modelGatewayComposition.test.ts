/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
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
    const onRecordedUsage = vi.fn();
    const modelGateway = createModelGatewayComposition({
      db: () => database,
      getAccount: (accountId) =>
        accountId === activeAccount.id ? activeAccount : null,
      getOrganization: (organizationId) =>
        organizationId === activeOrganization.id ? activeOrganization : null,
      listOrganizationAccounts: () => [activeAccount],
      createId: () => 'request-1',
      onRecordedUsage,
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
      expect(onRecordedUsage).toHaveBeenCalledTimes(1);
      expect(onRecordedUsage).toHaveBeenCalledWith({
        organizationId: 'org-a',
        messageId: 'message-a',
        model: 'model-a',
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
      });
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
      expect(modelGateway.getPersonalTokenUsageProfile('account-a')).toMatchObject({
        accountId: 'account-a',
        source: 'client_reported',
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        requestCount: 1,
        averageTokensPerRequest: 20,
        byModel: [{ model: 'model-a', totalTokens: 20, requestCount: 1 }],
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

  it('returns an empty, bounded personal profile without sensitive request fields', () => {
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
      createId: () => 'unused',
    });

    try {
      const minimum = modelGateway.getPersonalTokenUsageProfile(
        activeAccount.id,
        -10,
      );
      expect(minimum).toEqual({
        accountId: activeAccount.id,
        periodDays: 1,
        source: 'client_reported',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        averageTokensPerRequest: 0,
        lastUsedAt: null,
        byModel: [],
        daily: [],
      });
      expect(
        modelGateway.getPersonalTokenUsageProfile(activeAccount.id, 1_000)
          .periodDays,
      ).toBe(365);
      expect(
        JSON.stringify(minimum),
      ).not.toMatch(/sessionId|messageId|username|organizationId/i);
    } finally {
      database.close();
    }
  });

  it('isolates personal usage and aggregates models and UTC days', () => {
    const database = createDatabase();
    database.exec(`
      INSERT INTO organizations (id) VALUES ('org-b');
      INSERT INTO accounts (id, organization_id) VALUES
        ('account-peer', 'org-a'),
        ('account-b', 'org-b');
    `);
    const accounts: ModelUsageAccount[] = [
      account(),
      {
        id: 'account-peer',
        organizationId: 'org-a',
        name: 'Peer',
        username: 'peer',
        status: 'active',
      },
      {
        id: 'account-b',
        organizationId: 'org-b',
        name: 'Other organization',
        username: 'other',
        status: 'active',
      },
    ];
    const organizations: ModelUsageOrganization[] = [
      organization(),
      { id: 'org-b', status: 'active' },
    ];
    let sequence = 0;
    const modelGateway = createModelGatewayComposition({
      db: () => database,
      getAccount: (accountId) =>
        accounts.find((candidate) => candidate.id === accountId) ?? null,
      getOrganization: (organizationId) =>
        organizations.find((candidate) => candidate.id === organizationId) ??
        null,
      listOrganizationAccounts: (organizationId) =>
        accounts.filter((candidate) => candidate.organizationId === organizationId),
      createId: () => `request-${++sequence}`,
    });

    try {
      const record = (
        accountId: string,
        messageId: string,
        model: string | null,
        inputTokens: number,
        outputTokens: number,
      ) =>
        modelGateway.recordTokenUsage({
          accountId,
          sessionId: `secret-session-${messageId}`,
          messageId: `secret-message-${messageId}`,
          model,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        });
      record('account-a', 'a1', 'model-a', 10, 5);
      record('account-a', 'a2', 'model-a', 20, 10);
      record('account-a', 'a3', null, 2, 3);
      record('account-peer', 'peer', 'model-peer', 100, 100);
      record('account-b', 'other-org', 'model-other', 500, 500);
      database
        .prepare(
          `UPDATE account_token_usage
           SET created_at = '2026-08-27 12:00:00'
           WHERE message_id = 'secret-message-a1'`,
        )
        .run();
      database
        .prepare(
          `UPDATE account_token_usage
           SET created_at = '2026-08-28 12:00:00'
           WHERE account_id = 'account-a'
             AND message_id != 'secret-message-a1'`,
        )
        .run();

      const profile = modelGateway.getPersonalTokenUsageProfile('account-a', 2);
      expect(profile).toMatchObject({
        accountId: 'account-a',
        inputTokens: 32,
        outputTokens: 18,
        totalTokens: 50,
        requestCount: 3,
        averageTokensPerRequest: 17,
        byModel: [
          {
            model: 'model-a',
            inputTokens: 30,
            outputTokens: 15,
            totalTokens: 45,
            requestCount: 2,
          },
          {
            model: null,
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
            requestCount: 1,
          },
        ],
        daily: [
          { date: '2026-08-27', totalTokens: 15, requestCount: 1 },
          { date: '2026-08-28', totalTokens: 35, requestCount: 2 },
        ],
      });
      const serialized = JSON.stringify(profile);
      expect(serialized).not.toContain('secret-session');
      expect(serialized).not.toContain('secret-message');
      expect(serialized).not.toContain('model-peer');
      expect(serialized).not.toContain('model-other');
    } finally {
      database.close();
    }
  });
});
