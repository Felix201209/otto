/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Redis is a short-lived accelerator and cross-replica invalidation channel.
 * PostgreSQL remains authoritative for sessions and durable login throttling.
 */

import { createHash } from 'node:crypto';

import {
  ACCOUNT_PRESENCE_MAX_CLIENT_ID_LENGTH,
  ACCOUNT_PRESENCE_MAX_ONLINE_WINDOW_MS,
  ACCOUNT_PRESENCE_ONLINE_WINDOW_MS,
  type AccountPresenceView,
} from '../modules/collaboration/presenceRepository.js';
import type { EnterpriseSharedCache } from '../modules/data_platform/index.js';
import type {
  PostgresEnterpriseAccountView,
  PostgresEnterpriseCoreRepository,
} from './postgresCoreRepository.js';

const SESSION_CACHE_TTL_MS = 15_000;
const PRESENCE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sessionKey(token: string): string {
  return `sessions:v1:${digest(token)}`;
}

function loginBlockKey(identifier: string): string {
  return `login-blocks:v1:${digest(identifier.trim().toLowerCase())}`;
}

function presenceKey(organizationId: string, accountId: string): string {
  return `presence:v1:${digest(organizationId)}:${digest(accountId)}`;
}

function normalizePresenceClientId(clientId?: string | null): string {
  return (
    (clientId || 'default')
      .trim()
      .slice(0, ACCOUNT_PRESENCE_MAX_CLIENT_ID_LENGTH) || 'default'
  );
}

function cachedPresenceTimestamp(value: string, nowMs: number): number | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const lastSeenAtMs = Number(
      (parsed as { lastSeenAtMs?: unknown }).lastSeenAtMs,
    );
    if (
      !Number.isSafeInteger(lastSeenAtMs) ||
      lastSeenAtMs < 0 ||
      lastSeenAtMs > nowMs
    ) {
      return null;
    }
    return lastSeenAtMs;
  } catch {
    return null;
  }
}

function cachedAccount(value: string): PostgresEnterpriseAccountView | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
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
      await input.cache.set(key, JSON.stringify(account), SESSION_CACHE_TTL_MS);
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

  async function touchAccountPresence(presenceInput: {
    organizationId: string;
    accountId: string;
    clientId?: string | null;
  }): Promise<AccountPresenceView> {
    const organizationId = presenceInput.organizationId.trim();
    const accountId = presenceInput.accountId.trim();
    if (!organizationId || !accountId) {
      throw new Error('Account not available for presence');
    }
    const lastSeenAtMs = Math.max(0, Math.floor(clock()));
    await input.cache.set(
      presenceKey(organizationId, accountId),
      JSON.stringify({
        clientId: normalizePresenceClientId(presenceInput.clientId),
        lastSeenAtMs,
      }),
      PRESENCE_CACHE_TTL_MS,
    );
    return {
      accountId,
      online: true,
      lastSeenAt: new Date(lastSeenAtMs).toISOString(),
    };
  }

  async function listAccountPresence(
    organizationId: string,
    accountIds: string[],
    onlineWindowMs = ACCOUNT_PRESENCE_ONLINE_WINDOW_MS,
  ): Promise<AccountPresenceView[]> {
    const normalizedOrganizationId = organizationId.trim();
    if (!normalizedOrganizationId) return [];
    const normalizedWindowMs = Math.min(
      ACCOUNT_PRESENCE_MAX_ONLINE_WINDOW_MS,
      Math.max(1, Math.floor(onlineWindowMs)),
    );
    const nowMs = Math.max(0, Math.floor(clock()));
    const normalizedAccountIds = [
      ...new Set(accountIds.map((value) => value.trim()).filter(Boolean)),
    ];

    return Promise.all(
      normalizedAccountIds.map(
        async (accountId): Promise<AccountPresenceView> => {
          const key = presenceKey(normalizedOrganizationId, accountId);
          const cached = await input.cache.get(key);
          if (!cached) {
            return { accountId, online: false, lastSeenAt: null };
          }
          const lastSeenAtMs = cachedPresenceTimestamp(cached, nowMs);
          if (lastSeenAtMs === null) {
            await input.cache.delete(key);
            return { accountId, online: false, lastSeenAt: null };
          }
          return {
            accountId,
            online: nowMs - lastSeenAtMs <= normalizedWindowMs,
            lastSeenAt: new Date(lastSeenAtMs).toISOString(),
          };
        },
      ),
    );
  }

  return {
    cacheSession,
    getAccountBySession,
    revokeSession,
    getLoginRetryAfter,
    recordLoginBlock,
    clearLoginFailures,
    touchAccountPresence,
    listAccountPresence,
  };
}

export type ClusteredEnterpriseSharedState = ReturnType<
  typeof createClusteredEnterpriseSharedState
>;
