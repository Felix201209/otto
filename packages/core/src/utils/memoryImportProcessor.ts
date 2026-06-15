/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import { realpathSync } from 'fs';
import * as path from 'path';

// Simple console logger for import processing
const logger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any[]) =>
    console.debug('[DEBUG] [ImportProcessor]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...args: any[]) => console.warn('[WARN] [ImportProcessor]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any[]) =>
    console.error('[ERROR] [ImportProcessor]', ...args),
};

/**
 * Interface for tracking import processing state to prevent circular imports
 */
interface ImportState {
  processedFiles: Set<string>;
  maxDepth: number;
  currentDepth: number;
  currentFile?: string; // Track the current file being processed
  // Global set of files already read across the entire import tree.
  // Shared by reference across all recursive branches so each file is
  // processed at most once, preventing exponential re-reads (DoS).
  visitedFiles?: Set<string>;
}

/**
 * Processes import statements in GEMINI.md content
 * Supports @path/to/file.md syntax for importing content from other files
 *
 * @param content - The content to process for imports
 * @param basePath - The directory path where the current file is located
 * @param debugMode - Whether to enable debug logging
 * @param importState - State tracking for circular import prevention
 * @returns Processed content with imports resolved
 */
export async function processImports(
  content: string,
  basePath: string,
  debugMode: boolean = false,
  importState: ImportState = {
    processedFiles: new Set(),
    maxDepth: 10,
    currentDepth: 0,
  },
): Promise<string> {
  // Lazily initialize the tree-wide visited set on first entry so it is
  // shared by reference across every recursive branch (deduplication).
  if (!importState.visitedFiles) {
    importState.visitedFiles = new Set<string>();
  }
  const visitedFiles = importState.visitedFiles;

  if (importState.currentDepth >= importState.maxDepth) {
    if (debugMode) {
      logger.warn(
        `Maximum import depth (${importState.maxDepth}) reached. Stopping import processing.`,
      );
    }
    return content;
  }

  // Regex to match @path/to/file imports (supports any file extension)
  // Supports both @path/to/file.md and @./path/to/file.md syntax
  const importRegex = /@([./]?[^\s\n]+\.[^\s\n]+)/g;

  let processedContent = content;
  let match: RegExpExecArray | null;

  // Process all imports in the content
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];

    // Validate import path to prevent path traversal attacks
    if (!validateImportPath(importPath, basePath, [basePath])) {
      processedContent = processedContent.replace(
        match[0],
        `<!-- Import failed: ${importPath} - Path traversal attempt -->`,
      );
      continue;
    }

    // Check if the import is for a non-md file and warn
    if (!importPath.endsWith('.md')) {
      logger.warn(
        `Import processor only supports .md files. Attempting to import non-md file: ${importPath}. This will fail.`,
      );
      // Replace the import with a warning comment
      processedContent = processedContent.replace(
        match[0],
        `<!-- Import failed: ${importPath} - Only .md files are supported -->`,
      );
      continue;
    }

    const fullPath = path.resolve(basePath, importPath);

    if (debugMode) {
      logger.debug(`Processing import: ${importPath} -> ${fullPath}`);
    }

    // Check for circular imports - if we're already processing this file
    if (importState.currentFile === fullPath) {
      if (debugMode) {
        logger.warn(`Circular import detected: ${importPath}`);
      }
      // Replace the import with a warning comment
      processedContent = processedContent.replace(
        match[0],
        `<!-- Circular import detected: ${importPath} -->`,
      );
      continue;
    }

    // Check if we've already processed this file in this import chain
    if (importState.processedFiles.has(fullPath)) {
      if (debugMode) {
        logger.warn(`File already processed in this chain: ${importPath}`);
      }
      // Replace the import with a warning comment
      processedContent = processedContent.replace(
        match[0],
        `<!-- File already processed: ${importPath} -->`,
      );
      continue;
    }

    // Check for potential circular imports by looking at the import chain
    if (importState.currentFile) {
      const currentFileDir = path.dirname(importState.currentFile);
      const potentialCircularPath = path.resolve(currentFileDir, importPath);
      if (potentialCircularPath === importState.currentFile) {
        if (debugMode) {
          logger.warn(`Circular import detected: ${importPath}`);
        }
        // Replace the import with a warning comment
        processedContent = processedContent.replace(
          match[0],
          `<!-- Circular import detected: ${importPath} -->`,
        );
        continue;
      }
    }

    // Tree-wide deduplication: if this file was already read anywhere in the
    // import tree, skip re-reading it. Sibling branches share this set by
    // reference, so a file referenced N times is processed only once,
    // preventing exponential expansion (DoS).
    if (visitedFiles.has(fullPath)) {
      if (debugMode) {
        logger.warn(`File already imported in this tree: ${importPath}`);
      }
      processedContent = processedContent.replace(
        match[0],
        `<!-- File already processed: ${importPath} -->`,
      );
      continue;
    }

    try {
      // Check if the file exists
      await fs.access(fullPath);

      // Mark as visited before reading so concurrent/recursive references
      // cannot trigger a second read of the same file.
      visitedFiles.add(fullPath);

      // Read the imported file content
      const importedContent = await fs.readFile(fullPath, 'utf-8');

      if (debugMode) {
        logger.debug(`Successfully read imported file: ${fullPath}`);
      }

      // Recursively process imports in the imported content
      const processedImportedContent = await processImports(
        importedContent,
        path.dirname(fullPath),
        debugMode,
        {
          ...importState,
          processedFiles: new Set([...importState.processedFiles, fullPath]),
          currentDepth: importState.currentDepth + 1,
          currentFile: fullPath, // Set the current file being processed
          visitedFiles, // Share the tree-wide visited set by reference
        },
      );

      // Replace the import statement with the processed content
      processedContent = processedContent.replace(
        match[0],
        `<!-- Imported from: ${importPath} -->\n${processedImportedContent}\n<!-- End of import from: ${importPath} -->`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (debugMode) {
        logger.error(`Failed to import ${importPath}: ${errorMessage}`);
      }

      // Replace the import with an error comment
      processedContent = processedContent.replace(
        match[0],
        `<!-- Import failed: ${importPath} - ${errorMessage} -->`,
      );
    }
  }

  return processedContent;
}

