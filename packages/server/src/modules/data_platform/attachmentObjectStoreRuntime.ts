/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

import {
  createLocalAttachmentObjectStore,
  type AttachmentObjectStore,
} from './attachmentObjectStore.js';
import type { EncryptedObjectStore } from './encryptedObjectStore.js';
import {
  createS3AttachmentObjectStore,
  type S3CommandClient,
} from './s3AttachmentObjectStore.js';

export interface AttachmentObjectStoreEnvironment {
  OTTO_ENTERPRISE_REPLICA_COUNT?: string;
  OTTO_ATTACHMENT_OBJECT_STORE?: string;
  OTTO_S3_BUCKET?: string;
  OTTO_S3_REGION?: string;
  OTTO_S3_ENDPOINT?: string;
  OTTO_S3_FORCE_PATH_STYLE?: string;
  OTTO_S3_BUCKET_PRIVATE_CONFIRMED?: string;
  OTTO_S3_ALLOW_INSECURE?: string;
  OTTO_S3_KMS_KEY_ID?: string;
  OTTO_S3_PRESIGN_TTL_SECONDS?: string;
}

export type AttachmentObjectStoreConfig =
  | { backend: 'encrypted-filesystem' }
  | {
      backend: 's3';
      bucket: string;
      region: string;
      endpoint?: string;
      forcePathStyle: boolean;
      kmsKeyId?: string;
      presignTtlSeconds: number;
    };

function booleanSetting(input: {
  name: string;
  value: string | undefined;
  fallback: boolean;
}): boolean {
  const normalized = input.value?.trim().toLowerCase();
  if (!normalized) return input.fallback;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${input.name} must be true or false`);
}

function boundedInteger(input: {
  name: string;
  value: string | undefined;
  fallback: number;
  minimum: number;
  maximum: number;
}): number {
  if (!input.value?.trim()) return input.fallback;
  const parsed = Number(input.value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < input.minimum ||
    parsed > input.maximum
  ) {
    throw new Error(
      `${input.name} must be an integer from ${input.minimum} to ${input.maximum}`,
    );
  }
  return parsed;
}

function endpointUrl(value: string | undefined, allowInsecure: boolean) {
  if (!value?.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('OTTO_S3_ENDPOINT must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('OTTO_S3_ENDPOINT must be a valid HTTP(S) URL');
  }
  if (parsed.username || parsed.password) {
    throw new Error('OTTO_S3_ENDPOINT must not contain credentials');
  }
  if (parsed.protocol === 'http:' && !allowInsecure) {
    throw new Error(
      'insecure S3 endpoint must be explicitly enabled with OTTO_S3_ALLOW_INSECURE=true',
    );
  }
  return parsed.toString();
}

export function resolveAttachmentObjectStoreConfig(
  environment: AttachmentObjectStoreEnvironment,
): AttachmentObjectStoreConfig {
  const configured =
    environment.OTTO_ATTACHMENT_OBJECT_STORE?.trim().toLowerCase() || 'local';
  const replicas = boundedInteger({
    name: 'OTTO_ENTERPRISE_REPLICA_COUNT',
    value: environment.OTTO_ENTERPRISE_REPLICA_COUNT,
    fallback: 1,
    minimum: 1,
    maximum: 1_000,
  });
  if (['local', 'encrypted-filesystem'].includes(configured)) {
    if (replicas !== 1) {
      throw new Error(
        'local attachment storage supports one Otto Server replica; use S3 for multiple replicas',
      );
    }
    return { backend: 'encrypted-filesystem' };
  }
  if (configured !== 's3') {
    throw new Error('OTTO_ATTACHMENT_OBJECT_STORE must be local or s3');
  }

  const privateBucketConfirmed = booleanSetting({
    name: 'OTTO_S3_BUCKET_PRIVATE_CONFIRMED',
    value: environment.OTTO_S3_BUCKET_PRIVATE_CONFIRMED,
    fallback: false,
  });
  if (!privateBucketConfirmed) {
    throw new Error(
      'S3 attachment bucket must be private and OTTO_S3_BUCKET_PRIVATE_CONFIRMED=true must be set',
    );
  }
  const bucket = environment.OTTO_S3_BUCKET?.trim() ?? '';
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('OTTO_S3_BUCKET must be a valid private bucket name');
  }
  const region = environment.OTTO_S3_REGION?.trim() ?? '';
  if (!region || region.length > 100 || /\s/.test(region)) {
    throw new Error('OTTO_S3_REGION is required for S3 attachment storage');
  }
  const allowInsecure = booleanSetting({
    name: 'OTTO_S3_ALLOW_INSECURE',
    value: environment.OTTO_S3_ALLOW_INSECURE,
    fallback: false,
  });
  const endpoint = endpointUrl(environment.OTTO_S3_ENDPOINT, allowInsecure);
  const forcePathStyle = booleanSetting({
    name: 'OTTO_S3_FORCE_PATH_STYLE',
    value: environment.OTTO_S3_FORCE_PATH_STYLE,
    fallback: false,
  });
  const presignTtlSeconds = boundedInteger({
    name: 'OTTO_S3_PRESIGN_TTL_SECONDS',
    value: environment.OTTO_S3_PRESIGN_TTL_SECONDS,
    fallback: 300,
    minimum: 30,
    maximum: 900,
  });
  const kmsKeyId = environment.OTTO_S3_KMS_KEY_ID?.trim() || undefined;
  return {
    backend: 's3',
    bucket,
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle,
    ...(kmsKeyId ? { kmsKeyId } : {}),
    presignTtlSeconds,
  };
}

export function createAttachmentObjectStoreRuntime(input: {
  environment?: AttachmentObjectStoreEnvironment;
  encryptedStore?: EncryptedObjectStore;
  s3ClientFactory?: (config: S3ClientConfig) => S3CommandClient;
}): { config: AttachmentObjectStoreConfig; store: AttachmentObjectStore } {
  const config = resolveAttachmentObjectStoreConfig(
    input.environment ?? process.env,
  );
  if (config.backend === 'encrypted-filesystem') {
    if (!input.encryptedStore) {
      throw new Error('encrypted local attachment store is required');
    }
    return {
      config,
      store: createLocalAttachmentObjectStore({
        encryptedStore: input.encryptedStore,
      }),
    };
  }

  const clientConfig: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  };
  const client = input.s3ClientFactory
    ? input.s3ClientFactory(clientConfig)
    : (new S3Client(clientConfig) as unknown as S3CommandClient);
  return {
    config,
    store: createS3AttachmentObjectStore({
      client,
      bucket: config.bucket,
      kmsKeyId: config.kmsKeyId,
      presignTtlSeconds: config.presignTtlSeconds,
    }),
  };
}
