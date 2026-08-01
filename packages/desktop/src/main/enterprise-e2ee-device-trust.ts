/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * E2EE v2 device trust lives in Electron main. The renderer receives only
 * public directory metadata; private keys stay inside an OS-protected vault.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  OTTO_E2EE_PROTOCOL_ID,
  OTTO_E2EE_TRUST_VERSION,
  type EnterpriseE2eeAccountRootRegistration,
  type EnterpriseE2eeCapabilityStatus,
  type EnterpriseE2eeDeviceApprovalProof,
  type EnterpriseE2eeDeviceDirectory,
  type EnterpriseE2eeDeviceRegistration,
  type EnterpriseE2eeDeviceRevocationProof,
} from './enterprise-client.js';

const VAULT_VERSION = 2 as const;
const SIGNATURE_PREFIX = 'ed25519:';
const DEVICE_CREDENTIAL_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const EMPTY_MERKLE_ROOT = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

type DirectoryDevice = EnterpriseE2eeDeviceDirectory['devices'][number];
type DirectoryProof = EnterpriseE2eeDeviceDirectory['proofs'][number]['proof'];
type TransparencyCheckpoint = EnterpriseE2eeDeviceDirectory['transparency']['checkpoint'];

export interface EnterpriseE2eeScope {
  serverUrl: string;
  organizationId: string;
  accountId: string;
}

interface StoredKeyPair {
  publicKey: string;
  privateKey: string;
}

interface StoredDeviceIdentity extends StoredKeyPair {
  deviceId: string;
  deviceName: string;
  createdAt: string;
}

interface StoredRootIdentity {
  signing: StoredKeyPair;
  recovery: StoredKeyPair;
  createdAt: string;
}

interface StoredCheckpoint extends TransparencyCheckpoint {
  pinnedAt: string;
}

interface DeviceTrustVaultRecord {
  version: typeof VAULT_VERSION;
  serverUrl: string;
  organizationId: string;
  accountId: string;
  device: StoredDeviceIdentity;
  root?: StoredRootIdentity;
  checkpoint?: StoredCheckpoint;
}

export interface EnterpriseE2eeDeviceSummary {
  deviceId: string;
  deviceName: string;
  state: DirectoryDevice['state'];
  isCurrentDevice: boolean;
  issuedAt: string;
  expiresAt: string;
  credentialFingerprint: string;
  transparencySequence: number;
}

export interface EnterpriseE2eeTrustOverview {
  capability: EnterpriseE2eeCapabilityStatus;
  secureStorage: {
    available: boolean;
    backend: string;
  };
  localDevice: {
    deviceId: string;
    deviceName: string;
    publicKeyFingerprint: string;
    registrationState: DirectoryDevice['state'] | 'not_registered';
  } | null;
  directoryState: 'not_initialized' | 'ready';
  canManageDevices: boolean;
  devices: EnterpriseE2eeDeviceSummary[];
  transparency: StoredCheckpoint | null;
}

export interface EnterpriseE2eeDeviceVerification {
  deviceId: string;
  deviceName: string;
  safetyNumber: string;
  qrPayload: string;
  fingerprints: [string, string];
}

export interface EnterpriseE2eeTrustClient {
  getE2eeCapabilityStatus(): Promise<EnterpriseE2eeCapabilityStatus>;
  registerE2eeAccountRoot(
    input: EnterpriseE2eeAccountRootRegistration,
  ): Promise<EnterpriseE2eeDeviceDirectory>;
  registerE2eeDevice(
    input: EnterpriseE2eeDeviceRegistration,
  ): Promise<EnterpriseE2eeDeviceDirectory>;
  approveE2eeDevice(
    input: EnterpriseE2eeDeviceApprovalProof,
  ): Promise<EnterpriseE2eeDeviceDirectory>;
  revokeE2eeDevice(
    input: EnterpriseE2eeDeviceRevocationProof,
  ): Promise<EnterpriseE2eeDeviceDirectory>;
  getE2eeDeviceDirectory(): Promise<EnterpriseE2eeDeviceDirectory>;
}

export interface EnterpriseE2eeVaultOptions {
  directory: string;
  protect(plaintext: string): string;
  unprotect(protectedValue: string): string;
  deviceName?: () => string;
  now?: () => Date;
  uuid?: () => string;
}

