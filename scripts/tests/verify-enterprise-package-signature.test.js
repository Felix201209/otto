import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { verifyEnterprisePackageSignature } from '../verify-enterprise-package-signature.mjs';

describe('enterprise package signature verifier', () => {
  it('accepts only a signature made by the separately trusted public key', async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), 'otto-enterprise-signature-'),
    );
    const archivePath = path.join(dir, 'otto-enterprise.tar.gz');
    const signaturePath = `${archivePath}.sig`;
    const archive = Buffer.from('verified enterprise package');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
    await writeFile(archivePath, archive);
    await writeFile(
      signaturePath,
      JSON.stringify({
        format: 'otto-enterprise-package-signature-v1',
        algorithm: 'Ed25519',
        file: path.basename(archivePath),
        sha256: createHash('sha256').update(archive).digest('hex'),
        keyId: createHash('sha256')
          .update(publicKeyDer)
          .digest('hex')
          .slice(0, 16),
        signature: sign(null, archive, privateKey).toString('base64url'),
      }),
    );

    await expect(
      verifyEnterprisePackageSignature({
        archivePath,
        signaturePath,
        trustedPublicKey: publicKeyPem,
      }),
    ).resolves.toMatchObject({ ok: true, file: path.basename(archivePath) });
  });

  it('rejects tampering and a signature envelope that supplies its own key', async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), 'otto-enterprise-signature-'),
    );
    const archivePath = path.join(dir, 'otto-enterprise.tar.gz');
    const signaturePath = `${archivePath}.sig`;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const original = Buffer.from('original');
    const publicKeyPem = publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
    const envelope = {
      format: 'otto-enterprise-package-signature-v1',
      algorithm: 'Ed25519',
      file: path.basename(archivePath),
      sha256: createHash('sha256').update(original).digest('hex'),
      keyId: createHash('sha256')
        .update(publicKeyDer)
        .digest('hex')
        .slice(0, 16),
      signature: sign(null, original, privateKey).toString('base64url'),
    };
    await writeFile(archivePath, Buffer.from('tampered'));
    await writeFile(signaturePath, JSON.stringify(envelope));
    await expect(
      verifyEnterprisePackageSignature({
        archivePath,
        signaturePath,
        trustedPublicKey: publicKeyPem,
      }),
    ).rejects.toThrow('SHA-256 mismatch');

    await writeFile(archivePath, original);
    await writeFile(
      signaturePath,
      JSON.stringify({ ...envelope, publicKey: publicKeyPem }),
    );
    await expect(
      verifyEnterprisePackageSignature({
        archivePath,
        signaturePath,
        trustedPublicKey: publicKeyPem,
      }),
    ).rejects.toThrow('must not choose its own trust key');
  });
});
