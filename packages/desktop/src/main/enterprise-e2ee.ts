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
export const ENTERPRISE_FEDERATION_E2EE_SCOPE = 'otto:federation-e2ee:v1';

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

export interface EnterpriseFederationIdentityCard {
  v: 1;
  deploymentId: string;
  principalId: string;
  displayName: string;
  device: EnterpriseE2eeDeviceBundle;
  issuedAt: string;
  signature: string;
}

export interface EnterpriseFederationContactTrust {
  card: EnterpriseFederationIdentityCard;
  verifiedAt: string | null;
  pinnedAt: string;
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

export type EnterpriseE2eeKeyTransparencyEvent =
  | 'bootstrap_approved'
  | 'registered_pending'
  | 'approved'
  | 'revoked';

export interface EnterpriseE2eeKeyTransparencyEntry {
  sequence: number;
  accountId: string;
  deviceId: string;
  event: EnterpriseE2eeKeyTransparencyEvent;
  keyFingerprint: string;
  actorDeviceId: string | null;
  previousHash: string;
  entryHash: string;
  createdAt: string;
}

export interface EnterpriseE2eeKeyTransparencyView {
  accountId: string;
  headSequence: number;
  headHash: string;
  entries: EnterpriseE2eeKeyTransparencyEntry[];
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

interface TransparencyCheckpoint {
  v: 1;
  serverScope: string;
  organizationId: string;
  accountId: string;
  headSequence: number;
  headHash: string;
  updatedAt: string;
}

interface FederationContactTrustFile extends EnterpriseFederationContactTrust {
  v: 1;
  localServerScope: string;
  localAccountId: string;
  contactId: string;
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

const EMPTY_TRANSPARENCY_HASH = '0'.repeat(64);
const TRANSPARENCY_HASH = /^[0-9a-f]{64}$/;
const TRANSPARENCY_EVENTS = new Set<EnterpriseE2eeKeyTransparencyEvent>([
  'bootstrap_approved',
  'registered_pending',
  'approved',
  'revoked',
]);

function validateTransparencyView(
  organizationId: string,
  view: EnterpriseE2eeKeyTransparencyView,
): EnterpriseE2eeKeyTransparencyView {
  if (
    !view ||
    typeof view !== 'object' ||
    typeof view.accountId !== 'string' ||
    !view.accountId ||
    !Number.isSafeInteger(view.headSequence) ||
    view.headSequence < 0 ||
    !TRANSPARENCY_HASH.test(view.headHash) ||
    !Array.isArray(view.entries) ||
    view.entries.length !== view.headSequence
  ) {
    throw new Error('E2EE key transparency log integrity check failed');
  }
  let previousHash = EMPTY_TRANSPARENCY_HASH;
  for (const [index, entry] of view.entries.entries()) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      entry.sequence !== index + 1 ||
      entry.accountId !== view.accountId ||
      typeof entry.deviceId !== 'string' ||
      !entry.deviceId ||
      !TRANSPARENCY_EVENTS.has(entry.event) ||
      !TRANSPARENCY_HASH.test(entry.keyFingerprint) ||
      (entry.actorDeviceId !== null &&
        (typeof entry.actorDeviceId !== 'string' || !entry.actorDeviceId)) ||
      entry.previousHash !== previousHash ||
      !TRANSPARENCY_HASH.test(entry.entryHash) ||
      typeof entry.createdAt !== 'string' ||
      !entry.createdAt
    ) {
      throw new Error('E2EE key transparency log integrity check failed');
    }
    const expectedHash = createHash('sha256')
      .update('otto:e2ee-key-transparency:v1\n')
      .update(
        JSON.stringify({
          sequence: entry.sequence,
          organizationId,
          accountId: entry.accountId,
          deviceId: entry.deviceId,
          event: entry.event,
          keyFingerprint: entry.keyFingerprint,
          actorDeviceId: entry.actorDeviceId,
          previousHash: entry.previousHash,
          createdAt: entry.createdAt,
        }),
      )
      .digest('hex');
    if (entry.entryHash !== expectedHash) {
      throw new Error('E2EE key transparency log integrity check failed');
    }
    previousHash = entry.entryHash;
  }
  if (view.headHash !== previousHash) {
    throw new Error('E2EE key transparency log integrity check failed');
  }
  return view;
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

  private transparencyCheckpointPath(
    serverScope: string,
    organizationId: string,
    accountId: string,
  ): string {
    const digest = createHash('sha256')
      .update(`${serverScope}\0${organizationId}\0${accountId}`)
      .digest('hex');
    return path.join(this.options.directory, `${digest}.transparency`);
  }

