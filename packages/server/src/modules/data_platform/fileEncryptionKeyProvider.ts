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
}): EncryptionKeyProvider {
  let cached: Buffer | null = null;
  return {
    getKey() {
      if (cached) return cached;
      fs.mkdirSync(path.dirname(input.keyPath), { recursive: true });
      let key: Buffer;
      try {
        key = fs.readFileSync(input.keyPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
          key = fs.readFileSync(input.keyPath);
        }
      }
      if (key.length !== input.keyBytes) {
        throw new Error(input.invalidKeyMessage);
      }
      try {
        fs.chmodSync(input.keyPath, 0o600);
      } catch {
        // Windows protects this file through the data-directory ACL.
      }
      cached = key;
      return cached;
    },
    clear() {
      cached = null;
    },
  };
}
