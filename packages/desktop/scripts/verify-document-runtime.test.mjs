/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  inspectDocumentRuntimeTarget,
  verifyBundledRuntimeTargets,
} from './verify-document-runtime.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function createRequiredRuntime(platform, arch) {
  const vendorRoot = mkdtempSync(path.join(tmpdir(), 'otto-runtime-guard-'));
  roots.push(vendorRoot);
  const root = path.join(vendorRoot, `${platform}-${arch}`);
  const files =
    platform === 'win32'
      ? [
          'python/python.exe',
          'node/node.exe',
          'libreoffice/program/soffice.exe',
        ]
      : platform === 'darwin'
        ? [
            'python/bin/python3',
            'node/bin/node',
            'libreoffice/LibreOffice.app/Contents/MacOS/soffice',
          ]
        : [
            'python/bin/python3',
            'node/bin/node',
            'libreoffice/program/soffice',
          ];
  for (const relativePath of files) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'placeholder used by static guard test');
  }
  for (const moduleName of ['docx', 'jinja2', 'markdown']) {
    mkdirSync(path.join(root, 'python', 'site-packages', moduleName), {
      recursive: true,
    });
  }
  return vendorRoot;
}

describe('document runtime packaging guard', () => {
  it('fails loud when a release target lacks required runtimes', () => {
    const vendorRoot = mkdtempSync(path.join(tmpdir(), 'otto-runtime-guard-'));
    roots.push(vendorRoot);

    expect(() =>
      verifyBundledRuntimeTargets([{ platform: 'win32', arch: 'x64' }], {
        vendorRoot,
      }),
    ).toThrow('release packaging blocked');
  });

  it('accepts only the complete required Python/Node/LibreOffice payload', () => {
    const vendorRoot = createRequiredRuntime('darwin', 'arm64');
    const report = inspectDocumentRuntimeTarget({
      vendorRoot,
      platform: 'darwin',
      arch: 'arm64',
    });

    expect(report.ready).toBe(true);
    expect(report.missingRequired).toEqual([]);
  });

  it('packages only the current platform and architecture runtime directory', () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    expect(packageJson.build.mac.extraResources).toContainEqual({
      from: 'vendor/runtime/darwin-${arch}',
      to: 'runtime/darwin-${arch}',
    });
    expect(packageJson.build.win.extraResources).toContainEqual({
      from: 'vendor/runtime/win32-${arch}',
      to: 'runtime/win32-${arch}',
    });
    expect(packageJson.build.mac.extraResources).not.toContainEqual({
      from: 'vendor/runtime',
      to: 'runtime',
    });
  });
});
