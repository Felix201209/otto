import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MlsGroupInspection,
  MlsKeyPackage,
  MlsPendingApplication,
  MlsPendingReceivedApplication,
} from '@otto/native';

import {
  EnterpriseMlsInboundPollScheduler,
  EnterpriseMlsSessionCoordinator,
  EnterpriseMlsSessionManager,
  EnterpriseMlsOutboxRetryScheduler,
  enterpriseMlsDirectConversationId,
  type EnterpriseMlsKeyPackageInventory,
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
  vi.useRealTimers();
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
      recipient_account_id: 'account-b',
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
    encryptTransportApplication: vi.fn(
      async (conversationId: string, peerAccountId: string) => ({
      protocol: 'mls10-openmls-0.8' as const,
      event_id: `mls-${'a'.repeat(64)}`,
      conversation_id: conversationId,
      peer_account_id: peerAccountId,
      group_id: 'Z3JvdXA=',
      epoch: 1,
      ciphertext: 'Y2lwaGVydGV4dA==',
      }),
    ),
    listPendingApplications: vi.fn(
      async (): Promise<MlsPendingApplication[]> => [],
    ),
    listPendingApplicationPeers: vi.fn(async (): Promise<string[]> => []),
    listConversationPeers: vi.fn(async (): Promise<string[]> => []),
    bindConversationPeer: vi.fn(async () => false),
    acknowledgePendingApplication: vi.fn(async () => undefined),
    transportCursor: vi.fn(async () => 0),
    acknowledgeTransportEvent: vi.fn(async () => undefined),
    receiveTransportCommit: vi.fn(async (conversationId: string) => ({
      ...groupState,
      conversation_id: conversationId,
      epoch: 2,
    })),
    receiveTransportApplication: vi.fn(
      async (
        conversationId: string,
        peerAccountId: string,
        eventId: string,
        _ciphertext: string,
        sequence: number,
        _expectedGroupId: string,
        _expectedEpoch: number,
        _senderDeviceId: string,
        createdAt: string,
      ) => ({
        protocol: 'mls10-openmls-0.8' as const,
        eventId,
        conversationId,
        peerAccountId,
        sequence,
        groupId: 'Z3JvdXA=',
        epoch: 1,
        senderDeviceScope: 'server/org-a/account-b/device-b',
        plaintext: new Uint8Array([1, 2, 3]),
        createdAt,
      }),
    ),
    stageTransportApplication: vi.fn(
      async (
        conversationId: string,
        peerAccountId: string,
        eventId: string,
        _ciphertext: string,
        sequence: number,
        _expectedGroupId: string,
        _expectedEpoch: number,
        _senderDeviceId: string,
        createdAt: string,
      ) => ({
        protocol: 'mls10-openmls-0.8' as const,
        eventId,
        conversationId,
        peerAccountId,
        sequence,
        groupId: 'Z3JvdXA=',
        epoch: 1,
        senderDeviceScope: 'server/org-a/account-b/device-b',
        createdAt,
      }),
    ),
    listPendingReceivedApplications: vi.fn(
      async (): Promise<MlsPendingReceivedApplication[]> => [],
    ),
    acknowledgeReceivedApplication: vi.fn(async () => undefined),
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
    await manager.inspectGroup('account-b');
    await manager.encryptTransportApplication(
      'account-b',
      new Uint8Array([2]),
    );
    await manager.listPendingApplications('account-b');
    await manager.listPendingApplicationPeers();
    await manager.listConversationPeers();
    await manager.acknowledgePendingApplication(
      'account-b',
      `mls-${'a'.repeat(64)}`,
    );
    await manager.transportCursor('account-b');
    await manager.advanceTransportCursor('account-b', 4);
    await manager.receiveTransportApplication(
      'account-b',
      `mls-${'b'.repeat(64)}`,
      'Y2lwaGVydGV4dA==',
      5,
      'Z3JvdXA=',
      1,
      'device-b',
      '2026-08-02T00:02:00.000Z',
    );
    await manager.stageTransportApplication(
      'account-b',
      `mls-${'c'.repeat(64)}`,
      'Y2lwaGVydGV4dA==',
      6,
      'Z3JvdXA=',
      1,
      'device-b',
      '2026-08-02T00:03:00.000Z',
    );
    await manager.listPendingReceivedApplications('account-b');
    await manager.acknowledgeReceivedApplication(
      'account-b',
      `mls-${'b'.repeat(64)}`,
    );

    expect(kernel.createGroup).toHaveBeenCalledWith(conversationId);
    expect(kernel.bindConversationPeer).toHaveBeenCalledWith(
      conversationId,
      'account-b',
    );
    expect(kernel.encryptTransportApplication).toHaveBeenCalledWith(
      conversationId,
      'account-b',
      new Uint8Array([2]),
    );
    expect(kernel.listPendingApplications).toHaveBeenCalledWith(
      conversationId,
      'account-b',
    );
    expect(kernel.listPendingApplicationPeers).toHaveBeenCalledOnce();
    expect(kernel.listConversationPeers).toHaveBeenCalledOnce();
    expect(kernel.acknowledgePendingApplication).toHaveBeenCalledWith(
      conversationId,
      'account-b',
      `mls-${'a'.repeat(64)}`,
    );
    expect(kernel.transportCursor).toHaveBeenCalledWith(conversationId);
    expect(kernel.acknowledgeTransportEvent).toHaveBeenCalledWith(
      conversationId,
      4,
    );
    expect(kernel.receiveTransportApplication).toHaveBeenCalledWith(
      conversationId,
      'account-b',
      `mls-${'b'.repeat(64)}`,
      'Y2lwaGVydGV4dA==',
      5,
      'Z3JvdXA=',
      1,
      'device-b',
      '2026-08-02T00:02:00.000Z',
    );
    expect(kernel.stageTransportApplication).toHaveBeenCalledWith(
      conversationId,
      'account-b',
      `mls-${'c'.repeat(64)}`,
      'Y2lwaGVydGV4dA==',
      6,
      'Z3JvdXA=',
      1,
      'device-b',
      '2026-08-02T00:03:00.000Z',
    );
    expect(kernel.listPendingReceivedApplications).toHaveBeenCalledWith(
      conversationId,
      'account-b',
    );
    expect(kernel.acknowledgeReceivedApplication).toHaveBeenCalledWith(
      conversationId,
      'account-b',
      `mls-${'b'.repeat(64)}`,
    );
  });

  it('closes a cleared MLS kernel and requires explicit reactivation', async () => {
    const kernel = fakeKernel();
    const replacementKernel = fakeKernel();
    const kernelFactory = vi
      .fn()
      .mockReturnValueOnce(kernel)
      .mockReturnValueOnce(replacementKernel);
    const manager = new EnterpriseMlsSessionManager({
      stateDirectory: await temporaryDirectory(),
      secureStorage: {
        assertAvailable: vi.fn(),
        protect: vi.fn((value) => value),
        unprotect: vi.fn((value) => value),
      },
      kernelFactory,
    });

    await expect(manager.resetSecurityState()).rejects.toThrow('not ready');
    await manager.activate(identity());
    await expect(manager.resetSecurityState()).resolves.toBeUndefined();
    expect(kernel.reset).toHaveBeenCalledOnce();
    expect(kernel.close).toHaveBeenCalledOnce();
    expect(manager.status()).toEqual({
      state: 'inactive',
      protocol: 'mls10-openmls-0.8',
    });
    await expect(manager.createKeyPackage()).rejects.toThrow('not ready');
    await expect(
      manager.encryptTransportApplication(
        'account-b',
        new TextEncoder().encode('must not send'),
      ),
    ).rejects.toThrow('not ready');
    await expect(manager.transportCursor('account-b')).rejects.toThrow(
      'not ready',
    );

    await expect(manager.activate(identity())).resolves.toMatchObject({
      state: 'ready',
    });
    expect(kernelFactory).toHaveBeenCalledTimes(2);
    expect(replacementKernel.init).toHaveBeenCalledOnce();
    await manager.createKeyPackage();
    expect(replacementKernel.createKeyPackage).toHaveBeenCalledOnce();
    expect(kernel.createKeyPackage).not.toHaveBeenCalled();
  });

  it('blocks the MLS lifecycle when security-state reset fails', async () => {
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
      recipient_account_id: 'account-b',
      recipient_device_id: 'device-b',
      commit: 'Y29tbWl0',
      welcome: 'd2VsY29tZQ==',
    })),
    mergePendingCommit: vi.fn(async () => group),
    inspectGroup: vi.fn(async (): Promise<MlsGroupInspection | null> => null),
    joinGroup: vi.fn(async () => group),
    encryptTransportApplication: vi.fn(async () => ({
      protocol: 'mls10-openmls-0.8' as const,
      event_id: `mls-${'2'.repeat(64)}`,
      conversation_id: group.conversation_id,
      peer_account_id: 'account-b',
      group_id: group.group_id,
      epoch: group.epoch,
      ciphertext: 'bmV3LWNpcGhlcnRleHQ=',
    })),
    listPendingApplications: vi.fn(
      async (): Promise<MlsPendingApplication[]> => [],
    ),
    listPendingApplicationPeers: vi.fn(async (): Promise<string[]> => []),
    listConversationPeers: vi.fn(async (): Promise<string[]> => ['account-b']),
    acknowledgePendingApplication: vi.fn(async () => undefined),
    transportCursor: vi.fn(async () => 0),
    advanceTransportCursor: vi.fn(async () => undefined),
    receiveTransportCommit: vi.fn(async () => ({
      ...group,
      epoch: group.epoch + 1,
    })),
    receiveTransportApplication: vi.fn(
      async (
        _peerAccountId: string,
        eventId: string,
        _ciphertext: string,
        sequence: number,
        _expectedGroupId: string,
        _expectedEpoch: number,
        _senderDeviceId: string,
        createdAt: string,
      ) => ({
        protocol: 'mls10-openmls-0.8' as const,
        eventId,
        conversationId: group.conversation_id,
        peerAccountId: 'account-b',
        sequence,
        groupId: group.group_id,
        epoch: 1,
        senderDeviceScope: `${'f'.repeat(64)}/org-a/account-b/device-b`,
        plaintext: new Uint8Array([7, 8, 9]),
        createdAt,
      }),
    ),
    stageTransportApplication: vi.fn(
      async (
        peerAccountId: string,
        eventId: string,
        _ciphertext: string,
        sequence: number,
        expectedGroupId: string,
        expectedEpoch: number,
        senderDeviceId: string,
        createdAt: string,
      ) => ({
        protocol: 'mls10-openmls-0.8' as const,
        eventId,
        conversationId: group.conversation_id,
        peerAccountId,
        sequence,
        groupId: expectedGroupId,
        epoch: expectedEpoch,
        senderDeviceScope: `${'f'.repeat(64)}/org-a/${peerAccountId}/${senderDeviceId}`,
        createdAt,
      }),
    ),
    listPendingReceivedApplications: vi.fn(
      async (): Promise<MlsPendingReceivedApplication[]> => [],
    ),
    acknowledgeReceivedApplication: vi.fn(async () => undefined),
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
      expiresAt: '2099-01-01T00:00:00.000Z',
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
    listMlsInboundConversationPeers: vi.fn(async (): Promise<string[]> => []),
    listMlsKeyPackageInventory: vi.fn(
      async (deviceId: string): Promise<EnterpriseMlsKeyPackageInventory> => ({
        deviceId,
        keyPackages: [],
      }),
    ),
    retireMlsKeyPackage: vi.fn(async () => undefined),
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
  it('reuses server inventory and replaces only unavailable local KeyPackages', async () => {
    const claimed: MlsKeyPackage = {
      protocol: 'mls10-openmls-0.8' as const,
      ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const,
      reference: 'c'.repeat(64),
      key_package: 'b2xkLWtleS1wYWNrYWdl',
    };
    const available: MlsKeyPackage = {
      ...claimed,
      reference: 'd'.repeat(64),
      key_package: 'YXZhaWxhYmxlLWtleS1wYWNrYWdl',
    };
    const { sessions, transport } = coordinatorHarness([available, claimed]);
    transport.listMlsKeyPackageInventory.mockResolvedValue({
      deviceId: 'device-a',
      keyPackages: [
        {
          reference: available.reference,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    });
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
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(
      coordinator.ensurePublishedKeyPackageInventory(2, 0),
    ).resolves.toBe(2);
    expect(transport.listMlsKeyPackageInventory).toHaveBeenCalledWith(
      'device-a',
    );
    expect(transport.publishMlsKeyPackage.mock.calls).toEqual([
      ['device-a', claimed],
      ['device-a', expect.objectContaining({ reference: 'a'.repeat(64) })],
    ]);
  });

  it('retires an unclaimed server KeyPackage whose private key is absent locally', async () => {
    const { sessions, transport } = coordinatorHarness();
    transport.listMlsKeyPackageInventory.mockResolvedValue({
      deviceId: 'device-a',
      keyPackages: [
        {
          reference: 'd'.repeat(64),
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    });
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(
      coordinator.ensurePublishedKeyPackageInventory(1, 0),
    ).resolves.toBe(1);

    expect(transport.retireMlsKeyPackage).toHaveBeenCalledWith(
      'device-a',
      'd'.repeat(64),
    );
    expect(transport.publishMlsKeyPackage).toHaveBeenCalledWith(
      'device-a',
      expect.objectContaining({ reference: 'a'.repeat(64) }),
    );
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
        recipient_account_id: 'account-b',
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
    expect(transport.listMlsTransportEvents).toHaveBeenCalledWith(
      'account-a',
      0,
      100,
    );
  });

  it('lets the deterministic receiver consume a pending handshake without exposing application plaintext', async () => {
    const { group, sessions, transport } = coordinatorHarness();
    sessions.activeScope.mockReturnValue({
      serverUrl: 'https://enterprise.example.test',
      organizationId: 'org-a',
      accountId: 'account-b',
      deviceId: 'device-b',
    });
    const readyGroup: MlsGroupInspection = {
      ...group,
      pending_commit: false,
      pending_invitation: null,
    };
    sessions.inspectGroup
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(readyGroup)
      .mockResolvedValueOnce(readyGroup);
    const commit = transportEvent({
      sequence: 1,
      senderAccountId: 'account-a',
      senderDeviceId: 'device-a',
    });
    const welcome = transportEvent({
      sequence: 2,
      eventId: 'welcome-2',
      eventType: 'welcome',
      senderAccountId: 'account-a',
      senderDeviceId: 'device-a',
      recipientAccountId: 'account-b',
      recipientDeviceId: 'device-b',
      keyPackageReference: 'a'.repeat(64),
      payload: 'd2VsY29tZQ==',
    });
    const application = transportEvent({
      sequence: 3,
      eventId: `mls-${'6'.repeat(64)}`,
      eventType: 'application',
      senderAccountId: 'account-a',
      senderDeviceId: 'device-a',
      payload: 'Y2lwaGVydGV4dA==',
    });
    transport.listMlsTransportEvents.mockResolvedValue([
      commit,
      welcome,
      application,
    ]);
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(
      coordinator.establishDirectSession('account-a'),
    ).resolves.toEqual({ state: 'ready', group: readyGroup });

    expect(sessions.joinGroup).toHaveBeenCalledWith(
      'account-a',
      'a'.repeat(64),
      group.group_id,
      'd2VsY29tZQ==',
    );
    expect(sessions.stageTransportApplication).toHaveBeenCalledWith(
      'account-a',
      application.eventId,
      application.payload,
      application.sequence,
      application.groupId,
      application.epoch,
      application.senderDeviceId,
      application.createdAt,
    );
    expect(sessions.receiveTransportApplication).not.toHaveBeenCalled();
    expect(sessions.listPendingReceivedApplications).not.toHaveBeenCalled();
    expect(sessions.createGroup).not.toHaveBeenCalled();
    expect(transport.claimMlsKeyPackage).not.toHaveBeenCalled();
  });

  it('fails closed when the deterministic receiver cannot poll its handshake', async () => {
    const { sessions, transport } = coordinatorHarness();
    sessions.activeScope.mockReturnValue({
      serverUrl: 'https://enterprise.example.test',
      organizationId: 'org-a',
      accountId: 'account-b',
      deviceId: 'device-b',
    });
    transport.listMlsTransportEvents.mockRejectedValue(
      new Error('transport offline'),
    );
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(
      coordinator.establishDirectSession('account-a'),
    ).rejects.toThrow('transport offline');
    expect(sessions.createGroup).not.toHaveBeenCalled();
    expect(transport.claimMlsKeyPackage).not.toHaveBeenCalled();
  });

  it('replays the durable application outbox before encrypting a new message', async () => {
    const { group, sessions, transport } = coordinatorHarness();
    const recovered: MlsPendingApplication = {
      protocol: 'mls10-openmls-0.8',
      event_id: `mls-${'1'.repeat(64)}`,
      conversation_id: group.conversation_id,
      peer_account_id: 'account-b',
      group_id: group.group_id,
      epoch: group.epoch,
      ciphertext: 'cmVjb3ZlcmVkLWNpcGhlcnRleHQ=',
    };
    sessions.listPendingApplications.mockResolvedValue([recovered]);
    sessions.inspectGroup.mockResolvedValue({
      ...group,
      pending_commit: false,
      pending_invitation: null,
    });
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(
      coordinator.sendApplication('account-b', new Uint8Array([4, 5, 6])),
    ).resolves.toMatchObject({
      eventId: `mls-${'2'.repeat(64)}`,
      eventType: 'application',
    });

    expect(
      transport.appendMlsTransportEvent.mock.calls.map(
        ([, input]) => input.eventId,
      ),
    ).toEqual([recovered.event_id, `mls-${'2'.repeat(64)}`]);
    expect(sessions.acknowledgePendingApplication.mock.calls).toEqual([
      ['account-b', recovered.event_id],
      ['account-b', `mls-${'2'.repeat(64)}`],
    ]);
    expect(sessions.encryptTransportApplication).toHaveBeenCalledWith(
      'account-b',
      new Uint8Array([4, 5, 6]),
    );
    expect(
      sessions.acknowledgePendingApplication.mock.invocationCallOrder[0],
    ).toBeLessThan(
      sessions.encryptTransportApplication.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps a pending application when transport delivery fails', async () => {
    const { group, sessions, transport } = coordinatorHarness();
    const recovered: MlsPendingApplication = {
      protocol: 'mls10-openmls-0.8',
      event_id: `mls-${'3'.repeat(64)}`,
      conversation_id: group.conversation_id,
      peer_account_id: 'account-b',
      group_id: group.group_id,
      epoch: group.epoch,
      ciphertext: 'cmV0cnktY2lwaGVydGV4dA==',
    };
    sessions.listPendingApplications.mockResolvedValue([recovered]);
    sessions.inspectGroup.mockResolvedValue({
      ...group,
      pending_commit: false,
      pending_invitation: null,
    });
    transport.appendMlsTransportEvent.mockRejectedValueOnce(
      new Error('transport unavailable'),
    );
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(
      coordinator.sendApplication('account-b', new Uint8Array([7])),
    ).rejects.toThrow('transport unavailable');
    expect(sessions.acknowledgePendingApplication).not.toHaveBeenCalled();
    expect(sessions.encryptTransportApplication).not.toHaveBeenCalled();
  });

  it('does not acknowledge a transport response with different security bindings', async () => {
    const { group, sessions, transport } = coordinatorHarness();
    const recovered: MlsPendingApplication = {
      protocol: 'mls10-openmls-0.8',
      event_id: `mls-${'4'.repeat(64)}`,
      conversation_id: group.conversation_id,
      peer_account_id: 'account-b',
      group_id: group.group_id,
      epoch: group.epoch,
      ciphertext: 'YmluZGluZy1jaXBoZXJ0ZXh0',
    };
    sessions.listPendingApplications.mockResolvedValue([recovered]);
    sessions.inspectGroup.mockResolvedValue({
      ...group,
      pending_commit: false,
      pending_invitation: null,
    });
    transport.appendMlsTransportEvent.mockImplementationOnce(
      async (peerAccountId, input) => ({
        sequence: 1,
        eventId: input.eventId,
        conversationId: group.conversation_id,
        sessionGeneration: 1,
        senderAccountId: 'account-a',
        senderDeviceId: input.senderDeviceId,
        recipientAccountId: peerAccountId,
        recipientDeviceId: null,
        eventType: 'application',
        epoch: input.epoch,
        groupId: input.groupId,
        payload: input.payload,
        keyPackageReference: null,
        createdAt: '2026-08-02T00:02:00.000Z',
        expiresAt: '2026-10-31T00:02:00.000Z',
      }),
    );
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(
      coordinator.flushPendingApplications('account-b'),
    ).rejects.toThrow('acknowledgement binding is invalid');
    expect(sessions.acknowledgePendingApplication).not.toHaveBeenCalled();
  });

  it('continues flushing other peer outboxes and reports partial failure', async () => {
    const { sessions, transport } = coordinatorHarness();
    sessions.listPendingApplicationPeers.mockResolvedValue([
      'account-b',
      'account-c',
    ]);
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );
    const flush = vi
      .spyOn(coordinator, 'flushPendingApplications')
      .mockRejectedValueOnce(new Error('peer session blocked'))
      .mockResolvedValueOnce([transportEvent({ eventId: 'application-c' })]);

    await expect(coordinator.flushAllPendingApplications()).rejects.toThrow(
      'failed for 1 peer session',
    );
    expect(flush.mock.calls).toEqual([['account-b'], ['account-c']]);
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
      eventId: `mls-${'3'.repeat(64)}`,
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
    expect(sessions.receiveTransportApplication).toHaveBeenCalledWith(
      'account-b',
      `mls-${'3'.repeat(64)}`,
      'Y2lwaGVydGV4dA==',
      3,
      group.group_id,
      1,
      'device-b',
      '2026-08-02T00:02:00.000Z',
    );
    expect(result).toMatchObject({
      previousSequence: 0,
      nextSequence: 3,
      processedEvents: 3,
      messages: [
        {
          sequence: 3,
          eventId: `mls-${'3'.repeat(64)}`,
          senderAccountId: 'account-b',
          senderDeviceId: 'device-b',
        },
      ],
    });
  });

  it('processes a later remote Commit through the native atomic epoch transition', async () => {
    const { group, sessions, transport } = coordinatorHarness();
    sessions.transportCursor.mockResolvedValue(7);
    sessions.inspectGroup.mockResolvedValue({
      ...group,
      pending_commit: false,
      pending_invitation: null,
    });
    const commit = transportEvent({
      sequence: 8,
      eventId: `mls-${'8'.repeat(64)}`,
      epoch: 2,
      payload: 'dXBkYXRlLWNvbW1pdA==',
    });
    transport.listMlsTransportEvents.mockResolvedValue([commit]);
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(coordinator.poll('account-b')).resolves.toMatchObject({
      previousSequence: 7,
      nextSequence: 8,
      processedEvents: 1,
      messages: [],
    });
    expect(sessions.receiveTransportCommit).toHaveBeenCalledWith(
      'account-b',
      commit.payload,
      commit.sequence,
      commit.groupId,
      commit.epoch,
      commit.senderDeviceId,
    );
    expect(sessions.advanceTransportCursor).not.toHaveBeenCalled();
  });

  it('fails closed when a remote Commit skips an epoch', async () => {
    const { group, sessions, transport } = coordinatorHarness();
    sessions.inspectGroup.mockResolvedValue({
      ...group,
      pending_commit: false,
      pending_invitation: null,
    });
    transport.listMlsTransportEvents.mockResolvedValue([
      transportEvent({ sequence: 2, epoch: 3 }),
    ]);
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(coordinator.poll('account-b')).rejects.toThrow(
      'does not advance the next epoch',
    );
    expect(sessions.receiveTransportCommit).not.toHaveBeenCalled();
    expect(sessions.advanceTransportCursor).not.toHaveBeenCalled();
  });

  it('re-delivers the encrypted native inbox until the consumer acknowledges it', async () => {
    const { group, sessions, transport } = coordinatorHarness();
    const pending: MlsPendingReceivedApplication = {
      protocol: 'mls10-openmls-0.8',
      eventId: `mls-${'4'.repeat(64)}`,
      conversationId: group.conversation_id,
      peerAccountId: 'account-b',
      sequence: 7,
      groupId: group.group_id,
      epoch: 1,
      senderDeviceScope: `${'f'.repeat(64)}/org-a/account-b/device-b`,
      plaintext: new Uint8Array([9, 8, 7]),
      createdAt: '2026-08-02T00:03:00.000Z',
    };
    sessions.transportCursor.mockResolvedValue(7);
    sessions.listPendingReceivedApplications.mockResolvedValue([pending]);
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(coordinator.poll('account-b')).resolves.toMatchObject({
      previousSequence: 7,
      nextSequence: 7,
      processedEvents: 0,
      messages: [{ eventId: pending.eventId, sequence: 7 }],
    });
    await coordinator.acknowledgeReceivedApplication(
      'account-b',
      pending.eventId,
    );

    expect(sessions.acknowledgeReceivedApplication).toHaveBeenCalledWith(
      'account-b',
      pending.eventId,
    );
  });

  it('stages background applications without exposing pending plaintext', async () => {
    const { group, sessions, transport } = coordinatorHarness();
    sessions.inspectGroup.mockResolvedValue({
      ...group,
      pending_commit: false,
      pending_invitation: null,
    });
    const application = transportEvent({
      sequence: 1,
      eventId: `mls-${'5'.repeat(64)}`,
      eventType: 'application',
      payload: 'Y2lwaGVydGV4dA==',
    });
    transport.listMlsTransportEvents.mockResolvedValue([application]);
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(coordinator.pollAllActiveSessions()).resolves.toBe(1);

    expect(sessions.stageTransportApplication).toHaveBeenCalledWith(
      'account-b',
      application.eventId,
      application.payload,
      application.sequence,
      application.groupId,
      application.epoch,
      application.senderDeviceId,
      application.createdAt,
    );
    expect(sessions.receiveTransportApplication).not.toHaveBeenCalled();
    expect(sessions.listPendingReceivedApplications).not.toHaveBeenCalled();
  });

  it('polls an inbound Welcome peer before the local conversation is opened', async () => {
    const { group, sessions, transport } = coordinatorHarness();
    sessions.listConversationPeers.mockResolvedValue([]);
    sessions.inspectGroup
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...group,
        pending_commit: false,
        pending_invitation: null,
      });
    transport.listMlsInboundConversationPeers.mockResolvedValue(['account-b']);
    transport.listMlsTransportEvents.mockResolvedValue([
      transportEvent({ sequence: 1, eventId: 'commit-discovered' }),
      transportEvent({
        sequence: 2,
        eventId: 'welcome-discovered',
        eventType: 'welcome',
        recipientAccountId: 'account-a',
        recipientDeviceId: 'device-a',
        keyPackageReference: 'a'.repeat(64),
        payload: 'd2VsY29tZQ==',
      }),
      transportEvent({
        sequence: 3,
        eventId: `mls-${'6'.repeat(64)}`,
        eventType: 'application',
        payload: 'Y2lwaGVydGV4dA==',
      }),
    ]);
    const coordinator = new EnterpriseMlsSessionCoordinator(
      sessions,
      transport,
    );

    await expect(coordinator.pollAllActiveSessions()).resolves.toBe(3);

    expect(transport.listMlsInboundConversationPeers).toHaveBeenCalledWith(
      'device-a',
    );
    expect(transport.listMlsTransportEvents).toHaveBeenCalledWith(
      'account-b',
      0,
      100,
    );
    expect(sessions.joinGroup).toHaveBeenCalledWith(
      'account-b',
      'a'.repeat(64),
      group.group_id,
      'd2VsY29tZQ==',
    );
    expect(sessions.stageTransportApplication).toHaveBeenCalledOnce();
    expect(sessions.receiveTransportApplication).not.toHaveBeenCalled();
  });
});

