/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createPostgresDatabaseLifecycle,
  type PostgresClientLike,
  type PostgresMigration,
  type PostgresPoolLike,
  type PostgresQueryResult,
} from './postgresDatabaseLifecycle.js';

class FakePostgres implements PostgresPoolLike, PostgresClientLike {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly applied = new Map<
    number,
    { version: number; name: string; checksum: string }
  >();
  inRecovery = false;
  released = 0;
  ended = 0;

  async connect(): Promise<PostgresClientLike> {
    return this;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.statements.push({ sql, values });
    if (sql.includes('SELECT version, name, checksum')) {
      return { rows: [...this.applied.values()] as Row[] };
    }
    if (sql.includes('INSERT INTO otto_schema_migrations')) {
      const [version, name, checksum] = values as [number, string, string];
      this.applied.set(version, { version, name, checksum });
      return { rows: [] };
    }
    if (sql.includes("current_setting('server_version_num')")) {
      const schemaVersion = Math.max(0, ...this.applied.keys());
      return {
        rows: [
          {
            server_version_num: 170002,
            in_recovery: this.inRecovery,
            schema_version: schemaVersion,
          } as Row,
        ],
      };
    }
    return { rows: [] };
  }

  release(): void {
    this.released += 1;
  }

  async end(): Promise<void> {
    this.ended += 1;
  }
}

const migrations: PostgresMigration[] = [
  { version: 1, name: 'foundation', sql: 'CREATE TABLE foundation (id text);' },
  { version: 2, name: 'accounts', sql: 'CREATE TABLE accounts (id text);' },
];

describe('PostgreSQL database lifecycle', () => {
  it('serializes and applies ordered migrations before reporting a writable primary', async () => {
    const pool = new FakePostgres();
    const lifecycle = createPostgresDatabaseLifecycle({ pool, migrations });

    await expect(lifecycle.initialize()).resolves.toEqual({
      ready: true,
      backend: 'postgresql',
      schemaVersion: 2,
      serverVersion: 170002,
      writable: true,
    });

    expect(pool.statements.map(({ sql }) => sql)).toEqual(
      expect.arrayContaining([
        'BEGIN',
        expect.stringContaining('pg_advisory_xact_lock'),
        migrations[0].sql,
        migrations[1].sql,
        'COMMIT',
      ]),
    );
    expect(pool.released).toBe(1);
    await lifecycle.close();
    expect(pool.ended).toBe(1);
  });

  it('refuses changed or future migrations and rolls back', async () => {
    const changed = new FakePostgres();
    changed.applied.set(1, {
      version: 1,
      name: 'foundation',
      checksum: createHash('sha256').update('different').digest('hex'),
    });
    const changedLifecycle = createPostgresDatabaseLifecycle({
      pool: changed,
      migrations,
    });
    await expect(changedLifecycle.initialize()).rejects.toThrow(
      /migration 1.*checksum/i,
    );
    expect(changed.statements.at(-1)?.sql).toBe('ROLLBACK');
    expect(changed.released).toBe(1);

    const future = new FakePostgres();
    future.applied.set(3, { version: 3, name: 'future', checksum: 'future' });
    await expect(
      createPostgresDatabaseLifecycle({
        pool: future,
        migrations,
      }).initialize(),
    ).rejects.toThrow(/schema version 3.*current version 2/i);
  });

  it('does not declare a read-only standby ready for a write-serving instance', async () => {
    const pool = new FakePostgres();
    pool.inRecovery = true;
    const lifecycle = createPostgresDatabaseLifecycle({ pool, migrations });

    await expect(lifecycle.initialize()).rejects.toThrow(/read-only standby/i);
  });
});
