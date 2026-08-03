/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Production-facing MLS private-message bridge. Plaintext exists only in the
 * Electron main process and in an authenticated, OS-key-wrapped local history
 * file. A received native inbox item is acknowledged only after that history
 * write succeeds.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { MlsDeviceScope, MlsGroupState } from '@otto/native';

import type {
  EnterpriseMlsPollResult,
  EnterpriseMlsSessionEstablishment,
  EnterpriseMlsTransportEvent,
} from './enterprise-mls.js';
import type { EnterpriseDirectMessageAttachmentUpload } from './enterprise-client.js';

const PROTOCOL = 'mls10-openmls-0.8' as const;
const HISTORY_CIPHER = 'aes-256-gcm' as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MESSAGE_ID = /^mls-message-[0-9a-f-]{36}$/;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_APPLICATION_BYTES = 512 * 1024;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 10_000;

export type EnterpriseMlsContentType =
  'message' | 'atoa_request' | 'atoa_response';

export interface EnterpriseMlsPrivateMessage {
  id: string;
  senderAccountId: string;
  recipientAccountId: string;
  content: string;
  createdAt: string;
  readAt: string | null;
  attachments?: [];
  e2ee: true;
  e2eeProtocol: typeof PROTOCOL;
  contentType: EnterpriseMlsContentType;
  inReplyToMessageId: string | null;
}

export interface StoredEnterpriseMlsPrivateMessage extends EnterpriseMlsPrivateMessage {
  deliveryState: 'pending' | 'delivered';
}

interface EnterpriseMlsApplicationPayload {
  format: 1;
  id: string;
  senderAccountId: string;
  recipientAccountId: string;
  content: string;
  contentType: EnterpriseMlsContentType;
  inReplyToMessageId: string | null;
  createdAt: string;
}

export interface EnterpriseMlsPrivateMessageCoordinator {
  activeScope(): MlsDeviceScope;
  establishDirectSession(
    peerAccountId: string,
  ): Promise<EnterpriseMlsSessionEstablishment>;
  ensureApprovedDeviceMembership?(peerAccountId: string): Promise<unknown>;
  refreshEpoch(peerAccountId: string): Promise<unknown>;
  resetDirectSession?(peerAccountId: string): Promise<unknown>;
  sendApplication(
    peerAccountId: string,
    plaintext: Uint8Array,
  ): Promise<EnterpriseMlsTransportEvent>;
  poll(peerAccountId: string, limit?: number): Promise<EnterpriseMlsPollResult>;
  acknowledgeReceivedApplication(
    peerAccountId: string,
    eventId: string,
  ): Promise<void>;
  listActiveConversationPeers(): Promise<string[]>;
}

export interface EnterpriseMlsMessageHistory {
  list(
    scope: MlsDeviceScope,
    peerAccountId: string,
  ): Promise<StoredEnterpriseMlsPrivateMessage[]>;
  put(
    scope: MlsDeviceScope,
    peerAccountId: string,
    message: StoredEnterpriseMlsPrivateMessage,
  ): Promise<void>;
  pendingOutgoing(
    scope: MlsDeviceScope,
    peerAccountId: string,
  ): Promise<StoredEnterpriseMlsPrivateMessage[]>;
  markOutgoingDelivered(
    scope: MlsDeviceScope,
    peerAccountId: string,
    messageId: string,
  ): Promise<void>;
  markRead(scope: MlsDeviceScope, peerAccountId: string): Promise<void>;
  unread(scope: MlsDeviceScope): Promise<StoredEnterpriseMlsPrivateMessage[]>;
}

export interface EnterpriseMlsHistorySecureStorage {
  assertAvailable(): void;
  protect(plaintext: string): string;
  unprotect(protectedValue: string): string;
}

export interface FileEnterpriseMlsMessageHistoryOptions {
  directory: string;
  secureStorage: EnterpriseMlsHistorySecureStorage;
}

interface HistoryState {
  format: 1;
  identityHash: string;
  messages: StoredEnterpriseMlsPrivateMessage[];
}

interface HistoryManifest {
  format: 1;
  keyProtection: 'os-secure-storage';
  cipher: typeof HISTORY_CIPHER;
  protectedStateKey: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
}

