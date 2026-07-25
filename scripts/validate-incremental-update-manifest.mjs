#!/usr/bin/env node
/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';

const manifestPath = process.argv[2] ?? 'docs/examples/incremental-update-manifest.example.json';
const sha256Re = /^[a-f0-9]{64}$/;
const kinds = ['patch', 'kernel', 'component'];
const restarts = new Set(['none', 'renderer', 'server', 'app']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail(`failed to read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
}

if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest must be an object');
if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1');
assertString(manifest.appVersion, 'appVersion');
assertString(manifest.sourceCommit, 'sourceCommit');
assertString(manifest.publishedAt, 'publishedAt');
if (Number.isNaN(Date.parse(manifest.publishedAt))) fail('publishedAt must be an ISO date string');
if (!manifest.channels || typeof manifest.channels !== 'object' || Array.isArray(manifest.channels)) {
  fail('channels must be an object');
}

for (const kind of kinds) {
  const entries = manifest.channels[kind];
  if (!Array.isArray(entries)) fail(`channels.${kind} must be an array`);
  for (const [index, artifact] of entries.entries()) {
    const label = `channels.${kind}[${index}]`;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) fail(`${label} must be an object`);
    if (artifact.kind !== kind) fail(`${label}.kind must be ${kind}`);
    for (const field of ['id', 'version', 'target', 'url', 'sha256', 'signature']) {
      assertString(artifact[field], `${label}.${field}`);
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) fail(`${label}.size must be a positive integer`);
    if (!sha256Re.test(artifact.sha256)) fail(`${label}.sha256 must be lowercase hex sha256`);
    if (!restarts.has(artifact.restart)) fail(`${label}.restart is invalid`);
    try {
      const url = new URL(artifact.url);
      if (url.protocol !== 'https:') fail(`${label}.url must use https`);
    } catch {
      fail(`${label}.url is invalid`);
    }
    if (!artifact.compat || typeof artifact.compat !== 'object' || Array.isArray(artifact.compat)) fail(`${label}.compat must be an object`);
    if (artifact.compat.appVersion !== manifest.appVersion) fail(`${label}.compat.appVersion must match manifest appVersion`);
    if (kind === 'patch') assertString(artifact.compat.sourceCommit, `${label}.compat.sourceCommit`);
    if (kind === 'kernel') assertString(artifact.compat.kernelAbi, `${label}.compat.kernelAbi`);
    if (kind === 'component') assertString(artifact.compat.componentApi, `${label}.compat.componentApi`);
    if (!artifact.rollback || typeof artifact.rollback !== 'object' || Array.isArray(artifact.rollback)) fail(`${label}.rollback must be an object`);
    if (typeof artifact.rollback.supported !== 'boolean' || typeof artifact.rollback.receipt !== 'boolean') {
      fail(`${label}.rollback flags must be boolean`);
    }
  }
}

console.log(`incremental update manifest ok: ${manifestPath}`);
