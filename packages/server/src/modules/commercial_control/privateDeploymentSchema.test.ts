/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR } from './privateDeploymentSchema.js';

function applySchema(database: Database): void {
  applyDatabaseSchemaContributors(database, [
    PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR,
  ]);
}

describe('private deployment schema contributor', () => {
  it('creates deployment, license, and telemetry storage idempotently', () => {
    const database = new Database(':memory:');
    try {
      applySchema(database);
      database.exec(`
        INSERT INTO deployment_settings (key, value)
        VALUES ('deployment_id', 'dep-1');
        INSERT INTO deployment_license
          (id, deployment_id, customer_name, plan, expires_at_ms, seat_limit,
           modules_json, issued_at_ms, signature, raw_json)
        VALUES
          ('license-1', 'dep-1', 'Customer', 'enterprise', 2000, 20,
           '["meeting_agent"]', 1000, 'signature', '{}');
        INSERT INTO telemetry_events
          (id, deployment_id, event_type, payload_json, signature, created_at_ms)
        VALUES ('event-1', 'dep-1', 'startup', '{}', 'signature', 1000);
      `);
      applySchema(database);

      expect(
        database
          .prepare(
            `SELECT offline, telemetry_allowed
             FROM deployment_license WHERE id = ?`,
          )
          .get('license-1'),
      ).toEqual({ offline: 0, telemetry_allowed: 1 });
      expect(
        database
          .prepare(
            `SELECT status, attempts, sent_at_ms
             FROM telemetry_events WHERE id = ?`,
          )
          .get('event-1'),
      ).toEqual({ status: 'queued', attempts: 0, sent_at_ms: null });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name LIKE 'idx_telemetry_events_%'
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'idx_telemetry_events_deployment_created' },
        { name: 'idx_telemetry_events_status_created' },
      ]);
    } finally {
      database.close();
    }
  });

  it('enforces license flags and telemetry queue states', () => {
    const database = new Database(':memory:');
    try {
      applySchema(database);
      expect(() =>
        database.exec(`
          INSERT INTO deployment_license
            (id, deployment_id, customer_name, plan, expires_at_ms, seat_limit,
             modules_json, offline, issued_at_ms, signature, raw_json)
          VALUES
            ('license-1', 'dep-1', 'Customer', 'enterprise', 2000, 20,
             '[]', 2, 1000, 'signature', '{}');
        `),
      ).toThrow(/CHECK constraint failed/i);
      expect(() =>
        database.exec(`
          INSERT INTO deployment_license
            (id, deployment_id, customer_name, plan, expires_at_ms, seat_limit,
             modules_json, telemetry_allowed, issued_at_ms, signature, raw_json)
          VALUES
            ('license-2', 'dep-1', 'Customer', 'enterprise', 2000, 20,
             '[]', -1, 1000, 'signature', '{}');
        `),
      ).toThrow(/CHECK constraint failed/i);
      expect(() =>
        database.exec(`
          INSERT INTO telemetry_events
            (id, deployment_id, event_type, payload_json, signature, status, created_at_ms)
          VALUES
            ('event-1', 'dep-1', 'startup', '{}', 'signature', 'unknown', 1000);
        `),
      ).toThrow(/CHECK constraint failed/i);
    } finally {
      database.close();
    }
  });

  it('preserves existing deployment settings while adopting the schema', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE deployment_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO deployment_settings (key, value)
        VALUES ('telemetry_enabled', 'false');
      `);

      applySchema(database);

      expect(
        database
          .prepare('SELECT value FROM deployment_settings WHERE key = ?')
          .get('telemetry_enabled'),
      ).toEqual({ value: 'false' });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'table'
               AND name IN ('deployment_settings', 'deployment_license',
                            'deployment_license_leases', 'telemetry_events',
                            'billing_usage_outbox', 'billing_admission_outbox')`,
          )
          .get(),
      ).toEqual({ count: 6 });
    } finally {
      database.close();
    }
  });
});
