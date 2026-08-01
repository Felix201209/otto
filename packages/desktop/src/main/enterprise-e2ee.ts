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
import {
  canonicalE2eeBytes,
  E2EE_TRUST_FORMAT,
  E2EE_ATOA_GRANT_FORMAT,
  e2eeAtoaGrantDigest,
  e2eeAtoaGrantPayload,
  e2eeAtoaRequestDigest,
  e2eeDeviceCertificateApprovalPayload,
  e2eeDeviceCertificateRequestHash,
  e2eeDeviceCertificateRequestPayload,
  e2eeMerkleRoot,
  verifyE2eeAtoaOneTimeGrant,
  verifyE2eeDeviceCertificateRequest,
  verifyE2eeMerkleAppendOnlySnapshot,
  verifyE2eeMerkleInclusion,
  type AtoaContextSource,
  type E2eeAtoaOneTimeGrant,
  type E2eeDeviceCertificateApprovalV2,
  type E2eeDeviceCertificateRequestV2,
  type E2eeMerkleInclusionProof,
} from 'otto-server';

export const ENTERPRISE_E2EE_PROTOCOL_VERSION = 1 as const;

export interface EnterpriseE2eeDeviceBundle {
  accountId: string;
  deviceId: string;
  deviceName: string;
  identitySigningPublicKey: string;
  deviceExchangePublicKey: string;
  keyFingerprint: string;
  certificateFormat?: 2;
  certificateSerial?: string;
  certificateRequest?: E2eeDeviceCertificateRequestV2;
  certificateHash?: string | null;
  certificateExpiresAt?: string | null;
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

export type EnterpriseE2eeDeviceApproval = E2eeDeviceCertificateApprovalV2;

export interface EnterpriseAtoaAuthorizationReceipt {
  grantId: string;
  grantDigest: string;
  expiresAt: string;
  allowedSources: AtoaContextSource[];
  authorizedMessageIds: string[];
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
  certificateHash: string;
  actorDeviceId: string | null;
  previousHash: string;
  entryHash: string;
  createdAt: string;
}

export interface EnterpriseE2eeKeyTransparencyView {
  accountId: string;
  headSequence: number;
  headHash: string;
  treeSize: number;
  merkleRoot: string;
  inclusionProofs: E2eeMerkleInclusionProof[];
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
  certificateSerial: string;
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

interface RecoveryPackageV1 {
  v: 1;
  kdf: 'scrypt';
  cipher: 'aes-256-gcm';
  salt: string;
  nonce: string;
  ciphertext: string;
  createdAt: string;
}

interface RecoveryPackageV2 {
  v: 2;
  kdf: 'scrypt';
  cipher: 'aes-256-gcm';
  scopeHash: string;
  accountHash: string;
  keyringHash: string;
  salt: string;
  nonce: string;
  ciphertext: string;
  createdAt: string;
}

type RecoveryPackage = RecoveryPackageV1 | RecoveryPackageV2;

interface TransparencyCheckpoint {
  v: 1 | 2;
  serverScope: string;
  organizationId: string;
  accountId: string;
  headSequence: number;
  headHash: string;
  treeSize?: number;
  merkleRoot?: string;
  updatedAt: string;
}

interface AtoaGrantLedgerFile {
  v: 1;
  entries: Array<{ replayKey: string; expiresAt: string }>;
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
    certificateSerial: randomUUID(),
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
  const result = {
    ...raw,
    certificateSerial:
      typeof raw.certificateSerial === 'string' && raw.certificateSerial
        ? raw.certificateSerial
        : `cert-${String(raw.deviceId)}`,
  } as unknown as DeviceKeySet;
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

export function enterpriseE2eeTransparencyLeaf(
  organizationId: string,
  entry: EnterpriseE2eeKeyTransparencyEntry,
): Buffer {
  return canonicalE2eeBytes('otto:e2ee-transparency-event:v2', {
    organizationId,
    ...entry,
  });
}

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
    !Number.isSafeInteger(view.treeSize) ||
    view.treeSize < 0 ||
    !TRANSPARENCY_HASH.test(view.merkleRoot) ||
    !Array.isArray(view.inclusionProofs) ||
    !Array.isArray(view.entries) ||
    view.entries.length !== view.headSequence ||
    view.entries.length !== view.treeSize ||
    view.inclusionProofs.length !== view.treeSize
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
      !TRANSPARENCY_HASH.test(entry.certificateHash) ||
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
          certificateHash: entry.certificateHash,
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
  const leaves = view.entries.map((entry) =>
    enterpriseE2eeTransparencyLeaf(organizationId, entry),
  );
  if (e2eeMerkleRoot(leaves) !== view.merkleRoot) {
    throw new Error('E2EE Merkle transparency root is invalid');
  }
  for (const [leafIndex, leaf] of leaves.entries()) {
    const proof = view.inclusionProofs[leafIndex];
    if (
      !proof ||
      proof.leafIndex !== leafIndex ||
      proof.treeSize !== view.treeSize ||
      !verifyE2eeMerkleInclusion({
        leaf,
        proof,
        expectedRoot: view.merkleRoot,
      })
    ) {
      throw new Error('E2EE Merkle transparency inclusion proof is invalid');
    }
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

  currentTime(): Date {
    return this.now();
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

  private atoaGrantLedgerPath(serverScope: string, accountId: string): string {
    const digest = createHash('sha256')
      .update(`${serverScope}\0${accountId}`)
      .digest('hex');
    return path.join(this.options.directory, `${digest}.atoa-grants`);
  }

  consumeAtoaGrant(input: {
    serverScope: string;
    accountId: string;
    replayKey: string;
    expiresAt: string;
  }): void {
    const filePath = this.atoaGrantLedgerPath(input.serverScope, input.accountId);
    const now = this.now().getTime();
    let ledger: AtoaGrantLedgerFile = { v: 1, entries: [] };
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('E2EE A2A grant ledger path must be a regular file');
      }
      const parsed = JSON.parse(
        this.options.unprotect(fs.readFileSync(filePath, 'utf8')),
      ) as Partial<AtoaGrantLedgerFile>;
      if (
        parsed.v !== 1 ||
        !Array.isArray(parsed.entries) ||
        parsed.entries.some(
          (entry) =>
            !entry ||
            typeof entry.replayKey !== 'string' ||
            typeof entry.expiresAt !== 'string' ||
            !Number.isFinite(Date.parse(entry.expiresAt)),
        )
      ) {
        throw new Error('E2EE A2A grant ledger is invalid');
      }
      ledger = parsed as AtoaGrantLedgerFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const entries = ledger.entries.filter(
      (entry) => Date.parse(entry.expiresAt) > now - 24 * 60 * 60 * 1000,
    );
    if (entries.some((entry) => entry.replayKey === input.replayKey)) {
      throw new Error('A2A authorization was already consumed');
    }
    entries.push({ replayKey: input.replayKey, expiresAt: input.expiresAt });
    atomicWrite(
      filePath,
      this.options.protect(JSON.stringify({ v: 1, entries } satisfies AtoaGrantLedgerFile)),
    );
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
        (parsed.v !== 1 && parsed.v !== 2) ||
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
      if (checkpoint.v === 2) {
        if (
          checkpoint.treeSize !== checkpoint.headSequence ||
          typeof checkpoint.merkleRoot !== 'string'
        ) {
          throw new Error('E2EE Merkle transparency checkpoint is invalid');
        }
        verifyE2eeMerkleAppendOnlySnapshot({
          leaves: view.entries.map((entry) =>
            enterpriseE2eeTransparencyLeaf(input.organizationId, entry),
          ),
          treeSize: view.treeSize,
          rootHash: view.merkleRoot,
          pinnedTreeSize: checkpoint.treeSize,
          pinnedRootHash: checkpoint.merkleRoot,
        });
      }
    }

    if (
      !checkpoint ||
      checkpoint.headSequence !== view.headSequence ||
      checkpoint.headHash !== view.headHash ||
      checkpoint.v !== 2 ||
      checkpoint.merkleRoot !== view.merkleRoot
    ) {
      const next: TransparencyCheckpoint = {
        v: 2,
        serverScope: input.serverScope,
        organizationId: input.organizationId,
        accountId: view.accountId,
        headSequence: view.headSequence,
        headHash: view.headHash,
        treeSize: view.treeSize,
        merkleRoot: view.merkleRoot,
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
    const body = Buffer.from(JSON.stringify(keyring), 'utf8');
    const metadata = {
      v: 2 as const,
      kdf: 'scrypt' as const,
      cipher: 'aes-256-gcm' as const,
      scopeHash: createHash('sha256').update(serverScope).digest('hex'),
      accountHash: createHash('sha256').update(accountId).digest('hex'),
      keyringHash: createHash('sha256').update(body).digest('hex'),
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      createdAt: this.now().toISOString(),
    };
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(canonicalE2eeBytes('otto:e2ee-recovery:v2', metadata));
    const ciphertext = Buffer.concat([
      cipher.update(body),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const recovery: RecoveryPackageV2 = {
      ...metadata,
      ciphertext: ciphertext.toString('base64'),
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
      (recovery.v !== 1 && recovery.v !== 2) ||
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
      if (recovery.v === 2) {
        const metadata = {
          v: recovery.v,
          kdf: recovery.kdf,
          cipher: recovery.cipher,
          scopeHash: recovery.scopeHash,
          accountHash: recovery.accountHash,
          keyringHash: recovery.keyringHash,
          salt: recovery.salt,
          nonce: recovery.nonce,
          createdAt: recovery.createdAt,
        };
        if (
          recovery.scopeHash !==
            createHash('sha256').update(serverScope).digest('hex') ||
          recovery.accountHash !==
            createHash('sha256').update(accountId).digest('hex') ||
          !TRANSPARENCY_HASH.test(recovery.keyringHash)
        ) {
          throw new Error('invalid');
        }
        decipher.setAAD(canonicalE2eeBytes('otto:e2ee-recovery:v2', metadata));
      } else {
        decipher.setAAD(Buffer.from('otto-e2ee-recovery-v1', 'utf8'));
      }
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plaintextBuffer = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - 16)),
        decipher.final(),
      ]);
      if (
        recovery.v === 2 &&
        createHash('sha256').update(plaintextBuffer).digest('hex') !==
          recovery.keyringHash
      ) {
        throw new Error('invalid');
      }
      const plaintext = plaintextBuffer.toString('utf8');
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

function deviceTransparencyCertificateHash(
  device: EnterpriseE2eeDeviceBundle,
): string {
  if (device.certificateFormat !== 2 || !device.certificateRequest) {
    throw new Error('E2EE device is missing its v2 certificate request');
  }
  const request = verifyE2eeDeviceCertificateRequest(device.certificateRequest);
  if (
    request.accountId !== device.accountId ||
    request.deviceId !== device.deviceId ||
    request.credentialSigningPublicKey !== device.identitySigningPublicKey ||
    request.deviceExchangePublicKey !== device.deviceExchangePublicKey
  ) {
    throw new Error('E2EE device certificate does not match its public keys');
  }
  const requestHash = e2eeDeviceCertificateRequestHash(
    device.certificateRequest,
  );
  if (device.approvalState === 'pending') return requestHash;
  if (!device.certificateHash || !TRANSPARENCY_HASH.test(device.certificateHash)) {
    throw new Error('approved E2EE device certificate hash is unavailable');
  }
  return device.certificateHash;
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
    deviceTransparencyCertificateHash(registered);
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
      if (
        pinned.entry.certificateHash !==
        deviceTransparencyCertificateHash(device)
      ) {
        throw new Error(
          'E2EE device certificate does not match transparency log',
        );
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

  createDeviceCertificateRequest(input: {
    serverScope: string;
    deploymentId: string;
    organizationId: string;
    accountId: string;
  }): E2eeDeviceCertificateRequestV2 {
    const active = this.vault.loadOrCreate(
      input.serverScope,
      input.accountId,
    ).active;
    const unsigned: E2eeDeviceCertificateRequestV2 = {
      format: E2EE_TRUST_FORMAT,
      deploymentId: input.deploymentId,
      organizationId: input.organizationId,
      accountId: input.accountId,
      deviceId: active.deviceId,
      certificateSerial: active.certificateSerial,
      deviceName: active.deviceName,
      credentialSigningPublicKey: active.identitySigningPublicKey,
      deviceExchangePublicKey: active.deviceExchangePublicKey,
      predecessorCertificateHash: null,
      proofOfPossession: '',
    };
    return {
      ...unsigned,
      proofOfPossession: sign(
        null,
        e2eeDeviceCertificateRequestPayload(unsigned),
        active.identitySigningPrivateKey,
      ).toString('base64'),
    };
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
    approverDevice: EnterpriseE2eeDeviceBundle;
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
    if (
      input.approverDevice.deviceId !== active.deviceId ||
      !input.approverDevice.certificateHash
    ) {
      throw new Error('current E2EE device certificate is unavailable');
    }
    if (!input.targetDevice.certificateRequest) {
      throw new Error('pending E2EE device certificate request is unavailable');
    }
    const { proofOfPossession: _proof, ...request } =
      input.targetDevice.certificateRequest;
    if (
      request.organizationId !== input.organizationId ||
      request.accountId !== input.accountId ||
      request.deviceId !== input.targetDevice.deviceId
    ) {
      throw new Error('pending E2EE device certificate request is inconsistent');
    }
    const approvedAt = this.vault.currentTime();
    const unsigned: E2eeDeviceCertificateApprovalV2 = {
      format: E2EE_TRUST_FORMAT,
      request,
      approverDeviceId: active.deviceId,
      approverCertificateHash: input.approverDevice.certificateHash,
      approvedAt: approvedAt.toISOString(),
      expiresAt: new Date(
        approvedAt.getTime() + 365 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      approvalSignature: '',
    };
    return {
      ...unsigned,
      approvalSignature: sign(
        null,
        e2eeDeviceCertificateApprovalPayload(unsigned),
        active.identitySigningPrivateKey,
      ).toString('base64'),
    };
  }

  authorizeAtoaOnce(input: {
    serverScope: string;
    issuerDeploymentId: string;
    audienceDeploymentId: string;
    organizationId: string;
    issuerAccountId: string;
    requesterAccountId: string;
    requestMessageId: string;
    requestContent: string;
    allowedSources: AtoaContextSource[];
    authorizedMessageIds: string[];
  }): EnterpriseAtoaAuthorizationReceipt {
    const active = this.vault.loadOrCreate(
      input.serverScope,
      input.issuerAccountId,
    ).active;
    const issuedAt = this.vault.currentTime();
    const expiresAt = new Date(issuedAt.getTime() + 3 * 60 * 1000);
    const requestDigest = e2eeAtoaRequestDigest({
      requestMessageId: input.requestMessageId,
      requesterAccountId: input.requesterAccountId,
      recipientAccountId: input.issuerAccountId,
      content: input.requestContent,
    });
    const unsigned: E2eeAtoaOneTimeGrant = {
      format: E2EE_ATOA_GRANT_FORMAT,
      grantId: `grant_${randomUUID()}`,
      issuerDeploymentId: input.issuerDeploymentId,
      audienceDeploymentId: input.audienceDeploymentId,
      organizationId: input.organizationId,
      issuerAccountId: input.issuerAccountId,
      issuerDeviceId: active.deviceId,
      requesterAccountId: input.requesterAccountId,
      requestMessageId: input.requestMessageId,
      requestDigest,
      allowedSources: [...input.allowedSources],
      authorizedMessageIds: [...input.authorizedMessageIds],
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nonce: `nonce_${randomBytes(18).toString('base64url')}`,
      signature: '',
    };
    const grant: E2eeAtoaOneTimeGrant = {
      ...unsigned,
      signature: sign(
        null,
        e2eeAtoaGrantPayload(unsigned),
        active.identitySigningPrivateKey,
      ).toString('base64'),
    };
    const expected = {
      issuerDeploymentId: input.issuerDeploymentId,
      audienceDeploymentId: input.audienceDeploymentId,
      organizationId: input.organizationId,
      issuerAccountId: input.issuerAccountId,
      requesterAccountId: input.requesterAccountId,
      requestMessageId: input.requestMessageId,
      requestDigest,
    };
    const verified = verifyE2eeAtoaOneTimeGrant({
      grant,
      issuerSigningPublicKey: active.identitySigningPublicKey,
      expected,
      now: issuedAt,
    });
    const replayKey = [
      verified.issuerDeploymentId,
      verified.audienceDeploymentId,
      verified.organizationId,
      verified.issuerAccountId,
      verified.requestMessageId,
      verified.nonce,
    ].join(':');
    this.vault.consumeAtoaGrant({
      serverScope: input.serverScope,
      accountId: input.issuerAccountId,
      replayKey,
      expiresAt: verified.expiresAt,
    });
    return {
      grantId: verified.grantId,
      grantDigest: e2eeAtoaGrantDigest(grant),
      expiresAt: verified.expiresAt,
      allowedSources: [...verified.allowedSources],
      authorizedMessageIds: [...verified.authorizedMessageIds],
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
