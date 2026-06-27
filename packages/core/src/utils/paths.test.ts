/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  escapePath,
  unescapePath,
  needsLegacyMigration,
  migrateLegacyDirectories,
} from './paths.js';

describe('escapePath', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    // Restore original platform
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
  });

  describe('on Windows (win32)', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true,
      });
    });

    it('should NOT escape spaces in file paths on Windows', () => {
      expect(escapePath('文件名 有空格.docx')).toBe('文件名 有空格.docx');
      expect(escapePath('file with spaces.txt')).toBe('file with spaces.txt');
      expect(escapePath('My Documents\\file.txt')).toBe('My Documents\\file.txt');
    });

    it('should return paths unchanged on Windows', () => {
      expect(escapePath('normal-file.txt')).toBe('normal-file.txt');
      expect(escapePath('文件名.docx')).toBe('文件名.docx');
    });

    it('should handle paths with multiple spaces on Windows', () => {
      expect(escapePath('文件名   有空格.docx')).toBe('文件名   有空格.docx');
    });
  });

  describe('on Unix-like systems (darwin, linux)', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
        configurable: true,
      });
    });

    it('should escape spaces in file paths on Unix-like systems', () => {
      expect(escapePath('file with spaces.txt')).toBe('file\\ with\\ spaces.txt');
      expect(escapePath('文件名 有空格.docx')).toBe('文件名\\ 有空格.docx');
    });

    it('should not double-escape already escaped spaces', () => {
      expect(escapePath('file\\ with\\ spaces.txt')).toBe('file\\ with\\ spaces.txt');
    });

    it('should handle paths with multiple consecutive spaces', () => {
      expect(escapePath('file   name.txt')).toBe('file\\ \\ \\ name.txt');
    });

    it('should not escape paths without spaces', () => {
      expect(escapePath('normal-file.txt')).toBe('normal-file.txt');
    });
  });
});

describe('unescapePath', () => {
  it('should unescape backslash-escaped spaces', () => {
    expect(unescapePath('file\\ with\\ spaces.txt')).toBe('file with spaces.txt');
    expect(unescapePath('文件名\\ 有空格.docx')).toBe('文件名 有空格.docx');
  });

  it('should handle multiple consecutive escaped spaces', () => {
    expect(unescapePath('文件名\\ \\ \\ 有空格.docx')).toBe('文件名   有空格.docx');
  });

  it('should not modify paths without escaped spaces', () => {
    expect(unescapePath('normal-file.txt')).toBe('normal-file.txt');
    expect(unescapePath('file with spaces.txt')).toBe('file with spaces.txt');
  });

  it('should preserve backslashes that are not escaping spaces', () => {
    expect(unescapePath('path\\to\\file.txt')).toBe('path\\to\\file.txt');
  });

  it('should work with @ symbol prefix', () => {
    expect(unescapePath('@file\\ name.txt')).toBe('@file name.txt');
    expect(unescapePath('@文件名\\ 有空格.docx')).toBe('@文件名 有空格.docx');
  });
});

describe('escapePath and unescapePath integration', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
  });

  describe('on Windows', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true,
      });
    });

    it('should maintain path integrity through escape/unescape cycle', () => {
      const originalPath = '文件名   有空格.docx';
      const escaped = escapePath(originalPath);
      const unescaped = unescapePath(escaped);

      expect(escaped).toBe(originalPath); // No escaping on Windows
      expect(unescaped).toBe(originalPath); // Should remain unchanged
    });

    it('should handle @ command workflow correctly', () => {
      const userInput = '@文件名 有空格.docx';
      const pathPart = userInput.substring(1);
      const escaped = escapePath(pathPart);
      const finalPath = unescapePath('@' + escaped).substring(1);

      expect(finalPath).toBe(pathPart); // Path should be preserved
    });
  });

  describe('on Unix-like systems', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
        configurable: true,
      });
    });

    it('should maintain path integrity through escape/unescape cycle', () => {
      const originalPath = 'file with spaces.txt';
      const escaped = escapePath(originalPath);
      const unescaped = unescapePath(escaped);

      expect(escaped).toBe('file\\ with\\ spaces.txt');
      expect(unescaped).toBe(originalPath); // Should restore to original
    });
  });
});

