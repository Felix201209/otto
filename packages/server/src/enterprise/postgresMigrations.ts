/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { PostgresMigration } from '../modules/data_platform/postgresDatabaseLifecycle.js';

/** PostgreSQL migrations for the clustered enterprise authority. */
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
  {
    version: 3,
    name: 'sqlite-import-staging',
    sql: `
CREATE TABLE otto_sqlite_import_tables (
  run_id TEXT NOT NULL REFERENCES otto_sqlite_import_runs(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL CHECK (length(table_name) BETWEEN 1 AND 255),
  source_schema_sql TEXT NOT NULL CHECK (length(source_schema_sql) > 0),
  column_names JSONB NOT NULL CHECK (jsonb_typeof(column_names) = 'array'),
  primary_key JSONB NOT NULL CHECK (jsonb_typeof(primary_key) = 'array'),
  source_row_count BIGINT NOT NULL CHECK (source_row_count >= 0),
  source_row_sha256 TEXT NOT NULL CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$'),
  copied_row_count BIGINT CHECK (copied_row_count >= 0),
  copied_row_sha256 TEXT CHECK (copied_row_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('copying', 'verified', 'failed')),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, table_name),
  CHECK (
    state <> 'verified' OR
    (copied_row_count = source_row_count AND copied_row_sha256 = source_row_sha256)
  )
);

CREATE TABLE otto_sqlite_import_rows (
  run_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_index BIGINT NOT NULL CHECK (row_index >= 0),
  row_sha256 TEXT NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
  row_data JSONB NOT NULL CHECK (jsonb_typeof(row_data) = 'array'),
  PRIMARY KEY (run_id, table_name, row_index),
  FOREIGN KEY (run_id, table_name)
    REFERENCES otto_sqlite_import_tables(run_id, table_name) ON DELETE CASCADE
);

CREATE INDEX otto_sqlite_import_rows_verification
  ON otto_sqlite_import_rows (run_id, table_name, row_index);`,
  },
  {
    version: 4,
    name: 'enterprise-core-domain',
    sql: `
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 120),
  type TEXT NOT NULL DEFAULT 'enterprise'
    CHECK (type IN ('personal', 'enterprise', 'park')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  park_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE organization_features (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enterprise_tree BOOLEAN NOT NULL DEFAULT TRUE,
  direct_messages BOOLEAN NOT NULL DEFAULT TRUE,
  atoa BOOLEAN NOT NULL DEFAULT TRUE,
  park_services BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE organization_departments (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, name)
);

CREATE TABLE organization_positions (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  role_mapping TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, department_id, title),
  FOREIGN KEY (organization_id, department_id)
    REFERENCES organization_departments(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  account_type TEXT NOT NULL DEFAULT 'enterprise'
    CHECK (account_type IN ('personal', 'enterprise')),
  employee_id TEXT,
  username TEXT NOT NULL,
  phone TEXT,
  feishu_open_id TEXT,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  role TEXT,
  department TEXT,
  department_id TEXT,
  position_id TEXT,
  position_title TEXT,
  avatar_url TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, username),
  UNIQUE (id, organization_id)
);

CREATE UNIQUE INDEX accounts_phone_active_unique
  ON accounts (phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX accounts_feishu_open_id_active_unique
  ON accounts (feishu_open_id)
  WHERE feishu_open_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX accounts_organization_status
  ON accounts (organization_id, status, id) WHERE deleted_at IS NULL;

CREATE TABLE account_tags (
  account_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 80),
  PRIMARY KEY (account_id, tag),
  FOREIGN KEY (account_id, organization_id)
    REFERENCES accounts(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX account_tags_organization ON account_tags (organization_id, tag);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX auth_sessions_account_active
  ON auth_sessions (account_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE auth_login_limits (
  identity_hash TEXT PRIMARY KEY CHECK (length(identity_hash) = 64),
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX auth_login_limits_blocked
  ON auth_login_limits (blocked_until) WHERE blocked_until IS NOT NULL;

CREATE TABLE audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
  actor_employee_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audit_logs_organization_created
  ON audit_logs (organization_id, created_at DESC, id DESC);

CREATE TABLE e2ee_devices (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 120),
  identity_signing_public_key TEXT NOT NULL,
  device_exchange_public_key TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL CHECK (key_fingerprint ~ '^[0-9a-f]{64}$'),
  approval_state TEXT NOT NULL CHECK (approval_state IN ('pending', 'approved')),
  approved_by_device_id TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (organization_id, account_id, device_id),
  FOREIGN KEY (account_id, organization_id)
    REFERENCES accounts(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX e2ee_devices_active
  ON e2ee_devices (organization_id, account_id, device_id)
  WHERE revoked_at IS NULL;

CREATE TABLE e2ee_key_transparency_log (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  event TEXT NOT NULL
    CHECK (event IN ('bootstrap_approved', 'registered_pending', 'approved', 'revoked')),
  key_fingerprint TEXT NOT NULL CHECK (key_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_device_id TEXT,
  previous_hash TEXT NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  entry_hash TEXT NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, account_id, sequence),
  UNIQUE (organization_id, account_id, entry_hash),
  FOREIGN KEY (account_id, organization_id)
    REFERENCES accounts(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE direct_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sender_account_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL,
  content_type TEXT NOT NULL
    CHECK (content_type IN ('message', 'atoa_request', 'atoa_response')),
  content_ciphertext TEXT,
  content_iv TEXT,
  content_auth_tag TEXT,
  content_key_version INTEGER,
  e2ee_protocol_version INTEGER CHECK (e2ee_protocol_version = 1),
  e2ee_sender_device_id TEXT,
  e2ee_ciphertext TEXT,
  e2ee_nonce TEXT,
  e2ee_signature TEXT,
  e2ee_envelopes JSONB CHECK (jsonb_typeof(e2ee_envelopes) = 'array'),
  in_reply_to_message_id TEXT REFERENCES direct_messages(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TIMESTAMPTZ,
  CHECK (sender_account_id <> recipient_account_id),
  CHECK (
    (e2ee_protocol_version = 1
      AND e2ee_sender_device_id IS NOT NULL
      AND e2ee_ciphertext IS NOT NULL
      AND e2ee_nonce IS NOT NULL
      AND e2ee_signature IS NOT NULL
      AND e2ee_envelopes IS NOT NULL)
    OR
    (e2ee_protocol_version IS NULL
      AND content_ciphertext IS NOT NULL
      AND content_iv IS NOT NULL
      AND content_auth_tag IS NOT NULL
      AND content_key_version IS NOT NULL)
  ),
  FOREIGN KEY (sender_account_id, organization_id)
    REFERENCES accounts(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_account_id, organization_id)
    REFERENCES accounts(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, sender_account_id, e2ee_sender_device_id)
    REFERENCES e2ee_devices(organization_id, account_id, device_id) ON DELETE RESTRICT
);
CREATE INDEX direct_messages_conversation
  ON direct_messages (
    organization_id, sender_account_id, recipient_account_id, created_at DESC, id
  );
CREATE INDEX direct_messages_unread
  ON direct_messages (organization_id, recipient_account_id, created_at DESC)
  WHERE read_at IS NULL;

INSERT INTO organizations (id, name, slug, type, status)
VALUES ('org_default', 'Otto', 'otto-default', 'enterprise', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO organization_features (organization_id)
VALUES ('org_default')
ON CONFLICT (organization_id) DO NOTHING;

CREATE TABLE otto_sqlite_import_promotions (
  run_id TEXT PRIMARY KEY REFERENCES otto_sqlite_import_runs(id) ON DELETE RESTRICT,
  promoted_counts JSONB NOT NULL CHECK (jsonb_typeof(promoted_counts) = 'object'),
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);`,
  },
  {
    version: 5,
    name: 'attachment-tenant-authority',
    sql: `
ALTER TABLE attachment_storage_quotas
  ADD CONSTRAINT attachment_storage_quotas_organization_fk
  FOREIGN KEY (organization_id)
  REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE attachment_objects
  ADD CONSTRAINT attachment_objects_organization_fk
  FOREIGN KEY (organization_id)
  REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE attachment_objects
  ADD CONSTRAINT attachment_objects_owner_fk
  FOREIGN KEY (owner_account_id, organization_id)
  REFERENCES accounts(id, organization_id) ON DELETE CASCADE;

ALTER TABLE attachment_object_access
  ADD CONSTRAINT attachment_object_access_account_fk
  FOREIGN KEY (account_id, organization_id)
  REFERENCES accounts(id, organization_id) ON DELETE CASCADE;

ALTER TABLE attachment_objects
  DROP CONSTRAINT attachment_objects_migration_state_check;
ALTER TABLE attachment_objects
  ADD CONSTRAINT attachment_objects_migration_state_check
  CHECK (migration_state IN (
    'none', 'copying', 'verified', 'failed', 'purging', 'orphan_cleaning'
  ));

ALTER TABLE direct_messages
  ADD CONSTRAINT direct_messages_id_organization_unique
  UNIQUE (id, organization_id);

CREATE TABLE direct_message_attachment_objects (
  attachment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 5),
  e2ee_nonce TEXT NOT NULL,
  ciphertext_bytes BIGINT NOT NULL CHECK (ciphertext_bytes > 16),
  ciphertext_sha256 TEXT NOT NULL CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (message_id, ordinal),
  FOREIGN KEY (message_id, organization_id)
    REFERENCES direct_messages(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (attachment_id, organization_id)
    REFERENCES attachment_objects(id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX direct_message_attachment_objects_message
  ON direct_message_attachment_objects (message_id, ordinal);`,
  },
  {
    version: 6,
    name: 'sqlite-attachment-import-preparation',
    sql: `
CREATE TABLE otto_sqlite_import_attachment_objects (
  run_id TEXT NOT NULL REFERENCES otto_sqlite_import_runs(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  sender_account_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 5),
  ciphertext_bytes BIGINT NOT NULL CHECK (ciphertext_bytes > 16),
  ciphertext_sha256 TEXT NOT NULL CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  e2ee_nonce TEXT NOT NULL,
  source_backend TEXT NOT NULL
    CHECK (source_backend IN ('sqlite', 'encrypted-filesystem')),
  source_storage_key TEXT,
  s3_storage_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('verified', 'failed')),
  failure_code TEXT,
  source_created_at TIMESTAMPTZ NOT NULL,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, attachment_id),
  UNIQUE (run_id, message_id, ordinal),
  CHECK (
    (source_backend = 'sqlite' AND source_storage_key IS NULL) OR
    (source_backend = 'encrypted-filesystem' AND source_storage_key IS NOT NULL)
  ),
  CHECK (
    (state = 'verified' AND s3_storage_key IS NOT NULL AND failure_code IS NULL) OR
    (state = 'failed' AND s3_storage_key IS NULL AND failure_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX otto_sqlite_import_attachment_objects_s3_key
  ON otto_sqlite_import_attachment_objects (s3_storage_key)
  WHERE s3_storage_key IS NOT NULL;`,
  },
  {
    version: 7,
    name: 'enterprise-registration-authority',
    sql: `
ALTER TABLE organizations
  ADD COLUMN invite_secret TEXT
  CHECK (invite_secret IS NULL OR invite_secret ~ '^[0-9a-f]{64}$');

CREATE TABLE organization_invites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 16 AND 200),
  code_hash TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  default_department TEXT CHECK (default_department IS NULL OR length(default_department) <= 120),
  department_id TEXT,
  position_id TEXT,
  position_title TEXT CHECK (position_title IS NULL OR length(position_title) <= 120),
  default_role TEXT CHECK (default_role IS NULL OR length(default_role) <= 120),
  max_uses INTEGER CHECK (max_uses BETWEEN 1 AND 10000),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > issued_at),
  CHECK (max_uses IS NULL OR used_count <= max_uses),
  FOREIGN KEY (organization_id, department_id)
    REFERENCES organization_departments(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, position_id)
    REFERENCES organization_positions(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX organization_invites_current
  ON organization_invites (organization_id, issued_at DESC);
CREATE INDEX organization_invites_active
  ON organization_invites (organization_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE sms_registration_challenges (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone TEXT NOT NULL CHECK (phone ~ '^\\+86[1-9][0-9]{10}$'),
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts_remaining INTEGER NOT NULL DEFAULT 5
    CHECK (attempts_remaining BETWEEN 0 AND 5),
  organization_invite_id TEXT REFERENCES organization_invites(id) ON DELETE RESTRICT,
  department TEXT,
  department_id TEXT,
  position_id TEXT,
  position_title TEXT,
  role TEXT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sms_registration_challenges_phone_recent
  ON sms_registration_challenges (phone, created_at DESC);
CREATE INDEX sms_registration_challenges_expiry
  ON sms_registration_challenges (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE legal_consents (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL CHECK (document_id IN ('terms', 'privacy')),
  document_version TEXT NOT NULL,
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  source TEXT NOT NULL CHECK (source IN ('registration', 'settings', 'migration')),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, document_id, document_version),
  FOREIGN KEY (account_id, organization_id)
    REFERENCES accounts(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX legal_consents_account
  ON legal_consents (account_id, accepted_at DESC);`,
  },
  {
    version: 8,
    name: 'mls-ciphertext-transport',
    sql: `
CREATE TABLE mls_key_packages (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_package_reference TEXT NOT NULL CHECK (key_package_reference ~ '^[0-9a-f]{64}$'),
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  ciphersuite TEXT NOT NULL
    CHECK (ciphersuite = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'),
  key_package TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TIMESTAMPTZ,
  claimed_by_account_id TEXT,
  claimed_by_device_id TEXT,
  welcome_event_id TEXT,
  PRIMARY KEY (organization_id, key_package_reference),
  FOREIGN KEY (organization_id, account_id, device_id)
    REFERENCES e2ee_devices(organization_id, account_id, device_id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, claimed_by_account_id, claimed_by_device_id)
    REFERENCES e2ee_devices(organization_id, account_id, device_id)
    ON DELETE RESTRICT,
  CHECK (
    (claimed_at IS NULL AND claimed_by_account_id IS NULL AND claimed_by_device_id IS NULL)
    OR
    (claimed_at IS NOT NULL AND claimed_by_account_id IS NOT NULL AND claimed_by_device_id IS NOT NULL)
  )
);
CREATE INDEX mls_key_packages_unclaimed
  ON mls_key_packages (organization_id, account_id, created_at, key_package_reference)
  WHERE claimed_at IS NULL;
CREATE UNIQUE INDEX mls_key_packages_welcome
  ON mls_key_packages (organization_id, welcome_event_id)
  WHERE welcome_event_id IS NOT NULL;

CREATE TABLE mls_conversations (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL CHECK (conversation_id ~ '^[0-9a-f]{64}$'),
  participant_a_account_id TEXT NOT NULL,
  participant_b_account_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  current_epoch BIGINT NOT NULL CHECK (current_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, conversation_id),
  UNIQUE (organization_id, participant_a_account_id, participant_b_account_id),
  CHECK (participant_a_account_id < participant_b_account_id),
  FOREIGN KEY (participant_a_account_id, organization_id)
    REFERENCES accounts(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (participant_b_account_id, organization_id)
    REFERENCES accounts(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE mls_transport_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_account_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  recipient_account_id TEXT,
  recipient_device_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('welcome', 'commit', 'application')),
  epoch BIGINT NOT NULL CHECK (epoch > 0),
  group_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  key_package_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, conversation_id)
    REFERENCES mls_conversations(organization_id, conversation_id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, sender_account_id, sender_device_id)
    REFERENCES e2ee_devices(organization_id, account_id, device_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, recipient_account_id, recipient_device_id)
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
CREATE INDEX mls_transport_events_conversation
  ON mls_transport_events (organization_id, conversation_id, sequence);
CREATE UNIQUE INDEX mls_transport_events_welcome_package
  ON mls_transport_events (organization_id, key_package_reference)
  WHERE key_package_reference IS NOT NULL;

-- One-time claims are selected with SELECT ... FOR UPDATE SKIP LOCKED by the repository.
`,
  },
  {
    version: 9,
    name: 'mls-resource-governance',
    sql: `
ALTER TABLE mls_key_packages ADD COLUMN expires_at TIMESTAMPTZ;
UPDATE mls_key_packages
SET expires_at = created_at + INTERVAL '7 days'
WHERE expires_at IS NULL;
ALTER TABLE mls_key_packages ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE mls_key_packages
  ALTER COLUMN expires_at SET DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days');

ALTER TABLE mls_conversations
  ADD COLUMN retention_floor_sequence BIGINT NOT NULL DEFAULT 0
  CHECK (retention_floor_sequence >= 0);

ALTER TABLE mls_transport_events ADD COLUMN expires_at TIMESTAMPTZ;
UPDATE mls_transport_events
SET expires_at = created_at + INTERVAL '90 days'
WHERE expires_at IS NULL;
ALTER TABLE mls_transport_events ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE mls_transport_events
  ALTER COLUMN expires_at SET DEFAULT (CURRENT_TIMESTAMP + INTERVAL '90 days');

CREATE TABLE mls_resource_rate_buckets (
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('key_package_publish', 'transport_event_append')),
  bucket_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (
    organization_id, account_id, device_id, action, bucket_started_at
  ),
  FOREIGN KEY (organization_id, account_id, device_id)
    REFERENCES e2ee_devices(organization_id, account_id, device_id)
    ON DELETE CASCADE
);

CREATE INDEX mls_key_packages_expiry
  ON mls_key_packages (expires_at, organization_id);
CREATE INDEX mls_transport_events_expiry
  ON mls_transport_events (expires_at, sequence);
CREATE INDEX mls_transport_events_inventory
  ON mls_transport_events (organization_id, conversation_id, expires_at);
CREATE INDEX mls_resource_rate_buckets_expiry
  ON mls_resource_rate_buckets (bucket_started_at);
`,
  },
  {
    version: 10,
    name: 'mls-group-session-history',
    sql: `
ALTER TABLE mls_conversations
  ADD COLUMN active_generation BIGINT NOT NULL DEFAULT 1
  CHECK (active_generation > 0);

CREATE TABLE mls_group_sessions (
  organization_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation > 0),
  group_id TEXT NOT NULL,
  current_epoch BIGINT NOT NULL CHECK (current_epoch > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retired_at TIMESTAMPTZ,
  reset_by_account_id TEXT,
  reset_by_device_id TEXT,
  reset_event_id TEXT,
  PRIMARY KEY (organization_id, conversation_id, generation),
  UNIQUE (organization_id, conversation_id, group_id),
  UNIQUE (organization_id, reset_event_id),
  FOREIGN KEY (organization_id, conversation_id)
    REFERENCES mls_conversations(organization_id, conversation_id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, reset_by_account_id, reset_by_device_id)
    REFERENCES e2ee_devices(organization_id, account_id, device_id)
    ON DELETE RESTRICT,
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

INSERT INTO mls_group_sessions
  (organization_id, conversation_id, generation, group_id,
   current_epoch, status, created_at)
SELECT organization_id, conversation_id, 1, group_id,
       current_epoch, 'active', created_at
FROM mls_conversations;

ALTER TABLE mls_transport_events
  ADD COLUMN session_generation BIGINT NOT NULL DEFAULT 1
  CHECK (session_generation > 0);
ALTER TABLE mls_transport_events
  ADD CONSTRAINT mls_transport_events_group_session_fk
  FOREIGN KEY (organization_id, conversation_id, session_generation)
  REFERENCES mls_group_sessions(organization_id, conversation_id, generation)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX mls_group_sessions_active
  ON mls_group_sessions (organization_id, conversation_id)
  WHERE status = 'active';
CREATE INDEX mls_group_sessions_retired
  ON mls_group_sessions (retired_at, organization_id, conversation_id)
  WHERE status = 'retired';
`,
  },
  {
    version: 11,
    name: 'mls-inbound-welcome-discovery-index',
    sql: `
CREATE INDEX mls_transport_events_inbound_welcome
  ON mls_transport_events (
    organization_id,
    recipient_account_id,
    recipient_device_id,
    sender_account_id COLLATE "C"
  ) INCLUDE (expires_at, conversation_id, session_generation)
  WHERE event_type = 'welcome';
`,
  },
  {
    version: 12,
    name: 'mls-key-package-device-inventory-index',
    sql: `
CREATE INDEX mls_key_packages_device_inventory
  ON mls_key_packages (
    organization_id,
    account_id,
    device_id,
    key_package_reference
  ) INCLUDE (expires_at)
  WHERE claimed_at IS NULL;
`,
  },
];

export const ENTERPRISE_POSTGRES_SCHEMA_VERSION =
  ENTERPRISE_POSTGRES_MIGRATIONS.length;
