/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';

import type {
  PostgresClientLike,
  PostgresPoolLike,
} from './postgresDatabaseLifecycle.js';
import type { DatabaseHandle } from './sqliteCompat.js';

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5_000;
const IMPORT_ADVISORY_LOCK_KEY = 0x4f545449;

interface SqliteTableRow extends Record<string, unknown> {
  name: string;
  sql: string | null;
}

interface SqliteColumnRow extends Record<string, unknown> {
  cid: number;
  name: string;
  pk: number;
  hidden: number;
}

interface SqliteTableDescriptor {
  name: string;
  schemaSql: string;
  columns: string[];
  primaryKey: string[];
  orderBy: string;
}

interface CanonicalRow {
  data: string;
  sha256: string;
}

export interface SqliteImportTablePlan {
  name: string;
  schemaSql: string;
  columns: string[];
  primaryKey: string[];
  rowCount: number;
  rowSha256: string;
}

export interface SqliteImportPlan {
  sourceSchemaVersion: number;
  sourceSha256: string;
  tables: SqliteImportTablePlan[];
}

export interface SqlitePostgresImportResult extends SqliteImportPlan {
  state: 'planned' | 'verified';
  runId: string | null;
  targetSchemaVersion: number;
}

function normalizeBatchSize(value: number | undefined): number {
  const batchSize = value ?? DEFAULT_BATCH_SIZE;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_BATCH_SIZE
  ) {
    throw new Error(
      `SQLite import batch size must be an integer from 1 to ${MAX_BATCH_SIZE}`,
    );
  }
  return batchSize;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function encodeSqliteValue(value: unknown): unknown {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('SQLite import encountered a non-finite number');
    }
    if (Object.is(value, -0)) return { type: 'number', value: '-0' };
    return value;
  }
  if (typeof value === 'bigint') {
    return { type: 'bigint', value: value.toString(10) };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return {
      type: 'bytes',
      value: Buffer.from(value).toString('base64'),
    };
  }
  throw new Error(
    `SQLite import encountered unsupported value type ${typeof value}`,
  );
}

function canonicalRow(
  row: Record<string, unknown>,
  columns: readonly string[],
): CanonicalRow {
  const data = JSON.stringify(
    columns.map((column) => encodeSqliteValue(row[column])),
  );
  return {
    data,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

function schemaVersion(database: DatabaseHandle): number {
  const row = database.prepare('PRAGMA user_version').get() as
    { user_version?: number } | undefined;
  const version = Number(row?.user_version ?? 0);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('SQLite import source schema version is unavailable');
  }
  return version;
}

function tableDescriptors(database: DatabaseHandle): SqliteTableDescriptor[] {
  const tables = database
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
    .all() as SqliteTableRow[];

  return tables.map((table) => {
    if (typeof table.name !== 'string' || !table.name) {
      throw new Error('SQLite import source contains an invalid table name');
    }
    if (typeof table.sql !== 'string' || !table.sql.trim()) {
      throw new Error(`SQLite import table ${table.name} has no source schema`);
    }
    const columns = database
      .prepare(`PRAGMA table_xinfo(${quoteIdentifier(table.name)})`)
      .all() as SqliteColumnRow[];
    const visibleColumns = columns
      .filter((column) => Number(column.hidden ?? 0) === 0)
      .sort((left, right) => Number(left.cid) - Number(right.cid));
    if (visibleColumns.length === 0) {
      throw new Error(
        `SQLite import table ${table.name} has no visible columns`,
      );
    }
    const columnNames = visibleColumns.map((column) => {
      if (typeof column.name !== 'string' || !column.name) {
        throw new Error(
          `SQLite import table ${table.name} has an invalid column`,
        );
      }
      return column.name;
    });
    const primaryKey = visibleColumns
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name);
    return {
      name: table.name,
      schemaSql: table.sql,
      columns: columnNames,
      primaryKey,
      orderBy:
        primaryKey.length > 0
          ? primaryKey.map(quoteIdentifier).join(', ')
          : 'rowid',
    };
  });
}

