/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

const DEFAULT_MIGRATION_LOCK_KEY = 0x4f54544f;

export interface PostgresQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  rows: Row[];
  rowCount?: number | null;
}

export interface PostgresClientLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
  release(): void;
}

export interface PostgresPoolLike {
  connect(): Promise<PostgresClientLike>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
  end(): Promise<void>;
}

export interface PostgresMigration {
  version: number;
  name: string;
  sql: string;
}

export interface PostgresDatabaseReadiness {
  ready: true;
  backend: 'postgresql';
  schemaVersion: number;
  serverVersion: number;
  writable: true;
}

interface AppliedMigrationRow extends Record<string, unknown> {
  version: number;
  name: string;
  checksum: string;
}

interface ReadinessRow extends Record<string, unknown> {
  server_version_num: number | string;
  in_recovery: boolean;
  schema_version: number | string;
}

const CREATE_MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS otto_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

const READINESS_SQL = `
SELECT
  current_setting('server_version_num')::integer AS server_version_num,
  pg_is_in_recovery() AS in_recovery,
  COALESCE((SELECT MAX(version) FROM otto_schema_migrations), 0)::integer
    AS schema_version`;

function migrationChecksum(sql: string): string {
  const canonicalSql = sql.replace(/\r\n?/g, '\n').trim();
  return createHash('sha256').update(canonicalSql).digest('hex');
}

function validateMigrationManifest(
  migrations: readonly PostgresMigration[],
): void {
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `PostgreSQL migration versions must be contiguous from 1; expected ${expectedVersion}, received ${migration.version}`,
      );
    }
    if (!migration.name.trim() || !migration.sql.trim()) {
      throw new Error(
        `PostgreSQL migration ${migration.version} is incomplete`,
      );
    }
  }
}

export function createPostgresDatabaseLifecycle(options: {
  pool: PostgresPoolLike;
  migrations: readonly PostgresMigration[];
  migrationLockKey?: number;
}) {
  validateMigrationManifest(options.migrations);
  const expectedVersion = options.migrations.length;
  const migrationLockKey =
    options.migrationLockKey ?? DEFAULT_MIGRATION_LOCK_KEY;
  let initialization: Promise<PostgresDatabaseReadiness> | null = null;
  let closed = false;

  async function getReadiness(): Promise<PostgresDatabaseReadiness> {
    const result = await options.pool.query<ReadinessRow>(READINESS_SQL);
    const row = result.rows[0];
    if (!row) throw new Error('PostgreSQL readiness probe returned no rows');
    if (row.in_recovery) {
      throw new Error(
        'PostgreSQL connection points to a read-only standby; Otto Server requires the writable primary',
      );
    }
    const schemaVersion = Number(row.schema_version);
    if (schemaVersion !== expectedVersion) {
      throw new Error(
        `PostgreSQL schema version ${schemaVersion} does not match current version ${expectedVersion}`,
      );
    }
    const serverVersion = Number(row.server_version_num);
    if (!Number.isSafeInteger(serverVersion) || serverVersion <= 0) {
      throw new Error('PostgreSQL server version is unavailable');
    }
    return {
      ready: true,
      backend: 'postgresql',
      schemaVersion,
      serverVersion,
      writable: true,
    };
  }

  async function initializeOnce(): Promise<PostgresDatabaseReadiness> {
    if (closed) throw new Error('PostgreSQL database lifecycle is closed');
    const client = await options.pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        migrationLockKey,
      ]);
      await client.query(CREATE_MIGRATION_TABLE_SQL);
      const appliedResult = await client.query<AppliedMigrationRow>(
        'SELECT version, name, checksum FROM otto_schema_migrations ORDER BY version',
      );
      const applied = new Map(
        appliedResult.rows.map((migration) => [migration.version, migration]),
      );
      const newestAppliedVersion = Math.max(0, ...applied.keys());
      if (newestAppliedVersion > expectedVersion) {
        throw new Error(
          `PostgreSQL schema version ${newestAppliedVersion} is newer than current version ${expectedVersion}; refusing downgrade`,
        );
      }

      for (const migration of options.migrations) {
        const existing = applied.get(migration.version);
        if (existing) {
          const checksum = migrationChecksum(migration.sql);
          if (
            existing.name !== migration.name ||
            existing.checksum !== checksum
          ) {
            throw new Error(
              `PostgreSQL migration ${migration.version} checksum or name differs from the applied migration`,
            );
          }
          continue;
        }
        if (migration.version < newestAppliedVersion) {
          throw new Error(
            `PostgreSQL migration history is incomplete at version ${migration.version}`,
          );
        }
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO otto_schema_migrations (version, name, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migrationChecksum(migration.sql)],
        );
      }
      await client.query('COMMIT');
      inTransaction = false;
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the migration error that made the connection unusable.
        }
      }
      throw error;
    } finally {
      client.release();
    }
    return getReadiness();
  }

  function initialize(): Promise<PostgresDatabaseReadiness> {
    initialization ??= initializeOnce().catch((error: unknown) => {
      initialization = null;
      throw error;
    });
    return initialization;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await options.pool.end();
  }

  return { initialize, getReadiness, close };
}
