import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MlsGroupInspection, MlsKeyPackage } from '@otto/native';

import {
  EnterpriseMlsSessionCoordinator,
  EnterpriseMlsSessionManager,
  enterpriseMlsDirectConversationId,
  type EnterpriseMlsSessionOperations,
  type EnterpriseMlsTransportClient,
  type EnterpriseMlsTransportEvent,
  type EnterpriseMlsKernel,
  type EnterpriseMlsKernelFactoryInput,
} from './enterprise-mls.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'otto-enterprise-mls-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function identity(
  overrides: Partial<
    Parameters<EnterpriseMlsSessionManager['activate']>[0]
  > = {},
) {
  return {
    serverUrl: 'https://enterprise.example.test/base/',
    organizationId: 'org-a',
    accountId: 'account-a',
    deviceId: 'device-a',
    approvalState: 'approved' as const,
    ...overrides,
  };
}

function fakeKernel() {
  const groupState = {
    protocol: 'mls10-openmls-0.8' as const,
    conversation_id: 'conversation-placeholder',
    group_id: 'Z3JvdXA=',
    epoch: 1,
    member_count: 2,
  };
  return {
    init: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    createKeyPackage: vi.fn(async () => ({
      protocol: 'mls10-openmls-0.8' as const,
      ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const,
      reference: 'a'.repeat(64),
      key_package: 'S2V5UGFja2FnZQ==',
    })),
    listKeyPackages: vi.fn(async (): Promise<MlsKeyPackage[]> => []),
    consumeKeyPackage: vi.fn(async () => undefined),
    createGroup: vi.fn(async (conversationId: string) => ({
      ...groupState,
      conversation_id: conversationId,
      epoch: 0,
      member_count: 1,
    })),
    addMember: vi.fn(async (conversationId: string) => ({
      protocol: 'mls10-openmls-0.8' as const,
      conversation_id: conversationId,
      group_id: 'Z3JvdXA=',
      epoch: 1,
      key_package_reference: 'b'.repeat(64),
      recipient_device_id: 'device-b',
      commit: 'Y29tbWl0',
      welcome: 'd2VsY29tZQ==',
    })),
    mergePendingCommit: vi.fn(async (conversationId: string) => ({
      ...groupState,
      conversation_id: conversationId,
    })),
    inspectGroup: vi.fn(async (conversationId: string) => ({
      ...groupState,
      conversation_id: conversationId,
      pending_commit: false,
      pending_invitation: null,
    })),
    joinGroup: vi.fn(async (conversationId: string) => ({
      ...groupState,
      conversation_id: conversationId,
    })),
    encryptApplication: vi.fn(async (conversationId: string) => ({
      protocol: 'mls10-openmls-0.8' as const,
      conversation_id: conversationId,
      group_id: 'Z3JvdXA=',
      epoch: 1,
      ciphertext: 'Y2lwaGVydGV4dA==',
    })),
    decryptApplication: vi.fn(async (conversationId: string) => ({
      protocol: 'mls10-openmls-0.8' as const,
      conversationId,
      groupId: 'Z3JvdXA=',
      epoch: 1,
      senderDeviceScope: 'server/org-a/account-b/device-b',
      plaintext: new Uint8Array([1, 2, 3]),
    })),
    transportCursor: vi.fn(async () => 0),
    acknowledgeTransportEvent: vi.fn(async () => undefined),
    decryptTransportApplication: vi.fn(async (conversationId: string) => ({
      protocol: 'mls10-openmls-0.8' as const,
      conversationId,
      groupId: 'Z3JvdXA=',
      epoch: 1,
      senderDeviceScope: 'server/org-a/account-b/device-b',
      plaintext: new Uint8Array([1, 2, 3]),
    })),
  } satisfies EnterpriseMlsKernel;
}

