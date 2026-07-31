/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const COLLABORATION_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'collaboration',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS account_presence (
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        client_id TEXT NOT NULL DEFAULT '',
        last_seen_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (organization_id, account_id, client_id),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS direct_messages (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        sender_account_id TEXT NOT NULL,
        recipient_account_id TEXT NOT NULL,
        content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),
        content_ciphertext TEXT,
        content_iv TEXT,
        content_auth_tag TEXT,
        content_key_version INTEGER,
        e2ee_protocol_version INTEGER,
        e2ee_sender_device_id TEXT,
        e2ee_ciphertext TEXT,
        e2ee_nonce TEXT,
        e2ee_signature TEXT,
        e2ee_envelopes_json TEXT,
        in_reply_to_message_id TEXT,
        content_type TEXT NOT NULL DEFAULT 'message'
          CHECK(content_type IN ('message', 'atoa_request', 'atoa_response')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        read_at TEXT,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (recipient_account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS direct_message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
        content BLOB NOT NULL,
        storage_backend TEXT NOT NULL DEFAULT 'sqlite',
        storage_key TEXT,
        e2ee_nonce TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (message_id) REFERENCES direct_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS e2ee_devices (
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        identity_signing_public_key TEXT NOT NULL,
        device_exchange_public_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        revoked_at TEXT,
        PRIMARY KEY (organization_id, account_id, device_id),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_account_presence_org_seen
        ON account_presence(organization_id, last_seen_at_ms);
      CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation
        ON direct_messages(
          organization_id,
          sender_account_id,
          recipient_account_id,
          created_at
        );
      CREATE INDEX IF NOT EXISTS idx_direct_message_attachments_message
        ON direct_message_attachments(message_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_e2ee_devices_active
        ON e2ee_devices(organization_id, account_id, revoked_at, created_at);
    `);

    const attachmentColumns = new Set(
      (
        database
          .prepare('PRAGMA table_info(direct_message_attachments)')
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!attachmentColumns.has('storage_backend')) {
      database.exec(
        "ALTER TABLE direct_message_attachments ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'sqlite'",
      );
    }
    if (!attachmentColumns.has('storage_key')) {
      database.exec(
        'ALTER TABLE direct_message_attachments ADD COLUMN storage_key TEXT',
      );
    }
    if (!attachmentColumns.has('e2ee_nonce')) {
      database.exec(
        'ALTER TABLE direct_message_attachments ADD COLUMN e2ee_nonce TEXT',
      );
    }
    const messageColumns = new Set(
      (
        database.prepare('PRAGMA table_info(direct_messages)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    const addMessageColumn = (name: string, definition: string) => {
      if (!messageColumns.has(name)) {
        database.exec(
          `ALTER TABLE direct_messages ADD COLUMN ${name} ${definition}`,
        );
      }
    };
    addMessageColumn('content_ciphertext', 'TEXT');
    addMessageColumn('content_iv', 'TEXT');
    addMessageColumn('content_auth_tag', 'TEXT');
    addMessageColumn('content_key_version', 'INTEGER');
    addMessageColumn('e2ee_protocol_version', 'INTEGER');
    addMessageColumn('e2ee_sender_device_id', 'TEXT');
    addMessageColumn('e2ee_ciphertext', 'TEXT');
    addMessageColumn('e2ee_nonce', 'TEXT');
    addMessageColumn('e2ee_signature', 'TEXT');
    addMessageColumn('e2ee_envelopes_json', 'TEXT');
    addMessageColumn('in_reply_to_message_id', 'TEXT');
    addMessageColumn(
      'content_type',
      "TEXT NOT NULL DEFAULT 'message' CHECK(content_type IN ('message', 'atoa_request', 'atoa_response'))",
    );
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_direct_messages_type
        ON direct_messages(
          organization_id,
          recipient_account_id,
          content_type,
          created_at
        );
      CREATE INDEX IF NOT EXISTS idx_direct_message_attachments_storage
        ON direct_message_attachments(storage_backend, storage_key);
    `);
  },
};
