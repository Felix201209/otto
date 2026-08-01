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
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const binSuffix = isWindows ? '.cmd' : '';

const checks = [];
const SOURCE_SIZE_BUDGET_MB = Number(process.env.OTTO_DOCTOR_SOURCE_SIZE_BUDGET_MB || 50);
const DISTRIBUTION_SIZE_BUDGET_MB = Number(process.env.OTTO_DOCTOR_DISTRIBUTION_SIZE_BUDGET_MB || 10);
const DISTRIBUTION_ARTIFACT_PATHS = [
  process.env.OTTO_DOCTOR_RELEASE_ARTIFACT_DIR,
  'bundle',
  path.join('otto-native', 'bin'),
].filter(Boolean);
const SOURCE_SIZE_EXCLUDES = new Set([
  '.git',
  'node_modules',
  'bundle',
  'dist',
  'target',
  'release',
  'coverage',
  '.otto',
  '.agents',
]);
const MOJIBAKE_SCAN_ROOTS = [
  'docs',
  'packages/core/src/core',
  'packages/core/src/tools',
  'packages/core/src/agents',
  'packages/core/src/config',
];
const MOJIBAKE_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.md']);
const MOJIBAKE_MARKERS = [
  '�',
  'ï¿½',
  'Ã',
  'Â',
  'â€',
  '鈥',
  '鉁',
  '鉂',
  '馃',
  '鑷',
  '鍥',
  '涓€',
  '鏃',
  '闃',
  '杩',
  '浠',
  '瀛',
  '宸',
  '绋',
];

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
  } catch {
    return null;
  }
}

function parseMajor(version) {
  const match = String(version).match(/v?(\d+)/);
  return match ? Number(match[1]) : NaN;
}

function directorySizeBytes(dir, topLevelStats = new Map(), topLevelName = '') {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SOURCE_SIZE_EXCLUDES.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const topName = topLevelName || entry.name;
    try {
      if (entry.isDirectory()) {
        total += directorySizeBytes(fullPath, topLevelStats, topName);
      } else if (entry.isFile()) {
        const size = fs.statSync(fullPath).size;
        total += size;
        topLevelStats.set(topName, (topLevelStats.get(topName) || 0) + size);
      }
    } catch {
      // Ignore files that disappear during the scan; doctor should stay lightweight.
    }
  }
  return total;
}

function directoryRawSizeBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += directoryRawSizeBytes(fullPath);
      } else if (entry.isFile()) {
        total += fs.statSync(fullPath).size;
      }
    } catch {
      // Ignore files that disappear during the scan; doctor should stay lightweight.
    }
  }
  return total;
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function collectFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SOURCE_SIZE_EXCLUDES.has(entry.name)) collectFiles(fullPath, files);
    } else if (entry.isFile() && MOJIBAKE_FILE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function findMojibakeMarkers() {
  const findings = [];
  for (const relativeRoot of MOJIBAKE_SCAN_ROOTS) {
    const scanRoot = path.join(root, relativeRoot);
    for (const file of collectFiles(scanRoot)) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const marker = MOJIBAKE_MARKERS.find((candidate) => text.includes(candidate));
      if (marker) {
        findings.push(`${path.relative(root, file)} (${marker})`);
      }
    }
  }
  return findings;
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
const topLevelStats = new Map();
const sourcePayloadBytes = directorySizeBytes(root, topLevelStats);
const topSourceContributors = [...topLevelStats.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([name, size]) => `${name} ${formatMb(size)}`)
  .join(', ');
const totalMemoryGb = os.totalmem() / 1024 / 1024 / 1024;
const mojibakeFindings = findMojibakeMarkers();
const distributionArtifacts = DISTRIBUTION_ARTIFACT_PATHS
  .map((relativePath) => ({
    relativePath,
    fullPath: path.resolve(root, relativePath),
  }))
  .filter((artifact) => fs.existsSync(artifact.fullPath));
const distributionPayloadBytes = distributionArtifacts.reduce(
  (total, artifact) => total + directoryRawSizeBytes(artifact.fullPath),
  0,
);
const distributionDetails = distributionArtifacts.length === 0
  ? `no release artifact found; budget: ${DISTRIBUTION_SIZE_BUDGET_MB} MB`
  : `${formatMb(distributionPayloadBytes)} (budget: ${DISTRIBUTION_SIZE_BUDGET_MB} MB; paths: ${distributionArtifacts.map((artifact) => artifact.relativePath).join(', ')})`;

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

addCheck(
  'source payload size',
  sourcePayloadBytes <= SOURCE_SIZE_BUDGET_MB * 1024 * 1024,
  `${formatMb(sourcePayloadBytes)} (budget: ${SOURCE_SIZE_BUDGET_MB} MB; top: ${topSourceContributors || 'none'})`,
  'Remove stale generated assets/dead code or raise OTTO_DOCTOR_SOURCE_SIZE_BUDGET_MB with a release note.',
);

addCheck(
  'release distribution size',
  distributionArtifacts.length === 0 || distributionPayloadBytes <= DISTRIBUTION_SIZE_BUDGET_MB * 1024 * 1024,
  distributionDetails,
  'Move optional components out of the core artifact or rebuild the Rust native distribution under 10MB.',
);

addCheck(
  'host memory profile',
  totalMemoryGb >= 4,
  `${totalMemoryGb.toFixed(1)} GB RAM detected`,
  'Use OTTO_AGENT_PROFILE=low and keep max_concurrency at 1 on very small devices.',
);

addCheck(
  'agent-critical text encoding',
  mojibakeFindings.length === 0,
  mojibakeFindings.length === 0
    ? 'no mojibake markers found in docs/core/tools/prompts'
    : mojibakeFindings.slice(0, 8).join(', '),
  'Rewrite the affected agent-facing comments/docs/prompts as valid UTF-8 before changing behavior.',
);

const expectedWorkspaces = ['packages/core', 'packages/server', 'packages/desktop'];
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
