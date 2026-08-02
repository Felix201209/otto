/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClusteredEnterpriseServer } from './clusteredServer.js';
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
const peerAccount: PostgresEnterpriseAccountView = {
  ...account,
  id: 'acc_peer',
  username: 'peer',
  name: 'Peer',
  isAdmin: false,
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
      identifier === 'admin' && password === 'correct-password'
        ? account
        : null,
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
    getAccount: vi.fn(async (id: string) =>
      id === peerAccount.id ? peerAccount : id === account.id ? account : null,
    ),
  } as unknown as PostgresEnterpriseCoreRepository;
}

const servers: Array<
  ReturnType<typeof createClusteredEnterpriseServer>['server']
> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function listen(
  repo = repository(),
  options: NonNullable<
    Parameters<typeof createClusteredEnterpriseServer>[1]
  > = {},
) {
  const created = createClusteredEnterpriseServer(repo, {
    host: '127.0.0.1',
    port: 0,
    adminToken: 'system-admin-token',
    appVersion: '1.9.10',
    buildCommit: 'a'.repeat(40),
    ...options,
  });
  servers.push(created.server);
  await new Promise<void>((resolve) =>
    created.server.listen(0, '127.0.0.1', resolve),
  );
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
      body: JSON.stringify({
        identifier: 'admin',
        password: 'correct-password',
      }),
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

  it('relays MLS KeyPackages and opaque events through the PostgreSQL authority', async () => {
    const keyPackage = {
      reference: 'a'.repeat(64),
      accountId: 'acc_peer',
      deviceId: 'peer-device',
      ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
      keyPackage: Buffer.from('key-package').toString('base64'),
      createdAt: '2026-08-01T00:00:00.000Z',
      claimedAt: null,
    };
    const publishMlsKeyPackage = vi.fn(async () => keyPackage);
    const claimMlsKeyPackage = vi.fn(async () => keyPackage);
    const appendMlsTransportEvent = vi.fn(async () => ({
      sequence: 1,
      eventId: 'commit-1',
      conversationId: 'b'.repeat(64),
      senderAccountId: 'acc_admin',
      senderDeviceId: 'admin-device',
      recipientAccountId: null,
      recipientDeviceId: null,
      eventType: 'commit',
      epoch: 1,
      groupId: Buffer.from('group').toString('base64'),
      payload: Buffer.from('commit').toString('base64'),
      keyPackageReference: null,
      createdAt: '2026-08-01T00:00:01.000Z',
    }));
    const listMlsTransportEvents = vi.fn(async () => []);
    const repo = {
      ...repository(),
      publishMlsKeyPackage,
      claimMlsKeyPackage,
      appendMlsTransportEvent,
      listMlsTransportEvents,
    } as unknown as PostgresEnterpriseCoreRepository;
    const { baseUrl } = await listen(repo);
    const headers = {
      authorization: 'Bearer clustered-session-token',
      'content-type': 'application/json',
    };

    const publish = await fetch(`${baseUrl}/enterprise/e2ee/mls/key-packages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deviceId: 'admin-device',
        ciphersuite: keyPackage.ciphersuite,
        keyPackage: keyPackage.keyPackage,
      }),
    });
    expect(publish.status).toBe(201);
    const claim = await fetch(
      `${baseUrl}/enterprise/e2ee/mls/key-packages/claim`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          requesterDeviceId: 'admin-device',
          recipientAccountId: 'acc_peer',
        }),
      },
    );
    expect(claim.status).toBe(200);
    const eventsUrl = `${baseUrl}/enterprise/e2ee/mls/conversations/acc_peer/events`;
    const appended = await fetch(eventsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        senderDeviceId: 'admin-device',
        eventId: 'commit-1',
        eventType: 'commit',
        epoch: 1,
        groupId: Buffer.from('group').toString('base64'),
        payload: Buffer.from('commit').toString('base64'),
      }),
    });
    expect(appended.status).toBe(201);
    const listed = await fetch(eventsUrl, { headers });
    expect(listed.status).toBe(200);

    expect(publishMlsKeyPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        accountId: 'acc_admin',
        deviceId: 'admin-device',
      }),
    );
    expect(claimMlsKeyPackage).toHaveBeenCalledWith(
      expect.objectContaining({ recipientAccountId: 'acc_peer' }),
    );
    expect(appendMlsTransportEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'commit', epoch: 1 }),
    );
    expect(listMlsTransportEvents).toHaveBeenCalled();

    const health = (await (
      await fetch(`${baseUrl}/enterprise/health`)
    ).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain('e2ee_mls_transport_v1');
    expect(health.capabilities).toContain(
      'e2ee_mls_resource_governance_v1',
    );
    expect(health.capabilities).toContain(
      'e2ee_mls_transport_session_reset_v1',
    );
    expect(health.capabilities).not.toContain('e2ee_mls_v1');
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

  it('issues organization invites through PostgreSQL without exposing a stored code', async () => {
    const issueOrganizationInvite = vi.fn(async () => ({
      id: 'orginvite_1',
      organizationId: 'org_default',
      code: 'ABCD-EFGH-JKLM',
      status: 'active' as const,
      defaultDepartment: null,
      departmentId: null,
      positionId: null,
      positionTitle: null,
      defaultRole: null,
      maxUses: 3,
      usedCount: 0,
      issuedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-08T00:00:00.000Z',
      validHours: 168 as const,
    }));
    const repo = {
      ...repository(),
      issueOrganizationInvite,
    } as unknown as PostgresEnterpriseCoreRepository;
    const { baseUrl } = await listen(repo, {
      publicUrl: 'https://join.otto.example',
    });

    const response = await fetch(`${baseUrl}/enterprise/organization/invite`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer clustered-session-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ maxUses: 3 }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      invite: {
        code: 'ABCD-EFGH-JKLM',
        link: 'https://join.otto.example/enterprise/join/ABCD-EFGH-JKLM',
      },
    });
    expect(issueOrganizationInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        createdByAccountId: 'acc_admin',
        maxUses: 3,
      }),
    );
  });

  it('serves active public invitation pages from PostgreSQL inspection state', async () => {
    const repo = {
      ...repository(),
      inspectOrganizationInvite: vi.fn(async () => ({
        status: 'active' as const,
        organizationId: 'org_default',
      })),
    } as unknown as PostgresEnterpriseCoreRepository;
    const { baseUrl } = await listen(repo, {
      publicUrl: 'https://join.otto.example',
    });

    const response = await fetch(`${baseUrl}/enterprise/join/ABCD-EFGH-JKLM`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('ABCD-EFGH-JKLM');
  });

  it('requests and completes SMS registration through PostgreSQL state', async () => {
    const requestSmsRegistration = vi.fn(async () => ({
      state: 'issued' as const,
      challengeId: 'smsreg_1',
      expiresAt: '2026-08-01T00:05:00.000Z',
      retryAfterSeconds: 60,
      registrationMode: 'personal' as const,
      organization: null,
    }));
    const completeSmsRegistration = vi.fn(async () => ({
      state: 'registered' as const,
      account: { ...account, id: 'acc_new', accountType: 'personal' as const },
    }));
    const repo = {
      ...repository(),
      requestSmsRegistration,
      discardSmsRegistrationChallenge: vi.fn(async () => undefined),
      completeSmsRegistration,
    } as unknown as PostgresEnterpriseCoreRepository;
    const smsSender = {
      sendVerificationCode: vi.fn(async () => true),
    };
    const { baseUrl } = await listen(repo, { smsSender });

    const request = await fetch(
      `${baseUrl}/enterprise/auth/register/sms/request`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '13800138000' }),
      },
    );
    expect(request.status).toBe(200);
    expect(await request.json()).toMatchObject({
      challengeId: 'smsreg_1',
      registrationMode: 'personal',
    });
    expect(smsSender.sendVerificationCode).toHaveBeenCalledWith(
      '13800138000',
      expect.stringMatching(/^\d{6}$/),
    );

    const verify = await fetch(
      `${baseUrl}/enterprise/auth/register/sms/verify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: 'smsreg_1',
          code: '123456',
          name: 'New User',
          password: 'Secure-password-2026',
          legalConsent: true,
        }),
      },
    );
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({
      account: { id: 'acc_new', accountType: 'personal' },
      token: 'clustered-session-token',
      legalConsentRecorded: true,
    });
    expect(completeSmsRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: 'smsreg_1',
        code: '123456',
        legalConsent: true,
      }),
    );
  });

  it('joins a personal account to an enterprise and expires stale sessions', async () => {
    const personal = {
      ...account,
      id: 'acc_personal',
      organizationId: 'org_personal',
      organizationName: 'Personal',
      accountType: 'personal' as const,
      isAdmin: false,
    };
    const joined = {
      ...personal,
      organizationId: 'org_default',
      organizationName: 'Otto',
      accountType: 'enterprise' as const,
    };
    const joinOrganizationWithInvite = vi.fn(async () => ({
      state: 'joined' as const,
      account: joined,
    }));
    const repo = {
      ...repository(),
      getAccountBySession: vi.fn(async () => personal),
      joinOrganizationWithInvite,
    } as unknown as PostgresEnterpriseCoreRepository;
    const { baseUrl } = await listen(repo);

    const response = await fetch(
      `${baseUrl}/enterprise/auth/join-organization`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer personal-session',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ inviteCode: 'ABCD-EFGH-JKLM' }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      account: { id: 'acc_personal', organizationId: 'org_default' },
      requiresLogin: true,
    });
    expect(joinOrganizationWithInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc_personal',
        inviteCode: 'ABCD-EFGH-JKLM',
      }),
    );
  });

  it('does not authorize an empty configured system token', async () => {
    const repo = repository();
    const created = createClusteredEnterpriseServer(repo, {
      host: '127.0.0.1',
      port: 0,
      adminToken: '',
    });
    servers.push(created.server);
    await new Promise<void>((resolve) =>
      created.server.listen(0, '127.0.0.1', resolve),
    );
    const address = created.server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/enterprise/accounts`,
      { headers: { 'x-otto-admin-token': '' } },
    );
    expect(response.status).toBe(401);
  });

  it('stores only E2EE ciphertext through the shared attachment service', async () => {
    const putInlineCiphertext = vi.fn(async () => ({
      id: 'att_01',
      state: 'available',
      ciphertextBytes: 32,
      ciphertextSha256: 'b'.repeat(64),
      encryption: 'e2ee-client-v1',
      expiresAt: '2026-08-01T01:00:00.000Z',
      location: { backend: 's3', key: 'attachments/v1/opaque.bin' },
    }));
    const attachmentStorage = {
      putInlineCiphertext,
    } as unknown as NonNullable<
      Parameters<typeof createClusteredEnterpriseServer>[1]
    >['attachmentStorage'];
    const { baseUrl } = await listen(repository(), { attachmentStorage });
    const ciphertext = Buffer.alloc(32, 7);

    const response = await fetch(`${baseUrl}/enterprise/attachments/inline`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer clustered-session-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        peerAccountId: 'acc_peer',
        attachmentId: 'att_01',
        ciphertext: ciphertext.toString('base64'),
        ciphertextSha256: 'b'.repeat(64),
      }),
    });

    expect(response.status).toBe(201);
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      attachment: {
        id: 'att_01',
        state: 'available',
        ciphertextBytes: 32,
        ciphertextSha256: 'b'.repeat(64),
        encryption: 'e2ee-client-v1',
        expiresAt: '2026-08-01T01:00:00.000Z',
      },
    });
    expect(JSON.stringify(responseBody)).not.toContain('opaque.bin');
    expect(putInlineCiphertext).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        accountId: 'acc_admin',
        attachmentId: 'att_01',
        encryption: 'e2ee-client-v1',
        authorizedAccountIds: ['acc_peer'],
        ciphertext,
      }),
    );
  });
});
