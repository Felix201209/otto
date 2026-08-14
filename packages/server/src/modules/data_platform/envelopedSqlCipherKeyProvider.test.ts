/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAwsKmsKeyProvider,
  type KeyProviderTransport,
} from './keyProvider.js';
import {
  createFileEnvelopeManifestStore,
  initializeEnvelopedSqlCipherKeyProvider,
} from './envelopedSqlCipherKeyProvider.js';

const temporaryDirectories: string[] = [];

function createHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-envelope-'));
  temporaryDirectories.push(directory);
  const manifestPath = path.join(directory, 'database.envelope.json');
  const transport: KeyProviderTransport & { version: string } = {
    kind: 'aws-kms',
    version: 'kek-v1',
    healthCheck: vi.fn(async () => true),
    getKeyVersion: vi.fn(async function (this: { version: string }) {
      return this.version;
    }),
    wrap: vi.fn(async function (this: { version: string }, plaintext: Buffer) {
      return {
        ciphertext: Buffer.from(plaintext.map((value) => value ^ 0x5a)),
        keyVersion: this.version,
      };
    }),
    unwrap: vi.fn(async (ciphertext: Buffer) =>
      Buffer.from(ciphertext.map((value) => value ^ 0x5a)),
    ),
    rewrap: vi.fn(async function (
      this: { version: string },
      ciphertext: Buffer,
    ) {
      return { ciphertext: Buffer.from(ciphertext), keyVersion: this.version };
    }),
  };
  return {
    manifestPath,
    transport,
    kms: createAwsKmsKeyProvider({ keyId: 'database-kek', transport }),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('enveloped SQLCipher key provider', () => {
  it('persists only wrapped DEKs and unwraps once during fail-closed startup', async () => {
    const harness = createHarness();
    const manifestStore = createFileEnvelopeManifestStore(harness.manifestPath);
    const provider = await initializeEnvelopedSqlCipherKeyProvider({
      databaseId: 'desktop-cache',
      keyProvider: harness.kms,
      manifestStore,
      createIfMissing: true,
    });
    const active = Buffer.from(provider.getKeyCandidates()[0]!.key);
    const persisted = fs.readFileSync(harness.manifestPath, 'utf8');

    expect(persisted).not.toContain(active.toString('base64'));
    expect(persisted).not.toContain('keyBase64');
    expect(harness.transport.unwrap).not.toHaveBeenCalled();
    provider.clear();

    const reopened = await initializeEnvelopedSqlCipherKeyProvider({
      databaseId: 'desktop-cache',
      keyProvider: harness.kms,
      manifestStore,
      createIfMissing: false,
    });
    expect(reopened.getKeyCandidates()[0]!.key).toEqual(active);
    expect(harness.transport.unwrap).toHaveBeenCalledTimes(1);
  });

  it('stages DEK rotation before the synchronous SQLCipher rekey transaction', async () => {
    const harness = createHarness();
    const provider = await initializeEnvelopedSqlCipherKeyProvider({
      databaseId: 'desktop-cache',
      keyProvider: harness.kms,
      manifestStore: createFileEnvelopeManifestStore(harness.manifestPath),
      createIfMissing: true,
    });

    const staged = await provider.prepareDekRotation();
    expect(provider.beginRotation()).toEqual(staged);
    provider.commitRotation(staged);

    expect(provider.getKeyCandidates().map((item) => item.version)).toEqual([
      2, 1,
    ]);
    expect(provider.getEnvelopeStatus()).toMatchObject({
      activeDekVersion: 2,
      pendingDekVersion: null,
      kekVersion: 'kek-v1',
    });
  });

  it('rewraps the DEK under a new KEK without changing the database key', async () => {
    const harness = createHarness();
    const provider = await initializeEnvelopedSqlCipherKeyProvider({
      databaseId: 'desktop-cache',
      keyProvider: harness.kms,
      manifestStore: createFileEnvelopeManifestStore(harness.manifestPath),
      createIfMissing: true,
    });
    const before = Buffer.from(provider.getKeyCandidates()[0]!.key);
    harness.transport.version = 'kek-v2';

    const prepared = await provider.prepareKekRotation();
    expect(provider.getEnvelopeStatus().kekVersion).toBe('kek-v1');
    provider.activateKekRotation(prepared.rotationId);

    expect(prepared).toMatchObject({
      previousKekVersions: ['kek-v1'],
      activeKekVersion: 'kek-v2',
      dekVersions: [1],
    });
    expect(provider.getKeyCandidates()[0]!.key).toEqual(before);
    expect(provider.getEnvelopeStatus().kekVersion).toBe('kek-v2');
  });

  it('refuses startup when KMS health validation fails', async () => {
    const harness = createHarness();
    harness.transport.healthCheck = vi.fn(async () => false);

    await expect(
      initializeEnvelopedSqlCipherKeyProvider({
        databaseId: 'desktop-cache',
        keyProvider: harness.kms,
        manifestStore: createFileEnvelopeManifestStore(harness.manifestPath),
        createIfMissing: true,
      }),
    ).rejects.toThrow(/unavailable/i);
    expect(fs.existsSync(harness.manifestPath)).toBe(false);
  });
});
