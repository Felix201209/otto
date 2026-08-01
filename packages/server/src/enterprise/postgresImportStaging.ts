/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Shared, verified decoder for the immutable SQLite import staging rows.
 */

import type { PostgresClientLike } from '../modules/data_platform/postgresDatabaseLifecycle.js';

interface ImportTableRow extends Record<string, unknown> {
  table_name: string;
  column_names: unknown[] | string;
  source_row_count: number | string;
  copied_row_count: number | string | null;
  state: string;
}

interface ImportDataRow extends Record<string, unknown> {
  row_data: unknown[] | string;
}

export type DecodedSqliteImportRow = Record<string, unknown>;

function parseArray(value: unknown[] | string, label: string): unknown[] {
  const parsed =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) throw new Error(`${label} is not a JSON array`);
  return parsed;
}

function decodeValue(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'type' in value &&
    'value' in value
  ) {
    const encoded = value as { type: unknown; value: unknown };
    if (encoded.type === 'bytes' && typeof encoded.value === 'string') {
      return Buffer.from(encoded.value, 'base64');
    }
    if (encoded.type === 'bigint' && typeof encoded.value === 'string') {
      return encoded.value;
    }
    if (encoded.type === 'number' && encoded.value === '-0') return 0;
    throw new Error('SQLite staging row contains an unsupported encoded value');
  }
  return value;
}

function columnName(value: unknown, tableName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`SQLite import ${tableName} column is invalid`);
  }
  return value;
}

export async function loadVerifiedSqliteImportTable(
  client: Pick<PostgresClientLike, 'query'>,
  runId: string,
  tableName: string,
): Promise<DecodedSqliteImportRow[]> {
  const tableResult = await client.query<ImportTableRow>(
    `SELECT table_name, column_names, source_row_count, copied_row_count, state
     FROM otto_sqlite_import_tables
     WHERE run_id = $1 AND table_name = $2`,
    [runId, tableName],
  );
  const table = tableResult.rows[0];
  if (!table) return [];
  if (
    table.state !== 'verified' ||
    Number(table.source_row_count) !== Number(table.copied_row_count)
  ) {
    throw new Error(`SQLite import table ${tableName} is not verified`);
  }
  const columns = parseArray(table.column_names, `${tableName} columns`).map(
    (column) => columnName(column, tableName),
  );
  const rows = await client.query<ImportDataRow>(
    `SELECT row_data FROM otto_sqlite_import_rows
     WHERE run_id = $1 AND table_name = $2 ORDER BY row_index`,
    [runId, tableName],
  );
  if (rows.rows.length !== Number(table.source_row_count)) {
    throw new Error(
      `SQLite import table ${tableName} row count changed after verification`,
    );
  }
  return rows.rows.map((row, rowIndex) => {
    const values = parseArray(row.row_data, `${tableName} row ${rowIndex}`);
    if (values.length !== columns.length) {
      throw new Error(`SQLite import table ${tableName} row shape is invalid`);
    }
    return Object.fromEntries(
      columns.map((column, index) => [column, decodeValue(values[index])]),
    );
  });
}
