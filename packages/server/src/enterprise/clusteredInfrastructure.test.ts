/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { createClusteredEnterpriseInfrastructure } from './clusteredInfrastructure.js';

const clusteredEnvironment = {
  OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
  OTTO_POSTGRES_URL: 'postgresql://otto:secret@db.internal/otto',
  OTTO_ENTERPRISE_CACHE_BACKEND: 'redis',
  OTTO_REDIS_URL: 'rediss://default:secret@cache.internal:6379',
  OTTO_ATTACHMENT_OBJECT_STORE: 's3',
  OTTO_S3_BUCKET: 'otto-private',
  OTTO_S3_REGION: 'us-east-1',
  OTTO_S3_BUCKET_PRIVATE_CONFIRMED: 'true',
} as const;

describe('clustered enterprise infrastructure configuration', () => {
  it('rejects a partial legacy dual-read configuration before opening clients', async () => {
    await expect(
      createClusteredEnterpriseInfrastructure({
        environment: {
          ...clusteredEnvironment,
          OTTO_ATTACHMENT_LEGACY_READ_DIR: 'D:\\legacy-attachments',
        },
      }),
    ).rejects.toThrow(/requires both/i);
  });

  it('forbids a local legacy fallback on a multi-replica deployment', async () => {
    await expect(
      createClusteredEnterpriseInfrastructure({
        environment: {
          ...clusteredEnvironment,
          OTTO_ENTERPRISE_REPLICA_COUNT: '2',
          OTTO_ATTACHMENT_LEGACY_READ_DIR: 'D:\\legacy-attachments',
          OTTO_ATTACHMENT_LEGACY_READ_KEY_FILE: 'D:\\keys\\attachment.key',
        },
      }),
    ).rejects.toThrow(/one migration-window replica/i);
  });

  it('rejects an attachment limit above the desktop E2EE protocol limit', async () => {
    await expect(
      createClusteredEnterpriseInfrastructure({
        environment: {
          ...clusteredEnvironment,
          OTTO_ATTACHMENT_MAX_BYTES: String(10 * 1024 * 1024 + 17),
        },
      }),
    ).rejects.toThrow(/E2EE protocol limit/i);
  });
});