export interface EnterpriseE2eeTrustControllerOptions {
  client: EnterpriseE2eeTrustClient;
  vault: EnterpriseE2eeDeviceTrustVault;
  identity(): EnterpriseE2eeScope | null;
  secureStorageAvailable(): boolean;
  secureStorageBackend(): string;
  now?: () => Date;
  nonce?: () => string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalEnterpriseE2eeJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function publicKeyObject(value: string): KeyObject {
  const trimmed = value.trim().replace(/\\n/gu, '\n');
  const key = trimmed.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(trimmed)
    : createPublicKey({
        key: Buffer.from(trimmed, 'base64'),
        format: 'der',
        type: 'spki',
      });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('E2EE signing key must be Ed25519');
  }
  return key;
}

function privateKeyObject(value: string): KeyObject {
  const key = createPrivateKey({
    key: Buffer.from(value, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('E2EE private signing key must be Ed25519');
  }
  return key;
}

function publicKeyBase64(key: KeyObject): string {
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

function privateKeyBase64(key: KeyObject): string {
  return key.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

function normalizePublicKey(value: string): string {
  return publicKeyBase64(publicKeyObject(value));
}

function publicKeyFingerprint(value: string): string {
  return createHash('sha256')
    .update(publicKeyObject(value).export({ format: 'der', type: 'spki' }))
    .digest('hex');
}

function newKeyPair(): StoredKeyPair {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKeyBase64(pair.publicKey),
    privateKey: privateKeyBase64(pair.privateKey),
  };
}

function validateKeyPair(value: unknown): StoredKeyPair {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('E2EE protected key material is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.publicKey !== 'string' || typeof candidate.privateKey !== 'string') {
    throw new Error('E2EE protected key material is invalid');
  }
  const privateKey = privateKeyObject(candidate.privateKey);
  if (publicKeyBase64(createPublicKey(privateKey)) !== normalizePublicKey(candidate.publicKey)) {
    throw new Error('E2EE protected private key does not match its public key');
  }
  return {
    publicKey: normalizePublicKey(candidate.publicKey),
    privateKey: candidate.privateKey,
  };
}

function validateCheckpoint(value: unknown): StoredCheckpoint | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('E2EE pinned transparency checkpoint is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.size)
    || Number(candidate.size) < 1
    || typeof candidate.rootHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(candidate.rootHash)
    || typeof candidate.pinnedAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.pinnedAt))
  ) {
    throw new Error('E2EE pinned transparency checkpoint is invalid');
  }
  return {
    size: Number(candidate.size),
    rootHash: candidate.rootHash,
    pinnedAt: new Date(candidate.pinnedAt).toISOString(),
  };
}

function validateVaultRecord(value: unknown, scope: EnterpriseE2eeScope): DeviceTrustVaultRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('E2EE protected device vault is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== VAULT_VERSION
    || candidate.serverUrl !== scope.serverUrl
    || candidate.organizationId !== scope.organizationId
    || candidate.accountId !== scope.accountId
    || !candidate.device
    || typeof candidate.device !== 'object'
    || Array.isArray(candidate.device)
  ) {
    throw new Error('E2EE device vault belongs to another account or server');
  }
  const rawDevice = candidate.device as Record<string, unknown>;
  if (
    typeof rawDevice.deviceId !== 'string'
    || typeof rawDevice.deviceName !== 'string'
    || typeof rawDevice.createdAt !== 'string'
    || !rawDevice.deviceId
    || !rawDevice.deviceName
    || !Number.isFinite(Date.parse(rawDevice.createdAt))
  ) {
    throw new Error('E2EE protected device identity is invalid');
  }
  const deviceKeys = validateKeyPair(rawDevice);
  let root: StoredRootIdentity | undefined;
  if (candidate.root !== undefined) {
    if (!candidate.root || typeof candidate.root !== 'object' || Array.isArray(candidate.root)) {
      throw new Error('E2EE protected account root is invalid');
    }
    const rawRoot = candidate.root as Record<string, unknown>;
    if (
      typeof rawRoot.createdAt !== 'string'
      || !Number.isFinite(Date.parse(rawRoot.createdAt))
    ) {
      throw new Error('E2EE protected account root is invalid');
    }
    root = {
      signing: validateKeyPair(rawRoot.signing),
      recovery: validateKeyPair(rawRoot.recovery),
      createdAt: new Date(rawRoot.createdAt).toISOString(),
    };
  }
  return {
    version: VAULT_VERSION,
    serverUrl: scope.serverUrl,
    organizationId: scope.organizationId,
    accountId: scope.accountId,
    device: {
      ...deviceKeys,
      deviceId: rawDevice.deviceId,
      deviceName: rawDevice.deviceName.slice(0, 120),
      createdAt: new Date(rawDevice.createdAt).toISOString(),
    },
    ...(root ? { root } : {}),
    ...(candidate.checkpoint ? { checkpoint: validateCheckpoint(candidate.checkpoint) } : {}),
  };
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
      // Windows ACLs remain authoritative.
    }
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary path was already renamed or never created.
    }
  }
}

