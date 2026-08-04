/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';

import type { EncryptedObjectStore } from './encryptedObjectStore.js';

export type AttachmentCiphertextEncryption =
  'e2ee-client-v1' | 'server-envelope-v1';
export type AttachmentObjectBackend = 'encrypted-filesystem' | 's3';

export interface AttachmentObjectLocation {
  backend: AttachmentObjectBackend;
  key: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  eTag?: string;
}

export interface AttachmentMultipartUpload {
  backend: AttachmentObjectBackend;
  key: string;
  uploadId: string;
}

export interface AttachmentMultipartPart {
  partNumber: number;
  eTag: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
}

export interface AttachmentPresignedRequest {
  method: 'GET' | 'PUT';
  url: string;
  expiresInSeconds: number;
  requiredHeaders: Readonly<Record<string, string>>;
}

export interface AttachmentObjectSummary {
  key: string;
  ciphertextBytes: number;
  lastModifiedAt: string | null;
}

export interface AttachmentObjectStore {
  readonly backend: AttachmentObjectBackend;
  readonly supportsPresignedUrls: boolean;
  readonly supportsMultipartUpload: boolean;
  putCiphertext(input: {
    ciphertext: Buffer;
    ciphertextSha256: string;
    encryption: AttachmentCiphertextEncryption;
  }): Promise<AttachmentObjectLocation>;
  getCiphertext(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<AttachmentObjectLocation>;
  createMultipartUpload(input: {
    ciphertextBytes: number;
    ciphertextSha256: string;
    encryption: AttachmentCiphertextEncryption;
  }): Promise<AttachmentMultipartUpload>;
  presignUploadPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    ciphertextBytes: number;
    ciphertextSha256: string;
  }): Promise<AttachmentPresignedRequest>;
  completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    ciphertextBytes: number;
    ciphertextSha256: string;
    parts: AttachmentMultipartPart[];
  }): Promise<AttachmentObjectLocation>;
  abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void>;
  presignDownload(input: {
    key: string;
    expiresInSeconds?: number;
  }): Promise<AttachmentPresignedRequest>;
  listObjects(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: AttachmentObjectSummary[]; cursor: string | null }>;
}

export class AttachmentObjectNotFoundError extends Error {
  constructor() {
    super('attachment object not found');
    this.name = 'AttachmentObjectNotFoundError';
  }
}

export class AttachmentObjectStoreUnsupportedError extends Error {
  constructor(capability: string) {
    super(`attachment object store does not support ${capability}`);
    this.name = 'AttachmentObjectStoreUnsupportedError';
  }
}

export function normalizeCiphertextSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('attachment ciphertext checksum is invalid');
  }
  return normalized;
}

export function ciphertextSha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function verifyCiphertext(input: {
  ciphertext: Uint8Array;
  ciphertextSha256: string;
}): string {
  if (input.ciphertext.byteLength <= 0) {
    throw new Error('attachment ciphertext is empty');
  }
  const expected = normalizeCiphertextSha256(input.ciphertextSha256);
  if (ciphertextSha256(input.ciphertext) !== expected) {
    throw new Error('attachment ciphertext checksum mismatch');
  }
  return expected;
}

export function createOpaqueAttachmentObjectKey(): string {
  const id = randomUUID().replaceAll('-', '');
  return `attachments/v1/${id.slice(0, 2)}/${id}.bin`;
}

function unsupported(capability: string): never {
  throw new AttachmentObjectStoreUnsupportedError(capability);
}

/** Adapts the existing encrypted filesystem store for desktop/offline use. */
export function createLocalAttachmentObjectStore(input: {
  encryptedStore: EncryptedObjectStore;
}): AttachmentObjectStore {
  return {
    backend: 'encrypted-filesystem',
    supportsPresignedUrls: false,
    supportsMultipartUpload: false,
    async putCiphertext({ ciphertext, ciphertextSha256: expected }) {
      const digest = verifyCiphertext({
        ciphertext,
        ciphertextSha256: expected,
      });
      const stored = input.encryptedStore.put({
        namespace: 'attachment-object-v1',
        objectId: randomUUID(),
        content: ciphertext,
      });
      return {
        backend: 'encrypted-filesystem',
        key: stored.key,
        ciphertextBytes: ciphertext.length,
        ciphertextSha256: digest,
      };
    },
    async getCiphertext(key) {
      try {
        return input.encryptedStore.read(key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new AttachmentObjectNotFoundError();
        }
        throw error;
      }
    },
    async deleteObject(key) {
      input.encryptedStore.delete(key);
    },
    async headObject(key) {
      const ciphertext = await this.getCiphertext(key);
      return {
        backend: 'encrypted-filesystem',
        key,
        ciphertextBytes: ciphertext.length,
        ciphertextSha256: ciphertextSha256(ciphertext),
      };
    },
    async createMultipartUpload() {
      return unsupported('multipart uploads');
    },
    async presignUploadPart() {
      return unsupported('presigned uploads');
    },
    async completeMultipartUpload() {
      return unsupported('multipart uploads');
    },
    async abortMultipartUpload() {
      return unsupported('multipart uploads');
    },
    async presignDownload() {
      return unsupported('presigned downloads');
    },
    async listObjects() {
      const objects = await Promise.all(
        input.encryptedStore.listKeys().map(async (key) => {
          const head = await this.headObject(key);
          return {
            key,
            ciphertextBytes: head.ciphertextBytes,
            lastModifiedAt: null,
          };
        }),
      );
      return { objects, cursor: null };
    },
  };
}
