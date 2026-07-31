/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Private-chat cryptography lives in Electron main, outside the renderer and
 * outside the enterprise server. The server receives ciphertext, signatures
 * and per-device wrapped message keys only.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  scryptSync,
  sign,
  verify,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ENTERPRISE_E2EE_PROTOCOL_VERSION = 1 as const;

export interface EnterpriseE2eeDeviceBundle {
  accountId: string;
  deviceId: string;
  deviceName: string;
  identitySigningPublicKey: string;
  deviceExchangePublicKey: string;
  keyFingerprint: string;
  approvalState: 'pending' | 'approved';
  approvedByDeviceId: string | null;
  approvedAt: string | null;
  isCurrentDevice?: boolean;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface EnterpriseE2eeDeviceVerification {
  safetyNumber: string;
  qrPayload: string;
  deviceFingerprints: [string, string];
}

export interface EnterpriseE2eeDeviceApproval {
  approverDeviceId: string;
  targetDeviceId: string;
  targetKeyFingerprint: string;
  signature: string;
}

export interface EnterpriseE2eeEnvelope {
  accountId: string;
  deviceId: string;
  ephemeralPublicKey: string;
  wrappedKey: string;
  nonce: string;
}

export interface EnterpriseE2eeAttachmentCiphertext {
  id: string;
  ciphertext: string;
  nonce: string;
}

export interface EnterpriseE2eeWireMessage {
  id: string;
  senderAccountId: string;
  recipientAccountId: string;
  senderDeviceId: string;
  senderIdentitySigningPublicKey: string;
  protocolVersion: 1;
  contentType: 'message' | 'atoa_request' | 'atoa_response';
  inReplyToMessageId: string | null;
  ciphertext: string;
  nonce: string;
  signature: string;
  envelopes: EnterpriseE2eeEnvelope[];
  createdAt: string;
  readAt: string | null;
  attachments: Array<{ id: string; ciphertextSize: number; nonce: string }>;
}

export interface EnterpriseE2eeSendPayload {
  messageId: string;
  senderDeviceId: string;
  protocolVersion: 1;
  contentType: 'message' | 'atoa_request' | 'atoa_response';
  inReplyToMessageId: string | null;
  ciphertext: string;
  nonce: string;
  signature: string;
  envelopes: EnterpriseE2eeEnvelope[];
  attachments: EnterpriseE2eeAttachmentCiphertext[];
}

export interface EnterpriseE2eePlainAttachmentUpload {
  fileName: string;
  mimeType: string;
  size: number;
  data: string;
}

export interface EnterpriseE2eePlainMessage {
  id: string;
  senderAccountId: string;
  recipientAccountId: string;
  content: string;
  contentType: 'message' | 'atoa_request' | 'atoa_response';
  inReplyToMessageId: string | null;
  createdAt: string;
  readAt: string | null;
  attachments: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
  }>;
}

interface PlaintextPayload {
  v: 1;
  contentType: 'message' | 'atoa_request' | 'atoa_response';
  content: string;
  attachments: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
    nonce: string;
  }>;
}

interface DeviceKeySet {
  deviceId: string;
  deviceName: string;
  identitySigningPublicKey: string;
  identitySigningPrivateKey: string;
  deviceExchangePublicKey: string;
  deviceExchangePrivateKey: string;
  createdAt: string;
}

interface DeviceKeyring {
  v: 1;
  serverScope: string;
  accountId: string;
  active: DeviceKeySet;
  historical: DeviceKeySet[];
}

interface RecoveryPackage {
  v: 1;
  kdf: 'scrypt';
  cipher: 'aes-256-gcm';
  salt: string;
  nonce: string;
  ciphertext: string;
  createdAt: string;
}

export interface EnterpriseE2eeVaultOptions {
  directory: string;
  protect(plaintext: string): string;
  unprotect(protectedValue: string): string;
  deviceName?: () => string;
  now?: () => Date;
}

