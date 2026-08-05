/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1]?.trim() || null;
}

function requiredRevision(name) {
  const value = process.env[name]?.trim();
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) {
    throw new Error(`${name} must be an immutable 40-character Git commit`);
  }
  return value;
}

function rawKey(key) {
  return `"x'${key.toString('hex')}'"`;
}

function assertOrdinarySqliteRejects(databasePath) {
  const probe = [
    'import sqlite3, sys',
    'database = sqlite3.connect(sys.argv[1])',
    "database.execute('SELECT name FROM sqlite_master').fetchall()",
  ].join('; ');
  const candidates =
    process.platform === 'win32' ? ['python'] : ['python3', 'python'];
  for (const command of candidates) {
    const result = spawnSync(command, ['-c', probe, databasePath], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error?.code === 'ENOENT') continue;
    if (result.error) {
      throw new Error(
        `ordinary SQLite probe failed to execute: ${result.error.message}`,
      );
    }
    if (result.status === 0) {
      throw new Error(
        'ordinary SQLite unexpectedly opened the encrypted database',
      );
    }
    return true;
  }
  throw new Error(
    'Python sqlite3 is required for the ordinary SQLite rejection probe',
  );
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

    const plainSqliteRejected = assertOrdinarySqliteRejects(databasePath);

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
    return { cipherVersion, plainSqliteRejected };
  } finally {
    key.fill(0);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  const bindingPath = path.resolve(requiredArgument('--binding'));
  const outputRoot = path.resolve(requiredArgument('--output-root'));
  const target = requiredArgument('--target');
  const runtime = optionalArgument('--runtime') ?? 'electron';
  if (!['electron', 'node'].includes(runtime)) {
    throw new Error('--runtime must be electron or node');
  }
  const targetMatch = /^(win32|darwin|linux)-(x64|arm64)$/.exec(target);
  if (!targetMatch) throw new Error(`unsupported target ${target}`);
  if (!fs.existsSync(bindingPath))
    throw new Error(`binding does not exist: ${bindingPath}`);

  const { cipherVersion, plainSqliteRejected } = smokeTest(bindingPath);
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
  const expectedRuntimeVersion =
    runtime === 'electron'
      ? desktopPackage.build.electronVersion
      : requiredArgument('--runtime-version');
  if (
    runtime === 'electron' &&
    process.versions.electron !== expectedRuntimeVersion
  ) {
    throw new Error(
      `asset must be finalized by Electron ${expectedRuntimeVersion}; got ${process.versions.electron ?? 'plain Node.js'}`,
    );
  }
  if (
    runtime === 'node' &&
    (process.versions.electron ||
      process.versions.node !== expectedRuntimeVersion)
  ) {
    throw new Error(
      `asset must be finalized by Node.js ${expectedRuntimeVersion}; got ${process.versions.electron ? `Electron ${process.versions.electron}` : `Node.js ${process.versions.node}`}`,
    );
  }
  const bindingSha256 = createHash('sha256')
    .update(fs.readFileSync(outputBinding))
    .digest('hex');
  const sourceRevision = requiredRevision('SQLCIPHER_SOURCE_REVISION');
  const buildCommit = requiredRevision('GITHUB_SHA');
  const noticesSource = path.join(
    process.cwd(),
    'native',
    'sqlcipher',
    'THIRD_PARTY_NOTICES.md',
  );
  if (!fs.existsSync(noticesSource)) {
    throw new Error(
      `SQLCipher third-party notices are missing: ${noticesSource}`,
    );
  }
  const noticesPath = path.join(targetDirectory, 'THIRD_PARTY_NOTICES.md');
  fs.copyFileSync(noticesSource, noticesPath);
  const noticesSha256 = createHash('sha256')
    .update(fs.readFileSync(noticesPath))
    .digest('hex');
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      properties: [
        { name: 'otto:target', value: target },
        { name: 'otto:buildCommit', value: buildCommit },
        { name: 'otto:sourceRevision', value: sourceRevision },
        { name: 'otto:runtime', value: runtime },
        { name: `otto:${runtime}Version`, value: expectedRuntimeVersion },
        { name: `otto:${runtime}ModuleAbi`, value: process.versions.modules },
      ],
      component: {
        type: 'file',
        name: 'better_sqlite3.node',
        version: serverPackage.dependencies['better-sqlite3'],
        hashes: [{ alg: 'SHA-256', content: bindingSha256 }],
      },
    },
    components: [
      {
        type: 'library',
        name: 'SQLCipher',
        version: cipherVersion,
        licenses: [{ license: { id: 'BSD-3-Clause' } }],
        externalReferences: [
          {
            type: 'vcs',
            url: `https://github.com/sqlcipher/sqlcipher/tree/${sourceRevision}`,
          },
        ],
      },
      {
        type: 'library',
        name: 'better-sqlite3',
        version: serverPackage.dependencies['better-sqlite3'],
        purl: `pkg:npm/better-sqlite3@${serverPackage.dependencies['better-sqlite3']}`,
      },
    ],
  };
  const sbomPath = path.join(targetDirectory, 'sbom.cdx.json');
  fs.writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, {
    mode: 0o600,
  });
  const manifest = {
    format: 3,
    target,
    platform: targetMatch[1],
    arch: targetMatch[2],
    runtime,
    runtimeVersion: expectedRuntimeVersion,
    sqlcipherVersion: cipherVersion,
    betterSqlite3Version: serverPackage.dependencies['better-sqlite3'],
    cipherSelfTest: true,
    plainSqliteRejected,
    license: 'BSD-3-Clause',
    source: 'https://github.com/sqlcipher/sqlcipher',
    sourceRevision,
    buildCommit,
    toolchain: {
      nodeVersion: process.versions.node,
      ...(runtime === 'electron'
        ? {
            electronVersion: process.versions.electron,
            electronModuleAbi: process.versions.modules,
          }
        : { nodeModuleAbi: process.versions.modules }),
      opensslVersion: process.versions.openssl,
    },
    sha256: bindingSha256,
    notices: {
      path: 'THIRD_PARTY_NOTICES.md',
      sha256: noticesSha256,
    },
    sbom: {
      format: 'CycloneDX',
      path: 'sbom.cdx.json',
      sha256: createHash('sha256')
        .update(fs.readFileSync(sbomPath))
        .digest('hex'),
    },
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
