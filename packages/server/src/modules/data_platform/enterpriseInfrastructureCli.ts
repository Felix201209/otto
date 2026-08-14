#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createAttachmentObjectStoreRuntime,
  type AttachmentObjectStoreEnvironment,
} from './attachmentObjectStoreRuntime.js';
import {
  createClusteredEnterpriseInfrastructureRuntime,
  type ClusteredEnterpriseDatabaseLifecycle,
} from './enterpriseInfrastructureRuntime.js';
import type { EnterpriseSharedCache } from './enterpriseSharedCache.js';
import {
  describeEnterpriseServiceTopology,
  resolveEnterpriseServiceTopology,
  type EnterpriseServiceEnvironment,
} from './enterpriseServiceTopology.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from './enterprisePostgresMigrations.js';
import {
  buildNodePostgresPoolConfig,
  createNodePostgresPool,
  type NodePostgresEnvironment,
} from './nodePostgresPool.js';
import {
  createNodeRedisEnterpriseSharedCache,
  type NodeRedisEnvironment,
} from './nodeRedisSharedCache.js';
import { createPostgresDatabaseLifecycle } from './postgresDatabaseLifecycle.js';

type InfrastructureEnvironment = EnterpriseServiceEnvironment &
  NodePostgresEnvironment &
  NodeRedisEnvironment;

interface AttachmentRuntimeLike {
  store: ReturnType<typeof createAttachmentObjectStoreRuntime>['store'];
  close(): void | Promise<void>;
}

export function safeInfrastructureErrorMessage(
  error: unknown,
  environment: Pick<
    InfrastructureEnvironment,
    'OTTO_POSTGRES_URL' | 'OTTO_REDIS_URL'
  >,
): string {
  let message = error instanceof Error ? error.message : 'unknown error';
  message = message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[REDACTED]')
    .replace(/redis(?:s)?:\/\/[^\s]+/gi, 'redis://[REDACTED]');
  for (const connectionString of [
    environment.OTTO_POSTGRES_URL,
    environment.OTTO_REDIS_URL,
  ]) {
    if (!connectionString) continue;
    try {
      const parsed = new URL(connectionString);
      for (const secret of [
        connectionString,
        parsed.username,
        parsed.password,
        decodeURIComponent(parsed.username),
        decodeURIComponent(parsed.password),
      ]) {
        if (secret.length >= 3)
          message = message.replaceAll(secret, '[REDACTED]');
      }
    } catch {
      // Generic URL patterns above still protect malformed credential URLs.
    }
  }
  return message;
}

export async function checkClusteredEnterpriseInfrastructure(input: {
  environment: InfrastructureEnvironment;
  sqliteDatabasePath: string;
  databaseFactory?: (
    connectionString: string,
  ) => ClusteredEnterpriseDatabaseLifecycle;
  cacheFactory?: (connectionString: string) => Promise<EnterpriseSharedCache>;
  attachmentFactory?: (
    environment: AttachmentObjectStoreEnvironment,
  ) => AttachmentRuntimeLike;
  log?: (message: string) => void;
}) {
  const topology = resolveEnterpriseServiceTopology({
    environment: input.environment,
    sqliteDatabasePath: input.sqliteDatabasePath,
  });
  if (
    topology.mode !== 'clustered-enterprise' ||
    topology.database.backend !== 'postgresql' ||
    topology.cache.backend !== 'redis'
  ) {
    throw new Error(
      'enterprise infrastructure preflight requires PostgreSQL clustered mode',
    );
  }

  const attachmentRuntime = input.attachmentFactory
    ? input.attachmentFactory(input.environment)
    : createAttachmentObjectStoreRuntime({ environment: input.environment });
  let cache: EnterpriseSharedCache | null = null;
  let database: ClusteredEnterpriseDatabaseLifecycle | null = null;
  let runtime: ReturnType<
    typeof createClusteredEnterpriseInfrastructureRuntime
  > | null = null;
  try {
    cache = input.cacheFactory
      ? await input.cacheFactory(topology.cache.connectionString)
      : await createNodeRedisEnterpriseSharedCache({
          connectionString: topology.cache.connectionString,
          environment: input.environment,
        });
    database = input.databaseFactory
      ? input.databaseFactory(topology.database.connectionString)
      : createPostgresDatabaseLifecycle({
          pool: createNodePostgresPool(
            buildNodePostgresPoolConfig({
              connectionString: topology.database.connectionString,
              environment: input.environment,
            }),
          ),
          migrations: ENTERPRISE_POSTGRES_MIGRATIONS,
        });
    runtime = createClusteredEnterpriseInfrastructureRuntime({
      database,
      cache,
      attachments: attachmentRuntime.store,
      closeAttachments: attachmentRuntime.close,
    });
    const readiness = await runtime.initialize();
    const result = {
      topology: describeEnterpriseServiceTopology(topology),
      readiness,
    };
    input.log?.(JSON.stringify(result));
    await runtime.close();
    database = null;
    cache = null;
    return result;
  } catch (error) {
    if (runtime) {
      await runtime.close();
    } else {
      await Promise.allSettled([
        database?.close(),
        cache?.close(),
        Promise.resolve(attachmentRuntime.close()),
      ]);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const dataDirectory =
    process.env.OTTO_ENTERPRISE_DIR?.trim() ||
    path.join(process.cwd(), '.otto-enterprise');
  await checkClusteredEnterpriseInfrastructure({
    environment: process.env,
    sqliteDatabasePath: path.join(dataDirectory, 'data.db'),
    log: (message) => console.log(message),
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    console.error(
      `[Otto Enterprise] infrastructure preflight failed: ${safeInfrastructureErrorMessage(
        error,
        process.env,
      )}`,
    );
    process.exitCode = 1;
  });
}
