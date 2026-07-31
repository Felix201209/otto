/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { PostgresMigration } from './postgresDatabaseLifecycle.js';

/**
 * PostgreSQL migration control-plane schema. Domain repositories remain on the
 * local SQLite adapter until each async PostgreSQL repository is migrated.
 */
export const ENTERPRISE_POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [
  {
    version: 1,
    name: 'sqlite-import-control-plane',
    sql: `
CREATE TABLE otto_sqlite_import_runs (
  id TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  source_schema_version INTEGER NOT NULL CHECK (source_schema_version > 0),
  target_schema_version INTEGER NOT NULL CHECK (target_schema_version > 0),
  state TEXT NOT NULL CHECK (state IN ('preparing', 'copying', 'verified', 'failed')),
  row_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  failure_code TEXT
);

CREATE UNIQUE INDEX otto_sqlite_import_runs_verified_source
  ON otto_sqlite_import_runs (source_sha256)
  WHERE state = 'verified';`,
  },
];

export const ENTERPRISE_POSTGRES_SCHEMA_VERSION =
  ENTERPRISE_POSTGRES_MIGRATIONS.length;
