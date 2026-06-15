/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isWithinRoot, type FileSystemService } from 'otto-core';
import type * as acp from '@agentclientprotocol/sdk';
import os from 'node:os';
import path from 'node:path';

/**
 * A {@link FileSystemService} that forwards text-file reads/writes to the
 * ACP client (IDE). This lets the editor's unsaved-buffer state override what
 * the filesystem would return for workspace files.
 *
 * A fallback `FileSystemService` (typically the default
 * {@link StandardFileSystemService}) is used for any path that:
 *   - escapes the session's workspace root, or
 *   - falls inside the user's global config directory (`~/.otto`), so
 *     global memory/settings stay on the actual disk even when the user
 *     runs the CLI from their home directory.
 */
export class AcpFileSystemService implements FileSystemService {
  private readonly globalDir = path.join(os.homedir(), '.otto');

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly sessionId: string,
    private readonly capabilities: acp.FileSystemCapabilities,
    private readonly fallback: FileSystemService,
    private readonly root: string,
  ) {}

  private shouldUseFallback(filePath: string): boolean {
    return (
      !isWithinRoot(filePath, this.root) ||
      isWithinRoot(filePath, this.globalDir)
    );
  }

  private normalizeFileSystemError(err: unknown): never {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes('Resource not found') ||
      message.includes('ENOENT') ||
      message.includes('does not exist') ||
      message.includes('No such file')
    ) {
      const e = new Error(message) as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    }
    throw err;
  }

  async readTextFile(filePath: string): Promise<string> {
    if (!this.capabilities.readTextFile || this.shouldUseFallback(filePath)) {
      return this.fallback.readTextFile(filePath);
    }
    try {
      const response = await this.connection.readTextFile({
        path: filePath,
        sessionId: this.sessionId,
      });
      return response.content;
    } catch (err) {
      this.normalizeFileSystemError(err);
    }
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    if (!this.capabilities.writeTextFile || this.shouldUseFallback(filePath)) {
      return this.fallback.writeTextFile(filePath, content);
    }
    try {
      await this.connection.writeTextFile({
        path: filePath,
        content,
        sessionId: this.sessionId,
      });
    } catch (err) {
      this.normalizeFileSystemError(err);
    }
  }
}