interface LoadedHistory {
  state: HistoryState;
  stateKey: Buffer | null;
  protectedStateKey: string | null;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function requireIsoTime(value: string, label: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function messageMetadata(content: string): {
  contentType: EnterpriseMlsContentType;
  inReplyToMessageId: string | null;
} {
  if (content.startsWith('OTTO_ATOA_REQUEST ')) {
    return { contentType: 'atoa_request', inReplyToMessageId: null };
  }
  if (content.startsWith('OTTO_ATOA_RESPONSE ')) {
    try {
      const parsed = JSON.parse(
        content.slice('OTTO_ATOA_RESPONSE '.length),
      ) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).requestId === 'string'
      ) {
        return {
          contentType: 'atoa_response',
          inReplyToMessageId: (parsed as Record<string, string>).requestId,
        };
      }
    } catch {
      // Invalid A2A content is an ordinary private message.
    }
  }
  return { contentType: 'message', inReplyToMessageId: null };
}

function identityHash(scope: MlsDeviceScope): string {
  const normalized = {
    serverUrl: new URL(scope.serverUrl).origin,
    organizationId: requireIdentifier(scope.organizationId, 'organization id'),
    accountId: requireIdentifier(scope.accountId, 'account id'),
    deviceId: requireIdentifier(scope.deviceId, 'device id'),
  };
  return createHash('sha256')
    .update('otto:mls-message-history:v1\n')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

function historyAad(hash: string): Buffer {
  return Buffer.from(`otto:mls-message-history:v1\n${hash}`, 'utf8');
}

function historyFileName(scope: MlsDeviceScope): string {
  return `history-${identityHash(scope)}.json`;
}

function publicMessage(
  message: StoredEnterpriseMlsPrivateMessage,
): EnterpriseMlsPrivateMessage {
  const { deliveryState: _deliveryState, ...view } = message;
  return view;
}

function validateStoredMessage(
  value: unknown,
): StoredEnterpriseMlsPrivateMessage {
  const message = value as Partial<StoredEnterpriseMlsPrivateMessage>;
  if (
    !message ||
    typeof message.id !== 'string' ||
    !MESSAGE_ID.test(message.id) ||
    typeof message.senderAccountId !== 'string' ||
    !IDENTIFIER.test(message.senderAccountId) ||
    typeof message.recipientAccountId !== 'string' ||
    !IDENTIFIER.test(message.recipientAccountId) ||
    message.senderAccountId === message.recipientAccountId ||
    typeof message.content !== 'string' ||
    Buffer.byteLength(message.content, 'utf8') > MAX_CONTENT_BYTES ||
    typeof message.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(message.createdAt)) ||
    (message.readAt !== null &&
      (typeof message.readAt !== 'string' ||
        !Number.isFinite(Date.parse(message.readAt)))) ||
    message.e2ee !== true ||
    message.e2eeProtocol !== PROTOCOL ||
    !['message', 'atoa_request', 'atoa_response'].includes(
      message.contentType ?? '',
    ) ||
    (message.inReplyToMessageId !== null &&
      (typeof message.inReplyToMessageId !== 'string' ||
        message.inReplyToMessageId.length > 200)) ||
    !['pending', 'delivered'].includes(message.deliveryState ?? '') ||
    (message.attachments !== undefined &&
      (!Array.isArray(message.attachments) || message.attachments.length !== 0))
  ) {
    throw new Error('MLS private-message history entry is invalid');
  }
  return { ...message, attachments: [] } as StoredEnterpriseMlsPrivateMessage;
}

function parseHistoryState(value: unknown, expectedHash: string): HistoryState {
  const state = value as Partial<HistoryState>;
  if (
    state?.format !== 1 ||
    state.identityHash !== expectedHash ||
    !Array.isArray(state.messages) ||
    state.messages.length > MAX_HISTORY_MESSAGES
  ) {
    throw new Error('MLS private-message history is invalid');
  }
  const messages = state.messages.map(validateStoredMessage);
  const ids = new Set(messages.map((message) => message.id));
  if (ids.size !== messages.length) {
    throw new Error('MLS private-message history contains duplicate ids');
  }
  return { format: 1, identityHash: expectedHash, messages };
}

function parseManifest(value: unknown): HistoryManifest {
  const manifest = value as Partial<HistoryManifest>;
  if (
    manifest?.format !== 1 ||
    manifest.keyProtection !== 'os-secure-storage' ||
    manifest.cipher !== HISTORY_CIPHER ||
    typeof manifest.protectedStateKey !== 'string' ||
    !manifest.protectedStateKey ||
    typeof manifest.nonce !== 'string' ||
    Buffer.from(manifest.nonce, 'base64').byteLength !== 12 ||
    typeof manifest.authTag !== 'string' ||
    Buffer.from(manifest.authTag, 'base64').byteLength !== 16 ||
    typeof manifest.ciphertext !== 'string' ||
    !manifest.ciphertext ||
    Buffer.byteLength(manifest.ciphertext, 'base64') > MAX_HISTORY_BYTES
  ) {
    throw new Error('MLS private-message history manifest is invalid');
  }
  return manifest as HistoryManifest;
}

