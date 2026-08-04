/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  AttachmentObjectNotFoundError,
  type AttachmentCiphertextEncryption,
  type AttachmentMultipartPart,
  type AttachmentObjectBackend,
  type AttachmentObjectLocation,
  type AttachmentObjectStore,
  type AttachmentPresignedRequest,
  normalizeCiphertextSha256,
  verifyCiphertext,
} from './attachmentObjectStore.js';

export interface AttachmentStoragePointer {
  backend: AttachmentObjectBackend;
  key: string;
}

export type AttachmentMetadataState =
  'reserved' | 'uploading' | 'verifying' | 'cleaning' | 'available' | 'failed';

export interface AttachmentMetadataRecord {
  id: string;
  organizationId: string;
  ownerAccountId: string;
  state: AttachmentMetadataState;
  encryption: AttachmentCiphertextEncryption;
  ciphertextBytes: number;
  ciphertextSha256: string;
  location: AttachmentStoragePointer | null;
  legacyLocation: AttachmentStoragePointer | null;
  uploadId: string | null;
  expiresAt: string;
  legacyDeleteAfter: string | null;
  legalHold: boolean;
}

export interface AttachmentMetadataRepository {
  /** Must reserve tenant quota atomically with creation of the metadata row. */
  reserveUpload(input: {
    attachmentId: string;
    organizationId: string;
    accountId: string;
    authorizedAccountIds: string[];
    encryption: AttachmentCiphertextEncryption;
    ciphertextBytes: number;
    ciphertextSha256: string;
    expiresAt: string;
  }): Promise<AttachmentMetadataRecord>;
  attachMultipartUpload(input: {
    attachmentId: string;
    location: AttachmentStoragePointer;
    uploadId: string;
  }): Promise<AttachmentMetadataRecord>;
  recordMultipartParts(input: {
    attachmentId: string;
    parts: AttachmentMultipartPart[];
  }): Promise<void>;
  replaceMultipartVerificationParts(input: {
    attachmentId: string;
    parts: AttachmentMultipartPart[];
  }): Promise<void>;
  listMultipartParts(input: {
    attachmentId: string;
  }): Promise<AttachmentMultipartPart[]>;
  /** Atomically prevents completion and expiry workers from racing. */
  claimMultipartVerification(input: {
    attachmentId: string;
    leaseExpiresAt: string;
  }): Promise<AttachmentMetadataRecord | null>;
  /** Authorization is a metadata query, never an object-key prefix check. */
  getAuthorizedAttachment(input: {
    attachmentId: string;
    organizationId: string;
    accountId: string;
  }): Promise<AttachmentMetadataRecord | null>;
  markAvailable(input: {
    attachmentId: string;
    location: AttachmentStoragePointer;
  }): Promise<AttachmentMetadataRecord>;
  markFailed(input: {
    attachmentId: string;
    failureCode: string;
  }): Promise<void>;
  listExpiredUploads(input: {
    before: string;
    limit: number;
  }): Promise<AttachmentMetadataRecord[]>;
  claimExpiredUpload(input: {
    attachmentId: string;
    before: string;
  }): Promise<AttachmentMetadataRecord | null>;
  isStorageKeyReferenced(input: {
    backend: AttachmentObjectBackend;
    key: string;
  }): Promise<boolean>;
  claimMigration(input: {
    attachmentId: string;
    targetBackend: AttachmentObjectBackend;
  }): Promise<AttachmentMetadataRecord | null>;
  completeMigration(input: {
    attachmentId: string;
    location: AttachmentStoragePointer;
    legacyLocation: AttachmentStoragePointer;
    legacyDeleteAfter: string;
  }): Promise<void>;
  failMigration(input: {
    attachmentId: string;
    failureCode: string;
  }): Promise<void>;
  listLegacyPurgeCandidates(input: {
    before: string;
    limit: number;
  }): Promise<AttachmentMetadataRecord[]>;
  claimLegacyPurge(input: {
    attachmentId: string;
    before: string;
  }): Promise<AttachmentMetadataRecord | null>;
  clearLegacyLocation(input: { attachmentId: string }): Promise<void>;
}

