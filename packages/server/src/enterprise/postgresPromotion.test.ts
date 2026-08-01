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

function dryRunPool(input: { targetAccounts?: number } = {}) {
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
        if (tableName !== 'organizations') return result();
        return result([
          {
            table_name: 'organizations',
            column_names: [
              'id',
              'name',
              'slug',
              'park_id',
              'status',
              'created_at',
              'updated_at',
            ],
            source_row_count: 1,
            copied_row_count: 1,
            state: 'verified',
          },
        ]);
      }
      if (sql.includes('FROM otto_sqlite_import_rows')) {
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
});
