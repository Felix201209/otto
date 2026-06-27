/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import os from 'os';
import * as crypto from 'crypto';
import fs from 'node:fs';

export const OTTO_DIR = '.otto-user';
export const PROJECT_DIR_PREFIX = '.otto';

export const GOOGLE_ACCOUNTS_FILENAME = 'google_accounts.json';
const TMP_DIR_NAME = 'tmp';
const COMMANDS_DIR_NAME = 'commands';
const SKILLS_DIR_NAME = 'skills';

/**
 * Replaces the home directory with a tilde.
 * @param path - The path to tildeify.
 * @returns The tildeified path.
 */
export function tildeifyPath(path: string): string {
  const homeDir = os.homedir();
  if (path.startsWith(homeDir)) {
    return path.replace(homeDir, '~');
  }
  return path;
}

/**
 * Shortens a path string if it exceeds maxLen, prioritizing the start and end segments.
 * Example: /path/to/a/very/long/file.txt -> /path/.../long/file.txt
 */
export function shortenPath(filePath: string, maxLen: number = 35): string {
  if (filePath.length <= maxLen) {
    return filePath;
  }

  const parsedPath = path.parse(filePath);
  const root = parsedPath.root;
  const separator = path.sep;

  // Get segments of the path *after* the root
  const relativePath = filePath.substring(root.length);
  const segments = relativePath.split(separator).filter((s) => s !== ''); // Filter out empty segments

  // Handle cases with no segments after root (e.g., "/", "C:\") or only one segment
  if (segments.length <= 1) {
    // Fall back to simple start/end truncation for very short paths or single segments
    const keepLen = Math.floor((maxLen - 3) / 2);
    // Ensure keepLen is not negative if maxLen is very small
    if (keepLen <= 0) {
      return filePath.substring(0, maxLen - 3) + '...';
    }
    const start = filePath.substring(0, keepLen);
    const end = filePath.substring(filePath.length - keepLen);
    return `${start}...${end}`;
  }

  const firstDir = segments[0];
  const lastSegment = segments[segments.length - 1];
  const startComponent = root + firstDir;

  const endPartSegments: string[] = [];
  // Base length: separator + "..." + lastDir
  let currentLength = separator.length + lastSegment.length;

  // Iterate backwards through segments (excluding the first one)
  for (let i = segments.length - 2; i >= 0; i--) {
    const segment = segments[i];
    // Length needed if we add this segment: current + separator + segment
    const lengthWithSegment = currentLength + separator.length + segment.length;

    if (lengthWithSegment <= maxLen) {
      endPartSegments.unshift(segment); // Add to the beginning of the end part
      currentLength = lengthWithSegment;
    } else {
      break;
    }
  }

  let result = endPartSegments.join(separator) + separator + lastSegment;

  if (currentLength > maxLen) {
    return result;
  }

  // Construct the final path
  result = startComponent + separator + result;

  // As a final check, if the result is somehow still too long
  // truncate the result string from the beginning, prefixing with "...".
  if (result.length > maxLen) {
    return '...' + result.substring(result.length - maxLen - 3);
  }

  return result;
}

/**
 * Calculates the relative path from a root directory to a target path.
 * Ensures both paths are resolved before calculating.
 * Returns '.' if the target path is the same as the root directory.
 *
 * @param targetPath The absolute or relative path to make relative.
 * @param rootDirectory The absolute path of the directory to make the target path relative to.
 * @returns The relative path from rootDirectory to targetPath.
 */
export function makeRelative(
  targetPath: string,
  rootDirectory: string,
): string {
  const resolvedTargetPath = path.resolve(targetPath);
  const resolvedRootDirectory = path.resolve(rootDirectory);

  const relativePath = path.relative(resolvedRootDirectory, resolvedTargetPath);

  // If the paths are the same, path.relative returns '', return '.' instead
  return relativePath || '.';
}

/**
 * Escapes spaces in a file path.
 * On Windows, spaces in file paths do not need to be escaped.
 * On Unix-like systems, spaces should be escaped with backslash.
 */
export function escapePath(filePath: string): string {
  // On Windows, file paths with spaces work directly without escaping
  // Only escape on Unix-like systems (macOS, Linux)
  if (process.platform === 'win32') {
    return filePath;
  }

  let result = '';
  for (let i = 0; i < filePath.length; i++) {
    // Only escape spaces that are not already escaped.
    if (filePath[i] === ' ' && (i === 0 || filePath[i - 1] !== '\\')) {
      result += '\\ ';
    } else {
      result += filePath[i];
    }
  }
  return result;
}

