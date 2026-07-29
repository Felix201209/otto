/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { COLLABORATION_SCHEMA_CONTRIBUTOR } from './collaborationSchema.js';
import { createCollaborationComposition } from './collaborationComposition.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  COLLABORATION_SCHEMA_CONTRIBUTOR.apply(database);
  database.prepare('INSERT INTO organizations (id) VALUES (?)').run('org-a');
  database
    .prepare(
      `INSERT INTO accounts (id, organization_id, name, status)
       VALUES (?, ?, ?, ?)`,
    )
    .run('alice', 'org-a', 'Alice', 'active');
  database
    .prepare(
      `INSERT INTO accounts (id, organization_id, name, status)
       VALUES (?, ?, ?, ?)`,
    )
    .run('bob', 'org-a', 'Bob', 'active');
  return database;
}

describe('collaboration composition', () => {
  it('shares tenant-scoped active account checks across messaging and presence', () => {
    const database = createDatabase();
    let sequence = 0;
    let now = 10_000;
    const collaboration = createCollaborationComposition({
      db: () => database,
      now: () => now,
      createId: () => `message-${++sequence}`,
      getAccount(accountId, organizationId) {
        return (
          (database
            .prepare(
              `SELECT id, name, status FROM accounts
               WHERE id = ? AND organization_id = ?`,
            )
            .get(accountId, organizationId) as
            | {
                id: string;
                name: string;
                status: 'active' | 'disabled';
              }
            | undefined) ?? null
        );
      },
    });

    try {
      const message = collaboration.sendDirectMessage({
        organizationId: 'org-a',
        senderAccountId: 'alice',
        recipientAccountId: 'bob',
        content: 'Hello Bob',
      });
      expect(message).toMatchObject({
        id: 'message-1',
        senderAccountId: 'alice',
        recipientAccountId: 'bob',
      });

      collaboration.touchAccountPresence({
        organizationId: 'org-a',
        accountId: 'bob',
        clientId: 'desktop',
        nowMs: now,
      });
      now = 100_000;
      collaboration.touchAccountPresence({
        organizationId: 'org-a',
        accountId: 'alice',
        clientId: 'desktop',
        nowMs: now,
      });
      expect(
        collaboration.listAccountPresence('org-a', 60_000, now),
      ).toEqual([
        { accountId: 'alice', online: true, lastSeenAt: expect.any(String) },
        { accountId: 'bob', online: false, lastSeenAt: expect.any(String) },
      ]);
    } finally {
      database.close();
    }
  });
});
