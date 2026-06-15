/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getGitCommitSha, getGitProjectPath } from './gitUtils.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const VALID_SHA_UPPER = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2';

// ---------------------------------------------------------------------------
// getGitCommitSha
// ---------------------------------------------------------------------------

describe('getGitCommitSha', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 40-char lowercase sha from git rev-parse HEAD', () => {
    (execSync as Mock).mockReturnValue(`${VALID_SHA}\n`);
    expect(getGitCommitSha('/some/repo')).toBe(VALID_SHA);
  });

  it('normalises uppercase sha to lowercase', () => {
    (execSync as Mock).mockReturnValue(`${VALID_SHA_UPPER}\n`);
    expect(getGitCommitSha('/some/repo')).toBe(VALID_SHA_UPPER.toLowerCase());
  });

  it('falls back to reading .git/HEAD (detached HEAD) when git command fails', () => {
    (execSync as Mock).mockImplementation(() => {
      throw new Error('git not found');
    });
    (fs.existsSync as Mock).mockImplementation((p: unknown) =>
      String(p).endsWith('.git'),
    );
    (fs.statSync as Mock).mockReturnValue({
      isDirectory: () => true,
      isFile: () => false,
    });
    (fs.readFileSync as Mock).mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith('HEAD')) return `${VALID_SHA}\n`;
      throw new Error(`unexpected read: ${String(filePath)}`);
    });

    expect(getGitCommitSha('/some/repo')).toBe(VALID_SHA);
  });

  it('falls back to resolving symbolic ref when git command fails', () => {
    (execSync as Mock).mockImplementation(() => {
      throw new Error('git not found');
    });
    (fs.existsSync as Mock).mockImplementation((p: unknown) =>
      String(p).endsWith('.git'),
    );
    (fs.statSync as Mock).mockReturnValue({
      isDirectory: () => true,
      isFile: () => false,
    });
    (fs.readFileSync as Mock).mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.endsWith('HEAD')) return 'ref: refs/heads/main\n';
      if (p.endsWith(path.join('refs', 'heads', 'main'))) return `${VALID_SHA}\n`;
      throw new Error(`unexpected read: ${p}`);
    });

    expect(getGitCommitSha('/some/repo')).toBe(VALID_SHA);
  });

  it('returns null in a non-git directory without throwing', () => {
    (execSync as Mock).mockImplementation(() => {
      throw new Error('not a git repo');
    });
    (fs.existsSync as Mock).mockReturnValue(false);

    expect(() => getGitCommitSha('/not/a/repo')).not.toThrow();
    expect(getGitCommitSha('/not/a/repo')).toBeNull();
  });

  it('returns null when git outputs an invalid (non-hex) string', () => {
    (execSync as Mock).mockReturnValue('HEAD\n');
    (fs.existsSync as Mock).mockReturnValue(false);

    expect(getGitCommitSha('/some/repo')).toBeNull();
  });

  it('returns null when ref file does not contain a valid sha', () => {
    (execSync as Mock).mockImplementation(() => {
      throw new Error('git not found');
    });
    (fs.existsSync as Mock).mockImplementation((p: unknown) =>
      String(p).endsWith('.git'),
    );
    (fs.statSync as Mock).mockReturnValue({
      isDirectory: () => true,
      isFile: () => false,
    });
    (fs.readFileSync as Mock).mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.endsWith('HEAD')) return 'ref: refs/heads/main\n';
      if (p.includes('refs')) return 'not-a-sha\n';
      throw new Error(`unexpected read: ${p}`);
    });

    expect(getGitCommitSha('/some/repo')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getGitProjectPath
// ---------------------------------------------------------------------------

describe('getGitProjectPath', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockGitRemoteOutput(output: string) {
    (execSync as Mock).mockReturnValue(output);
  }

  it('parses HTTPS remote URL with .git suffix', () => {
    mockGitRemoteOutput(
      'origin\thttps://gitlab.example.com/payment/refund-service.git (fetch)\n' +
        'origin\thttps://gitlab.example.com/payment/refund-service.git (push)\n',
    );
    expect(getGitProjectPath('/some/repo')).toBe('payment/refund-service');
  });

  it('parses HTTPS remote URL without .git suffix', () => {
    mockGitRemoteOutput(
      'origin\thttps://github.com/OrionStarAI/DeepVCode (fetch)\n',
    );
    expect(getGitProjectPath('/some/repo')).toBe('OrionStarAI/DeepVCode');
  });

  it('parses SSH remote URL (colon syntax) with .git suffix', () => {
    mockGitRemoteOutput(
      'origin\tgit@gitlab.example.com:payment/refund-service.git (fetch)\n',
    );
    expect(getGitProjectPath('/some/repo')).toBe('payment/refund-service');
  });

  it('parses SSH remote URL (colon syntax) without .git suffix', () => {
    mockGitRemoteOutput(
      'origin\tgit@github.com:OrionStarAI/DeepVCode (fetch)\n',
    );
    expect(getGitProjectPath('/some/repo')).toBe('OrionStarAI/DeepVCode');
  });

  it('parses SSH remote URL with multi-level subgroup path', () => {
    mockGitRemoteOutput(
      'origin\tgit@gitlab.example.com:group/DeepVCode/DeepVcodeClient.git (fetch)\n',
    );
    expect(getGitProjectPath('/some/repo')).toBe('group/DeepVCode/DeepVcodeClient');
  });

  it('falls back to first remote when origin is absent', () => {
    mockGitRemoteOutput(
      'upstream\thttps://gitlab.example.com/ns/myrepo.git (fetch)\n',
    );
    expect(getGitProjectPath('/some/repo')).toBe('ns/myrepo');
  });

  it('returns null when no remotes exist without throwing', () => {
    (execSync as Mock).mockImplementation(() => {
      throw new Error('no remotes');
    });
    (fs.existsSync as Mock).mockReturnValue(false);

    expect(() => getGitProjectPath('/some/repo')).not.toThrow();
    expect(getGitProjectPath('/some/repo')).toBeNull();
  });

  it('returns null in non-git directory without throwing', () => {
    (execSync as Mock).mockImplementation(() => {
      throw new Error('not a git repo');
    });
    (fs.existsSync as Mock).mockReturnValue(false);

    expect(() => getGitProjectPath('/not/a/repo')).not.toThrow();
    expect(getGitProjectPath('/not/a/repo')).toBeNull();
  });
});
