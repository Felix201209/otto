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
  type MlsApplicationCiphertext,
  type MlsDecryptedApplication,
  type MlsDeviceScope,
  type MlsGroupState,
  type MlsKeyPackage,
  type MlsMemberInvitation,
  type MlsStatePersistence,
} from '@otto/native';

export const ENTERPRISE_MLS_CIPHERSUITE =
  'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

export type EnterpriseMlsTransportEventType =
  | 'welcome'
  | 'commit'
  | 'application';

export interface EnterpriseMlsPublishedKeyPackage {
  reference: string;
  accountId: string;
  deviceId: string;
  ciphersuite: typeof ENTERPRISE_MLS_CIPHERSUITE;
  keyPackage: string;
  createdAt: string;
  claimedAt: string | null;
  expiresAt: string;
}

export interface EnterpriseMlsAppendTransportEventInput {
  senderDeviceId: string;
  eventId: string;
  eventType: EnterpriseMlsTransportEventType;
  epoch: number;
  groupId: string;
  payload: string;
  recipientDeviceId?: string | null;
  keyPackageReference?: string | null;
  resetFromGroupId?: string | null;
}

export interface EnterpriseMlsTransportEvent {
  sequence: number;
  eventId: string;
  conversationId: string;
  sessionGeneration: number;
  senderAccountId: string;
  senderDeviceId: string;
  recipientAccountId: string | null;
  recipientDeviceId: string | null;
  eventType: EnterpriseMlsTransportEventType;
  epoch: number;
  groupId: string;
  payload: string;
  keyPackageReference: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface EnterpriseMlsKernel {
  init(): Promise<void>;
  createKeyPackage(): Promise<MlsKeyPackage>;
  consumeKeyPackage(reference: string): Promise<void>;
  createGroup(conversationId: string): Promise<MlsGroupState>;
  addMember(
    conversationId: string,
    keyPackage: MlsKeyPackage,
  ): Promise<MlsMemberInvitation>;
  mergePendingCommit(conversationId: string): Promise<MlsGroupState>;
  joinGroup(
    conversationId: string,
    keyPackageReference: string,
    expectedGroupId: string,
    welcome: string,
  ): Promise<MlsGroupState>;
  encryptApplication(
    conversationId: string,
    plaintext: Uint8Array,
  ): Promise<MlsApplicationCiphertext>;
  decryptApplication(
    conversationId: string,
    ciphertext: string,
  ): Promise<MlsDecryptedApplication>;
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
        | 'native-initialization-failed'
        | 'security-state-reset-failed';
    };

export interface EnterpriseMlsSessionManagerOptions {
  stateDirectory: string;
  secureStorage: EnterpriseMlsSecureStorage;
  binaryPath?: string;
  kernelFactory?: EnterpriseMlsKernelFactory;
}

interface ActiveEnterpriseMlsKernel {
  identityHash: string;
  scope: MlsDeviceScope;
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

export function enterpriseMlsDirectConversationId(input: {
  organizationId: string;
  accountId: string;
  peerAccountId: string;
}): string {
  const identifiers = [
    input.organizationId,
    input.accountId,
    input.peerAccountId,
  ].map((value) => value.trim());
  if (identifiers.some((value) => !IDENTIFIER.test(value))) {
    throw new Error('MLS conversation identity is invalid');
  }
  if (identifiers[1] === identifiers[2]) {
    throw new Error('MLS participants must be different');
  }
  const [participantAAccountId, participantBAccountId] = [
    identifiers[1]!,
    identifiers[2]!,
  ].sort() as [string, string];
  return createHash('sha256')
    .update('otto:mls-direct-conversation:v1\n')
    .update(identifiers[0]!)
    .update('\n')
    .update(participantAAccountId)
    .update('\n')
    .update(participantBAccountId)
    .digest('hex');
}

export function enterpriseMlsKeyPackageReference(keyPackage: string): string {
  if (!isMlsBase64(keyPackage, 64 * 1024)) {
    throw new Error('MLS KeyPackage is invalid');
  }
  return createHash('sha256')
    .update('otto:mls-key-package:v1\n')
    .update(Buffer.from(keyPackage, 'base64'))
    .digest('hex');
}

export function parseEnterpriseMlsPublishedKeyPackage(
  value: unknown,
): EnterpriseMlsPublishedKeyPackage {
  const keyPackage = value as Partial<EnterpriseMlsPublishedKeyPackage>;
  if (
    !keyPackage ||
    !IDENTIFIER.test(keyPackage.accountId ?? '') ||
    !IDENTIFIER.test(keyPackage.deviceId ?? '') ||
    keyPackage.ciphersuite !== ENTERPRISE_MLS_CIPHERSUITE ||
    !isMlsReference(keyPackage.reference) ||
    !isMlsBase64(keyPackage.keyPackage, 64 * 1024) ||
    keyPackage.reference !==
      enterpriseMlsKeyPackageReference(keyPackage.keyPackage) ||
    !isIsoTime(keyPackage.createdAt) ||
    (keyPackage.claimedAt !== null && !isIsoTime(keyPackage.claimedAt)) ||
    !isIsoTime(keyPackage.expiresAt)
  ) {
    throw new Error('enterprise MLS KeyPackage response is invalid');
  }
  return { ...keyPackage } as EnterpriseMlsPublishedKeyPackage;
}

export function parseEnterpriseMlsTransportEvent(
  value: unknown,
): EnterpriseMlsTransportEvent {
  const event = value as Partial<EnterpriseMlsTransportEvent>;
  if (
    !event ||
    !Number.isSafeInteger(event.sequence) ||
    (event.sequence ?? 0) < 1 ||
    !IDENTIFIER.test(event.eventId ?? '') ||
    !/^[0-9a-f]{64}$/.test(event.conversationId ?? '') ||
    !Number.isSafeInteger(event.sessionGeneration) ||
    (event.sessionGeneration ?? 0) < 1 ||
    !IDENTIFIER.test(event.senderAccountId ?? '') ||
    !IDENTIFIER.test(event.senderDeviceId ?? '') ||
    (event.recipientAccountId !== null &&
      !IDENTIFIER.test(event.recipientAccountId ?? '')) ||
    (event.recipientDeviceId !== null &&
      !IDENTIFIER.test(event.recipientDeviceId ?? '')) ||
    !['welcome', 'commit', 'application'].includes(event.eventType ?? '') ||
    !Number.isSafeInteger(event.epoch) ||
    (event.epoch ?? -1) < 0 ||
    !isMlsBase64(event.groupId, 255) ||
    !isMlsBase64(event.payload, 1024 * 1024) ||
    (event.keyPackageReference !== null &&
      !isMlsReference(event.keyPackageReference)) ||
    !isIsoTime(event.createdAt) ||
    !isIsoTime(event.expiresAt)
  ) {
    throw new Error('enterprise MLS transport event response is invalid');
  }
  if (
    event.eventType === 'welcome'
      ? !event.recipientAccountId ||
        !event.recipientDeviceId ||
        !event.keyPackageReference
      : event.recipientAccountId !== null ||
        event.recipientDeviceId !== null ||
        event.keyPackageReference !== null
  ) {
    throw new Error('enterprise MLS transport event binding is invalid');
  }
  return { ...event } as EnterpriseMlsTransportEvent;
}

function isMlsReference(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isMlsBase64(value: unknown, maxBytes: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return false;
  }
  return Buffer.byteLength(Buffer.from(value, 'base64')) <= maxBytes;
}

function isIsoTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
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
      this.active = { identityHash: hash, scope, kernel };
      this.currentStatus = {
        state: 'ready',
        protocol: PROTOCOL,
        identityHash: hash,
      };
      return this.status();
    });
  }

  createKeyPackage(): Promise<MlsKeyPackage> {
    return this.withReadyKernel((active) => active.kernel.createKeyPackage());
  }

  consumeKeyPackage(reference: string): Promise<void> {
    return this.withReadyKernel((active) =>
      active.kernel.consumeKeyPackage(reference),
    );
  }

  createGroup(peerAccountId: string): Promise<MlsGroupState> {
    return this.withReadyKernel((active) =>
      active.kernel.createGroup(this.conversationId(active, peerAccountId)),
    );
  }

  addMember(
    peerAccountId: string,
    keyPackage: MlsKeyPackage,
  ): Promise<MlsMemberInvitation> {
    return this.withReadyKernel((active) =>
      active.kernel.addMember(
        this.conversationId(active, peerAccountId),
        keyPackage,
      ),
    );
  }

  mergePendingCommit(peerAccountId: string): Promise<MlsGroupState> {
    return this.withReadyKernel((active) =>
      active.kernel.mergePendingCommit(
        this.conversationId(active, peerAccountId),
      ),
    );
  }

  joinGroup(
    peerAccountId: string,
    keyPackageReference: string,
    expectedGroupId: string,
    welcome: string,
  ): Promise<MlsGroupState> {
    return this.withReadyKernel((active) =>
      active.kernel.joinGroup(
        this.conversationId(active, peerAccountId),
        keyPackageReference,
        expectedGroupId,
        welcome,
      ),
    );
  }

  encryptApplication(
    peerAccountId: string,
    plaintext: Uint8Array,
  ): Promise<MlsApplicationCiphertext> {
    return this.withReadyKernel((active) =>
      active.kernel.encryptApplication(
        this.conversationId(active, peerAccountId),
        plaintext,
      ),
    );
  }

  decryptApplication(
    peerAccountId: string,
    ciphertext: string,
  ): Promise<MlsDecryptedApplication> {
    return this.withReadyKernel((active) =>
      active.kernel.decryptApplication(
        this.conversationId(active, peerAccountId),
        ciphertext,
      ),
    );
  }

  resetSecurityState(): Promise<void> {
    return this.exclusive(async () => {
      const active = this.requireReadyKernel();
      try {
        await active.kernel.reset();
      } catch (error) {
        await this.closeActive().catch(() => undefined);
        this.currentStatus = {
          state: 'blocked',
          protocol: PROTOCOL,
          reason: 'security-state-reset-failed',
        };
        throw error;
      }
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

  private conversationId(
    active: ActiveEnterpriseMlsKernel,
    peerAccountId: string,
  ): string {
    return enterpriseMlsDirectConversationId({
      organizationId: active.scope.organizationId,
      accountId: active.scope.accountId,
      peerAccountId,
    });
  }

  private requireReadyKernel(): ActiveEnterpriseMlsKernel {
    if (!this.active || this.currentStatus.state !== 'ready') {
      throw new Error('MLS desktop session is not ready');
    }
    return this.active;
  }

  private withReadyKernel<T>(
    operation: (active: ActiveEnterpriseMlsKernel) => Promise<T>,
  ): Promise<T> {
    return this.exclusive(() => operation(this.requireReadyKernel()));
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
