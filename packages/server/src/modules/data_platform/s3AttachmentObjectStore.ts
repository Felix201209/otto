/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  AttachmentObjectNotFoundError,
  type AttachmentObjectStore,
  ciphertextSha256,
  createOpaqueAttachmentObjectKey,
  normalizeCiphertextSha256,
  verifyCiphertext,
} from './attachmentObjectStore.js';

export interface S3CommandClient {
  send(command: unknown): Promise<Record<string, unknown>>;
}

export type S3Presign = (
  client: S3CommandClient,
  command: unknown,
  options: { expiresIn: number },
) => Promise<string>;

function checksumBase64(checksum: string): string {
  return Buffer.from(normalizeCiphertextSha256(checksum), 'hex').toString(
    'base64',
  );
}

function assertPositiveBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('attachment ciphertext size is invalid');
  }
  return value;
}

function sseOptions(kmsKeyId: string | undefined): Record<string, unknown> {
  if (!kmsKeyId) return {};
  return {
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: kmsKeyId,
    BucketKeyEnabled: true,
  };
}

async function responseBodyBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (
    body &&
    typeof body === 'object' &&
    'transformToByteArray' in body &&
    typeof body.transformToByteArray === 'function'
  ) {
    return Buffer.from(await body.transformToByteArray());
  }
  if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('S3 attachment response body is unavailable');
}

function isMissingObject(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.name === 'NoSuchKey' ||
    candidate?.name === 'NotFound' ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}

function validateParts(
  parts: Array<{
    partNumber: number;
    eTag: string;
    ciphertextBytes: number;
    ciphertextSha256: string;
  }>,
  expectedBytes: number,
): void {
  if (parts.length === 0 || parts.length > 10_000) {
    throw new Error('attachment multipart parts are invalid');
  }
  let total = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.partNumber !== index + 1 || !part.eTag.trim()) {
      throw new Error('attachment multipart parts must be contiguous');
    }
    total += assertPositiveBytes(part.ciphertextBytes);
    normalizeCiphertextSha256(part.ciphertextSha256);
  }
  if (total !== expectedBytes) {
    throw new Error('attachment multipart size mismatch');
  }
}

