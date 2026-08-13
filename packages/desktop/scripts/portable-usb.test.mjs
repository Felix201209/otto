/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assemblePortableUsb } from './portable-usb.mjs';

describe('portable USB distribution', () => {
  it('assembles the green runtime and redirects every user directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-portable-'));
    const unpacked = path.join(root, 'release', 'win-unpacked');
    const output = path.join(root, 'Otto');
    try {
      await mkdir(unpacked, { recursive: true });
      await writeFile(path.join(unpacked, 'Otto.exe'), 'fixture');

      await assemblePortableUsb({ unpackedDir: unpacked, outputDir: output });

      const launcher = await readFile(path.join(output, '启动Otto.bat'), 'utf8');
      expect(launcher).toContain('set "OTTO_USER_DIR=%~dp0otto-data"');
      expect(launcher).toContain('set "OTTO_USER_DATA_DIR=%~dp0otto-data\\electron"');
      expect(launcher).toContain('set "USERPROFILE=%~dp0otto-home"');
      expect(launcher).toContain('"%~dp0win-unpacked\\Otto.exe"');
      await expect(readFile(path.join(output, 'win-unpacked', 'Otto.exe'))).resolves.toBeTruthy();
      await expect(readFile(path.join(output, '部署说明.md'), 'utf8')).resolves.toContain(
        'OTTO_USER_DIR',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails loudly when the unpacked executable is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-portable-'));
    try {
      await expect(
        assemblePortableUsb({
          unpackedDir: path.join(root, 'missing'),
          outputDir: path.join(root, 'Otto'),
        }),
      ).rejects.toThrow('Otto.exe');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
