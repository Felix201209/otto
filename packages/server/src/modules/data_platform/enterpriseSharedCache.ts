/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

const RELEASE_OWNED_LEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export interface EnterpriseSharedCacheReadiness {
  ready: true;
  backend: 'redis';
}

export interface EnterpriseSharedCache {
  readonly backend: 'redis';
  healthCheck(): Promise<EnterpriseSharedCacheReadiness>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  acquireLease(key: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(key: string, owner: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface RedisEnterpriseClientLike {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { NX?: boolean; PX?: number },
  ): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  quit(): Promise<unknown>;
}

function cacheKey(prefix: string, key: string): string {
  const normalized = key.trim();
  if (
    !normalized ||
    normalized.length > 512 ||
    Array.from(normalized).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error('enterprise cache key is invalid');
  }
  return `${prefix}:${normalized}`;
}

function positiveTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) {
    throw new Error(
      'enterprise cache TTL must be from 1 to 86400000 milliseconds',
    );
  }
  return ttlMs;
}

/** Redis-backed cache and lease primitive shared by every Otto Server replica. */
export function createRedisEnterpriseSharedCache(input: {
  client: RedisEnterpriseClientLike;
  keyPrefix?: string;
}): EnterpriseSharedCache {
  const keyPrefix = input.keyPrefix?.trim() || 'otto';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyPrefix)) {
    throw new Error('enterprise cache key prefix is invalid');
  }

  return {
    backend: 'redis',
    async healthCheck() {
      const response = await input.client.ping();
      if (response !== 'PONG') {
        throw new Error('Redis enterprise cache health check failed');
      }
      return { ready: true, backend: 'redis' };
    },
    get(key) {
      return input.client.get(cacheKey(keyPrefix, key));
    },
    async set(key, value, ttlMs) {
      const namespacedKey = cacheKey(keyPrefix, key);
      const result =
        ttlMs === undefined
          ? await input.client.set(namespacedKey, value)
          : await input.client.set(namespacedKey, value, {
              PX: positiveTtl(ttlMs),
            });
      if (result !== 'OK')
        throw new Error('Redis enterprise cache write failed');
    },
    async delete(key) {
      await input.client.del(cacheKey(keyPrefix, key));
    },
    async acquireLease(key, owner, ttlMs) {
      if (!owner.trim() || owner.length > 512) {
        throw new Error('enterprise cache lease owner is invalid');
      }
      return (
        (await input.client.set(cacheKey(keyPrefix, key), owner, {
          NX: true,
          PX: positiveTtl(ttlMs),
        })) === 'OK'
      );
    },
    async releaseLease(key, owner) {
      const released = await input.client.eval(RELEASE_OWNED_LEASE_SCRIPT, {
        keys: [cacheKey(keyPrefix, key)],
        arguments: [owner],
      });
      return Number(released) === 1;
    },
    async close() {
      await input.client.quit();
    },
  };
}
