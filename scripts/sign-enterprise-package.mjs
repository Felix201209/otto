#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePrivateKey(value) {
  const key = createPrivateKey(value.trim().replace(/\\n/g, '\n'));
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('enterprise package signing requires an Ed25519 key');
  }
  return key;
}

export async function loadEnterpriseSigningPrivateKey(
  environment = process.env,
) {
  if (environment.OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY_FILE) {
    return readFile(
      path.resolve(environment.OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY_FILE),
      'utf8',
    );
  }
  const inline = environment.OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY;
  if (!inline?.trim()) {
    throw new Error(
      'enterprise package signing key missing; use an isolated signing environment or KMS/HSM signer',
    );
  }
  return inline;
}

export async function signEnterprisePackage(input) {
  const archivePath = path.resolve(input.archivePath);
  const signaturePath = path.resolve(
    input.signaturePath || `${archivePath}.sig`,
  );
  if (existsSync(signaturePath) && !input.allowOverwrite) {
    throw new Error(
      `signature already exists, refusing overwrite: ${signaturePath}`,
    );
  }
  const archive = await readFile(archivePath);
  const privateKey = normalizePrivateKey(input.privateKey);
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const envelope = {
    format: 'otto-enterprise-package-signature-v1',
    algorithm: 'Ed25519',
    file: path.basename(archivePath),
    sha256: sha256(archive),
    keyId: sha256(publicKeyDer).slice(0, 16),
    signature: sign(null, archive, privateKey).toString('base64url'),
  };
  await writeFile(signaturePath, `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o644,
  });
  return { signaturePath, envelope, publicKey };
}

async function main() {
  const [archivePath] = process.argv.slice(2);
  if (!archivePath) {
    throw new Error('usage: sign-enterprise-package.mjs <archive>');
  }
  const privateKey = await loadEnterpriseSigningPrivateKey();
  const result = await signEnterprisePackage({ archivePath, privateKey });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      signaturePath: result.signaturePath,
      sha256: result.envelope.sha256,
      keyId: result.envelope.keyId,
      publicKey: result.publicKey
        .export({ format: 'pem', type: 'spki' })
        .toString(),
    })}\n`,
  );
}

const isEntryPoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`[enterprise-signing] ${error.message}\n`);
    process.exitCode = 3;
  });
}
