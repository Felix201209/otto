/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const SECURE_MESSAGING_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'secure_messaging',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS e2ee_account_roots (
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        protocol_id TEXT NOT NULL CHECK(protocol_id = 'otto-mls-v1'),
        trust_version INTEGER NOT NULL CHECK(trust_version = 2),
        root_key_id TEXT NOT NULL,
        root_signing_public_key TEXT NOT NULL,
        recovery_public_key TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        nonce TEXT NOT NULL,
        signature TEXT NOT NULL,
        recovery_signature TEXT NOT NULL,
        transparency_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (organization_id, account_id),
        UNIQUE (organization_id, root_key_id),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS e2ee_devices (
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        protocol_id TEXT NOT NULL CHECK(protocol_id = 'otto-mls-v1'),
        trust_version INTEGER NOT NULL CHECK(trust_version = 2),
        device_name TEXT NOT NULL,
        signing_public_key TEXT NOT NULL,
        mls_key_package TEXT NOT NULL,
        credential_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        nonce TEXT NOT NULL,
        signature TEXT NOT NULL,
        transparency_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (organization_id, account_id, device_id),
        UNIQUE (organization_id, account_id, credential_hash),
        FOREIGN KEY (organization_id, account_id)
          REFERENCES e2ee_account_roots(organization_id, account_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS e2ee_device_proofs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        proof_id TEXT NOT NULL UNIQUE,
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        proof_type TEXT NOT NULL CHECK(proof_type IN ('bootstrap', 'approval', 'revocation')),
        actor_device_id TEXT,
        target_device_id TEXT NOT NULL,
        target_credential_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        nonce TEXT NOT NULL,
        signature TEXT NOT NULL,
        transparency_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id, account_id, target_device_id)
          REFERENCES e2ee_devices(organization_id, account_id, device_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS e2ee_transparency_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_sequence INTEGER NOT NULL,
        event_kind TEXT NOT NULL CHECK(event_kind IN (
          'account_root_registered',
          'device_registered',
          'device_bootstrapped',
          'device_approved',
          'device_revoked'
        )),
        payload_json TEXT NOT NULL,
        leaf_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, account_id, account_sequence),
        UNIQUE (organization_id, account_id, leaf_hash),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_e2ee_devices_account
        ON e2ee_devices(organization_id, account_id, issued_at);
      CREATE INDEX IF NOT EXISTS idx_e2ee_device_proofs_account
        ON e2ee_device_proofs(organization_id, account_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_e2ee_transparency_account
        ON e2ee_transparency_log(organization_id, account_id, account_sequence);
    `);
  },
};