  private federationContactPath(
    localServerScope: string,
    localAccountId: string,
    contactId: string,
  ): string {
    const digest = createHash('sha256')
      .update(`federation-contact\0${localServerScope}\0${localAccountId}\0${contactId}`)
      .digest('hex');
    return path.join(this.options.directory, `${digest}.federation-contact`);
  }

  loadFederationContactTrust(input: {
    localServerScope: string;
    localAccountId: string;
    contactId: string;
  }): EnterpriseFederationContactTrust | null {
    const filePath = this.federationContactPath(
      input.localServerScope,
      input.localAccountId,
      input.contactId,
    );
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('federation contact trust path must be a regular file');
      }
      const parsed = JSON.parse(
        this.options.unprotect(fs.readFileSync(filePath, 'utf8')),
      ) as FederationContactTrustFile;
      if (
        parsed.v !== 1 ||
        parsed.localServerScope !== input.localServerScope ||
        parsed.localAccountId !== input.localAccountId ||
        parsed.contactId !== input.contactId ||
        typeof parsed.pinnedAt !== 'string' ||
        (parsed.verifiedAt !== null && typeof parsed.verifiedAt !== 'string')
      ) {
        throw new Error('federation contact trust file is invalid');
      }
      return {
        card: parsed.card,
        verifiedAt: parsed.verifiedAt,
        pinnedAt: parsed.pinnedAt,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  saveFederationContactTrust(input: {
    localServerScope: string;
    localAccountId: string;
    contactId: string;
    card: EnterpriseFederationIdentityCard;
    allowDeviceKeyChange?: boolean;
  }): EnterpriseFederationContactTrust {
    const current = this.loadFederationContactTrust(input);
    if (
      current &&
      current.card.device.keyFingerprint !== input.card.device.keyFingerprint &&
      !input.allowDeviceKeyChange
    ) {
      throw new Error(
        'federation contact device key changed; verify the new safety number before accepting it',
      );
    }
    const now = this.now().toISOString();
    const next: FederationContactTrustFile = {
      v: 1,
      localServerScope: input.localServerScope,
      localAccountId: input.localAccountId,
      contactId: input.contactId,
      card: input.card,
      pinnedAt: current?.pinnedAt ?? now,
      verifiedAt: current?.card.device.keyFingerprint === input.card.device.keyFingerprint
        ? current.verifiedAt
        : null,
    };
    atomicWrite(
      this.federationContactPath(
        input.localServerScope,
        input.localAccountId,
        input.contactId,
      ),
      this.options.protect(JSON.stringify(next)),
    );
    return {
      card: next.card,
      verifiedAt: next.verifiedAt,
      pinnedAt: next.pinnedAt,
    };
  }

  verifyFederationContact(input: {
    localServerScope: string;
    localAccountId: string;
    contactId: string;
  }): EnterpriseFederationContactTrust {
    const current = this.loadFederationContactTrust(input);
    if (!current) throw new Error('federation contact trust was not found');
    const verifiedAt = this.now().toISOString();
    const next: FederationContactTrustFile = {
      v: 1,
      ...input,
      card: current.card,
      pinnedAt: current.pinnedAt,
      verifiedAt,
    };
    atomicWrite(
      this.federationContactPath(
        input.localServerScope,
        input.localAccountId,
        input.contactId,
      ),
      this.options.protect(JSON.stringify(next)),
    );
    return { card: next.card, pinnedAt: next.pinnedAt, verifiedAt };
  }

  removeFederationContact(input: {
    localServerScope: string;
    localAccountId: string;
    contactId: string;
  }): void {
    const filePath = this.federationContactPath(
      input.localServerScope,
      input.localAccountId,
      input.contactId,
    );
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('federation contact trust path must be a regular file');
      }
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  verifyAndPinTransparencyCheckpoint(input: {
    serverScope: string;
    organizationId: string;
    view: EnterpriseE2eeKeyTransparencyView;
  }): EnterpriseE2eeKeyTransparencyView {
    const view = validateTransparencyView(input.organizationId, input.view);
    const checkpointPath = this.transparencyCheckpointPath(
      input.serverScope,
      input.organizationId,
      view.accountId,
    );
    let checkpoint: TransparencyCheckpoint | null = null;
    try {
      const stat = fs.lstatSync(checkpointPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(
          'E2EE key transparency checkpoint path must be a regular file',
        );
      }
      const parsed = JSON.parse(
        this.options.unprotect(fs.readFileSync(checkpointPath, 'utf8')),
      ) as Partial<TransparencyCheckpoint>;
      if (
        parsed.v !== 1 ||
        parsed.serverScope !== input.serverScope ||
        parsed.organizationId !== input.organizationId ||
        parsed.accountId !== view.accountId ||
        !Number.isSafeInteger(parsed.headSequence) ||
        (parsed.headSequence ?? -1) < 0 ||
        typeof parsed.headHash !== 'string' ||
        !TRANSPARENCY_HASH.test(parsed.headHash) ||
        typeof parsed.updatedAt !== 'string' ||
        !parsed.updatedAt
      ) {
        throw new Error('E2EE key transparency checkpoint is invalid');
      }
      checkpoint = parsed as TransparencyCheckpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (checkpoint) {
      if (view.headSequence < checkpoint.headSequence) {
        throw new Error('E2EE key transparency rollback detected');
      }
      const pinnedEntry =
        checkpoint.headSequence === 0
          ? null
          : view.entries[checkpoint.headSequence - 1];
      if (
        (checkpoint.headSequence === 0 &&
          checkpoint.headHash !== EMPTY_TRANSPARENCY_HASH) ||
        (checkpoint.headSequence > 0 &&
          pinnedEntry?.entryHash !== checkpoint.headHash)
      ) {
        throw new Error('E2EE key transparency fork detected');
      }
    }

    if (
      !checkpoint ||
      checkpoint.headSequence !== view.headSequence ||
      checkpoint.headHash !== view.headHash
    ) {
      const next: TransparencyCheckpoint = {
        v: 1,
        serverScope: input.serverScope,
        organizationId: input.organizationId,
        accountId: view.accountId,
        headSequence: view.headSequence,
        headHash: view.headHash,
        updatedAt: this.now().toISOString(),
      };
      atomicWrite(
        checkpointPath,
        this.options.protect(JSON.stringify(next)),
      );
    }
    return view;
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

function federationIdentityCardPayload(
  card: Omit<EnterpriseFederationIdentityCard, 'signature'>,
): Buffer {
  return Buffer.from(JSON.stringify({
    v: card.v,
    deploymentId: card.deploymentId,
    principalId: card.principalId,
    displayName: card.displayName,
    device: card.device,
    issuedAt: card.issuedAt,
  }), 'utf8');
}

function validateFederationIdentityCard(
  value: EnterpriseFederationIdentityCard,
): EnterpriseFederationIdentityCard {
  const identity = `${value.deploymentId}:${value.principalId}`;
  if (
    value.v !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value.deploymentId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value.principalId) ||
    typeof value.displayName !== 'string' ||
    !value.displayName.trim() ||
    value.displayName.length > 120 ||
    !value.device ||
    value.device.accountId !== identity ||
    value.device.approvalState !== 'approved' ||
    value.device.revokedAt !== null ||
    enterpriseE2eeDeviceKeyFingerprint(value.device) !== value.device.keyFingerprint ||
    !Number.isFinite(Date.parse(value.issuedAt)) ||
    typeof value.signature !== 'string' ||
    !value.signature
  ) {
    throw new Error('federation identity card is invalid');
  }
  const unsigned = { ...value };
  delete (unsigned as Partial<EnterpriseFederationIdentityCard>).signature;
  if (!verify(
    null,
    federationIdentityCardPayload(
      unsigned as Omit<EnterpriseFederationIdentityCard, 'signature'>,
    ),
    value.device.identitySigningPublicKey,
    Buffer.from(value.signature, 'base64'),
  )) {
    throw new Error('federation identity card signature is invalid');
  }
  return value;
}

export class EnterpriseE2eeCrypto {
  constructor(private readonly vault: EnterpriseE2eeKeyVault) {}

  verifyAndPinKeyTransparency(input: {
    serverScope: string;
    organizationId: string;
    view: EnterpriseE2eeKeyTransparencyView;
  }): EnterpriseE2eeKeyTransparencyView {
    return this.vault.verifyAndPinTransparencyCheckpoint(input);
  }

  createFederationIdentityCard(input: {
    deploymentId: string;
    principalId: string;
    displayName: string;
    issuedAt?: string;
  }): EnterpriseFederationIdentityCard {
    const accountId = `${input.deploymentId}:${input.principalId}`;
    const keyring = this.vault.loadOrCreate(
      ENTERPRISE_FEDERATION_E2EE_SCOPE,
      accountId,
    );
    const device = this.localDevice(
      ENTERPRISE_FEDERATION_E2EE_SCOPE,
      accountId,
    );
    const unsigned: Omit<EnterpriseFederationIdentityCard, 'signature'> = {
      v: 1,
      deploymentId: input.deploymentId,
      principalId: input.principalId,
      displayName: input.displayName.trim(),
      device,
      issuedAt: input.issuedAt ?? new Date().toISOString(),
    };
    const card: EnterpriseFederationIdentityCard = {
      ...unsigned,
      signature: sign(
        null,
        federationIdentityCardPayload(unsigned),
        keyring.active.identitySigningPrivateKey,
      ).toString('base64'),
    };
    return validateFederationIdentityCard(card);
  }

  verifyFederationIdentityCard(
    value: EnterpriseFederationIdentityCard,
  ): EnterpriseFederationIdentityCard {
    return validateFederationIdentityCard(value);
  }

  pinFederationContact(input: {
    localServerScope: string;
    localAccountId: string;
    contactId: string;
    card: EnterpriseFederationIdentityCard;
    allowDeviceKeyChange?: boolean;
  }): EnterpriseFederationContactTrust {
    return this.vault.saveFederationContactTrust({
      ...input,
      card: validateFederationIdentityCard(input.card),
    });
  }

  federationContactTrust(input: {
    localServerScope: string;
    localAccountId: string;
    contactId: string;
  }): EnterpriseFederationContactTrust | null {
    const trust = this.vault.loadFederationContactTrust(input);
    if (trust) validateFederationIdentityCard(trust.card);
    return trust;
  }

  verifyFederationContact(input: {
    localServerScope: string;
    localAccountId: string;
    contactId: string;
  }): EnterpriseFederationContactTrust {
    return this.vault.verifyFederationContact(input);
  }

  removeFederationContact(input: {
    localServerScope: string;
    localAccountId: string;
    contactId: string;
  }): void {
    this.vault.removeFederationContact(input);
  }

  verifyLocalDeviceRegistration(
    local: EnterpriseE2eeDeviceBundle,
    registered: EnterpriseE2eeDeviceBundle,
  ): EnterpriseE2eeDeviceBundle {
    if (
      registered.accountId !== local.accountId ||
      registered.deviceId !== local.deviceId ||
      registered.identitySigningPublicKey !== local.identitySigningPublicKey ||
      registered.deviceExchangePublicKey !== local.deviceExchangePublicKey ||
      registered.keyFingerprint !== enterpriseE2eeDeviceKeyFingerprint(local)
    ) {
      throw new Error('E2EE server returned a substituted local device key');
    }
    return registered;
  }

  verifyDeviceDirectory(input: {
    organizationId: string;
    devices: EnterpriseE2eeDeviceBundle[];
    transparency: EnterpriseE2eeKeyTransparencyView[];
    includePending: boolean;
    includeRevoked: boolean;
  }): EnterpriseE2eeDeviceBundle[] {
    const expected = new Map<
      string,
      { entry: EnterpriseE2eeKeyTransparencyEntry; accountId: string }
    >();
    for (const rawView of input.transparency) {
      const view = validateTransparencyView(input.organizationId, rawView);
      const latest = new Map<string, EnterpriseE2eeKeyTransparencyEntry>();
      for (const entry of view.entries) latest.set(entry.deviceId, entry);
      for (const entry of latest.values()) {
        const visible =
          entry.event === 'revoked'
            ? input.includeRevoked
            : entry.event === 'registered_pending'
              ? input.includePending
              : true;
        if (visible) {
          expected.set(`${view.accountId}:${entry.deviceId}`, {
            entry,
            accountId: view.accountId,
          });
        }
      }
    }

    const actual = new Set<string>();
    for (const device of input.devices) {
      const key = `${device.accountId}:${device.deviceId}`;
      if (actual.has(key)) throw new Error('E2EE device directory is duplicated');
      actual.add(key);
      if (enterpriseE2eeDeviceKeyFingerprint(device) !== device.keyFingerprint) {
        throw new Error('E2EE device fingerprint does not match its public keys');
      }
      const pinned = expected.get(key);
      if (!pinned || pinned.entry.keyFingerprint !== device.keyFingerprint) {
        throw new Error('E2EE device directory does not match transparency log');
      }
      const stateMatches =
        pinned.entry.event === 'revoked'
          ? device.revokedAt !== null
          : pinned.entry.event === 'registered_pending'
            ? device.revokedAt === null && device.approvalState === 'pending'
            : device.revokedAt === null && device.approvalState === 'approved';
      if (!stateMatches) {
        throw new Error('E2EE device state does not match transparency log');
      }
    }
    if (
      actual.size !== expected.size ||
      [...expected.keys()].some((key) => !actual.has(key))
    ) {
      throw new Error('E2EE device directory does not match transparency log');
    }
    return input.devices;
  }

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
