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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (message_id) REFERENCES direct_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
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
