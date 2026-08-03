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
        key_fingerprint TEXT NOT NULL CHECK(length(key_fingerprint) = 64),
        approval_state TEXT NOT NULL
          CHECK(approval_state IN ('pending', 'approved')),
        approved_by_device_id TEXT,
        approved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        revoked_at TEXT,
        PRIMARY KEY (organization_id, account_id, device_id),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS e2ee_key_transparency_log (
        organization_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        event TEXT NOT NULL
          CHECK(event IN ('bootstrap_approved', 'registered_pending', 'approved', 'revoked')),
        key_fingerprint TEXT NOT NULL CHECK(length(key_fingerprint) = 64),
        actor_device_id TEXT,
        previous_hash TEXT NOT NULL CHECK(length(previous_hash) = 64),
        entry_hash TEXT NOT NULL CHECK(length(entry_hash) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, account_id, sequence),
        UNIQUE (organization_id, account_id, entry_hash),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS mls_key_packages (
        organization_id TEXT NOT NULL,
        key_package_reference TEXT NOT NULL CHECK(length(key_package_reference) = 64),
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        ciphersuite TEXT NOT NULL,
        key_package TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        claimed_at TEXT,
        claimed_by_account_id TEXT,
        claimed_by_device_id TEXT,
        welcome_event_id TEXT,
        expires_at TEXT NOT NULL DEFAULT (
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days')
        ),
        PRIMARY KEY (organization_id, key_package_reference),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id, account_id, device_id)
          REFERENCES e2ee_devices(organization_id, account_id, device_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS mls_conversations (
        organization_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL CHECK(length(conversation_id) = 64),
        participant_a_account_id TEXT NOT NULL,
        participant_b_account_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        current_epoch INTEGER NOT NULL CHECK(current_epoch > 0),
        active_generation INTEGER NOT NULL DEFAULT 1
          CHECK(active_generation > 0),
        retention_floor_sequence INTEGER NOT NULL DEFAULT 0
          CHECK(retention_floor_sequence >= 0),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (organization_id, conversation_id),
        UNIQUE (
          organization_id,
          participant_a_account_id,
          participant_b_account_id
        ),
        CHECK(participant_a_account_id < participant_b_account_id),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (participant_a_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (participant_b_account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS mls_group_sessions (
        organization_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation > 0),
        group_id TEXT NOT NULL,
        current_epoch INTEGER NOT NULL CHECK(current_epoch > 0),
        status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        retired_at TEXT,
        reset_by_account_id TEXT,
        reset_by_device_id TEXT,
        reset_event_id TEXT,
        PRIMARY KEY (organization_id, conversation_id, generation),
        UNIQUE (organization_id, conversation_id, group_id),
        FOREIGN KEY (organization_id, conversation_id)
          REFERENCES mls_conversations(organization_id, conversation_id)
          ON DELETE CASCADE,
        CHECK (
          (status = 'active' AND retired_at IS NULL)
          OR (status = 'retired' AND retired_at IS NOT NULL)
        ),
        CHECK (
          (generation = 1
            AND reset_by_account_id IS NULL
            AND reset_by_device_id IS NULL
            AND reset_event_id IS NULL)
          OR (generation > 1
            AND reset_by_account_id IS NOT NULL
            AND reset_by_device_id IS NOT NULL
            AND reset_event_id IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS mls_transport_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        session_generation INTEGER NOT NULL DEFAULT 1
          CHECK(session_generation > 0),
        sender_account_id TEXT NOT NULL,
        sender_device_id TEXT NOT NULL,
        recipient_account_id TEXT,
        recipient_device_id TEXT,
        event_type TEXT NOT NULL
          CHECK(event_type IN ('welcome', 'commit', 'application')),
        epoch INTEGER NOT NULL CHECK(epoch > 0),
        group_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        key_package_reference TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL DEFAULT (
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+90 days')
        ),
        UNIQUE (organization_id, id),
        FOREIGN KEY (organization_id, conversation_id)
          REFERENCES mls_conversations(organization_id, conversation_id)
          ON DELETE CASCADE,
        FOREIGN KEY (organization_id, conversation_id, session_generation)
          REFERENCES mls_group_sessions(
            organization_id, conversation_id, generation
          ) ON DELETE RESTRICT,
        FOREIGN KEY (organization_id, sender_account_id, sender_device_id)
          REFERENCES e2ee_devices(organization_id, account_id, device_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (organization_id, key_package_reference)
          REFERENCES mls_key_packages(organization_id, key_package_reference)
          ON DELETE RESTRICT,
        CHECK (
          (event_type = 'welcome'
            AND recipient_account_id IS NOT NULL
            AND recipient_device_id IS NOT NULL
            AND key_package_reference IS NOT NULL)
          OR
          (event_type <> 'welcome'
            AND recipient_account_id IS NULL
            AND recipient_device_id IS NULL
            AND key_package_reference IS NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS mls_resource_rate_buckets (
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        action TEXT NOT NULL
          CHECK(action IN ('key_package_publish', 'transport_event_append')),
        bucket_started_at_ms INTEGER NOT NULL CHECK(bucket_started_at_ms >= 0),
        request_count INTEGER NOT NULL CHECK(request_count > 0),
        PRIMARY KEY (
          organization_id, account_id, device_id, action, bucket_started_at_ms
        ),
        FOREIGN KEY (organization_id, account_id, device_id)
          REFERENCES e2ee_devices(organization_id, account_id, device_id)
          ON DELETE CASCADE
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
      CREATE INDEX IF NOT EXISTS idx_e2ee_key_transparency_account
        ON e2ee_key_transparency_log(organization_id, account_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_mls_key_packages_unclaimed
        ON mls_key_packages(organization_id, account_id, created_at)
        WHERE claimed_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_key_packages_welcome
        ON mls_key_packages(organization_id, welcome_event_id)
        WHERE welcome_event_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_group_sessions_active
        ON mls_group_sessions(organization_id, conversation_id)
        WHERE status = 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_group_sessions_reset_event
        ON mls_group_sessions(organization_id, reset_event_id)
        WHERE reset_event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_mls_transport_events_conversation
        ON mls_transport_events(organization_id, conversation_id, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_transport_events_welcome_package
        ON mls_transport_events(organization_id, key_package_reference)
        WHERE key_package_reference IS NOT NULL;
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
    const deviceColumns = new Set(
      (
        database.prepare('PRAGMA table_info(e2ee_devices)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    const addDeviceColumn = (name: string, definition: string) => {
      if (!deviceColumns.has(name)) {
        database.exec(
          `ALTER TABLE e2ee_devices ADD COLUMN ${name} ${definition}`,
        );
      }
    };
    addDeviceColumn('key_fingerprint', "TEXT NOT NULL DEFAULT ''");
    addDeviceColumn(
      'approval_state',
      "TEXT NOT NULL DEFAULT 'approved' CHECK(approval_state IN ('pending', 'approved'))",
    );
    addDeviceColumn('approved_by_device_id', 'TEXT');
    addDeviceColumn('approved_at', 'TEXT');
    const keyPackageColumns = new Set(
      (
        database.prepare('PRAGMA table_info(mls_key_packages)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!keyPackageColumns.has('expires_at')) {
      database.exec('ALTER TABLE mls_key_packages ADD COLUMN expires_at TEXT');
      database.exec(
        `UPDATE mls_key_packages
         SET expires_at = strftime(
           '%Y-%m-%dT%H:%M:%fZ', created_at, '+7 days'
         )
         WHERE expires_at IS NULL`,
      );
    }
    database.exec(
      `UPDATE mls_key_packages
       SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)
       WHERE expires_at IS NOT NULL AND instr(expires_at, 'T') = 0`,
    );
    const conversationColumns = new Set(
      (
        database.prepare('PRAGMA table_info(mls_conversations)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!conversationColumns.has('retention_floor_sequence')) {
      database.exec(
        `ALTER TABLE mls_conversations
         ADD COLUMN retention_floor_sequence INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!conversationColumns.has('active_generation')) {
      database.exec(
        `ALTER TABLE mls_conversations
         ADD COLUMN active_generation INTEGER NOT NULL DEFAULT 1`,
      );
    }
    const eventColumns = new Set(
      (
        database.prepare('PRAGMA table_info(mls_transport_events)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!eventColumns.has('expires_at')) {
      database.exec('ALTER TABLE mls_transport_events ADD COLUMN expires_at TEXT');
      database.exec(
        `UPDATE mls_transport_events
         SET expires_at = strftime(
           '%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days'
         )
         WHERE expires_at IS NULL`,
      );
    }
    if (!eventColumns.has('session_generation')) {
      database.exec(
        `ALTER TABLE mls_transport_events
         ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 1`,
      );
    }
    database.exec(
      `UPDATE mls_transport_events
       SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)
       WHERE expires_at IS NOT NULL AND instr(expires_at, 'T') = 0`,
    );
    database.exec(
      `INSERT OR IGNORE INTO mls_group_sessions
        (organization_id, conversation_id, generation, group_id,
         current_epoch, status, created_at)
       SELECT organization_id, conversation_id, 1, group_id,
              current_epoch, 'active', created_at
       FROM mls_conversations`,
    );
    database.exec(`
      DROP INDEX IF EXISTS idx_e2ee_devices_active;
      CREATE INDEX idx_e2ee_devices_active
        ON e2ee_devices(
          organization_id,
          account_id,
          approval_state,
          revoked_at,
          created_at
        );
      CREATE INDEX IF NOT EXISTS idx_direct_messages_type
        ON direct_messages(
          organization_id,
          recipient_account_id,
          content_type,
          created_at
        );
      CREATE INDEX IF NOT EXISTS idx_direct_message_attachments_storage
        ON direct_message_attachments(storage_backend, storage_key);
      CREATE INDEX IF NOT EXISTS idx_mls_key_packages_expiry
        ON mls_key_packages(expires_at, organization_id);
      CREATE INDEX IF NOT EXISTS idx_mls_key_packages_device_inventory
        ON mls_key_packages(
          organization_id,
          account_id,
          device_id,
          key_package_reference,
          expires_at
        ) WHERE claimed_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_group_sessions_active
        ON mls_group_sessions(organization_id, conversation_id)
        WHERE status = 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mls_group_sessions_reset_event
        ON mls_group_sessions(organization_id, reset_event_id)
        WHERE reset_event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_mls_transport_events_expiry
        ON mls_transport_events(expires_at, sequence);
      CREATE INDEX IF NOT EXISTS idx_mls_transport_events_inventory
        ON mls_transport_events(organization_id, conversation_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_mls_transport_events_inbound_welcome
        ON mls_transport_events(
          organization_id,
          recipient_account_id,
          recipient_device_id,
          event_type,
          sender_account_id,
          expires_at,
          conversation_id,
          session_generation
        );
      CREATE INDEX IF NOT EXISTS idx_mls_rate_buckets_expiry
        ON mls_resource_rate_buckets(bucket_started_at_ms);
    `);
  },
};