export class AttachmentAccessDeniedError extends Error {
  constructor() {
    super('attachment access denied');
    this.name = 'AttachmentAccessDeniedError';
  }
}

function validateAttachmentId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)) {
    throw new Error('attachment id is invalid');
  }
  return normalized;
}

function validateSize(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error('attachment ciphertext size exceeds the configured limit');
  }
  return value;
}

function validateMultipartParts(
  parts: AttachmentMultipartPart[],
  expectedBytes: number,
): AttachmentMultipartPart[] {
  if (parts.length === 0 || parts.length > 10_000) {
    throw new Error('attachment multipart parts are invalid');
  }
  let total = 0;
  const normalized = parts.map((part, index) => {
    if (
      part.partNumber !== index + 1 ||
      !part.eTag.trim() ||
      part.eTag.length > 512
    ) {
      throw new Error('attachment multipart parts must be contiguous');
    }
    const ciphertextBytes = validateSize(part.ciphertextBytes, expectedBytes);
    total += ciphertextBytes;
    return {
      ...part,
      eTag: part.eTag.trim(),
      ciphertextBytes,
      ciphertextSha256: normalizeCiphertextSha256(part.ciphertextSha256),
    };
  });
  if (total !== expectedBytes) {
    throw new Error('attachment multipart size mismatch');
  }
  return normalized;
}

