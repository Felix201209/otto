#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Zero-dependency package boundary checker.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PACKAGES_DIR = path.join(ROOT, 'packages');
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'release']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IMPORT_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const BASELINE = new Set([
  'packages/adapters/mem0/index.ts -> ../../core/src/config/config.js (#90: adapter package is not a workspace yet; migrate to otto-core public exports)',
  'packages/adapters/mem0/index.ts -> ../../core/src/memory/memoryProvider.js (#90: adapter package is not a workspace yet; migrate to otto-core public exports)',
  'packages/server/src/enterprise/db.test.ts -> ../../../desktop/src/renderer/atoaProtocol.js (#90/#91: move A2A protocol to shared public module)',
  'packages/server/src/enterprise/server.test.ts -> ../../../desktop/src/renderer/atoaProtocol.js (#90/#91: move A2A protocol to shared public module)',
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
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
}

function packageName(rel) {
  const parts = rel.split('/');
  return parts[0] === 'packages' ? parts[1] : null;
}

function resolveImport(fromRel, specifier) {
  if (!specifier.startsWith('.')) return null;
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  return normalized.startsWith('packages/') ? normalized : null;
}

function violationFor(fromRel, specifier) {
  const fromPackage = packageName(fromRel);
  if (!fromPackage) return null;
  const resolved = resolveImport(fromRel, specifier);
  if (fromPackage === 'core') {
    if (resolved?.startsWith('packages/cli/') || resolved?.startsWith('packages/server/') || resolved?.startsWith('packages/desktop/')) {
      return 'core must not import cli/server/desktop';
    }
  }
  if (specifier.includes('/core/src/') || specifier.match(/^\.\.\/\.\.\/core\/src\//)) {
    return 'cross-package core source import must use otto-core public exports';
  }
  if (fromPackage === 'server' && resolved?.startsWith('packages/desktop/src/')) {
    return 'server must not import desktop source';
  }
  if (fromPackage === 'desktop' && resolved?.startsWith('packages/server/src/')) {
    return 'desktop must not import server source deep paths';
  }
  if (fromPackage === 'desktop' && specifier.startsWith('otto-server/')) {
    return 'desktop must import otto-server through public package exports';
  }
  return null;
}

const files = [];
walk(PACKAGES_DIR, files);
const violations = [];
for (const file of files) {
  const rel = toRel(file);
  const content = readFileSync(file, 'utf8');
  for (const match of content.matchAll(IMPORT_RE)) {
    const specifier = match[1] || match[2];
    if (!specifier) continue;
    const reason = violationFor(rel, specifier);
    if (!reason) continue;
    const basePrefix = `${rel} -> ${specifier}`;
    const baseline = [...BASELINE].find((entry) => entry.startsWith(basePrefix));
    violations.push({ rel, specifier, reason, baseline });
  }
}

console.log('Otto package boundary validation');
if (violations.length === 0) {
  console.log('No boundary violations found.');
  process.exit(0);
}
for (const violation of violations) {
  const status = violation.baseline ? 'BASELINE' : 'FAIL';
  console.log(`${status} ${violation.rel} imports ${violation.specifier}`);
  console.log(`  ${violation.reason}`);
  if (violation.baseline) console.log(`  ${violation.baseline}`);
}
const newViolations = violations.filter((violation) => !violation.baseline);
if (newViolations.length > 0) {
  console.error('');
  console.error(`Boundary validation failed: ${newViolations.length} new violation(s).`);
  process.exit(1);
}
console.log('');
console.log(`Boundary validation passed with ${violations.length} baselined violation(s).`);
