/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  EnterpriseSharedCache,
  createAttachmentStorageService,
} from '../modules/data_platform/index.js';
import { createClusteredAttachmentMaintenance } from './clusteredAttachmentMaintenance.js';

type AttachmentStorageService = ReturnType<
  typeof createAttachmentStorageService
>;

describe('clustered attachment maintenance', () => {
  it('uses a Redis lease so only one replica performs destructive cleanup', async () => {
    const storage = {
      sweepExpiredUploads: vi.fn(async () => 1),
      sweepOrphans: vi.fn(async () => ({ deleted: 2, nextCursor: null })),
      purgeMigratedLegacy: vi.fn(async () => 1),
    } as unknown as AttachmentStorageService;
    const cache = {
      acquireLease: vi.fn(async () => true),
      releaseLease: vi.fn(async () => true),
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as unknown as EnterpriseSharedCache;
    const maintenance = createClusteredAttachmentMaintenance({
      storage,
      cache,
      owner: 'replica-a',
    });

    await expect(maintenance.runOnce()).resolves.toBe(true);
    expect(storage.sweepExpiredUploads).toHaveBeenCalledWith({ limit: 200 });
    expect(storage.sweepOrphans).toHaveBeenCalledWith({
      backend: 's3',
      limit: 500,
    });
    expect(cache.delete).toHaveBeenCalledWith(
      'jobs:attachment-orphan-cursor:v1',
    );
    expect(cache.releaseLease).toHaveBeenCalledWith(
      'jobs:attachment-maintenance:v1',
      'replica-a',
    );
  });

  it('does no cleanup when another replica owns the lease', async () => {
    const storage = {
      sweepExpiredUploads: vi.fn(),
    } as unknown as AttachmentStorageService;
    const cache = {
      acquireLease: vi.fn(async () => false),
      releaseLease: vi.fn(),
    } as unknown as EnterpriseSharedCache;
    const maintenance = createClusteredAttachmentMaintenance({ storage, cache });

    await expect(maintenance.runOnce()).resolves.toBe(false);
    expect(storage.sweepExpiredUploads).not.toHaveBeenCalled();
    expect(cache.releaseLease).not.toHaveBeenCalled();
  });

  it('deletes expired message-unbound objects before releasing stored quota', async () => {
    const storage = {
      sweepExpiredUploads: vi.fn(async () => 0),
      sweepOrphans: vi.fn(async () => ({ deleted: 0, nextCursor: null })),
      purgeMigratedLegacy: vi.fn(async () => 0),
    } as unknown as AttachmentStorageService;
    const cache = {
      acquireLease: vi.fn(async () => true),
      releaseLease: vi.fn(async () => true),
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as unknown as EnterpriseSharedCache;
    const attachment = {
      id: 'att-unbound',
      organizationId: 'org-1',
      key: 'attachments/v1/ab/opaque.bin',
      ciphertextBytes: 64,
    };
    const attachmentAuthority = {
      claimExpiredUnboundAttachments: vi.fn(async () => [attachment]),
      completeExpiredUnboundAttachment: vi.fn(async () => undefined),
    };
    const objectStore = { deleteObject: vi.fn(async () => undefined) };
    const maintenance = createClusteredAttachmentMaintenance({
      storage,
      cache,
      attachmentAuthority,
      objectStore,
    });

    await maintenance.runOnce();

    expect(objectStore.deleteObject).toHaveBeenCalledWith(attachment.key);
    expect(
      attachmentAuthority.completeExpiredUnboundAttachment,
    ).toHaveBeenCalledWith(attachment);
    expect(
      objectStore.deleteObject.mock.invocationCallOrder[0],
    ).toBeLessThan(
      attachmentAuthority.completeExpiredUnboundAttachment.mock
        .invocationCallOrder[0]!,
    );
  });

  it('continues the orphan sweep from its shared Redis cursor', async () => {
    const storage = {
      sweepExpiredUploads: vi.fn(async () => 0),
      sweepOrphans: vi.fn(async () => ({
        deleted: 1,
        nextCursor: 'cursor-2',
      })),
      purgeMigratedLegacy: vi.fn(async () => 0),
    } as unknown as AttachmentStorageService;
    const cache = {
      acquireLease: vi.fn(async () => true),
      releaseLease: vi.fn(async () => true),
      get: vi.fn(async () => 'cursor-1'),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as unknown as EnterpriseSharedCache;
    const maintenance = createClusteredAttachmentMaintenance({ storage, cache });

    await maintenance.runOnce();

    expect(storage.sweepOrphans).toHaveBeenCalledWith({
      backend: 's3',
      cursor: 'cursor-1',
      limit: 500,
    });
    expect(cache.set).toHaveBeenCalledWith(
      'jobs:attachment-orphan-cursor:v1',
      'cursor-2',
      86_400_000,
    );
  });
});
