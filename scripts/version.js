/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// A script to handle versioning and ensure all related changes are in a single, atomic commit.

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function incrementVersion(current, releaseType) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(current);
  if (!match) throw new Error(`Invalid current version: ${current}`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  const prerelease = match[4];
  if (releaseType === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
    return `${major}.${minor}.${patch}`;
  }
  if (releaseType === 'minor') {
    minor += 1;
    patch = 0;
    return `${major}.${minor}.${patch}`;
  }
  if (releaseType === 'patch') {
    patch += 1;
    return `${major}.${minor}.${patch}`;
  }
  if (releaseType === 'prerelease') {
    if (!prerelease) return `${major}.${minor}.${patch + 1}-0`;
    const parts = prerelease.split('.');
    const last = parts.at(-1) ?? '';
    if (/^\d+$/.test(last)) parts[parts.length - 1] = String(Number(last) + 1);
    else parts.push('0');
    return `${major}.${minor}.${patch}-${parts.join('.')}`;
  }
  throw new Error(`Unsupported version type: ${releaseType}`);
}

function replaceRequired(filePath, pattern, replacement) {
  const source = readFileSync(filePath, 'utf-8');
  if (!pattern.test(source)) {
    throw new Error(`Version marker not found in ${filePath}`);
  }
  writeFileSync(filePath, source.replace(pattern, replacement), 'utf-8');
}

// Get the version type from the command line arguments.
const versionType = process.argv[2];
if (!versionType) {
  console.error('Error: No version type specified.');
  console.error('Usage: npm run release:version -- <patch|minor|major|prerelease>');
  process.exit(1);
}

const rootPackageJsonPath = resolve(process.cwd(), 'package.json');
const corePackageJsonPath = resolve(process.cwd(), 'packages/core/package.json');
const desktopPackageJsonPath = resolve(process.cwd(), 'packages/desktop/package.json');
const packageLockPath = resolve(process.cwd(), 'package-lock.json');
const rootPackage = readJson(rootPackageJsonPath);
const corePackage = readJson(corePackageJsonPath);
const desktopPackage = readJson(desktopPackageJsonPath);
const packageLock = readJson(packageLockPath);
const newVersion = incrementVersion(rootPackage.version, versionType);
const newCoreVersion = incrementVersion(corePackage.version, versionType);

rootPackage.version = newVersion;
desktopPackage.version = newVersion;
corePackage.version = newCoreVersion;
packageLock.version = newVersion;
packageLock.packages[''].version = newVersion;
packageLock.packages['packages/core'].version = newCoreVersion;
packageLock.packages['packages/desktop'].version = newVersion;
writeJson(rootPackageJsonPath, rootPackage);
writeJson(corePackageJsonPath, corePackage);
writeJson(desktopPackageJsonPath, desktopPackage);
writeJson(packageLockPath, packageLock);

// Keep every runtime-facing version display aligned with the release package.
// These preview/server fallbacks are bundled independently and cannot safely
// read the root package.json at runtime.
const versionMarkers = [
  {
    file: 'packages/desktop/preview/live-bridge.ts',
    replacements: [
      [/Promise\.resolve\('\d+\.\d+\.\d+-browser'\)/, `Promise.resolve('${newVersion}-browser')`],
      [/currentVersion: '\d+\.\d+\.\d+'/, `currentVersion: '${newVersion}'`],
    ],
  },
  {
    file: 'packages/desktop/src/renderer/browserPreviewBridge.ts',
    replacements: [
      [/Promise\.resolve\('\d+\.\d+\.\d+-browser-preview'\)/, `Promise.resolve('${newVersion}-browser-preview')`],
      [/currentVersion: '\d+\.\d+\.\d+'/, `currentVersion: '${newVersion}'`],
    ],
  },
  {
    file: 'packages/server/src/server.ts',
    replacements: [
      [/appVersion: \(\) => Promise\.resolve\('\d+\.\d+\.\d+'\)/, `appVersion: () => Promise.resolve('${newVersion}')`],
      [/currentVersion: '\d+\.\d+\.\d+'/, `currentVersion: '${newVersion}'`],
    ],
  },
  {
    file: 'packages/server/src/enterprise/bin.ts',
    replacements: [
      [/OTTO_APP_VERSION=\d+\.\d+\.\d+/, `OTTO_APP_VERSION=${newVersion}`],
    ],
  },
];
for (const marker of versionMarkers) {
  for (const [pattern, replacement] of marker.replacements) {
    replaceRequired(resolve(process.cwd(), marker.file), pattern, replacement);
  }
}

// Update the sandboxImageUri in the root package.json if release sandboxes return.
// const rootPackageJson = readJson(rootPackageJsonPath);
// if (rootPackageJson.config?.sandboxImageUri) {
//   rootPackageJson.config.sandboxImageUri =
//     rootPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
//   console.log(`Updated sandboxImageUri in root to use version ${newVersion}`);
//   writeJson(rootPackageJsonPath, rootPackageJson);
// }

// Update the desktop sandbox image if release sandboxes return.
// const cliPackageJsonPath = resolve(process.cwd(), 'packages/desktop/package.json');
// const cliPackageJson = readJson(cliPackageJsonPath);
// if (cliPackageJson.config?.sandboxImageUri) {
//   cliPackageJson.config.sandboxImageUri =
//     cliPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
//   console.log(
//     `Updated sandboxImageUri in desktop package to use version ${newVersion}`,
//   );
//   writeJson(cliPackageJsonPath, cliPackageJson);
// }

console.log(`Successfully bumped versions to v${newVersion}.`);
