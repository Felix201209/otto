/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createPublicKey } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalEnterpriseE2eeJson,
  EnterpriseE2eeDeviceTrustController,
  EnterpriseE2eeDeviceTrustVault,
  verifyEnterpriseE2eeDirectory,
  type EnterpriseE2eeScope,
  type EnterpriseE2eeTrustClient,
} from './enterprise-e2ee-device-trust.js';
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

const temporaryDirectories: string[] = [];
const FIXED_NOW = new Date('2026-08-01T08:00:00.000Z');
const CAPABILITY: EnterpriseE2eeCapabilityStatus = {
  protocolId: OTTO_E2EE_PROTOCOL_ID,
  releaseState: 'foundation-only',
  enabled: false,
  externalAuditCompleted: false,
  mlsEngineReady: false,
  reason: 'OpenMLS integration is not complete',
};

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-e2ee-trust-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scope(accountId = 'account-1'): EnterpriseE2eeScope {
  return {
    serverUrl: 'https://enterprise.example.test',
    organizationId: 'org-1',
    accountId,
  };
}

function vault(
  directory: string,
  deviceName: string,
  deviceId: string,
): EnterpriseE2eeDeviceTrustVault {
  return new EnterpriseE2eeDeviceTrustVault({
    directory,
    protect: (plaintext) => Buffer.from(`protected:${plaintext}`, 'utf8').toString('base64'),
    unprotect: (protectedValue) => {
      const plaintext = Buffer.from(protectedValue, 'base64').toString('utf8');
      if (!plaintext.startsWith('protected:')) throw new Error('not protected');
      return plaintext.slice('protected:'.length);
    },
    deviceName: () => deviceName,
    uuid: () => deviceId,
    now: () => FIXED_NOW,
  });
}

function leafHash(payload: unknown): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalEnterpriseE2eeJson(payload))]))
    .digest('hex');
}

function nodeHash(left: string, right: string): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from([1]), Buffer.from(left, 'hex'), Buffer.from(right, 'hex')]))
    .digest('hex');
}

function merkleRoot(hashes: readonly string[]): string {
  if (hashes.length === 0) return createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  if (hashes.length === 1) return hashes[0]!;
  let split = 1;
  while (split * 2 < hashes.length) split *= 2;
  return nodeHash(merkleRoot(hashes.slice(0, split)), merkleRoot(hashes.slice(split)));
}

