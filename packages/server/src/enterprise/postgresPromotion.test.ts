/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  parsePostgresEnterprisePromotionArguments,
} from './postgresPromotionCli.js';
import { promoteVerifiedSqliteImport } from './postgresPromotion.js';
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

function dryRunPool(
  input: {
    targetAccounts?: number;
    targetMlsEvents?: number;
    withAttachments?: boolean;
    preparedAttachments?: boolean;
    withInvites?: boolean;
    withMls?: boolean;
    legacyMlsSchema?: boolean;
    invalidMlsEventType?: boolean;
  } = {},
) {
  const statements: string[] = [];
  const client: PostgresClientLike = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      statements.push(sql);
      if (sql.includes('FROM otto_sqlite_import_promotions')) return result();
      if (sql.includes('FROM otto_sqlite_import_runs')) {
        return result([{ id: 'import_1', state: 'verified' }]);
      }
      if (sql.includes('AS non_default_organizations')) {
        return result([
          {
            accounts: input.targetAccounts ?? 0,
            messages: 0,
            mls_key_packages: 0,
            mls_conversations: 0,
            mls_group_sessions: 0,
            mls_transport_events: input.targetMlsEvents ?? 0,
            account_sync_snapshots: 0,
            business_records: 0,
            non_default_organizations: 0,
          },
        ]);
      }
      if (sql.includes('FROM otto_sqlite_import_tables')) {
        const tableName = String(values[1]);
        if (
          tableName !== 'organizations' &&
          !(input.withInvites && tableName === 'organization_invites') &&
          !(input.withAttachments &&
            ['direct_messages', 'direct_message_attachments'].includes(
              tableName,
            )) &&
          !(input.withMls &&
            [
              'mls_key_packages',
              'mls_conversations',
              'mls_group_sessions',
              'mls_transport_events',
              'mls_resource_rate_buckets',
            ].includes(tableName) &&
            !(input.legacyMlsSchema && tableName === 'mls_group_sessions'))
        ) {
          return result();
        }
        const columns =
          tableName === 'organizations'
            ? [
                'id',
                'name',
                'slug',
                'park_id',
                'invite_secret',
                'status',
                'created_at',
                'updated_at',
              ]
            : tableName === 'organization_invites'
              ? [
                  'id',
                  'organization_id',
                  'nonce',
                  'issued_at_ms',
                  'expires_at_ms',
                  'revoked_at_ms',
                  'created_by_account_id',
                  'default_department',
                  'department_id',
                  'position_id',
                  'position_title',
                  'default_role',
                  'max_uses',
                  'used_count',
                ]
            : tableName === 'direct_messages'
              ? [
                  'id',
                  'organization_id',
                  'sender_account_id',
                  'recipient_account_id',
                  'content_type',
                  'e2ee_protocol_version',
                  'e2ee_sender_device_id',
                  'e2ee_ciphertext',
                  'e2ee_nonce',
                  'e2ee_signature',
                  'e2ee_envelopes_json',
                  'in_reply_to_message_id',
                  'created_at',
                  'read_at',
                ]
            : tableName === 'mls_key_packages'
              ? [
                  'organization_id',
                  'key_package_reference',
                  'account_id',
                  'device_id',
                  'ciphersuite',
                  'key_package',
                  'created_at',
                  'claimed_at',
                  'claimed_by_account_id',
                  'claimed_by_device_id',
                  'welcome_event_id',
                  'expires_at',
                ]
            : tableName === 'mls_conversations'
              ? [
                  'organization_id',
                  'conversation_id',
                  'participant_a_account_id',
                  'participant_b_account_id',
                  'group_id',
                  'current_epoch',
                  'created_at',
                  'updated_at',
                  'retention_floor_sequence',
                  ...(input.legacyMlsSchema ? [] : ['active_generation']),
                ]
            : tableName === 'mls_group_sessions'
              ? [
                  'organization_id',
                  'conversation_id',
                  'generation',
                  'group_id',
                  'current_epoch',
                  'status',
                  'created_at',
                  'retired_at',
                  'reset_by_account_id',
                  'reset_by_device_id',
                  'reset_event_id',
                ]
            : tableName === 'mls_transport_events'
              ? [
                  'sequence',
                  'id',
                  'organization_id',
                  'conversation_id',
                  ...(input.legacyMlsSchema ? [] : ['session_generation']),
                  'sender_account_id',
                  'sender_device_id',
                  'recipient_account_id',
                  'recipient_device_id',
                  'event_type',
                  'epoch',
                  'group_id',
                  'payload',
                  'key_package_reference',
                  'created_at',
                  'expires_at',
                ]
            : tableName === 'mls_resource_rate_buckets'
              ? [
                  'organization_id',
                  'account_id',
                  'device_id',
                  'action',
                  'bucket_started_at_ms',
                  'request_count',
                ]
              : [
                  'id',
                  'message_id',
                  'organization_id',
                  'ordinal',
                  'byte_size',
                  'storage_backend',
                  'storage_key',
                  'e2ee_nonce',
                  'created_at',
                ];
        return result([
          {
            table_name: tableName,
            column_names: columns,
            source_row_count: 1,
            copied_row_count: 1,
            state: 'verified',
          },
        ]);
      }
      if (sql.includes('FROM otto_sqlite_import_rows')) {
        const tableName = String(values[1]);
        if (tableName === 'direct_messages') {
          return result([
            {
              row_data: [
                'msg-1',
                'org_default',
                'sender-1',
                'recipient-1',
                'message',
                1,
                'device-1',
                Buffer.alloc(32, 1).toString('base64'),
                Buffer.alloc(12, 2).toString('base64'),
                Buffer.alloc(64, 3).toString('base64'),
                '[]',
                null,
                '2026-08-01 00:00:00',
                null,
              ],
            },
          ]);
        }
        if (tableName === 'direct_message_attachments') {
          return result([
            {
              row_data: [
                'att-1',
                'msg-1',
                'org_default',
                0,
                32,
                'encrypted-filesystem',
                'ab/cd/source.otto-object',
                Buffer.alloc(12, 4).toString('base64'),
                '2026-08-01 00:00:00',
              ],
            },
          ]);
        }
        if (tableName === 'mls_key_packages') {
          return result([{
            row_data: [
              'org_default',
              'a'.repeat(64),
              'account-b',
              'device-b',
              'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
              Buffer.alloc(64, 5).toString('base64'),
              '2026-08-01 00:00:00',
              '2026-08-01 00:01:00',
              'account-a',
              'device-a',
              'mls-event-welcome-1',
              '2026-08-02 00:01:00',
            ],
          }]);
        }
        if (tableName === 'mls_conversations') {
          return result([{
            row_data: [
              'org_default',
              'b'.repeat(64),
              'account-a',
              'account-b',
              Buffer.alloc(32, 6).toString('base64'),
              1,
              '2026-08-01 00:02:00',
              '2026-08-01 00:03:00',
              17,
              ...(input.legacyMlsSchema ? [] : [1]),
            ],
          }]);
        }
        if (tableName === 'mls_group_sessions') {
          return result([{
            row_data: [
              'org_default',
              'b'.repeat(64),
              ...(input.legacyMlsSchema ? [] : [1]),
              Buffer.alloc(32, 6).toString('base64'),
              1,
              'active',
              '2026-08-01 00:02:00',
              null,
              null,
              null,
              null,
            ],
          }]);
        }
        if (tableName === 'mls_transport_events') {
          return result([{
            row_data: [
              41,
              'mls-event-welcome-1',
              'org_default',
              'b'.repeat(64),
              ...(input.legacyMlsSchema ? [] : [1]),
              'account-a',
              'device-a',
              'account-b',
              'device-b',
              input.invalidMlsEventType ? 'plaintext' : 'welcome',
              1,
              Buffer.alloc(32, 6).toString('base64'),
              Buffer.alloc(96, 7).toString('base64'),
              'a'.repeat(64),
              '2026-08-01 00:04:00',
              '2026-11-01 00:04:00',
            ],
          }]);
        }
        if (tableName === 'mls_resource_rate_buckets') {
          return result([{
            row_data: [
              'org_default',
              'account-a',
              'device-a',
              'transport_event_append',
              Date.parse('2026-08-01T00:04:00.000Z'),
              7,
            ],
          }]);
        }
        if (tableName === 'organization_invites') {
          return result([{
            row_data: [
              'orginvite_1',
              'org_default',
              'legacy-nonce-1234567890',
              Date.parse('2026-08-01T00:00:00.000Z'),
              Date.parse('2026-08-08T00:00:00.000Z'),
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              3,
              1,
            ],
          }]);
        }
        return result([
          {
            row_data: [
              'org_default',
              'Otto',
              'otto-default',
              null,
              '1'.repeat(64),
              'active',
              '2026-08-01 00:00:00',
              '2026-08-01 00:00:00',
            ],
          },
        ]);
      }
      if (sql.includes('FROM otto_sqlite_import_attachment_objects')) {
        return result(
          input.withAttachments
            && input.preparedAttachments !== false
            ? [
                {
                  attachment_id: 'att-1',
                  message_id: 'msg-1',
                  organization_id: 'org_default',
                  sender_account_id: 'sender-1',
                  recipient_account_id: 'recipient-1',
                  ordinal: 0,
                  ciphertext_bytes: 48,
                  ciphertext_sha256: 'a'.repeat(64),
                  e2ee_nonce: Buffer.alloc(12, 4).toString('base64'),
                  source_backend: 'encrypted-filesystem',
                  source_storage_key: 'ab/cd/source.otto-object',
                  s3_storage_key:
                    'attachments/v1/ab/' + 'a'.repeat(32) + '.bin',
                  state: 'verified',
                  source_created_at: new Date(
                    '2026-08-01T00:00:00.000Z',
                  ),
                },
              ]
            : [],
        );
      }
      if (sql.includes('SELECT invite_secret FROM organizations')) {
        return result([{ invite_secret: '1'.repeat(64) }]);
      }
      if (sql.includes('INSERT INTO otto_sqlite_import_promotions')) {
        return result([
          {
            run_id: 'import_1',
            promoted_counts: {
              organizations: 1,
              direct_messages: input.withAttachments ? 1 : 0,
              direct_message_attachments: input.withAttachments ? 1 : 0,
              mls_key_packages: input.withMls ? 1 : 0,
              mls_conversations: input.withMls ? 1 : 0,
              mls_group_sessions:
                input.withMls && !input.legacyMlsSchema ? 1 : 0,
              mls_transport_events: input.withMls ? 1 : 0,
              mls_resource_rate_buckets: input.withMls ? 1 : 0,
            },
            promoted_at: new Date('2026-08-01T00:05:00.000Z'),
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
  return { pool, client, statements };
}

describe('verified SQLite PostgreSQL promotion', () => {
  it('parses a safe dry-run by default and requires a run id', () => {
    expect(parsePostgresEnterprisePromotionArguments(['--run', 'import_1'])).toEqual({
      runId: 'import_1',
      dryRun: true,
    });
    expect(
      parsePostgresEnterprisePromotionArguments([
        '--execute',
        '--run',
        'import_1',
      ]),
    ).toEqual({ runId: 'import_1', dryRun: false });
    expect(() => parsePostgresEnterprisePromotionArguments([])).toThrow(
      '--run is required',
    );
  });

  it('validates every promoted table and rolls back a rehearsal', async () => {
    const { pool, client, statements } = dryRunPool();
    const result = await promoteVerifiedSqliteImport({
      pool,
      runId: 'import_1',
      dryRun: true,
    });
    expect(result).toMatchObject({
      runId: 'import_1',
      state: 'planned',
      promotedAt: null,
      promotedCounts: { organizations: 1, accounts: 0, direct_messages: 0 },
    });
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.some((sql) => sql.includes('INSERT INTO organizations'))).toBe(
      false,
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('refuses to overwrite a PostgreSQL authority that already has accounts', async () => {
    const { pool, client, statements } = dryRunPool({ targetAccounts: 1 });
    await expect(
      promoteVerifiedSqliteImport({ pool, runId: 'import_1' }),
    ).rejects.toThrow('target is not empty');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('refuses to overwrite a PostgreSQL authority that already has MLS state', async () => {
    const { pool, client, statements } = dryRunPool({ targetMlsEvents: 1 });
    await expect(
      promoteVerifiedSqliteImport({ pool, runId: 'import_1' }),
    ).rejects.toThrow('target is not empty');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('atomically promotes MLS packages, epochs and exact transport cursors', async () => {
    const { pool, client, statements } = dryRunPool({ withMls: true });

    await expect(
      promoteVerifiedSqliteImport({
        pool,
        runId: 'import_1',
        dryRun: false,
      }),
    ).resolves.toMatchObject({
      state: 'promoted',
      promotedCounts: {
        mls_key_packages: 1,
        mls_conversations: 1,
        mls_group_sessions: 1,
        mls_transport_events: 1,
        mls_resource_rate_buckets: 1,
      },
    });

    const calls = vi.mocked(client.query).mock.calls;
    const packageInsert = calls.find(([sql]) =>
      sql.includes('INSERT INTO mls_key_packages'),
    );
    const conversationInsert = calls.find(([sql]) =>
      sql.includes('INSERT INTO mls_conversations'),
    );
    const eventInsert = calls.find(([sql]) =>
      sql.includes('INSERT INTO mls_transport_events'),
    );
    const groupSessionInsert = calls.find(([sql]) =>
      sql.includes('INSERT INTO mls_group_sessions'),
    );
    expect(packageInsert?.[1]).toMatchObject({
      1: 'a'.repeat(64),
      7: '2026-08-01T00:01:00.000Z',
      10: 'mls-event-welcome-1',
      11: '2026-08-02T00:01:00.000Z',
    });
    expect(conversationInsert?.[1]?.[5]).toBe(1);
    expect(conversationInsert?.[1]?.[8]).toBe(17);
    expect(conversationInsert?.[1]?.[9]).toBe(1);
    expect(groupSessionInsert?.[1]).toEqual(
      expect.arrayContaining([1, 'active']),
    );
    expect(eventInsert?.[0]).toContain('OVERRIDING SYSTEM VALUE');
    expect(eventInsert?.[1]?.[0]).toBe(41);
    expect(eventInsert?.[1]?.[4]).toBe(1);
    expect(eventInsert?.[1]?.[9]).toBe('welcome');
    expect(eventInsert?.[1]?.[15]).toBe('2026-11-01T00:04:00.000Z');
    expect(
      statements.some((sql) =>
        sql.includes("pg_get_serial_sequence('mls_transport_events', 'sequence')"),
      ),
    ).toBe(true);
    expect(
      statements.some((sql) =>
        sql.includes('INSERT INTO mls_resource_rate_buckets'),
      ),
    ).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('synthesizes generation one for verified legacy MLS imports', async () => {
    const { pool, client } = dryRunPool({
      withMls: true,
      legacyMlsSchema: true,
    });

    await expect(
      promoteVerifiedSqliteImport({
        pool,
        runId: 'import_1',
        dryRun: false,
      }),
    ).resolves.toMatchObject({
      state: 'promoted',
      promotedCounts: { mls_group_sessions: 0 },
    });

    const calls = vi.mocked(client.query).mock.calls;
    const synthesizedSession = calls.find(([sql]) =>
      sql.includes('INSERT INTO mls_group_sessions'),
    );
    const eventInsert = calls.find(([sql]) =>
      sql.includes('INSERT INTO mls_transport_events'),
    );
    expect(synthesizedSession?.[0]).toContain("1, $3, $4, 'active'");
    expect(synthesizedSession?.[1]).toEqual(expect.arrayContaining([1]));
    expect(eventInsert?.[1]?.[4]).toBe(1);
  });

  it('rolls back every MLS row when a staged event is invalid', async () => {
    const { pool, statements } = dryRunPool({
      withMls: true,
      invalidMlsEventType: true,
    });

    await expect(
      promoteVerifiedSqliteImport({
        pool,
        runId: 'import_1',
        dryRun: false,
      }),
    ).rejects.toThrow('MLS event type is invalid');

    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(
      statements.some((sql) =>
        sql.includes('INSERT INTO otto_sqlite_import_promotions'),
      ),
    ).toBe(false);
    expect(statements).not.toContain('COMMIT');
  });

  it('requires every staged attachment to have a verified S3 preparation', async () => {
    const { pool } = dryRunPool({ withAttachments: true });
    await expect(
      promoteVerifiedSqliteImport({
        pool,
        runId: 'import_1',
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      state: 'planned',
      promotedCounts: {
        direct_messages: 1,
        direct_message_attachments: 1,
      },
    });

    const missing = dryRunPool({
      withAttachments: true,
      preparedAttachments: false,
    });
    await expect(
      promoteVerifiedSqliteImport({
        pool: missing.pool,
        runId: 'import_1',
        dryRun: true,
      }),
    ).rejects.toThrow(/verified S3 preparation/i);
  });

  it('atomically promotes S3 metadata, both participant ACLs and the message reference', async () => {
    const { pool, statements } = dryRunPool({ withAttachments: true });

    await expect(
      promoteVerifiedSqliteImport({
        pool,
        runId: 'import_1',
        dryRun: false,
      }),
    ).resolves.toMatchObject({ state: 'promoted' });

    expect(
      statements.some((sql) => sql.includes('INSERT INTO attachment_objects')),
    ).toBe(true);
    expect(
      statements.filter((sql) =>
        sql.includes('INSERT INTO attachment_object_access'),
      ),
    ).toHaveLength(2);
    expect(
      statements.some((sql) =>
        sql.includes('INSERT INTO direct_message_attachment_objects'),
      ),
    ).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('preserves legacy invite validity while storing only a searchable hash', async () => {
    const { pool, client, statements } = dryRunPool({ withInvites: true });

    await expect(
      promoteVerifiedSqliteImport({
        pool,
        runId: 'import_1',
        dryRun: false,
      }),
    ).resolves.toMatchObject({ state: 'promoted' });

    const calls = vi.mocked(client.query).mock.calls;
    const inserted = calls.find(([sql]) =>
      sql.includes('INSERT INTO organization_invites'),
    );
    expect(inserted).toBeDefined();
    const values = inserted![1]!;
    const digest = createHmac('sha256', '1'.repeat(64))
      .update('org_default:legacy-nonce-1234567890')
      .digest();
    const alphabet =
      'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const rawCode = Array.from({ length: 12 }, (_, index) =>
      alphabet[digest[index]! % alphabet.length],
    ).join('');
    expect(values[3]).toBe(
      createHash('sha256').update(rawCode).digest('hex'),
    );
    expect(values).not.toContain(rawCode);
    expect(
      statements.some((sql) => sql.includes('invite_secret = COALESCE')),
    ).toBe(true);
  });
});
