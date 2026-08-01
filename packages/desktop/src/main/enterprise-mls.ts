/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Electron-main ownership boundary for the inactive MLS upgrade path. The
 * renderer and enterprise server receive public KeyPackages/ciphertext only;
 * native state keys are wrapped by Electron safeStorage before touching disk.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  FileMlsStatePersistence,
  OpenMlsNativeKernel,
  type MlsDeviceScope,
  type MlsKeyPackage,
  type MlsStatePersistence,
} from '@otto/native';

export interface EnterpriseMlsKernel {
  init(): Promise<void>;
  createKeyPackage(): Promise<MlsKeyPackage>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface EnterpriseMlsSecureStorage {
  assertAvailable(): void;
  protect(plaintext: string): string;
  unprotect(protectedValue: string): string;
}

export interface EnterpriseMlsKernelFactoryInput {
  scope: MlsDeviceScope;
  statePath: string;
  persistence: MlsStatePersistence;
  binaryPath?: string;
}

export type EnterpriseMlsKernelFactory = (
  input: EnterpriseMlsKernelFactoryInput,
) => EnterpriseMlsKernel;

export interface EnterpriseMlsIdentity extends MlsDeviceScope {
  approvalState: 'pending' | 'approved';
}

export type EnterpriseMlsStatus =
  | { state: 'inactive'; protocol: 'mls10-openmls-0.8' }
  | {
      state: 'ready';
      protocol: 'mls10-openmls-0.8';
      identityHash: string;
    }
  | {
      state: 'blocked';
      protocol: 'mls10-openmls-0.8';
      reason:
        | 'device-not-approved'
        | 'secure-storage-unavailable'
        | 'native-initialization-failed';
    };

export interface EnterpriseMlsSessionManagerOptions {
  stateDirectory: string;
  secureStorage: EnterpriseMlsSecureStorage;
  binaryPath?: string;
  kernelFactory?: EnterpriseMlsKernelFactory;
}

interface ActiveEnterpriseMlsKernel {
  identityHash: string;
  kernel: EnterpriseMlsKernel;
}

const PROTOCOL = 'mls10-openmls-0.8' as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function normalizeIdentity(input: EnterpriseMlsIdentity): MlsDeviceScope {
  let server: URL;
  try {
    server = new URL(input.serverUrl.trim());
  } catch {
    throw new Error('MLS server URL is invalid');
  }
  if (
    !['https:', 'http:'].includes(server.protocol) ||
    server.username ||
    server.password ||
    server.search ||
    server.hash
  ) {
    throw new Error('MLS server URL is invalid');
  }
  const identifiers = [
    input.organizationId,
    input.accountId,
    input.deviceId,
  ].map((value) => value.trim());
  if (identifiers.some((value) => !IDENTIFIER.test(value))) {
    throw new Error('MLS device identity is invalid');
  }
  return {
    serverUrl: `${server.origin}${server.pathname.replace(/\/+$/, '')}`,
    organizationId: identifiers[0]!,
    accountId: identifiers[1]!,
    deviceId: identifiers[2]!,
  };
}

function identityHash(scope: MlsDeviceScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.serverUrl,
        scope.organizationId,
        scope.accountId,
        scope.deviceId,
      ]),
      'utf8',
    )
    .digest('hex');
}

function defaultKernelFactory(
  input: EnterpriseMlsKernelFactoryInput,
): EnterpriseMlsKernel {
  return new OpenMlsNativeKernel(
    input.scope,
    input.binaryPath,
    input.persistence,
  );
}

export class EnterpriseMlsSessionManager {
  private active: ActiveEnterpriseMlsKernel | null = null;
  private currentStatus: EnterpriseMlsStatus = {
    state: 'inactive',
    protocol: PROTOCOL,
  };
  private operation: Promise<void> = Promise.resolve();
  private readonly stateDirectory: string;
  private readonly kernelFactory: EnterpriseMlsKernelFactory;

  constructor(private readonly options: EnterpriseMlsSessionManagerOptions) {
    this.stateDirectory = path.resolve(options.stateDirectory);
    this.kernelFactory = options.kernelFactory ?? defaultKernelFactory;
  }

  status(): EnterpriseMlsStatus {
    return { ...this.currentStatus };
  }

  activate(identity: EnterpriseMlsIdentity): Promise<EnterpriseMlsStatus> {
    return this.exclusive(async () => {
      if (identity.approvalState !== 'approved') {
        await this.closeActive();
        this.currentStatus = {
          state: 'blocked',
          protocol: PROTOCOL,
          reason: 'device-not-approved',
        };
        throw new Error('MLS requires an approved E2EE device');
      }

      try {
        this.options.secureStorage.assertAvailable();
      } catch (error) {
        await this.closeActive();
        this.currentStatus = {
          state: 'blocked',
          protocol: PROTOCOL,
          reason: 'secure-storage-unavailable',
        };
        throw error;
      }

      const scope = normalizeIdentity(identity);
      const hash = identityHash(scope);
      if (this.active?.identityHash === hash) return this.status();
      await this.closeActive();

      const statePath = path.join(this.stateDirectory, `state-${hash}.json`);
      const persistence = new FileMlsStatePersistence({
        filePath: statePath,
        protectStateKey: (plaintext) => {
          this.options.secureStorage.assertAvailable();
          return this.options.secureStorage.protect(plaintext);
        },
        unprotectStateKey: (protectedValue) => {
          this.options.secureStorage.assertAvailable();
          return this.options.secureStorage.unprotect(protectedValue);
        },
      });
      const kernel = this.kernelFactory({
        scope,
        statePath,
        persistence,
        binaryPath: this.options.binaryPath,
      });
      try {
        await kernel.init();
      } catch (error) {
        await kernel.close().catch(() => undefined);
        this.currentStatus = {
          state: 'blocked',
          protocol: PROTOCOL,
          reason: 'native-initialization-failed',
        };
        throw error;
      }
      this.active = { identityHash: hash, kernel };
      this.currentStatus = {
        state: 'ready',
        protocol: PROTOCOL,
        identityHash: hash,
      };
      return this.status();
    });
  }

  createKeyPackage(): Promise<MlsKeyPackage> {
    return this.exclusive(async () => {
      if (!this.active || this.currentStatus.state !== 'ready') {
        throw new Error('MLS desktop session is not ready');
      }
      return this.active.kernel.createKeyPackage();
    });
  }

  close(): Promise<void> {
    return this.exclusive(async () => {
      await this.closeActive();
      this.currentStatus = { state: 'inactive', protocol: PROTOCOL };
    });
  }

  private async closeActive(): Promise<void> {
    const active = this.active;
    this.active = null;
    if (active) await active.kernel.close();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
