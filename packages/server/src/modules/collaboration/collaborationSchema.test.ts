/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { COLLABORATION_SCHEMA_CONTRIBUTOR } from './collaborationSchema.js';

function createIdentityPrerequisites(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );
  `);
}

describe('collaboration schema contributor', () => {
  it('creates its tables and indexes idempotently', () => {
    const database = new Database(':memory:');
    try {
      createIdentityPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        COLLABORATION_SCHEMA_CONTRIBUTOR,
      ]);
      applyDatabaseSchemaContributors(database, [
        COLLABORATION_SCHEMA_CONTRIBUTOR,
      ]);

      const objects = database
        .prepare(
          `SELECT type, name FROM sqlite_master
           WHERE name IN (
             'account_presence',
             'direct_messages',
             'direct_message_attachments',
             'idx_account_presence_org_seen',
             'idx_direct_messages_conversation',
             'idx_direct_message_attachments_message'
           )
           ORDER BY type, name`,
        )
        .all();
      expect(objects).toEqual([
        { type: 'index', name: 'idx_account_presence_org_seen' },
        { type: 'index', name: 'idx_direct_message_attachments_message' },
        { type: 'index', name: 'idx_direct_messages_conversation' },
        { type: 'table', name: 'account_presence' },
        { type: 'table', name: 'direct_message_attachments' },
        { type: 'table', name: 'direct_messages' },
      ]);
    } finally {
      database.close();
    }
  });

  it('preserves message and attachment cascade ownership', () => {
    const database = new Database(':memory:');
    try {
      createIdentityPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        COLLABORATION_SCHEMA_CONTRIBUTOR,
      ]);
      database.exec(`
        INSERT INTO organizations (id) VALUES ('org');
        INSERT INTO accounts (id, organization_id) VALUES ('sender', 'org');
        INSERT INTO accounts (id, organization_id) VALUES ('recipient', 'org');
        INSERT INTO direct_messages
          (id, organization_id, sender_account_id, recipient_account_id, content)
        VALUES ('message', 'org', 'sender', 'recipient', 'hello');
        INSERT INTO direct_message_attachments
          (id, message_id, organization_id, ordinal, file_name, mime_type, byte_size, content)
        VALUES ('attachment', 'message', 'org', 0, 'brief.pdf', 'application/pdf', 1, X'01');
        DELETE FROM accounts WHERE id = 'sender';
      `);

      expect(
        database.prepare('SELECT COUNT(*) AS count FROM direct_messages').get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM direct_message_attachments')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