export class EnterpriseE2eeDeviceTrustVault {
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly deviceName: () => string;

  constructor(private readonly options: EnterpriseE2eeVaultOptions) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.deviceName = options.deviceName ?? (() => 'Otto desktop');
  }

  private recordPath(scope: EnterpriseE2eeScope): string {
    const digest = createHash('sha256')
      .update(`${scope.serverUrl}\0${scope.organizationId}\0${scope.accountId}`)
      .digest('hex');
    return path.join(this.options.directory, `${digest}.trust-v2`);
  }

  loadOrCreate(scope: EnterpriseE2eeScope): DeviceTrustVaultRecord {
    const filePath = this.recordPath(scope);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('E2EE device vault path must be a regular file');
      }
      const protectedValue = fs.readFileSync(filePath, 'utf8');
      return validateVaultRecord(
        JSON.parse(this.options.unprotect(protectedValue)) as unknown,
        scope,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const keys = newKeyPair();
    const created: DeviceTrustVaultRecord = {
      version: VAULT_VERSION,
      ...scope,
      device: {
        ...keys,
        deviceId: this.uuid(),
        deviceName: this.deviceName().trim().slice(0, 120) || 'Otto desktop',
        createdAt: this.now().toISOString(),
      },
    };
    this.save(created);
    return created;
  }

  ensureRoot(scope: EnterpriseE2eeScope): DeviceTrustVaultRecord {
    const record = this.loadOrCreate(scope);
    if (record.root) return record;
    const updated: DeviceTrustVaultRecord = {
      ...record,
      root: {
        signing: newKeyPair(),
        recovery: newKeyPair(),
        createdAt: this.now().toISOString(),
      },
    };
    this.save(updated);
    return updated;
  }

  pinCheckpoint(scope: EnterpriseE2eeScope, checkpoint: TransparencyCheckpoint): void {
    const record = this.loadOrCreate(scope);
    this.save({
      ...record,
      checkpoint: {
        ...checkpoint,
        pinnedAt: this.now().toISOString(),
      },
    });
  }

  erase(scope: EnterpriseE2eeScope): void {
    try {
      fs.unlinkSync(this.recordPath(scope));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private save(record: DeviceTrustVaultRecord): void {
    atomicWrite(
      this.recordPath(record),
      this.options.protect(JSON.stringify(record)),
    );
  }
}

function accountRootSigningPayload(
  input: Omit<EnterpriseE2eeAccountRootRegistration, 'signature' | 'recoverySignature'>,
): unknown {
  return { purpose: 'otto-e2ee-account-root-registration', ...input };
}

function deviceRegistrationSigningPayload(
  input: Omit<EnterpriseE2eeDeviceRegistration, 'signature' | 'bootstrap'>,
): unknown {
  return { purpose: 'otto-e2ee-device-registration', ...input };
}

function deviceCredentialHash(
  input: Omit<EnterpriseE2eeDeviceRegistration, 'signature' | 'bootstrap'>,
): string {
  return createHash('sha256')
    .update(canonicalEnterpriseE2eeJson(deviceRegistrationSigningPayload(input)))
    .digest('hex');
}

function deviceProofSigningPayload(input: DirectoryProof): unknown {
  const { signature: _signature, ...proof } = input;
  return {
    purpose: `otto-e2ee-device-${input.type}`,
    protocolId: OTTO_E2EE_PROTOCOL_ID,
    trustVersion: OTTO_E2EE_TRUST_VERSION,
    ...proof,
  };
}

function signPayload(payload: unknown, privateKey: string): string {
  return `${SIGNATURE_PREFIX}${sign(
    null,
    Buffer.from(canonicalEnterpriseE2eeJson(payload)),
    privateKeyObject(privateKey),
  ).toString('base64url')}`;
}

function verifySignature(payload: unknown, signature: string, publicKey: string): boolean {
  if (!signature.startsWith(SIGNATURE_PREFIX)) return false;
  const bytes = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'base64url');
  if (bytes.length !== 64) return false;
  try {
    return verify(
      null,
      Buffer.from(canonicalEnterpriseE2eeJson(payload)),
      publicKeyObject(publicKey),
      bytes,
    );
  } catch {
    return false;
  }
}

function rootRegistration(directory: EnterpriseE2eeDeviceDirectory): EnterpriseE2eeAccountRootRegistration {
  const { rootKeyId: _rootKeyId, transparencySequence: _sequence, ...root } = directory.root;
  return root;
}

