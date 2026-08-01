/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryResult,
} from './postgresDatabaseLifecycle.js';
import {
  inspectSqliteImportSource,
  runSqliteToPostgresImport,
} from './sqlitePostgresImport.js';
import { Database } from './sqliteCompat.js';

const temporaryDirectories: string[] = [];

function createSource(): Database {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'otto-sqlite-postgres-import-'),
  );
  temporaryDirectories.push(directory);
  const database = new Database(path.join(directory, 'source.db'));
  database.exec(`
    PRAGMA user_version = 20;
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      quota INTEGER NOT NULL,
      logo BLOB
    );
    CREATE TABLE audit_logs (
      sequence INTEGER PRIMARY KEY,
      organization_id TEXT NOT NULL,
      action TEXT NOT NULL
    );
  `);
  database
    .prepare(
      'INSERT INTO organizations (id, display_name, quota, logo) VALUES (?, ?, ?, ?)',
    )
    .run('org_b', '乙企业', 20, Buffer.from([2, 3]));
  database
    .prepare(
      'INSERT INTO organizations (id, display_name, quota, logo) VALUES (?, ?, ?, ?)',
    )
    .run('org_a', '甲企业', 10, Buffer.from([0, 1]));
  database
    .prepare(
      'INSERT INTO audit_logs (sequence, organization_id, action) VALUES (?, ?, ?)',
    )
    .run(2, 'org_b', 'updated');
  database
    .prepare(
      'INSERT INTO audit_logs (sequence, organization_id, action) VALUES (?, ?, ?)',
    )
    .run(1, 'org_a', 'created');
  return database;
}

class ImportTarget implements PostgresPoolLike, PostgresClientLike {
  readonly rows = new Map<
    string,
    Array<{ row_index: number; row_sha256: string }>
  >();
  readonly statements: string[] = [];
  released = 0;
  ended = 0;
  runState = '';
  runId: string | null = null;
  sourceSchemaVersion = 0;
  targetSchemaVersion = 0;
  tamperTargetHash = false;
  insertAttempts = 0;
  failOnInsertAttempt: number | null = null;

