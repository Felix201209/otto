import { createPublicKey, verify } from 'node:crypto';
import type { CustomerModuleManifestV1 } from './customerModuleManifest.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalCustomerModuleManifest(
  manifest: Omit<CustomerModuleManifestV1, 'signature'> | CustomerModuleManifestV1,
): string {
  const { signature: _signature, ...unsigned } = manifest as CustomerModuleManifestV1;
  return canonical(unsigned);
}

export function verifyCustomerModuleSignature(
  manifest: CustomerModuleManifestV1,
  publicKeys: Readonly<Record<string, string>>,
): boolean {
  const signature = manifest.signature;
  if (!signature || signature.algorithm !== 'ed25519' || !signature.value.startsWith('ed25519:')) return false;
  const publicKey = publicKeys[signature.keyId];
  if (!publicKey) return false;
  try {
    return verify(
      null,
      Buffer.from(canonicalCustomerModuleManifest(manifest)),
      createPublicKey(publicKey),
      Buffer.from(signature.value.slice('ed25519:'.length), 'base64url'),
    );
  } catch {
    return false;
  }
}