function deviceRegistration(device: DirectoryDevice): EnterpriseE2eeDeviceRegistration {
  const {
    credentialHash: _credentialHash,
    state: _state,
    transparencySequence: _sequence,
    ...registration
  } = device;
  return registration;
}

function transparencyPayload(kind: string, value: unknown): unknown {
  return { kind, value };
}

function transparencyLeafHash(payload: unknown): string {
  return createHash('sha256')
    .update(Buffer.concat([
      Buffer.from([0]),
      Buffer.from(canonicalEnterpriseE2eeJson(payload)),
    ]))
    .digest('hex');
}

function transparencyNodeHash(left: string, right: string): string {
  return createHash('sha256')
    .update(Buffer.concat([
      Buffer.from([1]),
      Buffer.from(left, 'hex'),
      Buffer.from(right, 'hex'),
    ]))
    .digest('hex');
}

function largestPowerOfTwoBelow(value: number): number {
  let result = 1;
  while (result * 2 < value) result *= 2;
  return result;
}

function merkleRoot(hashes: readonly string[]): string {
  if (hashes.length === 0) return EMPTY_MERKLE_ROOT;
  if (hashes.length === 1) return hashes[0]!;
  const split = largestPowerOfTwoBelow(hashes.length);
  return transparencyNodeHash(
    merkleRoot(hashes.slice(0, split)),
    merkleRoot(hashes.slice(split)),
  );
}

function assertScope(
  directory: EnterpriseE2eeDeviceDirectory,
  organizationId: string,
  accountId: string,
): void {
  if (organizationId !== directory.organizationId || accountId !== directory.accountId) {
    throw new Error('E2EE directory contains a cross-account trust record');
  }
}