function publicPem(key: ReturnType<typeof createPublicKey>): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function privatePem(key: ReturnType<typeof createPrivateKey>): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export function enterpriseE2eeDeviceKeyFingerprint(
  device: Pick<
    EnterpriseE2eeDeviceBundle,
    'identitySigningPublicKey' | 'deviceExchangePublicKey'
  >,
): string {
  const signing = publicPem(createPublicKey(device.identitySigningPublicKey));
  const exchange = publicPem(createPublicKey(device.deviceExchangePublicKey));
  return createHash('sha256')
    .update('otto:e2ee-device-fingerprint:v1\n')
    .update(signing)
    .update('\n')
    .update(exchange)
    .digest('hex');
}

export function enterpriseE2eeDeviceVerification(
  first: EnterpriseE2eeDeviceBundle,
  second: EnterpriseE2eeDeviceBundle,
): EnterpriseE2eeDeviceVerification {
  const identities = [first, second]
    .map((device) => ({
      accountId: device.accountId,
      deviceId: device.deviceId,
      keyFingerprint:
        device.keyFingerprint || enterpriseE2eeDeviceKeyFingerprint(device),
    }))
    .sort((left, right) =>
      `${left.accountId}:${left.deviceId}`.localeCompare(
        `${right.accountId}:${right.deviceId}`,
      ),
    );
  const canonical = JSON.stringify({ v: 1, devices: identities });
  const digest = createHash('sha512')
    .update('otto:e2ee-safety-number:v1\n')
    .update(canonical)
    .digest();
  const groups = Array.from({ length: 12 }, (_, index) =>
    String(digest.readUInt32BE(index * 4) % 100_000).padStart(5, '0'),
  );
  return {
    safetyNumber: groups.join(' '),
    qrPayload: `otto-e2ee-verify:v1:${Buffer.from(canonical).toString('base64url')}`,
    deviceFingerprints: [
      identities[0]!.keyFingerprint,
      identities[1]!.keyFingerprint,
    ],
  };
}

export function enterpriseE2eeDeviceApprovalSignaturePayload(input: {
  organizationId: string;
  accountId: string;
  approverDeviceId: string;
  targetDeviceId: string;
  targetKeyFingerprint: string;
}): Buffer {
  return Buffer.from(
    `otto:e2ee-device-approval:v1\n${JSON.stringify(input)}`,
    'utf8',
  );
}

function newDeviceKeySet(deviceName: string, now: Date): DeviceKeySet {
  const identity = generateKeyPairSync('ed25519');
  const exchange = generateKeyPairSync('x25519');
  return {
    deviceId: randomUUID(),
    deviceName: deviceName.trim().slice(0, 120) || 'Otto device',
    identitySigningPublicKey: publicPem(identity.publicKey),
    identitySigningPrivateKey: privatePem(identity.privateKey),
    deviceExchangePublicKey: publicPem(exchange.publicKey),
    deviceExchangePrivateKey: privatePem(exchange.privateKey),
    createdAt: now.toISOString(),
  };
}

function validateKeySet(value: unknown): DeviceKeySet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('E2EE device key set is invalid');
  }
  const raw = value as Record<string, unknown>;
  for (const field of [
    'deviceId',
    'deviceName',
    'identitySigningPublicKey',
    'identitySigningPrivateKey',
    'deviceExchangePublicKey',
    'deviceExchangePrivateKey',
    'createdAt',
  ]) {
    if (typeof raw[field] !== 'string' || !raw[field]) {
      throw new Error('E2EE device key set is invalid');
    }
  }
  const result = raw as unknown as DeviceKeySet;
  const signingPrivate = createPrivateKey(result.identitySigningPrivateKey);
  const exchangePrivate = createPrivateKey(result.deviceExchangePrivateKey);
  if (
    signingPrivate.asymmetricKeyType !== 'ed25519' ||
    exchangePrivate.asymmetricKeyType !== 'x25519' ||
    publicPem(createPublicKey(signingPrivate)) !==
      result.identitySigningPublicKey ||
    publicPem(createPublicKey(exchangePrivate)) !==
      result.deviceExchangePublicKey
  ) {
    throw new Error('E2EE device key set does not match its public keys');
  }
  return result;
}