async function writePrivateFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, filePath);
    if (process.platform !== 'win32') {
      await fs.promises.chmod(filePath, 0o600);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export class FileEnterpriseMlsMessageHistory implements EnterpriseMlsMessageHistory {
  private operation: Promise<void> = Promise.resolve();
  private readonly directory: string;

  constructor(
    private readonly options: FileEnterpriseMlsMessageHistoryOptions,
  ) {
    this.directory = path.resolve(options.directory);
  }

  list(
    scope: MlsDeviceScope,
    peerAccountId: string,
  ): Promise<StoredEnterpriseMlsPrivateMessage[]> {
    return this.exclusive(async () => {
      const loaded = await this.load(scope);
      try {
        return this.peerMessages(loaded.state, scope, peerAccountId);
      } finally {
        loaded.stateKey?.fill(0);
      }
    });
  }

  put(
    scope: MlsDeviceScope,
    peerAccountId: string,
    rawMessage: StoredEnterpriseMlsPrivateMessage,
  ): Promise<void> {
    return this.exclusive(async () => {
      const message = validateStoredMessage(rawMessage);
      this.assertMessageParticipants(scope, peerAccountId, message);
      const loaded = await this.load(scope);
      try {
        const existingIndex = loaded.state.messages.findIndex(
          (candidate) => candidate.id === message.id,
        );
        if (existingIndex >= 0) {
          const existing = loaded.state.messages[existingIndex]!;
          const samePayload =
            existing.senderAccountId === message.senderAccountId &&
            existing.recipientAccountId === message.recipientAccountId &&
            existing.content === message.content &&
            existing.contentType === message.contentType &&
            existing.inReplyToMessageId === message.inReplyToMessageId &&
            existing.createdAt === message.createdAt;
          if (!samePayload) {
            throw new Error(
              'MLS private-message id conflicts with local history',
            );
          }
          loaded.state.messages[existingIndex] = {
            ...existing,
            readAt: existing.readAt ?? message.readAt,
            deliveryState:
              existing.deliveryState === 'delivered' ||
              message.deliveryState === 'delivered'
                ? 'delivered'
                : 'pending',
          };
        } else {
          if (loaded.state.messages.length >= MAX_HISTORY_MESSAGES) {
            throw new Error('MLS private-message history capacity exceeded');
          }
          loaded.state.messages.push(message);
        }
        await this.save(scope, loaded);
      } finally {
        loaded.stateKey?.fill(0);
      }
    });
  }

  pendingOutgoing(
    scope: MlsDeviceScope,
    peerAccountId: string,
  ): Promise<StoredEnterpriseMlsPrivateMessage[]> {
    return this.exclusive(async () => {
      const loaded = await this.load(scope);
      try {
        return this.peerMessages(loaded.state, scope, peerAccountId).filter(
          (message) =>
            message.senderAccountId === scope.accountId &&
            message.deliveryState === 'pending',
        );
      } finally {
        loaded.stateKey?.fill(0);
      }
    });
  }

  markOutgoingDelivered(
    scope: MlsDeviceScope,
    peerAccountId: string,
    messageId: string,
  ): Promise<void> {
    return this.update(scope, peerAccountId, (messages) => {
      const message = messages.find((candidate) => candidate.id === messageId);
      if (!message || message.senderAccountId !== scope.accountId) {
        throw new Error('MLS outgoing message history entry is missing');
      }
      message.deliveryState = 'delivered';
    });
  }

  markRead(scope: MlsDeviceScope, peerAccountId: string): Promise<void> {
    return this.update(scope, peerAccountId, (messages) => {
      const readAt = new Date().toISOString();
      for (const message of messages) {
        if (message.recipientAccountId === scope.accountId && !message.readAt) {
          message.readAt = readAt;
        }
      }
    });
  }

  unread(scope: MlsDeviceScope): Promise<StoredEnterpriseMlsPrivateMessage[]> {
    return this.exclusive(async () => {
      const loaded = await this.load(scope);
      try {
        return loaded.state.messages
          .filter(
            (message) =>
              message.recipientAccountId === scope.accountId && !message.readAt,
          )
          .map((message) => ({ ...message, attachments: [] }));
      } finally {
        loaded.stateKey?.fill(0);
      }
    });
  }

  private update(
    scope: MlsDeviceScope,
    peerAccountId: string,
    mutate: (messages: StoredEnterpriseMlsPrivateMessage[]) => void,
  ): Promise<void> {
    return this.exclusive(async () => {
      const loaded = await this.load(scope);
      try {
        const messages = this.peerMessages(loaded.state, scope, peerAccountId);
        mutate(messages);
        const updates = new Map(
          messages.map((message) => [message.id, message]),
        );
        loaded.state.messages = loaded.state.messages.map(
          (message) => updates.get(message.id) ?? message,
        );
        await this.save(scope, loaded);
      } finally {
        loaded.stateKey?.fill(0);
      }
    });
  }

  private peerMessages(
    state: HistoryState,
    scope: MlsDeviceScope,
    rawPeerAccountId: string,
  ): StoredEnterpriseMlsPrivateMessage[] {
    const peerAccountId = requireIdentifier(
      rawPeerAccountId,
      'peer account id',
    );
    if (peerAccountId === scope.accountId) {
      throw new Error('MLS private-message peer account is invalid');
    }
    return state.messages
      .filter(
        (message) =>
          [message.senderAccountId, message.recipientAccountId]
            .sort()
            .join('\n') === [scope.accountId, peerAccountId].sort().join('\n'),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .map((message) => ({ ...message, attachments: [] }));
  }

  private assertMessageParticipants(
    scope: MlsDeviceScope,
    peerAccountId: string,
    message: StoredEnterpriseMlsPrivateMessage,
  ): void {
    requireIdentifier(peerAccountId, 'peer account id');
    const expected = [scope.accountId, peerAccountId].sort().join('\n');
    const actual = [message.senderAccountId, message.recipientAccountId]
      .sort()
      .join('\n');
    if (expected !== actual) {
      throw new Error('MLS private-message participant binding is invalid');
    }
  }

  private async load(scope: MlsDeviceScope): Promise<LoadedHistory> {
    this.options.secureStorage.assertAvailable();
    const hash = identityHash(scope);
    const filePath = path.join(this.directory, historyFileName(scope));
    let serialized: string;
    try {
      serialized = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          state: { format: 1, identityHash: hash, messages: [] },
          stateKey: null,
          protectedStateKey: null,
        };
      }
      throw error;
    }
    const manifest = parseManifest(JSON.parse(serialized));
    const encodedKey = this.options.secureStorage.unprotect(
      manifest.protectedStateKey,
    );
    const stateKey = Buffer.from(encodedKey, 'base64');
    if (stateKey.byteLength !== 32) {
      stateKey.fill(0);
      throw new Error('MLS private-message history key is invalid');
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        stateKey,
        Buffer.from(manifest.nonce, 'base64'),
      );
      decipher.setAAD(historyAad(hash));
      decipher.setAuthTag(Buffer.from(manifest.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(manifest.ciphertext, 'base64')),
        decipher.final(),
      ]);
      try {
        if (plaintext.byteLength > MAX_HISTORY_BYTES) {
          throw new Error('MLS private-message history capacity exceeded');
        }
        return {
          state: parseHistoryState(
            JSON.parse(plaintext.toString('utf8')),
            hash,
          ),
          stateKey,
          protectedStateKey: manifest.protectedStateKey,
        };
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      stateKey.fill(0);
      throw error;
    }
  }

  private async save(
    scope: MlsDeviceScope,
    loaded: LoadedHistory,
  ): Promise<void> {
    this.options.secureStorage.assertAvailable();
    const hash = identityHash(scope);
    const plaintext = Buffer.from(JSON.stringify(loaded.state), 'utf8');
    if (plaintext.byteLength > MAX_HISTORY_BYTES) {
      plaintext.fill(0);
      throw new Error('MLS private-message history capacity exceeded');
    }
    const stateKey = loaded.stateKey ?? randomBytes(32);
    try {
      const protectedStateKey =
        loaded.protectedStateKey ??
        this.options.secureStorage.protect(stateKey.toString('base64'));
      const nonce = randomBytes(12);
      try {
        const cipher = createCipheriv('aes-256-gcm', stateKey, nonce);
        cipher.setAAD(historyAad(hash));
        const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]);
        const manifest: HistoryManifest = {
          format: 1,
          keyProtection: 'os-secure-storage',
          cipher: HISTORY_CIPHER,
          protectedStateKey,
          nonce: nonce.toString('base64'),
          authTag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        };
        await writePrivateFileAtomic(
          path.join(this.directory, historyFileName(scope)),
          `${JSON.stringify(manifest)}\n`,
        );
        ciphertext.fill(0);
      } finally {
        nonce.fill(0);
      }
    } finally {
      plaintext.fill(0);
      if (!loaded.stateKey) stateKey.fill(0);
    }
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

