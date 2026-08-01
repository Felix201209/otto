/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import type {
  AttachmentObjectStore,
  EnterpriseSharedCache,
  createAttachmentStorageService,
} from '../modules/data_platform/index.js';
import type { PostgresEnterpriseCoreRepository } from './postgresCoreRepository.js';

type AttachmentStorageService = ReturnType<
  typeof createAttachmentStorageService
>;

const ATTACHMENT_ORPHAN_CURSOR_KEY = 'jobs:attachment-orphan-cursor:v1';
const ATTACHMENT_ORPHAN_CURSOR_TTL_MS = 24 * 60 * 60 * 1_000;

export function createClusteredAttachmentMaintenance(input: {
  storage: AttachmentStorageService;
  cache: EnterpriseSharedCache;
  attachmentAuthority?: Pick<
    PostgresEnterpriseCoreRepository,
    'claimExpiredUnboundAttachments' | 'completeExpiredUnboundAttachment'
  >;
  objectStore?: Pick<AttachmentObjectStore, 'deleteObject'>;
  intervalMs?: number;
  owner?: string;
  onError?: (error: unknown) => void;
}) {
  const intervalMs = input.intervalMs ?? 15 * 60 * 1_000;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 60_000 ||
    intervalMs > 24 * 60 * 60 * 1_000
  ) {
    throw new Error('attachment maintenance interval is invalid');
  }
  const owner = input.owner?.trim() || randomUUID();
  if (Boolean(input.attachmentAuthority) !== Boolean(input.objectStore)) {
    throw new Error(
      'unbound attachment cleanup requires both authority and object store',
    );
  }
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let closed = false;

  async function runOnce(): Promise<boolean> {
    if (closed || running) return false;
    running = true;
    let leased = false;
    try {
      leased = await input.cache.acquireLease(
        'jobs:attachment-maintenance:v1',
        owner,
        Math.min(24 * 60 * 60 * 1_000, intervalMs * 2),
      );
      if (!leased) return false;
      await input.storage.sweepExpiredUploads({ limit: 200 });
      if (input.attachmentAuthority && input.objectStore) {
        const unbound = await input.attachmentAuthority.claimExpiredUnboundAttachments({
          before: new Date().toISOString(),
          limit: 200,
        });
        for (const attachment of unbound) {
          await input.objectStore.deleteObject(attachment.key);
          await input.attachmentAuthority.completeExpiredUnboundAttachment(
            attachment,
          );
        }
      }
      const orphanCursor = await input.cache.get(ATTACHMENT_ORPHAN_CURSOR_KEY);
      const orphanSweep = await input.storage.sweepOrphans({
        backend: 's3',
        limit: 500,
        ...(orphanCursor ? { cursor: orphanCursor } : {}),
      });
      if (orphanSweep.nextCursor) {
        await input.cache.set(
          ATTACHMENT_ORPHAN_CURSOR_KEY,
          orphanSweep.nextCursor,
          ATTACHMENT_ORPHAN_CURSOR_TTL_MS,
        );
      } else {
        await input.cache.delete(ATTACHMENT_ORPHAN_CURSOR_KEY);
      }
      await input.storage.purgeMigratedLegacy({ limit: 200 });
      return true;
    } finally {
      if (leased) await input.cache.releaseLease(
        'jobs:attachment-maintenance:v1',
        owner,
      );
      running = false;
    }
  }

  function start(): void {
    if (closed || timer) return;
    timer = setInterval(() => {
      void runOnce().catch((error: unknown) => input.onError?.(error));
    }, intervalMs);
    timer.unref();
  }

  function close(): void {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, close };
}
