#!/usr/bin/env node

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function normalizePublicKey(value) {
  const trimmed = value.trim().replace(/\\n/g, '\n');
  if (!trimmed) throw new Error('trusted public key is empty');
  if (trimmed.includes('BEGIN PUBLIC KEY')) return createPublicKey(trimmed);
  return createPublicKey({
    key: Buffer.from(trimmed, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function verifyEnterprisePackageSignature(input) {
  const archivePath = path.resolve(input.archivePath);
  const signaturePath = path.resolve(input.signaturePath);
  const archive = await readFile(archivePath);
  const envelope = JSON.parse(await readFile(signaturePath, 'utf8'));
  if (
    envelope?.format !== 'otto-enterprise-package-signature-v1' ||
    envelope.algorithm !== 'Ed25519' ||
    envelope.file !== path.basename(archivePath) ||
    !/^[0-9a-f]{64}$/.test(envelope.sha256 || '') ||
    !/^[0-9a-f]{16}$/.test(envelope.keyId || '') ||
    typeof envelope.signature !== 'string'
  ) {
    throw new Error('enterprise package signature envelope is invalid');
  }
  if ('publicKey' in envelope) {
    throw new Error('signature envelope must not choose its own trust key');
  }
  const publicKey = normalizePublicKey(input.trustedPublicKey);
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = sha256(publicKeyDer).slice(0, 16);
  if (envelope.keyId !== keyId) {
    throw new Error(
      `enterprise package signing key mismatch: ${envelope.keyId}`,
    );
  }
  const archiveSha256 = sha256(archive);
  if (envelope.sha256 !== archiveSha256) {
    throw new Error('enterprise package SHA-256 mismatch');
  }
  const signature = Buffer.from(envelope.signature, 'base64url');
  if (signature.length !== 64 || !verify(null, archive, publicKey, signature)) {
    throw new Error('enterprise package Ed25519 signature is invalid');
  }
  return {
    ok: true,
    file: envelope.file,
    sha256: archiveSha256,
    keyId,
  };
}

async function main() {
  const [archivePath, signaturePath, publicKeyFile] = process.argv.slice(2);
  if (!archivePath || !signaturePath) {
    throw new Error(
      'usage: verify-enterprise-package-signature.mjs <archive> <signature> [trusted-public-key-file]',
    );
  }
  const trustedPublicKey = publicKeyFile
    ? await readFile(path.resolve(publicKeyFile), 'utf8')
    : process.env.OTTO_ENTERPRISE_SIGNING_PUBLIC_KEY?.replace(/\\n/g, '\n');
  if (!trustedPublicKey) {
    throw new Error(
      'trusted public key missing; pass a file or set OTTO_ENTERPRISE_SIGNING_PUBLIC_KEY',
    );
  }
  const result = await verifyEnterprisePackageSignature({
    archivePath,
    signaturePath,
    trustedPublicKey,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isEntryPoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`[enterprise-signature] ${error.message}\n`);
    process.exitCode = 3;
  });
}