/** Independently verifies every signed record and the append-only log. */
export function verifyEnterpriseE2eeDirectory(
  directory: EnterpriseE2eeDeviceDirectory,
  previous?: TransparencyCheckpoint,
  nowMs: number = Date.now(),
): void {
  if (
    directory.protocolId !== OTTO_E2EE_PROTOCOL_ID
    || directory.trustVersion !== OTTO_E2EE_TRUST_VERSION
  ) {
    throw new Error('E2EE directory protocol is unsupported');
  }
  const root = rootRegistration(directory);
  const {
    signature: _rootSignature,
    recoverySignature: _recoverySignature,
    ...unsignedRoot
  } = root;
  assertScope(directory, root.organizationId, root.accountId);
  if (
    publicKeyFingerprint(root.rootSigningPublicKey) !== directory.root.rootKeyId
    || !verifySignature(accountRootSigningPayload(unsignedRoot), root.signature, root.rootSigningPublicKey)
    || !verifySignature(
      accountRootSigningPayload(unsignedRoot),
      root.recoverySignature,
      root.recoveryPublicKey,
    )
  ) {
    throw new Error('E2EE account trust root signature is invalid');
  }

  const registrations = new Map<string, EnterpriseE2eeDeviceRegistration>();
  const states = new Map<string, DirectoryDevice['state']>();
  for (const device of directory.devices) {
    const registration = deviceRegistration(device);
    const {
      signature: _signature,
      bootstrap: _bootstrap,
      ...unsignedDevice
    } = registration;
    assertScope(directory, registration.organizationId, registration.accountId);
    if (
      deviceCredentialHash(unsignedDevice) !== device.credentialHash
      || !verifySignature(
        deviceRegistrationSigningPayload(unsignedDevice),
        registration.signature,
        registration.signingPublicKey,
      )
    ) {
      throw new Error('E2EE device registration signature is invalid');
    }
    if (registrations.has(registration.deviceId)) {
      throw new Error('E2EE directory contains a duplicate device');
    }
    registrations.set(registration.deviceId, registration);
    states.set(registration.deviceId, 'pending');
  }

  const proofs = [...directory.proofs].sort(
    (left, right) => left.transparencySequence - right.transparencySequence,
  );
  for (const entry of proofs) {
    const proof = entry.proof;
    assertScope(directory, proof.organizationId, proof.accountId);
    const target = registrations.get(proof.targetDeviceId);
    if (!target) throw new Error('E2EE device proof targets an unknown credential');
    const {
      signature: _targetSignature,
      bootstrap: _targetBootstrap,
      ...unsignedTarget
    } = target;
    if (deviceCredentialHash(unsignedTarget) !== proof.targetCredentialHash) {
      throw new Error('E2EE device proof targets an unknown credential');
    }
    if (proof.type === 'bootstrap') {
      if ([...states.values()].some((state) => state === 'approved')) {
        throw new Error('E2EE bootstrap proof is only valid for the first device');
      }
      if (!verifySignature(deviceProofSigningPayload(proof), proof.signature, root.rootSigningPublicKey)) {
        throw new Error('E2EE bootstrap proof signature is invalid');
      }
      states.set(proof.targetDeviceId, 'approved');
      continue;
    }
    const actor = registrations.get(proof.actorDeviceId);
    if (!actor || states.get(proof.actorDeviceId) !== 'approved') {
      throw new Error('E2EE device proof actor is not an approved device');
    }
    if (Date.parse(actor.expiresAt) <= Date.parse(proof.issuedAt)) {
      throw new Error('E2EE device proof actor credential was expired');
    }
    if (!verifySignature(deviceProofSigningPayload(proof), proof.signature, actor.signingPublicKey)) {
      throw new Error('E2EE device proof signature is invalid');
    }
    if (proof.type === 'approval') {
      if (states.get(proof.targetDeviceId) !== 'pending') {
        throw new Error('E2EE approval proof does not target a pending device');
      }
      states.set(proof.targetDeviceId, 'approved');
    } else {
      if (states.get(proof.targetDeviceId) !== 'approved') {
        throw new Error('E2EE revocation proof does not target an approved device');
      }
      states.set(proof.targetDeviceId, 'revoked');
    }
  }
  for (const device of directory.devices) {
    const expected = states.get(device.deviceId) !== 'revoked' && Date.parse(device.expiresAt) <= nowMs
      ? 'expired'
      : states.get(device.deviceId);
    if (device.state !== expected) {
      throw new Error('E2EE device state is not backed by signed proofs');
    }
  }

  const expectedLeaves = new Map<number, { kind: string; payload: unknown }>();
  const expectLeaf = (sequence: number, kind: string, payload: unknown): void => {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || expectedLeaves.has(sequence)) {
      throw new Error('E2EE transparency log contains a duplicate or invalid sequence');
    }
    expectedLeaves.set(sequence, { kind, payload });
  };
  expectLeaf(directory.root.transparencySequence, 'account_root_registered',
    transparencyPayload('account_root_registered', root));
  for (const device of directory.devices) {
    const registration = deviceRegistration(device);
    expectLeaf(device.transparencySequence, 'device_registered',
      transparencyPayload('device_registered', registration));
  }
  for (const entry of directory.proofs) {
    const kind = entry.proof.type === 'bootstrap'
      ? 'device_bootstrapped'
      : entry.proof.type === 'approval'
        ? 'device_approved'
        : 'device_revoked';
    expectLeaf(entry.transparencySequence, kind, transparencyPayload(kind, entry.proof));
  }
  const leaves = [...directory.transparency.leaves].sort(
    (left, right) => left.accountSequence - right.accountSequence,
  );
  if (leaves.length !== expectedLeaves.size) {
    throw new Error('E2EE transparency log omitted or added a trust event');
  }
  for (let index = 0; index < leaves.length; index += 1) {
    const leaf = leaves[index]!;
    const expected = expectedLeaves.get(leaf.accountSequence);
    if (
      leaf.accountSequence !== index + 1
      || !expected
      || expected.kind !== leaf.kind
      || canonicalEnterpriseE2eeJson(expected.payload) !== canonicalEnterpriseE2eeJson(leaf.payload)
      || transparencyLeafHash(leaf.payload) !== leaf.leafHash
    ) {
      throw new Error('E2EE transparency event does not match its signed record');
    }
  }
  const hashes = leaves.map((leaf) => leaf.leafHash);
  if (
    directory.transparency.checkpoint.size !== hashes.length
    || directory.transparency.checkpoint.rootHash !== merkleRoot(hashes)
  ) {
    throw new Error('E2EE transparency checkpoint is invalid');
  }
  if (previous) {
    if (previous.size > hashes.length) throw new Error('E2EE transparency rollback detected');
    if (previous.rootHash !== merkleRoot(hashes.slice(0, previous.size))) {
      throw new Error('E2EE transparency fork detected');
    }
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'status' in error
    && (error as { status?: unknown }).status === 404,
  );
}

function validateMlsKeyPackage(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new Error('MLS KeyPackage is invalid');
  }
  const bytes = Buffer.from(normalized, 'base64url');
  if (bytes.length < 32 || bytes.length > 64 * 1024) {
    throw new Error('MLS KeyPackage size is invalid');
  }
  return bytes.toString('base64url');
}

