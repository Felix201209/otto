#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  describeEnterpriseDatabaseTopology,
  resolveEnterpriseDatabaseTopology,
  type EnterpriseDatabaseTopologyEnvironment,
} from '../modules/data_platform/enterpriseDatabaseTopology.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from './postgresMigrations.js';
import {
  buildNodePostgresPoolConfig,
  createNodePostgresPool,
  type NodePostgresEnvironment,
} from '../modules/data_platform/nodePostgresPool.js';
import { createPostgresDatabaseLifecycle } from '../modules/data_platform/postgresDatabaseLifecycle.js';
import { safePostgresErrorMessage } from '../modules/data_platform/postgresDatabaseCli.js';
import {
  promoteVerifiedSqliteImport,
  type PostgresEnterprisePromotionResult,
} from './postgresPromotion.js';

type PromotionEnvironment = NodeJS.ProcessEnv &
  EnterpriseDatabaseTopologyEnvironment &
  NodePostgresEnvironment & {
    OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED?: string;
    OTTO_ATTACHMENT_TENANT_QUOTA_BYTES?: string;
    OTTO_ATTACHMENT_MIGRATION_GRACE_DAYS?: string;
  };

export interface PostgresEnterprisePromotionArguments {
  runId: string;
  dryRun: boolean;
}

function positiveIntegerSetting(input: {
  name: string;
  value: string | undefined;
  fallback: number;
}): number {
  if (!input.value?.trim()) return input.fallback;
  const parsed = Number(input.value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${input.name} must be a positive safe integer`);
  }
  return parsed;
}

export function parsePostgresEnterprisePromotionArguments(
  args: readonly string[],
): PostgresEnterprisePromotionArguments {
  let runId = '';
  let dryRun = true;
  let selectedMode: 'dry-run' | 'execute' | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--run') {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith('--')) {
        throw new Error('--run requires a verified SQLite import run id');
      }
      runId = value;
      index += 1;
      continue;
    }
    if (argument === '--dry-run' || argument === '--execute') {
      const mode = argument === '--execute' ? 'execute' : 'dry-run';
      if (selectedMode && selectedMode !== mode) {
        throw new Error('--dry-run and --execute cannot be combined');
      }
      selectedMode = mode;
      dryRun = mode === 'dry-run';
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!runId) throw new Error('--run is required');
  return { runId, dryRun };
}

export async function promoteEnterprisePostgres(input: {
  arguments: readonly string[];
  environment: PromotionEnvironment;
  log?: (message: string) => void;
}): Promise<PostgresEnterprisePromotionResult> {
  const options = parsePostgresEnterprisePromotionArguments(input.arguments);
  if (
    !options.dryRun &&
    input.environment.OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED?.trim().toLowerCase() !==
      'true'
  ) {
    throw new Error(
      'execute requires OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED=true after stopping all SQLite writers',
    );
  }
  const topology = resolveEnterpriseDatabaseTopology({
    environment: input.environment,
    sqliteDatabasePath: 'promotion-does-not-open-sqlite.db',
  });
  if (topology.backend !== 'postgresql') {
    throw new Error('PostgreSQL promotion requires PostgreSQL enterprise mode');
  }
  const pool = createNodePostgresPool(
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
    await lifecycle.initialize();
    const result = await promoteVerifiedSqliteImport({
      pool,
      runId: options.runId,
      dryRun: options.dryRun,
      defaultAttachmentQuotaBytes: positiveIntegerSetting({
        name: 'OTTO_ATTACHMENT_TENANT_QUOTA_BYTES',
        value: input.environment.OTTO_ATTACHMENT_TENANT_QUOTA_BYTES,
        fallback: 100 * 1024 * 1024 * 1024,
      }),
      legacyAttachmentGraceMs:
        positiveIntegerSetting({
          name: 'OTTO_ATTACHMENT_MIGRATION_GRACE_DAYS',
          value: input.environment.OTTO_ATTACHMENT_MIGRATION_GRACE_DAYS,
          fallback: 30,
        }) *
        24 *
        60 *
        60 *
        1_000,
    });
    input.log?.(
      JSON.stringify({
        mode: options.dryRun ? 'dry-run' : 'execute',
        target: describeEnterpriseDatabaseTopology(topology),
        ...result,
      }),
    );
    return result;
  } finally {
    await lifecycle.close();
  }
}

async function main(): Promise<void> {
  try {
    await promoteEnterprisePostgres({
      arguments: process.argv.slice(2),
      environment: process.env,
      log: (message) => console.log(message),
    });
  } catch (error) {
    console.error(
      `[Otto Enterprise] PostgreSQL promotion failed: ${safePostgresErrorMessage(
        error,
        process.env.OTTO_POSTGRES_URL,
      )}`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) void main();
