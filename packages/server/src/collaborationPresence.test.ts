/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_PRESENCE_MAX_CLIENTS_PER_ACCOUNT,
  ACCOUNT_PRESENCE_MAX_CLIENT_ID_LENGTH,
  createAccountPresenceFacade,
  type AccountPresenceRepositoryStore,
} from './modules/collaboration/index.js';
import { Database } from './modules/data_platform/index.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      status TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE account_presence (
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      client_id TEXT NOT NULL DEFAULT '',
      last_seen_at_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (organization_id, account_id, client_id)
    );
  `);
  return database;
}

function seedAccounts(database: Database): void {
  database
    .prepare(
      `INSERT INTO accounts (id, organization_id, status, deleted_at)
       VALUES (?, ?, ?, NULL), (?, ?, ?, NULL), (?, ?, ?, NULL)`,
    )
    .run(
      'account-a',
      'org-a',
      'active',
      'account-b',
      'org-b',
      'active',
      'account-disabled',
      'org-a',
      'disabled',
    );
}

function createStore(
  database: Database,
  now = 100_000,
): AccountPresenceRepositoryStore {
  return {
    db: () => database,
    now: () => now,
    isActiveAccountInOrganization(accountId, organizationId) {
      return Boolean(
        database
          .prepare(
            `SELECT 1 FROM accounts
             WHERE id = ? AND organization_id = ?
               AND status = 'active' AND deleted_at IS NULL`,
          )
          .get(accountId, organizationId),
      );
    },
  };
}

describe('collaboration account presence kernel', () => {
  it('rejects missing, disabled and cross-organization heartbeat writes', () => {
    const database = createDatabase();
    seedAccounts(database);
    const presence = createAccountPresenceFacade(createStore(database));

    try {
      expect(() =>
        presence.touchAccountPresence({
          organizationId: 'org-b',
          accountId: 'account-a',
        }),
      ).toThrow('Account not available for presence');
      expect(() =>
        presence.touchAccountPresence({
          organizationId: 'org-a',
          accountId: 'account-disabled',
        }),
      ).toThrow('Account not available for presence');
      expect(() =>
        presence.touchAccountPresence({
          organizationId: 'org-a',
          accountId: 'missing',
        }),
      ).toThrow('Account not available for presence');
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM account_presence')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('aggregates multiple clients and expires the account after the online window', () => {
    const database = createDatabase();
    seedAccounts(database);
    const presence = createAccountPresenceFacade(createStore(database));

    try {
      presence.touchAccountPresence({
        organizationId: 'org-a',
        accountId: 'account-a',
        clientId: 'desktop-a',
        nowMs: 10_000,
      });
      presence.touchAccountPresence({
        organizationId: 'org-a',
        accountId: 'account-a',
        clientId: 'desktop-b',
        nowMs: 50_000,
      });
      expect(presence.listAccountPresence('org-a', 60_000, 100_000)).toEqual([
        {
          accountId: 'account-a',
          online: true,
          lastSeenAt: new Date(50_000).toISOString(),
        },
      ]);
      expect(presence.listAccountPresence('org-a', 60_000, 110_001)).toEqual([
        {
          accountId: 'account-a',
          online: false,
          lastSeenAt: new Date(50_000).toISOString(),
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('restores persisted last-seen state through a fresh facade instance', () => {
    const database = createDatabase();
    seedAccounts(database);
    const beforeRestart = createAccountPresenceFacade(
      createStore(database, 200_000),
    );

    try {
      beforeRestart.touchAccountPresence({
        organizationId: 'org-a',
        accountId: 'account-a',
        clientId: 'desktop-a',
        nowMs: 180_000,
      });
      const afterRestart = createAccountPresenceFacade(
        createStore(database, 200_000),
      );
      expect(afterRestart.listAccountPresence('org-a')).toEqual([
        {
          accountId: 'account-a',
          online: true,
          lastSeenAt: new Date(180_000).toISOString(),
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('normalizes client ids and bounds stored clients per account', () => {
    const database = createDatabase();
    seedAccounts(database);
    const presence = createAccountPresenceFacade(createStore(database));

    try {
      presence.touchAccountPresence({
        organizationId: 'org-a',
        accountId: 'account-a',
        clientId: '   ',
        nowMs: Number.NaN,
      });
      expect(
        database
          .prepare(
            `SELECT client_id, last_seen_at_ms FROM account_presence
             WHERE organization_id = ? AND account_id = ?`,
          )
          .get('org-a', 'account-a'),
      ).toEqual({ client_id: 'default', last_seen_at_ms: 100_000 });

      expect(
        presence.touchAccountPresence({
          organizationId: 'org-a',
          accountId: 'account-a',
          clientId: 'future-client',
          nowMs: 999_999,
        }).lastSeenAt,
      ).toBe(new Date(100_000).toISOString());

      for (
        let index = 0;
        index < ACCOUNT_PRESENCE_MAX_CLIENTS_PER_ACCOUNT + 3;
        index += 1
      ) {
        presence.touchAccountPresence({
          organizationId: 'org-a',
          accountId: 'account-a',
          clientId: `${index}-${'x'.repeat(ACCOUNT_PRESENCE_MAX_CLIENT_ID_LENGTH + 20)}`,
          nowMs: 101_000 + index,
        });
      }
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count, MAX(length(client_id)) AS max_length
             FROM account_presence WHERE organization_id = ? AND account_id = ?`,
          )
          .get('org-a', 'account-a'),
      ).toEqual({
        count: ACCOUNT_PRESENCE_MAX_CLIENTS_PER_ACCOUNT,
        max_length: ACCOUNT_PRESENCE_MAX_CLIENT_ID_LENGTH,
      });
    } finally {
      database.close();
    }
  });

  it('ignores invalid future rows without hiding a valid client heartbeat', () => {
    const database = createDatabase();
    seedAccounts(database);
    const presence = createAccountPresenceFacade(createStore(database));

    try {
      database
        .prepare(
          `INSERT INTO account_presence
           (organization_id, account_id, client_id, last_seen_at_ms)
           VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
        )
        .run(
          'org-a',
          'account-a',
          'valid-client',
          90_000,
          'org-a',
          'account-a',
          'future-client',
          999_999,
        );
      expect(presence.listAccountPresence('org-a', 60_000, 100_000)).toEqual([
        {
          accountId: 'account-a',
          online: true,
          lastSeenAt: new Date(90_000).toISOString(),
        },
      ]);

      database
        .prepare(
          'DELETE FROM account_presence WHERE organization_id = ? AND client_id = ?',
        )
        .run('org-a', 'valid-client');
      expect(presence.listAccountPresence('org-a', 60_000, 100_000)).toEqual([
        { accountId: 'account-a', online: false, lastSeenAt: null },
      ]);
    } finally {
      database.close();
    }
  });

  it('hides presence rows after an account is disabled or moved out of scope', () => {
    const database = createDatabase();
    seedAccounts(database);
    const presence = createAccountPresenceFacade(createStore(database));

    try {
      presence.touchAccountPresence({
        organizationId: 'org-a',
        accountId: 'account-a',
        nowMs: 100_000,
      });
      database
        .prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?")
        .run('account-a');
      expect(presence.listAccountPresence('org-a')).toEqual([]);
      expect(presence.listAccountPresence('org-b')).toEqual([]);
    } finally {
      database.close();
    }
  });
});
