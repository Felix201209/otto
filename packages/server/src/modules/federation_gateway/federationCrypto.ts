/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalJson,
  ED25519_SIGNATURE_PREFIX,
} from '../commercial_control/signedEnvelope.js';

export interface FederationPayloadSigner {
  keyId: string;
  publicKeyPem: string;
  sign(payload: unknown): Promise<string>;
}

function normalizePrivateKey(value: string): KeyObject {
  const normalized = value.trim().replace(/\\n/gu, '\n');
  const key = normalized.includes('BEGIN PRIVATE KEY')
    ? createPrivateKey(normalized)
    : createPrivateKey({
        key: Buffer.from(normalized, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('federation signing key must be Ed25519');
  }
  return key;
}

export function federationPublicKeyId(publicKey: KeyObject | string): string {
  const key = typeof publicKey === 'string'
    ? createPublicKey(publicKey.trim().replace(/\\n/gu, '\n'))
    : publicKey;
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('federation verification key must be Ed25519');
  }
  const der = key.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export class LocalFederationSigner implements FederationPayloadSigner {
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly #privateKey: KeyObject;

  constructor(privateKey: string) {
    this.#privateKey = normalizePrivateKey(privateKey);
    const publicKey = createPublicKey(this.#privateKey);
    this.keyId = federationPublicKeyId(publicKey);
    this.publicKeyPem = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
  }

  async sign(payload: unknown): Promise<string> {
    const signature = sign(
      null,
      Buffer.from(canonicalJson(payload)),
      this.#privateKey,
    );
    return `${ED25519_SIGNATURE_PREFIX}${signature.toString('base64url')}`;
  }
}

function ensurePrivateDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(filePath), 0o700);
  } catch {
    // Some managed filesystems do not implement POSIX modes.
  }
}

export function loadOrCreateFederationSigner(input: {
  keyPath: string;
  createIfMissing: boolean;
}): LocalFederationSigner {
  if (!fs.existsSync(input.keyPath)) {
    if (!input.createIfMissing) {
      throw new Error('federation signing key file does not exist');
    }
    ensurePrivateDirectory(input.keyPath);
    const { privateKey } = generateKeyPairSync('ed25519');
    fs.writeFileSync(
      input.keyPath,
      privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    try {
      fs.chmodSync(input.keyPath, 0o600);
    } catch {
      // Creation mode remains the primary protection on Windows-compatible FS.
    }
  }
  const keyStats = fs.lstatSync(input.keyPath);
  if (!keyStats.isFile() || keyStats.isSymbolicLink()) {
    throw new Error('federation signing key must be a regular non-symlink file');
  }
  if (keyStats.size < 32 || keyStats.size > 64 * 1024) {
    throw new Error('federation signing key file size is invalid');
  }
  return new LocalFederationSigner(fs.readFileSync(input.keyPath, 'utf8'));
}

export function verifyFederationEnvelopeSignature(input: {
  payload: unknown;
  signature: string;
  publicKeyPem: string;
}): void {
  if (!input.signature.startsWith(ED25519_SIGNATURE_PREFIX)) {
    throw new Error('federation signature must use Ed25519');
  }
  const signature = Buffer.from(
    input.signature.slice(ED25519_SIGNATURE_PREFIX.length),
    'base64url',
  );
  const publicKey = createPublicKey(input.publicKeyPem);
  if (
    publicKey.asymmetricKeyType !== 'ed25519' ||
    signature.length !== 64 ||
    !verify(
      null,
      Buffer.from(canonicalJson(input.payload)),
      publicKey,
      signature,
    )
  ) {
    throw new Error('federation signature is invalid');
  }
}
