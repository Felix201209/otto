/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';

/**
 * Interface for text file read/write operations.
 *
 * This is the hook point that lets ACP (or other) clients substitute their
 * own implementation — e.g. a client-backed provider that delegates reads and
 * writes to the editor so unsaved buffer state is honored.
 *
 * NOTE: Do not confuse with {@link FileDiscoveryService}, which handles
 * gitignore/deepvignore discovery and filtering. The names are historical.
 */
export interface FileSystemService {
  /**
   * Read the text content of a file as UTF-8.
   *
   * @param filePath Absolute path to the file to read.
   */
  readTextFile(filePath: string): Promise<string>;

  /**
   * Write UTF-8 text content to a file, creating or overwriting it.
   *
   * @param filePath Absolute path to the file to write.
   * @param content  File contents.
   */
  writeTextFile(filePath: string, content: string): Promise<void>;
}

/**
 * Default implementation that delegates directly to Node's `fs/promises`.
 * Used whenever no client-backed provider is installed.
 */
export class StandardFileSystemService implements FileSystemService {
  async readTextFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8');
  }
}
