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
  type MlsDecryptedApplication,
  type MlsDeviceScope,
  type MlsGroupInspection,
  type MlsGroupState,
  type MlsKeyPackage,
  type MlsMemberInvitation,
  type MlsPendingApplication,
  type MlsStatePersistence,
} from '@otto/native';

export const ENTERPRISE_MLS_CIPHERSUITE =
  'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

export type EnterpriseMlsTransportEventType =
  'welcome' | 'commit' | 'application';

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

export interface EnterpriseMlsTransportClient {
  publishMlsKeyPackage(
    deviceId: string,
    keyPackage: MlsKeyPackage,
  ): Promise<EnterpriseMlsPublishedKeyPackage>;
  claimMlsKeyPackage(
    requesterDeviceId: string,
    recipientAccountId: string,
  ): Promise<EnterpriseMlsPublishedKeyPackage | null>;
  appendMlsTransportEvent(
    peerAccountId: string,
    input: EnterpriseMlsAppendTransportEventInput,
  ): Promise<EnterpriseMlsTransportEvent>;
  listMlsTransportEvents(
    peerAccountId: string,
    afterSequence?: number,
    limit?: number,
  ): Promise<EnterpriseMlsTransportEvent[]>;
}

export interface EnterpriseMlsDecryptedTransportMessage {
  sequence: number;
  eventId: string;
  senderAccountId: string;
  senderDeviceId: string;
  plaintext: Uint8Array;
  createdAt: string;
}

export interface EnterpriseMlsPollResult {
  previousSequence: number;
  nextSequence: number;
  processedEvents: number;
  messages: EnterpriseMlsDecryptedTransportMessage[];
}

export type EnterpriseMlsSessionEstablishment =
  | {
      state: 'ready';
      group: MlsGroupState;
    }
  | {
      state: 'waiting-for-peer-key-package';
      group: MlsGroupState;
    }
  | {
      state: 'waiting-for-peer-commit';
      group: null;
    };

