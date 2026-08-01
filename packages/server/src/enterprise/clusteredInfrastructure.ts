/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Production composition root for a stateless enterprise replica. All three
 * shared dependencies are mandatory and startup is fail-closed.
 */

import path from 'node:path';

import {
  buildNodePostgresPoolConfig,
  createAttachmentObjectStoreRuntime,
  createAttachmentStorageService,
  createClusteredEnterpriseInfrastructureRuntime,
  createNodePostgresPool,
  createNodeRedisEnterpriseSharedCache,
  createPostgresAttachmentMetadataRepository,
  createPostgresDatabaseLifecycle,
  describeEnterpriseServiceTopology,
  resolveEnterpriseServiceTopology,
  type ClusteredEnterpriseInfrastructureReadiness,
  type EnterpriseServiceEnvironment,
  type NodePostgresEnvironment,
  type NodeRedisEnvironment,
} from '../modules/data_platform/index.js';
import { E2EE_ATTACHMENT_MAX_CIPHERTEXT_BYTES } from '../modules/collaboration/index.js';
import { createPostgresEnterpriseCoreRepository } from './postgresCoreRepository.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from './postgresMigrations.js';
import { createClusteredEnterpriseSharedState } from './clusteredSharedState.js';

export type ClusteredEnterpriseEnvironment = EnterpriseServiceEnvironment &
  NodePostgresEnvironment &
  NodeRedisEnvironment & {
    OTTO_ENTERPRISE_DIR?: string;
    OTTO_ATTACHMENT_MAX_BYTES?: string;
    OTTO_ATTACHMENT_TENANT_QUOTA_BYTES?: string;
  };

function positiveIntegerSetting(input: {
  name: string;
  value: string | undefined;
  fallback: number;
}): number {
  if (!input.value?.trim()) return input.fallback;
  const value = Number(input.value);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${input.name} must be a positive safe integer`);
  }
  return value;
}

export async function createClusteredEnterpriseInfrastructure(input: {
  environment?: ClusteredEnterpriseEnvironment;
} = {}) {
  const environment = input.environment ?? process.env;
  const dataDirectory =
    environment.OTTO_ENTERPRISE_DIR?.trim() ||
    path.join(process.cwd(), '.otto-enterprise');
  const topology = resolveEnterpriseServiceTopology({
    environment,
    sqliteDatabasePath: path.join(dataDirectory, 'data.db'),
  });
  if (
    topology.mode !== 'clustered-enterprise' ||
    topology.database.backend !== 'postgresql' ||
    topology.cache.backend !== 'redis' ||
    topology.attachments.backend !== 's3'
  ) {
    throw new Error(
      'clustered enterprise server requires PostgreSQL, Redis, and S3',
    );
  }

  const maxAttachmentBytes = positiveIntegerSetting({
    name: 'OTTO_ATTACHMENT_MAX_BYTES',
    value: environment.OTTO_ATTACHMENT_MAX_BYTES,
    fallback: E2EE_ATTACHMENT_MAX_CIPHERTEXT_BYTES,
  });
  if (maxAttachmentBytes > E2EE_ATTACHMENT_MAX_CIPHERTEXT_BYTES) {
    throw new Error(
      `OTTO_ATTACHMENT_MAX_BYTES must not exceed the E2EE protocol limit (${E2EE_ATTACHMENT_MAX_CIPHERTEXT_BYTES})`,
    );
  }
  const defaultQuotaBytes = positiveIntegerSetting({
    name: 'OTTO_ATTACHMENT_TENANT_QUOTA_BYTES',
    value: environment.OTTO_ATTACHMENT_TENANT_QUOTA_BYTES,
    fallback: 100 * 1024 * 1024 * 1024,
  });
  if (defaultQuotaBytes < maxAttachmentBytes) {
    throw new Error(
      'OTTO_ATTACHMENT_TENANT_QUOTA_BYTES must be at least OTTO_ATTACHMENT_MAX_BYTES',
    );
  }

  const pool = createNodePostgresPool(
    buildNodePostgresPoolConfig({
      connectionString: topology.database.connectionString,
      environment,
    }),
  );
  const database = createPostgresDatabaseLifecycle({
    pool,
    migrations: ENTERPRISE_POSTGRES_MIGRATIONS,
  });
  const attachmentRuntime = createAttachmentObjectStoreRuntime({ environment });
  let cache: Awaited<
    ReturnType<typeof createNodeRedisEnterpriseSharedCache>
  > | null = null;
  let infrastructure: ReturnType<
    typeof createClusteredEnterpriseInfrastructureRuntime
  > | null = null;
  try {
    cache = await createNodeRedisEnterpriseSharedCache({
      connectionString: topology.cache.connectionString,
      environment,
    });
    infrastructure = createClusteredEnterpriseInfrastructureRuntime({
      database,
      cache,
      attachments: attachmentRuntime.store,
      closeAttachments: attachmentRuntime.close,
    });
    const initialReadiness = await infrastructure.initialize();
    const repository = createPostgresEnterpriseCoreRepository({ pool });
    const attachmentStorage = createAttachmentStorageService({
      metadata: createPostgresAttachmentMetadataRepository({
        pool,
        defaultQuotaBytes,
      }),
      stores: { s3: attachmentRuntime.store },
      primaryBackend: 's3',
      maxAttachmentBytes,
    });
    return {
      topology,
      topologyDescription: describeEnterpriseServiceTopology(topology),
      repository,
      cache,
      sharedState: createClusteredEnterpriseSharedState({ repository, cache }),
      attachmentStorage,
      attachmentStore: attachmentRuntime.store,
      initialReadiness,
      getReadiness: (): Promise<ClusteredEnterpriseInfrastructureReadiness> =>
        infrastructure!.getReadiness(),
      close: () => infrastructure!.close(),
    };
  } catch (error) {
    if (infrastructure) {
      await infrastructure.close();
    } else {
      await Promise.allSettled([
        database.close(),
        cache?.close(),
        Promise.resolve(attachmentRuntime.close()),
      ]);
    }
    throw error;
  }
}

export type ClusteredEnterpriseInfrastructure = Awaited<
  ReturnType<typeof createClusteredEnterpriseInfrastructure>
>;
