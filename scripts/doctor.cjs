#!/usr/bin/env node
/**
 * Lightweight repository health check.
 *
 * This script intentionally uses only Node.js built-ins so it can run before
 * `npm ci` succeeds. It explains whether the local checkout is ready for the
 * normal verification commands.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const binSuffix = isWindows ? '.cmd' : '';

const checks = [];

function addCheck(name, ok, detail, fix) {
  checks.push({ name, ok, detail, fix });
}

function readJson(relativePath) {
  const fullPath = path.join(root, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function commandVersion(command, args = ['--version']) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return null;
  }
}

function parseMajor(version) {
  const match = String(version).match(/v?(\d+)/);
  return match ? Number(match[1]) : NaN;
}

const rootPackage = readJson('package.json');
const nodeVersion = process.version;
const nodeMajor = parseMajor(nodeVersion);
function detectNpmVersion() {
  const userAgent = process.env.npm_config_user_agent || '';
  const match = userAgent.match(/\bnpm\/([^\s]+)/);
  if (match) return match[1];
  return commandVersion(isWindows ? 'npm.cmd' : 'npm');
}

const npmVersion = detectNpmVersion();

addCheck(
  'Node.js version',
  Number.isFinite(nodeMajor) && nodeMajor >= 20,
  `${nodeVersion} (required: ${rootPackage.engines?.node ?? '>=20.0.0'})`,
  'Install Node.js 20 or newer.',
);

addCheck(
  'npm available',
  Boolean(npmVersion),
  npmVersion ? `npm ${npmVersion}` : 'npm command not found',
  'Install npm with Node.js or fix PATH.',
);

addCheck(
  'package-lock present',
  fs.existsSync(path.join(root, 'package-lock.json')),
  'package-lock.json is required for reproducible installs',
  'Restore package-lock.json before installing dependencies.',
);

const expectedWorkspaces = ['packages/cli', 'packages/core', 'packages/server', 'packages/desktop'];
for (const workspace of expectedWorkspaces) {
  addCheck(
    `workspace ${workspace}`,
    fs.existsSync(path.join(root, workspace, 'package.json')),
    `${workspace}/package.json`,
    `Restore ${workspace}/package.json or update package.json workspaces.`,
  );
}

const localBins = ['vitest', 'tsc', 'eslint'];
for (const bin of localBins) {
  const binPath = path.join(root, 'node_modules', '.bin', `${bin}${binSuffix}`);
  addCheck(
    `local bin ${bin}`,
    fs.existsSync(binPath),
    path.relative(root, binPath),
    'Run npm ci, then rerun npm run doctor.',
  );
}

const failed = checks.filter((check) => !check.ok);

console.log('Otto repository doctor');
console.log('');
for (const check of checks) {
  console.log(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
  if (!check.ok) console.log(`  fix: ${check.fix}`);
}

console.log('');
if (failed.length === 0) {
  console.log('Ready for verification: git diff --check, focused tests, typecheck, lint/build as needed.');
  process.exit(0);
}

console.log(`${failed.length} check(s) failed. Fix the items above before trusting test/typecheck results.`);
process.exit(1);