describe('EnterpriseMlsSessionManager', () => {
  it('activates an approved device with OS-protected encrypted persistence', async () => {
    const stateDirectory = await temporaryDirectory();
    const kernel = fakeKernel();
    const protect = vi.fn((plaintext: string) =>
      Buffer.from(`protected:${plaintext}`, 'utf8').toString('base64'),
    );
    const unprotect = vi.fn((protectedValue: string) =>
      Buffer.from(protectedValue, 'base64')
        .toString('utf8')
        .slice('protected:'.length),
    );
    const factory = vi.fn((input: EnterpriseMlsKernelFactoryInput) => {
      kernel.init.mockImplementationOnce(async () => {
        await input.persistence.create(
          Uint8Array.from({ length: 32 }, (_, index) => index + 1),
          '{"ciphertext":"native-state"}',
        );
      });
      return kernel;
    });
    const manager = new EnterpriseMlsSessionManager({
      stateDirectory,
      secureStorage: {
        assertAvailable: vi.fn(),
        protect,
        unprotect,
      },
      kernelFactory: factory,
    });

    const ready = await manager.activate(identity());
    expect(ready).toMatchObject({
      state: 'ready',
      protocol: 'mls10-openmls-0.8',
    });
    expect(factory).toHaveBeenCalledOnce();
    expect(kernel.init).toHaveBeenCalledOnce();
    const factoryInput = factory.mock.calls[0]![0];
    expect(factoryInput.scope).toMatchObject({
      organizationId: 'org-a',
      accountId: 'account-a',
      deviceId: 'device-a',
    });
    expect(factoryInput.statePath).toMatch(/[\\/]state-[a-f0-9]{64}\.json$/);
    expect(factoryInput.statePath).not.toContain('account-a');
    expect(factoryInput.statePath).not.toContain('device-a');
    const manifest = await readFile(factoryInput.statePath, 'utf8');
    expect(manifest).not.toContain(
      Buffer.from(
        Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      ).toString('base64'),
    );
    expect(manifest).toContain('native-state');
    expect(protect).toHaveBeenCalledOnce();
    expect(unprotect).not.toHaveBeenCalled();

    await expect(manager.activate(identity())).resolves.toEqual(ready);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('refuses pending devices before creating a native kernel', async () => {
    const factory = vi.fn(() => fakeKernel());
    const manager = new EnterpriseMlsSessionManager({
      stateDirectory: await temporaryDirectory(),
      secureStorage: {
        assertAvailable: vi.fn(),
        protect: vi.fn(),
        unprotect: vi.fn(),
      },
      kernelFactory: factory,
    });

    await expect(
      manager.activate(identity({ approvalState: 'pending' })),
    ).rejects.toThrow('approved');
    expect(factory).not.toHaveBeenCalled();
    expect(manager.status()).toMatchObject({
      state: 'blocked',
      reason: 'device-not-approved',
    });
  });

  it('fails closed when OS secure storage is unavailable', async () => {
    const factory = vi.fn(() => fakeKernel());
    const manager = new EnterpriseMlsSessionManager({
      stateDirectory: await temporaryDirectory(),
      secureStorage: {
        assertAvailable: () => {
          throw new Error('secure storage unavailable');
        },
        protect: vi.fn(),
        unprotect: vi.fn(),
      },
      kernelFactory: factory,
    });

    await expect(manager.activate(identity())).rejects.toThrow(
      'secure storage unavailable',
    );
    expect(factory).not.toHaveBeenCalled();
    expect(manager.status()).toMatchObject({
      state: 'blocked',
      reason: 'secure-storage-unavailable',
    });
  });

  it('closes the old kernel before switching device scope', async () => {
    const first = fakeKernel();
    const second = fakeKernel();
    const factory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const manager = new EnterpriseMlsSessionManager({
      stateDirectory: await temporaryDirectory(),
      secureStorage: {
        assertAvailable: vi.fn(),
        protect: vi.fn((value) => value),
        unprotect: vi.fn((value) => value),
      },
      kernelFactory: factory,
    });

    await manager.activate(identity());
    await manager.activate(
      identity({ accountId: 'account-b', deviceId: 'device-b' }),
    );
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.init).toHaveBeenCalledOnce();
  });

  it('closes and blocks a kernel whose encrypted state cannot initialize', async () => {
    const kernel = fakeKernel();
    kernel.init.mockRejectedValueOnce(
      new Error('snapshot authentication failed'),
    );
    const manager = new EnterpriseMlsSessionManager({
      stateDirectory: await temporaryDirectory(),
      secureStorage: {
        assertAvailable: vi.fn(),
        protect: vi.fn((value) => value),
        unprotect: vi.fn((value) => value),
      },
      kernelFactory: vi.fn(() => kernel),
    });

    await expect(manager.activate(identity())).rejects.toThrow(
      'snapshot authentication failed',
    );
    expect(kernel.close).toHaveBeenCalledOnce();
    expect(manager.status()).toMatchObject({
      state: 'blocked',
      reason: 'native-initialization-failed',
    });
  });

  it('binds every native group operation to the deterministic account pair', async () => {
    const kernel = fakeKernel();
    const manager = new EnterpriseMlsSessionManager({
      stateDirectory: await temporaryDirectory(),
      secureStorage: {
        assertAvailable: vi.fn(),
        protect: vi.fn((value) => value),
        unprotect: vi.fn((value) => value),
      },
      kernelFactory: vi.fn(() => kernel),
    });
    await manager.activate(identity());
    const conversationId = enterpriseMlsDirectConversationId({
      organizationId: 'org-a',
      accountId: 'account-a',
      peerAccountId: 'account-b',
    });

    await manager.createGroup('account-b');
    await manager.encryptApplication('account-b', new Uint8Array([1]));
    await manager.decryptApplication('account-b', 'Y2lwaGVydGV4dA==');
    await manager.transportCursor('account-b');
    await manager.advanceTransportCursor('account-b', 4);
    await manager.decryptTransportApplication(
      'account-b',
      'Y2lwaGVydGV4dA==',
      5,
    );

    expect(kernel.createGroup).toHaveBeenCalledWith(conversationId);
    expect(kernel.encryptApplication).toHaveBeenCalledWith(
      conversationId,
      new Uint8Array([1]),
    );
    expect(kernel.decryptApplication).toHaveBeenCalledWith(
      conversationId,
      'Y2lwaGVydGV4dA==',
    );
    expect(kernel.transportCursor).toHaveBeenCalledWith(conversationId);
    expect(kernel.acknowledgeTransportEvent).toHaveBeenCalledWith(
      conversationId,
      4,
    );
    expect(kernel.decryptTransportApplication).toHaveBeenCalledWith(
      conversationId,
      'Y2lwaGVydGV4dA==',
      5,
    );
  });

  it('resets only an active MLS security state and fails closed on reset errors', async () => {
    const kernel = fakeKernel();
    const manager = new EnterpriseMlsSessionManager({
      stateDirectory: await temporaryDirectory(),
      secureStorage: {
        assertAvailable: vi.fn(),
        protect: vi.fn((value) => value),
        unprotect: vi.fn((value) => value),
      },
      kernelFactory: vi.fn(() => kernel),
    });

    await expect(manager.resetSecurityState()).rejects.toThrow('not ready');
    await manager.activate(identity());
    await expect(manager.resetSecurityState()).resolves.toBeUndefined();
    expect(kernel.reset).toHaveBeenCalledOnce();
    expect(manager.status().state).toBe('ready');

    kernel.reset.mockRejectedValueOnce(new Error('state clear failed'));
    await expect(manager.resetSecurityState()).rejects.toThrow(
      'state clear failed',
    );
    expect(kernel.close).toHaveBeenCalledOnce();
    expect(manager.status()).toMatchObject({
      state: 'blocked',
      reason: 'security-state-reset-failed',
    });
  });
});

function coordinatorHarness(keyPackages: MlsKeyPackage[] = []) {
  const group = {
    protocol: 'mls10-openmls-0.8' as const,
    conversation_id: enterpriseMlsDirectConversationId({
      organizationId: 'org-a',
      accountId: 'account-a',
      peerAccountId: 'account-b',
    }),
    group_id: 'Z3JvdXAtMQ==',
    epoch: 1,
    member_count: 2,
  };
  const sessions = {
    activeScope: vi.fn(() => ({
      serverUrl: 'https://enterprise.example.test',
      organizationId: 'org-a',
      accountId: 'account-a',
      deviceId: 'device-a',
    })),
    createKeyPackage: vi.fn(async () => ({
      protocol: 'mls10-openmls-0.8' as const,
      ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const,
      reference: 'a'.repeat(64),
      key_package: 'a2V5LXBhY2thZ2U=',
    })),
    listKeyPackages: vi.fn(async (): Promise<MlsKeyPackage[]> => keyPackages),
    createGroup: vi.fn(async () => ({
      ...group,
      epoch: 0,
      member_count: 1,
    })),
    addMember: vi.fn(async () => ({
      protocol: 'mls10-openmls-0.8' as const,
      conversation_id: group.conversation_id,
      group_id: group.group_id,
      epoch: 0,
      key_package_reference: 'b'.repeat(64),
      recipient_device_id: 'device-b',
      commit: 'Y29tbWl0',
      welcome: 'd2VsY29tZQ==',
    })),
    mergePendingCommit: vi.fn(async () => group),
    inspectGroup: vi.fn(async (): Promise<MlsGroupInspection | null> => null),
    joinGroup: vi.fn(async () => group),
    transportCursor: vi.fn(async () => 0),
    advanceTransportCursor: vi.fn(async () => undefined),
    decryptTransportApplication: vi.fn(async () => ({
      protocol: 'mls10-openmls-0.8' as const,
      conversationId: group.conversation_id,
      groupId: group.group_id,
      epoch: 1,
      senderDeviceScope: `${'f'.repeat(64)}/org-a/account-b/device-b`,
      plaintext: new Uint8Array([7, 8, 9]),
    })),
  } satisfies EnterpriseMlsSessionOperations;
  let nextSequence = 0;
  const transport = {
    publishMlsKeyPackage: vi.fn(async (deviceId, keyPackage) => ({
      reference: keyPackage.reference,
      accountId: 'account-a',
      deviceId,
      ciphersuite: keyPackage.ciphersuite,
      keyPackage: keyPackage.key_package,
      createdAt: '2026-08-02T00:00:00.000Z',
      claimedAt: null,
      expiresAt: '2026-08-09T00:00:00.000Z',
    })),
    claimMlsKeyPackage: vi.fn(async () => ({
      reference: 'b'.repeat(64),
      accountId: 'account-b',
      deviceId: 'device-b',
      ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const,
      keyPackage: 'cGVlci1rZXktcGFja2FnZQ==',
      createdAt: '2026-08-02T00:00:00.000Z',
      claimedAt: '2026-08-02T00:01:00.000Z',
      expiresAt: '2026-08-03T00:01:00.000Z',
    })),
    appendMlsTransportEvent: vi.fn(async (peerAccountId, input) => ({
      sequence: ++nextSequence,
      eventId: input.eventId,
      conversationId: group.conversation_id,
      sessionGeneration: 1,
      senderAccountId: 'account-a',
      senderDeviceId: input.senderDeviceId,
      recipientAccountId: input.eventType === 'welcome' ? peerAccountId : null,
      recipientDeviceId: input.recipientDeviceId ?? null,
      eventType: input.eventType,
      epoch: input.epoch,
      groupId: input.groupId,
      payload: input.payload,
      keyPackageReference: input.keyPackageReference ?? null,
      createdAt: '2026-08-02T00:02:00.000Z',
      expiresAt: '2026-10-31T00:02:00.000Z',
    })),
    listMlsTransportEvents: vi.fn(
      async (): Promise<EnterpriseMlsTransportEvent[]> => [],
    ),
  } satisfies EnterpriseMlsTransportClient;
  return { group, sessions, transport };
}

function transportEvent(
  overrides: Partial<EnterpriseMlsTransportEvent>,
): EnterpriseMlsTransportEvent {
  return {
    sequence: 1,
    eventId: 'event-1',
    conversationId: enterpriseMlsDirectConversationId({
      organizationId: 'org-a',
      accountId: 'account-a',
      peerAccountId: 'account-b',
    }),
    sessionGeneration: 1,
    senderAccountId: 'account-b',
    senderDeviceId: 'device-b',
    recipientAccountId: null,
    recipientDeviceId: null,
    eventType: 'commit',
    epoch: 1,
    groupId: 'Z3JvdXAtMQ==',
    payload: 'Y29tbWl0',
    keyPackageReference: null,
    createdAt: '2026-08-02T00:02:00.000Z',
    expiresAt: '2026-10-31T00:02:00.000Z',
    ...overrides,
  };
}

describe('EnterpriseMlsSessionCoordinator', () => {
  it('recovers local KeyPackage inventory and replaces only a claimed package', async () => {
    const claimed: MlsKeyPackage = {
      protocol: 'mls10-openmls-0.8' as const,
      ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const,
      reference: 'c'.repeat(64),
      key_package: 'b2xkLWtleS1wYWNrYWdl',
    };
    const { sessions, transport } = coordinatorHarness([claimed]);
    transport.publishMlsKeyPackage
      .mockRejectedValueOnce(
        new Error('MLS KeyPackage reference conflict or reuse'),
      )
      .mockResolvedValueOnce({
        reference: 'a'.repeat(64),
        accountId: 'account-a',
        deviceId: 'device-a',
        ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
        keyPackage: 'a2V5LXBhY2thZ2U=',
        createdAt: '2026-08-02T00:00:00.000Z',
        claimedAt: null,
        expiresAt: '2026-08-09T00:00:00.000Z',
      });
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(
      coordinator.ensurePublishedKeyPackage(),
    ).resolves.toMatchObject({
      reference: 'a'.repeat(64),
    });
    expect(transport.publishMlsKeyPackage.mock.calls).toEqual([
      ['device-a', claimed],
      ['device-a', expect.objectContaining({ reference: 'a'.repeat(64) })],
    ]);
  });

  it('replays a persisted pending invitation with stable event identifiers', async () => {
    const { group, sessions, transport } = coordinatorHarness();
    const pending = {
      ...group,
      epoch: 0,
      member_count: 1,
      pending_commit: true,
      pending_invitation: {
        protocol: 'mls10-openmls-0.8' as const,
        conversation_id: group.conversation_id,
        group_id: group.group_id,
        epoch: 0,
        key_package_reference: 'b'.repeat(64),
        recipient_device_id: 'device-b',
        commit: 'Y29tbWl0',
        welcome: 'd2VsY29tZQ==',
      },
    };
    sessions.inspectGroup.mockResolvedValue(pending);
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(
      coordinator.establishDirectSession('account-b'),
    ).resolves.toMatchObject({ state: 'ready', group });
    const firstIds = transport.appendMlsTransportEvent.mock.calls.map(
      ([, input]) => input.eventId,
    );
    transport.appendMlsTransportEvent.mockClear();
    await coordinator.establishDirectSession('account-b');

    expect(transport.claimMlsKeyPackage).not.toHaveBeenCalled();
    expect(
      transport.appendMlsTransportEvent.mock.calls.map(
        ([, input]) => input.eventId,
      ),
    ).toEqual(firstIds);
    expect(sessions.mergePendingCommit).toHaveBeenCalledTimes(2);
  });

  it('lets only the deterministic account initiate a new direct group', async () => {
    const { sessions, transport } = coordinatorHarness();
    sessions.activeScope.mockReturnValue({
      serverUrl: 'https://enterprise.example.test',
      organizationId: 'org-a',
      accountId: 'account-z',
      deviceId: 'device-z',
    });
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(
      coordinator.establishDirectSession('account-a'),
    ).resolves.toEqual({ state: 'waiting-for-peer-commit', group: null });
    expect(sessions.createGroup).not.toHaveBeenCalled();
    expect(transport.claimMlsKeyPackage).not.toHaveBeenCalled();
  });

  it('joins from Welcome and atomically advances application cursor on decrypt', async () => {
    const { group, sessions, transport } = coordinatorHarness();
    const commit = transportEvent({ sequence: 1, eventId: 'commit-1' });
    const welcome = transportEvent({
      sequence: 2,
      eventId: 'welcome-1',
      eventType: 'welcome',
      recipientAccountId: 'account-a',
      recipientDeviceId: 'device-a',
      keyPackageReference: 'a'.repeat(64),
      payload: 'd2VsY29tZQ==',
    });
    const application = transportEvent({
      sequence: 3,
      eventId: 'application-1',
      eventType: 'application',
      payload: 'Y2lwaGVydGV4dA==',
    });
    transport.listMlsTransportEvents.mockResolvedValue([
      commit,
      welcome,
      application,
    ]);
    sessions.inspectGroup
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...group,
        pending_commit: false,
        pending_invitation: null,
      });
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    const result = await coordinator.poll('account-b');

    expect(sessions.joinGroup).toHaveBeenCalledWith(
      'account-b',
      'a'.repeat(64),
      group.group_id,
      'd2VsY29tZQ==',
    );
    expect(sessions.advanceTransportCursor.mock.calls).toEqual([
      ['account-b', 1],
      ['account-b', 2],
    ]);
    expect(sessions.decryptTransportApplication).toHaveBeenCalledWith(
      'account-b',
      'Y2lwaGVydGV4dA==',
      3,
    );
    expect(result).toMatchObject({
      previousSequence: 0,
      nextSequence: 3,
      processedEvents: 3,
      messages: [
        {
          sequence: 3,
          eventId: 'application-1',
          senderAccountId: 'account-b',
          senderDeviceId: 'device-b',
        },
      ],
    });
  });
});
