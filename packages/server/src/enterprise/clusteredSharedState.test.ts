/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { EnterpriseSharedCache } from '../modules/data_platform/index.js';
import { createClusteredEnterpriseSharedState } from './clusteredSharedState.js';
import type {
  PostgresEnterpriseAccountView,
  PostgresEnterpriseCoreRepository,
} from './postgresCoreRepository.js';

const account = {
  id: 'acc_admin',
  organizationId: 'org_default',
  username: 'admin',
  status: 'active',
} as PostgresEnterpriseAccountView;

function dependencies() {
  const values = new Map<string, string>();
  const cache = {
    backend: 'redis',
    healthCheck: vi.fn(),
    get: vi.fn(async (key: string) => values.get(`otto:${key}`) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(`otto:${key}`, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(`otto:${key}`);
    }),
    acquireLease: vi.fn(),
    releaseLease: vi.fn(),
    close: vi.fn(),
  } as EnterpriseSharedCache;
  const repository = {
    getAccountBySession: vi.fn(async () => account),
    revokeAuthSession: vi.fn(async () => true),
    getLoginRetryAfter: vi.fn(async () => 0),
    clearLoginFailures: vi.fn(async () => undefined),
  } as unknown as PostgresEnterpriseCoreRepository;
  return { cache, repository, values };
}

describe('clustered enterprise shared state', () => {
  it('caches a session under a token digest and shares logout invalidation', async () => {
    const deps = dependencies();
    const state = createClusteredEnterpriseSharedState({
      ...deps,
      clock: () => Date.parse('2026-08-01T00:00:00.000Z'),
    });
    await state.cacheSession(
      'raw-session-token',
      '2026-08-01T00:01:00.000Z',
      account,
    );

    const expectedKey = `sessions:v1:${createHash('sha256')
      .update('raw-session-token')
      .digest('hex')}`;
    expect(deps.cache.set).toHaveBeenCalledWith(
      expectedKey,
      JSON.stringify(account),
      15_000,
    );
    expect(JSON.stringify([...deps.values])).not.toContain('raw-session-token');
    await expect(
      state.getAccountBySession('raw-session-token'),
    ).resolves.toEqual(account);
    expect(deps.repository.getAccountBySession).not.toHaveBeenCalled();

    await expect(state.revokeSession('raw-session-token')).resolves.toBe(true);
    expect(deps.repository.revokeAuthSession).toHaveBeenCalledWith(
      'raw-session-token',
    );
    expect(deps.values.size).toBe(0);
  });

  it('mirrors a durable PostgreSQL login block into Redis', async () => {
    const deps = dependencies();
    vi.mocked(deps.repository.getLoginRetryAfter).mockResolvedValue(120);
    const now = Date.parse('2026-08-01T00:00:00.000Z');
    const state = createClusteredEnterpriseSharedState({
      ...deps,
      clock: () => now,
    });

    await expect(state.getLoginRetryAfter('Admin')).resolves.toBe(120);
    const expectedKey = `login-blocks:v1:${createHash('sha256')
      .update('admin')
      .digest('hex')}`;
    expect(deps.cache.set).toHaveBeenCalledWith(
      expectedKey,
      String(now + 120_000),
      120_000,
    );
  });

  it('shares account presence across replicas without exposing account ids in keys', async () => {
    const deps = dependencies();
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const state = createClusteredEnterpriseSharedState({
      ...deps,
      clock: () => now,
    });

    await expect(
      state.touchAccountPresence({
        organizationId: 'org_default',
        accountId: 'acc_admin',
        clientId: 'desktop-main',
      }),
    ).resolves.toEqual({
      accountId: 'acc_admin',
      online: true,
      lastSeenAt: '2026-08-01T00:00:00.000Z',
    });
    const writtenKey = vi.mocked(deps.cache.set).mock.calls.at(-1)?.[0] ?? '';
    expect(writtenKey).toMatch(/^presence:v1:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(writtenKey).not.toContain('org_default');
    expect(writtenKey).not.toContain('acc_admin');

    await expect(
      state.listAccountPresence('org_default', ['acc_admin', 'acc_peer']),
    ).resolves.toEqual([
      {
        accountId: 'acc_admin',
        online: true,
        lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
      { accountId: 'acc_peer', online: false, lastSeenAt: null },
    ]);

    now += 60_001;
    await expect(
      state.listAccountPresence('org_default', ['acc_admin']),
    ).resolves.toEqual([
      {
        accountId: 'acc_admin',
        online: false,
        lastSeenAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
  });
});
