/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createClusteredEnterpriseServer,
} from './clusteredServer.js';
import type {
  PostgresEnterpriseAccountView,
  PostgresEnterpriseCoreRepository,
} from './postgresCoreRepository.js';

const account: PostgresEnterpriseAccountView = {
  id: 'acc_admin',
  organizationId: 'org_default',
  organizationName: 'Otto',
  accountType: 'enterprise',
  employeeId: null,
  username: 'admin',
  phone: null,
  feishuOpenId: null,
  name: 'Administrator',
  role: 'Administrator',
  department: 'IT',
  departmentId: null,
  positionId: null,
  positionTitle: null,
  avatarUrl: null,
  isAdmin: true,
  status: 'active',
  tags: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function repository(): PostgresEnterpriseCoreRepository {
  return {
    defaultOrganizationId: 'org_default',
    readiness: vi.fn(async () => ({
      ready: true,
      backend: 'postgresql',
      schemaVersion: 4,
      organizations: 1,
      accounts: 1,
    })),
    authenticateAccount: vi.fn(async (identifier: string, password: string) =>
      identifier === 'admin' && password === 'correct-password' ? account : null,
    ),
    getLoginRetryAfter: vi.fn(async () => 0),
    recordLoginFailure: vi.fn(async () => 0),
    clearLoginFailures: vi.fn(async () => undefined),
    createAuthSession: vi.fn(async () => ({
      token: 'clustered-session-token',
      expiresAt: '2026-09-01T00:00:00.000Z',
    })),
    getAccountBySession: vi.fn(async (token: string) =>
      token === 'clustered-session-token' ? account : null,
    ),
    revokeAuthSession: vi.fn(async () => true),
  } as unknown as PostgresEnterpriseCoreRepository;
}

const servers: Array<
  ReturnType<typeof createClusteredEnterpriseServer>['server']
> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function listen(repo = repository()) {
  const created = createClusteredEnterpriseServer(repo, {
    host: '127.0.0.1',
    port: 0,
    adminToken: 'system-admin-token',
    appVersion: '1.9.10',
    buildCommit: 'a'.repeat(40),
  });
  servers.push(created.server);
  await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const address = created.server.address() as AddressInfo;
  return {
    repo,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

describe('clustered PostgreSQL enterprise server', () => {
  it('publishes PostgreSQL authority readiness without touching SQLite', async () => {
    const { baseUrl } = await listen();
    const response = await fetch(`${baseUrl}/enterprise/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      topology: { mode: 'clustered-enterprise', database: 'postgresql' },
      authority: { ready: true, backend: 'postgresql', schemaVersion: 4 },
    });
  });

  it('serves password login and session lookup from the async repository', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const login = await fetch(`${baseUrl}/enterprise/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin', password: 'correct-password' }),
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({
      account: { id: 'acc_admin', organizationId: 'org_default' },
      token: 'clustered-session-token',
    });

    const me = await fetch(`${baseUrl}/enterprise/auth/me`, {
      headers: { authorization: 'Bearer clustered-session-token' },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ account: { username: 'admin' } });
    expect(repo.authenticateAccount).toHaveBeenCalledWith(
      'admin',
      'correct-password',
    );
    expect(repo.clearLoginFailures).toHaveBeenCalledWith('admin');
  });

  it('enforces a PostgreSQL-shared login block before checking credentials', async () => {
    const repo = repository();
    vi.mocked(repo.getLoginRetryAfter).mockResolvedValue(45);
    const { baseUrl } = await listen(repo);

    const response = await fetch(`${baseUrl}/enterprise/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin', password: 'guess' }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('45');
    expect(await response.json()).toMatchObject({
      code: 'LOGIN_RATE_LIMITED',
      retryAfterSeconds: 45,
    });
    expect(repo.authenticateAccount).not.toHaveBeenCalled();
  });

  it('fails closed for routes that have not moved to PostgreSQL', async () => {
    const { baseUrl } = await listen();
    const response = await fetch(`${baseUrl}/enterprise/knowledge`, {
      headers: { authorization: 'Bearer clustered-session-token' },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'POSTGRES_ROUTE_NOT_MIGRATED',
      path: '/enterprise/knowledge',
    });
  });

  it('does not authorize an empty configured system token', async () => {
    const repo = repository();
    const created = createClusteredEnterpriseServer(repo, {
      host: '127.0.0.1',
      port: 0,
      adminToken: '',
    });
    servers.push(created.server);
    await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve));
    const address = created.server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/enterprise/accounts`,
      { headers: { 'x-otto-admin-token': '' } },
    );
    expect(response.status).toBe(401);
  });
});
