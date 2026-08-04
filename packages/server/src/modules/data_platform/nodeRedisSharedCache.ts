/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createClient, type RedisClientOptions } from 'redis';

import {
  createRedisEnterpriseSharedCache,
  type EnterpriseSharedCache,
  type RedisEnterpriseClientLike,
} from './enterpriseSharedCache.js';

export interface NodeRedisEnvironment {
  OTTO_REDIS_CONNECT_TIMEOUT_MS?: string;
}

export interface NodeRedisClientLike extends RedisEnterpriseClientLike {
  connect(): Promise<unknown>;
  disconnect(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

function boundedInteger(input: {
  name: string;
  value: string | undefined;
  fallback: number;
  min: number;
  max: number;
}): number {
  if (!input.value?.trim()) return input.fallback;
  const parsed = Number(input.value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < input.min ||
    parsed > input.max
  ) {
    throw new Error(
      `${input.name} must be an integer from ${input.min} to ${input.max}`,
    );
  }
  return parsed;
}

export function buildNodeRedisClientOptions(input: {
  connectionString: string;
  environment: NodeRedisEnvironment;
}): RedisClientOptions {
  return {
    url: input.connectionString,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: boundedInteger({
        name: 'OTTO_REDIS_CONNECT_TIMEOUT_MS',
        value: input.environment.OTTO_REDIS_CONNECT_TIMEOUT_MS,
        fallback: 10_000,
        min: 100,
        max: 120_000,
      }),
      reconnectStrategy: false,
    },
  };
}

/** Opens and verifies a Redis connection without logging its credential-bearing URL. */
export async function createNodeRedisEnterpriseSharedCache(input: {
  connectionString: string;
  environment: NodeRedisEnvironment;
  keyPrefix?: string;
  clientFactory?: (options: RedisClientOptions) => NodeRedisClientLike;
}): Promise<EnterpriseSharedCache> {
  const options = buildNodeRedisClientOptions(input);
  const client = input.clientFactory
    ? input.clientFactory(options)
    : (createClient(options) as unknown as NodeRedisClientLike);
  client.on('error', () => {
    // Connection failures are surfaced by operations/readiness, not logged with
    // client configuration that may contain credentials.
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const cache = createRedisEnterpriseSharedCache({
      client,
      keyPrefix: input.keyPrefix,
    });
    await cache.healthCheck();
    return cache;
  } catch (error) {
    try {
      if (connected) await client.quit();
      else client.disconnect();
    } catch {
      // Preserve the connection or readiness error.
    }
    throw error;
  }
}
