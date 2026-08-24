/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleRuntimeDependencyClosure,
  collectRuntimeDependencyClosure,
} from '../runtime-dependency-bundler.mjs';

function writePackage(directory, value) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify(value)}\n`,
  );
  writeFileSync(path.join(directory, 'index.js'), 'export default true;\n');
}

describe('enterprise runtime dependency bundler', () => {
  it('copies the installed production dependency closure without dev packages', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'otto-runtime-deps-'));
    const releaseRoot = path.join(root, 'release');
    try {
      writePackage(path.join(root, 'node_modules', 'alpha'), {
        name: 'alpha',
        version: '1.0.0',
        dependencies: { beta: '2.0.0', gamma: '3.0.0' },
        optionalDependencies: { absent: '1.0.0' },
        devDependencies: { 'dev-only': '9.0.0' },
      });
      writePackage(path.join(root, 'node_modules', 'beta'), {
        name: 'beta',
        version: '2.0.0',
      });
      writePackage(
        path.join(root, 'node_modules', 'alpha', 'node_modules', 'gamma'),
        { name: 'gamma', version: '3.0.0' },
      );
      writePackage(path.join(root, 'node_modules', 'dev-only'), {
        name: 'dev-only',
        version: '9.0.0',
      });

      const closure = collectRuntimeDependencyClosure({
        repoRoot: root,
        directDependencies: ['alpha'],
      });
      expect(closure.map((item) => item.relative)).toEqual([
        'alpha',
        path.join('alpha', 'node_modules', 'gamma'),
        'beta',
      ]);

      const bundled = bundleRuntimeDependencyClosure({
        repoRoot: root,
        releaseRoot,
        directDependencies: ['alpha'],
      });
      expect(bundled.directVersions).toEqual({ alpha: '1.0.0' });
      expect(
        JSON.parse(
          readFileSync(
            path.join(releaseRoot, 'node_modules', 'beta', 'package.json'),
            'utf8',
          ),
        ).version,
      ).toBe('2.0.0');
      expect(
        existsSync(path.join(releaseRoot, 'node_modules', 'dev-only')),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