function validateKeyring(
  value: unknown,
  serverScope: string,
  accountId: string,
): DeviceKeyring {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('E2EE keyring is invalid');
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.v !== 1 ||
    raw.serverScope !== serverScope ||
    raw.accountId !== accountId ||
    !Array.isArray(raw.historical)
  ) {
    throw new Error('E2EE keyring belongs to another account or server');
  }
  const active = validateKeySet(raw.active);
  const historical = raw.historical.map(validateKeySet);
  const ids = [active, ...historical].map((item) => item.deviceId);
  if (new Set(ids).size !== ids.length)
    throw new Error('E2EE keyring contains duplicate devices');
  return { v: 1, serverScope, accountId, active, historical };
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporaryPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* Windows ACLs are authoritative. */
    }
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      /* already renamed */
    }
  }
}

export class EnterpriseE2eeKeyVault {
  private readonly now: () => Date;
  private readonly deviceName: () => string;

  constructor(private readonly options: EnterpriseE2eeVaultOptions) {
    this.now = options.now ?? (() => new Date());
    this.deviceName = options.deviceName ?? (() => 'Otto desktop');
  }

  private keyringPath(serverScope: string, accountId: string): string {
    const digest = createHash('sha256')
      .update(`${serverScope}\0${accountId}`)
      .digest('hex');
    return path.join(this.options.directory, `${digest}.keyring`);
  }

  loadOrCreate(serverScope: string, accountId: string): DeviceKeyring {
    const filePath = this.keyringPath(serverScope, accountId);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('E2EE keyring path must be a regular file');
      }
      const protectedValue = fs.readFileSync(filePath, 'utf8');
      const plaintext = this.options.unprotect(protectedValue);
      return validateKeyring(JSON.parse(plaintext), serverScope, accountId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const created: DeviceKeyring = {
      v: 1,
      serverScope,
      accountId,
      active: newDeviceKeySet(this.deviceName(), this.now()),
      historical: [],
    };
    this.save(created);
    return created;
  }

  private save(keyring: DeviceKeyring): void {
    const plaintext = JSON.stringify(keyring);
    atomicWrite(
      this.keyringPath(keyring.serverScope, keyring.accountId),
      this.options.protect(plaintext),
    );
  }

  rotateDevice(serverScope: string, accountId: string): DeviceKeyring {
    const current = this.loadOrCreate(serverScope, accountId);
    const rotated: DeviceKeyring = {
      ...current,
      active: newDeviceKeySet(this.deviceName(), this.now()),
      historical: [current.active, ...current.historical],
    };
    this.save(rotated);
    return rotated;
  }

