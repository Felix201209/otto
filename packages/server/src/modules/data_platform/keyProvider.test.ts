/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createAwsKmsKeyProvider,
  createAzureKeyVaultKeyProvider,
  createGoogleCloudKmsKeyProvider,
  createHashicorpVaultKeyProvider,
  createPkcs11HsmKeyProvider,
  type KeyProviderKind,
  type KeyProviderTransport,
} from './keyProvider.js';

function createTransport(kind: KeyProviderKind): KeyProviderTransport & {
  version: string;
} {
  return {
    kind,
    version: 'kek-v1',
    healthCheck: vi.fn(async () => true),
    getKeyVersion: vi.fn(async function (this: { version: string }) {
      return this.version;
    }),
    wrap: vi.fn(async function (this: { version: string }, plaintext: Buffer) {
      return {
        ciphertext: Buffer.from(plaintext.map((value) => value ^ 0xa5)),
        keyVersion: this.version,
      };
    }),
    unwrap: vi.fn(async (ciphertext: Buffer) =>
      Buffer.from(ciphertext.map((value) => value ^ 0xa5)),
    ),
    rewrap: vi.fn(async function (
      this: { version: string },
      ciphertext: Buffer,
    ) {
      return { ciphertext: Buffer.from(ciphertext), keyVersion: this.version };
    }),
  };
}

const factories = [
  ['aws-kms', createAwsKmsKeyProvider],
  ['azure-key-vault', createAzureKeyVaultKeyProvider],
  ['google-cloud-kms', createGoogleCloudKmsKeyProvider],
  ['hashicorp-vault', createHashicorpVaultKeyProvider],
  ['pkcs11-hsm', createPkcs11HsmKeyProvider],
] as const;

describe('unified key provider', () => {
  it.each(factories)(
    'adapts %s without exposing a plaintext key in metadata',
    async (kind, factory) => {
      const transport = createTransport(kind);
      const provider = factory({ keyId: `${kind}-database-kek`, transport });
      const plaintext = Buffer.alloc(32, 7);
      const context = { purpose: 'database-dek' as const, scopeId: 'db-01' };

      await expect(provider.healthCheck()).resolves.toEqual({
        healthy: true,
        kind,
        keyId: `${kind}-database-kek`,
        keyVersion: 'kek-v1',
      });
      const wrapped = await provider.wrap(plaintext, context);
      expect(wrapped).toMatchObject({
        provider: kind,
        keyId: `${kind}-database-kek`,
        keyVersion: 'kek-v1',
      });
      expect(JSON.stringify(wrapped)).not.toContain(
        plaintext.toString('base64'),
      );
      await expect(provider.unwrap(wrapped, context)).resolves.toEqual(
        plaintext,
      );

      transport.version = 'kek-v2';
      await expect(provider.rewrap(wrapped, context)).resolves.toMatchObject({
        keyVersion: 'kek-v2',
      });
    },
  );

  it('rejects client E2EE private-key purposes before calling a server KMS', async () => {
    const transport = createTransport('aws-kms');
    const provider = createAwsKmsKeyProvider({
      keyId: 'server-kek',
      transport,
    });

    await expect(
      provider.wrap(Buffer.alloc(32), {
        purpose: 'e2ee-identity-private',
        scopeId: 'device-01',
      }),
    ).rejects.toThrow(/client E2EE.*independent trust domain/i);
    expect(transport.wrap).not.toHaveBeenCalled();
  });

  it('fails closed when health or unwrapped key validation fails', async () => {
    const unhealthy = createTransport('hashicorp-vault');
    unhealthy.healthCheck = vi.fn(async () => false);
    const unavailable = createHashicorpVaultKeyProvider({
      keyId: 'vault-kek',
      transport: unhealthy,
    });
    await expect(unavailable.healthCheck()).rejects.toThrow(/unavailable/i);

    const invalid = createTransport('pkcs11-hsm');
    invalid.unwrap = vi.fn(async () => Buffer.alloc(8));
    const provider = createPkcs11HsmKeyProvider({
      keyId: 'hsm-kek',
      transport: invalid,
    });
    await expect(
      provider.unwrap(
        {
          provider: 'pkcs11-hsm',
          keyId: 'hsm-kek',
          keyVersion: '1',
          ciphertext: Buffer.alloc(48),
        },
        { purpose: 'database-dek', scopeId: 'db-01' },
      ),
    ).rejects.toThrow(/32-byte DEK/i);
  });
});
