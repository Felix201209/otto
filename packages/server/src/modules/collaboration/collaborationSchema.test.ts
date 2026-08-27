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
  it('adds encrypted message metadata before creating the A2A type index', () => {
    const database = new Database(':memory:');
    try {
      createIdentityPrerequisites(database);
      database.exec(`
        CREATE TABLE direct_messages (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          sender_account_id TEXT NOT NULL,
          recipient_account_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          read_at TEXT
        );
      `);

      applyDatabaseSchemaContributors(database, [
        COLLABORATION_SCHEMA_CONTRIBUTOR,
      ]);

      const columns = database
        .prepare('PRAGMA table_info(direct_messages)')
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'content_ciphertext',
          'content_iv',
          'content_auth_tag',
          'content_key_version',
          'content_type',
        ]),
      );
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_direct_messages_type'",
          )
          .get(),
      ).toEqual({ name: 'idx_direct_messages_type' });
    } finally {
      database.close();
    }
  });

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
             'e2ee_devices',
             'e2ee_key_transparency_log',
             'mls_key_packages',
             'mls_conversations',
             'mls_group_sessions',
             'mls_transport_events',
             'mls_resource_rate_buckets',
             'idx_account_presence_org_seen',
             'idx_direct_messages_conversation',
             'idx_direct_messages_type',
             'idx_direct_message_attachments_message',
             'idx_mls_conversations_participant_b',
             'idx_mls_key_packages_expiry',
             'idx_mls_transport_events_expiry',
             'idx_mls_transport_events_inventory',
             'idx_mls_rate_buckets_expiry'
           )
           ORDER BY type, name`,
        )
        .all();
      expect(objects).toEqual([
        { type: 'index', name: 'idx_account_presence_org_seen' },
        { type: 'index', name: 'idx_direct_message_attachments_message' },
        { type: 'index', name: 'idx_direct_messages_conversation' },
        { type: 'index', name: 'idx_direct_messages_type' },
        { type: 'index', name: 'idx_mls_conversations_participant_b' },
        { type: 'index', name: 'idx_mls_key_packages_expiry' },
        { type: 'index', name: 'idx_mls_rate_buckets_expiry' },
        { type: 'index', name: 'idx_mls_transport_events_expiry' },
        { type: 'index', name: 'idx_mls_transport_events_inventory' },
        { type: 'table', name: 'account_presence' },
        { type: 'table', name: 'direct_message_attachments' },
        { type: 'table', name: 'direct_messages' },
        { type: 'table', name: 'e2ee_devices' },
        { type: 'table', name: 'e2ee_key_transparency_log' },
        { type: 'table', name: 'mls_conversations' },
        { type: 'table', name: 'mls_group_sessions' },
        { type: 'table', name: 'mls_key_packages' },
        { type: 'table', name: 'mls_resource_rate_buckets' },
        { type: 'table', name: 'mls_transport_events' },
      ]);
    } finally {
      database.close();
    }
  });

  it('upgrades existing MLS tables with expiry and retention governance', () => {
    const database = new Database(':memory:');
    try {
      createIdentityPrerequisites(database);
      database.exec(`
        CREATE TABLE mls_key_packages (
          organization_id TEXT NOT NULL,
          key_package_reference TEXT NOT NULL,
          account_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          ciphersuite TEXT NOT NULL,
          key_package TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          claimed_at TEXT,
          claimed_by_account_id TEXT,
          claimed_by_device_id TEXT,
          welcome_event_id TEXT,
          PRIMARY KEY (organization_id, key_package_reference)
        );
        CREATE TABLE mls_conversations (
          organization_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          participant_a_account_id TEXT NOT NULL,
          participant_b_account_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          current_epoch INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (organization_id, conversation_id)
        );
        CREATE TABLE mls_transport_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          sender_account_id TEXT NOT NULL,
          sender_device_id TEXT NOT NULL,
          recipient_account_id TEXT,
          recipient_device_id TEXT,
          event_type TEXT NOT NULL,
          epoch INTEGER NOT NULL,
          group_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          key_package_reference TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO mls_key_packages (
          organization_id, key_package_reference, account_id, device_id,
          ciphersuite, key_package, created_at
        ) VALUES (
          'org', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'account', 'device', 'suite', 'package', '2026-01-02 03:04:05'
        );
        INSERT INTO mls_conversations (
          organization_id, conversation_id, participant_a_account_id,
          participant_b_account_id, group_id, current_epoch
        ) VALUES (
          'org', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'account-a', 'account-b', 'group', 1
        );
        INSERT INTO mls_transport_events (
          id, organization_id, conversation_id, sender_account_id,
          sender_device_id, event_type, epoch, group_id, payload, created_at
        ) VALUES (
          'event', 'org',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'account-a', 'device', 'commit', 1, 'group', 'payload',
          '2026-01-02 03:04:05'
        );
      `);

      applyDatabaseSchemaContributors(database, [
        COLLABORATION_SCHEMA_CONTRIBUTOR,
      ]);

      const columns = (table: string) =>
        (
          database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
          }>
        ).map((column) => column.name);
      expect(columns('mls_key_packages')).toContain('expires_at');
      expect(columns('mls_conversations')).toContain(
        'retention_floor_sequence',
      );
      expect(columns('mls_conversations')).toContain('active_generation');
      expect(columns('mls_group_sessions')).toEqual(
        expect.arrayContaining([
          'generation',
          'group_id',
          'status',
          'reset_event_id',
        ]),
      );
      expect(columns('mls_transport_events')).toContain('expires_at');
      expect(columns('mls_transport_events')).toContain('session_generation');
      expect(
        database
          .prepare(
            `SELECT generation, group_id, current_epoch, status
             FROM mls_group_sessions`,
          )
          .get(),
      ).toEqual({
        generation: 1,
        group_id: 'group',
        current_epoch: 1,
        status: 'active',
      });
      expect(
        database
          .prepare('SELECT expires_at FROM mls_key_packages')
          .get(),
      ).toEqual({ expires_at: '2026-01-09T03:04:05.000Z' });
      expect(
        database
          .prepare('SELECT expires_at FROM mls_transport_events')
          .get(),
      ).toEqual({ expires_at: '2026-04-02T03:04:05.000Z' });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'mls_resource_rate_buckets'`,
          )
          .get(),
      ).toEqual({ name: 'mls_resource_rate_buckets' });
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