function publicKeyId(value: string): string {
  const key = createPublicKey({
    key: Buffer.from(value, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return createHash('sha256')
    .update(key.export({ format: 'der', type: 'spki' }))
    .digest('hex');
}

function registrationHash(input: EnterpriseE2eeDeviceRegistration): string {
  const { signature: _signature, bootstrap: _bootstrap, ...unsigned } = input;
  return createHash('sha256')
    .update(canonicalEnterpriseE2eeJson({
      purpose: 'otto-e2ee-device-registration',
      ...unsigned,
    }))
    .digest('hex');
}

type Device = EnterpriseE2eeDeviceDirectory['devices'][number];
type Proof = EnterpriseE2eeDeviceDirectory['proofs'][number];
type Leaf = EnterpriseE2eeDeviceDirectory['transparency']['leaves'][number];

class FakeTrustServer implements EnterpriseE2eeTrustClient {
  private root: EnterpriseE2eeDeviceDirectory['root'] | null = null;
  private devices: Device[] = [];
  private proofs: Proof[] = [];
  private leaves: Leaf[] = [];
  directoryOverride: EnterpriseE2eeDeviceDirectory | null | undefined;
  lastDeviceRegistration: EnterpriseE2eeDeviceRegistration | null = null;

  constructor(private readonly trustScope: EnterpriseE2eeScope) {}

  async getE2eeCapabilityStatus(): Promise<EnterpriseE2eeCapabilityStatus> {
    return CAPABILITY;
  }

  async registerE2eeAccountRoot(
    input: EnterpriseE2eeAccountRootRegistration,
  ): Promise<EnterpriseE2eeDeviceDirectory> {
    if (!this.root) {
      const sequence = this.append('account_root_registered', input);
      this.root = {
        ...input,
        rootKeyId: publicKeyId(input.rootSigningPublicKey),
        transparencySequence: sequence,
      };
    }
    return this.snapshot();
  }

  async registerE2eeDevice(
    input: EnterpriseE2eeDeviceRegistration,
  ): Promise<EnterpriseE2eeDeviceDirectory> {
    this.lastDeviceRegistration = structuredClone(input);
    const { bootstrap, ...stored } = input;
    const sequence = this.append('device_registered', stored);
    this.devices.push({
      ...stored,
      bootstrap: undefined,
      credentialHash: registrationHash(input),
      state: bootstrap ? 'approved' : 'pending',
      transparencySequence: sequence,
    });
    if (bootstrap) {
      const proofSequence = this.append('device_bootstrapped', bootstrap);
      this.proofs.push({
        proofId: createHash('sha256').update(canonicalEnterpriseE2eeJson(bootstrap)).digest('hex'),
        proof: bootstrap,
        transparencySequence: proofSequence,
      });
    }
    return this.snapshot();
  }

  async approveE2eeDevice(
    input: EnterpriseE2eeDeviceApprovalProof,
  ): Promise<EnterpriseE2eeDeviceDirectory> {
    const sequence = this.append('device_approved', input);
    this.proofs.push({
      proofId: createHash('sha256').update(canonicalEnterpriseE2eeJson(input)).digest('hex'),
      proof: input,
      transparencySequence: sequence,
    });
    this.devices = this.devices.map((device) =>
      device.deviceId === input.targetDeviceId ? { ...device, state: 'approved' } : device);
    return this.snapshot();
  }

  async revokeE2eeDevice(
    input: EnterpriseE2eeDeviceRevocationProof,
  ): Promise<EnterpriseE2eeDeviceDirectory> {
    const sequence = this.append('device_revoked', input);
    this.proofs.push({
      proofId: createHash('sha256').update(canonicalEnterpriseE2eeJson(input)).digest('hex'),
      proof: input,
      transparencySequence: sequence,
    });
    this.devices = this.devices.map((device) =>
      device.deviceId === input.targetDeviceId ? { ...device, state: 'revoked' } : device);
    return this.snapshot();
  }

  async getE2eeDeviceDirectory(): Promise<EnterpriseE2eeDeviceDirectory> {
    if (this.directoryOverride !== undefined) {
      if (this.directoryOverride === null) throw Object.assign(new Error('not found'), { status: 404 });
      return structuredClone(this.directoryOverride);
    }
    if (!this.root) throw Object.assign(new Error('not found'), { status: 404 });
    return this.snapshot();
  }

  snapshot(): EnterpriseE2eeDeviceDirectory {
    if (!this.root) throw new Error('root missing');
    const hashes = this.leaves.map((leaf) => leaf.leafHash);
    return structuredClone({
      protocolId: OTTO_E2EE_PROTOCOL_ID,
      trustVersion: OTTO_E2EE_TRUST_VERSION,
      organizationId: this.trustScope.organizationId,
      accountId: this.trustScope.accountId,
      root: this.root,
      devices: this.devices,
      proofs: this.proofs,
      transparency: {
        checkpoint: { size: hashes.length, rootHash: merkleRoot(hashes) },
        leaves: this.leaves,
      },
    });
  }

  private append(kind: Leaf['kind'], value: unknown): number {
    const payload = { kind, value };
    const sequence = this.leaves.length + 1;
    this.leaves.push({
      accountSequence: sequence,
      kind,
      payload,
      leafHash: leafHash(payload),
    });
    return sequence;
  }
}

function controller(
  client: EnterpriseE2eeTrustClient,
  store: EnterpriseE2eeDeviceTrustVault,
  trustScope: EnterpriseE2eeScope,
  noncePrefix: string,
  secureStorageAvailable = true,
): EnterpriseE2eeDeviceTrustController {
  let nonce = 0;
  return new EnterpriseE2eeDeviceTrustController({
    client,
    vault: store,
    identity: () => trustScope,
    secureStorageAvailable: () => secureStorageAvailable,
    secureStorageBackend: () => 'test-keystore',
    now: () => FIXED_NOW,
    nonce: () => Buffer.from(`${noncePrefix}-${++nonce}`.padEnd(24, '!')).toString('base64url'),
  });
}

describe('EnterpriseE2eeDeviceTrustVault', () => {
  it('encrypts private material at rest and isolates server/account scopes', () => {
    const directory = temporaryDirectory();
    const store = vault(directory, 'Workstation A', 'device-a');
    const first = store.ensureRoot(scope('account-a'));
    const second = store.loadOrCreate(scope('account-b'));

    expect(first.device.deviceId).toBe('device-a');
    expect(second.accountId).toBe('account-b');
    expect(first.root?.signing.privateKey).toBeTruthy();
    const files = fs.readdirSync(directory);
    expect(files).toHaveLength(2);
    const disk = files.map((file) => fs.readFileSync(path.join(directory, file), 'utf8')).join('\n');
    expect(disk).not.toContain(first.device.privateKey);
    expect(disk).not.toContain(first.root!.signing.privateKey);
    expect(disk).not.toContain('account-a');
  });
});

describe('EnterpriseE2eeDeviceTrustController', () => {
  it('does not create private keys when OS secure storage is unavailable', async () => {
    const directory = temporaryDirectory();
    const server = new FakeTrustServer(scope());
    const result = await controller(
      server,
      vault(directory, 'Unavailable', 'device-none'),
      scope(),
      'none',
      false,
    ).overview();

    expect(result.secureStorage.available).toBe(false);
    expect(result.localDevice).toBeNull();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('bootstraps one device, registers a second device, and approves it locally', async () => {
    const trustScope = scope();
    const server = new FakeTrustServer(trustScope);
    const first = controller(
      server,
      vault(temporaryDirectory(), 'Finance laptop', 'device-a'),
      trustScope,
      'first',
    );
    const second = controller(
      server,
      vault(temporaryDirectory(), 'Home desktop', 'device-b'),
      trustScope,
      'second',
    );
    const firstPackage = randomPackage('first');
    const secondPackage = randomPackage('second');

    const bootstrapped = await first.bootstrapWithMlsKeyPackage(firstPackage);
    expect(bootstrapped.localDevice?.registrationState).toBe('approved');
    expect(server.lastDeviceRegistration?.mlsKeyPackage).toBe(firstPackage);

    const pending = await second.registerWithMlsKeyPackage(secondPackage);
    expect(pending.localDevice?.registrationState).toBe('pending');
    expect(server.lastDeviceRegistration?.mlsKeyPackage).toBe(secondPackage);

    const verification = await first.verification('device-b');
    expect(verification.safetyNumber.split(' ')).toHaveLength(12);
    expect(verification.qrPayload).toMatch(/^otto-e2ee-verify:v2:/u);

    const approved = await first.approve('device-b');
    expect(approved.devices.find((device) => device.deviceId === 'device-b')?.state).toBe('approved');
    expect((await second.overview()).localDevice?.registrationState).toBe('approved');
    expect(approved.capability.enabled).toBe(false);
    verifyEnterpriseE2eeDirectory(server.snapshot(), undefined, FIXED_NOW.getTime());
  });

  it('rejects a transparency rollback after pinning a newer checkpoint', async () => {
    const trustScope = scope();
    const server = new FakeTrustServer(trustScope);
    const first = controller(
      server,
      vault(temporaryDirectory(), 'Finance laptop', 'device-a'),
      trustScope,
      'rollback',
    );
    await first.bootstrapWithMlsKeyPackage(randomPackage('rollback'));
    const full = server.snapshot();
    server.directoryOverride = {
      ...full,
      devices: [],
      proofs: [],
      transparency: {
        checkpoint: {
          size: 1,
          rootHash: full.transparency.leaves[0]!.leafHash,
        },
        leaves: full.transparency.leaves.slice(0, 1),
      },
    };

    await expect(first.overview()).rejects.toThrow('E2EE transparency rollback detected');
  });

  it('rejects duplicate transparency sequences instead of overwriting trust events', async () => {
    const trustScope = scope();
    const server = new FakeTrustServer(trustScope);
    const first = controller(
      server,
      vault(temporaryDirectory(), 'Finance laptop', 'device-a'),
      trustScope,
      'duplicate-sequence',
    );
    await first.bootstrapWithMlsKeyPackage(randomPackage('duplicate-sequence'));
    const tampered = server.snapshot();
    tampered.devices[0]!.transparencySequence = tampered.root.transparencySequence;

    expect(() => verifyEnterpriseE2eeDirectory(
      tampered,
      undefined,
      FIXED_NOW.getTime(),
    )).toThrow('E2EE transparency log contains a duplicate or invalid sequence');
  });
});

function randomPackage(label: string): string {
  return Buffer.from(`${label}:openmls-key-package`.padEnd(64, '#')).toString('base64url');
}
