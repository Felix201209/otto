/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { AttachmentObjectStore } from './attachmentObjectStore.js';
import type { EnterpriseSharedCache } from './enterpriseSharedCache.js';
import type { ClusteredEnterpriseDatabaseLifecycle } from './enterpriseInfrastructureRuntime.js';
import {
  checkClusteredEnterpriseInfrastructure,
  safeInfrastructureErrorMessage,
} from './enterpriseInfrastructureCli.js';

const environment = {
  OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
  OTTO_POSTGRES_URL: 'postgresql://otto:db-secret@db.internal:5432/otto',
  OTTO_ENTERPRISE_REPLICA_COUNT: '2',
  OTTO_ENTERPRISE_CACHE_BACKEND: 'redis',
  OTTO_REDIS_URL: 'rediss://default:cache-secret@cache.internal:6379/1',
  OTTO_ATTACHMENT_OBJECT_STORE: 's3',
  OTTO_S3_BUCKET: 'otto-private',
  OTTO_S3_REGION: 'cn-east-1',
  OTTO_S3_BUCKET_PRIVATE_CONFIRMED: 'true',
};

describe('enterprise infrastructure preflight', () => {
  it('checks shared dependencies and logs only credential-free topology', async () => {
    const database: ClusteredEnterpriseDatabaseLifecycle = {
      initialize: vi.fn(async () => ({
        ready: true,
        backend: 'postgresql',
        schemaVersion: 2,
        serverVersion: 170000,
        writable: true,
      })),
      getReadiness: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const cache = {
      backend: 'redis',
      healthCheck: vi.fn(async () => ({ ready: true, backend: 'redis' })),
      close: vi.fn(async () => undefined),
    } as unknown as EnterpriseSharedCache;
    const attachments = {
      backend: 's3',
      listObjects: vi.fn(async () => ({ objects: [], cursor: null })),
    } as unknown as AttachmentObjectStore;
    const closeAttachments = vi.fn();
    const log = vi.fn();

    await checkClusteredEnterpriseInfrastructure({
      environment,
      sqliteDatabasePath: '/unused/data.db',
      databaseFactory: vi.fn(() => database),
      cacheFactory: vi.fn(async () => cache),
      attachmentFactory: vi.fn(() => ({
        store: attachments,
        close: closeAttachments,
      })),
      log,
    });

    const output = log.mock.calls[0]?.[0] as string;
    expect(output).toContain('db.internal:5432/otto');
    expect(output).toContain('cache.internal:6379/1');
    expect(output).not.toMatch(/db-secret|cache-secret|default@/);
    expect(database.close).toHaveBeenCalledOnce();
    expect(cache.close).toHaveBeenCalledOnce();
    expect(closeAttachments).toHaveBeenCalledOnce();
  });

  it('redacts PostgreSQL and Redis credentials from failures', () => {
    expect(
      safeInfrastructureErrorMessage(
        new Error(
          `failed ${environment.OTTO_POSTGRES_URL} and ${environment.OTTO_REDIS_URL}`,
        ),
        environment,
      ),
    ).toBe('failed postgresql://[REDACTED] and redis://[REDACTED]');
  });
});