  exportRecoveryBundle(
    serverScope: string,
    accountId: string,
    passphrase: string,
  ): string {
    if (passphrase.length < 12)
      throw new Error(
        'E2EE recovery passphrase must contain at least 12 characters',
      );
    const keyring = this.loadOrCreate(serverScope, accountId);
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from('otto-e2ee-recovery-v1', 'utf8'));
    const body = Buffer.from(JSON.stringify(keyring), 'utf8');
    const ciphertext = Buffer.concat([
      cipher.update(body),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const recovery: RecoveryPackage = {
      v: 1,
      kdf: 'scrypt',
      cipher: 'aes-256-gcm',
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      createdAt: this.now().toISOString(),
    };
    return JSON.stringify(recovery);
  }

  importRecoveryBundle(
    serverScope: string,
    accountId: string,
    serialized: string,
    passphrase: string,
  ): DeviceKeyring {
    let recovery: RecoveryPackage;
    try {
      recovery = JSON.parse(serialized) as RecoveryPackage;
    } catch {
      throw new Error('E2EE recovery bundle is invalid');
    }
    if (
      recovery.v !== 1 ||
      recovery.kdf !== 'scrypt' ||
      recovery.cipher !== 'aes-256-gcm'
    ) {
      throw new Error('E2EE recovery bundle version is unsupported');
    }
    try {
      const salt = Buffer.from(recovery.salt, 'base64');
      const nonce = Buffer.from(recovery.nonce, 'base64');
      const sealed = Buffer.from(recovery.ciphertext, 'base64');
      if (salt.length !== 16 || nonce.length !== 12 || sealed.length <= 16)
        throw new Error('invalid');
      const key = scryptSync(passphrase, salt, 32, {
        N: 1 << 15,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      });
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from('otto-e2ee-recovery-v1', 'utf8'));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plaintext = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - 16)),
        decipher.final(),
      ]).toString('utf8');
      const recovered = validateKeyring(
        JSON.parse(plaintext),
        serverScope,
        accountId,
      );
      const local = this.loadOrCreate(serverScope, accountId);
      const historicalById = new Map(
        [recovered.active, ...recovered.historical, ...local.historical]
          .filter((item) => item.deviceId !== local.active.deviceId)
          .map((item) => [item.deviceId, item]),
      );
      const merged: DeviceKeyring = {
        ...local,
        historical: [...historicalById.values()],
      };
      this.save(merged);
      return merged;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('E2EE keyring'))
        throw error;
      throw new Error('E2EE recovery bundle or passphrase is invalid');
    }
  }
}

function aesEncrypt(
  key: Buffer,
  plaintext: Buffer,
  nonce: Buffer,
  aad: string,
): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

function aesDecrypt(
  key: Buffer,
  sealed: Buffer,
  nonce: Buffer,
  aad: string,
): Buffer {
  if (sealed.length <= 16) throw new Error('E2EE ciphertext is truncated');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);
}

function messageAad(
  organizationId: string,
  messageId: string,
  senderAccountId: string,
  recipientAccountId: string,
): string {
  return `otto:e2ee:message:v1:${organizationId}:${messageId}:${senderAccountId}:${recipientAccountId}`;
}

function envelopeAad(
  messageId: string,
  accountId: string,
  deviceId: string,
): string {
  return `otto:e2ee:envelope:v1:${messageId}:${accountId}:${deviceId}`;
}

function attachmentAad(messageId: string, attachmentId: string): string {
  return `otto:e2ee:attachment:v1:${messageId}:${attachmentId}`;
}

function deriveEnvelopeKey(
  privateKeyPem: string,
  publicKeyPem: string,
  messageId: string,
  accountId: string,
  deviceId: string,
): Buffer {
  const secret = diffieHellman({
    privateKey: createPrivateKey(privateKeyPem),
    publicKey: createPublicKey(publicKeyPem),
  });
  return Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      Buffer.from(messageId, 'utf8'),
      Buffer.from(`otto-e2ee-envelope-key-v1:${accountId}:${deviceId}`, 'utf8'),
      32,
    ),
  );
}

function envelopeDigest(envelopes: readonly EnterpriseE2eeEnvelope[]): string {
  const canonical = [...envelopes]
    .sort((a, b) =>
      `${a.accountId}:${a.deviceId}`.localeCompare(
        `${b.accountId}:${b.deviceId}`,
      ),
    )
    .map((envelope) => ({
      accountId: envelope.accountId,
      deviceId: envelope.deviceId,
      ephemeralPublicKey: envelope.ephemeralPublicKey,
      wrappedKey: envelope.wrappedKey,
      nonce: envelope.nonce,
    }));
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('base64');
}

