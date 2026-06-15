/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared filesystem helpers for skill / plugin directory scanning.
 *
 * Background:
 *   Node's `fs.readdir(path, { withFileTypes: true })` returns `Dirent`
 *   objects whose `isDirectory()` method returns **false** for symbolic
 *   links, even when the link target is a directory. This means any code
 *   that filters entries with `entry.isDirectory()` silently drops
 *   symlinked subdirectories — exactly the "skills in ~/.deepv/skills
 *   aren't loaded when the folder is a symlink" bug reported by users on
 *   macOS.
 *
 *   To handle this correctly we must use `fs.stat()` (NOT `fs.lstat()`),
 *   which automatically follows symlinks, and treat "isDirectory OR
 *   symlink-to-directory" as the positive case.
 *
 * These helpers centralize that behavior so callers don't have to
 * remember the distinction.
 */

import fs from 'fs-extra';
import path from 'path';

// Self-check: guard against future `import * as fs from 'fs-extra'` regressions.
// Under Node's native ESM runtime, namespace imports of CJS packages do NOT
// populate named exports, so `fs.statSync` ends up undefined. Vitest's Vite
// interop layer happens to fix this transparently, which means a unit test
// can appear green while the actual shipped binary silently fails (all
// try/catch paths return false, so every directory looks "non-directory").
// Asserting at module-load time catches that class of bug immediately.
if (typeof fs.statSync !== 'function' || typeof fs.stat !== 'function') {
  throw new Error(
    'fs-helpers: fs-extra default import did not expose statSync/stat. ' +
      'This usually means someone switched to `import * as fs from "fs-extra"`; ' +
      'use the default import instead.',
  );
}

/**
 * Returns true if `p` is a directory OR a symlink whose target is a
 * directory. Returns false on any error (missing path, permission denied,
 * broken symlink, etc.) — callers can treat errors as "skip this entry".
 */
export async function isDirectoryFollowingSymlinks(p: string): Promise<boolean> {
  try {
    // fs.stat follows symlinks (unlike fs.lstat).
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Sync variant of {@link isDirectoryFollowingSymlinks}.
 */
export function isDirectoryFollowingSymlinksSync(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Convenience wrapper: given a `Dirent` entry produced by
 * `readdir(..., { withFileTypes: true })` (and its parent directory), resolve
 * whether it represents a directory — transparently following symlinks.
 *
 * Plain directories return immediately; symlinks trigger a single
 * `fs.stat()` to resolve the target.
 */
export async function isDirentDirectoryFollowingSymlinks(
  entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean },
  parentDir: string,
): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  return isDirectoryFollowingSymlinks(path.join(parentDir, entry.name));
}