describe('legacy directory migration', () => {
  let sandbox: string;
  let fakeHome: string;
  let projectRoot: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-paths-test-'));
    fakeHome = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    // Redirect os.homedir() to the sandbox via env vars (works cross-platform
    // and avoids ESM module-namespace spy limitations). This isolates the
    // user/global migration units from the developer's real ~/.otto.
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // NOTE: The project/user/global units share the exact same predicate via
  // getLegacyMigrationUnits. After the brand rename the project unit collapsed
  // to .otto -> .otto (legacy === new), so it can no longer exercise a real
  // migration. The only unit with a distinct legacy source is the user unit
  // (~/.otto -> ~/.otto-user). os.homedir() is redirected to the sandbox via
  // HOME/USERPROFILE, so these tests drive the user-level unit safely without
  // touching the developer's real ~/.otto.
  const legacyUserDir = () => path.join(fakeHome, '.otto');
  const newUserDir = () => path.join(fakeHome, '.otto-user');

  describe('needsLegacyMigration', () => {
    it('returns false when no legacy directories exist', () => {
      expect(needsLegacyMigration(projectRoot)).toBe(false);
    });

    it('returns true when legacy user dir (.otto) has real data', () => {
      fs.mkdirSync(legacyUserDir(), { recursive: true });
      fs.writeFileSync(path.join(legacyUserDir(), 'settings.json'), '{}');
      expect(needsLegacyMigration(projectRoot)).toBe(true);
    });

    it('returns false when new dir already contains real files', () => {
      fs.mkdirSync(legacyUserDir(), { recursive: true });
      fs.writeFileSync(path.join(legacyUserDir(), 'a.json'), '{}');
      // New dir already has real content -> migration must NOT be needed.
      fs.mkdirSync(newUserDir(), { recursive: true });
      fs.writeFileSync(path.join(newUserDir(), 'settings.json'), '{}');
      expect(needsLegacyMigration(projectRoot)).toBe(false);
    });

    it('returns true when new dir exists but only has empty placeholder subdirs', () => {
      fs.mkdirSync(legacyUserDir(), { recursive: true });
      fs.writeFileSync(path.join(legacyUserDir(), 'a.json'), '{}');
      // Other services may pre-create empty subfolders before migration runs.
      fs.mkdirSync(path.join(newUserDir(), 'tmp'), { recursive: true });
      fs.mkdirSync(path.join(newUserDir(), 'commands'), { recursive: true });
      expect(needsLegacyMigration(projectRoot)).toBe(true);
    });
  });

  describe('needsLegacyMigration vs migrateLegacyDirectories consistency', () => {
    it('migration actually copies data whenever needsLegacyMigration is true', () => {
      const legacyDir = legacyUserDir();
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'settings.json'), '{"a":1}');
      fs.mkdirSync(path.join(legacyDir, 'commands'), { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'commands', 'c.md'), 'cmd');
      // Pre-create empty placeholder to mimic the real-world race condition.
      fs.mkdirSync(path.join(newUserDir(), 'tmp'), { recursive: true });

      expect(needsLegacyMigration(projectRoot)).toBe(true);

      const fired: string[] = [];
      migrateLegacyDirectories(projectRoot, (type) => fired.push(type));

      const newDir = newUserDir();
      expect(fired).toContain('user');
      expect(fs.existsSync(path.join(newDir, 'settings.json'))).toBe(true);
      expect(fs.existsSync(path.join(newDir, 'commands', 'c.md'))).toBe(true);
      // Legacy dir should be cleaned up after a successful migration.
      expect(fs.existsSync(legacyDir)).toBe(false);
      // After a successful migration there should be nothing left to migrate.
      expect(needsLegacyMigration(projectRoot)).toBe(false);
    });

    it('does nothing and stays false when there is no legacy data', () => {
      expect(needsLegacyMigration(projectRoot)).toBe(false);
      const fired: string[] = [];
      migrateLegacyDirectories(projectRoot, (type) => fired.push(type));
      expect(fired).toEqual([]);
      expect(needsLegacyMigration(projectRoot)).toBe(false);
    });
  });
});
