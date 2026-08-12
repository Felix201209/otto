/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const FEDERATION_GATEWAY_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'federation_gateway',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS federation_outbox (
        message_id TEXT PRIMARY KEY,
        recipient_deployment_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        signed_envelope_json TEXT NOT NULL,
        ciphertext_sha256 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK(status IN ('queued', 'sent', 'failed', 'expired')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        expires_at_ms INTEGER NOT NULL,
        next_attempt_at_ms INTEGER,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        sent_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS federation_inbox (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        sender_deployment_id TEXT NOT NULL,
        recipient_principal_id TEXT NOT NULL,
        sender_principal_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        signed_envelope_json TEXT NOT NULL,
        claim_token_ciphertext TEXT,
        claim_token_iv TEXT,
        claim_token_auth_tag TEXT,
        claim_token_key_version INTEGER,
        gateway_acknowledged INTEGER NOT NULL DEFAULT 0
          CHECK(gateway_acknowledged IN (0, 1)),
        discarded INTEGER NOT NULL DEFAULT 0 CHECK(discarded IN (0, 1)),
        consumed_at_ms INTEGER,
        received_at_ms INTEGER NOT NULL,
        acknowledged_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS federation_a2a_grants (
        grant_id TEXT PRIMARY KEY,
        owner_deployment_id TEXT NOT NULL,
        requester_deployment_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        requester_principal_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        consumed_message_id TEXT UNIQUE,
        consumed_at_ms INTEGER,
        revoked_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS federation_blocks (
        blocked_deployment_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS federation_runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS federation_chat_contacts (
        contact_id TEXT PRIMARY KEY,
        owner_account_id TEXT NOT NULL,
        remote_deployment_id TEXT NOT NULL,
        remote_principal_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        deployment_display_name TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(owner_account_id, remote_deployment_id, remote_principal_id),
        FOREIGN KEY(owner_account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS federation_chat_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        contact_id TEXT NOT NULL,
        owner_account_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        signed_envelope_json TEXT NOT NULL,
        received_at_ms INTEGER,
        read_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(contact_id) REFERENCES federation_chat_contacts(contact_id) ON DELETE CASCADE,
        FOREIGN KEY(owner_account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_federation_outbox_delivery
        ON federation_outbox(status, next_attempt_at_ms, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_federation_inbox_recipient_cursor
        ON federation_inbox(recipient_principal_id, cursor);
      CREATE INDEX IF NOT EXISTS idx_federation_inbox_ack
        ON federation_inbox(gateway_acknowledged, discarded, received_at_ms);
      CREATE INDEX IF NOT EXISTS idx_federation_grants_owner_expiry
        ON federation_a2a_grants(owner_deployment_id, expires_at_ms);
      CREATE INDEX IF NOT EXISTS idx_federation_chat_contacts_owner
        ON federation_chat_contacts(owner_account_id, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_federation_chat_messages_conversation
        ON federation_chat_messages(owner_account_id, contact_id, created_at_ms, sequence);
      CREATE INDEX IF NOT EXISTS idx_federation_chat_messages_unread
        ON federation_chat_messages(owner_account_id, direction, read_at_ms, created_at_ms);
    `);
  },
};
