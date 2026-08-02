/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { EnterpriseSharedCache } from '../modules/data_platform/index.js';
import { createClusteredMlsMaintenance } from './clusteredMlsMaintenance.js';

describe('clustered MLS resource maintenance', () => {
  it('uses a shared lease and runs bounded PostgreSQL cleanup', async () => {
    const cache = {
      acquireLease: vi.fn(async () => true),
      releaseLease: vi.fn(async () => true),
    } as unknown as EnterpriseSharedCache;
    const authority = {
      cleanupExpiredMlsResources: vi.fn(async () => ({
        eventsDeleted: 3,
        keyPackagesDeleted: 2,
        groupSessionsDeleted: 1,
        rateBucketsDeleted: 1,
        conversationsAdvanced: 1,
      })),
    };
    const maintenance = createClusteredMlsMaintenance({
      cache,
      authority,
      owner: 'replica-a',
    });

    await expect(maintenance.runOnce()).resolves.toBe(true);
    expect(authority.cleanupExpiredMlsResources).toHaveBeenCalledWith({
      before: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      limit: 500,
    });
    expect(cache.releaseLease).toHaveBeenCalledWith(
      'jobs:mls-resource-maintenance:v1',
      'replica-a',
    );
  });

  it('does not clean when another replica owns the lease', async () => {
    const cache = {
      acquireLease: vi.fn(async () => false),
      releaseLease: vi.fn(),
    } as unknown as EnterpriseSharedCache;
    const authority = { cleanupExpiredMlsResources: vi.fn() };
    const maintenance = createClusteredMlsMaintenance({ cache, authority });

    await expect(maintenance.runOnce()).resolves.toBe(false);
    expect(authority.cleanupExpiredMlsResources).not.toHaveBeenCalled();
    expect(cache.releaseLease).not.toHaveBeenCalled();
  });
});
