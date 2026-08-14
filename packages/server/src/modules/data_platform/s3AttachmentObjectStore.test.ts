/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  createS3AttachmentObjectStore,
  type S3CommandClient,
} from './s3AttachmentObjectStore.js';

class FakeS3Client implements S3CommandClient {
  readonly commands: Array<{ name: string; input: Record<string, unknown> }> =
    [];
  content = Buffer.from('multipart ciphertext');

  async send(command: {
    constructor: { name: string };
    input?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const name = command.constructor.name;
    const input = command.input ?? {};
    this.commands.push({ name, input });
    if (name === 'CreateMultipartUploadCommand')
      return { UploadId: 'upload-1' };
    if (name === 'GetObjectCommand') {
      return {
        Body: {
          transformToByteArray: async () => this.content,
        },
      };
    }
    if (name === 'HeadObjectCommand') {
      return {
        ContentLength: this.content.length,
        Metadata: {
          'otto-sha256': createHash('sha256')
            .update(this.content)
            .digest('hex'),
          'otto-encryption': 'e2ee-client-v1',
        },
      };
    }
    return {};
  }
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('S3 AttachmentObjectStore', () => {
  it('uploads only opaque ciphertext objects and applies optional SSE-KMS', async () => {
    const client = new FakeS3Client();
    const store = createS3AttachmentObjectStore({
      client,
      bucket: 'private-attachments',
      kmsKeyId: 'arn:aws:kms:region:account:key/key-id',
      presign: vi.fn(),
    });
    const ciphertext = Buffer.from('e2ee ciphertext');

    const stored = await store.putCiphertext({
      ciphertext,
      ciphertextSha256: digest(ciphertext),
      encryption: 'e2ee-client-v1',
    });

    expect(stored.key).toMatch(
      /^attachments\/v1\/[0-9a-f]{2}\/[0-9a-f]{32}\.bin$/,
    );
    const put = client.commands.find(({ name }) => name === 'PutObjectCommand');
    expect(put?.input).toMatchObject({
      Bucket: 'private-attachments',
      Key: stored.key,
      Body: ciphertext,
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'arn:aws:kms:region:account:key/key-id',
      BucketKeyEnabled: true,
      Metadata: {
        'otto-sha256': digest(ciphertext),
        'otto-encryption': 'e2ee-client-v1',
      },
    });
    expect(JSON.stringify(put?.input)).not.toContain('organization');
    expect(JSON.stringify(put?.input)).not.toContain('filename');
    expect(JSON.stringify(put?.input)).not.toContain('public-read');
  });

  it('presigns bounded multipart parts and verifies the completed ciphertext', async () => {
    const client = new FakeS3Client();
    const presign = vi.fn(
      async (_client, command, options) =>
        `https://objects.invalid/${command.constructor.name}?ttl=${options.expiresIn}`,
    );
    const store = createS3AttachmentObjectStore({
      client,
      bucket: 'private-attachments',
      presign,
      presignTtlSeconds: 120,
    });
    const expectedSha256 = digest(client.content);
    const upload = await store.createMultipartUpload({
      ciphertextBytes: client.content.length,
      ciphertextSha256: expectedSha256,
      encryption: 'e2ee-client-v1',
    });
    const partChecksum = digest(client.content);
    const signed = await store.presignUploadPart({
      key: upload.key,
      uploadId: upload.uploadId,
      partNumber: 1,
      ciphertextBytes: client.content.length,
      ciphertextSha256: partChecksum,
    });

    expect(signed).toMatchObject({
      method: 'PUT',
      expiresInSeconds: 120,
      requiredHeaders: {
        'content-length': String(client.content.length),
        'x-amz-checksum-sha256': Buffer.from(partChecksum, 'hex').toString(
          'base64',
        ),
      },
    });
    await expect(
      store.completeMultipartUpload({
        key: upload.key,
        uploadId: upload.uploadId,
        ciphertextBytes: client.content.length,
        ciphertextSha256: expectedSha256,
        parts: [
          {
            partNumber: 1,
            eTag: 'etag-1',
            ciphertextBytes: client.content.length,
            ciphertextSha256: partChecksum,
          },
        ],
      }),
    ).resolves.toMatchObject({
      key: upload.key,
      ciphertextBytes: client.content.length,
      ciphertextSha256: expectedSha256,
    });
    expect(client.commands.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'CreateMultipartUploadCommand',
        'CompleteMultipartUploadCommand',
        'GetObjectCommand',
      ]),
    );
  });

  it('deletes a completed object when full ciphertext verification fails', async () => {
    const client = new FakeS3Client();
    const store = createS3AttachmentObjectStore({
      client,
      bucket: 'private-attachments',
      presign: vi.fn(),
    });
    const upload = await store.createMultipartUpload({
      ciphertextBytes: client.content.length,
      ciphertextSha256: 'f'.repeat(64),
      encryption: 'e2ee-client-v1',
    });

    await expect(
      store.completeMultipartUpload({
        key: upload.key,
        uploadId: upload.uploadId,
        ciphertextBytes: client.content.length,
        ciphertextSha256: 'f'.repeat(64),
        parts: [
          {
            partNumber: 1,
            eTag: 'etag-1',
            ciphertextBytes: client.content.length,
            ciphertextSha256: digest(client.content),
          },
        ],
      }),
    ).rejects.toThrow(/checksum/i);
    expect(client.commands.at(-1)?.name).toBe('DeleteObjectCommand');
  });
});
