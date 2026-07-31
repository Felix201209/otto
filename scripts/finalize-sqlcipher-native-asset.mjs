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

function smokeTest(bindingPath) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'otto-sqlcipher-smoke-'),
  );
  const databasePath = path.join(directory, 'encrypted.db');
  const key = Buffer.alloc(32, 0x6a);
  try {
    const database = new BetterSqlite3(databasePath, {
      nativeBinding: bindingPath,
    });
    database.pragma(`key = ${rawKey(key)}`);
    const cipherVersion = database.pragma('cipher_version', { simple: true });
    if (typeof cipherVersion !== 'string' || !cipherVersion.trim()) {
      throw new Error('native asset does not expose SQLCipher cipher_version');
    }
    database.exec('CREATE TABLE protected_probe (value TEXT NOT NULL);');
    database
      .prepare('INSERT INTO protected_probe (value) VALUES (?)')
      .run('secret');
    database.close();

    const header = fs
      .readFileSync(databasePath)
      .subarray(0, 16)
      .toString('ascii');
    if (header === 'SQLite format 3\0') {
      throw new Error('native asset created a plaintext SQLite header');
    }

    const reopened = new BetterSqlite3(databasePath, {
      nativeBinding: bindingPath,
    });
    reopened.pragma(`key = ${rawKey(key)}`);
    const row = reopened.prepare('SELECT value FROM protected_probe').get();
    if (row?.value !== 'secret')
      throw new Error('SQLCipher correct-key read failed');
    const cipherErrors = reopened.pragma('cipher_integrity_check');
    if (!Array.isArray(cipherErrors) || cipherErrors.length !== 0) {
      throw new Error('SQLCipher cipher_integrity_check failed');
    }
    reopened.close();

    const wrong = new BetterSqlite3(databasePath, {
      nativeBinding: bindingPath,
    });
    wrong.pragma(`key = ${rawKey(Buffer.alloc(32, 0x7b))}`);
    let rejected = false;
    try {
      wrong.prepare('SELECT value FROM protected_probe').get();
    } catch {
      rejected = true;
    } finally {
      wrong.close();
    }
    if (!rejected) throw new Error('SQLCipher wrong-key read was not rejected');
    return cipherVersion;
  } finally {
    key.fill(0);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  const bindingPath = path.resolve(requiredArgument('--binding'));
  const outputRoot = path.resolve(requiredArgument('--output-root'));
  const target = requiredArgument('--target');
  const targetMatch = /^(win32|darwin|linux)-(x64|arm64)$/.exec(target);
  if (!targetMatch) throw new Error(`unsupported target ${target}`);
  if (!fs.existsSync(bindingPath))
    throw new Error(`binding does not exist: ${bindingPath}`);

  const cipherVersion = smokeTest(bindingPath);
  const targetDirectory = path.join(outputRoot, target);
  fs.mkdirSync(targetDirectory, { recursive: true });
  const outputBinding = path.join(targetDirectory, 'better_sqlite3.node');
  fs.copyFileSync(bindingPath, outputBinding);
  const desktopPackage = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'packages', 'desktop', 'package.json'),
      'utf8',
    ),
  );
  const serverPackage = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'packages', 'server', 'package.json'),
      'utf8',
    ),
  );
  const manifest = {
    format: 1,
    target,
    platform: targetMatch[1],
    arch: targetMatch[2],
    runtime: 'electron',
    runtimeVersion: desktopPackage.build.electronVersion,
    sqlcipherVersion: cipherVersion,
    betterSqlite3Version: serverPackage.dependencies['better-sqlite3'],
    cipherSelfTest: true,
    license: 'BSD-3-Clause',
    source: 'https://github.com/sqlcipher/sqlcipher',
    sourceRevision: process.env.SQLCIPHER_SOURCE_REVISION || 'unknown',
    buildCommit: process.env.GITHUB_SHA || 'local',
    sha256: createHash('sha256')
      .update(fs.readFileSync(outputBinding))
      .digest('hex'),
  };
  fs.writeFileSync(
    path.join(targetDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `[sqlcipher-assets] ${target} passed SQLCipher ${cipherVersion} behavior checks\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
