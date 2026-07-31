/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopRoot, '../..');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readAsarJson(archivePath, archiveEntry) {
  const nativeEntry = archiveEntry.split('/').join(path.sep);
  return JSON.parse(
    asar.extractFile(archivePath, nativeEntry).toString('utf8'),
  );
}

function requireAsarEntry(entries, archiveEntry) {
  const normalized = `/${archiveEntry.replaceAll('\\', '/')}`;
  if (!entries.has(normalized)) {
    throw new Error(`packaged runtime is missing ${archiveEntry}`);
  }
}

function expectedSheetJsVersion(specifier) {
  const match = String(specifier).match(/xlsx-(\d+\.\d+\.\d+)\.tgz$/);
  if (!match) {
    throw new Error(`cannot determine SheetJS version from ${specifier}`);
  }
  return match[1];
}

export function verifyPackagedRuntime(
  archivePath,
  platform = process.platform,
) {
  if (!existsSync(archivePath)) {
    throw new Error(`app.asar not found: ${archivePath}`);
  }

  const desktopPackage = readJson(path.join(desktopRoot, 'package.json'));
  const serverPackage = readJson(
    path.join(repoRoot, 'packages/server/package.json'),
  );
  const corePackage = readJson(
    path.join(repoRoot, 'packages/core/package.json'),
  );
  const entries = new Set(
    asar.listPackage(archivePath).map((entry) => entry.replaceAll('\\', '/')),
  );

  for (const entry of [
    'dist/main/index.js',
    'dist/preload/index.js',
    'dist/renderer/index.html',
    'node_modules/otto-server/dist/index.js',
    'node_modules/otto-server/package.json',
    'node_modules/otto-core/package.json',
    'node_modules/xlsx/package.json',
    'node_modules/@modelcontextprotocol/sdk/package.json',
  ]) {
    requireAsarEntry(entries, entry);
  }

  const packagedDesktop = readAsarJson(archivePath, 'package.json');
  const packagedServer = readAsarJson(
    archivePath,
    'node_modules/otto-server/package.json',
  );
  const packagedCore = readAsarJson(
    archivePath,
    'node_modules/otto-core/package.json',
  );
  const packagedXlsx = readAsarJson(
    archivePath,
    'node_modules/xlsx/package.json',
  );
  const packagedMcp = readAsarJson(
    archivePath,
    'node_modules/@modelcontextprotocol/sdk/package.json',
  );

  const expected = {
    desktop: desktopPackage.version,
    server: serverPackage.version,
    core: corePackage.version,
    xlsx: expectedSheetJsVersion(corePackage.dependencies.xlsx),
    mcp: corePackage.dependencies['@modelcontextprotocol/sdk'],
  };
  const actual = {
    desktop: packagedDesktop.version,
    server: packagedServer.version,
    core: packagedCore.version,
    xlsx: packagedXlsx.version,
    mcp: packagedMcp.version,
  };

  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `packaged ${key} version mismatch: expected ${expected[key]}, got ${actual[key]}`,
      );
    }
  }

  const sqlCipherDirectory = path.join(path.dirname(archivePath), 'sqlcipher');
  const sqlCipherBinding = path.join(sqlCipherDirectory, 'better_sqlite3.node');
  const sqlCipherManifest = path.join(sqlCipherDirectory, 'manifest.json');
  const sqlCipherSbom = path.join(sqlCipherDirectory, 'sbom.cdx.json');
  const sqlCipherNotices = path.join(
    sqlCipherDirectory,
    'THIRD_PARTY_NOTICES.md',
  );
  for (const required of [
    sqlCipherBinding,
    sqlCipherManifest,
    sqlCipherSbom,
    sqlCipherNotices,
  ]) {
    if (!existsSync(required)) {
      throw new Error(`packaged SQLCipher resource is missing: ${required}`);
    }
  }
  const nativeHeader = readFileSync(sqlCipherBinding).subarray(0, 4);
  const validNativeHeader =
    platform === 'win32'
      ? nativeHeader.subarray(0, 2).toString('ascii') === 'MZ'
      : platform === 'linux'
        ? nativeHeader.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
        : ['cffaedfe', 'cefaedfe', 'cafebabe', 'cafebabf'].includes(
            nativeHeader.toString('hex'),
          );
  if (!validNativeHeader) {
    throw new Error(
      `packaged SQLCipher resource has wrong platform format: ${sqlCipherBinding}`,
    );
  }
  const nativeSha256 = createHash('sha256')
    .update(readFileSync(sqlCipherBinding))
    .digest('hex');
  const manifest = readJson(sqlCipherManifest);
  if (
    manifest.format !== 2 ||
    manifest.sha256 !== nativeSha256 ||
    manifest.plainSqliteRejected !== true ||
    manifest.sbom?.path !== 'sbom.cdx.json'
  ) {
    throw new Error('packaged SQLCipher manifest verification failed');
  }
  const sbomSha256 = createHash('sha256')
    .update(readFileSync(sqlCipherSbom))
    .digest('hex');
  if (manifest.sbom.sha256 !== sbomSha256) {
    throw new Error('packaged SQLCipher SBOM checksum verification failed');
  }

  if (platform === 'win32') {
    const ripgrepPath = path.join(
      path.dirname(archivePath),
      'ripgrep',
      'rg.exe',
    );
    if (!existsSync(ripgrepPath)) {
      throw new Error(`packaged ripgrep is missing: ${ripgrepPath}`);
    }
    const magic = readFileSync(ripgrepPath).subarray(0, 2).toString('ascii');
    if (magic !== 'MZ') {
      throw new Error(
        `packaged ripgrep is not a Windows executable: ${ripgrepPath}`,
      );
    }
  }

  return actual;
}

function main() {
  const archiveArgument = process.argv[2];
  if (!archiveArgument) {
    throw new Error(
      'usage: verify-packaged-runtime.mjs <app.asar> [--platform win32|darwin]',
    );
  }
  const platformIndex = process.argv.indexOf('--platform');
  const platform =
    platformIndex === -1 ? process.platform : process.argv[platformIndex + 1];
  const archivePath = path.resolve(process.cwd(), archiveArgument);
  const versions = verifyPackagedRuntime(archivePath, platform);
  console.log(`[packaged-runtime] verified ${JSON.stringify(versions)}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
