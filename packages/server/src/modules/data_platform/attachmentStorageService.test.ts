/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  AttachmentObjectNotFoundError,
  type AttachmentObjectStore,
} from './attachmentObjectStore.js';
import {
  createAttachmentStorageService,
  type AttachmentMetadataRecord,
  type AttachmentMetadataRepository,
} from './attachmentStorageService.js';

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function record(
  overrides: Partial<AttachmentMetadataRecord> = {},
): AttachmentMetadataRecord {
  return {
    id: 'att-1',
    organizationId: 'org-1',
    ownerAccountId: 'acc-1',
    state: 'uploading',
    encryption: 'e2ee-client-v1',
    ciphertextBytes: 20,
    ciphertextSha256: 'a'.repeat(64),
    location: null,
    legacyLocation: null,
    uploadId: 'upload-1',
    expiresAt: '2099-08-01T00:00:00.000Z',
    legacyDeleteAfter: null,
    legalHold: false,
    mlsAuthorization: null,
    ...overrides,
  };
}

function metadataRepository(
  overrides: Partial<AttachmentMetadataRepository> = {},
): AttachmentMetadataRepository {
  let multipartParts: Parameters<
    AttachmentMetadataRepository['recordMultipartParts']
  >[0]['parts'] = [];
  return {
    reserveUpload: vi.fn(async (input) =>
      record({
        id: input.attachmentId,
        organizationId: input.organizationId,
        ownerAccountId: input.accountId,
        state: 'reserved',
        encryption: input.encryption,
        ciphertextBytes: input.ciphertextBytes,
        ciphertextSha256: input.ciphertextSha256,
        expiresAt: input.expiresAt,
        uploadId: null,
      }),
    ),
    attachMultipartUpload: vi.fn(async (input) =>
      record({
        id: input.attachmentId,
        state: 'uploading',
        location: input.location,
        uploadId: input.uploadId,
      }),
    ),
    recordMultipartParts: vi.fn(async (input) => {
      multipartParts = input.parts;
    }),
    replaceMultipartVerificationParts: vi.fn(async (input) => {
      multipartParts = input.parts;
    }),
    listMultipartParts: vi.fn(async () => multipartParts),
    claimMultipartVerification: vi.fn(async (input) =>
      record({
        id: input.attachmentId,
        state: 'verifying',
        location: { backend: 's3', key: 'opaque-key' },
      }),
    ),
    getAuthorizedAttachment: vi.fn(async () =>
      record({ location: { backend: 's3', key: 'opaque-key' } }),
    ),
    markAvailable: vi.fn(async (input) =>
      record({ state: 'available', location: input.location }),
    ),
    markFailed: vi.fn(async () => {}),
    listExpiredUploads: vi.fn(async () => []),
    claimExpiredUpload: vi.fn(async () => null),
    isStorageKeyReferenced: vi.fn(async () => false),
    claimMigration: vi.fn(async () => null),
    completeMigration: vi.fn(async () => {}),
    failMigration: vi.fn(async () => {}),
    listLegacyPurgeCandidates: vi.fn(async () => []),
    claimLegacyPurge: vi.fn(async () => null),
    clearLegacyLocation: vi.fn(async () => {}),
    ...overrides,
  };
}

function objectStore(
  backend: 'encrypted-filesystem' | 's3',
  overrides: Partial<AttachmentObjectStore> = {},
): AttachmentObjectStore {
  return {
    backend,
    supportsPresignedUrls: backend === 's3',
    supportsMultipartUpload: backend === 's3',
    putCiphertext: vi.fn(async ({ ciphertext, ciphertextSha256 }) => ({
      backend,
      key: `${backend}-key`,
      ciphertextBytes: ciphertext.length,
      ciphertextSha256,
    })),
    getCiphertext: vi.fn(async () => Buffer.from('ciphertext')),
    deleteObject: vi.fn(async () => {}),
    headObject: vi.fn(async (key) => ({
      backend,
      key,
      ciphertextBytes: 20,
      ciphertextSha256: 'a'.repeat(64),
    })),
    createMultipartUpload: vi.fn(async () => ({
      backend,
      key: 'opaque-key',
      uploadId: 'upload-1',
    })),
    presignUploadPart: vi.fn(async () => ({
      method: 'PUT',
      url: 'https://objects.invalid/upload',
      expiresInSeconds: 120,
      requiredHeaders: {},
    })),
    completeMultipartUpload: vi.fn(async (input) => ({
      backend,
      key: input.key,
      ciphertextBytes: input.ciphertextBytes,
      ciphertextSha256: input.ciphertextSha256,
    })),
    abortMultipartUpload: vi.fn(async () => {}),
    presignDownload: vi.fn(async () => ({
      method: 'GET',
      url: 'https://objects.invalid/download',
      expiresInSeconds: 120,
      requiredHeaders: {},
    })),
    listObjects: vi.fn(async () => ({ objects: [], cursor: null })),
    ...overrides,
  };
}

