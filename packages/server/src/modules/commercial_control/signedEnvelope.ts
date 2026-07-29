/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

export const ED25519_SIGNATURE_PREFIX = 'ed25519:';

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

/** Stable JSON bytes are the signed contract shared by issuer and server. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function normalizePublicKey(value: string): KeyObject {
  const trimmed = value.trim().replace(/\\n/g, '\n');
  if (trimmed.includes('BEGIN PUBLIC KEY')) return createPublicKey(trimmed);
  return createPublicKey({
    key: Buffer.from(trimmed, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function normalizePrivateKey(value: string): KeyObject {
  const trimmed = value.trim().replace(/\\n/g, '\n');
  if (trimmed.includes('BEGIN PRIVATE KEY')) return createPrivateKey(trimmed);
  return createPrivateKey({
    key: Buffer.from(trimmed, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

export function publicKeyId(publicKey: string): string {
  const key = normalizePublicKey(publicKey);
  const der = key.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function signEd25519Envelope(
  payload: unknown,
  privateKey: string,
): string {
  const signature = sign(
    null,
    Buffer.from(canonicalJson(payload)),
    normalizePrivateKey(privateKey),
  );
  return `${ED25519_SIGNATURE_PREFIX}${signature.toString('base64url')}`;
}

export function verifyEd25519Envelope(
  payload: unknown,
  signature: string,
  publicKeys: readonly string[],
): { valid: boolean; keyId: string | null } {
  if (!signature.startsWith(ED25519_SIGNATURE_PREFIX)) {
    return { valid: false, keyId: null };
  }
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(
      signature.slice(ED25519_SIGNATURE_PREFIX.length),
      'base64url',
    );
  } catch {
    return { valid: false, keyId: null };
  }
  if (signatureBytes.length !== 64) return { valid: false, keyId: null };
  const message = Buffer.from(canonicalJson(payload));
  for (const publicKey of publicKeys) {
    try {
      const key = normalizePublicKey(publicKey);
      if (verify(null, message, key, signatureBytes)) {
        return { valid: true, keyId: publicKeyId(publicKey) };
      }
    } catch {
      // A malformed rotated key must not prevent trying the remaining keys.
    }
  }
  return { valid: false, keyId: null };
}

export function parsePublicKeyList(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0,
        );
      }
    } catch {
      return [];
    }
  }
  return [value];
}
