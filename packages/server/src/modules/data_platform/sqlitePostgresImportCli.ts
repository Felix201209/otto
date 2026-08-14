#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertLocalSqliteDatabasePath,
  describeEnterpriseDatabaseTopology,
  resolveEnterpriseDatabaseTopology,
  type EnterpriseDatabaseTopologyEnvironment,
} from './enterpriseDatabaseTopology.js';
import {
  ENTERPRISE_POSTGRES_MIGRATIONS,
  ENTERPRISE_POSTGRES_SCHEMA_VERSION,
} from './enterprisePostgresMigrations.js';
import {
  buildNodePostgresPoolConfig,
  createNodePostgresPool,
  type NodePostgresEnvironment,
} from './nodePostgresPool.js';
import {
  createPostgresDatabaseLifecycle,
  type PostgresPoolLike,
} from './postgresDatabaseLifecycle.js';
import { safePostgresErrorMessage } from './postgresDatabaseCli.js';
import {
  inspectSqliteImportSource,
  runSqliteToPostgresImport,
  type SqlitePostgresImportResult,
} from './sqlitePostgresImport.js';
import {
  createSqlCipherFileRuntime,
  parseSqlCipherRuntimeMode,
} from './sqlCipherRuntime.js';
import { Database, type DatabaseHandle } from './sqliteCompat.js';

type SqlitePostgresImportEnvironment = NodeJS.ProcessEnv &
  EnterpriseDatabaseTopologyEnvironment &
  NodePostgresEnvironment & {
    NODE_ENV?: string;
    OTTO_SQLITE_IMPORT_PATH?: string;
    OTTO_SQLITE_IMPORT_ENCRYPTION?: string;
    OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED?: string;
    OTTO_DATABASE_ENCRYPTION_KEY_FILE?: string;
    OTTO_DATABASE_ENCRYPTION_KEY_ID?: string;
    OTTO_DATABASE_ENCRYPTION_KEY_READONLY?: string;
    OTTO_SQLCIPHER_NATIVE_BINDING?: string;
  };

export interface SqlitePostgresImportArguments {
  dryRun: boolean;
  sourcePath?: string;
  batchSize?: number;
}

interface SqliteImportSourceRuntime {
  database: DatabaseHandle;
  close(): void;
}

export function parseSqlitePostgresImportArguments(
  input: readonly string[],
): SqlitePostgresImportArguments {
  let dryRun = true;
  let selectedMode: 'dry-run' | 'execute' | null = null;
  let sourcePath: string | undefined;
  let batchSize: number | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index];
    if (argument === '--dry-run' || argument === '--execute') {
      const nextMode = argument === '--execute' ? 'execute' : 'dry-run';
      if (selectedMode && selectedMode !== nextMode) {
        throw new Error('--dry-run and --execute cannot be combined');
      }
      selectedMode = nextMode;
      dryRun = nextMode === 'dry-run';
      continue;
    }
    if (argument === '--source') {
      const value = input[index + 1]?.trim();
      if (!value || value.startsWith('--')) {
        throw new Error('--source requires a SQLite snapshot path');
      }
      sourcePath = value;
      index += 1;
      continue;
    }
    if (argument === '--batch-size') {
      const value = Number(input[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
        throw new Error('--batch-size must be an integer from 1 to 5000');
      }
      batchSize = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return {
    dryRun,
    ...(sourcePath ? { sourcePath } : {}),
    ...(batchSize ? { batchSize } : {}),
  };
}

function openSqliteImportSource(
  sourcePath: string,
  environment: SqlitePostgresImportEnvironment,
): SqliteImportSourceRuntime {
  const sourceEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    OTTO_DATABASE_ENCRYPTION: environment.OTTO_SQLITE_IMPORT_ENCRYPTION,
  };
  if (parseSqlCipherRuntimeMode(sourceEnvironment) === 'disabled') {
    const database = new Database(sourcePath, { readOnly: true });
    return { database, close: () => database.close() };
  }
  const runtime = createSqlCipherFileRuntime({
    dataDirectory: path.dirname(sourcePath),
    environment: sourceEnvironment,
  });
  try {
    const database = runtime.openProtectedDatabase(sourcePath);
    return {
      database,
      close() {
        try {
          database.close();
        } finally {
          runtime.keyProvider.clear();
        }
      },
    };
  } catch (error) {
    runtime.keyProvider.clear();
    throw error;
  }
}

function maintenanceConfirmed(
  environment: SqlitePostgresImportEnvironment,
): boolean {
  return (
    environment.OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED?.trim().toLowerCase() ===
    'true'
  );
}

