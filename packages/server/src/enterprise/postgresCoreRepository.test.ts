/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { currentLegalDocumentReferences } from '../modules/data_governance/index.js';
import { parseMlsMemberAddCommitEnvelope } from '../modules/collaboration/index.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from './postgresMigrations.js';
import {
  createPostgresEnterpriseCoreRepository,
  normalizePostgresEnterprisePhone,
  type PostgresEnterpriseAccountView,
} from './postgresCoreRepository.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryResult,
} from '../modules/data_platform/postgresDatabaseLifecycle.js';

function result<Row extends Record<string, unknown>>(
  rows: Row[] = [],
  rowCount: number | null = rows.length,
): PostgresQueryResult<Row> {
  return { rows, rowCount };
}

const governanceAccount: PostgresEnterpriseAccountView = {
  id: 'acc_admin',
  organizationId: 'org_default',
  organizationName: 'Otto',
  accountType: 'enterprise',
  employeeId: null,
  username: 'admin',
  phone: null,
  feishuOpenId: null,
  name: 'Administrator',
  role: 'Administrator',
  department: null,
  departmentId: null,
  positionId: null,
  positionTitle: null,
  avatarUrl: null,
  isAdmin: true,
  status: 'active',
  tags: [],
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
};

describe('PostgreSQL enterprise core authority', () => {
  it('installs authoritative organization, account, session, audit and E2EE tables', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 4,
    );
    expect(migration).toMatchObject({
      version: 4,
      name: 'enterprise-core-domain',
    });
    for (const table of [
      'organizations',
      'accounts',
      'auth_sessions',
      'auth_login_limits',
      'audit_logs',
      'e2ee_devices',
      'e2ee_key_transparency_log',
      'direct_messages',
    ]) {
      expect(migration!.sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration!.sql).toContain('token_hash TEXT PRIMARY KEY');
    expect(migration!.sql).not.toContain('token TEXT PRIMARY KEY');
  });

  it('enforces attachment tenant and account ownership in PostgreSQL', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 5,
    );
    expect(migration).toMatchObject({
      name: 'attachment-tenant-authority',
    });
    expect(migration!.sql).toContain(
      'FOREIGN KEY (owner_account_id, organization_id)',
    );
    expect(migration!.sql).toContain(
      'FOREIGN KEY (account_id, organization_id)',
    );
    expect(migration!.sql).toContain(
      'CREATE TABLE direct_message_attachment_objects',
    );
  });

  it('installs PostgreSQL authority for invitations, SMS registration and legal consent', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 7,
    );
    expect(migration).toMatchObject({
      version: 7,
      name: 'enterprise-registration-authority',
    });
    for (const table of [
      'organization_invites',
      'sms_registration_challenges',
      'legal_consents',
    ]) {
      expect(migration!.sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration!.sql).toContain('code_hash TEXT NOT NULL UNIQUE');
    expect(migration!.sql).not.toContain('code TEXT NOT NULL');
  });

  it('installs tenant-bound PostgreSQL authority for the remaining business domains', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 13,
    );
    expect(migration).toMatchObject({
      version: 13,
      name: 'enterprise-business-authority',
    });
    for (const table of [
      'account_sync_snapshots',
      'enterprise_business_records',
      'enterprise_business_events',
    ]) {
      expect(migration!.sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration!.sql).toContain(
      'FOREIGN KEY (account_id, organization_id)',
    );
    expect(migration!.sql).toContain(
      'FOREIGN KEY (owner_account_id, organization_id)',
    );
    expect(migration!.sql).toContain('payload_ciphertext TEXT NOT NULL');
    expect(migration!.sql).not.toContain('payload_plaintext');
  });

  it('binds MLS attachment objects to one generation and device roster', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 14,
    );
    expect(migration).toMatchObject({
      version: 14,
      name: 'mls-attachment-object-authority',
    });
    expect(migration!.sql).toContain("'mls-client-v1'");
    expect(migration!.sql).toContain('mls_authorized_devices JSONB');
    expect(migration!.sql).toContain('mls_participant_account_ids JSONB');
    expect(migration!.sql).toContain(
      'REFERENCES mls_group_sessions(organization_id, conversation_id, generation)',
    );
    expect(migration!.sql).toContain(
      'attachment_objects_mls_authorization_all_or_none',
    );
  });

  it('requires an exact policy hash before PostgreSQL reports current consent', async () => {
    const references = currentLegalDocumentReferences();
    const pool: PostgresPoolLike = {
      connect: vi.fn(),
      query: vi.fn(async () => result([
        {
          document_id: references[0]!.id,
          document_version: references[0]!.version,
          policy_hash: references[0]!.hash,
          accepted_at: new Date('2026-08-03T00:00:00.000Z'),
        },
        {
          document_id: references[1]!.id,
          document_version: references[1]!.version,
          policy_hash: '0'.repeat(64),
          accepted_at: new Date('2026-08-03T00:00:00.000Z'),
        },
      ])),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    const profile = await repository.getDataGovernanceProfile(governanceAccount);

    expect(profile.documents.map((document) => document.accepted)).toEqual([
      true,
      false,
    ]);
    expect(profile.currentConsentComplete).toBe(false);
  });

  it('records both current document hashes in one PostgreSQL transaction', async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        return result();
      }),
      release: vi.fn(),
    };
    const pool: PostgresPoolLike = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });
    const references = currentLegalDocumentReferences();

    await repository.recordCurrentLegalConsent(governanceAccount, references);

    expect(statements.map((statement) => statement.sql.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO legal_consents'),
      expect.stringContaining('INSERT INTO legal_consents'),
      'COMMIT',
    ]);
    expect(statements[1]!.values).toContain(references[0]!.hash);
    expect(statements[2]!.values).toContain(references[1]!.hash);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('installs opaque MLS transport tables without plaintext or private-key columns', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 8,
    );
    expect(migration).toMatchObject({
      version: 8,
      name: 'mls-ciphertext-transport',
    });
    for (const table of [
      'mls_key_packages',
      'mls_conversations',
      'mls_transport_events',
    ]) {
      expect(migration!.sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration!.sql).not.toMatch(/plaintext|private_key/i);
  });

  it('installs durable PostgreSQL MLS resource governance', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 9,
    );
    expect(migration).toMatchObject({
      version: 9,
      name: 'mls-resource-governance',
    });
    expect(migration!.sql).toContain('CREATE TABLE mls_resource_rate_buckets');
    expect(migration!.sql).toContain('retention_floor_sequence');
    expect(migration!.sql).toContain('expires_at');
  });

  it('installs versioned MLS group-session history for explicit resets', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 10,
    );
    expect(migration).toMatchObject({
      version: 10,
      name: 'mls-group-session-history',
    });
    expect(migration!.sql).toContain('CREATE TABLE mls_group_sessions');
    expect(migration!.sql).toContain('active_generation');
    expect(migration!.sql).toContain('session_generation');
    expect(migration!.sql).toContain('mls_group_sessions_active');
  });

  it('indexes exact-device inbound Welcome discovery without indexing payloads', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 11,
    );
    expect(migration).toMatchObject({
      version: 11,
      name: 'mls-inbound-welcome-discovery-index',
    });
    expect(migration!.sql).toContain(
      'mls_transport_events_inbound_welcome',
    );
    expect(migration!.sql).toContain('recipient_device_id');
    expect(migration!.sql).toContain("WHERE event_type = 'welcome'");
    expect(migration!.sql).not.toContain('payload');
  });

  it('indexes exact-device unclaimed KeyPackage inventory without key bytes', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.version === 12,
    );
    expect(migration).toMatchObject({
      version: 12,
      name: 'mls-key-package-device-inventory-index',
    });
    expect(migration!.sql).toContain('mls_key_packages_device_inventory');
    expect(migration!.sql).toContain('device_id');
    expect(migration!.sql).toContain('WHERE claimed_at IS NULL');
    expect(migration!.sql).not.toContain('key_package)');
  });

  it('checks for a recoverable claim before locking a new KeyPackage', async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    const packageRow = {
      key_package_reference: 'a'.repeat(64),
      account_id: 'acc_bob',
      device_id: 'bob-device',
      ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
      key_package: Buffer.from('key-package').toString('base64'),
      created_at: new Date('2026-08-01T00:00:00.000Z'),
      claimed_at: null,
      claimed_by_account_id: null,
      claimed_by_device_id: null,
      welcome_event_id: null,
      expires_at: new Date('2026-08-08T00:00:00.000Z'),
    };
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.includes('SELECT account.id FROM accounts')) {
          return result([{ id: 'acc_alice' }, { id: 'acc_bob' }]);
        }
        if (sql.includes('SELECT 1 FROM e2ee_devices')) {
          return result([{ available: 1 }]);
        }
        if (
          sql.includes('SELECT package.* FROM mls_key_packages') &&
          sql.includes('claimed_by_account_id = $4')
        ) {
          return result();
        }
        if (sql.includes('SELECT package.* FROM mls_key_packages')) {
          return result([packageRow]);
        }
        if (sql.includes('UPDATE mls_key_packages')) {
          return result([
            {
              ...packageRow,
              claimed_at: new Date('2026-08-01T00:00:01.000Z'),
              claimed_by_account_id: 'acc_alice',
              claimed_by_device_id: 'alice-device',
            },
          ]);
        }
        return result();
      }),
      release: vi.fn(),
    };
    const pool: PostgresPoolLike = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    await expect(
      repository.claimMlsKeyPackage({
        organizationId: 'org_default',
        requesterAccountId: 'acc_alice',
        requesterDeviceId: 'alice-device',
        recipientAccountId: 'acc_bob',
      }),
    ).resolves.toMatchObject({
      reference: 'a'.repeat(64),
      accountId: 'acc_bob',
      claimedAt: '2026-08-01T00:00:01.000Z',
    });
    expect(
      statements.find((statement) =>
        statement.sql.includes('FOR UPDATE OF package SKIP LOCKED'),
      )?.sql,
    ).toContain('FOR UPDATE OF package SKIP LOCKED');
    expect(statements.map((statement) => statement.sql.trim())).toEqual(
      expect.arrayContaining(['BEGIN', 'COMMIT']),
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('discovers PostgreSQL Welcome peers only through the active device generation', async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    const pool: PostgresPoolLike = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.includes('SELECT 1 FROM accounts AS account')) {
          return result([{ available: 1 }]);
        }
        if (sql.includes('SELECT 1 FROM e2ee_devices')) {
          return result([{ available: 1 }]);
        }
        if (sql.includes('SELECT DISTINCT')) {
          return result([
            { peer_account_id: 'acc_alice' },
            { peer_account_id: 'acc_carol' },
          ]);
        }
        return result();
      }),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    await expect(
      repository.listMlsInboundConversationPeers({
        organizationId: 'org_default',
        accountId: 'acc_bob',
        deviceId: 'bob-device',
        afterPeerAccountId: 'acc_aaron',
        limit: 25,
      }),
    ).resolves.toEqual(['acc_alice', 'acc_carol']);

    const discovery = statements.find((statement) =>
      statement.sql.includes('SELECT DISTINCT'),
    );
    expect(discovery?.sql).toContain(
      'conversation.active_generation = event.session_generation',
    );
    expect(discovery?.sql).toContain("event.event_type = 'welcome'");
    expect(discovery?.sql).toContain('event.recipient_device_id = $3');
    expect(discovery?.sql).toContain('event.expires_at > $4::timestamptz');
    expect(discovery?.values).toEqual([
      'org_default',
      'acc_bob',
      'bob-device',
      expect.any(String),
      'acc_aaron',
      25,
    ]);
  });

  it('lists PostgreSQL unclaimed KeyPackage references for the exact device', async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    const pool: PostgresPoolLike = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.includes('SELECT 1 FROM accounts AS account')) {
          return result([{ available: 1 }]);
        }
        if (sql.includes('SELECT 1 FROM e2ee_devices')) {
          return result([{ available: 1 }]);
        }
        if (
          sql.includes('FROM mls_key_packages') &&
          sql.includes('claimed_at IS NULL')
        ) {
          return result([
            {
              key_package_reference: 'a'.repeat(64),
              expires_at: new Date('2026-08-10T00:00:00.000Z'),
            },
            {
              key_package_reference: 'b'.repeat(64),
              expires_at: new Date('2026-08-10T00:00:00.000Z'),
            },
          ]);
        }
        return result();
      }),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    await expect(
      repository.listMlsKeyPackageInventory({
        organizationId: 'org_default',
        accountId: 'acc_bob',
        deviceId: 'bob-device',
      }),
    ).resolves.toEqual([
      {
        reference: 'a'.repeat(64),
        expiresAt: '2026-08-10T00:00:00.000Z',
      },
      {
        reference: 'b'.repeat(64),
        expiresAt: '2026-08-10T00:00:00.000Z',
      },
    ]);
    const inventory = statements.find((statement) =>
      statement.sql.includes('FROM mls_key_packages'),
    );
    expect(inventory?.sql).toContain('device_id = $3');
    expect(inventory?.sql).toContain('expires_at > $4::timestamptz');
    expect(inventory?.sql).not.toContain('key_package,');
    expect(inventory?.values).toEqual([
      'org_default',
      'acc_bob',
      'bob-device',
      expect.any(String),
    ]);
  });

  it('retires an unclaimed PostgreSQL KeyPackage under a device row lock', async () => {
    const statements: string[] = [];
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.trim());
        if (sql.includes('SELECT 1 FROM accounts AS account')) {
          return result([{ available: 1 }]);
        }
        if (sql.includes('SELECT 1 FROM e2ee_devices')) {
          return result([{ available: 1 }]);
        }
        if (sql.includes('SELECT claimed_at FROM mls_key_packages')) {
          return result([{ claimed_at: null }]);
        }
        return result();
      }),
      release: vi.fn(),
    };
    const pool: PostgresPoolLike = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    await expect(
      repository.retireMlsKeyPackage({
        organizationId: 'org_default',
        accountId: 'acc_bob',
        deviceId: 'bob-device',
        reference: 'a'.repeat(64),
      }),
    ).resolves.toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes('DELETE FROM mls_key_packages'),
      ),
    ).toBe(true);
    expect(statements).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('binds an initial PostgreSQL MLS Commit and Welcome to one KeyPackage claim', async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    const groupId = Buffer.from('group').toString('base64');
    const payload = Buffer.from('commit').toString('base64');
    const welcomePayload = Buffer.from('welcome').toString('base64');
    const keyPackageReference = 'a'.repeat(64);
    let conversationCreated = false;
    let reservedEventId: string | null = null;
    let storedCommitPayload = '';
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.includes('SELECT account.id FROM accounts')) {
          return result([{ id: 'acc_alice' }, { id: 'acc_bob' }]);
        }
        if (sql.includes('SELECT 1 FROM e2ee_devices')) {
          return result([{ available: 1 }]);
        }
        if (sql.includes('SELECT * FROM mls_transport_events')) {
          if (sql.includes("event_type = 'commit'")) {
            return result([
              {
                sequence: 1,
                id: 'commit-1',
                conversation_id: 'b'.repeat(64),
                session_generation: 1,
                sender_account_id: 'acc_alice',
                sender_device_id: 'alice-device',
                recipient_account_id: null,
                recipient_device_id: null,
                event_type: 'commit',
                epoch: 1,
                group_id: groupId,
                payload: storedCommitPayload,
                key_package_reference: null,
                created_at: new Date('2026-08-01T00:00:00.000Z'),
                expires_at: new Date('2026-10-30T00:00:00.000Z'),
              },
            ]);
          }
          return result();
        }
        if (sql.includes('INSERT INTO mls_resource_rate_buckets')) {
          return result([{ request_count: 1 }]);
        }
        if (sql.includes('AS organization_count')) {
          return result([
            {
              organization_count: 0,
              organization_bytes: 0,
              conversation_count: 0,
              conversation_bytes: 0,
            },
          ]);
        }
        if (sql.includes('SELECT * FROM mls_conversations')) {
          return conversationCreated
            ? result([
                {
                  conversation_id: 'b'.repeat(64),
                  participant_a_account_id: 'acc_alice',
                  participant_b_account_id: 'acc_bob',
                  group_id: groupId,
                  current_epoch: 1,
                  active_generation: 1,
                  retention_floor_sequence: 0,
                  created_at: new Date('2026-08-01T00:00:00.000Z'),
                  updated_at: new Date('2026-08-01T00:00:00.000Z'),
                },
              ])
            : result();
        }
        if (sql.includes('INSERT INTO mls_conversations')) {
          conversationCreated = true;
          return result();
        }
        if (sql.includes('SELECT * FROM mls_key_packages')) {
          return result([
            {
              key_package_reference: keyPackageReference,
              account_id: 'acc_bob',
              device_id: 'bob-device',
              ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
              key_package: Buffer.from('key-package').toString('base64'),
              created_at: new Date('2026-08-01T00:00:00.000Z'),
              claimed_at: new Date('2026-08-01T00:00:01.000Z'),
              claimed_by_account_id: 'acc_alice',
              claimed_by_device_id: 'alice-device',
              welcome_event_id: reservedEventId,
              expires_at: new Date('2099-08-02T00:00:00.000Z'),
            },
          ]);
        }
        if (sql.includes('UPDATE mls_key_packages')) {
          reservedEventId = values[2] as string;
          return result();
        }
        if (sql.includes('INSERT INTO mls_transport_events')) {
          const storedPayload = values[11] as string;
          const eventType = values[8] as 'commit' | 'welcome';
          if (eventType === 'commit') storedCommitPayload = storedPayload;
          return result([
            {
              sequence: eventType === 'commit' ? 1 : 2,
              id: values[0] as string,
              conversation_id: 'b'.repeat(64),
              session_generation: 1,
              sender_account_id: 'acc_alice',
              sender_device_id: 'alice-device',
              recipient_account_id:
                eventType === 'welcome' ? 'acc_bob' : null,
              recipient_device_id:
                eventType === 'welcome' ? 'bob-device' : null,
              event_type: eventType,
              epoch: 1,
              group_id: groupId,
              payload: storedPayload,
              key_package_reference:
                eventType === 'welcome' ? keyPackageReference : null,
              created_at: new Date('2026-08-01T00:00:00.000Z'),
              expires_at: new Date('2026-10-30T00:00:00.000Z'),
            },
          ]);
        }
        return result();
      }),
      release: vi.fn(),
    };
    const pool: PostgresPoolLike = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    await expect(
      repository.appendMlsTransportEvent({
        organizationId: 'org_default',
        senderAccountId: 'acc_alice',
        peerAccountId: 'acc_bob',
        senderDeviceId: 'alice-device',
        eventId: 'commit-1',
        eventType: 'commit',
        epoch: 1,
        groupId,
        payload,
        recipientDeviceId: 'bob-device',
        keyPackageReference,
      }),
    ).resolves.toMatchObject({
      eventId: 'commit-1',
      eventType: 'commit',
      epoch: 1,
      groupId,
      sessionGeneration: 1,
    });
    const inserted = statements.find((statement) =>
      statement.sql.includes('INSERT INTO mls_transport_events'),
    );
    const storedPayload = inserted?.values[11] as string;
    expect(parseMlsMemberAddCommitEnvelope(storedPayload)).toEqual({
      commit: payload,
      recipientAccountId: 'acc_bob',
      recipientDeviceId: 'bob-device',
      keyPackageReference,
      resetFromGroupId: null,
    });
    await expect(
      repository.appendMlsTransportEvent({
        organizationId: 'org_default',
        senderAccountId: 'acc_alice',
        peerAccountId: 'acc_bob',
        senderDeviceId: 'alice-device',
        eventId: 'welcome-1',
        eventType: 'welcome',
        epoch: 1,
        groupId,
        payload: welcomePayload,
        recipientDeviceId: 'bob-device',
        keyPackageReference,
      }),
    ).resolves.toMatchObject({
      eventId: 'welcome-1',
      eventType: 'welcome',
      payload: welcomePayload,
      recipientDeviceId: 'bob-device',
      keyPackageReference,
    });
    expect(reservedEventId).toBe('welcome-1');
    expect(
      statements.some((statement) =>
        statement.sql.includes('INSERT INTO mls_group_sessions'),
      ),
    ).toBe(true);
    expect(inserted?.values).toEqual(
      expect.arrayContaining(['commit-1', 'acc_alice', groupId, storedPayload]),
    );
    expect(
      statements.some(
        (statement) =>
          statement.sql.includes('UPDATE mls_key_packages') &&
          statement.values.includes(keyPackageReference),
      ),
    ).toBe(true);
    expect(statements.map((statement) => statement.sql).join('\n')).not.toMatch(
      /plaintext|private_key/i,
    );
  });

  it('atomically retires the active PostgreSQL MLS group during reset', async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    const previousGroupId = Buffer.from('previous-group').toString('base64');
    const nextGroupId = Buffer.from('next-group').toString('base64');
    const payload = Buffer.from('reset-commit').toString('base64');
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.includes('SELECT account.id FROM accounts')) {
          return result([{ id: 'acc_alice' }, { id: 'acc_bob' }]);
        }
        if (sql.includes('SELECT 1 FROM e2ee_devices')) {
          return result([{ available: 1 }]);
        }
        if (sql.includes('SELECT * FROM mls_transport_events')) {
          return result();
        }
        if (sql.includes('INSERT INTO mls_resource_rate_buckets')) {
          return result([{ request_count: 1 }]);
        }
        if (sql.includes('AS organization_count')) {
          return result([
            {
              organization_count: 3,
              organization_bytes: 512,
              conversation_count: 3,
              conversation_bytes: 512,
            },
          ]);
        }
        if (sql.includes('SELECT * FROM mls_conversations')) {
          return result([
            {
              conversation_id: 'b'.repeat(64),
              participant_a_account_id: 'acc_alice',
              participant_b_account_id: 'acc_bob',
              group_id: previousGroupId,
              current_epoch: 5,
              active_generation: 1,
              retention_floor_sequence: 0,
            },
          ]);
        }
        if (sql.includes('SELECT 1 FROM mls_group_sessions')) {
          return result();
        }
        if (
          sql.includes('UPDATE mls_group_sessions') &&
          sql.includes("status = 'retired'")
        ) {
          return result([
            {
              organization_id: 'org_default',
              conversation_id: 'b'.repeat(64),
              generation: 1,
              group_id: previousGroupId,
              current_epoch: 5,
              status: 'retired',
              created_at: new Date('2026-08-01T00:00:00.000Z'),
              retired_at: new Date('2026-08-02T00:00:00.000Z'),
              reset_by_account_id: null,
              reset_by_device_id: null,
              reset_event_id: null,
            },
          ]);
        }
        if (sql.includes('INSERT INTO mls_transport_events')) {
          return result([
            {
              sequence: 4,
              id: 'reset-commit-1',
              conversation_id: 'b'.repeat(64),
              session_generation: 2,
              sender_account_id: 'acc_alice',
              sender_device_id: 'alice-device',
              recipient_account_id: null,
              recipient_device_id: null,
              event_type: 'commit',
              epoch: 1,
              group_id: nextGroupId,
              payload,
              key_package_reference: null,
              created_at: new Date('2026-08-02T00:00:00.000Z'),
              expires_at: new Date('2026-10-31T00:00:00.000Z'),
            },
          ]);
        }
        return result();
      }),
      release: vi.fn(),
    };
    const pool: PostgresPoolLike = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    await expect(
      repository.appendMlsTransportEvent({
        organizationId: 'org_default',
        senderAccountId: 'acc_alice',
        peerAccountId: 'acc_bob',
        senderDeviceId: 'alice-device',
        eventId: 'reset-commit-1',
        eventType: 'commit',
        epoch: 1,
        groupId: nextGroupId,
        resetFromGroupId: previousGroupId,
        payload,
      }),
    ).resolves.toMatchObject({
      eventId: 'reset-commit-1',
      groupId: nextGroupId,
      epoch: 1,
      sessionGeneration: 2,
    });
    expect(
      statements.find((statement) =>
        statement.sql.includes('SELECT * FROM mls_conversations'),
      )?.sql,
    ).toContain('FOR UPDATE');
    expect(
      statements.find((statement) =>
        statement.sql.includes('INSERT INTO mls_group_sessions') &&
        statement.sql.includes('reset_event_id'),
      )?.values,
    ).toEqual(
      expect.arrayContaining([
        2,
        nextGroupId,
        'acc_alice',
        'alice-device',
        'reset-commit-1',
      ]),
    );
    expect(statements.at(-1)?.sql.trim()).toBe('COMMIT');
  });

  it('rolls back PostgreSQL MLS writes when the durable rate bucket is full', async () => {
    const statements: string[] = [];
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.trim());
        if (sql.includes('SELECT account.id FROM accounts')) {
          return result([{ id: 'acc_alice' }, { id: 'acc_bob' }]);
        }
        if (sql.includes('SELECT 1 FROM e2ee_devices')) {
          return result([{ available: 1 }]);
        }
        return result();
      }),
      release: vi.fn(),
    };
    const pool: PostgresPoolLike = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    await expect(
      repository.appendMlsTransportEvent({
        organizationId: 'org_default',
        senderAccountId: 'acc_alice',
        peerAccountId: 'acc_bob',
        senderDeviceId: 'alice-device',
        eventId: 'rate-limited-commit',
        eventType: 'commit',
        epoch: 1,
        groupId: Buffer.from('group').toString('base64'),
        payload: Buffer.from('commit').toString('base64'),
      }),
    ).rejects.toThrow(/rate limit/i);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(
      statements.some((sql) => sql.includes('INSERT INTO mls_transport_events')),
    ).toBe(false);
  });

  it('advances retention floors before bounded PostgreSQL MLS cleanup', async () => {
    const statements: string[] = [];
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('pg_try_advisory_xact_lock')) {
          return result([{ locked: true }]);
        }
        if (sql.includes('SELECT sequence, organization_id, conversation_id')) {
          return result([
            {
              sequence: 40,
              organization_id: 'org_default',
              conversation_id: 'a'.repeat(64),
            },
            {
              sequence: 41,
              organization_id: 'org_default',
              conversation_id: 'a'.repeat(64),
            },
          ]);
        }
        if (sql.includes('DELETE FROM mls_transport_events')) {
          return result([{ sequence: 40 }, { sequence: 41 }]);
        }
        if (sql.includes('DELETE FROM mls_group_sessions')) {
          return result([{ generation: 1 }]);
        }
        if (sql.includes('DELETE FROM mls_key_packages')) {
          return result([{ key_package_reference: 'b'.repeat(64) }]);
        }
        if (sql.includes('DELETE FROM mls_resource_rate_buckets')) {
          return result([{ ctid: '(0,1)' }]);
        }
        return result();
      }),
      release: vi.fn(),
    };
    const pool: PostgresPoolLike = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    await expect(
      repository.cleanupExpiredMlsResources({
        before: '2026-08-02T00:00:00.000Z',
        limit: 50,
      }),
    ).resolves.toEqual({
      eventsDeleted: 2,
      keyPackagesDeleted: 1,
      groupSessionsDeleted: 1,
      rateBucketsDeleted: 1,
      conversationsAdvanced: 1,
    });
    expect(
      statements.find((sql) => sql.includes('UPDATE mls_conversations')),
    ).toContain('retention_floor_sequence = GREATEST');
    expect(statements.at(-1)?.trim()).toBe('COMMIT');
  });

  it('normalizes mainland phone numbers without importing the SQLite repository', () => {
    expect(normalizePostgresEnterprisePhone('138 0013 8000')).toBe(
      '+8613800138000',
    );
    expect(normalizePostgresEnterprisePhone('+86 13800138000')).toBe(
      '+8613800138000',
    );
    expect(() => normalizePostgresEnterprisePhone('10086')).toThrow(
      'phone is invalid',
    );
  });

  it('stores only a SHA-256 session token digest in PostgreSQL', async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const pool: PostgresPoolLike = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        return result([], 1);
      }),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    const session = await repository.createAuthSession('acc_admin');

    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('INSERT INTO auth_sessions');
    expect(queries[0]!.values[0]).toBe(
      createHash('sha256').update(session.token).digest('hex'),
    );
    expect(queries[0]!.values).not.toContain(session.token);
  });

  it('shares login throttling without persisting the account identifier', async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const pool: PostgresPoolLike = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        return result([{ retry_after_seconds: 900 }]);
      }),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    expect(await repository.recordLoginFailure('Admin@Example.COM')).toBe(900);

    expect(queries[0]!.sql).toContain('INSERT INTO auth_login_limits');
    expect(queries[0]!.values[0]).toBe(
      createHash('sha256').update('admin@example.com').digest('hex'),
    );
    expect(queries[0]!.values).not.toContain('Admin@Example.COM');
  });

  it('claims only expired unbound S3 objects outside legal hold', async () => {
    const queries: string[] = [];
    const pool: PostgresPoolLike = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return result([
          {
            id: 'att-unbound',
            organization_id: 'org_default',
            storage_key: 'attachments/v1/ab/opaque.bin',
            ciphertext_bytes: 64,
          },
        ]);
      }),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    await expect(
      repository.claimExpiredUnboundAttachments({
        before: '2026-08-01T00:00:00.000Z',
      }),
    ).resolves.toEqual([
      {
        id: 'att-unbound',
        organizationId: 'org_default',
        key: 'attachments/v1/ab/opaque.bin',
        ciphertextBytes: 64,
      },
    ]);
    expect(queries[0]).toContain('object.legal_hold = FALSE');
    expect(queries[0]).toContain(
      'NOT EXISTS (\n             SELECT 1 FROM direct_message_attachment_objects',
    );
    expect(queries[0]).toContain("migration_state = 'orphan_cleaning'");
  });

  it('rolls back an account transaction when PostgreSQL rejects a write', async () => {
    const statements: string[] = [];
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT * FROM organizations')) {
          return result([
            {
              id: 'org_default',
              name: 'Otto',
              slug: 'otto-default',
              type: 'enterprise',
              status: 'active',
              park_id: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ]);
        }
        if (sql.includes('INSERT INTO accounts')) {
          throw new Error('duplicate account');
        }
        return result();
      }),
      release: vi.fn(),
    };
    const pool: PostgresPoolLike = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    await expect(
      repository.createAccount({
        username: 'admin',
        password: 'Secure-password-2026',
        name: 'Administrator',
        isAdmin: true,
      }),
    ).rejects.toThrow('duplicate account');

    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects inline E2EE attachment bodies after the shared S3 route is mounted', async () => {
    const pool: PostgresPoolLike = {
      connect: vi.fn(),
      query: vi.fn(),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });
    await expect(
      repository.sendE2eeDirectMessage({
        organizationId: 'org_default',
        senderAccountId: 'acc_sender',
        recipientAccountId: 'acc_recipient',
        messageId: 'msg_1',
        senderDeviceId: 'device_1',
        protocolVersion: 1,
        contentType: 'message',
        ciphertext: Buffer.alloc(32).toString('base64'),
        nonce: Buffer.alloc(12).toString('base64'),
        signature: Buffer.alloc(64).toString('base64'),
        envelopes: [],
        attachments: [
          {
            id: 'attachment_1',
            ciphertext: Buffer.alloc(32).toString('base64'),
            nonce: Buffer.alloc(12).toString('base64'),
          },
        ],
      }),
    ).rejects.toThrow('must be uploaded before sending the message');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
