/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Redis is a short-lived accelerator and cross-replica invalidation channel.
 * PostgreSQL remains authoritative for sessions and durable login throttling.
 */

import { createHash } from 'node:crypto';

import type { EnterpriseSharedCache } from '../modules/data_platform/index.js';
import type {
  PostgresEnterpriseAccountView,
  PostgresEnterpriseCoreRepository,
} from './postgresCoreRepository.js';

const SESSION_CACHE_TTL_MS = 15_000;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sessionKey(token: string): string {
  return `sessions:v1:${digest(token)}`;
}

function loginBlockKey(identifier: string): string {
  return `login-blocks:v1:${digest(identifier.trim().toLowerCase())}`;
}

function cachedAccount(value: string): PostgresEnterpriseAccountView | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const account = parsed as Partial<PostgresEnterpriseAccountView>;
    if (
      typeof account.id !== 'string' ||
      typeof account.organizationId !== 'string' ||
      typeof account.username !== 'string' ||
      account.status !== 'active'
    ) {
      return null;
    }
    return account as PostgresEnterpriseAccountView;
  } catch {
    return null;
  }
}

export function createClusteredEnterpriseSharedState(input: {
  repository: PostgresEnterpriseCoreRepository;
  cache: EnterpriseSharedCache;
  clock?: () => number;
}) {
  const clock = input.clock ?? Date.now;

  async function cacheSession(
    token: string,
    expiresAt: string,
    account: PostgresEnterpriseAccountView,
  ): Promise<void> {
    const remaining = new Date(expiresAt).getTime() - clock();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    await input.cache.set(
      sessionKey(token),
      JSON.stringify(account),
      Math.max(1, Math.min(SESSION_CACHE_TTL_MS, Math.floor(remaining))),
    );
  }

  async function getAccountBySession(
    token: string,
  ): Promise<PostgresEnterpriseAccountView | null> {
    if (!token.trim()) return null;
    const key = sessionKey(token);
    const cached = await input.cache.get(key);
    if (cached) {
      const account = cachedAccount(cached);
      if (account) return account;
      await input.cache.delete(key);
    }
    const account = await input.repository.getAccountBySession(token);
    if (account) {
      await input.cache.set(
        key,
        JSON.stringify(account),
        SESSION_CACHE_TTL_MS,
      );
    }
    return account;
  }

  async function revokeSession(token: string): Promise<boolean> {
    const revoked = await input.repository.revokeAuthSession(token);
    await input.cache.delete(sessionKey(token));
    return revoked;
  }

  async function getLoginRetryAfter(identifier: string): Promise<number> {
    const cached = Number(await input.cache.get(loginBlockKey(identifier)));
    const cachedRetry = Number.isSafeInteger(cached)
      ? Math.max(0, Math.ceil((cached - clock()) / 1_000))
      : 0;
    if (cachedRetry > 0) return cachedRetry;
    const durableRetry = await input.repository.getLoginRetryAfter(identifier);
    if (durableRetry > 0) await recordLoginBlock(identifier, durableRetry);
    return durableRetry;
  }

  async function recordLoginBlock(
    identifier: string,
    retryAfterSeconds: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds <= 0) {
      return;
    }
    await input.cache.set(
      loginBlockKey(identifier),
      String(clock() + retryAfterSeconds * 1_000),
      retryAfterSeconds * 1_000,
    );
  }

  async function clearLoginFailures(identifier: string): Promise<void> {
    await Promise.all([
      input.repository.clearLoginFailures(identifier),
      input.cache.delete(loginBlockKey(identifier)),
    ]);
  }

  return {
    cacheSession,
    getAccountBySession,
    revokeSession,
    getLoginRetryAfter,
    recordLoginBlock,
    clearLoginFailures,
  };
}

export type ClusteredEnterpriseSharedState = ReturnType<
  typeof createClusteredEnterpriseSharedState
>;
