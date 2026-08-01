/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export type KeyProviderKind =
  | 'aws-kms'
  | 'azure-key-vault'
  | 'google-cloud-kms'
  | 'hashicorp-vault'
  | 'pkcs11-hsm';

export type KeyProtectionPurpose =
  | 'database-dek'
  | 'backup-dek'
  | 'field-encryption-dek'
  | 'object-storage-sse-kek'
  | 'e2ee-identity-private'
  | 'e2ee-device-private'
  | 'e2ee-recovery-material';

export interface KeyProtectionContext {
  purpose: KeyProtectionPurpose;
  /** Opaque non-secret scope identifier used as authenticated context. */
  scopeId: string;
}

export interface WrappedKey {
  provider: KeyProviderKind;
  keyId: string;
  keyVersion: string;
  ciphertext: Buffer;
}

export interface KeyProviderHealth {
  healthy: true;
  kind: KeyProviderKind;
  keyId: string;
  keyVersion: string;
}

export interface KeyProvider {
  readonly kind: KeyProviderKind;
  readonly keyId: string;
  wrap(plaintext: Buffer, context: KeyProtectionContext): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey, context: KeyProtectionContext): Promise<Buffer>;
  rewrap(
    wrapped: WrappedKey,
    context: KeyProtectionContext,
  ): Promise<WrappedKey>;
  healthCheck(): Promise<KeyProviderHealth>;
  getKeyVersion(): Promise<string>;
}

/**
 * Narrow bridge implemented by an official cloud SDK, Vault transit client,
 * or PKCS#11 host. Provider credentials and sessions remain outside Otto.
 */
export interface KeyProviderTransport {
  readonly kind: KeyProviderKind;
  healthCheck(): Promise<boolean>;
  getKeyVersion(keyId: string): Promise<string>;
  wrap(
    plaintext: Buffer,
    input: { keyId: string; context: KeyProtectionContext },
  ): Promise<{ ciphertext: Buffer; keyVersion: string }>;
  unwrap(
    ciphertext: Buffer,
    input: {
      keyId: string;
      keyVersion: string;
      context: KeyProtectionContext;
    },
  ): Promise<Buffer>;
  rewrap(
    ciphertext: Buffer,
    input: {
      keyId: string;
      sourceKeyVersion: string;
      context: KeyProtectionContext;
    },
  ): Promise<{ ciphertext: Buffer; keyVersion: string }>;
}

function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\0\r\n]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function assertServerTrustDomain(context: KeyProtectionContext): void {
  assertIdentifier(context.scopeId, 'key protection scope');
  if (context.purpose.startsWith('e2ee-')) {
    throw new Error(
      'client E2EE private keys and recovery material belong to an independent trust domain and cannot use a server KeyProvider',
    );
  }
}

function assertDek(plaintext: Buffer): void {
  if (!Buffer.isBuffer(plaintext) || plaintext.length !== 32) {
    throw new Error('KeyProvider requires a 32-byte DEK');
  }
}

function assertWrappedResult(input: {
  ciphertext: Buffer;
  keyVersion: string;
}): void {
  if (!Buffer.isBuffer(input.ciphertext) || input.ciphertext.length === 0) {
    throw new Error('KeyProvider returned an empty wrapped key');
  }
  assertIdentifier(input.keyVersion, 'KeyProvider key version');
}

export function createUnifiedKeyProvider(input: {
  kind: KeyProviderKind;
  keyId: string;
  transport: KeyProviderTransport;
}): KeyProvider {
  const keyId = assertIdentifier(input.keyId, 'KeyProvider key id');
  if (input.transport.kind !== input.kind) {
    throw new Error('KeyProvider transport kind does not match configuration');
  }

  async function getKeyVersion(): Promise<string> {
    return assertIdentifier(
      await input.transport.getKeyVersion(keyId),
      'KeyProvider key version',
    );
  }

  function assertEnvelope(wrapped: WrappedKey): void {
    if (wrapped.provider !== input.kind || wrapped.keyId !== keyId) {
      throw new Error('wrapped key belongs to a different KeyProvider');
    }
    assertWrappedResult(wrapped);
  }

  return {
    kind: input.kind,
    keyId,
    getKeyVersion,
    async healthCheck() {
      if (!(await input.transport.healthCheck())) {
        throw new Error(`${input.kind} KeyProvider is unavailable`);
      }
      return {
        healthy: true,
        kind: input.kind,
        keyId,
        keyVersion: await getKeyVersion(),
      };
    },
    async wrap(plaintext, context) {
      assertServerTrustDomain(context);
      assertDek(plaintext);
      const result = await input.transport.wrap(plaintext, { keyId, context });
      assertWrappedResult(result);
      return {
        provider: input.kind,
        keyId,
        keyVersion: result.keyVersion,
        ciphertext: Buffer.from(result.ciphertext),
      };
    },
    async unwrap(wrapped, context) {
      assertServerTrustDomain(context);
      assertEnvelope(wrapped);
      const plaintext = await input.transport.unwrap(wrapped.ciphertext, {
        keyId,
        keyVersion: wrapped.keyVersion,
        context,
      });
      try {
        assertDek(plaintext);
        return Buffer.from(plaintext);
      } finally {
        plaintext.fill(0);
      }
    },
    async rewrap(wrapped, context) {
      assertServerTrustDomain(context);
      assertEnvelope(wrapped);
      const result = await input.transport.rewrap(wrapped.ciphertext, {
        keyId,
        sourceKeyVersion: wrapped.keyVersion,
        context,
      });
      assertWrappedResult(result);
      return {
        provider: input.kind,
        keyId,
        keyVersion: result.keyVersion,
        ciphertext: Buffer.from(result.ciphertext),
      };
    },
  };
}

type ProviderFactoryInput = {
  keyId: string;
  transport: KeyProviderTransport;
};

function providerFactory(kind: KeyProviderKind, input: ProviderFactoryInput) {
  return createUnifiedKeyProvider({ kind, ...input });
}

export const createAwsKmsKeyProvider = (input: ProviderFactoryInput) =>
  providerFactory('aws-kms', input);
export const createAzureKeyVaultKeyProvider = (input: ProviderFactoryInput) =>
  providerFactory('azure-key-vault', input);
export const createGoogleCloudKmsKeyProvider = (input: ProviderFactoryInput) =>
  providerFactory('google-cloud-kms', input);
export const createHashicorpVaultKeyProvider = (input: ProviderFactoryInput) =>
  providerFactory('hashicorp-vault', input);
export const createPkcs11HsmKeyProvider = (input: ProviderFactoryInput) =>
  providerFactory('pkcs11-hsm', input);