export interface EnterpriseMlsPrivateMessageServiceOptions {
  randomId?: () => string;
  now?: () => Date;
}

export class EnterpriseMlsPrivateMessageService {
  private readonly randomId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly coordinator: EnterpriseMlsPrivateMessageCoordinator,
    private readonly history: EnterpriseMlsMessageHistory,
    options: EnterpriseMlsPrivateMessageServiceOptions = {},
  ) {
    this.randomId = options.randomId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async send(
    rawPeerAccountId: string,
    content: string,
    attachments: EnterpriseDirectMessageAttachmentUpload[] = [],
  ): Promise<EnterpriseMlsPrivateMessage> {
    const scope = this.coordinator.activeScope();
    const peerAccountId = this.requirePeer(scope, rawPeerAccountId);
    if (attachments.length > 0) {
      throw new Error(
        'MLS attachment transport is not active; refusing protocol downgrade',
      );
    }
    if (
      !content.trim() ||
      Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES
    ) {
      throw new Error('MLS private-message content is invalid');
    }
    const establishment =
      await this.coordinator.establishDirectSession(peerAccountId);
    this.requireReady(establishment);
    await this.coordinator.ensureApprovedDeviceMembership?.(peerAccountId);
    await this.coordinator.refreshEpoch(peerAccountId);
    const metadata = messageMetadata(content);
    const payload: EnterpriseMlsApplicationPayload = {
      format: 1,
      id: `mls-message-${this.randomId()}`,
      senderAccountId: scope.accountId,
      recipientAccountId: peerAccountId,
      content,
      contentType: metadata.contentType,
      inReplyToMessageId: metadata.inReplyToMessageId,
      createdAt: this.now().toISOString(),
    };
    const pending: StoredEnterpriseMlsPrivateMessage = {
      ...payload,
      readAt: payload.createdAt,
      attachments: [],
      e2ee: true,
      e2eeProtocol: PROTOCOL,
      deliveryState: 'pending',
    };
    await this.history.put(scope, peerAccountId, pending);
    await this.coordinator.sendApplication(
      peerAccountId,
      this.encodePayload(payload),
    );
    await this.history.markOutgoingDelivered(scope, peerAccountId, payload.id);
    return publicMessage({ ...pending, deliveryState: 'delivered' });
  }

  async list(rawPeerAccountId: string): Promise<EnterpriseMlsPrivateMessage[]> {
    const scope = this.coordinator.activeScope();
    const peerAccountId = this.requirePeer(scope, rawPeerAccountId);
    const establishment =
      await this.coordinator.establishDirectSession(peerAccountId);
    if (establishment.state === 'ready') {
      await this.flushPendingOutgoing(scope, peerAccountId);
    }
    await this.receivePeer(scope, peerAccountId);
    const messages = await this.history.list(scope, peerAccountId);
    await this.history.markRead(scope, peerAccountId);
    return messages.map(publicMessage);
  }

  async listUnread(): Promise<StoredEnterpriseMlsPrivateMessage[]> {
    const scope = this.coordinator.activeScope();
    const peers = await this.coordinator.listActiveConversationPeers();
    for (const peerAccountId of peers) {
      const establishment =
        await this.coordinator.establishDirectSession(peerAccountId);
      if (establishment.state === 'ready') {
        await this.flushPendingOutgoing(scope, peerAccountId);
      }
      await this.receivePeer(scope, peerAccountId);
    }
    return this.history.unread(scope);
  }

  async reset(rawPeerAccountId: string): Promise<void> {
    const scope = this.coordinator.activeScope();
    const peerAccountId = this.requirePeer(scope, rawPeerAccountId);
    const resetDirectSession = this.coordinator.resetDirectSession?.bind(
      this.coordinator,
    );
    if (!resetDirectSession) {
      throw new Error('MLS conversation reset is unavailable');
    }
    await resetDirectSession(peerAccountId);
  }

  private async receivePeer(
    scope: MlsDeviceScope,
    peerAccountId: string,
  ): Promise<void> {
    const result = await this.coordinator.poll(peerAccountId);
    for (const received of result.messages) {
      const payload = this.parsePayload(received.plaintext);
      const expectedParticipants = [scope.accountId, peerAccountId]
        .sort()
        .join('\n');
      const actualParticipants = [
        payload.senderAccountId,
        payload.recipientAccountId,
      ]
        .sort()
        .join('\n');
      if (
        actualParticipants !== expectedParticipants ||
        payload.senderAccountId !== received.senderAccountId ||
        payload.recipientAccountId !== scope.accountId
      ) {
        throw new Error('MLS private-message sender binding is invalid');
      }
      await this.history.put(scope, peerAccountId, {
        ...payload,
        readAt: null,
        attachments: [],
        e2ee: true,
        e2eeProtocol: PROTOCOL,
        deliveryState: 'delivered',
      });
      await this.coordinator.acknowledgeReceivedApplication(
        peerAccountId,
        received.eventId,
      );
    }
    if (result.messages.length > 0) {
      await this.coordinator.refreshEpoch(peerAccountId);
    }
  }

  private async flushPendingOutgoing(
    scope: MlsDeviceScope,
    peerAccountId: string,
  ): Promise<void> {
    await this.coordinator.ensureApprovedDeviceMembership?.(peerAccountId);
    const pending = await this.history.pendingOutgoing(scope, peerAccountId);
    for (const message of pending) {
      const payload: EnterpriseMlsApplicationPayload = {
        format: 1,
        id: message.id,
        senderAccountId: message.senderAccountId,
        recipientAccountId: message.recipientAccountId,
        content: message.content,
        contentType: message.contentType,
        inReplyToMessageId: message.inReplyToMessageId,
        createdAt: message.createdAt,
      };
      await this.coordinator.sendApplication(
        peerAccountId,
        this.encodePayload(payload),
      );
      await this.history.markOutgoingDelivered(
        scope,
        peerAccountId,
        message.id,
      );
    }
  }

  private encodePayload(payload: EnterpriseMlsApplicationPayload): Uint8Array {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
    if (encoded.byteLength > MAX_APPLICATION_BYTES) {
      encoded.fill(0);
      throw new Error('MLS private-message application is too large');
    }
    return encoded;
  }

  private parsePayload(plaintext: Uint8Array): EnterpriseMlsApplicationPayload {
    if (
      plaintext.byteLength === 0 ||
      plaintext.byteLength > MAX_APPLICATION_BYTES
    ) {
      throw new Error('MLS private-message application is invalid');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(plaintext).toString('utf8'));
    } catch {
      throw new Error('MLS private-message application is invalid');
    }
    const payload = parsed as Partial<EnterpriseMlsApplicationPayload>;
    if (
      payload?.format !== 1 ||
      typeof payload.id !== 'string' ||
      !MESSAGE_ID.test(payload.id) ||
      typeof payload.senderAccountId !== 'string' ||
      !IDENTIFIER.test(payload.senderAccountId) ||
      typeof payload.recipientAccountId !== 'string' ||
      !IDENTIFIER.test(payload.recipientAccountId) ||
      payload.senderAccountId === payload.recipientAccountId ||
      typeof payload.content !== 'string' ||
      Buffer.byteLength(payload.content, 'utf8') > MAX_CONTENT_BYTES ||
      !['message', 'atoa_request', 'atoa_response'].includes(
        payload.contentType ?? '',
      ) ||
      (payload.inReplyToMessageId !== null &&
        (typeof payload.inReplyToMessageId !== 'string' ||
          payload.inReplyToMessageId.length > 200)) ||
      typeof payload.createdAt !== 'string'
    ) {
      throw new Error('MLS private-message application is invalid');
    }
    requireIsoTime(payload.createdAt, 'MLS private-message timestamp');
    return payload as EnterpriseMlsApplicationPayload;
  }

  private requirePeer(scope: MlsDeviceScope, rawPeerAccountId: string): string {
    const peerAccountId = requireIdentifier(
      rawPeerAccountId,
      'peer account id',
    );
    if (peerAccountId === scope.accountId) {
      throw new Error('MLS private-message peer account is invalid');
    }
    return peerAccountId;
  }

  private requireReady(
    establishment: EnterpriseMlsSessionEstablishment,
  ): asserts establishment is { state: 'ready'; group: MlsGroupState } {
    if (establishment.state !== 'ready') {
      throw new Error(
        establishment.state === 'waiting-for-peer-key-package'
          ? 'MLS peer has no available KeyPackage'
          : 'MLS peer session is waiting for an authenticated handshake',
      );
    }
  }
}