function signaturePayload(input: {
  organizationId: string;
  messageId: string;
  senderAccountId: string;
  recipientAccountId: string;
  senderDeviceId: string;
  protocolVersion: 1;
  contentType: 'message' | 'atoa_request' | 'atoa_response';
  inReplyToMessageId: string | null;
  ciphertext: string;
  nonce: string;
  envelopes: EnterpriseE2eeEnvelope[];
  attachments: EnterpriseE2eeAttachmentCiphertext[];
}): Buffer {
  const body = {
    protocolVersion: input.protocolVersion,
    organizationId: input.organizationId,
    messageId: input.messageId,
    senderAccountId: input.senderAccountId,
    recipientAccountId: input.recipientAccountId,
    senderDeviceId: input.senderDeviceId,
    contentType: input.contentType,
    inReplyToMessageId: input.inReplyToMessageId,
    nonce: input.nonce,
    ciphertextHash: createHash('sha256')
      .update(Buffer.from(input.ciphertext, 'base64'))
      .digest('base64'),
    envelopeDigest: envelopeDigest(input.envelopes),
  };
  return Buffer.from(`otto-e2ee-message-v1\n${JSON.stringify(body)}`, 'utf8');
}

function parsePlaintextPayload(value: Buffer): PlaintextPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString('utf8'));
  } catch {
    throw new Error('decrypted E2EE payload is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('decrypted E2EE payload is invalid');
  }
  const payload = parsed as PlaintextPayload;
  if (
    payload.v !== 1 ||
    !['message', 'atoa_request', 'atoa_response'].includes(
      payload.contentType,
    ) ||
    typeof payload.content !== 'string' ||
    payload.content.length > 4000 ||
    !Array.isArray(payload.attachments) ||
    payload.attachments.length > 6
  ) {
    throw new Error('decrypted E2EE payload is invalid');
  }
  return payload;
}

export class EnterpriseE2eeCrypto {
  constructor(private readonly vault: EnterpriseE2eeKeyVault) {}

  localDevice(
    serverScope: string,
    accountId: string,
  ): EnterpriseE2eeDeviceBundle {
    const active = this.vault.loadOrCreate(serverScope, accountId).active;
    const device = {
      accountId,
      deviceId: active.deviceId,
      deviceName: active.deviceName,
      identitySigningPublicKey: active.identitySigningPublicKey,
      deviceExchangePublicKey: active.deviceExchangePublicKey,
      approvalState: 'approved' as const,
      approvedByDeviceId: null,
      approvedAt: active.createdAt,
      createdAt: active.createdAt,
      lastSeenAt: active.createdAt,
      revokedAt: null,
    };
    return {
      ...device,
      keyFingerprint: enterpriseE2eeDeviceKeyFingerprint(device),
    };
  }

  signDeviceApproval(input: {
    serverScope: string;
    organizationId: string;
    accountId: string;
    targetDevice: EnterpriseE2eeDeviceBundle;
  }): EnterpriseE2eeDeviceApproval {
    if (input.targetDevice.accountId !== input.accountId) {
      throw new Error(
        'only a device belonging to the current account can be approved',
      );
    }
    const active = this.vault.loadOrCreate(
      input.serverScope,
      input.accountId,
    ).active;
    if (active.deviceId === input.targetDevice.deviceId) {
      throw new Error('a device cannot approve itself');
    }
    const approval = {
      organizationId: input.organizationId,
      accountId: input.accountId,
      approverDeviceId: active.deviceId,
      targetDeviceId: input.targetDevice.deviceId,
      targetKeyFingerprint:
        input.targetDevice.keyFingerprint ||
        enterpriseE2eeDeviceKeyFingerprint(input.targetDevice),
    };
    return {
      approverDeviceId: approval.approverDeviceId,
      targetDeviceId: approval.targetDeviceId,
      targetKeyFingerprint: approval.targetKeyFingerprint,
      signature: sign(
        null,
        enterpriseE2eeDeviceApprovalSignaturePayload(approval),
        active.identitySigningPrivateKey,
      ).toString('base64'),
    };
  }

