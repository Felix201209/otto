/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import {
  prepareEnterprisePostgres,
  safePostgresErrorMessage,
} from './postgresDatabaseCli.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryResult,
} from './postgresDatabaseLifecycle.js';

class PreparedPool implements PostgresPoolLike, PostgresClientLike {
  private schemaVersion = 0;
  ended = 0;

  async connect(): Promise<PostgresClientLike> {
    return this;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.includes('SELECT version, name, checksum')) return { rows: [] };
    if (sql.includes('INSERT INTO otto_schema_migrations')) {
      this.schemaVersion = Number(values[0]);
      return { rows: [] };
    }
    if (sql.includes("current_setting('server_version_num')")) {
      return {
        rows: [
          {
            server_version_num: 170002,
            in_recovery: false,
            schema_version: this.schemaVersion,
          } as Row,
        ],
      };
    }
    return { rows: [] };
  }

  release(): void {}

  async end(): Promise<void> {
    this.ended += 1;
  }
}

describe('enterprise PostgreSQL preparation CLI', () => {
  it('prepares the migration control plane and only logs a redacted target', async () => {
    const pool = new PreparedPool();
    const log = vi.fn();

    await expect(
      prepareEnterprisePostgres({
        environment: {
          OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
          OTTO_POSTGRES_URL:
            'postgresql://otto:super-secret@db.internal:5432/otto',
        },
        poolFactory: () => pool,
        log,
      }),
    ).resolves.toMatchObject({
      ready: true,
      backend: 'postgresql',
      schemaVersion: 3,
    });

    expect(pool.ended).toBe(1);
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain('db.internal:5432/otto');
    expect(output).not.toContain('super-secret');
    expect(output).not.toContain('otto@');
  });

  it('refuses to run against the local SQLite topology', async () => {
    await expect(
      prepareEnterprisePostgres({
        environment: {},
        poolFactory: () => {
          throw new Error('pool must not be created');
        },
      }),
    ).rejects.toThrow(/requires.*postgresql/i);
  });

  it('redacts credentials from driver errors', () => {
    const connectionString =
      'postgresql://otto:super-secret@db.internal:5432/otto';
    const message = safePostgresErrorMessage(
      new Error(`connection failed for ${connectionString}: super-secret`),
      connectionString,
    );

    expect(message).not.toContain('super-secret');
    expect(message).not.toContain('otto@');
    expect(message).toContain('[REDACTED]');
  });
});