function scanTable(input: {
  source: DatabaseHandle;
  descriptor: SqliteTableDescriptor;
  batchSize: number;
  onBatch?: (rows: readonly CanonicalRow[], offset: number) => void;
}): SqliteImportTablePlan {
  const digest = createHash('sha256');
  let offset = 0;
  const projection = input.descriptor.columns.map(quoteIdentifier).join(', ');
  const statement = input.source.prepare(
    `SELECT ${projection}
     FROM ${quoteIdentifier(input.descriptor.name)}
     ORDER BY ${input.descriptor.orderBy}
     LIMIT ? OFFSET ?`,
  );
  while (true) {
    const rawRows = statement.all(input.batchSize, offset) as Array<
      Record<string, unknown>
    >;
    if (rawRows.length === 0) break;
    const rows = rawRows.map((row) =>
      canonicalRow(row, input.descriptor.columns),
    );
    for (const row of rows) digest.update(row.sha256).update('\n');
    input.onBatch?.(rows, offset);
    offset += rows.length;
    if (rows.length < input.batchSize) break;
  }
  return {
    name: input.descriptor.name,
    schemaSql: input.descriptor.schemaSql,
    columns: [...input.descriptor.columns],
    primaryKey: [...input.descriptor.primaryKey],
    rowCount: offset,
    rowSha256: digest.digest('hex'),
  };
}

function planDigest(
  sourceSchemaVersion: number,
  tables: readonly SqliteImportTablePlan[],
): string {
  const digest = createHash('sha256');
  digest.update(`schema:${sourceSchemaVersion}\n`);
  for (const table of tables) {
    digest.update(
      JSON.stringify({
        name: table.name,
        schemaSql: table.schemaSql,
        columns: table.columns,
        primaryKey: table.primaryKey,
        rowCount: table.rowCount,
        rowSha256: table.rowSha256,
      }),
    );
    digest.update('\n');
  }
  return digest.digest('hex');
}

/** Builds a logical snapshot independent of SQLite page/WAL layout. */
export function inspectSqliteImportSource(
  source: DatabaseHandle,
  options: { batchSize?: number } = {},
): SqliteImportPlan {
  const batchSize = normalizeBatchSize(options.batchSize);
  const sourceSchemaVersion = schemaVersion(source);
  const tables = tableDescriptors(source).map((descriptor) =>
    scanTable({ source, descriptor, batchSize }),
  );
  return {
    sourceSchemaVersion,
    sourceSha256: planDigest(sourceSchemaVersion, tables),
    tables,
  };
}

function samePlan(left: SqliteImportPlan, right: SqliteImportPlan): boolean {
  return (
    left.sourceSchemaVersion === right.sourceSchemaVersion &&
    left.sourceSha256 === right.sourceSha256 &&
    JSON.stringify(left.tables) === JSON.stringify(right.tables)
  );
}

async function verifyTargetTable(input: {
  client: PostgresClientLike;
  runId: string;
  table: SqliteImportTablePlan;
  batchSize: number;
}): Promise<void> {
  const digest = createHash('sha256');
  let offset = 0;
  while (true) {
    const result = await input.client.query<{
      row_index: number | string;
      row_sha256: string;
    }>(
      `SELECT row_index, row_sha256
       FROM otto_sqlite_import_rows
       WHERE run_id = $1 AND table_name = $2
       ORDER BY row_index
       LIMIT $4 OFFSET $3`,
      [input.runId, input.table.name, offset, input.batchSize],
    );
    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      if (Number(row.row_index) !== offset) {
        throw new Error(
          `PostgreSQL row sequence verification failed for ${input.table.name}`,
        );
      }
      if (!/^[0-9a-f]{64}$/.test(row.row_sha256)) {
        throw new Error(
          `PostgreSQL row hash verification failed for ${input.table.name}`,
        );
      }
      digest.update(row.row_sha256).update('\n');
      offset += 1;
    }
    if (result.rows.length < input.batchSize) break;
  }
  const rowSha256 = digest.digest('hex');
  if (offset !== input.table.rowCount || rowSha256 !== input.table.rowSha256) {
    throw new Error(
      `PostgreSQL row count or hash verification failed for ${input.table.name}`,
    );
  }
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/source.*changed/i.test(message)) return 'source_changed';
  if (/verification|sequence|hash|row count/i.test(message)) {
    return 'verification_failed';
  }
  return 'import_failed';
}

