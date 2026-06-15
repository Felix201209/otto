/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Checks if a directory is within a git repository
 * @param directory The directory to check
 * @returns true if the directory is in a git repository, false otherwise
 */
export function isGitRepository(directory: string): boolean {
  try {
    let currentDir = path.resolve(directory);

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      // Check if .git exists (either as directory or file for worktrees)
      if (fs.existsSync(gitDir)) {
        return true;
      }

      const parentDir = path.dirname(currentDir);

      // If we've reached the root directory, stop searching
      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    return false;
  } catch (_error) {
    // If any filesystem error occurs, assume not a git repo
    return false;
  }
}

/**
 * Finds the root directory of a git repository
 * @param directory Starting directory to search from
 * @returns The git repository root path, or null if not in a git repository
 */
export function findGitRoot(directory: string): string | null {
  try {
    let currentDir = path.resolve(directory);

    while (true) {
      const gitDir = path.join(currentDir, '.git');

      if (fs.existsSync(gitDir)) {
        return currentDir;
      }

      const parentDir = path.dirname(currentDir);

      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    return null;
  } catch (_error) {
    return null;
  }
}

/**
 * Resolves the actual `.git` directory for a given working directory.
 * Handles three cases:
 *   1. `.git` is a directory (normal repo)       → return it
 *   2. `.git` is a file (worktree/submodule)     → read `gitdir: <path>` pointer
 *   3. not found in cwd, walk up until repo root → return that `.git`
 * @returns Absolute path to the real .git directory, or null if not in a repo.
 */
export function resolveGitDir(directory: string): string | null {
  try {
    const root = findGitRoot(directory);
    if (!root) return null;
    const gitPath = path.join(root, '.git');
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return gitPath;
    if (stat.isFile()) {
      // worktree / submodule: contains `gitdir: <relative-or-absolute-path>`
      const content = fs.readFileSync(gitPath, 'utf-8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (!match) return null;
      const target = match[1].trim();
      return path.isAbsolute(target) ? target : path.resolve(root, target);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Minimal git INI config parser. Extracts `[remote "<name>"] url = <url>` entries.
 * Tolerant of comments, whitespace, and quoted values. Does NOT implement
 * `include.path` or conditional includes — those are rarely used for remotes.
 */
function parseGitConfigRemotes(configPath: string): Record<string, string> | null {
  try {
    const text = fs.readFileSync(configPath, 'utf-8');
    const remotes: Record<string, string> = {};
    let currentRemote: string | null = null;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;

      // Section header: [remote "origin"]  or  [section]  or  [section "sub"]
      const sectionMatch = line.match(/^\[([\w.-]+)(?:\s+"([^"]*)")?\]$/);
      if (sectionMatch) {
        currentRemote = sectionMatch[1] === 'remote' ? (sectionMatch[2] || null) : null;
        continue;
      }

      if (!currentRemote) continue;

      // Key-value: url = https://...   (key is case-insensitive per git-config)
      const kvMatch = line.match(/^(\w[\w-]*)\s*=\s*(.*)$/);
      if (!kvMatch) continue;
      if (kvMatch[1].toLowerCase() !== 'url') continue;

      let value = kvMatch[2].trim();
      // Strip inline comments (but not inside quotes)
      const hashIdx = value.search(/\s[#;]/);
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
      // Unquote
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1);
      }
      if (value) remotes[currentRemote] = sanitizeGitUrl(value);
    }

    return Object.keys(remotes).length > 0 ? remotes : null;
  } catch {
    return null;
  }
}

/**
 * Reads HEAD and resolves it to a branch name or short hash.
 * Works without invoking `git` — reads `.git/HEAD` directly.
 */
function readGitHeadBranch(gitDir: string): string | null {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    // Symbolic ref: "ref: refs/heads/main"
    const refMatch = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1].trim();
    // Detached HEAD — full hash; return short form
    if (/^[0-9a-f]{40}$/i.test(head) || /^[0-9a-f]{64}$/i.test(head)) {
      return head.slice(0, 7);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Wrapper around execSync that is more forgiving on Windows:
 *   - `windowsHide: true` prevents any console window from flashing (critical for
 *     packaged/Electron-hosted CLIs where a CMD black box would otherwise blink)
 *   - larger timeout (Windows git.exe startup is slow with AV hooks)
 *   - on Windows, re-tries under cmd.exe shell so PATHEXT (.cmd / .bat shims)
 *     is honored — still with windowsHide, so no window flashes
 */
function safeExecGit(cmd: string, cwd: string): string | null {
  const baseOpts = {
    cwd,
    encoding: 'utf-8' as const,
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    windowsHide: true, // no flashing console window on Windows
    maxBuffer: 10 * 1024 * 1024,
  };

  try {
    return execSync(cmd, baseOpts).toString().trim();
  } catch {
    // Windows fallback: some setups only expose `git.cmd` shim, which
    // CreateProcess won't resolve without a shell. `windowsHide` is inherited
    // from baseOpts and re-asserted explicitly below to guarantee no black
    // CMD window ever flashes on screen, even if baseOpts changes later.
    if (process.platform === 'win32') {
      try {
        return execSync(cmd, {
          ...baseOpts,
          shell: 'cmd.exe',
          windowsHide: true, // explicit — do not let a CMD window flash
        }).toString().trim();
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Gets all remote names and their URLs for the git repository.
 * Strips embedded credentials (userinfo) from URLs for safety.
 *
 * Strategy (with fallbacks):
 *   1. Try `git remote -v` (authoritative — respects includes, conditional config)
 *   2. On Windows, retry under cmd.exe shell (for .cmd shims)
 *   3. Parse `.git/config` directly (no git binary required, 100% fallback)
 *
 * @param directory The directory within the git repository
 * @returns A record of remote name → sanitized URL, or null if unavailable
 */
export function getGitRemotes(directory: string): Record<string, string> | null {
  // --- Strategy 1 & 2: invoke git ---
  const output = safeExecGit('git remote -v', directory);
  if (output) {
    const remotes: Record<string, string> = {};
    for (const rawLine of output.split(/\r?\n/)) {
      // Normalize: trim BOM / trailing CR / surrounding whitespace.
      const line = rawLine.replace(/^\uFEFF/, '').trim();
      if (!line) continue;
      // `git remote -v` output formats observed in the wild:
      //   "origin\thttps://github.com/org/repo.git (fetch)"         ← classic (tab)
      //   "origin https://github.com/org/repo.git (fetch)"          ← some Win builds (space)
      //   "origin  git@host:org/repo.git  (fetch)"                  ← double-space
      //   "origin\tgit@host:org/repo.git (fetch)" with trailing CR  ← CRLF terminals
      // Strategy: split on any run of whitespace into [name, url, marker].
      // Marker must be exactly "(fetch)" — we ignore "(push)" entries.
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;
      const marker = parts[parts.length - 1];
      if (marker !== '(fetch)') continue;
      const name = parts[0];
      // URL may theoretically contain whitespace in exotic cases — rejoin middle parts.
      const url = parts.slice(1, -1).join(' ');
      if (name && url) {
        remotes[name] = sanitizeGitUrl(url);
      }
    }
    if (Object.keys(remotes).length > 0) return remotes;
  }

  // --- Strategy 3: parse .git/config directly ---
  const gitDir = resolveGitDir(directory);
  if (!gitDir) return null;
  return parseGitConfigRemotes(path.join(gitDir, 'config'));
}

/**
 * Gets the current branch name of the git repository.
 * Returns the short commit hash if in detached HEAD state.
 *
 * Strategy (with fallbacks):
 *   1. `git rev-parse --abbrev-ref HEAD`
 *   2. Read `.git/HEAD` directly (no git binary required)
 *
 * @param directory The directory within the git repository
 * @returns The branch name or short hash, or null if unavailable
 */
export function getGitBranch(directory: string): string | null {
  // --- Strategy 1: invoke git ---
  const branch = safeExecGit('git rev-parse --abbrev-ref HEAD', directory);
  if (branch && branch !== 'HEAD') return branch;
  if (branch === 'HEAD') {
    // Detached — try short hash via git
    const short = safeExecGit('git rev-parse --short HEAD', directory);
    if (short) return short;
  }

  // --- Strategy 2: read .git/HEAD directly ---
  const gitDir = resolveGitDir(directory);
  if (!gitDir) return null;
  return readGitHeadBranch(gitDir);
}

/**
 * Scans immediate subdirectories for git repositories and collects their remote & branch info.
 * Used as a fallback when the current working directory itself is not a git repository,
 * but contains multiple project subdirectories that are.
 * @param directory The parent directory to scan
 * @returns Array of { name, remotes, branch } for each git-enabled subdirectory, or empty array
 */
export function getSubdirectoryGitInfos(directory: string): Array<{
  name: string;
  remotes: Record<string, string>;
  branch: string | null;
}> {
  try {
    const resolvedDir = path.resolve(directory);
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    const results: Array<{ name: string; remotes: Record<string, string>; branch: string | null }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      // 跳过含非 ASCII 字符的目录名（如中文），避免 HTTP header 中出现非 Latin-1 字符导致 ByteString 错误
      if (!/^[\x20-\x7E]+$/.test(entry.name)) continue;
      const subDir = path.join(resolvedDir, entry.name);
      const gitMarker = path.join(subDir, '.git');
      if (!fs.existsSync(gitMarker)) continue;

      const remotes = getGitRemotes(subDir);
      if (!remotes) continue;

      results.push({
        name: entry.name,
        remotes,
        branch: getGitBranch(subDir),
      });
    }
    return results;
  } catch (_error) {
    return [];
  }
}

/**
 * Gets the full 40-character commit SHA of the current HEAD.
 * Returns null (never throws) if the directory is not a git repo or git is unavailable.
 *
 * Strategy (with fallbacks):
 *   1. `git rev-parse HEAD` via execSync
 *   2. Read `.git/HEAD` directly (handles detached HEAD and no-git-binary cases)
 *
 * @param directory The working directory
 * @returns 40-character lowercase hex SHA, or null if unavailable
 */
export function getGitCommitSha(directory: string): string | null {
  // --- Strategy 1: invoke git ---
  const result = safeExecGit('git rev-parse HEAD', directory);
  if (result && /^[0-9a-f]{40}$/i.test(result)) {
    return result.toLowerCase();
  }

  // --- Strategy 2: read .git/HEAD directly ---
  try {
    const gitDir = resolveGitDir(directory);
    if (!gitDir) return null;
    const headContent = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    // Detached HEAD: HEAD contains the sha directly
    if (/^[0-9a-f]{40}$/i.test(headContent)) {
      return headContent.toLowerCase();
    }
    // Symbolic ref: resolve to the ref file
    const refMatch = headContent.match(/^ref:\s*(.+)$/);
    if (refMatch) {
      const refFile = path.join(gitDir, refMatch[1].trim());
      const refSha = fs.readFileSync(refFile, 'utf-8').trim();
      if (/^[0-9a-f]{40}$/i.test(refSha)) {
        return refSha.toLowerCase();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts a "namespace/repo" project path from the git remote origin URL.
 * Supports SSH (`git@host:ns/repo.git`) and HTTPS (`https://host/ns/repo.git`) formats.
 * Falls back to the first available remote if `origin` is absent.
 * Returns null (never throws) if no remotes exist or the URL cannot be parsed.
 *
 * @param directory The working directory
 * @returns Project path in "namespace/repo" format, or null if unavailable
 */
export function getGitProjectPath(directory: string): string | null {
  try {
    const remotes = getGitRemotes(directory);
    if (!remotes) return null;

    // Prefer origin; fall back to first remote
    const remoteUrl = remotes['origin'] ?? Object.values(remotes)[0];
    if (!remoteUrl) return null;

    // SSH format: git@gitlab.example.com:namespace/repo.git
    //             git@gitlab.example.com:/namespace/repo.git (leading slash variant)
    //             git@gitlab.example.com:group/subgroup/repo.git (multi-level subgroup)
    const sshMatch = remoteUrl.match(/:[/]?(.+?)(\.git)?$/);
    if (sshMatch && !remoteUrl.startsWith('http')) {
      return sshMatch[1].replace(/^\//, '');
    }

    // HTTPS / HTTP format: https://gitlab.example.com/namespace/repo.git
    const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/(.+?)(\.git)?$/);
    if (httpsMatch) {
      return httpsMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Removes embedded credentials from a git URL.
 * e.g. https://user:token@github.com/org/repo.git → https://github.com/org/repo.git
 * SSH URLs (git@...) are returned as-is since they don't embed passwords.
 */
function sanitizeGitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Not a standard URL (e.g. git@github.com:org/repo.git) — safe as-is
    return url;
  }
}