export function safeSqlitePostgresImportErrorMessage(
  error: unknown,
  environment: Pick<SqlitePostgresImportEnvironment, 'OTTO_POSTGRES_URL'>,
  sourcePath?: string,
): string {
  let message = safePostgresErrorMessage(error, environment.OTTO_POSTGRES_URL);
  if (sourcePath) {
    const sourceName = sourcePath.includes('\\')
      ? path.win32.basename(sourcePath)
      : path.basename(sourcePath);
    for (const candidate of [path.resolve(sourcePath), sourcePath].sort(
      (left, right) => right.length - left.length,
    )) {
      message = message.replaceAll(candidate, sourceName);
    }
  }
  return message;
}

export async function importEnterpriseSqliteToPostgres(input: {
  arguments: readonly string[];
  environment: SqlitePostgresImportEnvironment;
  sourceFactory?: (
    sourcePath: string,
    environment: SqlitePostgresImportEnvironment,
  ) => SqliteImportSourceRuntime;
  poolFactory?: (connectionString: string) => PostgresPoolLike;
  log?: (message: string) => void;
}): Promise<SqlitePostgresImportResult> {
  const options = parseSqlitePostgresImportArguments(input.arguments);
  if (!options.dryRun && !maintenanceConfirmed(input.environment)) {
    throw new Error(
      'execute requires OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED=true after stopping all SQLite writers',
    );
  }
  const configuredSource =
    options.sourcePath ?? input.environment.OTTO_SQLITE_IMPORT_PATH?.trim();
  if (!configuredSource) {
    throw new Error(
      'SQLite import requires --source or OTTO_SQLITE_IMPORT_PATH',
    );
  }
  const sourcePath = path.resolve(configuredSource);
  assertLocalSqliteDatabasePath(sourcePath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`SQLite import source does not exist: ${sourcePath}`);
  }
  const topology = resolveEnterpriseDatabaseTopology({
    environment: input.environment,
    sqliteDatabasePath: sourcePath,
  });
  if (topology.backend !== 'postgresql') {
    throw new Error(
      'SQLite import target requires OTTO_ENTERPRISE_DATABASE_BACKEND=postgresql',
    );
  }

  const sourceRuntime = (input.sourceFactory ?? openSqliteImportSource)(
    sourcePath,
    input.environment,
  );
  let result: SqlitePostgresImportResult;
  try {
    if (options.dryRun) {
      const plan = inspectSqliteImportSource(sourceRuntime.database, {
        batchSize: options.batchSize,
      });
      result = {
        ...plan,
        state: 'planned',
        runId: null,
        targetSchemaVersion: ENTERPRISE_POSTGRES_SCHEMA_VERSION,
      };
    } else {
      const pool = input.poolFactory
        ? input.poolFactory(topology.connectionString)
        : createNodePostgresPool(
            buildNodePostgresPoolConfig({
              connectionString: topology.connectionString,
              environment: input.environment,
            }),
          );
      const lifecycle = createPostgresDatabaseLifecycle({
        pool,
        migrations: ENTERPRISE_POSTGRES_MIGRATIONS,
      });
      try {
        const readiness = await lifecycle.initialize();
        result = await runSqliteToPostgresImport({
          source: sourceRuntime.database,
          target: pool,
          targetSchemaVersion: readiness.schemaVersion,
          batchSize: options.batchSize,
        });
      } finally {
        await lifecycle.close();
      }
    }
  } finally {
    sourceRuntime.close();
  }

  input.log?.(
    JSON.stringify({
      mode: options.dryRun ? 'dry-run' : 'execute',
      source: path.basename(sourcePath),
      target: describeEnterpriseDatabaseTopology(topology),
      state: result.state,
      runId: result.runId,
      sourceSchemaVersion: result.sourceSchemaVersion,
      targetSchemaVersion: result.targetSchemaVersion,
      sourceSha256: result.sourceSha256,
      tables: result.tables.map((table) => ({
        name: table.name,
        rowCount: table.rowCount,
        rowSha256: table.rowSha256,
      })),
    }),
  );
  return result;
}

async function main(): Promise<void> {
  let sourcePath: string | undefined;
  try {
    const options = parseSqlitePostgresImportArguments(process.argv.slice(2));
    sourcePath =
      options.sourcePath ?? process.env.OTTO_SQLITE_IMPORT_PATH?.trim();
    await importEnterpriseSqliteToPostgres({
      arguments: process.argv.slice(2),
      environment: process.env,
      log: (message) => console.log(message),
    });
  } catch (error) {
    const message = safeSqlitePostgresImportErrorMessage(
      error,
      process.env,
      sourcePath,
    );
    console.error(`[Otto Enterprise] SQLite import failed: ${message}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) void main();