/**
 * Copies a frozen SQLite logical snapshot into PostgreSQL staging tables.
 * Repositories are switched separately only after this result is verified.
 */
export async function runSqliteToPostgresImport(input: {
  source: DatabaseHandle;
  target: PostgresPoolLike;
  targetSchemaVersion: number;
  dryRun?: boolean;
  batchSize?: number;
  runId?: string;
}): Promise<SqlitePostgresImportResult> {
  if (
    !Number.isSafeInteger(input.targetSchemaVersion) ||
    input.targetSchemaVersion < 1
  ) {
    throw new Error('PostgreSQL target schema version is invalid');
  }
  const batchSize = normalizeBatchSize(input.batchSize);
  const initialPlan = inspectSqliteImportSource(input.source, { batchSize });
  if (input.dryRun) {
    return {
      ...initialPlan,
      state: 'planned',
      runId: null,
      targetSchemaVersion: input.targetSchemaVersion,
    };
  }

  const client = await input.target.connect();
  let runId: string | null = null;
  let runOwned = false;
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [IMPORT_ADVISORY_LOCK_KEY],
    );
    if (lock.rows[0]?.locked !== true) {
      throw new Error('another SQLite to PostgreSQL import is already running');
    }
    locked = true;

    const existing = await client.query<{
      id: string;
      state: string;
      source_schema_version: number | string;
      target_schema_version: number | string;
    }>(
      `SELECT id, state, source_schema_version, target_schema_version
       FROM otto_sqlite_import_runs
       WHERE source_sha256 = $1 AND target_schema_version = $2
       ORDER BY started_at DESC
       LIMIT 1`,
      [initialPlan.sourceSha256, input.targetSchemaVersion],
    );
    const prior = existing.rows[0];
    runId = prior?.id ?? input.runId ?? randomUUID();
    if (prior) {
      if (
        Number(prior.source_schema_version) !==
          initialPlan.sourceSchemaVersion ||
        Number(prior.target_schema_version) !== input.targetSchemaVersion
      ) {
        throw new Error(
          'existing SQLite import metadata does not match source',
        );
      }
      runOwned = true;
      await client.query(
        `UPDATE otto_sqlite_import_runs
         SET state = 'copying', failure_code = NULL, completed_at = NULL
         WHERE id = $1 AND state <> 'verified'`,
        [runId],
      );
    } else {
      await client.query(
        `INSERT INTO otto_sqlite_import_runs
           (id, source_sha256, source_schema_version, target_schema_version, state, row_counts)
         VALUES ($1, $2, $3, $4, 'copying', $5::jsonb)`,
        [
          runId,
          initialPlan.sourceSha256,
          initialPlan.sourceSchemaVersion,
          input.targetSchemaVersion,
          JSON.stringify(
            Object.fromEntries(
              initialPlan.tables.map((table) => [table.name, table.rowCount]),
            ),
          ),
        ],
      );
      runOwned = true;
    }

    const descriptors = tableDescriptors(input.source);
    for (const [tableIndex, descriptor] of descriptors.entries()) {
      const expected = initialPlan.tables[tableIndex];
      if (!expected || expected.name !== descriptor.name) {
        throw new Error('SQLite import source changed after planning');
      }
      await client.query(
        `INSERT INTO otto_sqlite_import_tables
           (run_id, table_name, source_schema_sql, column_names, primary_key,
            source_row_count, source_row_sha256, state)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, 'copying')
         ON CONFLICT (run_id, table_name) DO NOTHING`,
        [
          runId,
          expected.name,
          expected.schemaSql,
          JSON.stringify(expected.columns),
          JSON.stringify(expected.primaryKey),
          expected.rowCount,
          expected.rowSha256,
        ],
      );
      const progress = await client.query<{
        next_row_index: number | string;
        copied_rows: number | string;
      }>(
        `SELECT COALESCE(MAX(row_index) + 1, 0) AS next_row_index,
                COUNT(*) AS copied_rows
         FROM otto_sqlite_import_rows
         WHERE run_id = $1 AND table_name = $2`,
        [runId, expected.name],
      );
      const resumeAt = Number(progress.rows[0]?.next_row_index ?? 0);
      const copiedRows = Number(progress.rows[0]?.copied_rows ?? 0);
      if (
        !Number.isSafeInteger(resumeAt) ||
        resumeAt < 0 ||
        resumeAt !== copiedRows ||
        resumeAt > expected.rowCount
      ) {
        throw new Error(
          `PostgreSQL import progress is inconsistent for ${expected.name}`,
        );
      }

      const copiedDigest = createHash('sha256');
      const projection = descriptor.columns.map(quoteIdentifier).join(', ');
      const sourceRows = input.source.prepare(
        `SELECT ${projection}
         FROM ${quoteIdentifier(descriptor.name)}
         ORDER BY ${descriptor.orderBy}
         LIMIT ? OFFSET ?`,
      );
      let sourceOffset = 0;
      while (true) {
        const rawRows = sourceRows.all(batchSize, sourceOffset) as Array<
          Record<string, unknown>
        >;
        if (rawRows.length === 0) break;
        const rows = rawRows.map((row) =>
          canonicalRow(row, descriptor.columns),
        );
        for (const row of rows) copiedDigest.update(row.sha256).update('\n');
        const pending = rows
          .map((row, index) => ({ row, rowIndex: sourceOffset + index }))
          .filter((entry) => entry.rowIndex >= resumeAt);
        if (pending.length > 0) {
          await client.query(
            `INSERT INTO otto_sqlite_import_rows
               (run_id, table_name, row_index, row_sha256, row_data)
             SELECT $1, $2, row_index, row_sha256, row_data::jsonb
             FROM unnest($3::bigint[], $4::text[], $5::text[])
               AS imported(row_index, row_sha256, row_data)
             ON CONFLICT (run_id, table_name, row_index) DO NOTHING`,
            [
              runId,
              expected.name,
              pending.map((entry) => entry.rowIndex),
              pending.map((entry) => entry.row.sha256),
              pending.map((entry) => entry.row.data),
            ],
          );
        }
        sourceOffset += rows.length;
        if (rows.length < batchSize) break;
      }
      const copiedPlan: SqliteImportTablePlan = {
        name: descriptor.name,
        schemaSql: descriptor.schemaSql,
        columns: [...descriptor.columns],
        primaryKey: [...descriptor.primaryKey],
        rowCount: sourceOffset,
        rowSha256: copiedDigest.digest('hex'),
      };
      if (
        copiedPlan.rowCount !== expected.rowCount ||
        copiedPlan.rowSha256 !== expected.rowSha256
      ) {
        throw new Error(
          `SQLite import source changed while copying ${expected.name}`,
        );
      }
      await verifyTargetTable({
        client,
        runId,
        table: expected,
        batchSize,
      });
      await client.query(
        `UPDATE otto_sqlite_import_tables
         SET state = 'verified', copied_row_count = $3, copied_row_sha256 = $4,
             completed_at = CURRENT_TIMESTAMP
         WHERE run_id = $1 AND table_name = $2`,
        [runId, expected.name, expected.rowCount, expected.rowSha256],
      );
    }

    const finalPlan = inspectSqliteImportSource(input.source, { batchSize });
    if (!samePlan(initialPlan, finalPlan)) {
      throw new Error('SQLite import source changed before final verification');
    }
    await client.query(
      `UPDATE otto_sqlite_import_runs
       SET state = 'verified', completed_at = CURRENT_TIMESTAMP, failure_code = NULL
       WHERE id = $1 AND state IN ('copying', 'verified')`,
      [runId],
    );
    return {
      ...initialPlan,
      state: 'verified',
      runId,
      targetSchemaVersion: input.targetSchemaVersion,
    };
  } catch (error) {
    if (runId && runOwned) {
      try {
        await client.query(
          `UPDATE otto_sqlite_import_runs
           SET state = 'failed', completed_at = CURRENT_TIMESTAMP, failure_code = $2
           WHERE id = $1`,
          [runId, failureCode(error)],
        );
      } catch {
        // Preserve the import failure; the next run validates staging progress.
      }
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [
          IMPORT_ADVISORY_LOCK_KEY,
        ]);
      } catch {
        // Releasing the PostgreSQL session below also releases the lock.
      }
    }
    client.release();
  }
}
