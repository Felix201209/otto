/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CURRENT_LEGAL_DOCUMENTS,
  currentLegalDocumentReferences,
  dataGovernanceConfiguration,
  dataProcessingInventory,
  legalDocumentHash,
} from '../modules/data_governance/index.js';
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
  const getDataGovernanceProfile = vi.fn(async () => ({
    ...dataGovernanceConfiguration(),
    documents: CURRENT_LEGAL_DOCUMENTS.map((document) => ({
      ...document,
      hash: legalDocumentHash(document),
      accepted: false,
      acceptedAt: null,
    })),
    processingActivities: dataProcessingInventory(),
    rights: [],
    currentConsentComplete: false,
  }));
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
      token === 'clustered-session-token'
        ? account
        : token === 'peer-session-token'
          ? peerAccount
          : null,
    ),
    revokeAuthSession: vi.fn(async () => true),
    getOrganizationFeatures: vi.fn(async () => ({
      enterprise_tree: true,
      direct_messages: true,
      atoa: true,
      park_services: true,
      knowledge: true,
      skill_market: true,
    })),
    updateOrganizationFeatures: vi.fn(async (_organizationId, patch) => ({
      enterprise_tree: true,
      direct_messages: true,
      atoa: true,
      park_services: true,
      knowledge: patch.knowledge ?? true,
      skill_market: patch.skill_market ?? true,
    })),
    listAccountSyncSnapshots: vi.fn(async () => []),
    putAccountSyncSnapshot: vi.fn(async (input) => ({
      scope: input.scope,
      version: input.expectedVersion + 1,
      payload: input.payload,
      payloadHash: 'a'.repeat(64),
      deviceId: input.deviceId ?? null,
      updatedAtMs: Date.parse('2026-08-01T00:00:00.000Z'),
    })),
    listBusinessRecords: vi.fn(async () => []),
    getBusinessRecord: vi.fn(async () => null),
    createBusinessRecord: vi.fn(async (input) => ({
      organizationId: input.organizationId,
      domain: input.domain,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? 'resource-1',
      ownerAccountId: input.ownerAccountId ?? null,
      status: input.status ?? 'active',
      version: 1,
      payload: input.payload,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })),
    updateBusinessRecord: vi.fn(async () => null),
    appendBusinessEvent: vi.fn(async (input) => ({
      organizationId: input.organizationId,
      domain: input.domain,
      eventId: input.eventId ?? 'event-1',
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      actorAccountId: input.actorAccountId ?? null,
      eventType: input.eventType,
      payload: input.payload,
      createdAt: '2026-08-01T00:00:00.000Z',
      inserted: true,
    })),
    listBusinessEvents: vi.fn(async () => []),
    findActiveParkInvite: vi.fn(async () => null),
    listParkTenantMemberships: vi.fn(async () => []),
    listTicketRecordsForAccount: vi.fn(async () => []),
    listAddressedBusinessRecords: vi.fn(async () => []),
    exportAccountData: vi.fn(async (target) => ({
      format: 'otto-account-export-v1',
      account: target,
    })),
    deleteOwnAccountData: vi.fn(async (target) => ({
      accountId: target.id,
      deletedAt: '2026-08-01T00:00:00.000Z',
      mode: 'cryptographic_and_soft_delete' as const,
    })),
    getDataGovernanceProfile,
    recordCurrentLegalConsent: vi.fn(async () => undefined),
    getAccount: vi.fn(async (id: string) =>
      id === peerAccount.id ? peerAccount : id === account.id ? account : null,
    ),
    getOrganization: vi.fn(async (id: string) =>
      id === account.organizationId
        ? {
            id,
            name: account.organizationName,
            slug: 'otto',
            parkId: null,
            status: 'active' as const,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
          }
        : null,
    ),
    listAccounts: vi.fn(async (organizationId: string) =>
      organizationId === account.organizationId ? [account, peerAccount] : [],
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
      capabilities: expect.arrayContaining([
        'sms_registration',
        'personal_registration',
        'data_governance_v1',
      ]),
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

  it('serves complete versioned legal text and records exact document consent', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const legal = await fetch(`${baseUrl}/enterprise/legal`, {
      headers: { accept: 'text/html' },
    });
    expect(legal.status).toBe(200);
    const html = await legal.text();
    expect(html).toContain('正文 SHA-256');
    expect(html).toContain(CURRENT_LEGAL_DOCUMENTS[0]!.sections[0]!.title);

    const privacy = await fetch(`${baseUrl}/enterprise/privacy`, {
      headers: { authorization: 'Bearer clustered-session-token' },
    });
    expect(privacy.status).toBe(200);
    expect(await privacy.json()).toMatchObject({
      currentConsentComplete: false,
      authorization: {
        license: { status: 'unavailable', enforce: true },
        dataBoundary: { authority: 'postgresql' },
      },
    });

    const stale = await fetch(`${baseUrl}/enterprise/privacy/accept`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer clustered-session-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ accepted: true, documents: [] }),
    });
    expect(stale.status).toBe(409);

    const references = currentLegalDocumentReferences();
    const accepted = await fetch(`${baseUrl}/enterprise/privacy/accept`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer clustered-session-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ accepted: true, documents: references }),
    });
    expect(accepted.status).toBe(200);
    expect(repo.recordCurrentLegalConsent).toHaveBeenCalledWith(
      account,
      references,
    );
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
    const listMlsKeyPackageInventory = vi.fn(async () => [
      {
        reference: keyPackage.reference,
        expiresAt: '2026-08-08T00:00:00.000Z',
      },
    ]);
    const retireMlsKeyPackage = vi.fn(async () => true);
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
    const listMlsInboundConversationPeers = vi.fn(async () => ['acc_peer']);
    const repo = {
      ...repository(),
      publishMlsKeyPackage,
      listMlsKeyPackageInventory,
      retireMlsKeyPackage,
      claimMlsKeyPackage,
      appendMlsTransportEvent,
      listMlsTransportEvents,
      listMlsInboundConversationPeers,
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
        keyPackageReference: keyPackage.reference,
        keyPackage: keyPackage.keyPackage,
      }),
    });
    expect(publish.status).toBe(201);
    const inventory = await fetch(
      `${baseUrl}/enterprise/e2ee/mls/key-packages/inventory?deviceId=admin-device`,
      { headers },
    );
    expect(inventory.status).toBe(200);
    expect(inventory.headers.get('cache-control')).toBe('no-store');
    await expect(inventory.json()).resolves.toEqual({
      deviceId: 'admin-device',
      keyPackages: [
        {
          reference: keyPackage.reference,
          expiresAt: '2026-08-08T00:00:00.000Z',
        },
      ],
    });
    const retired = await fetch(
      `${baseUrl}/enterprise/e2ee/mls/key-packages/${keyPackage.reference}?deviceId=admin-device`,
      { method: 'DELETE', headers },
    );
    expect(retired.status).toBe(200);
    await expect(retired.json()).resolves.toEqual({
      deviceId: 'admin-device',
      reference: keyPackage.reference,
      retired: true,
    });
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
    const inbound = await fetch(
      `${baseUrl}/enterprise/e2ee/mls/inbound-conversations?deviceId=admin-device&afterPeerAccountId=acc_aaron&limit=25`,
      { headers },
    );
    expect(inbound.status).toBe(200);
    expect(inbound.headers.get('cache-control')).toBe('no-store');
    await expect(inbound.json()).resolves.toEqual({
      peerAccountIds: ['acc_peer'],
    });
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
        reference: keyPackage.reference,
      }),
    );
    expect(listMlsKeyPackageInventory).toHaveBeenCalledWith({
      organizationId: 'org_default',
      accountId: 'acc_admin',
      deviceId: 'admin-device',
    });
    expect(retireMlsKeyPackage).toHaveBeenCalledWith({
      organizationId: 'org_default',
      accountId: 'acc_admin',
      deviceId: 'admin-device',
      reference: keyPackage.reference,
    });
    expect(claimMlsKeyPackage).toHaveBeenCalledWith(
      expect.objectContaining({ recipientAccountId: 'acc_peer' }),
    );
    expect(appendMlsTransportEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'commit', epoch: 1 }),
    );
    expect(listMlsTransportEvents).toHaveBeenCalled();
    expect(listMlsInboundConversationPeers).toHaveBeenCalledWith({
      organizationId: 'org_default',
      accountId: 'acc_admin',
      deviceId: 'admin-device',
      afterPeerAccountId: 'acc_aaron',
      limit: 25,
    });

    const health = (await (
      await fetch(`${baseUrl}/enterprise/health`)
    ).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain('e2ee_mls_transport_v1');
    expect(health.capabilities).toContain('e2ee_mls_resource_governance_v1');
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

  it('serves account sync from the PostgreSQL tenant authority', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const response = await fetch(`${baseUrl}/enterprise/account-sync`, {
      method: 'PUT',
      headers: { authorization: 'Bearer clustered-session-token' },
      body: JSON.stringify({
        scope: 'worklog',
        expectedVersion: 0,
        deviceId: 'desktop-1',
        payload: {
          schemaVersion: 1,
          generatedAt: '2026-08-01T00:00:00.000Z',
          files: [],
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      snapshot: { scope: 'worklog', version: 1, deviceId: 'desktop-1' },
    });
    expect(repo.putAccountSyncSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        accountId: 'acc_admin',
        expectedVersion: 0,
      }),
    );
  });

  it('stores knowledge and skills under the authenticated PostgreSQL tenant', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const headers = {
      authorization: 'Bearer clustered-session-token',
      'content-type': 'application/json',
    };
    const knowledge = await fetch(`${baseUrl}/enterprise/knowledge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        category: 'runbook',
        content: 'Restore from PITR.',
      }),
    });
    expect(knowledge.status).toBe(200);
    await expect(knowledge.json()).resolves.toMatchObject({
      added: true,
      reviewStatus: 'active',
    });

    const skill = await fetch(`${baseUrl}/enterprise/skills`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Incident triage',
        description: 'Classifies and routes incidents.',
        content: '# Incident triage\n\nFollow the verified runbook.',
        visibility: 'company',
      }),
    });
    expect(skill.status).toBe(201);
    await expect(skill.json()).resolves.toMatchObject({
      outcome: 'submitted',
      skill: { name: 'Incident triage', status: 'active' },
    });
    expect(repo.createBusinessRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        domain: 'skills',
        ownerAccountId: 'acc_admin',
      }),
    );
  });

  it('accepts the desktop feature PATCH contract for migrated domains', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const response = await fetch(
      `${baseUrl}/enterprise/organization/features`,
      {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer clustered-session-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ knowledge: false, skill_market: false }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      features: { knowledge: false, skill_market: false },
    });
    expect(repo.updateOrganizationFeatures).toHaveBeenCalledWith(
      'org_default',
      { knowledge: false, skill_market: false },
    );
  });

  it('mounts park, ticketing and commercial control on PostgreSQL authority', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const headers = {
      authorization: 'Bearer clustered-session-token',
      'content-type': 'application/json',
    };

    const park = await fetch(`${baseUrl}/enterprise/park`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Otto Campus' }),
    });
    expect(park.status).toBe(200);
    await expect(park.json()).resolves.toMatchObject({
      park: { name: 'Otto Campus' },
    });

    const ticket = await fetch(`${baseUrl}/enterprise/tickets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        serviceId: 'it',
        title: 'PostgreSQL cutover check',
        description: 'Verify the authoritative route.',
      }),
    });
    expect(ticket.status).toBe(201);
    await expect(ticket.json()).resolves.toMatchObject({
      ticket: { title: 'PostgreSQL cutover check', status: 'open' },
    });

    const deployment = await fetch(`${baseUrl}/enterprise/deployment/status`, {
      headers,
    });
    expect(deployment.status).toBe(200);
    await expect(deployment.json()).resolves.toMatchObject({
      authority: 'postgresql',
      dataBoundary: {
        messageContent: 'client_e2ee_ciphertext_only',
        clientIdentityPrivateKeys: 'client_only',
      },
    });
    expect(repo.createBusinessRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_default',
        domain: 'ticketing',
      }),
    );
  });

  it('preserves member update-policy and module-manifest contracts', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const authorization = 'Bearer peer-session-token';
    const policy = await fetch(
      `${baseUrl}/enterprise/deployment/update-policy`,
      {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          distributionId: 'desktop-win32-x64',
          currentVersion: '1.10.0',
        }),
      },
    );
    expect(policy.status).toBe(200);
    await expect(policy.json()).resolves.toEqual({
      status: 'not_configured',
      reason: 'online_license_required',
    });

    const manifest = await fetch(
      `${baseUrl}/enterprise/modules/updates/client`,
      { headers: { authorization } },
    );
    expect(manifest.status).toBe(200);
    await expect(manifest.json()).resolves.toMatchObject({
      format: 'otto-module-updates-v1',
      deploymentId: 'clustered-enterprise',
      modules: [],
    });
  });

  it('exports and deletes account data through the PostgreSQL repository', async () => {
    const repo = repository();
    const { baseUrl } = await listen(repo);
    const authorization = 'Bearer clustered-session-token';
    const exported = await fetch(`${baseUrl}/enterprise/privacy/export`, {
      headers: { authorization },
    });
    expect(exported.status).toBe(200);
    await expect(exported.json()).resolves.toMatchObject({
      format: 'otto-account-export-v1',
      account: { id: 'acc_admin', organizationId: 'org_default' },
    });

    const deleted = await fetch(`${baseUrl}/enterprise/privacy/account`, {
      method: 'DELETE',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        password: 'correct-password',
        confirmation: '注销我的 Otto 账号',
      }),
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      accountId: 'acc_admin',
      mode: 'cryptographic_and_soft_delete',
    });
    expect(repo.deleteOwnAccountData).toHaveBeenCalledWith(account);
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
          legalDocuments: currentLegalDocumentReferences(),
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
        legalDocuments: currentLegalDocumentReferences(),
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
