/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSandboxCompatiblePreload,
  collectStaticRequires,
  verifyPreloadBundle,
} from './verify-preload-bundle.mjs';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function preloadFixture(files) {
  const root = mkdtempSync(resolve(tmpdir(), 'otto-preload-gate-'));
  tempRoots.push(root);
  const output = resolve(root, 'dist/preload');
  mkdirSync(output, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(resolve(output, name), contents);
  }
  return resolve(output, 'index.js');
}

describe('sandboxed preload bundle gate', () => {
  it('allows Electron sandbox built-ins only', () => {
    const source = [
      'const electron = require("electron");',
      'const events = require("node:events");',
      'const timers = require("timers");',
      'const url = require("node:url");',
    ].join('\n');

    expect(collectStaticRequires(source)).toEqual([
      'electron',
      'node:events',
      'timers',
      'node:url',
    ]);
    expect(() => assertSandboxCompatiblePreload(source)).not.toThrow();
  });

  it('rejects a local CommonJS split before it reaches a release package', () => {
    const source = [
      'const electron = require("electron");',
      'const endpoint = require("./server-endpoint.js");',
    ].join('\n');

    expect(() => assertSandboxCompatiblePreload(source)).toThrow(
      'sandbox 不允许的 require: ./server-endpoint.js',
    );
  });

  it('rejects non-literal require calls because they cannot be audited safely', () => {
    expect(() => assertSandboxCompatiblePreload(
      'const dependency = require(moduleName);',
    )).toThrow('无法静态审计的 require');
  });

  it('allows one executable bundle plus webpack license metadata', () => {
    const bundle = preloadFixture({
      'index.js': 'const electron = require("electron");',
      'index.js.LICENSE.txt': 'license metadata',
    });

    expect(verifyPreloadBundle(bundle).specifiers).toEqual(['electron']);
  });

  it('rejects a second executable preload file even if both files exist', () => {
    const bundle = preloadFixture({
      'index.js': 'const electron = require("electron");',
      'server-endpoint.js': 'module.exports = {};',
    });

    expect(() => verifyPreloadBundle(bundle)).toThrow(
      'preload 输出必须只有一个可执行文件 index.js',
    );
  });
});
