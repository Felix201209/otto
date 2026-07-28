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
  },
};