export function createAttachmentStorageService(input: {
  metadata: AttachmentMetadataRepository;
  stores: Partial<Record<AttachmentObjectBackend, AttachmentObjectStore>>;
  primaryBackend: AttachmentObjectBackend;
  maxAttachmentBytes: number;
  migrationGraceMs?: number;
  orphanGraceMs?: number;
  verificationLeaseMs?: number;
  uploadLifetimeMs?: number;
  clock?: () => Date;
}) {
  const migrationGraceMs = input.migrationGraceMs ?? 7 * 24 * 60 * 60 * 1_000;
  const orphanGraceMs = input.orphanGraceMs ?? 24 * 60 * 60 * 1_000;
  const verificationLeaseMs = input.verificationLeaseMs ?? 15 * 60 * 1_000;
  const uploadLifetimeMs = input.uploadLifetimeMs ?? 60 * 60 * 1_000;
  if (
    !Number.isSafeInteger(input.maxAttachmentBytes) ||
    input.maxAttachmentBytes <= 0
  ) {
    throw new Error('maximum attachment size is invalid');
  }
  if (migrationGraceMs < 60_000 || orphanGraceMs < 60_000) {
    throw new Error('attachment cleanup grace period is too short');
  }
  if (verificationLeaseMs < 60_000 || verificationLeaseMs > 60 * 60 * 1_000) {
    throw new Error('attachment verification lease is invalid');
  }
  if (
    uploadLifetimeMs < 5 * 60 * 1_000 ||
    uploadLifetimeMs > 24 * 60 * 60 * 1_000
  ) {
    throw new Error('attachment upload lifetime is invalid');
  }

  function now(): Date {
    const current = input.clock?.() ?? new Date();
    if (!Number.isFinite(current.getTime())) {
      throw new Error('attachment storage clock is invalid');
    }
    return current;
  }

  function storeFor(backend: AttachmentObjectBackend): AttachmentObjectStore {
    const store = input.stores[backend];
    if (!store || store.backend !== backend) {
      throw new Error(`attachment object store ${backend} is unavailable`);
    }
    return store;
  }

  function assertActiveUpload(
    metadata: AttachmentMetadataRecord,
  ): asserts metadata is AttachmentMetadataRecord & {
    state: 'uploading';
    location: AttachmentStoragePointer;
    uploadId: string;
  } {
    const expiry = new Date(metadata.expiresAt).getTime();
    if (
      metadata.state !== 'uploading' ||
      !metadata.location ||
      !metadata.uploadId ||
      !Number.isFinite(expiry) ||
      expiry <= now().getTime()
    ) {
      throw new Error('attachment upload is not active');
    }
  }

  async function authorized(inputRecord: {
    attachmentId: string;
    organizationId: string;
    accountId: string;
  }): Promise<AttachmentMetadataRecord> {
    const attachmentId = validateAttachmentId(inputRecord.attachmentId);
    const result = await input.metadata.getAuthorizedAttachment({
      ...inputRecord,
      attachmentId,
    });
    if (!result || result.organizationId !== inputRecord.organizationId) {
      throw new AttachmentAccessDeniedError();
    }
    return result;
  }

  async function reserve(inputRecord: {
    organizationId: string;
    accountId: string;
    attachmentId: string;
    ciphertextBytes: number;
    ciphertextSha256: string;
    encryption: AttachmentCiphertextEncryption;
    authorizedAccountIds?: string[];
  }): Promise<AttachmentMetadataRecord> {
    const attachmentId = validateAttachmentId(inputRecord.attachmentId);
    const ciphertextBytes = validateSize(
      inputRecord.ciphertextBytes,
      input.maxAttachmentBytes,
    );
    const ciphertextSha256 = normalizeCiphertextSha256(
      inputRecord.ciphertextSha256,
    );
    const expiresAt = new Date(
      now().getTime() + uploadLifetimeMs,
    ).toISOString();
    const authorizedAccountIds = [
      ...new Set([
        inputRecord.accountId,
        ...(inputRecord.authorizedAccountIds ?? []),
      ]),
    ];
    if (
      authorizedAccountIds.length > 32 ||
      authorizedAccountIds.some(
        (accountId) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(accountId),
      )
    ) {
      throw new Error('attachment authorized accounts are invalid');
    }
    return input.metadata.reserveUpload({
      ...inputRecord,
      attachmentId,
      ciphertextBytes,
      ciphertextSha256,
      authorizedAccountIds,
      expiresAt,
    });
  }

  async function initiateMultipartUpload(inputRecord: {
    organizationId: string;
    accountId: string;
    attachmentId: string;
    ciphertextBytes: number;
    ciphertextSha256: string;
    encryption: AttachmentCiphertextEncryption;
    authorizedAccountIds?: string[];
  }) {
    const metadata = await reserve(inputRecord);
    const store = storeFor(input.primaryBackend);
    if (!store.supportsMultipartUpload) {
      await input.metadata.markFailed({
        attachmentId: metadata.id,
        failureCode: 'multipart_not_supported',
      });
      throw new Error(
        'primary attachment store does not support multipart uploads',
      );
    }
    let upload: { key: string; uploadId: string } | null = null;
    try {
      upload = await store.createMultipartUpload({
        ciphertextBytes: metadata.ciphertextBytes,
        ciphertextSha256: metadata.ciphertextSha256,
        encryption: metadata.encryption,
      });
      await input.metadata.attachMultipartUpload({
        attachmentId: metadata.id,
        location: { backend: store.backend, key: upload.key },
        uploadId: upload.uploadId,
      });
      return { attachmentId: metadata.id, ...upload };
    } catch (error) {
      if (upload) {
        try {
          await store.abortMultipartUpload(upload);
        } catch {
          // Expired multipart cleanup will retry.
        }
      }
      await input.metadata.markFailed({
        attachmentId: metadata.id,
        failureCode: 'upload_initialization_failed',
      });
      throw error;
    }
  }

  async function putInlineCiphertext(inputRecord: {
    organizationId: string;
    accountId: string;
    attachmentId: string;
    ciphertext: Buffer;
    ciphertextSha256: string;
    encryption: AttachmentCiphertextEncryption;
    authorizedAccountIds?: string[];
  }): Promise<AttachmentMetadataRecord> {
    verifyCiphertext(inputRecord);
    const metadata = await reserve({
      ...inputRecord,
      ciphertextBytes: inputRecord.ciphertext.length,
    });
    const store = storeFor(input.primaryBackend);
    let location: AttachmentObjectLocation | null = null;
    try {
      location = await store.putCiphertext(inputRecord);
      return await input.metadata.markAvailable({
        attachmentId: metadata.id,
        location: { backend: location.backend, key: location.key },
      });
    } catch (error) {
      if (location) {
        try {
          await store.deleteObject(location.key);
        } catch {
          // Orphan cleanup will retry.
        }
      }
      await input.metadata.markFailed({
        attachmentId: metadata.id,
        failureCode: 'inline_upload_failed',
      });
      throw error;
    }
  }

  async function presignUploadPart(inputRecord: {
    organizationId: string;
    accountId: string;
    attachmentId: string;
    partNumber: number;
    ciphertextBytes: number;
    ciphertextSha256: string;
  }): Promise<AttachmentPresignedRequest> {
    const metadata = await authorized(inputRecord);
    assertActiveUpload(metadata);
    validateSize(inputRecord.ciphertextBytes, metadata.ciphertextBytes);
    return storeFor(metadata.location.backend).presignUploadPart({
      key: metadata.location.key,
      uploadId: metadata.uploadId,
      partNumber: inputRecord.partNumber,
      ciphertextBytes: inputRecord.ciphertextBytes,
      ciphertextSha256: normalizeCiphertextSha256(inputRecord.ciphertextSha256),
    });
  }

  async function completeMultipartUpload(inputRecord: {
    organizationId: string;
    accountId: string;
    attachmentId: string;
    parts: AttachmentMultipartPart[];
  }): Promise<AttachmentMetadataRecord> {
    const metadata = await authorized(inputRecord);
    assertActiveUpload(metadata);
    const requestedParts = validateMultipartParts(
      inputRecord.parts,
      metadata.ciphertextBytes,
    );
    const verification = await input.metadata.claimMultipartVerification({
      attachmentId: metadata.id,
      leaseExpiresAt: new Date(
        now().getTime() + verificationLeaseMs,
      ).toISOString(),
    });
    if (!verification?.location || !verification.uploadId) {
      throw new Error('attachment upload could not enter verification');
    }
    const store = storeFor(verification.location.backend);
    try {
      await input.metadata.replaceMultipartVerificationParts({
        attachmentId: metadata.id,
        parts: requestedParts,
      });
      const persistedParts = validateMultipartParts(
        await input.metadata.listMultipartParts({ attachmentId: metadata.id }),
        metadata.ciphertextBytes,
      );
      const location = await store.completeMultipartUpload({
        key: verification.location.key,
        uploadId: verification.uploadId,
        ciphertextBytes: verification.ciphertextBytes,
        ciphertextSha256: verification.ciphertextSha256,
        parts: persistedParts,
      });
      return await input.metadata.markAvailable({
        attachmentId: metadata.id,
        location: { backend: location.backend, key: location.key },
      });
    } catch (error) {
      try {
        await store.abortMultipartUpload({
          key: verification.location.key,
          uploadId: verification.uploadId,
        });
      } catch {
        // S3 rejects abort after completion; deleting the object is authoritative.
      }
      try {
        await store.deleteObject(verification.location.key);
      } catch {
        // Orphan cleanup will retry.
      }
      await input.metadata.markFailed({
        attachmentId: metadata.id,
        failureCode: 'upload_completion_failed',
      });
      throw error;
    }
  }

  async function recordUploadedPart(inputRecord: {
    organizationId: string;
    accountId: string;
    attachmentId: string;
    part: AttachmentMultipartPart;
  }): Promise<void> {
    const metadata = await authorized(inputRecord);
    assertActiveUpload(metadata);
    const { part } = inputRecord;
    if (
      !Number.isSafeInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > 10_000 ||
      !part.eTag.trim() ||
      part.eTag.length > 512
    ) {
      throw new Error('attachment multipart part is invalid');
    }
    await input.metadata.recordMultipartParts({
      attachmentId: metadata.id,
      parts: [
        {
          ...part,
          eTag: part.eTag.trim(),
          ciphertextBytes: validateSize(
            part.ciphertextBytes,
            metadata.ciphertextBytes,
          ),
          ciphertextSha256: normalizeCiphertextSha256(part.ciphertextSha256),
        },
      ],
    });
  }

  async function resumeMultipartUpload(inputRecord: {
    organizationId: string;
    accountId: string;
    attachmentId: string;
  }) {
    const metadata = await authorized(inputRecord);
    assertActiveUpload(metadata);
    return {
      attachmentId: metadata.id,
      ciphertextBytes: metadata.ciphertextBytes,
      ciphertextSha256: metadata.ciphertextSha256,
      parts: await input.metadata.listMultipartParts({
        attachmentId: metadata.id,
      }),
    };
  }

  async function readLocation(
    location: AttachmentStoragePointer,
    expected: { ciphertextBytes: number; ciphertextSha256: string },
  ): Promise<
    | { kind: 'ciphertext'; ciphertext: Buffer }
    | {
        kind: 'presigned';
        request: AttachmentPresignedRequest;
      }
  > {
    const store = storeFor(location.backend);
    const actual = await store.headObject(location.key);
    if (
      actual.ciphertextBytes !== expected.ciphertextBytes ||
      actual.ciphertextSha256 !== expected.ciphertextSha256
    ) {
      throw new Error('attachment object metadata integrity check failed');
    }
    if (store.supportsPresignedUrls) {
      return {
        kind: 'presigned',
        request: await store.presignDownload({ key: location.key }),
      };
    }
    return {
      kind: 'ciphertext',
      ciphertext: await store.getCiphertext(location.key),
    };
  }

  async function download(inputRecord: {
    organizationId: string;
    accountId: string;
    attachmentId: string;
  }) {
    const metadata = await authorized(inputRecord);
    if (metadata.state !== 'available' || !metadata.location) {
      throw new Error('attachment is not available');
    }
    try {
      const result = await readLocation(metadata.location, metadata);
      return {
        ...result,
        ciphertextBytes: metadata.ciphertextBytes,
        ciphertextSha256: metadata.ciphertextSha256,
        encryption: metadata.encryption,
      };
    } catch (error) {
      if (
        !(error instanceof AttachmentObjectNotFoundError) ||
        !metadata.legacyLocation
      ) {
        throw error;
      }
      const result = await readLocation(metadata.legacyLocation, metadata);
      return {
        ...result,
        ciphertextBytes: metadata.ciphertextBytes,
        ciphertextSha256: metadata.ciphertextSha256,
        encryption: metadata.encryption,
      };
    }
  }

  async function migrateAttachment(inputRecord: {
    attachmentId: string;
    now?: Date;
  }): Promise<boolean> {
    const metadata = await input.metadata.claimMigration({
      attachmentId: validateAttachmentId(inputRecord.attachmentId),
      targetBackend: input.primaryBackend,
    });
    if (
      !metadata?.location ||
      metadata.location.backend === input.primaryBackend
    ) {
      return false;
    }
    const source = storeFor(metadata.location.backend);
    const target = storeFor(input.primaryBackend);
    let uploaded: AttachmentObjectLocation | null = null;
    try {
      const ciphertext = await source.getCiphertext(metadata.location.key);
      verifyCiphertext({
        ciphertext,
        ciphertextSha256: metadata.ciphertextSha256,
      });
      if (ciphertext.length !== metadata.ciphertextBytes) {
        throw new Error('attachment migration size mismatch');
      }
      uploaded = await target.putCiphertext({
        ciphertext,
        ciphertextSha256: metadata.ciphertextSha256,
        encryption: metadata.encryption,
      });
      const verified = await target.headObject(uploaded.key);
      if (
        verified.ciphertextBytes !== metadata.ciphertextBytes ||
        verified.ciphertextSha256 !== metadata.ciphertextSha256
      ) {
        throw new Error('attachment migration verification failed');
      }
      const targetCiphertext = await target.getCiphertext(uploaded.key);
      verifyCiphertext({
        ciphertext: targetCiphertext,
        ciphertextSha256: metadata.ciphertextSha256,
      });
      if (targetCiphertext.length !== metadata.ciphertextBytes) {
        throw new Error('attachment migration target size mismatch');
      }
      const migrationTime = inputRecord.now ?? now();
      await input.metadata.completeMigration({
        attachmentId: metadata.id,
        location: { backend: uploaded.backend, key: uploaded.key },
        legacyLocation: metadata.location,
        legacyDeleteAfter: new Date(
          migrationTime.getTime() + migrationGraceMs,
        ).toISOString(),
      });
      return true;
    } catch (error) {
      if (uploaded) {
        try {
          await target.deleteObject(uploaded.key);
        } catch {
          // Orphan cleanup will retry.
        }
      }
      await input.metadata.failMigration({
        attachmentId: metadata.id,
        failureCode: 'migration_failed',
      });
      throw error;
    }
  }

  async function sweepExpiredUploads(inputRecord: {
    now?: Date;
    limit?: number;
  }): Promise<number> {
    const before = (inputRecord.now ?? now()).toISOString();
    const expired = await input.metadata.listExpiredUploads({
      before,
      limit: Math.min(1_000, Math.max(1, inputRecord.limit ?? 100)),
    });
    let cleaned = 0;
    for (const candidate of expired) {
      const metadata = await input.metadata.claimExpiredUpload({
        attachmentId: candidate.id,
        before,
      });
      if (!metadata || metadata.legalHold) continue;
      if (metadata.location) {
        const store = storeFor(metadata.location.backend);
        if (metadata.uploadId) {
          try {
            await store.abortMultipartUpload({
              key: metadata.location.key,
              uploadId: metadata.uploadId,
            });
          } catch {
            // Continue with idempotent object deletion.
          }
        }
        await store.deleteObject(metadata.location.key);
      }
      await input.metadata.markFailed({
        attachmentId: metadata.id,
        failureCode: 'upload_expired',
      });
      cleaned += 1;
    }
    return cleaned;
  }

  async function sweepOrphans(inputRecord: {
    backend: AttachmentObjectBackend;
    now?: Date;
    limit?: number;
    cursor?: string;
  }): Promise<{ deleted: number; nextCursor: string | null }> {
    const store = storeFor(inputRecord.backend);
    const cutoff = (inputRecord.now ?? now()).getTime() - orphanGraceMs;
    const listed = await store.listObjects({
      cursor: inputRecord.cursor,
      limit: Math.min(1_000, Math.max(1, inputRecord.limit ?? 100)),
    });
    let deleted = 0;
    for (const object of listed.objects) {
      if (
        !object.lastModifiedAt ||
        new Date(object.lastModifiedAt).getTime() > cutoff ||
        (await input.metadata.isStorageKeyReferenced({
          backend: store.backend,
          key: object.key,
        }))
      ) {
        continue;
      }
      await store.deleteObject(object.key);
      deleted += 1;
    }
    return { deleted, nextCursor: listed.cursor };
  }

  async function purgeMigratedLegacy(inputRecord: {
    now?: Date;
    limit?: number;
  }): Promise<number> {
    const before = (inputRecord.now ?? now()).toISOString();
    const candidates = await input.metadata.listLegacyPurgeCandidates({
      before,
      limit: Math.min(1_000, Math.max(1, inputRecord.limit ?? 100)),
    });
    let purged = 0;
    for (const candidate of candidates) {
      const metadata = await input.metadata.claimLegacyPurge({
        attachmentId: candidate.id,
        before,
      });
      if (metadata?.legalHold || !metadata?.legacyLocation) continue;
      await storeFor(metadata.legacyLocation.backend).deleteObject(
        metadata.legacyLocation.key,
      );
      await input.metadata.clearLegacyLocation({ attachmentId: metadata.id });
      purged += 1;
    }
    return purged;
  }

  return {
    initiateMultipartUpload,
    putInlineCiphertext,
    presignUploadPart,
    recordUploadedPart,
    completeMultipartUpload,
    resumeMultipartUpload,
    download,
    migrateAttachment,
    sweepExpiredUploads,
    sweepOrphans,
    purgeMigratedLegacy,
  };
}
