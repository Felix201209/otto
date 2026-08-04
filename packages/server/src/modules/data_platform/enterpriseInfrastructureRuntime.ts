/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { AttachmentObjectStore } from './attachmentObjectStore.js';
import type {
  EnterpriseSharedCache,
  EnterpriseSharedCacheReadiness,
} from './enterpriseSharedCache.js';
import type { PostgresDatabaseReadiness } from './postgresDatabaseLifecycle.js';

export interface ClusteredEnterpriseDatabaseLifecycle {
  initialize(): Promise<PostgresDatabaseReadiness>;
  getReadiness(): Promise<PostgresDatabaseReadiness>;
  close(): Promise<void>;
}

export interface ClusteredEnterpriseInfrastructureReadiness {
  ready: true;
  database: PostgresDatabaseReadiness;
  cache: EnterpriseSharedCacheReadiness;
  attachments: { ready: true; backend: 's3' };
}

export interface ClusteredEnterpriseInfrastructureRuntime {
  initialize(): Promise<ClusteredEnterpriseInfrastructureReadiness>;
  getReadiness(): Promise<ClusteredEnterpriseInfrastructureReadiness>;
  close(): Promise<void>;
}

/**
 * Owns the shared dependencies required by a stateless Otto Server replica.
 * There is deliberately no local fallback in this runtime.
 */
export function createClusteredEnterpriseInfrastructureRuntime(input: {
  database: ClusteredEnterpriseDatabaseLifecycle;
  cache: EnterpriseSharedCache;
  attachments: AttachmentObjectStore;
  closeAttachments?: () => void | Promise<void>;
}): ClusteredEnterpriseInfrastructureRuntime {
  if (input.attachments.backend !== 's3') {
    throw new Error(
      'clustered enterprise infrastructure requires S3 attachments',
    );
  }
  let initialization: Promise<ClusteredEnterpriseInfrastructureReadiness> | null =
    null;
  let closed = false;

  async function probe(
    initializeDatabase: boolean,
  ): Promise<ClusteredEnterpriseInfrastructureReadiness> {
    if (closed)
      throw new Error('clustered enterprise infrastructure is closed');
    const [database, cache] = await Promise.all([
      initializeDatabase
        ? input.database.initialize()
        : input.database.getReadiness(),
      input.cache.healthCheck(),
      input.attachments.listObjects({ limit: 1 }),
    ]);
    return {
      ready: true,
      database,
      cache,
      attachments: { ready: true, backend: 's3' },
    };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await Promise.allSettled([
      input.database.close(),
      input.cache.close(),
      Promise.resolve(input.closeAttachments?.()),
    ]);
  }

  function initialize(): Promise<ClusteredEnterpriseInfrastructureReadiness> {
    initialization ??= probe(true).catch(async (error: unknown) => {
      await close();
      throw error;
    });
    return initialization;
  }

  return {
    initialize,
    getReadiness: () => probe(false),
    close,
  };
}
