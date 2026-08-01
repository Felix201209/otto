/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

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
    withAttachments?: boolean;
    preparedAttachments?: boolean;
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
            non_default_organizations: 0,
          },
        ]);
      }
      if (sql.includes('FROM otto_sqlite_import_tables')) {
        const tableName = String(values[1]);
        if (
          tableName !== 'organizations' &&
          !(input.withAttachments &&
            ['direct_messages', 'direct_message_attachments'].includes(
              tableName,
            ))
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
                'status',
                'created_at',
                'updated_at',
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
        return result([
          {
            row_data: [
              'org_default',
              'Otto',
              'otto-default',
              null,
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
      if (sql.includes('INSERT INTO otto_sqlite_import_promotions')) {
        return result([
          {
            run_id: 'import_1',
            promoted_counts: {
              organizations: 1,
              direct_messages: input.withAttachments ? 1 : 0,
              direct_message_attachments: input.withAttachments ? 1 : 0,
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
});
