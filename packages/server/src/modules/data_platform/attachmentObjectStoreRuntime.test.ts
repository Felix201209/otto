/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { EncryptedObjectStore } from './encryptedObjectStore.js';
import {
  createAttachmentObjectStoreRuntime,
  resolveAttachmentObjectStoreConfig,
} from './attachmentObjectStoreRuntime.js';

const encryptedStore: EncryptedObjectStore = {
  backend: 'encrypted-filesystem',
  put: vi.fn(() => ({
    backend: 'encrypted-filesystem',
    key: `${'a'.repeat(2)}/${'b'.repeat(2)}/${'c'.repeat(64)}.otto-object`,
  })),
  read: vi.fn(() => Buffer.from('ciphertext')),
  markCommitted: vi.fn(),
  inspect: vi.fn(() => null),
  delete: vi.fn(),
  listKeys: vi.fn(() => []),
  sizeBytes: vi.fn(() => 0),
};

describe('attachment object-store runtime', () => {
  it('uses encrypted local storage by default for development and offline deployment', () => {
    const runtime = createAttachmentObjectStoreRuntime({
      environment: {},
      encryptedStore,
    });

    expect(runtime.config).toEqual({ backend: 'encrypted-filesystem' });
    expect(runtime.store.backend).toBe('encrypted-filesystem');
  });

  it('fails closed when an S3 bucket has not been confirmed private', () => {
    expect(() =>
      resolveAttachmentObjectStoreConfig({
        OTTO_ATTACHMENT_OBJECT_STORE: 's3',
        OTTO_S3_BUCKET: 'otto-private',
        OTTO_S3_REGION: 'us-east-1',
      }),
    ).toThrow(/private.*confirmed/i);
  });

  it('refuses local attachment storage for multiple server replicas', () => {
    expect(() =>
      resolveAttachmentObjectStoreConfig({
        OTTO_ATTACHMENT_OBJECT_STORE: 'local',
        OTTO_ENTERPRISE_REPLICA_COUNT: '2',
      }),
    ).toThrow(/local.*one.*replica/i);
  });

  it('configures an S3-compatible MinIO endpoint and optional SSE-KMS', () => {
    const clientFactory = vi.fn(() => ({
      send: vi.fn(async () => ({})),
    }));
    const runtime = createAttachmentObjectStoreRuntime({
      environment: {
        OTTO_ATTACHMENT_OBJECT_STORE: 's3',
        OTTO_S3_BUCKET: 'otto-private',
        OTTO_S3_REGION: 'us-east-1',
        OTTO_S3_ENDPOINT: 'https://minio.internal:9000',
        OTTO_S3_FORCE_PATH_STYLE: 'true',
        OTTO_S3_BUCKET_PRIVATE_CONFIRMED: 'true',
        OTTO_S3_KMS_KEY_ID: 'minio-kms-key',
        OTTO_S3_PRESIGN_TTL_SECONDS: '90',
      },
      encryptedStore,
      s3ClientFactory: clientFactory,
    });

    expect(clientFactory).toHaveBeenCalledWith({
      endpoint: 'https://minio.internal:9000/',
      forcePathStyle: true,
      region: 'us-east-1',
    });
    expect(runtime.config).toEqual({
      backend: 's3',
      bucket: 'otto-private',
      endpoint: 'https://minio.internal:9000/',
      forcePathStyle: true,
      kmsKeyId: 'minio-kms-key',
      presignTtlSeconds: 90,
      region: 'us-east-1',
    });
    expect(runtime.store.backend).toBe('s3');
  });

  it('rejects insecure object-store endpoints unless explicitly enabled', () => {
    expect(() =>
      resolveAttachmentObjectStoreConfig({
        OTTO_ATTACHMENT_OBJECT_STORE: 's3',
        OTTO_S3_BUCKET: 'otto-private',
        OTTO_S3_REGION: 'us-east-1',
        OTTO_S3_ENDPOINT: 'http://minio.internal:9000',
        OTTO_S3_BUCKET_PRIVATE_CONFIRMED: 'true',
      }),
    ).toThrow(/insecure.*explicitly enabled/i);
  });
});