describe('EnterpriseMlsOutboxRetryScheduler', () => {
  it('uses bounded exponential backoff and wakes immediately after recovery', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const flushAllPendingApplications = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValue(1);
    const scheduler = new EnterpriseMlsOutboxRetryScheduler(
      { flushAllPendingApplications },
      {
        baseDelayMs: 100,
        maxDelayMs: 250,
        idleDelayMs: 1_000,
        jitterRatio: 0,
        onError,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushAllPendingApplications).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(flushAllPendingApplications).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushAllPendingApplications).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(flushAllPendingApplications).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushAllPendingApplications).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);

    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushAllPendingApplications).toHaveBeenCalledTimes(4);
    await scheduler.stop();
  });

  it('waits for an active delivery and schedules nothing after stop', async () => {
    vi.useFakeTimers();
    let finishDelivery!: (count: number) => void;
    const flushAllPendingApplications = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finishDelivery = resolve;
        }),
    );
    const scheduler = new EnterpriseMlsOutboxRetryScheduler(
      { flushAllPendingApplications },
      { jitterRatio: 0 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finishDelivery(0);
    await stopping;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(flushAllPendingApplications).toHaveBeenCalledOnce();
  });
});

describe('EnterpriseMlsInboundPollScheduler', () => {
  it('backs off on polling failures and stops without leaving work running', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const pollAllActiveSessions = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(1);
    const scheduler = new EnterpriseMlsInboundPollScheduler(
      { pollAllActiveSessions },
      {
        baseDelayMs: 100,
        maxDelayMs: 200,
        idleDelayMs: 1_000,
        jitterRatio: 0,
        onError,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollAllActiveSessions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(pollAllActiveSessions).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pollAllActiveSessions).toHaveBeenCalledTimes(2);
  });
});
