/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildNodeRedisClientOptions,
  createNodeRedisEnterpriseSharedCache,
} from './nodeRedisSharedCache.js';

describe('node Redis shared cache', () => {
  it('uses bounded fail-fast connection settings', () => {
    expect(
      buildNodeRedisClientOptions({
        connectionString: 'rediss://default:secret@cache.internal:6379/1',
        environment: {
          OTTO_REDIS_CONNECT_TIMEOUT_MS: '5000',
        },
      }),
    ).toEqual({
      url: 'rediss://default:secret@cache.internal:6379/1',
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: false,
      },
    });
  });

  it('connects before exposing the cache and closes on failed health', async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      ping: vi.fn(async () => 'LOADING'),
      get: vi.fn(async () => null),
      set: vi.fn(async () => null),
      del: vi.fn(async () => 0),
      eval: vi.fn(async () => 0),
      quit: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      on: vi.fn(),
    };

    await expect(
      createNodeRedisEnterpriseSharedCache({
        connectionString: 'rediss://cache.internal:6379',
        environment: {},
        clientFactory: vi.fn(() => client),
      }),
    ).rejects.toThrow(/health.*failed/i);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.quit).toHaveBeenCalledOnce();
  });
});
