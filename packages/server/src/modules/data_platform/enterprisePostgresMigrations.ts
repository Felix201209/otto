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
  {
    version: 2,
    name: 'attachment-object-metadata',
    sql: `
CREATE TABLE attachment_storage_quotas (
  organization_id TEXT PRIMARY KEY,
  max_bytes BIGINT NOT NULL CHECK (max_bytes > 0),
  reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  stored_bytes BIGINT NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (reserved_bytes + stored_bytes <= max_bytes)
);

CREATE TABLE attachment_objects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'uploading', 'verifying', 'cleaning', 'available', 'failed')),
  encryption TEXT NOT NULL CHECK (encryption IN ('e2ee-client-v1', 'server-envelope-v1')),
  ciphertext_bytes BIGINT NOT NULL CHECK (ciphertext_bytes > 0),
  ciphertext_sha256 TEXT NOT NULL CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  storage_backend TEXT CHECK (storage_backend IN ('encrypted-filesystem', 's3')),
  storage_key TEXT,
  multipart_upload_id TEXT,
  legacy_storage_backend TEXT CHECK (legacy_storage_backend IN ('encrypted-filesystem', 's3')),
  legacy_storage_key TEXT,
  legacy_delete_after TIMESTAMPTZ,
  migration_state TEXT NOT NULL DEFAULT 'none'
    CHECK (migration_state IN ('none', 'copying', 'verified', 'failed', 'purging')),
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  failure_code TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  available_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (id, organization_id),
  CHECK (NOT legal_hold OR state = 'available'),
  CHECK (NOT legal_hold OR migration_state <> 'purging'),
  CHECK ((storage_backend IS NULL) = (storage_key IS NULL)),
  CHECK ((legacy_storage_backend IS NULL) = (legacy_storage_key IS NULL))
);

CREATE UNIQUE INDEX attachment_objects_storage_key
  ON attachment_objects (storage_backend, storage_key)
  WHERE storage_key IS NOT NULL;
CREATE INDEX attachment_objects_expiry
  ON attachment_objects (state, expires_at)
  WHERE state IN ('reserved', 'uploading', 'verifying', 'cleaning');
CREATE INDEX attachment_objects_legacy_cleanup
  ON attachment_objects (legacy_delete_after)
  WHERE legacy_storage_key IS NOT NULL;

CREATE TABLE attachment_multipart_parts (
  attachment_id TEXT NOT NULL REFERENCES attachment_objects(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL CHECK (length(etag) BETWEEN 1 AND 512),
  ciphertext_bytes BIGINT NOT NULL CHECK (ciphertext_bytes > 0),
  ciphertext_sha256 TEXT NOT NULL CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (attachment_id, part_number)
);

CREATE TABLE attachment_object_access (
  attachment_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (attachment_id, account_id),
  FOREIGN KEY (attachment_id, organization_id)
    REFERENCES attachment_objects(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX attachment_object_access_lookup
  ON attachment_object_access (organization_id, account_id, attachment_id);`,
  },
];

export const ENTERPRISE_POSTGRES_SCHEMA_VERSION =
  ENTERPRISE_POSTGRES_MIGRATIONS.length;
