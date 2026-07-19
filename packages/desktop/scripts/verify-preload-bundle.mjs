/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SANDBOX_REQUIRE_ALLOWLIST = new Set([
  'electron',
  'events',
  'node:events',
  'timers',
  'node:timers',
  'url',
  'node:url',
]);

/**
 * Return every statically-auditable CommonJS require specifier.
 *
 * Electron sandbox preload only exposes a tiny require polyfill. Dynamic
 * specifiers are rejected instead of being guessed or silently accepted.
 */
export function collectStaticRequires(source) {
  const specifiers = [];
  const callPattern = /(^|[^\w$])require\s*\(([^)]*)\)/g;
  let match;
  while ((match = callPattern.exec(source)) !== null) {
    const argument = match[2].trim();
    const literal = argument.match(/^(['"])([^'"\\]+)\1$/);
    if (!literal) {
      throw new Error(`无法静态审计的 require: ${argument || '(empty)'}`);
    }
    specifiers.push(literal[2]);
  }
  return specifiers;
}

export function assertSandboxCompatiblePreload(source) {
  const specifiers = collectStaticRequires(source);
  if (!specifiers.includes('electron')) {
    throw new Error('preload bundle 未保留 require("electron")，无法确认 Electron 桥');
  }
  const unsafe = [...new Set(
    specifiers.filter((specifier) => !SANDBOX_REQUIRE_ALLOWLIST.has(specifier)),
  )];
  if (unsafe.length > 0) {
    throw new Error(`sandbox 不允许的 require: ${unsafe.join(', ')}`);
  }
  return specifiers;
}

export function verifyPreloadBundle(bundlePath) {
  const absolutePath = resolve(bundlePath);
  const files = readdirSync(dirname(absolutePath))
    .filter((name) => !name.startsWith('.'))
    .sort();
  const runtimeFiles = files.filter((name) => name.endsWith('.js'));
  const unexpectedFiles = files.filter(
    (name) => name !== 'index.js' && name !== 'index.js.LICENSE.txt',
  );
  if (
    runtimeFiles.length !== 1
    || runtimeFiles[0] !== 'index.js'
    || unexpectedFiles.length > 0
  ) {
    throw new Error(
      `preload 输出必须只有一个可执行文件 index.js，实际为: ${
        files.join(', ') || '(empty)'
      }`,
    );
  }
  const source = readFileSync(absolutePath, 'utf8');
  const specifiers = assertSandboxCompatiblePreload(source);
  return { bundlePath: absolutePath, specifiers };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const defaultBundle = resolve(scriptDir, '../dist/preload/index.js');
  const result = verifyPreloadBundle(process.argv[2] ?? defaultBundle);
  console.log(
    `[preload] sandbox 单文件验证通过: ${result.bundlePath}; `
    + `requires=${JSON.stringify(result.specifiers)}`,
  );
}