/**
 * Unescapes spaces in a file path.
 */
export function unescapePath(filePath: string): string {
  return filePath.replace(/\\ /g, ' ');
}

/**
 * Generates a unique hash for a project based on its root path.
 * @param projectRoot The absolute path to the project's root directory.
 * @returns A SHA256 hash of the project root path.
 */
export function getProjectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(projectRoot).digest('hex');
}

/**
 * Generates a unique temporary directory path for a project.
 * @param projectRoot The absolute path to the project's root directory.
 * @returns The path to the project's temporary directory.
 */
export function getProjectTempDir(projectRoot: string): string {
  const hash = getProjectHash(projectRoot);
  return path.join(os.homedir(), OTTO_DIR, TMP_DIR_NAME, hash);
}

/**
 * Returns the absolute path to the user-level commands directory.
 * @returns The path to the user's commands directory.
 */
export function getUserCommandsDir(): string {
  return path.join(os.homedir(), OTTO_DIR, COMMANDS_DIR_NAME);
}

/**
 * Returns all possible user-level commands directories for compatibility.
 * @returns An array of paths to the user's commands directories.
 */
export function getUserCommandsDirs(): string[] {
  return [
    getUserCommandsDir(),
    path.join(os.homedir(), '.otto-user', COMMANDS_DIR_NAME),
    path.join(os.homedir(), '.gemini', COMMANDS_DIR_NAME),
  ];
}

/**
 * Returns the absolute path to the project-level commands directory.
 * @param projectRoot The absolute path to the project's root directory.
 * @returns The path to the project's commands directory.
 */
export function getProjectCommandsDir(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_DIR_PREFIX, COMMANDS_DIR_NAME);
}

/**
 * Returns all possible project-level commands directories for compatibility.
 * @param projectRoot The absolute path to the project's root directory.
 * @returns An array of absolute paths to the project's commands directories.
 */
export function getProjectCommandsDirs(projectRoot: string): string[] {
  return [
    getProjectCommandsDir(projectRoot),
    path.join(projectRoot, '.otto', COMMANDS_DIR_NAME),
    path.join(projectRoot, '.gemini', COMMANDS_DIR_NAME),
  ];
}

export function getProjectSkillsDir(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_DIR_PREFIX, SKILLS_DIR_NAME);
}

/**
 * Recursively copies a directory to a new location.
 */
/**
 * Recursively copies a directory to a new location with high-precision granular fault tolerance.
 */
function copyFolderRecursiveSync(source: string, target: string) {
  if (!fs.existsSync(source)) return;

  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
  } catch (err) {
    return;
  }

  let files: string[] = [];
  try {
    files = fs.readdirSync(source);
  } catch (err) {
    return;
  }

  for (const file of files) {
    const curSource = path.join(source, file);
    const curTarget = path.join(target, file);

    try {
      const stat = fs.lstatSync(curSource);
      if (stat.isDirectory()) {
        copyFolderRecursiveSync(curSource, curTarget);
      } else if (stat.isSymbolicLink()) {
        try {
          const symlinkTarget = fs.readlinkSync(curSource);
          fs.symlinkSync(symlinkTarget, curTarget);
        } catch (symlinkErr) {
          // Suppress symlink creation privilege errors in win32
        }
      } else {
        try {
          fs.copyFileSync(curSource, curTarget);
        } catch (copyErr) {
          // Suppress locks / EBUSY / EPERM on individual files in win32
        }
      }
    } catch (statErr) {
      // Suppress individual stat lookup errors
    }
  }
}

/**
 * Safely removes a folder recursively with per-file fault tolerance.
 *
 * A plain `fs.rmSync(dir, { recursive: true })` aborts the entire deletion the
 * moment it hits a single locked file. On Windows, files inside the legacy
 * `.otto` dir (logs, jwt-token, installation_id, etc.) may still be held open
 * by other early-loaded modules, causing EBUSY/EPERM and leaving the whole
 * legacy folder behind. To make a best-effort cleanup, we delete entries one by
 * one — skipping any individually locked file — and finally try to remove the
 * (now hopefully empty) directory itself.
 *
 * @returns true if the directory was fully removed, false if anything remained.
 */
