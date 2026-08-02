/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor =
  {
    id: 'commercial_control_private_deployment',
    apply(database) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS deployment_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS deployment_license (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 1,
        deployment_id TEXT NOT NULL,
        organization_id TEXT,
        machine_fingerprint TEXT,
        customer_name TEXT NOT NULL,
        plan TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        seat_limit INTEGER NOT NULL,
        grace_period_ms INTEGER NOT NULL DEFAULT 0,
        seat_enforcement TEXT NOT NULL DEFAULT 'monitor'
          CHECK(seat_enforcement IN ('monitor', 'enforce')),
        modules_json TEXT NOT NULL,
        offline INTEGER NOT NULL DEFAULT 0 CHECK(offline IN (0, 1)),
        telemetry_allowed INTEGER NOT NULL DEFAULT 1 CHECK(telemetry_allowed IN (0, 1)),
        issued_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        signature TEXT NOT NULL,
        signature_algorithm TEXT NOT NULL DEFAULT 'ed25519',
        signing_key_id TEXT,
        lease_endpoint TEXT,
        raw_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS deployment_license_leases (
        license_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        machine_fingerprint TEXT NOT NULL,
        issued_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        signature TEXT NOT NULL,
        signature_algorithm TEXT NOT NULL DEFAULT 'ed25519',
        signing_key_id TEXT,
        raw_json TEXT NOT NULL,
        last_refresh_at_ms INTEGER NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS telemetry_events (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        organization_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'sent', 'failed', 'discarded')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        sent_at_ms INTEGER,
        next_attempt_at_ms INTEGER,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS telemetry_ingest_events (
        deployment_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        organization_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        integrity TEXT NOT NULL,
        source_created_at_ms INTEGER NOT NULL,
        received_at_ms INTEGER NOT NULL,
        PRIMARY KEY (deployment_id, event_id)
      );

      CREATE TABLE IF NOT EXISTS telemetry_ingest_nonces (
        deployment_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL,
        PRIMARY KEY (deployment_id, nonce)
      );

      CREATE TABLE IF NOT EXISTS billing_usage_outbox (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        module TEXT NOT NULL,
        units INTEGER NOT NULL CHECK(units > 0),
        reference_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK(status IN ('queued', 'sent', 'failed', 'discarded')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        created_at_ms INTEGER NOT NULL,
        sent_at_ms INTEGER,
        next_attempt_at_ms INTEGER,
        last_error TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS billing_admission_outbox (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        hold_id TEXT NOT NULL,
        module TEXT NOT NULL,
        units INTEGER NOT NULL CHECK(units > 0),
        reference_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        desired_outcome TEXT CHECK(desired_outcome IN ('capture', 'release')),
        status TEXT NOT NULL DEFAULT 'authorized'
          CHECK(status IN ('authorized', 'pending', 'failed', 'finalized', 'discarded')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        created_at_ms INTEGER NOT NULL,
        finalized_at_ms INTEGER,
        next_attempt_at_ms INTEGER,
        last_error TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_events_status_created
        ON telemetry_events(status, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_telemetry_events_deployment_created
        ON telemetry_events(deployment_id, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_telemetry_ingest_received
        ON telemetry_ingest_events(received_at_ms);
      CREATE INDEX IF NOT EXISTS idx_telemetry_ingest_nonces_received
        ON telemetry_ingest_nonces(received_at_ms);
      CREATE INDEX IF NOT EXISTS idx_billing_usage_outbox_delivery
        ON billing_usage_outbox(status, next_attempt_at_ms, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_billing_admission_outbox_delivery
        ON billing_admission_outbox(status, next_attempt_at_ms, created_at_ms);
    `);

      const licenseColumns = new Set(
        (
          database.prepare('PRAGMA table_info(deployment_license)').all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      const addLicenseColumn = (name: string, definition: string) => {
        if (!licenseColumns.has(name)) {
          database.exec(
            `ALTER TABLE deployment_license ADD COLUMN ${name} ${definition}`,
          );
        }
      };
      addLicenseColumn('machine_fingerprint', 'TEXT');
      addLicenseColumn('revision', 'INTEGER NOT NULL DEFAULT 1');
      addLicenseColumn('grace_period_ms', 'INTEGER NOT NULL DEFAULT 0');
      addLicenseColumn(
        'seat_enforcement',
        "TEXT NOT NULL DEFAULT 'monitor'",
      );
      addLicenseColumn(
        'signature_algorithm',
        "TEXT NOT NULL DEFAULT 'ed25519'",
      );
      addLicenseColumn('signing_key_id', 'TEXT');
      addLicenseColumn('lease_endpoint', 'TEXT');

      const telemetryColumns = new Set(
        (
          database.prepare('PRAGMA table_info(telemetry_events)').all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      if (!telemetryColumns.has('next_attempt_at_ms')) {
        database.exec(
          'ALTER TABLE telemetry_events ADD COLUMN next_attempt_at_ms INTEGER',
        );
      }
      if (!telemetryColumns.has('last_error')) {
        database.exec(
          'ALTER TABLE telemetry_events ADD COLUMN last_error TEXT',
        );
      }
    },
  };
