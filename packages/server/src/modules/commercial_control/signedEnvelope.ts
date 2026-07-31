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
  expectedKeyId?: string | null,
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
      const keyId = publicKeyId(publicKey);
      if (expectedKeyId && keyId !== expectedKeyId) continue;
      if (verify(null, message, key, signatureBytes)) {
        return { valid: true, keyId };
      }
    } catch {
      // A malformed rotated key must not prevent trying the remaining keys.
    }
  }
  return { valid: false, keyId: null };
}

interface PublicKeyringEntry {
  keyId?: unknown;
  publicKeyPem?: unknown;
  state?: unknown;
}

function revokedKeyIds(raw: string | undefined): Set<string> {
  const value = raw?.trim();
  if (!value) return new Set();
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter(
        (item): item is string => typeof item === 'string' && /^[a-f0-9]{16}$/u.test(item),
      ));
    }
  } catch {
    // Fall through to the comma-delimited operational form.
  }
  return new Set(value.split(',').map((item) => item.trim()).filter(
    (item) => /^[a-f0-9]{16}$/u.test(item),
  ));
}

function keyringEntries(value: unknown): PublicKeyringEntry[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const keyring = object.keyring && typeof object.keyring === 'object'
    ? object.keyring as Record<string, unknown>
    : object;
  return Array.isArray(keyring.keys) ? keyring.keys as PublicKeyringEntry[] : null;
}

export function parsePublicKeyList(
  raw: string | undefined,
  revokedRaw?: string,
): string[] {
  const value = raw?.trim();
  if (!value) return [];
  const explicitlyRevoked = revokedKeyIds(revokedRaw);
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        const strings = parsed.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0,
        );
        if (strings.length === parsed.length) {
          return strings.filter((key) => {
            try {
              return !explicitlyRevoked.has(publicKeyId(key));
            } catch {
              return false;
            }
          });
        }
      }
    } catch {
      return [];
    }
  }
  if (value.startsWith('{')) {
    try {
      const entries = keyringEntries(JSON.parse(value));
      if (!entries) return [];
      return entries.flatMap((entry) => {
        if (
          typeof entry.publicKeyPem !== 'string' ||
          (entry.state !== 'active' && entry.state !== 'standby' && entry.state !== 'retired')
        ) return [];
        try {
          const computedKeyId = publicKeyId(entry.publicKeyPem);
          if (
            (typeof entry.keyId === 'string' && entry.keyId !== computedKeyId) ||
            explicitlyRevoked.has(computedKeyId)
          ) return [];
          return [entry.publicKeyPem];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }
  try {
    return explicitlyRevoked.has(publicKeyId(value)) ? [] : [value];
  } catch {
    return [];
  }
}
