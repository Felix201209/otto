/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  buildBundledPythonEnvironment,
  inspectBundledDocumentRuntime,
  resolveDocumentRuntime,
} from './bundledRuntime.js';

describe('bundled document runtime', () => {
  it('prefers the packaged resourcesPath runtime over a PATH fallback', () => {
    const resourcesPath = path.join(
      '/Applications',
      'Otto.app',
      'Contents',
      'Resources',
    );
    const bundledPython = path.join(
      resourcesPath,
      'runtime',
      'darwin-arm64',
      'python',
      'bin',
      'python3',
    );

    const result = resolveDocumentRuntime('python', {
      resourcesPath,
      platform: 'darwin',
      arch: 'arm64',
      pathExists: (candidate) => candidate === bundledPython,
    });

    expect(result).toEqual(
      expect.objectContaining({
        executable: bundledPython,
        source: 'bundled',
      }),
    );
    expect(result.pythonSitePackages).toBe(
      path.join(
        resourcesPath,
        'runtime',
        'darwin-arm64',
        'python',
        'site-packages',
      ),
    );
  });

  it('falls back to platform commands when packaged resources are absent', () => {
    expect(
      resolveDocumentRuntime('python', {
        platform: 'win32',
        arch: 'x64',
        pathExists: () => false,
      }),
    ).toEqual({ executable: 'python', source: 'system' });
    expect(
      resolveDocumentRuntime('libreoffice', {
        platform: 'linux',
        arch: 'x64',
        pathExists: () => false,
      }),
    ).toEqual({ executable: 'libreoffice', source: 'system' });
  });

  it('adds bundled Python packages without discarding the caller environment', () => {
    const resolution = {
      executable: '/runtime/python/bin/python3',
      source: 'bundled' as const,
      pythonSitePackages: '/runtime/python/site-packages',
    };
    const env = buildBundledPythonEnvironment(resolution, {
      PATH: '/usr/bin',
      PYTHONPATH: '/company/python',
      KEEP_ME: 'yes',
    });

    expect(env.KEEP_ME).toBe('yes');
    expect(env.PYTHONPATH).toBe(
      ['/runtime/python/site-packages', '/company/python'].join(path.delimiter),
    );
  });

  it('fails loud for every required packaged component including LibreOffice', () => {
    const root = path.join('/runtime', 'win32-x64');
    const present = new Set([path.join(root, 'python', 'python.exe')]);

    const report = inspectBundledDocumentRuntime({
      runtimeRoot: root,
      platform: 'win32',
      arch: 'x64',
      pathExists: (candidate) => present.has(candidate),
    });

    expect(report.ready).toBe(false);
    expect(report.missingRequired).toEqual(
      expect.arrayContaining([
        'node executable',
        'python site-packages/docx',
        'python site-packages/jinja2',
        'python site-packages/markdown',
        'python site-packages/fpdf',
        'LibreOffice executable',
      ]),
    );
    expect(report.message).toContain('打包必须失败');
  });
});