export interface EnterpriseMlsKernel {
  init(): Promise<void>;
  createKeyPackage(): Promise<MlsKeyPackage>;
  listKeyPackages(): Promise<MlsKeyPackage[]>;
  consumeKeyPackage(reference: string): Promise<void>;
  createGroup(conversationId: string): Promise<MlsGroupState>;
  addMember(
    conversationId: string,
    keyPackage: MlsKeyPackage,
  ): Promise<MlsMemberInvitation>;
  mergePendingCommit(conversationId: string): Promise<MlsGroupState>;
  inspectGroup(conversationId: string): Promise<MlsGroupInspection | null>;
  joinGroup(
    conversationId: string,
    keyPackageReference: string,
    expectedGroupId: string,
    welcome: string,
  ): Promise<MlsGroupState>;
  encryptTransportApplication(
    conversationId: string,
    plaintext: Uint8Array,
  ): Promise<MlsPendingApplication>;
  listPendingApplications(
    conversationId: string,
  ): Promise<MlsPendingApplication[]>;
  acknowledgePendingApplication(
    conversationId: string,
    eventId: string,
  ): Promise<void>;
  transportCursor(conversationId: string): Promise<number>;
  acknowledgeTransportEvent(
    conversationId: string,
    sequence: number,
  ): Promise<void>;
  decryptTransportApplication(
    conversationId: string,
    ciphertext: string,
    sequence: number,
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

export function enterpriseMlsTransportEventId(input: {
  conversationId: string;
  eventType: EnterpriseMlsTransportEventType;
  groupId: string;
  epoch: number;
  payload: string;
  keyPackageReference?: string | null;
  recipientDeviceId?: string | null;
}): string {
  return `mls-${createHash('sha256')
    .update('otto:mls-transport-event:v1\n')
    .update(
      JSON.stringify([
        input.conversationId,
        input.eventType,
        input.groupId,
        input.epoch,
        input.payload,
        input.keyPackageReference ?? null,
        input.recipientDeviceId ?? null,
      ]),
    )
    .digest('hex')}`;
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

  listKeyPackages(): Promise<MlsKeyPackage[]> {
    return this.withReadyKernel((active) => active.kernel.listKeyPackages());
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

  inspectGroup(peerAccountId: string): Promise<MlsGroupInspection | null> {
    return this.withReadyKernel((active) =>
      active.kernel.inspectGroup(this.conversationId(active, peerAccountId)),
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

  encryptTransportApplication(
    peerAccountId: string,
    plaintext: Uint8Array,
  ): Promise<MlsPendingApplication> {
    return this.withReadyKernel((active) =>
      active.kernel.encryptTransportApplication(
        this.conversationId(active, peerAccountId),
        plaintext,
      ),
    );
  }

  listPendingApplications(
    peerAccountId: string,
  ): Promise<MlsPendingApplication[]> {
    return this.withReadyKernel((active) =>
      active.kernel.listPendingApplications(
        this.conversationId(active, peerAccountId),
      ),
    );
  }

  acknowledgePendingApplication(
    peerAccountId: string,
    eventId: string,
  ): Promise<void> {
    return this.withReadyKernel((active) =>
      active.kernel.acknowledgePendingApplication(
        this.conversationId(active, peerAccountId),
        eventId,
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

  activeScope(): MlsDeviceScope {
    const active = this.requireReadyKernel();
    return { ...active.scope };
  }

  transportCursor(peerAccountId: string): Promise<number> {
    return this.withReadyKernel((active) =>
      active.kernel.transportCursor(this.conversationId(active, peerAccountId)),
    );
  }

  advanceTransportCursor(
    peerAccountId: string,
    sequence: number,
  ): Promise<void> {
    return this.withReadyKernel((active) =>
      active.kernel.acknowledgeTransportEvent(
        this.conversationId(active, peerAccountId),
        sequence,
      ),
    );
  }

  decryptTransportApplication(
    peerAccountId: string,
    ciphertext: string,
    sequence: number,
  ): Promise<MlsDecryptedApplication> {
    return this.withReadyKernel((active) =>
      active.kernel.decryptTransportApplication(
        this.conversationId(active, peerAccountId),
        ciphertext,
        sequence,
      ),
    );
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

export interface EnterpriseMlsSessionOperations {
  activeScope(): MlsDeviceScope;
  createKeyPackage(): Promise<MlsKeyPackage>;
  listKeyPackages(): Promise<MlsKeyPackage[]>;
  createGroup(peerAccountId: string): Promise<MlsGroupState>;
  addMember(
    peerAccountId: string,
    keyPackage: MlsKeyPackage,
  ): Promise<MlsMemberInvitation>;
  mergePendingCommit(peerAccountId: string): Promise<MlsGroupState>;
  inspectGroup(peerAccountId: string): Promise<MlsGroupInspection | null>;
  joinGroup(
    peerAccountId: string,
    keyPackageReference: string,
    expectedGroupId: string,
    welcome: string,
  ): Promise<MlsGroupState>;
  encryptTransportApplication(
    peerAccountId: string,
    plaintext: Uint8Array,
  ): Promise<MlsPendingApplication>;
  listPendingApplications(
    peerAccountId: string,
  ): Promise<MlsPendingApplication[]>;
  acknowledgePendingApplication(
    peerAccountId: string,
    eventId: string,
  ): Promise<void>;
  transportCursor(peerAccountId: string): Promise<number>;
  advanceTransportCursor(
    peerAccountId: string,
    sequence: number,
  ): Promise<void>;
  decryptTransportApplication(
    peerAccountId: string,
    ciphertext: string,
    sequence: number,
  ): Promise<MlsDecryptedApplication>;
}

/**
 * Crash-resumable transport orchestration for the inactive MLS path. It is
 * intentionally not connected to the production chat send/read APIs yet.
 */
export class EnterpriseMlsSessionCoordinator {
  private readonly peerOperations = new Map<string, Promise<void>>();
  private readonly publicationOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: EnterpriseMlsSessionOperations,
    private readonly transport: EnterpriseMlsTransportClient,
  ) {}

  ensurePublishedKeyPackage(): Promise<EnterpriseMlsPublishedKeyPackage> {
    const scope = this.sessions.activeScope();
    const key = JSON.stringify([
      scope.serverUrl,
      scope.organizationId,
      scope.accountId,
      scope.deviceId,
    ]);
    return this.exclusive(this.publicationOperations, key, async () => {
      const existing = await this.sessions.listKeyPackages();
      for (const keyPackage of existing) {
        try {
          return await this.transport.publishMlsKeyPackage(
            scope.deviceId,
            keyPackage,
          );
        } catch (error) {
          if (!this.isKeyPackageReuse(error)) throw error;
        }
      }
      const created = await this.sessions.createKeyPackage();
      return this.transport.publishMlsKeyPackage(scope.deviceId, created);
    });
  }

  establishDirectSession(
    peerAccountId: string,
  ): Promise<EnterpriseMlsSessionEstablishment> {
    return this.exclusive(this.peerOperations, peerAccountId, async () => {
      const scope = this.sessions.activeScope();
      const conversationId = enterpriseMlsDirectConversationId({
        organizationId: scope.organizationId,
        accountId: scope.accountId,
        peerAccountId,
      });
      let inspection = await this.sessions.inspectGroup(peerAccountId);
      if (!inspection) {
        if (scope.accountId > peerAccountId) {
          return { state: 'waiting-for-peer-commit', group: null };
        }
        const group = await this.sessions.createGroup(peerAccountId);
        inspection = {
          ...group,
          pending_commit: false,
          pending_invitation: null,
        };
      }
      if (
        inspection.pending_commit !== Boolean(inspection.pending_invitation)
      ) {
        throw new Error(
          'MLS pending member state is incomplete; security state reset is required',
        );
      }
      if (
        inspection.pending_commit &&
        (inspection.epoch !== 0 || inspection.member_count !== 1)
      ) {
        throw new Error(
          'MLS pending invitation is not an initial direct-session commit',
        );
      }
      if (!inspection.pending_commit && inspection.member_count >= 2) {
        return { state: 'ready', group: inspection };
      }
      if (
        !inspection.pending_commit &&
        (inspection.epoch !== 0 || inspection.member_count !== 1)
      ) {
        throw new Error(
          'MLS group is not eligible for initial member establishment',
        );
      }

      let invitation = inspection.pending_invitation;
      if (!invitation) {
        const claimed = await this.transport.claimMlsKeyPackage(
          scope.deviceId,
          peerAccountId,
        );
        if (!claimed) {
          return { state: 'waiting-for-peer-key-package', group: inspection };
        }
        invitation = await this.sessions.addMember(peerAccountId, {
          protocol: PROTOCOL,
          ciphersuite: ENTERPRISE_MLS_CIPHERSUITE,
          reference: claimed.reference,
          key_package: claimed.keyPackage,
        });
        if (
          invitation.key_package_reference !== claimed.reference ||
          invitation.recipient_device_id !== claimed.deviceId ||
          claimed.accountId !== peerAccountId
        ) {
          throw new Error(
            'MLS claimed KeyPackage credential binding is invalid',
          );
        }
      }

      const targetEpoch = invitation.epoch + 1;
      const commitId = enterpriseMlsTransportEventId({
        conversationId,
        eventType: 'commit',
        groupId: invitation.group_id,
        epoch: targetEpoch,
        payload: invitation.commit,
      });
      await this.transport.appendMlsTransportEvent(peerAccountId, {
        senderDeviceId: scope.deviceId,
        eventId: commitId,
        eventType: 'commit',
        epoch: targetEpoch,
        groupId: invitation.group_id,
        payload: invitation.commit,
      });
      const welcomeId = enterpriseMlsTransportEventId({
        conversationId,
        eventType: 'welcome',
        groupId: invitation.group_id,
        epoch: targetEpoch,
        payload: invitation.welcome,
        keyPackageReference: invitation.key_package_reference,
        recipientDeviceId: invitation.recipient_device_id,
      });
      await this.transport.appendMlsTransportEvent(peerAccountId, {
        senderDeviceId: scope.deviceId,
        eventId: welcomeId,
        eventType: 'welcome',
        epoch: targetEpoch,
        groupId: invitation.group_id,
        payload: invitation.welcome,
        recipientDeviceId: invitation.recipient_device_id,
        keyPackageReference: invitation.key_package_reference,
      });
      const group = await this.sessions.mergePendingCommit(peerAccountId);
      if (
        group.group_id !== invitation.group_id ||
        group.epoch !== targetEpoch ||
        group.member_count < 2
      ) {
        throw new Error('MLS merged group state does not match the invitation');
      }
      return { state: 'ready', group };
    });
  }

  flushPendingApplications(
    peerAccountId: string,
  ): Promise<EnterpriseMlsTransportEvent[]> {
    return this.exclusive(this.peerOperations, peerAccountId, async () => {
      const scope = this.sessions.activeScope();
      return this.flushPendingApplicationsUnlocked(peerAccountId, scope);
    });
  }

  sendApplication(
    peerAccountId: string,
    plaintext: Uint8Array,
  ): Promise<EnterpriseMlsTransportEvent> {
    return this.exclusive(this.peerOperations, peerAccountId, async () => {
      const scope = this.sessions.activeScope();
      await this.flushPendingApplicationsUnlocked(peerAccountId, scope);
      const group = await this.sessions.inspectGroup(peerAccountId);
      this.assertApplicationGroupReady(group);
      const pending = await this.sessions.encryptTransportApplication(
        peerAccountId,
        plaintext,
      );
      this.assertPendingApplicationMatchesGroup(
        peerAccountId,
        scope,
        pending,
        group,
      );
      return this.deliverPendingApplication(peerAccountId, scope, pending);
    });
  }

  poll(peerAccountId: string, limit = 100): Promise<EnterpriseMlsPollResult> {
    return this.exclusive(this.peerOperations, peerAccountId, async () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new Error('MLS poll limit is invalid');
      }
      const scope = this.sessions.activeScope();
      const previousSequence =
        await this.sessions.transportCursor(peerAccountId);
      let nextSequence = previousSequence;
      const messages: EnterpriseMlsDecryptedTransportMessage[] = [];
      const events = await this.transport.listMlsTransportEvents(
        peerAccountId,
        previousSequence,
        limit,
      );
      for (const event of events) {
        if (event.sequence <= nextSequence) {
          throw new Error(
            'MLS transport returned a non-monotonic event cursor',
          );
        }
        const ownEvent = event.senderAccountId === scope.accountId;
        if (event.eventType === 'commit') {
          const group = await this.sessions.inspectGroup(peerAccountId);
          if (!ownEvent && !group && event.epoch !== 1) {
            throw new Error('initial remote MLS Commit must use epoch one');
          }
          if (
            !ownEvent &&
            group &&
            !(
              !group.pending_commit &&
              group.group_id === event.groupId &&
              group.epoch >= event.epoch
            )
          ) {
            throw new Error(
              'remote MLS Commit processing is not implemented; security state reset is required',
            );
          }
          await this.sessions.advanceTransportCursor(
            peerAccountId,
            event.sequence,
          );
        } else if (event.eventType === 'welcome') {
          await this.processWelcome(peerAccountId, event, scope, ownEvent);
          await this.sessions.advanceTransportCursor(
            peerAccountId,
            event.sequence,
          );
        } else if (ownEvent) {
          await this.sessions.advanceTransportCursor(
            peerAccountId,
            event.sequence,
          );
        } else {
          const group = await this.sessions.inspectGroup(peerAccountId);
          if (
            !group ||
            group.pending_commit ||
            group.group_id !== event.groupId ||
            group.epoch !== event.epoch
          ) {
            throw new Error(
              'MLS application event does not match active group state',
            );
          }
          const decrypted = await this.sessions.decryptTransportApplication(
            peerAccountId,
            event.payload,
            event.sequence,
          );
          const sender = decrypted.senderDeviceScope.split('/');
          if (
            decrypted.groupId !== event.groupId ||
            decrypted.epoch !== event.epoch ||
            sender.length !== 4 ||
            sender[2] !== event.senderAccountId ||
            sender[3] !== event.senderDeviceId
          ) {
            throw new Error('MLS application sender binding is invalid');
          }
          messages.push({
            sequence: event.sequence,
            eventId: event.eventId,
            senderAccountId: event.senderAccountId,
            senderDeviceId: event.senderDeviceId,
            plaintext: decrypted.plaintext,
            createdAt: event.createdAt,
          });
        }
        nextSequence = event.sequence;
      }
      return {
        previousSequence,
        nextSequence,
        processedEvents: events.length,
        messages,
      };
    });
  }

  private async processWelcome(
    peerAccountId: string,
    event: EnterpriseMlsTransportEvent,
    scope: MlsDeviceScope,
    ownEvent: boolean,
  ): Promise<void> {
    const group = await this.sessions.inspectGroup(peerAccountId);
    if (ownEvent) {
      if (event.senderDeviceId !== scope.deviceId) return;
      const invitation = group?.pending_invitation;
      if (invitation) {
        if (
          invitation.group_id !== event.groupId ||
          invitation.epoch + 1 !== event.epoch ||
          invitation.key_package_reference !== event.keyPackageReference ||
          invitation.recipient_device_id !== event.recipientDeviceId ||
          invitation.welcome !== event.payload
        ) {
          throw new Error(
            'MLS pending invitation does not match Welcome event',
          );
        }
        await this.sessions.mergePendingCommit(peerAccountId);
        return;
      }
      if (group?.group_id === event.groupId && group.epoch >= event.epoch)
        return;
      throw new Error('MLS outgoing Welcome has no matching local invitation');
    }
    if (event.recipientDeviceId !== scope.deviceId) {
      return;
    }
    if (group) {
      if (
        !group.pending_commit &&
        group.group_id === event.groupId &&
        group.epoch >= event.epoch
      ) {
        return;
      }
      throw new Error(
        'MLS Welcome conflicts with local group; security state reset is required',
      );
    }
    const joined = await this.sessions.joinGroup(
      peerAccountId,
      event.keyPackageReference!,
      event.groupId,
      event.payload,
    );
    if (joined.group_id !== event.groupId || joined.epoch !== event.epoch) {
      throw new Error('MLS joined group does not match Welcome event');
    }
  }

  private async flushPendingApplicationsUnlocked(
    peerAccountId: string,
    scope: MlsDeviceScope,
  ): Promise<EnterpriseMlsTransportEvent[]> {
    const pending = await this.sessions.listPendingApplications(peerAccountId);
    if (pending.length === 0) return [];
    const group = await this.sessions.inspectGroup(peerAccountId);
    this.assertApplicationGroupReady(group);
    const delivered: EnterpriseMlsTransportEvent[] = [];
    for (const application of pending) {
      this.assertPendingApplicationMatchesGroup(
        peerAccountId,
        scope,
        application,
        group,
      );
      delivered.push(
        await this.deliverPendingApplication(
          peerAccountId,
          scope,
          application,
        ),
      );
    }
    return delivered;
  }

  private async deliverPendingApplication(
    peerAccountId: string,
    scope: MlsDeviceScope,
    pending: MlsPendingApplication,
  ): Promise<EnterpriseMlsTransportEvent> {
    const event = await this.transport.appendMlsTransportEvent(peerAccountId, {
      senderDeviceId: scope.deviceId,
      eventId: pending.event_id,
      eventType: 'application',
      epoch: pending.epoch,
      groupId: pending.group_id,
      payload: pending.ciphertext,
    });
    if (
      event.eventId !== pending.event_id ||
      event.conversationId !== pending.conversation_id ||
      event.senderAccountId !== scope.accountId ||
      event.senderDeviceId !== scope.deviceId ||
      event.recipientAccountId !== null ||
      event.recipientDeviceId !== null ||
      event.eventType !== 'application' ||
      event.epoch !== pending.epoch ||
      event.groupId !== pending.group_id ||
      event.payload !== pending.ciphertext ||
      event.keyPackageReference !== null
    ) {
      throw new Error('MLS application acknowledgement binding is invalid');
    }
    await this.sessions.acknowledgePendingApplication(
      peerAccountId,
      pending.event_id,
    );
    return event;
  }

  private assertApplicationGroupReady(
    group: MlsGroupInspection | null,
  ): asserts group is MlsGroupInspection {
    if (!group || group.pending_commit || group.member_count < 2) {
      throw new Error('MLS direct session is not ready for application messages');
    }
  }

  private assertPendingApplicationMatchesGroup(
    peerAccountId: string,
    scope: MlsDeviceScope,
    pending: MlsPendingApplication,
    group: MlsGroupInspection,
  ): void {
    const conversationId = enterpriseMlsDirectConversationId({
      organizationId: scope.organizationId,
      accountId: scope.accountId,
      peerAccountId,
    });
    if (
      pending.conversation_id !== conversationId ||
      pending.group_id !== group.group_id ||
      pending.epoch !== group.epoch
    ) {
      throw new Error(
        'MLS pending application does not match active group state; security state reset is required',
      );
    }
  }

  private isKeyPackageReuse(error: unknown): boolean {
    return (
      error instanceof Error &&
      /MLS KeyPackage reference conflict or reuse/i.test(error.message)
    );
  }

  private exclusive<T>(
    operations: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = operations.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    operations.set(key, settled);
    void settled.finally(() => {
      if (operations.get(key) === settled) operations.delete(key);
    });
    return result;
  }
}
