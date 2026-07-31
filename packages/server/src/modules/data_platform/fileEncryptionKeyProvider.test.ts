/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createFileEncryptionKeyProvider } from './fileEncryptionKeyProvider.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-key-provider-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('file encryption key provider', () => {
  it('requires customer-managed key files to exist', () => {
    const keyPath = path.join(temporaryDirectory(), 'external', 'field.key');
    const provider = createFileEncryptionKeyProvider({
      keyPath,
      keyBytes: 32,
      invalidKeyMessage: 'invalid field key',
      createIfMissing: false,
      managePermissions: false,
    });

    expect(() => provider.getKey()).toThrow(
      'configured encryption key file does not exist',
    );
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it('clears cached key bytes without changing the key file', () => {
    const keyPath = path.join(temporaryDirectory(), 'field.key');
    const original = Buffer.alloc(32, 23);
    fs.writeFileSync(keyPath, original);
    const provider = createFileEncryptionKeyProvider({
      keyPath,
      keyBytes: 32,
      invalidKeyMessage: 'invalid field key',
    });

    const cached = provider.getKey();
    expect(cached).toEqual(original);
    provider.clear();

    expect(cached).toEqual(Buffer.alloc(32));
    expect(provider.getKey()).toEqual(original);
    expect(fs.readFileSync(keyPath)).toEqual(original);
  });
});
