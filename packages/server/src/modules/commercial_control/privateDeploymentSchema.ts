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
        deployment_id TEXT NOT NULL,
        organization_id TEXT,
        customer_name TEXT NOT NULL,
        plan TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        seat_limit INTEGER NOT NULL,
        modules_json TEXT NOT NULL,
        offline INTEGER NOT NULL DEFAULT 0 CHECK(offline IN (0, 1)),
        telemetry_allowed INTEGER NOT NULL DEFAULT 1 CHECK(telemetry_allowed IN (0, 1)),
        issued_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        signature TEXT NOT NULL,
        raw_json TEXT NOT NULL,
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
        sent_at_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_events_status_created
        ON telemetry_events(status, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_telemetry_events_deployment_created
        ON telemetry_events(deployment_id, created_at_ms);
    `);
    },
  };
