/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const maxWindowsInstallerBytes = Number(
  process.env.OTTO_DESKTOP_MAX_INSTALLER_MB || 160,
) * 1024 * 1024;

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
    fail(`required file is too small: ${path.relative(repoRoot, file)} (${size} bytes)`);
  }
}

const rootPkg = readJson(path.join(repoRoot, 'package.json'));
const desktopPkg = readJson(path.join(desktopRoot, 'package.json'));
const lock = readJson(path.join(repoRoot, 'package-lock.json'));

if (rootPkg.version !== desktopPkg.version) {
  fail(`version mismatch: root=${rootPkg.version}, desktop=${desktopPkg.version}`);
}
if (lock.version !== rootPkg.version) {
  fail(`package-lock root version mismatch: lock=${lock.version}, root=${rootPkg.version}`);
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
  assertFile(path.join(desktopRoot, 'build', 'avatar', name), { minBytes: 512 * 1024 });
}
assertFile(path.join(desktopRoot, 'build', 'icon.png'), { minBytes: 64 * 1024 });
assertFile(path.join(desktopRoot, 'build', 'icon.icns'), { minBytes: 64 * 1024 });

const mainSource = readFileSync(path.join(desktopRoot, 'src', 'main', 'index.ts'), 'utf8');
for (const expected of [
  'function canRestoreEncryptedEnterpriseSession()',
  "process.env.OTTO_ENTERPRISE_RESTORE_KEYCHAIN_SESSION === '1'",
  "process.platform === 'darwin' && app.isPackaged",
  'if (!canRestoreEncryptedEnterpriseSession()) return',
]) {
  if (!mainSource.includes(expected)) fail(`missing enterprise login guard: ${expected}`);
}

const buildFiles = desktopPkg.build?.files ?? [];
if (buildFiles.includes('!**/node_modules/**/src/**')) {
  fail('package build.files must not exclude node_modules/**/src/**; ESM dependencies may require src files at runtime');
}

const releaseDir = path.join(desktopRoot, 'release');
const winInstaller = path.join(releaseDir, `Otto-Setup-${desktopPkg.version}-win-x64.exe`);
if (existsSync(winInstaller)) {
  const size = statSync(winInstaller).size;
  if (size > maxWindowsInstallerBytes) {
    fail(
      `Windows installer exceeds limit: ${size} bytes > ${maxWindowsInstallerBytes} bytes`,
    );
  }
} else {
  note('Windows installer not present; size gate will run after dist:win/package creates release artifact');
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
