/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  describeEnterpriseServiceTopology,
  resolveEnterpriseServiceTopology,
} from './enterpriseServiceTopology.js';

describe('enterprise service topology', () => {
  it('keeps local SQLite, encrypted filesystem attachments, and memory cache for offline use', () => {
    const topology = resolveEnterpriseServiceTopology({
      environment: {},
      sqliteDatabasePath: '/var/lib/otto/data.db',
    });

    expect(topology).toEqual({
      mode: 'local-offline',
      replicas: 1,
      database: {
        backend: 'sqlite',
        databasePath: '/var/lib/otto/data.db',
        replicas: 1,
      },
      attachments: { backend: 'encrypted-filesystem' },
      cache: { backend: 'memory' },
    });
  });

  it('requires shared S3 attachment storage for PostgreSQL enterprise mode', () => {
    expect(() =>
      resolveEnterpriseServiceTopology({
        environment: {
          OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
          OTTO_POSTGRES_URL: 'postgresql://otto:secret@db.internal/otto',
          OTTO_ENTERPRISE_CACHE_BACKEND: 'redis',
          OTTO_REDIS_URL: 'rediss://default:secret@cache.internal:6379',
        },
        sqliteDatabasePath: '/var/lib/otto/data.db',
      }),
    ).toThrow(/PostgreSQL.*S3/i);
  });

  it('requires a shared Redis-compatible cache for PostgreSQL enterprise mode', () => {
    expect(() =>
      resolveEnterpriseServiceTopology({
        environment: {
          OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
          OTTO_POSTGRES_URL: 'postgresql://otto:secret@db.internal/otto',
          OTTO_ATTACHMENT_OBJECT_STORE: 's3',
          OTTO_S3_BUCKET: 'otto-private',
          OTTO_S3_REGION: 'cn-east-1',
          OTTO_S3_BUCKET_PRIVATE_CONFIRMED: 'true',
        },
        sqliteDatabasePath: '/var/lib/otto/data.db',
      }),
    ).toThrow(/PostgreSQL.*Redis/i);
  });

  it('rejects mixed local and clustered storage backends', () => {
    expect(() =>
      resolveEnterpriseServiceTopology({
        environment: {
          OTTO_ATTACHMENT_OBJECT_STORE: 's3',
          OTTO_S3_BUCKET: 'otto-private',
          OTTO_S3_REGION: 'cn-east-1',
          OTTO_S3_BUCKET_PRIVATE_CONFIRMED: 'true',
        },
        sqliteDatabasePath: '/var/lib/otto/data.db',
      }),
    ).toThrow(/SQLite.*local attachment/i);

    expect(() =>
      resolveEnterpriseServiceTopology({
        environment: {
          OTTO_ENTERPRISE_CACHE_BACKEND: 'redis',
          OTTO_REDIS_URL: 'rediss://cache.internal:6379',
        },
        sqliteDatabasePath: '/var/lib/otto/data.db',
      }),
    ).toThrow(/SQLite.*memory cache/i);
  });

  it('builds a credential-free stateless topology for multiple replicas', () => {
    const topology = resolveEnterpriseServiceTopology({
      environment: {
        OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
        OTTO_POSTGRES_URL: 'postgresql://otto:db-secret@db.internal:5432/otto',
        OTTO_ENTERPRISE_REPLICA_COUNT: '3',
        OTTO_ENTERPRISE_CACHE_BACKEND: 'redis',
        OTTO_REDIS_URL: 'rediss://default:cache-secret@cache.internal:6379/2',
        OTTO_ATTACHMENT_OBJECT_STORE: 's3',
        OTTO_S3_BUCKET: 'otto-private',
        OTTO_S3_REGION: 'cn-east-1',
        OTTO_S3_BUCKET_PRIVATE_CONFIRMED: 'true',
      },
      sqliteDatabasePath: '/var/lib/otto/data.db',
    });

    expect(topology.mode).toBe('clustered-enterprise');
    const description = describeEnterpriseServiceTopology(topology);
    expect(description).toEqual({
      mode: 'clustered-enterprise',
      replicas: 3,
      database: {
        backend: 'postgresql',
        replicas: 3,
        target: 'db.internal:5432/otto',
      },
      attachments: { backend: 's3', target: 'otto-private' },
      cache: { backend: 'redis', target: 'cache.internal:6379/2' },
    });
    expect(JSON.stringify(description)).not.toMatch(/secret|default@/i);
  });
});