function safeRemoveFolderSync(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) return true;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return false;
  }

  let allRemoved = true;
  for (const entry of entries) {
    const full = path.join(dirPath, entry);
    try {
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        if (!safeRemoveFolderSync(full)) allRemoved = false;
      } else {
        try {
          fs.rmSync(full, { force: true });
        } catch {
          // Individual file locked (EBUSY/EPERM on win32) — skip it.
          allRemoved = false;
        }
      }
    } catch {
      allRemoved = false;
    }
  }

  // Try to remove the directory itself only if it is now empty.
  if (allRemoved) {
    try {
      fs.rmdirSync(dirPath);
    } catch {
      allRemoved = false;
    }
  }
  return allRemoved;
}

/**
 * Checks whether a directory lacks real data, i.e. it is missing, empty, or
 * contains only empty subdirectories (no actual files anywhere inside).
 *
 * This is intentionally more lenient than a simple `readdirSync().length === 0`
 * check: other services (e.g. mcpSettingsService, sessionPersistence) may
 * pre-create empty placeholder subfolders like `tmp/` or `commands/` inside the
 * new directory before migration runs. If we treated those empty folders as
 * "has content", the migration of real legacy data would be wrongly skipped.
 */
function isDirWithoutRealData(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) return true;
  try {
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      const full = path.join(dirPath, entry);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        // If we cannot stat an entry, conservatively treat it as real data.
        return false;
      }
      if (stat.isDirectory()) {
        // Recurse: an empty subdirectory does not count as real data.
        if (!isDirWithoutRealData(full)) return false;
      } else {
        // Any file (or symlink) counts as real data.
        return false;
      }
    }
    return true;
  } catch (err) {
    return true;
  }
}

/**
 * Describes a single legacy -> new directory migration unit.
 */
interface LegacyMigrationUnit {
  type: 'project' | 'user' | 'global';
  legacyDir: string;
  newDir: string;
}

/**
 * Builds the list of migration units for the given project root.
 * Centralizing this ensures `needsLegacyMigration` and
 * `migrateLegacyDirectories` always agree on what should be migrated.
 */
function getLegacyMigrationUnits(projectRoot: string): LegacyMigrationUnit[] {
  const globalBaseDir = process.platform === 'win32' ? 'C:\\ProgramData' : '/etc';
  return [
    // 1. Current workspace directory configuration: .otto -> .otto
    {
      type: 'project',
      legacyDir: path.join(projectRoot, '.otto'),
      newDir: path.join(projectRoot, '.otto'),
    },
    // 2. User home directory configuration: ~/.otto -> ~/.otto-user
    {
      type: 'user',
      legacyDir: path.join(os.homedir(), '.otto'),
      newDir: path.join(os.homedir(), '.otto-user'),
    },
    // 3. System global public directory configuration: [GlobalBase]/.otto -> [GlobalBase]/.otto-global
    {
      type: 'global',
      legacyDir: path.join(globalBaseDir, '.otto'),
      newDir: path.join(globalBaseDir, '.otto-global'),
    },
  ];
}

/**
 * Returns true when at least one legacy directory still needs migrating, i.e.
 * the legacy source exists AND the new target has no real data yet.
 *
 * This shares the exact same predicate as {@link migrateLegacyDirectories} so
 * callers (e.g. the VS Code extension) can reliably show a "migration is about
 * to start" prompt and know the migration will actually run afterwards.
 */
export function needsLegacyMigration(projectRoot: string): boolean {
  return getLegacyMigrationUnits(projectRoot).some(
    (unit) => fs.existsSync(unit.legacyDir) && isDirWithoutRealData(unit.newDir),
  );
}

/**
 * Performs configuration directory migration: copies legacy directories to new names and attempts removal.
 */
export function migrateLegacyDirectories(projectRoot: string, onStart?: (type: 'project' | 'user' | 'global') => void): void {
  for (const unit of getLegacyMigrationUnits(projectRoot)) {
    if (fs.existsSync(unit.legacyDir) && isDirWithoutRealData(unit.newDir)) {
      try {
        if (onStart) onStart(unit.type);
        copyFolderRecursiveSync(unit.legacyDir, unit.newDir);
        safeRemoveFolderSync(unit.legacyDir);
      } catch (err) {
        // Ignore errors
      }
    }
  }
}