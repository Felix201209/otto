import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadEnterpriseSigningPrivateKey,
  signEnterprisePackage,
} from '../sign-enterprise-package.mjs';
import { verifyEnterprisePackageSignature } from '../verify-enterprise-package-signature.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('enterprise package isolated signing', () => {
  it('creates a detached Ed25519 envelope accepted by the release verifier', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'otto-signing-'));
    temporaryDirectories.push(directory);
    const archivePath = path.join(directory, 'otto-enterprise.tar.gz');
    await writeFile(archivePath, Buffer.from('verified enterprise candidate'));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const publicKeyPem = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();

    const signed = await signEnterprisePackage({
      archivePath,
      privateKey: privateKeyPem,
    });
    const verified = await verifyEnterprisePackageSignature({
      archivePath,
      signaturePath: signed.signaturePath,
      trustedPublicKey: publicKeyPem,
    });

    expect(verified.ok).toBe(true);
    expect(
      JSON.parse(await readFile(signed.signaturePath, 'utf8')),
    ).not.toHaveProperty('publicKey');
  });

  it('fails closed when no signing key is provided', async () => {
    await expect(loadEnterpriseSigningPrivateKey({})).rejects.toThrow(
      'enterprise package signing key missing',
    );
  });
});
