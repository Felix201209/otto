/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression tests for the "symlinked skill folders are not discovered" bug.
 * On macOS users commonly `ln -s` a checkout of a skill repo into
 * ~/.deepv/skills/, expecting `/skill list` to pick it up. Before the fix,
 * `fs.readdir({withFileTypes:true}).isDirectory()` returned false for
 * symlinks and the skill was silently skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import {
  isDirectoryFollowingSymlinks,
  isDirectoryFollowingSymlinksSync,
  isDirentDirectoryFollowingSymlinks,
} from './fs-helpers.js';

/**
 * Create a directory symlink. Windows requires admin rights or developer mode
 * for symlinks, so we catch EPERM and allow tests to be skipped on that
 * platform rather than fail.
 */
async function trySymlinkDir(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, 'dir');
    return true;
  } catch (err: any) {
    if (err.code === 'EPERM' || err.code === 'ENOSYS') {
      return false;
    }
    throw err;
  }
}

describe('fs-helpers (symlink follow)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = path.join(
      os.tmpdir(),
      `deepv-fs-helpers-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await fs.ensureDir(tmpRoot);
  });

  afterEach(async () => {
    await fs.remove(tmpRoot);
  });

  describe('isDirectoryFollowingSymlinks', () => {
    it('returns true for a real directory', async () => {
      const dir = path.join(tmpRoot, 'real');
      await fs.ensureDir(dir);
      expect(await isDirectoryFollowingSymlinks(dir)).toBe(true);
    });

    it('returns false for a regular file', async () => {
      const file = path.join(tmpRoot, 'file.txt');
      await fs.writeFile(file, 'hi');
      expect(await isDirectoryFollowingSymlinks(file)).toBe(false);
    });

    it('returns false for a non-existent path', async () => {
      expect(
        await isDirectoryFollowingSymlinks(path.join(tmpRoot, 'nope')),
      ).toBe(false);
    });

    it('returns true for a symlink pointing at a directory', async () => {
      const target = path.join(tmpRoot, 'target-dir');
      const link = path.join(tmpRoot, 'link-dir');
      await fs.ensureDir(target);
      const ok = await trySymlinkDir(target, link);
      if (!ok) return; // platform does not allow symlinks (e.g. Windows without dev mode)

      expect(await isDirectoryFollowingSymlinks(link)).toBe(true);
    });

    it('returns false for a broken symlink', async () => {
      const link = path.join(tmpRoot, 'broken-link');
      const ok = await trySymlinkDir(
        path.join(tmpRoot, 'does-not-exist'),
        link,
      );
      if (!ok) return;

      expect(await isDirectoryFollowingSymlinks(link)).toBe(false);
    });
  });

  describe('isDirectoryFollowingSymlinksSync', () => {
    it('returns true for a real directory', () => {
      const dir = path.join(tmpRoot, 'real-sync');
      fs.ensureDirSync(dir);
      expect(isDirectoryFollowingSymlinksSync(dir)).toBe(true);
    });

    it('returns true for a symlink to a directory', async () => {
      const target = path.join(tmpRoot, 'target-sync');
      const link = path.join(tmpRoot, 'link-sync');
      await fs.ensureDir(target);
      const ok = await trySymlinkDir(target, link);
      if (!ok) return;
      expect(isDirectoryFollowingSymlinksSync(link)).toBe(true);
    });

    it('returns false on error (missing path)', () => {
      expect(
        isDirectoryFollowingSymlinksSync(path.join(tmpRoot, 'nothing-here')),
      ).toBe(false);
    });
  });

  describe('isDirentDirectoryFollowingSymlinks', () => {
    it('treats plain directory entries as directories', async () => {
      const dir = path.join(tmpRoot, 'plain');
      await fs.ensureDir(dir);
      const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
      const entry = entries.find((e) => e.name === 'plain');
      expect(entry).toBeDefined();
      expect(
        await isDirentDirectoryFollowingSymlinks(entry!, tmpRoot),
      ).toBe(true);
    });

    it('treats symlink-to-directory entries as directories', async () => {
      const target = path.join(tmpRoot, 'target');
      const link = path.join(tmpRoot, 'link');
      await fs.ensureDir(target);
      const ok = await trySymlinkDir(target, link);
      if (!ok) return;

      const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
      const entry = entries.find((e) => e.name === 'link');
      expect(entry).toBeDefined();

      // Sanity: Dirent reports isDirectory()=false for symlinks, that's the
      // whole reason this helper exists.
      expect(entry!.isDirectory()).toBe(false);
      expect(entry!.isSymbolicLink()).toBe(true);

      // But our helper should treat it as a directory:
      expect(
        await isDirentDirectoryFollowingSymlinks(entry!, tmpRoot),
      ).toBe(true);
    });

    it('returns false for symlink pointing at a file', async () => {
      const targetFile = path.join(tmpRoot, 'file.txt');
      const link = path.join(tmpRoot, 'link-to-file');
      await fs.writeFile(targetFile, 'hi');
      try {
        await fs.symlink(targetFile, link, 'file');
      } catch (err: any) {
        if (err.code === 'EPERM' || err.code === 'ENOSYS') return;
        throw err;
      }

      const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
      const entry = entries.find((e) => e.name === 'link-to-file')!;
      expect(
        await isDirentDirectoryFollowingSymlinks(entry, tmpRoot),
      ).toBe(false);
    });

    it('returns false for a regular file entry', async () => {
      const file = path.join(tmpRoot, 'plain.txt');
      await fs.writeFile(file, 'hi');
      const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
      const entry = entries.find((e) => e.name === 'plain.txt')!;
      expect(
        await isDirentDirectoryFollowingSymlinks(entry, tmpRoot),
      ).toBe(false);
    });
  });
});
