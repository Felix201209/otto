/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyUpdateManifest } from './verify-update-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const mebibyte = 1024 * 1024;
const lastPublicWindowsInstallerBytes = Number(
  process.env.OTTO_DESKTOP_BASELINE_INSTALLER_BYTES || 236_706_516,
);
const maxWindowsInstallerGrowthBytes =
  Number(process.env.OTTO_DESKTOP_MAX_INSTALLER_GROWTH_MB || 12) * mebibyte;
const hardWindowsInstallerLimitBytes =
  Number(process.env.OTTO_DESKTOP_MAX_INSTALLER_MB || 250) * mebibyte;
for (const [name, value] of [
  ['OTTO_DESKTOP_BASELINE_INSTALLER_BYTES', lastPublicWindowsInstallerBytes],
  ['OTTO_DESKTOP_MAX_INSTALLER_GROWTH_MB', maxWindowsInstallerGrowthBytes],
  ['OTTO_DESKTOP_MAX_INSTALLER_MB', hardWindowsInstallerLimitBytes],
]) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must resolve to a positive finite byte budget`);
  }
}
const maxWindowsInstallerBytes = Math.min(
  hardWindowsInstallerLimitBytes,
  lastPublicWindowsInstallerBytes + maxWindowsInstallerGrowthBytes,
);

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function note(message) {
  notes.push(message);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function assertFile(file, { minBytes = 1 } = {}) {
  if (!existsSync(file)) {
    fail(`missing required file: ${path.relative(repoRoot, file)}`);
    return;
  }
  const size = statSync(file).size;
  if (size < minBytes) {
    fail(
      `required file is too small: ${path.relative(repoRoot, file)} (${size} bytes)`,
    );
  }
}

const rootPkg = readJson(path.join(repoRoot, 'package.json'));
const desktopPkg = readJson(path.join(desktopRoot, 'package.json'));
const lock = readJson(path.join(repoRoot, 'package-lock.json'));

if (rootPkg.version !== desktopPkg.version) {
  fail(
    `version mismatch: root=${rootPkg.version}, desktop=${desktopPkg.version}`,
  );
}
if (lock.version !== rootPkg.version) {
  fail(
    `package-lock root version mismatch: lock=${lock.version}, root=${rootPkg.version}`,
  );
}
if (lock.packages?.['packages/desktop']?.version !== desktopPkg.version) {
  fail(
    `package-lock desktop version mismatch: lock=${lock.packages?.['packages/desktop']?.version}, desktop=${desktopPkg.version}`,
  );
}

for (const name of [
  'otto-avatar-1.png',
  'otto-avatar-2.png',
  'otto-avatar-3.png',
  'otto-avatar-4.png',
]) {
  assertFile(path.join(desktopRoot, 'build', 'avatar', name), {
    minBytes: 512 * 1024,
  });
}
assertFile(path.join(desktopRoot, 'build', 'icon.png'), {
  minBytes: 64 * 1024,
});
assertFile(path.join(desktopRoot, 'build', 'icon.icns'), {
  minBytes: 64 * 1024,
});

const mainSource = readFileSync(
  path.join(desktopRoot, 'src', 'main', 'index.ts'),
  'utf8',
);
for (const expected of [
  'function canRestoreEncryptedEnterpriseSession()',
  "process.env.OTTO_ENTERPRISE_RESTORE_KEYCHAIN_SESSION === '1'",
  "process.platform === 'darwin' && app.isPackaged",
  'if (!canRestoreEncryptedEnterpriseSession()) return',
]) {
  if (!mainSource.includes(expected))
    fail(`missing enterprise login guard: ${expected}`);
}

const buildFiles = desktopPkg.build?.files ?? [];
if (buildFiles.includes('!**/node_modules/**/src/**')) {
  fail(
    'package build.files must not exclude node_modules/**/src/**; ESM dependencies may require src files at runtime',
  );
}

const releaseDir = path.join(desktopRoot, 'release');
const winInstaller = path.join(
  releaseDir,
  `Otto-Setup-${desktopPkg.version}-win-x64.exe`,
);
const releaseAssetCandidates = [
  winInstaller,
  path.join(releaseDir, `Otto-${desktopPkg.version}-arm64.dmg`),
  path.join(releaseDir, `Otto-${desktopPkg.version}-x64.dmg`),
  path.join(releaseDir, 'latest.json'),
];
if (existsSync(winInstaller)) {
  const size = statSync(winInstaller).size;
  const growth = size - lastPublicWindowsInstallerBytes;
  if (size > maxWindowsInstallerBytes) {
    fail(
      `Windows installer exceeds 1.9.12-relative budget: ${size} bytes > ${maxWindowsInstallerBytes} bytes (growth ${growth} bytes)`,
    );
  } else {
    note(
      `Windows installer size ${size} bytes; growth from 1.9.12 is ${growth} bytes; budget ${maxWindowsInstallerBytes} bytes`,
    );
  }
} else {
  note(
    'Windows installer not present; size gate will run after dist:win/package creates release artifact',
  );
}

if (releaseAssetCandidates.some(existsSync)) {
  try {
    verifyUpdateManifest({
      releaseDir,
      version: desktopPkg.version,
    });
  } catch (error) {
    fail(`release/latest.json asset verification failed: ${error.message}`);
  }
} else {
  note(
    'Desktop release artifacts not present; update manifest gate will run after dist/package creates release assets',
  );
}

for (const relative of [
  'packages/desktop/package.json',
  'packages/desktop/src/main/index.ts',
  'packages/desktop/src/main/enterprise-auth-sync.test.ts',
]) {
  const text = readFileSync(path.join(repoRoot, relative), 'utf8');
  if (text.includes('<<<<<<<') || text.includes('>>>>>>>')) {
    fail(`conflict marker found in ${relative}`);
  }
}

if (failures.length) {
  console.error('[release:gate] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[release:gate] ok');
for (const message of notes) console.log(`[release:gate] note: ${message}`);
