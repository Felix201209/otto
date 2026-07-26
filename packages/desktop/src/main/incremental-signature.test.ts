/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyIncrementalArtifactSignature } from './incremental-signature.js';

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

async function writeArtifact(body: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-signature-'));
  const file = path.join(dir, 'artifact.bundle.json');
  await fs.writeFile(file, body);
  return file;
}

describe('incremental artifact signature verification', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts Ed25519 signatures with an inline PEM public key', async () => {
    const keys = generateKeyPairSync('ed25519');
    const body = 'trusted component bundle';
    const filePath = await writeArtifact(body);
    const signature = `ed25519:${base64url(sign(null, Buffer.from(body), keys.privateKey))}`;
    const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();

    await expect(verifyIncrementalArtifactSignature({ filePath, signature, publicKey })).resolves.toEqual({ ok: true });
  });

  it('loads public key from environment and rejects tampered artifacts', async () => {
    const keys = generateKeyPairSync('ed25519');
    const original = 'original component bundle';
    const filePath = await writeArtifact('tampered component bundle');
    const signature = `ed25519:${base64url(sign(null, Buffer.from(original), keys.privateKey))}`;
    vi.stubEnv('OTTO_INCREMENTAL_UPDATE_PUBLIC_KEY', keys.publicKey.export({ format: 'pem', type: 'spki' }).toString());

    await expect(verifyIncrementalArtifactSignature({ filePath, signature })).resolves.toEqual({
      ok: false,
      error: 'artifact Ed25519 signature verification failed',
    });
  });

  it('fails closed when no public key is configured', async () => {
    const keys = generateKeyPairSync('ed25519');
    const body = 'trusted component bundle';
    const filePath = await writeArtifact(body);
    const signature = `ed25519:${base64url(sign(null, Buffer.from(body), keys.privateKey))}`;

    await expect(verifyIncrementalArtifactSignature({ filePath, signature })).resolves.toEqual({
      ok: false,
      error: 'missing OTTO_INCREMENTAL_UPDATE_PUBLIC_KEY or OTTO_INCREMENTAL_UPDATE_PUBLIC_KEY_FILE',
    });
  });

  it('rejects non-canonical signature formats', async () => {
    const filePath = await writeArtifact('body');
    await expect(verifyIncrementalArtifactSignature({
      filePath,
      signature: 'ed25519:example',
      publicKey: 'not-a-key',
    })).resolves.toEqual({
      ok: false,
      error: 'artifact signature must be a 64-byte Ed25519 base64url value',
    });
  });
});
