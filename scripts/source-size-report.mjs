#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Zero-dependency source-size report and guard.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CHECK = process.argv.includes('--check');
const ROOTS = ['packages', 'docs', 'scripts', '.otto', 'otto-native'];
const ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'eslint.config.js',
  'AGENTS.md',
];
const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'coverage',
  'release',
  '.turbo',
  '.cache',
  'deliverables',
]);
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.md',
  '.html',
  '.yml',
  '.yaml',
  '.sh',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.rs',
  '.toml',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.icns',
  '.wav',
  '.svg',
]);
const TEXT_HARD_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.md']);

const BUDGETS = {
  totalBytes: 35 * 1024 * 1024,
  textWarnBytes: 150 * 1024,
  textHardBytes: 300 * 1024,
  duplicateBytes: 100 * 1024,
};

const BASELINE = new Map([
  ['packages/core/src/core/customModelAdapter.ts', '#92 inventory: keep provider adapter in core boundary review'],
  ['packages/core/src/core/customModelAdapter.test.ts', '#92 inventory: test follows adapter'],
  ['packages/desktop/src/renderer/styles/app.css', '#89 split desktop CSS'],
  ['packages/server/src/enterprise/db.ts', '#87 split enterprise DB module'],
  ['packages/server/src/enterprise/server.ts', '#85/#87 enterprise server split pending'],
  ['packages/server/src/enterprise/server.test.ts', '#87 enterprise tests follow DB/server split'],
  ['packages/server/src/server.ts', '#91 protocol/server split pending'],
  ['packages/server/src/feishu/vendor/gateway.ts', '#84 duplicate Feishu gateway pending'],
]);

function toRel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function walk(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    const stat = statSync(full);
    files.push({ path: full, rel: toRel(full), ext, size: stat.size });
  }
}

const files = [];
for (const root of ROOTS) {
  const full = path.join(ROOT, root);
  try {
    if (statSync(full).isDirectory()) walk(full, files);
  } catch {
    // Optional source roots may not exist in trimmed worktrees.
  }
}
for (const file of ROOT_FILES) {
  const full = path.join(ROOT, file);
  try {
    const stat = statSync(full);
    if (stat.isFile()) files.push({ path: full, rel: file, ext: path.extname(file), size: stat.size });
  } catch {
    // Optional root config file.
  }
}

files.sort((a, b) => a.rel.localeCompare(b.rel));
const total = files.reduce((sum, file) => sum + file.size, 0);
const byRoot = new Map();
for (const file of files) {
  const root = file.rel.split('/')[0] || file.rel;
  byRoot.set(root, (byRoot.get(root) ?? 0) + file.size);
}

const hashes = new Map();
for (const file of files) {
  if (file.size < BUDGETS.duplicateBytes) continue;
  const hash = createHash('sha256').update(readFileSync(file.path)).digest('hex');
  const group = hashes.get(hash) ?? [];
  group.push(file);
  hashes.set(hash, group);
}
const duplicates = [...hashes.entries()]
  .map(([hash, group]) => ({ hash, group }))
  .filter(({ group }) => group.length > 1)
  .sort((a, b) => b.group[0].size - a.group[0].size);

const largeText = files
  .filter((file) => TEXT_HARD_EXTENSIONS.has(file.ext) && file.size >= BUDGETS.textWarnBytes)
  .sort((a, b) => b.size - a.size);

function fmt(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

console.log('Otto source-size report');
console.log(`Total source-like size: ${fmt(total)} (budget: ${fmt(BUDGETS.totalBytes)})`);
console.log(`Files counted: ${files.length}`);
console.log(`Excluded directories: ${[...EXCLUDED_DIRS].sort().join(', ')}`);
console.log('');
console.log('By root:');
for (const [root, size] of [...byRoot.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${root.padEnd(18)} ${fmt(size)}`);
}
console.log('');
console.log('Top 30 files:');
for (const file of [...files].sort((a, b) => b.size - a.size).slice(0, 30)) {
  const note = BASELINE.get(file.rel) ? ` baseline ${BASELINE.get(file.rel)}` : '';
  console.log(`  ${fmt(file.size).padStart(9)}  ${file.rel}${note}`);
}
if (largeText.length > 0) {
  console.log('');
  console.log('Large text files >= 150 KB:');
  for (const file of largeText) {
    const status = file.size > BUDGETS.textHardBytes && !BASELINE.has(file.rel) ? 'FAIL' : BASELINE.has(file.rel) ? 'BASELINE' : 'WARN';
    console.log(`  ${status.padEnd(8)} ${fmt(file.size).padStart(9)}  ${file.rel}`);
  }
}
if (duplicates.length > 0) {
  console.log('');
  console.log('Duplicate files >= 100 KB:');
  for (const duplicate of duplicates) {
    const rels = duplicate.group.map((file) => file.rel);
    const baselined = rels.every((rel) => BASELINE.has(rel));
    console.log(`  ${baselined ? 'BASELINE' : 'FAIL'} ${fmt(duplicate.group[0].size)} ${duplicate.hash.slice(0, 12)} ${rels.join(' | ')}`);
  }
}

if (CHECK) {
  const failures = [];
  if (total > BUDGETS.totalBytes) failures.push(`total source-like size ${fmt(total)} exceeds ${fmt(BUDGETS.totalBytes)}`);
  for (const file of largeText) {
    if (file.size > BUDGETS.textHardBytes && !BASELINE.has(file.rel)) {
      failures.push(`${file.rel} exceeds hard text limit ${fmt(BUDGETS.textHardBytes)}`);
    }
  }
  for (const duplicate of duplicates) {
    if (!duplicate.group.every((file) => BASELINE.has(file.rel))) {
      failures.push(`duplicate large files: ${duplicate.group.map((file) => file.rel).join(', ')}`);
    }
  }
  if (failures.length > 0) {
    console.error('');
    console.error('Source-size check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('');
  console.log('Source-size check passed.');
}