/** S3-compatible attachment store for AWS S3, MinIO and cloud S3 APIs. */
export function createS3AttachmentObjectStore(input: {
  client: S3CommandClient;
  bucket: string;
  kmsKeyId?: string;
  presign?: S3Presign;
  presignTtlSeconds?: number;
}): AttachmentObjectStore {
  const bucket = input.bucket.trim();
  if (!bucket) throw new Error('S3 attachment bucket is required');
  const defaultTtl = input.presignTtlSeconds ?? 300;
  if (
    !Number.isSafeInteger(defaultTtl) ||
    defaultTtl < 30 ||
    defaultTtl > 900
  ) {
    throw new Error('S3 presigned URL TTL must be from 30 to 900 seconds');
  }
  const presign: S3Presign =
    input.presign ??
    ((client, command, options) =>
      getSignedUrl(client as unknown as S3Client, command as never, options));

  async function send(command: object): Promise<Record<string, unknown>> {
    return input.client.send(command);
  }

  async function getCiphertext(key: string): Promise<Buffer> {
    try {
      const response = await send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      return responseBodyBuffer(response.Body);
    } catch (error) {
      if (isMissingObject(error)) throw new AttachmentObjectNotFoundError();
      throw error;
    }
  }

  async function deleteObject(key: string): Promise<void> {
    await send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  return {
    backend: 's3',
    supportsPresignedUrls: true,
    supportsMultipartUpload: true,
    async putCiphertext({
      ciphertext,
      ciphertextSha256: expected,
      encryption,
    }) {
      const digest = verifyCiphertext({
        ciphertext,
        ciphertextSha256: expected,
      });
      const key = createOpaqueAttachmentObjectKey();
      const response = await send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: ciphertext,
          ContentLength: ciphertext.length,
          ContentType: 'application/octet-stream',
          ChecksumSHA256: checksumBase64(digest),
          Metadata: {
            'otto-sha256': digest,
            'otto-encryption': encryption,
          },
          ...sseOptions(input.kmsKeyId),
        }),
      );
      return {
        backend: 's3',
        key,
        ciphertextBytes: ciphertext.length,
        ciphertextSha256: digest,
        ...(typeof response.ETag === 'string' ? { eTag: response.ETag } : {}),
      };
    },
    getCiphertext,
    deleteObject,
    async headObject(key) {
      try {
        const response = await send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        const metadata = (response.Metadata ?? {}) as Record<string, string>;
        const digest = normalizeCiphertextSha256(metadata['otto-sha256'] ?? '');
        return {
          backend: 's3',
          key,
          ciphertextBytes: assertPositiveBytes(Number(response.ContentLength)),
          ciphertextSha256: digest,
          ...(typeof response.ETag === 'string' ? { eTag: response.ETag } : {}),
        };
      } catch (error) {
        if (isMissingObject(error)) throw new AttachmentObjectNotFoundError();
        throw error;
      }
    },
    async createMultipartUpload({
      ciphertextBytes,
      ciphertextSha256: expected,
      encryption,
    }) {
      assertPositiveBytes(ciphertextBytes);
      const digest = normalizeCiphertextSha256(expected);
      const key = createOpaqueAttachmentObjectKey();
      const response = await send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: 'application/octet-stream',
          ChecksumAlgorithm: 'SHA256',
          Metadata: {
            'otto-sha256': digest,
            'otto-encryption': encryption,
          },
          ...sseOptions(input.kmsKeyId),
        }),
      );
      if (typeof response.UploadId !== 'string' || !response.UploadId) {
        throw new Error('S3 did not return a multipart upload id');
      }
      return { backend: 's3', key, uploadId: response.UploadId };
    },
    async presignUploadPart({
      key,
      uploadId,
      partNumber,
      ciphertextBytes,
      ciphertextSha256: expected,
    }) {
      if (
        !Number.isSafeInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > 10_000
      ) {
        throw new Error('attachment part number is invalid');
      }
      const bytes = assertPositiveBytes(ciphertextBytes);
      const checksum = checksumBase64(expected);
      const command = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: bytes,
        ChecksumSHA256: checksum,
      });
      return {
        method: 'PUT',
        url: await presign(input.client, command, { expiresIn: defaultTtl }),
        expiresInSeconds: defaultTtl,
        requiredHeaders: {
          'content-length': String(bytes),
          'x-amz-checksum-sha256': checksum,
        },
      };
    },
    async completeMultipartUpload({
      key,
      uploadId,
      ciphertextBytes,
      ciphertextSha256: expected,
      parts,
    }) {
      const bytes = assertPositiveBytes(ciphertextBytes);
      const digest = normalizeCiphertextSha256(expected);
      validateParts(parts, bytes);
      await send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.eTag,
              ChecksumSHA256: checksumBase64(part.ciphertextSha256),
            })),
          },
        }),
      );
      try {
        const ciphertext = await getCiphertext(key);
        if (
          ciphertext.length !== bytes ||
          ciphertextSha256(ciphertext) !== digest
        ) {
          throw new Error(
            'attachment ciphertext checksum mismatch after upload',
          );
        }
      } catch (error) {
        try {
          await deleteObject(key);
        } catch {
          // Orphan cleanup retries deletion after the primary verification error.
        }
        throw error;
      }
      return {
        backend: 's3',
        key,
        ciphertextBytes: bytes,
        ciphertextSha256: digest,
      };
    },
    async abortMultipartUpload({ key, uploadId }) {
      await send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    },
    async presignDownload({ key, expiresInSeconds }) {
      const ttl = expiresInSeconds ?? defaultTtl;
      if (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > 900) {
        throw new Error('S3 presigned URL TTL must be from 30 to 900 seconds');
      }
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentType: 'application/octet-stream',
      });
      return {
        method: 'GET',
        url: await presign(input.client, command, { expiresIn: ttl }),
        expiresInSeconds: ttl,
        requiredHeaders: {},
      };
    },
    async listObjects({ cursor, limit } = {}) {
      const maximum = Math.min(1_000, Math.max(1, Math.floor(limit ?? 1_000)));
      const response = await send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: 'attachments/v1/',
          ContinuationToken: cursor,
          MaxKeys: maximum,
        }),
      );
      const contents = Array.isArray(response.Contents)
        ? response.Contents
        : [];
      return {
        objects: contents.flatMap((entry) => {
          const object = entry as {
            Key?: string;
            Size?: number;
            LastModified?: Date;
          };
          if (!object.Key) return [];
          return [
            {
              key: object.Key,
              ciphertextBytes: Number(object.Size ?? 0),
              lastModifiedAt: object.LastModified?.toISOString() ?? null,
            },
          ];
        }),
        cursor:
          typeof response.NextContinuationToken === 'string'
            ? response.NextContinuationToken
            : null,
      };
    },
  };
}
