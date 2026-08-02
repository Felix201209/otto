import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EnterpriseMlsSessionManager,
  enterpriseMlsDirectConversationId,
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
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function identity(
  overrides: Partial<Parameters<EnterpriseMlsSessionManager['activate']>[0]> = {},
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
      ciphersuite:
        'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const,
      reference: 'a'.repeat(64),
      key_package: 'S2V5UGFja2FnZQ==',
    })),
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
      commit: 'Y29tbWl0',
      welcome: 'd2VsY29tZQ==',
    })),
    mergePendingCommit: vi.fn(async (conversationId: string) => ({
      ...groupState,
      conversation_id: conversationId,
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
    expect(ready).toMatchObject({ state: 'ready', protocol: 'mls10-openmls-0.8' });
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
      Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString(
        'base64',
      ),
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
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
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
    await manager.activate(identity({ accountId: 'account-b', deviceId: 'device-b' }));
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.init).toHaveBeenCalledOnce();
  });

  it('closes and blocks a kernel whose encrypted state cannot initialize', async () => {
    const kernel = fakeKernel();
    kernel.init.mockRejectedValueOnce(new Error('snapshot authentication failed'));
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

    expect(kernel.createGroup).toHaveBeenCalledWith(conversationId);
    expect(kernel.encryptApplication).toHaveBeenCalledWith(
      conversationId,
      new Uint8Array([1]),
    );
    expect(kernel.decryptApplication).toHaveBeenCalledWith(
      conversationId,
      'Y2lwaGVydGV4dA==',
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
