/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface EncryptionKeyProvider {
  getKey(): Buffer;
  clear(): void;
}

export function createFileEncryptionKeyProvider(input: {
  keyPath: string;
  keyBytes: number;
  invalidKeyMessage: string;
  createIfMissing?: boolean;
  managePermissions?: boolean;
}): EncryptionKeyProvider {
  let cached: Buffer | null = null;

  function readExistingKey(): Buffer {
    const metadata = fs.lstatSync(input.keyPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('encryption key path must be a regular file');
    }
    return fs.readFileSync(input.keyPath);
  }

  return {
    getKey() {
      if (cached) return cached;
      const createIfMissing = input.createIfMissing !== false;
      if (createIfMissing) {
        fs.mkdirSync(path.dirname(input.keyPath), { recursive: true });
      }
      let key: Buffer;
      try {
        key = readExistingKey();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!createIfMissing) {
          throw new Error('configured encryption key file does not exist');
        }
        const generated = randomBytes(input.keyBytes);
        try {
          fs.writeFileSync(input.keyPath, generated, {
            flag: 'wx',
            mode: 0o600,
          });
          key = generated;
        } catch (writeError) {
          if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw writeError;
          }
          key = readExistingKey();
        }
      }
      if (key.length !== input.keyBytes) {
        throw new Error(input.invalidKeyMessage);
      }
      if (input.managePermissions !== false) {
        try {
          fs.chmodSync(input.keyPath, 0o600);
        } catch {
          // Windows protects this file through the data-directory ACL.
        }
      }
      cached = key;
      return cached;
    },
    clear() {
      cached?.fill(0);
      cached = null;
    },
  };
}