  async connect(): Promise<PostgresClientLike> {
    return this;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.statements.push(sql);
    if (sql.includes('pg_try_advisory_lock')) {
      return { rows: [{ locked: true } as Row] };
    }
    if (
      sql.includes('FROM otto_sqlite_import_runs') &&
      sql.includes('LIMIT 1')
    ) {
      return {
        rows: this.runId
          ? [
              {
                id: this.runId,
                state: this.runState,
                source_schema_version: this.sourceSchemaVersion,
                target_schema_version: this.targetSchemaVersion,
              } as Row,
            ]
          : [],
      };
    }
    if (sql.includes('INSERT INTO otto_sqlite_import_runs')) {
      this.runId = String(values[0]);
      this.sourceSchemaVersion = Number(values[2]);
      this.targetSchemaVersion = Number(values[3]);
      this.runState = 'copying';
      return { rows: [] };
    }
    if (sql.includes("SET state = 'copying'")) {
      this.runState = 'copying';
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('COALESCE(MAX(row_index) + 1')) {
      const key = `${String(values[0])}:${String(values[1])}`;
      const rows = this.rows.get(key) ?? [];
      return {
        rows: [
          {
            next_row_index: rows.length,
            copied_rows: rows.length,
          } as Row,
        ],
      };
    }
    if (sql.includes('INSERT INTO otto_sqlite_import_rows')) {
      this.insertAttempts += 1;
      if (this.insertAttempts === this.failOnInsertAttempt) {
        throw new Error('simulated PostgreSQL disconnect');
      }
      const key = `${String(values[0])}:${String(values[1])}`;
      const indexes = values[2] as number[];
      const hashes = values[3] as string[];
      const existing = this.rows.get(key) ?? [];
      for (let index = 0; index < indexes.length; index += 1) {
        if (!existing.some((row) => row.row_index === indexes[index])) {
          existing.push({
            row_index: indexes[index]!,
            row_sha256: hashes[index]!,
          });
        }
      }
      existing.sort((left, right) => left.row_index - right.row_index);
      this.rows.set(key, existing);
      return { rows: [], rowCount: indexes.length };
    }
    if (sql.includes('SELECT row_index, row_sha256')) {
      const key = `${String(values[0])}:${String(values[1])}`;
      const offset = Number(values[2]);
      const limit = Number(values[3]);
      const rows = (this.rows.get(key) ?? []).slice(offset, offset + limit);
      const result = rows.map((row, index) => ({
        ...row,
        row_sha256:
          this.tamperTargetHash && offset === 0 && index === 0
            ? 'f'.repeat(64)
            : row.row_sha256,
      }));
      return { rows: result as Row[] };
    }
    if (sql.includes("state = 'verified'")) {
      this.runState = 'verified';
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("state = 'failed'")) {
      this.runState = 'failed';
      return { rows: [], rowCount: 1 };
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLite to PostgreSQL import', () => {
  it('builds a deterministic logical snapshot with row counts and hashes', () => {
    const source = createSource();
    try {
      const first = inspectSqliteImportSource(source, { batchSize: 1 });
      const second = inspectSqliteImportSource(source, { batchSize: 3 });

      expect(first).toEqual(second);
      expect(first.sourceSchemaVersion).toBe(20);
      expect(first.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(first.tables.map((table) => table.name)).toEqual([
        'audit_logs',
        'organizations',
      ]);
      expect(first.tables.map((table) => table.rowCount)).toEqual([2, 2]);
      expect(
        first.tables.every((table) => /^[0-9a-f]{64}$/.test(table.rowSha256)),
      ).toBe(true);
    } finally {
      source.close();
    }
  });

  it('keeps dry-run read-only and reports the exact planned snapshot', async () => {
    const source = createSource();
    const target = new ImportTarget();
    try {
      const result = await runSqliteToPostgresImport({
        source,
        target,
        targetSchemaVersion: 3,
        dryRun: true,
        batchSize: 1,
      });

      expect(result.state).toBe('planned');
      expect(result.runId).toBeNull();
      expect(result.targetSchemaVersion).toBe(3);
      expect(result.tables).toHaveLength(2);
      expect(target.statements).toEqual([]);
    } finally {
      source.close();
    }
  });

  it('copies in resumable batches and activates only a verified import run', async () => {
    const source = createSource();
    const target = new ImportTarget();
    try {
      const result = await runSqliteToPostgresImport({
        source,
        target,
        targetSchemaVersion: 3,
        batchSize: 1,
        runId: 'import_test',
      });

      expect(result).toMatchObject({
        state: 'verified',
        runId: 'import_test',
        sourceSchemaVersion: 20,
        targetSchemaVersion: 3,
      });
      expect(result.tables.map((table) => table.rowCount)).toEqual([2, 2]);
      expect(target.runState).toBe('verified');
      expect(target.rows.size).toBe(2);
      expect(
        target.statements.filter((sql) =>
          sql.includes('INSERT INTO otto_sqlite_import_rows'),
        ),
      ).toHaveLength(4);
      expect(target.released).toBe(1);
    } finally {
      source.close();
    }
  });

  it('resumes the same failed run from its first missing row', async () => {
    const source = createSource();
    const target = new ImportTarget();
    target.failOnInsertAttempt = 2;
    try {
      await expect(
        runSqliteToPostgresImport({
          source,
          target,
          targetSchemaVersion: 3,
          batchSize: 1,
          runId: 'import_resume',
        }),
      ).rejects.toThrow(/simulated PostgreSQL disconnect/i);
      expect(target.runState).toBe('failed');
      expect(target.rows.get('import_resume:audit_logs')).toHaveLength(1);

      target.failOnInsertAttempt = null;
      const resumed = await runSqliteToPostgresImport({
        source,
        target,
        targetSchemaVersion: 3,
        batchSize: 1,
      });

      expect(resumed).toMatchObject({
        state: 'verified',
        runId: 'import_resume',
      });
      expect(target.rows.get('import_resume:audit_logs')).toHaveLength(2);
      expect(target.rows.get('import_resume:organizations')).toHaveLength(2);
    } finally {
      source.close();
    }
  });

  it('marks the run failed when PostgreSQL row hashes do not match', async () => {
    const source = createSource();
    const target = new ImportTarget();
    target.tamperTargetHash = true;
    try {
      await expect(
        runSqliteToPostgresImport({
          source,
          target,
          targetSchemaVersion: 3,
          batchSize: 2,
          runId: 'import_tampered',
        }),
      ).rejects.toThrow(/hash verification failed/i);
      expect(target.runState).toBe('failed');
      expect(target.released).toBe(1);
    } finally {
      source.close();
    }
  });
});