  rotateLocalDevice(
    serverScope: string,
    accountId: string,
  ): EnterpriseE2eeDeviceBundle {
    this.vault.rotateDevice(serverScope, accountId);
    return this.localDevice(serverScope, accountId);
  }

  encryptMessage(input: {
    serverScope: string;
    organizationId: string;
    senderAccountId: string;
    recipientAccountId: string;
    content: string;
    contentType: 'message' | 'atoa_request' | 'atoa_response';
    inReplyToMessageId?: string | null;
    devices: EnterpriseE2eeDeviceBundle[];
    attachments?: EnterpriseE2eePlainAttachmentUpload[];
    messageId?: string;
  }): EnterpriseE2eeSendPayload {
    const keyring = this.vault.loadOrCreate(
      input.serverScope,
      input.senderAccountId,
    );
    const activeDevices = input.devices.filter(
      (device) => device.revokedAt === null,
    );
    const participantIds = new Set([
      input.senderAccountId,
      input.recipientAccountId,
    ]);
    const envelopeDevices = activeDevices.filter((device) =>
      participantIds.has(device.accountId),
    );
    if (
      !envelopeDevices.some(
        (device) => device.accountId === input.senderAccountId,
      )
    ) {
      throw new Error('current account has no active E2EE device');
    }
    if (
      !envelopeDevices.some(
        (device) => device.accountId === input.recipientAccountId,
      )
    ) {
      throw new Error('recipient has no active E2EE device');
    }
    const uniqueDevices = new Set(
      envelopeDevices.map((device) => `${device.accountId}:${device.deviceId}`),
    );
    if (uniqueDevices.size !== envelopeDevices.length)
      throw new Error('E2EE device directory contains duplicates');
    const messageId = input.messageId ?? randomUUID();
    const messageKey = randomBytes(32);
    const attachments = (input.attachments ?? []).map((attachment) => {
      const attachmentId = randomUUID();
      const nonce = randomBytes(12);
      const plaintext = Buffer.from(attachment.data, 'base64');
      if (
        !plaintext.length ||
        plaintext.length !== attachment.size ||
        plaintext.toString('base64') !== attachment.data
      ) {
        throw new Error('E2EE attachment content is invalid');
      }
      return {
        metadata: {
          id: attachmentId,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          size: plaintext.length,
          nonce: nonce.toString('base64'),
        },
        ciphertext: {
          id: attachmentId,
          ciphertext: aesEncrypt(
            messageKey,
            plaintext,
            nonce,
            attachmentAad(messageId, attachmentId),
          ).toString('base64'),
          nonce: nonce.toString('base64'),
        },
      };
    });
    const plaintext: PlaintextPayload = {
      v: 1,
      contentType: input.contentType,
      content: input.content,
      attachments: attachments.map((item) => item.metadata),
    };
    const nonce = randomBytes(12);
    const ciphertext = aesEncrypt(
      messageKey,
      Buffer.from(JSON.stringify(plaintext), 'utf8'),
      nonce,
      messageAad(
        input.organizationId,
        messageId,
        input.senderAccountId,
        input.recipientAccountId,
      ),
    ).toString('base64');
    const ephemeral = generateKeyPairSync('x25519');
    const ephemeralPrivate = privatePem(ephemeral.privateKey);
    const ephemeralPublic = publicPem(ephemeral.publicKey);
    const envelopes = envelopeDevices.map((device) => {
      const envelopeNonce = randomBytes(12);
      const envelopeKey = deriveEnvelopeKey(
        ephemeralPrivate,
        device.deviceExchangePublicKey,
        messageId,
        device.accountId,
        device.deviceId,
      );
      return {
        accountId: device.accountId,
        deviceId: device.deviceId,
        ephemeralPublicKey: ephemeralPublic,
        wrappedKey: aesEncrypt(
          envelopeKey,
          messageKey,
          envelopeNonce,
          envelopeAad(messageId, device.accountId, device.deviceId),
        ).toString('base64'),
        nonce: envelopeNonce.toString('base64'),
      };
    });
    const unsigned = {
      organizationId: input.organizationId,
      messageId,
      senderAccountId: input.senderAccountId,
      recipientAccountId: input.recipientAccountId,
      senderDeviceId: keyring.active.deviceId,
      protocolVersion: ENTERPRISE_E2EE_PROTOCOL_VERSION,
      contentType: input.contentType,
      inReplyToMessageId: input.inReplyToMessageId ?? null,
      ciphertext,
      nonce: nonce.toString('base64'),
      envelopes,
      attachments: attachments.map((item) => item.ciphertext),
    };
    return {
      messageId,
      senderDeviceId: keyring.active.deviceId,
      protocolVersion: ENTERPRISE_E2EE_PROTOCOL_VERSION,
      contentType: input.contentType,
      inReplyToMessageId: input.inReplyToMessageId ?? null,
      ciphertext,
      nonce: nonce.toString('base64'),
      envelopes,
      attachments: attachments.map((item) => item.ciphertext),
      signature: sign(
        null,
        signaturePayload(unsigned),
        keyring.active.identitySigningPrivateKey,
      ).toString('base64'),
    };
  }

