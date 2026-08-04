/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import BetterSqlite3 from 'better-sqlite3';

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? null : process.argv[index + 1]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function rawKey(key) {
  return `"x'${key.toString('hex')}'"`;
}

export function probePackagedSqlCipher(bindingPath) {
  const resolvedBinding = path.resolve(bindingPath);
  const assetDirectory = path.dirname(resolvedBinding);
  const manifestPath = path.join(assetDirectory, 'manifest.json');
  if (!fs.existsSync(resolvedBinding) || !fs.existsSync(manifestPath)) {
    throw new Error('packaged SQLCipher binding or manifest is missing');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bindingSha256 = createHash('sha256')
    .update(fs.readFileSync(resolvedBinding))
    .digest('hex');
  if (
    manifest.format !== 3 ||
    manifest.target !== `${process.platform}-${process.arch}` ||
    manifest.runtimeVersion !== process.versions.electron ||
    manifest.toolchain?.electronModuleAbi !== process.versions.modules ||
    (process.env.GITHUB_SHA && manifest.buildCommit !== process.env.GITHUB_SHA) ||
    (process.env.SQLCIPHER_SOURCE_REVISION &&
      manifest.sourceRevision !== process.env.SQLCIPHER_SOURCE_REVISION) ||
    manifest.sha256 !== bindingSha256
  ) {
    throw new Error(
      'packaged SQLCipher runtime identity does not match manifest',
    );
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'otto-packaged-sqlcipher-'),
  );
  const databasePath = path.join(directory, 'probe.db');
  const key = Buffer.alloc(32, 0x5c);
  try {
    const database = new BetterSqlite3(databasePath, {
      nativeBinding: resolvedBinding,
    });
    database.pragma(`key = ${rawKey(key)}`);
    const cipherVersion = database.pragma('cipher_version', { simple: true });
    if (cipherVersion !== manifest.sqlcipherVersion) {
      throw new Error(
        `packaged SQLCipher version mismatch: expected ${manifest.sqlcipherVersion}, got ${cipherVersion}`,
      );
    }
    database.exec('CREATE TABLE runtime_probe (value TEXT NOT NULL);');
    database
      .prepare('INSERT INTO runtime_probe (value) VALUES (?)')
      .run('packaged-runtime-ok');
    database.close();

    const header = fs
      .readFileSync(databasePath)
      .subarray(0, 16)
      .toString('ascii');
    if (header === 'SQLite format 3\0') {
      throw new Error(
        'packaged SQLCipher runtime created a plaintext database',
      );
    }

    const reopened = new BetterSqlite3(databasePath, {
      nativeBinding: resolvedBinding,
    });
    reopened.pragma(`key = ${rawKey(key)}`);
    const row = reopened.prepare('SELECT value FROM runtime_probe').get();
    const integrityErrors = reopened.pragma('cipher_integrity_check');
    reopened.close();
    if (
      row?.value !== 'packaged-runtime-ok' ||
      !Array.isArray(integrityErrors) ||
      integrityErrors.length !== 0
    ) {
      throw new Error(
        'packaged SQLCipher runtime read or integrity probe failed',
      );
    }

    const wrongKey = new BetterSqlite3(databasePath, {
      nativeBinding: resolvedBinding,
    });
    wrongKey.pragma(`key = ${rawKey(Buffer.alloc(32, 0x6d))}`);
    let wrongKeyRejected = false;
    try {
      wrongKey.prepare('SELECT value FROM runtime_probe').get();
    } catch {
      wrongKeyRejected = true;
    } finally {
      wrongKey.close();
    }
    if (!wrongKeyRejected) {
      throw new Error('packaged SQLCipher runtime accepted a wrong key');
    }

    process.stdout.write(
      `[packaged-sqlcipher] ${manifest.target} loaded SQLCipher ${cipherVersion}\n`,
    );
    return { target: manifest.target, cipherVersion, bindingSha256 };
  } finally {
    key.fill(0);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  probePackagedSqlCipher(requiredArgument('--binding'));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