function safetyFingerprint(device: DirectoryDevice): string {
  return createHash('sha256')
    .update(canonicalEnterpriseE2eeJson({
      deviceId: device.deviceId,
      credentialHash: device.credentialHash,
      signingKey: normalizePublicKey(device.signingPublicKey),
    }))
    .digest('hex');
}

interface LoadedTrustState {
  scope: EnterpriseE2eeScope;
  capability: EnterpriseE2eeCapabilityStatus;
  record: DeviceTrustVaultRecord;
  directory: EnterpriseE2eeDeviceDirectory | null;
}

export class EnterpriseE2eeDeviceTrustController {
  private readonly now: () => Date;
  private readonly nonce: () => string;
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly options: EnterpriseE2eeTrustControllerOptions) {
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? (() => randomBytes(24).toString('base64url'));
  }

  overview(): Promise<EnterpriseE2eeTrustOverview> {
    return this.exclusive(async () => {
      const capability = await this.options.client.getE2eeCapabilityStatus();
      if (!this.options.secureStorageAvailable()) {
        return {
          capability,
          secureStorage: { available: false, backend: this.options.secureStorageBackend() },
          localDevice: null,
          directoryState: 'not_initialized',
          canManageDevices: false,
          devices: [],
          transparency: null,
        };
      }
      return this.overviewFromState(await this.loadState(capability));
    });
  }

  verification(deviceId: string): Promise<EnterpriseE2eeDeviceVerification> {
    return this.exclusive(async () => {
      const state = await this.loadState();
      const directory = this.requireDirectory(state);
      const current = this.requireCurrentApprovedDevice(state);
      const target = directory.devices.find((device) => device.deviceId === deviceId);
      if (!target) throw new Error('E2EE device was not found');
      const entries = [current, target]
        .map((device) => ({
          deviceId: device.deviceId,
          fingerprint: safetyFingerprint(device),
        }))
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
      const payload = {
        version: 2,
        protocolId: OTTO_E2EE_PROTOCOL_ID,
        organizationId: state.scope.organizationId,
        accountId: state.scope.accountId,
        rootKeyId: directory.root.rootKeyId,
        checkpoint: directory.transparency.checkpoint,
        devices: entries,
      };
      const digest = createHash('sha512')
        .update('otto:e2ee-safety-number:v2\n')
        .update(canonicalEnterpriseE2eeJson(payload))
        .digest();
      const groups = Array.from({ length: 12 }, (_, index) =>
        String(digest.readUInt32BE(index * 4) % 100_000).padStart(5, '0'));
      return {
        deviceId: target.deviceId,
        deviceName: target.deviceName,
        safetyNumber: groups.join(' '),
        qrPayload: `otto-e2ee-verify:v2:${Buffer.from(
          canonicalEnterpriseE2eeJson(payload),
        ).toString('base64url')}`,
        fingerprints: [entries[0]!.fingerprint, entries[1]!.fingerprint],
      };
    });
  }

  approve(deviceId: string): Promise<EnterpriseE2eeTrustOverview> {
    return this.exclusive(async () => {
      const state = await this.loadState();
      const directory = this.requireDirectory(state);
      const current = this.requireCurrentApprovedDevice(state);
      const target = directory.devices.find((device) => device.deviceId === deviceId);
      if (!target || target.state !== 'pending') {
        throw new Error('Only a pending E2EE device can be approved');
      }
      if (target.deviceId === current.deviceId) {
        throw new Error('An E2EE device cannot approve itself');
      }
      const unsigned = {
        type: 'approval' as const,
        organizationId: state.scope.organizationId,
        accountId: state.scope.accountId,
        actorDeviceId: current.deviceId,
        targetDeviceId: target.deviceId,
        targetCredentialHash: target.credentialHash,
        issuedAt: this.now().toISOString(),
        nonce: this.nonce(),
      };
      const proof: EnterpriseE2eeDeviceApprovalProof = {
        ...unsigned,
        signature: signPayload(deviceProofSigningPayload({ ...unsigned, signature: '' }), state.record.device.privateKey),
      };
      const next = await this.options.client.approveE2eeDevice(proof);
      this.verifyAndPin(state.scope, next, state.record.checkpoint);
      return this.overviewFromState({ ...state, directory: next });
    });
  }

  revoke(deviceId: string): Promise<EnterpriseE2eeTrustOverview> {
    return this.exclusive(async () => {
      const state = await this.loadState();
      const directory = this.requireDirectory(state);
      const current = this.requireCurrentApprovedDevice(state);
      const target = directory.devices.find((device) => device.deviceId === deviceId);
      if (!target || target.state !== 'approved') {
        throw new Error('Only an approved E2EE device can be revoked');
      }
      if (target.deviceId === current.deviceId) {
        throw new Error('Use account recovery to revoke the current E2EE device');
      }
      const unsigned = {
        type: 'revocation' as const,
        organizationId: state.scope.organizationId,
        accountId: state.scope.accountId,
        actorDeviceId: current.deviceId,
        targetDeviceId: target.deviceId,
        targetCredentialHash: target.credentialHash,
        issuedAt: this.now().toISOString(),
        nonce: this.nonce(),
      };
      const proof: EnterpriseE2eeDeviceRevocationProof = {
        ...unsigned,
        signature: signPayload(deviceProofSigningPayload({ ...unsigned, signature: '' }), state.record.device.privateKey),
      };
      const next = await this.options.client.revokeE2eeDevice(proof);
      this.verifyAndPin(state.scope, next, state.record.checkpoint);
      return this.overviewFromState({ ...state, directory: next });
    });
  }

  /** Integration seam for the future OpenMLS bridge; never called by renderer. */
  bootstrapWithMlsKeyPackage(mlsKeyPackage: string): Promise<EnterpriseE2eeTrustOverview> {
    return this.exclusive(async () => {
      const capability = await this.options.client.getE2eeCapabilityStatus();
      const state = await this.loadState(capability);
      if (state.directory) throw new Error('E2EE account trust root is already registered');
      const record = this.options.vault.ensureRoot(state.scope);
      const root = record.root!;
      const rootUnsigned = {
        protocolId: OTTO_E2EE_PROTOCOL_ID,
        trustVersion: OTTO_E2EE_TRUST_VERSION,
        organizationId: state.scope.organizationId,
        accountId: state.scope.accountId,
        rootSigningPublicKey: root.signing.publicKey,
        recoveryPublicKey: root.recovery.publicKey,
        issuedAt: this.now().toISOString(),
        nonce: this.nonce(),
      };
      const rootRegistrationInput: EnterpriseE2eeAccountRootRegistration = {
        ...rootUnsigned,
        signature: signPayload(accountRootSigningPayload(rootUnsigned), root.signing.privateKey),
        recoverySignature: signPayload(accountRootSigningPayload(rootUnsigned), root.recovery.privateKey),
      };
      const rootDirectory = await this.options.client.registerE2eeAccountRoot(rootRegistrationInput);
      this.verifyAndPin(state.scope, rootDirectory, record.checkpoint);
      const deviceDirectory = await this.options.client.registerE2eeDevice(
        this.deviceRegistration(record, validateMlsKeyPackage(mlsKeyPackage), true),
      );
      this.verifyAndPin(state.scope, deviceDirectory, rootDirectory.transparency.checkpoint);
      return this.overviewFromState({ ...state, record, directory: deviceDirectory });
    });
  }

  /** Integration seam for a new OpenMLS client leaf; never called by renderer. */
  registerWithMlsKeyPackage(mlsKeyPackage: string): Promise<EnterpriseE2eeTrustOverview> {
    return this.exclusive(async () => {
      const state = await this.loadState();
      const directory = this.requireDirectory(state);
      if (directory.devices.some((device) => device.deviceId === state.record.device.deviceId)) {
        throw new Error('Current E2EE device is already registered');
      }
      const next = await this.options.client.registerE2eeDevice(
        this.deviceRegistration(state.record, validateMlsKeyPackage(mlsKeyPackage), false),
      );
      this.verifyAndPin(state.scope, next, state.record.checkpoint);
      return this.overviewFromState({ ...state, directory: next });
    });
  }

  eraseCurrentScope(): void {
    const scope = this.requireScope();
    this.options.vault.erase(scope);
  }

  private deviceRegistration(
    record: DeviceTrustVaultRecord,
    mlsKeyPackage: string,
    bootstrap: boolean,
  ): EnterpriseE2eeDeviceRegistration {
    const unsigned = {
      protocolId: OTTO_E2EE_PROTOCOL_ID,
      trustVersion: OTTO_E2EE_TRUST_VERSION,
      organizationId: record.organizationId,
      accountId: record.accountId,
      deviceId: record.device.deviceId,
      deviceName: record.device.deviceName,
      signingPublicKey: record.device.publicKey,
      mlsKeyPackage,
      issuedAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + DEVICE_CREDENTIAL_LIFETIME_MS).toISOString(),
      nonce: this.nonce(),
    };
    const credentialHash = deviceCredentialHash(unsigned);
    const registration: EnterpriseE2eeDeviceRegistration = {
      ...unsigned,
      signature: signPayload(deviceRegistrationSigningPayload(unsigned), record.device.privateKey),
    };
    if (bootstrap) {
      if (!record.root) throw new Error('E2EE account root key is unavailable');
      const proof = {
        type: 'bootstrap' as const,
        organizationId: record.organizationId,
        accountId: record.accountId,
        targetDeviceId: record.device.deviceId,
        targetCredentialHash: credentialHash,
        issuedAt: this.now().toISOString(),
        nonce: this.nonce(),
      };
      registration.bootstrap = {
        ...proof,
        signature: signPayload(
          deviceProofSigningPayload({ ...proof, signature: '' }),
          record.root.signing.privateKey,
        ),
      };
    }
    return registration;
  }

  private async loadState(
    knownCapability?: EnterpriseE2eeCapabilityStatus,
  ): Promise<LoadedTrustState> {
    if (!this.options.secureStorageAvailable()) {
      throw new Error('系统安全存储不可用，无法读取 E2EE 设备私钥');
    }
    const scope = this.requireScope();
    const capability = knownCapability ?? await this.options.client.getE2eeCapabilityStatus();
    const record = this.options.vault.loadOrCreate(scope);
    let directory: EnterpriseE2eeDeviceDirectory | null;
    try {
      directory = await this.options.client.getE2eeDeviceDirectory();
    } catch (error) {
      if (!isNotFound(error)) throw error;
      directory = null;
    }
    if (directory) this.verifyAndPin(scope, directory, record.checkpoint);
    return { scope, capability, record, directory };
  }

  private verifyAndPin(
    scope: EnterpriseE2eeScope,
    directory: EnterpriseE2eeDeviceDirectory,
    previous?: TransparencyCheckpoint,
  ): void {
    if (
      directory.organizationId !== scope.organizationId
      || directory.accountId !== scope.accountId
    ) {
      throw new Error('E2EE directory scope does not match the current account');
    }
    verifyEnterpriseE2eeDirectory(directory, previous, this.now().getTime());
    this.options.vault.pinCheckpoint(scope, directory.transparency.checkpoint);
  }

  private requireScope(): EnterpriseE2eeScope {
    const scope = this.options.identity();
    if (!scope) throw new Error('登录已失效，请重新登录');
    return scope;
  }

  private requireDirectory(state: LoadedTrustState): EnterpriseE2eeDeviceDirectory {
    if (!state.directory) throw new Error('E2EE device directory is not initialized');
    return state.directory;
  }

  private currentDevice(state: LoadedTrustState): DirectoryDevice | undefined {
    const candidate = state.directory?.devices.find(
      (device) => device.deviceId === state.record.device.deviceId,
    );
    if (
      candidate
      && normalizePublicKey(candidate.signingPublicKey) !== state.record.device.publicKey
    ) {
      throw new Error('E2EE local device id is bound to a different signing key');
    }
    return candidate;
  }

  private requireCurrentApprovedDevice(state: LoadedTrustState): DirectoryDevice {
    const current = this.currentDevice(state);
    if (!current || current.state !== 'approved') {
      throw new Error('Current device is not approved for E2EE trust actions');
    }
    return current;
  }

  private overviewFromState(state: LoadedTrustState): EnterpriseE2eeTrustOverview {
    const current = this.currentDevice(state);
    const checkpoint = state.directory?.transparency.checkpoint;
    return {
      capability: state.capability,
      secureStorage: {
        available: true,
        backend: this.options.secureStorageBackend(),
      },
      localDevice: {
        deviceId: state.record.device.deviceId,
        deviceName: state.record.device.deviceName,
        publicKeyFingerprint: publicKeyFingerprint(state.record.device.publicKey),
        registrationState: current?.state ?? 'not_registered',
      },
      directoryState: state.directory ? 'ready' : 'not_initialized',
      canManageDevices: current?.state === 'approved',
      devices: (state.directory?.devices ?? [])
        .map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          state: device.state,
          isCurrentDevice: device.deviceId === state.record.device.deviceId,
          issuedAt: device.issuedAt,
          expiresAt: device.expiresAt,
          credentialFingerprint: safetyFingerprint(device),
          transparencySequence: device.transparencySequence,
        }))
        .sort((left, right) => {
          if (left.isCurrentDevice !== right.isCurrentDevice) return left.isCurrentDevice ? -1 : 1;
          if (left.state !== right.state) return left.state.localeCompare(right.state);
          return right.issuedAt.localeCompare(left.issuedAt);
        }),
      transparency: checkpoint
        ? {
            ...checkpoint,
            pinnedAt: this.options.vault.loadOrCreate(state.scope).checkpoint?.pinnedAt
              ?? this.now().toISOString(),
          }
        : null,
    };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}