  private messageKey(input: {
    serverScope: string;
    accountId: string;
    message: EnterpriseE2eeWireMessage;
  }): Buffer {
    const keyring = this.vault.loadOrCreate(input.serverScope, input.accountId);
    for (const keySet of [keyring.active, ...keyring.historical]) {
      const envelope = input.message.envelopes.find(
        (candidate) =>
          candidate.accountId === input.accountId &&
          candidate.deviceId === keySet.deviceId,
      );
      if (!envelope) continue;
      const envelopeKey = deriveEnvelopeKey(
        keySet.deviceExchangePrivateKey,
        envelope.ephemeralPublicKey,
        input.message.id,
        input.accountId,
        keySet.deviceId,
      );
      try {
        return aesDecrypt(
          envelopeKey,
          Buffer.from(envelope.wrappedKey, 'base64'),
          Buffer.from(envelope.nonce, 'base64'),
          envelopeAad(input.message.id, input.accountId, keySet.deviceId),
        );
      } catch {
        throw new Error('E2EE message key envelope is invalid');
      }
    }
    throw new Error('this device has no key envelope for the E2EE message');
  }

  decryptMessage(input: {
    serverScope: string;
    organizationId: string;
    accountId: string;
    message: EnterpriseE2eeWireMessage;
  }): EnterpriseE2eePlainMessage {
    const message = input.message;
    if (message.protocolVersion !== ENTERPRISE_E2EE_PROTOCOL_VERSION) {
      throw new Error('E2EE message protocol version is unsupported');
    }
    const signatureInput = {
      organizationId: input.organizationId,
      messageId: message.id,
      senderAccountId: message.senderAccountId,
      recipientAccountId: message.recipientAccountId,
      senderDeviceId: message.senderDeviceId,
      protocolVersion: message.protocolVersion,
      contentType: message.contentType,
      inReplyToMessageId: message.inReplyToMessageId,
      ciphertext: message.ciphertext,
      nonce: message.nonce,
      envelopes: message.envelopes,
      attachments: message.attachments.map((attachment) => ({
        id: attachment.id,
        nonce: attachment.nonce,
        // The server list intentionally omits attachment bodies. The signed
        // digest is verified when the attachment is downloaded.
        ciphertext: '',
      })),
    };
    if (
      !verify(
        null,
        signaturePayload(signatureInput),
        message.senderIdentitySigningPublicKey,
        Buffer.from(message.signature, 'base64'),
      )
    ) {
      throw new Error('E2EE message signature is invalid');
    }
    const key = this.messageKey({
      serverScope: input.serverScope,
      accountId: input.accountId,
      message,
    });
    let payload: PlaintextPayload;
    try {
      payload = parsePlaintextPayload(
        aesDecrypt(
          key,
          Buffer.from(message.ciphertext, 'base64'),
          Buffer.from(message.nonce, 'base64'),
          messageAad(
            input.organizationId,
            message.id,
            message.senderAccountId,
            message.recipientAccountId,
          ),
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('decrypted E2EE'))
        throw error;
      throw new Error('E2EE message authentication failed');
    }
    if (payload.contentType !== message.contentType) {
      throw new Error(
        'E2EE content type metadata does not match the encrypted body',
      );
    }
    const wireAttachmentIds = message.attachments.map((item) => item.id).sort();
    const bodyAttachmentIds = payload.attachments.map((item) => item.id).sort();
    if (
      JSON.stringify(wireAttachmentIds) !== JSON.stringify(bodyAttachmentIds)
    ) {
      throw new Error(
        'E2EE attachment metadata does not match the encrypted body',
      );
    }
    return {
      id: message.id,
      senderAccountId: message.senderAccountId,
      recipientAccountId: message.recipientAccountId,
      content: payload.content,
      contentType: payload.contentType,
      inReplyToMessageId: message.inReplyToMessageId,
      createdAt: message.createdAt,
      readAt: message.readAt,
      attachments: payload.attachments.map(
        ({ nonce: _nonce, ...attachment }) => attachment,
      ),
    };
  }

  decryptAttachment(input: {
    serverScope: string;
    organizationId: string;
    accountId: string;
    message: EnterpriseE2eeWireMessage;
    attachment: EnterpriseE2eeAttachmentCiphertext;
  }): {
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
    data: string;
  } {
    const key = this.messageKey({
      serverScope: input.serverScope,
      accountId: input.accountId,
      message: input.message,
    });
    const payload = parsePlaintextPayload(
      aesDecrypt(
        key,
        Buffer.from(input.message.ciphertext, 'base64'),
        Buffer.from(input.message.nonce, 'base64'),
        messageAad(
          input.organizationId,
          input.message.id,
          input.message.senderAccountId,
          input.message.recipientAccountId,
        ),
      ),
    );
    const metadata = payload.attachments.find(
      (item) => item.id === input.attachment.id,
    );
    if (!metadata || metadata.nonce !== input.attachment.nonce) {
      throw new Error('E2EE attachment metadata is invalid');
    }
    const signatureInput = {
      organizationId: input.organizationId,
      messageId: input.message.id,
      senderAccountId: input.message.senderAccountId,
      recipientAccountId: input.message.recipientAccountId,
      senderDeviceId: input.message.senderDeviceId,
      protocolVersion: input.message.protocolVersion,
      contentType: input.message.contentType,
      inReplyToMessageId: input.message.inReplyToMessageId,
      ciphertext: input.message.ciphertext,
      nonce: input.message.nonce,
      envelopes: input.message.envelopes,
      attachments: [input.attachment],
    };
    if (
      !verify(
        null,
        signaturePayload(signatureInput),
        input.message.senderIdentitySigningPublicKey,
        Buffer.from(input.message.signature, 'base64'),
      )
    ) {
      throw new Error('E2EE message signature is invalid');
    }
    let plaintext: Buffer;
    try {
      plaintext = aesDecrypt(
        key,
        Buffer.from(input.attachment.ciphertext, 'base64'),
        Buffer.from(input.attachment.nonce, 'base64'),
        attachmentAad(input.message.id, input.attachment.id),
      );
    } catch {
      throw new Error('E2EE attachment authentication failed');
    }
    if (plaintext.length !== metadata.size)
      throw new Error('E2EE attachment size mismatch');
    return {
      id: metadata.id,
      fileName: metadata.fileName,
      mimeType: metadata.mimeType,
      size: metadata.size,
      data: plaintext.toString('base64'),
    };
  }
}
