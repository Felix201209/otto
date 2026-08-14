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
} from './enterpriseDatabaseTopology.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from './enterprisePostgresMigrations.js';
import {
  buildNodePostgresPoolConfig,
  createNodePostgresPool,
  type NodePostgresEnvironment,
} from './nodePostgresPool.js';
import {
  createPostgresDatabaseLifecycle,
  type PostgresDatabaseReadiness,
  type PostgresMigration,
  type PostgresPoolLike,
} from './postgresDatabaseLifecycle.js';

type PostgresCliEnvironment = EnterpriseDatabaseTopologyEnvironment &
  NodePostgresEnvironment;

export function safePostgresErrorMessage(
  error: unknown,
  connectionString: string | undefined,
): string {
  let message = error instanceof Error ? error.message : 'unknown error';
  message = message.replace(
    /postgres(?:ql)?:\/\/[^\s]+/gi,
    'postgresql://[REDACTED]',
  );
  if (!connectionString) return message;
  try {
    const parsed = new URL(connectionString);
    const secrets = [
      connectionString,
      parsed.username,
      parsed.password,
      decodeURIComponent(parsed.username),
      decodeURIComponent(parsed.password),
    ];
    for (const secret of secrets) {
      if (secret.length >= 3)
        message = message.replaceAll(secret, '[REDACTED]');
    }
  } catch {
    // The generic PostgreSQL URL pattern above still protects malformed URLs.
  }
  return message;
}

export async function prepareEnterprisePostgres(input: {
  environment: PostgresCliEnvironment;
  migrations?: readonly PostgresMigration[];
  poolFactory?: (connectionString: string) => PostgresPoolLike;
  log?: (message: string) => void;
}): Promise<PostgresDatabaseReadiness> {
  const topology = resolveEnterpriseDatabaseTopology({
    environment: input.environment,
    sqliteDatabasePath: path.join(process.cwd(), 'data.db'),
  });
  if (topology.backend !== 'postgresql') {
    throw new Error(
      'PostgreSQL preparation requires OTTO_ENTERPRISE_DATABASE_BACKEND=postgresql',
    );
  }
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
    migrations: input.migrations ?? ENTERPRISE_POSTGRES_MIGRATIONS,
  });
  try {
    const readiness = await lifecycle.initialize();
    input.log?.(
      JSON.stringify({
        topology: describeEnterpriseDatabaseTopology(topology),
        readiness,
      }),
    );
    return readiness;
  } finally {
    await lifecycle.close();
  }
}

async function main(): Promise<void> {
  await prepareEnterprisePostgres({
    environment: process.env,
    log: (message) => console.log(message),
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = safePostgresErrorMessage(
      error,
      process.env.OTTO_POSTGRES_URL,
    );
    console.error(
      `[Otto Enterprise] PostgreSQL preparation failed: ${message}`,
    );
    process.exitCode = 1;
  });
}
