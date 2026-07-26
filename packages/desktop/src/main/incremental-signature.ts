/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { createPublicKey, verify } from 'node:crypto';
import * as fs from 'node:fs';

const SIGNATURE_PREFIX = 'ed25519:';
const PUBLIC_KEY_ENV = 'OTTO_INCREMENTAL_UPDATE_PUBLIC_KEY';
const PUBLIC_KEY_FILE_ENV = 'OTTO_INCREMENTAL_UPDATE_PUBLIC_KEY_FILE';

export type SignatureVerificationResult =
  | { ok: true }
  | { ok: false; error: string };

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
}

function parseSignature(signature: string): Buffer | string {
  if (!signature.startsWith(SIGNATURE_PREFIX)) {
    return 'artifact signature must use ed25519:<base64url> format';
  }
  const encoded = signature.slice(SIGNATURE_PREFIX.length).trim();
  const decoded = decodeBase64Url(encoded);
  if (!decoded || decoded.byteLength !== 64) {
    return 'artifact signature must be a 64-byte Ed25519 base64url value';
  }
  return decoded;
}

function publicKeyFromString(raw: string): ReturnType<typeof createPublicKey> | string {
  const value = raw.trim();
  if (!value) return 'incremental update public key is empty';
  try {
    if (value.includes('-----BEGIN PUBLIC KEY-----')) {
      return createPublicKey(value);
    }
    const decoded = decodeBase64Url(value) ?? Buffer.from(value, 'base64');
    return createPublicKey({ key: decoded, format: 'der', type: 'spki' });
  } catch (error) {
    return `invalid incremental update public key: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function loadIncrementalUpdatePublicKey(): ReturnType<typeof createPublicKey> | string {
  const inline = process.env[PUBLIC_KEY_ENV]?.trim();
  if (inline) return publicKeyFromString(inline);
  const file = process.env[PUBLIC_KEY_FILE_ENV]?.trim();
  if (file) {
    try {
      return publicKeyFromString(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      return `failed to read incremental update public key file: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return `missing ${PUBLIC_KEY_ENV} or ${PUBLIC_KEY_FILE_ENV}`;
}

export async function verifyIncrementalArtifactSignature(params: {
  filePath: string;
  signature: string;
  publicKey?: ReturnType<typeof createPublicKey> | string;
}): Promise<SignatureVerificationResult> {
  const signature = parseSignature(params.signature);
  if (typeof signature === 'string') return { ok: false, error: signature };

  const key = params.publicKey
    ? (typeof params.publicKey === 'string' ? publicKeyFromString(params.publicKey) : params.publicKey)
    : loadIncrementalUpdatePublicKey();
  if (typeof key === 'string') return { ok: false, error: key };

  let body: Buffer;
  try {
    body = await fs.promises.readFile(params.filePath);
  } catch (error) {
    return { ok: false, error: `failed to read artifact for signature verification: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    if (!verify(null, body, key, signature)) {
      return { ok: false, error: 'artifact Ed25519 signature verification failed' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `artifact signature verification failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