/**
 * Validates import paths to ensure they are safe and within allowed directories
 *
 * @param importPath - The import path to validate
 * @param basePath - The base directory for resolving relative paths
 * @param allowedDirectories - Array of allowed directory paths
 * @returns Whether the import path is valid
 */
export function validateImportPath(
  importPath: string,
  basePath: string,
  allowedDirectories: string[],
): boolean {
  // Reject URLs
  if (/^(file|https?):\/\//.test(importPath)) {
    return false;
  }

  const resolvedPath = path.resolve(basePath, importPath);

  // Normalize the target through the real filesystem when it exists, so that
  // symlinks are resolved before the containment check. This prevents a
  // symlink that lives inside an allowed directory from pointing outside it
  // (symlink escape). When the target does not exist yet (e.g. validation of
  // a path before creation, or unit tests with synthetic paths) realpathSync
  // throws, and we fall back to the lexically resolved path.
  const realResolvedPath = safeRealPath(resolvedPath);

  return allowedDirectories.some((allowedDir) => {
    const normalizedAllowedDir = path.resolve(allowedDir);
    const realAllowedDir = safeRealPath(normalizedAllowedDir);
    return isWithinDirectory(realResolvedPath, realAllowedDir);
  });
}

/**
 * Resolves a path through the real filesystem (following symlinks). If the
 * path does not exist or cannot be resolved, returns the input unchanged so
 * callers can still perform a lexical containment check.
 *
 * @param targetPath - The already absolute path to canonicalize
 * @returns The canonical (symlink-resolved) path, or the input on failure
 */
function safeRealPath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return targetPath;
  }
}

/**
 * Checks whether a path is contained within a directory, enforcing a path
 * separator boundary so that a sibling like "/allowed-evil" is not treated as
 * being inside "/allowed".
 *
 * @param targetPath - The absolute path to test
 * @param directory - The absolute directory that must contain it
 * @returns Whether targetPath is the directory itself or a descendant of it
 */
function isWithinDirectory(targetPath: string, directory: string): boolean {
  if (targetPath === directory) {
    return true;
  }
  const withSep = directory.endsWith(path.sep)
    ? directory
    : directory + path.sep;
  return targetPath.startsWith(withSep);
}
