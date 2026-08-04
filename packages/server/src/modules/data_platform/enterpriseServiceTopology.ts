/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

import {
  resolveAttachmentObjectStoreConfig,
  type AttachmentObjectStoreConfig,
  type AttachmentObjectStoreEnvironment,
} from './attachmentObjectStoreRuntime.js';
import {
  describeEnterpriseDatabaseTopology,
  resolveEnterpriseDatabaseTopology,
  type EnterpriseDatabaseTopology,
  type EnterpriseDatabaseTopologyEnvironment,
} from './enterpriseDatabaseTopology.js';

export interface EnterpriseSharedCacheEnvironment {
  OTTO_ENTERPRISE_CACHE_BACKEND?: string;
  OTTO_REDIS_URL?: string;
  OTTO_REDIS_ALLOW_INSECURE?: string;
}

export type EnterpriseServiceEnvironment =
  EnterpriseDatabaseTopologyEnvironment &
    AttachmentObjectStoreEnvironment &
    EnterpriseSharedCacheEnvironment;

export type EnterpriseSharedCacheConfig =
  { backend: 'memory' } | { backend: 'redis'; connectionString: string };

export interface EnterpriseServiceTopology {
  mode: 'local-offline' | 'clustered-enterprise';
  replicas: number;
  database: EnterpriseDatabaseTopology;
  attachments: AttachmentObjectStoreConfig;
  cache: EnterpriseSharedCacheConfig;
}

function configuredBackend(
  value: string | undefined,
  fallback: string,
): string {
  return value?.trim().toLowerCase() || fallback;
}

function parseBoolean(name: string, value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return false;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function parseRedisUrl(value: string, allowInsecure: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('OTTO_REDIS_URL must be a valid Redis URL');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(
      'OTTO_REDIS_URL must use redis:// or rediss:// and include a host',
    );
  }
  if (parsed.protocol === 'redis:' && !allowInsecure) {
    throw new Error(
      'plaintext Redis must be explicitly enabled with OTTO_REDIS_ALLOW_INSECURE=true',
    );
  }
  const database = parsed.pathname.replace(/^\/+/, '');
  if (database && !/^\d+$/.test(database)) {
    throw new Error('OTTO_REDIS_URL database must be numeric');
  }
  return parsed;
}

export function resolveEnterpriseSharedCacheConfig(input: {
  environment: EnterpriseSharedCacheEnvironment;
  requireShared: boolean;
}): EnterpriseSharedCacheConfig {
  const backend = configuredBackend(
    input.environment.OTTO_ENTERPRISE_CACHE_BACKEND,
    'memory',
  );
  if (backend === 'memory') {
    if (input.requireShared) {
      throw new Error(
        'PostgreSQL enterprise mode requires a shared Redis-compatible cache',
      );
    }
    return { backend: 'memory' };
  }
  if (backend !== 'redis') {
    throw new Error('OTTO_ENTERPRISE_CACHE_BACKEND must be memory or redis');
  }
  const connectionString = input.environment.OTTO_REDIS_URL?.trim();
  if (!connectionString) {
    throw new Error(
      'OTTO_REDIS_URL is required for the Redis enterprise cache',
    );
  }
  parseRedisUrl(
    connectionString,
    parseBoolean(
      'OTTO_REDIS_ALLOW_INSECURE',
      input.environment.OTTO_REDIS_ALLOW_INSECURE,
    ),
  );
  return { backend: 'redis', connectionString };
}

export function resolveEnterpriseServiceTopology(input: {
  environment: EnterpriseServiceEnvironment;
  sqliteDatabasePath: string;
}): EnterpriseServiceTopology {
  const database = resolveEnterpriseDatabaseTopology(input);
  const clustered = database.backend === 'postgresql';
  const attachmentBackend = configuredBackend(
    input.environment.OTTO_ATTACHMENT_OBJECT_STORE,
    'local',
  );
  if (clustered && attachmentBackend !== 's3') {
    throw new Error(
      'PostgreSQL enterprise mode requires shared S3-compatible attachment storage',
    );
  }
  if (!clustered && attachmentBackend === 's3') {
    throw new Error(
      'SQLite local/offline mode requires local attachment storage',
    );
  }
  const attachments = resolveAttachmentObjectStoreConfig(input.environment);
  const cache = resolveEnterpriseSharedCacheConfig({
    environment: input.environment,
    requireShared: clustered,
  });
  if (!clustered && cache.backend !== 'memory') {
    throw new Error(
      'SQLite local/offline mode requires the process memory cache',
    );
  }
  return {
    mode: clustered ? 'clustered-enterprise' : 'local-offline',
    replicas: database.replicas,
    database,
    attachments,
    cache,
  };
}

function describeRedisTarget(connectionString: string): string {
  const parsed = parseRedisUrl(connectionString, true);
  const database = parsed.pathname.replace(/^\/+/, '');
  return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${
    database ? `/${database}` : ''
  }`;
}

export function describeEnterpriseServiceTopology(
  topology: EnterpriseServiceTopology,
) {
  return {
    mode: topology.mode,
    replicas: topology.replicas,
    database: describeEnterpriseDatabaseTopology(topology.database),
    attachments:
      topology.attachments.backend === 's3'
        ? { backend: 's3' as const, target: topology.attachments.bucket }
        : {
            backend: 'encrypted-filesystem' as const,
            target: path.basename(
              topology.database.backend === 'sqlite'
                ? path.dirname(topology.database.databasePath)
                : 'local',
            ),
          },
    cache:
      topology.cache.backend === 'redis'
        ? {
            backend: 'redis' as const,
            target: describeRedisTarget(topology.cache.connectionString),
          }
        : { backend: 'memory' as const },
  };
}
