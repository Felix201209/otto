/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { AttachmentObjectStore } from './attachmentObjectStore.js';
import type { EnterpriseSharedCache } from './enterpriseSharedCache.js';
import {
  createClusteredEnterpriseInfrastructureRuntime,
  type ClusteredEnterpriseDatabaseLifecycle,
} from './enterpriseInfrastructureRuntime.js';

function dependencies() {
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
  const cache: EnterpriseSharedCache = {
    backend: 'redis',
    healthCheck: vi.fn(async () => ({ ready: true, backend: 'redis' })),
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    acquireLease: vi.fn(),
    releaseLease: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const attachments = {
    backend: 's3',
    listObjects: vi.fn(async () => ({ objects: [], cursor: null })),
  } as unknown as AttachmentObjectStore;
  const closeAttachments = vi.fn();
  return { database, cache, attachments, closeAttachments };
}

describe('clustered enterprise infrastructure runtime', () => {
  it('reports ready only after PostgreSQL, Redis, and S3 probes pass', async () => {
    const deps = dependencies();
    const runtime = createClusteredEnterpriseInfrastructureRuntime(deps);

    await expect(runtime.initialize()).resolves.toEqual({
      ready: true,
      database: {
        ready: true,
        backend: 'postgresql',
        schemaVersion: 2,
        serverVersion: 170000,
        writable: true,
      },
      cache: { ready: true, backend: 'redis' },
      attachments: { ready: true, backend: 's3' },
    });
    expect(deps.attachments.listObjects).toHaveBeenCalledWith({ limit: 1 });
  });

  it('closes every opened dependency when a required probe fails', async () => {
    const deps = dependencies();
    vi.mocked(deps.cache.healthCheck).mockRejectedValueOnce(
      new Error('redis unavailable'),
    );
    const runtime = createClusteredEnterpriseInfrastructureRuntime(deps);

    await expect(runtime.initialize()).rejects.toThrow('redis unavailable');
    expect(deps.database.close).toHaveBeenCalledOnce();
    expect(deps.cache.close).toHaveBeenCalledOnce();
    expect(deps.closeAttachments).toHaveBeenCalledOnce();
  });
});