describe('attachment storage service', () => {
  const mlsAuthorization = {
    conversationId: 'a'.repeat(64),
    sessionGeneration: 2,
    groupId: 'Z3JvdXAtMQ==',
    epoch: 4,
    messageId: 'mls-message-1',
    participantAccountIds: ['acc-1', 'acc-2'] as [string, string],
    authorizedDevices: [
      { accountId: 'acc-1', deviceId: 'device-1' },
      { accountId: 'acc-2', deviceId: 'device-2' },
    ],
  };

  it('reserves tenant quota before creating a multipart upload', async () => {
    const metadata = metadataRepository();
    const s3 = objectStore('s3');
    const service = createAttachmentStorageService({
      metadata,
      stores: { s3 },
      primaryBackend: 's3',
      maxAttachmentBytes: 100,
      uploadLifetimeMs: 300_000,
      clock: () => new Date('2026-08-01T00:00:00.000Z'),
    });

    const upload = await service.initiateMultipartUpload({
      organizationId: 'org-1',
      accountId: 'acc-1',
      authorizedAccountIds: ['acc-2', 'acc-1'],
      attachmentId: 'att-1',
      ciphertextBytes: 20,
      ciphertextSha256: 'a'.repeat(64),
      encryption: 'e2ee-client-v1',
    });

    expect(metadata.reserveUpload).toHaveBeenCalledBefore(
      s3.createMultipartUpload as ReturnType<typeof vi.fn>,
    );
    expect(upload).toMatchObject({
      attachmentId: 'att-1',
      key: 'opaque-key',
      uploadId: 'upload-1',
    });
    expect(metadata.reserveUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedAccountIds: ['acc-1', 'acc-2'],
        expiresAt: '2026-08-01T00:05:00.000Z',
      }),
    );
  });

  it('authorizes every part and download through tenant metadata', async () => {
    const metadata = metadataRepository({
      getAuthorizedAttachment: vi.fn(async () => null),
    });
    const s3 = objectStore('s3');
    const service = createAttachmentStorageService({
      metadata,
      stores: { s3 },
      primaryBackend: 's3',
      maxAttachmentBytes: 100,
    });

    await expect(
      service.presignUploadPart({
        organizationId: 'org-other',
        accountId: 'acc-other',
        attachmentId: 'att-1',
        partNumber: 1,
        ciphertextBytes: 20,
        ciphertextSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/access denied/i);
    await expect(
      service.download({
        organizationId: 'org-other',
        accountId: 'acc-other',
        attachmentId: 'att-1',
      }),
    ).rejects.toThrow(/access denied/i);
    expect(s3.presignUploadPart).not.toHaveBeenCalled();
    expect(s3.presignDownload).not.toHaveBeenCalled();
  });

  it('allows a non-owner account only when the metadata ACL authorizes it', async () => {
    const metadata = metadataRepository({
      getAuthorizedAttachment: vi.fn(async () =>
        record({
          ownerAccountId: 'acc-owner',
          state: 'available',
          location: { backend: 's3', key: 'opaque-key' },
        }),
      ),
    });
    const s3 = objectStore('s3');
    const service = createAttachmentStorageService({
      metadata,
      stores: { s3 },
      primaryBackend: 's3',
      maxAttachmentBytes: 100,
    });

    await expect(
      service.download({
        organizationId: 'org-1',
        accountId: 'acc-recipient',
        attachmentId: 'att-1',
      }),
    ).resolves.toMatchObject({
      kind: 'presigned',
      ciphertextBytes: 20,
      ciphertextSha256: 'a'.repeat(64),
      encryption: 'e2ee-client-v1',
    });
    expect(metadata.getAuthorizedAttachment).toHaveBeenCalledWith({
      organizationId: 'org-1',
      accountId: 'acc-recipient',
      attachmentId: 'att-1',
    });
  });

  it('persists the MLS generation and send-time device roster with the object', async () => {
    const metadata = metadataRepository();
    const s3 = objectStore('s3');
    const service = createAttachmentStorageService({
      metadata,
      stores: { s3 },
      primaryBackend: 's3',
      maxAttachmentBytes: 100,
    });

    await service.initiateMultipartUpload({
      organizationId: 'org-1',
      accountId: 'acc-1',
      authorizedAccountIds: ['acc-2'],
      attachmentId: 'mls-att-1',
      ciphertextBytes: 20,
      ciphertextSha256: 'a'.repeat(64),
      encryption: 'mls-client-v1',
      mlsAuthorization,
    });

    expect(metadata.reserveUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        encryption: 'mls-client-v1',
        authorizedAccountIds: ['acc-1', 'acc-2'],
        mlsAuthorization,
      }),
    );
  });

  it('requires both send-time and current MLS device authorization', async () => {
    const metadata = metadataRepository({
      getAuthorizedAttachment: vi.fn(async () =>
        record({
          ownerAccountId: 'acc-1',
          state: 'available',
          encryption: 'mls-client-v1',
          location: { backend: 's3', key: 'opaque-key' },
          mlsAuthorization,
        }),
      ),
    });
    const s3 = objectStore('s3');
    const service = createAttachmentStorageService({
      metadata,
      stores: { s3 },
      primaryBackend: 's3',
      maxAttachmentBytes: 100,
    });
    const currentSession = {
      conversationId: mlsAuthorization.conversationId,
      sessionGeneration: 2,
      groupId: mlsAuthorization.groupId,
      epoch: 7,
      participantAccountIds: mlsAuthorization.participantAccountIds,
      authorizedDevices: [
        ...mlsAuthorization.authorizedDevices,
        { accountId: 'acc-2', deviceId: 'device-new' },
      ],
    };

    await expect(
      service.download({
        organizationId: 'org-1',
        accountId: 'acc-2',
        attachmentId: 'mls-att-1',
      }),
    ).rejects.toThrow(/access denied/i);
    await expect(
      service.download({
        organizationId: 'org-1',
        accountId: 'acc-2',
        attachmentId: 'mls-att-1',
        mlsAccess: { deviceId: 'device-new', session: currentSession },
      }),
    ).rejects.toThrow(/access denied/i);
    await expect(
      service.download({
        organizationId: 'org-1',
        accountId: 'acc-2',
        attachmentId: 'mls-att-1',
        mlsAccess: { deviceId: 'device-2', session: currentSession },
      }),
    ).resolves.toMatchObject({
      kind: 'presigned',
      encryption: 'mls-client-v1',
    });
    await expect(
      service.download({
        organizationId: 'org-1',
        accountId: 'acc-2',
        attachmentId: 'mls-att-1',
        mlsAccess: {
          deviceId: 'device-2',
          session: {
            ...currentSession,
            authorizedDevices: currentSession.authorizedDevices.filter(
              (device) => device.deviceId !== 'device-2',
            ),
          },
        },
      }),
    ).rejects.toThrow(/access denied/i);
  });

  it('does not presign a download when object metadata fails integrity checks', async () => {
    const metadata = metadataRepository({
      getAuthorizedAttachment: vi.fn(async () =>
        record({
          state: 'available',
          location: { backend: 's3', key: 'opaque-key' },
        }),
      ),
    });
    const s3 = objectStore('s3', {
      headObject: vi.fn(async () => ({
        backend: 's3',
        key: 'opaque-key',
        ciphertextBytes: 20,
        ciphertextSha256: 'b'.repeat(64),
      })),
    });
    const service = createAttachmentStorageService({
      metadata,
      stores: { s3 },
      primaryBackend: 's3',
      maxAttachmentBytes: 100,
    });

    await expect(
      service.download({
        organizationId: 'org-1',
        accountId: 'acc-1',
        attachmentId: 'att-1',
      }),
    ).rejects.toThrow(/metadata integrity/i);
    expect(s3.presignDownload).not.toHaveBeenCalled();
  });

  it('does not issue part URLs after the server-assigned upload expiry', async () => {
    const metadata = metadataRepository({
      getAuthorizedAttachment: vi.fn(async () =>
        record({ expiresAt: '2026-07-31T00:00:00.000Z' }),
      ),
    });
    const s3 = objectStore('s3');
    const service = createAttachmentStorageService({
      metadata,
      stores: { s3 },
      primaryBackend: 's3',
      maxAttachmentBytes: 100,
      clock: () => new Date('2026-08-01T00:00:00.000Z'),
    });

    await expect(
      service.presignUploadPart({
        organizationId: 'org-1',
        accountId: 'acc-1',
        attachmentId: 'att-1',
        partNumber: 1,
        ciphertextBytes: 20,
        ciphertextSha256: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/upload is not active/i);
    expect(s3.presignUploadPart).not.toHaveBeenCalled();
  });

  it('rolls back object storage and quota metadata when completion fails', async () => {
    const metadata = metadataRepository();
    const s3 = objectStore('s3', {
      completeMultipartUpload: vi.fn(async () => {
        throw new Error('checksum mismatch');
      }),
    });
    const service = createAttachmentStorageService({
      metadata,
      stores: { s3 },
      primaryBackend: 's3',
      maxAttachmentBytes: 100,
    });

    await expect(
      service.completeMultipartUpload({
        organizationId: 'org-1',
        accountId: 'acc-1',
        attachmentId: 'att-1',
        parts: [
          {
            partNumber: 1,
            eTag: 'etag',
            ciphertextBytes: 20,
            ciphertextSha256: 'a'.repeat(64),
          },
        ],
      }),
    ).rejects.toThrow('checksum mismatch');
    expect(s3.abortMultipartUpload).toHaveBeenCalled();
    expect(s3.deleteObject).toHaveBeenCalledWith('opaque-key');
    expect(metadata.markFailed).toHaveBeenCalledWith({
      attachmentId: 'att-1',
      failureCode: 'upload_completion_failed',
    });
  });

  it('restores persisted multipart progress after an instance restart', async () => {
    const parts = [
      {
        partNumber: 1,
        eTag: 'etag-1',
        ciphertextBytes: 20,
        ciphertextSha256: 'a'.repeat(64),
      },
    ];
    const metadata = metadataRepository();
    const s3 = objectStore('s3');
    const service = createAttachmentStorageService({
      metadata,
      stores: { s3 },
      primaryBackend: 's3',
      maxAttachmentBytes: 100,
    });

    await service.recordUploadedPart({
      organizationId: 'org-1',
      accountId: 'acc-1',
      attachmentId: 'att-1',
      part: parts[0],
    });
    await expect(
      service.resumeMultipartUpload({
        organizationId: 'org-1',
        accountId: 'acc-1',
        attachmentId: 'att-1',
      }),
    ).resolves.toEqual({
      attachmentId: 'att-1',
      ciphertextBytes: 20,
      ciphertextSha256: 'a'.repeat(64),
      parts,
    });
    expect(metadata.recordMultipartParts).toHaveBeenCalledWith({
      attachmentId: 'att-1',
      parts,
    });
  });

  it('dual-reads legacy storage and migrates without deleting the source early', async () => {
    const ciphertext = Buffer.from('legacy ciphertext');
    const expected = digest(ciphertext);
    const legacy = objectStore('encrypted-filesystem', {
      getCiphertext: vi.fn(async () => ciphertext),
      headObject: vi.fn(async (key) => ({
        backend: 'encrypted-filesystem',
        key,
        ciphertextBytes: ciphertext.length,
        ciphertextSha256: expected,
      })),
    });
    const s3 = objectStore('s3', {
      getCiphertext: vi.fn(async (key) => {
        if (key === 'missing-primary') {
          throw new AttachmentObjectNotFoundError();
        }
        return ciphertext;
      }),
      headObject: vi.fn(async (key) => {
        if (key === 'missing-primary') {
          throw new AttachmentObjectNotFoundError();
        }
        return {
          backend: 's3',
          key,
          ciphertextBytes: ciphertext.length,
          ciphertextSha256: expected,
        };
      }),
      putCiphertext: vi.fn(async () => ({
        backend: 's3',
        key: 'new-key',
        ciphertextBytes: ciphertext.length,
        ciphertextSha256: expected,
      })),
    });
    const migrating = record({
      state: 'available',
      ciphertextBytes: ciphertext.length,
      ciphertextSha256: expected,
      location: { backend: 's3', key: 'missing-primary' },
      legacyLocation: {
        backend: 'encrypted-filesystem',
        key: 'legacy-key',
      },
    });
    const metadata = metadataRepository({
      getAuthorizedAttachment: vi.fn(async () => migrating),
      claimMigration: vi.fn(async () =>
        record({
          ...migrating,
          location: {
            backend: 'encrypted-filesystem',
            key: 'legacy-key',
          },
          legacyLocation: null,
        }),
      ),
    });
    const service = createAttachmentStorageService({
      metadata,
      stores: { s3, 'encrypted-filesystem': legacy },
      primaryBackend: 's3',
      maxAttachmentBytes: 100,
      migrationGraceMs: 86_400_000,
    });

    await expect(
      service.download({
        organizationId: 'org-1',
        accountId: 'acc-1',
        attachmentId: 'att-1',
      }),
    ).resolves.toEqual({
      kind: 'ciphertext',
      ciphertext,
      ciphertextBytes: ciphertext.length,
      ciphertextSha256: expected,
      encryption: 'e2ee-client-v1',
    });

    await service.migrateAttachment({
      attachmentId: 'att-1',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(metadata.completeMigration).toHaveBeenCalledWith({
      attachmentId: 'att-1',
      location: { backend: 's3', key: 'new-key' },
      legacyLocation: {
        backend: 'encrypted-filesystem',
        key: 'legacy-key',
      },
      legacyDeleteAfter: '2026-08-02T00:00:00.000Z',
    });
    expect(legacy.deleteObject).not.toHaveBeenCalled();
  });

  it('cleans only expired, unreferenced and non-retained objects', async () => {
    const expired = record({
      id: 'att-expired',
      state: 'uploading',
      location: { backend: 's3', key: 'expired-upload' },
      uploadId: 'multipart-expired',
    });
    const legacyDue = record({
      id: 'att-migrated',
      state: 'available',
      location: { backend: 's3', key: 'primary-key' },
      legacyLocation: {
        backend: 'encrypted-filesystem',
        key: 'legacy-due',
      },
      legacyDeleteAfter: '2026-07-01T00:00:00.000Z',
    });
    const metadata = metadataRepository({
      listExpiredUploads: vi.fn(async () => [expired]),
      claimExpiredUpload: vi.fn(async () =>
        record({ ...expired, state: 'cleaning' }),
      ),
      listLegacyPurgeCandidates: vi.fn(async () => [legacyDue]),
      claimLegacyPurge: vi.fn(async () => legacyDue),
      isStorageKeyReferenced: vi.fn(async ({ key }) => key === 'referenced'),
    });
    const s3 = objectStore('s3', {
      listObjects: vi.fn(async () => ({
        objects: [
          {
            key: 'orphan-old',
            ciphertextBytes: 10,
            lastModifiedAt: '2026-07-01T00:00:00.000Z',
          },
          {
            key: 'referenced',
            ciphertextBytes: 10,
            lastModifiedAt: '2026-07-01T00:00:00.000Z',
          },
          {
            key: 'orphan-new',
            ciphertextBytes: 10,
            lastModifiedAt: '2026-08-01T11:30:00.000Z',
          },
        ],
        cursor: null,
      })),
    });
    const local = objectStore('encrypted-filesystem');
    const service = createAttachmentStorageService({
      metadata,
      stores: { s3, 'encrypted-filesystem': local },
      primaryBackend: 's3',
      maxAttachmentBytes: 100,
      orphanGraceMs: 3_600_000,
    });
    const now = new Date('2026-08-01T12:00:00.000Z');

    await expect(service.sweepExpiredUploads({ now })).resolves.toBe(1);
    await expect(
      service.sweepOrphans({
        backend: 's3',
        now,
        cursor: 'previous-page',
      }),
    ).resolves.toEqual({ deleted: 1, nextCursor: null });
    await expect(service.purgeMigratedLegacy({ now })).resolves.toBe(1);

    expect(s3.abortMultipartUpload).toHaveBeenCalledWith({
      key: 'expired-upload',
      uploadId: 'multipart-expired',
    });
    expect(s3.deleteObject).toHaveBeenCalledWith('expired-upload');
    expect(s3.deleteObject).toHaveBeenCalledWith('orphan-old');
    expect(s3.deleteObject).not.toHaveBeenCalledWith('referenced');
    expect(s3.deleteObject).not.toHaveBeenCalledWith('orphan-new');
    expect(s3.listObjects).toHaveBeenCalledWith({
      cursor: 'previous-page',
      limit: 100,
    });
    expect(local.deleteObject).toHaveBeenCalledWith('legacy-due');
    expect(metadata.clearLegacyLocation).toHaveBeenCalledWith({
      attachmentId: 'att-migrated',
    });
  });
});
