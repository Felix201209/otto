/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSqlCipherFileRuntime,
  parseSqlCipherRuntimeMode,
} from './sqlCipherRuntime.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLCipher runtime configuration', () => {
  it('is required by default outside tests and only accepts explicit modes', () => {
    expect(parseSqlCipherRuntimeMode({ NODE_ENV: 'production' })).toBe(
      'required',
    );
    expect(parseSqlCipherRuntimeMode({ NODE_ENV: 'development' })).toBe(
      'required',
    );
    expect(parseSqlCipherRuntimeMode({ NODE_ENV: 'test' })).toBe('disabled');
    expect(
      parseSqlCipherRuntimeMode({ OTTO_DATABASE_ENCRYPTION: 'required' }),
    ).toBe('required');
    expect(parseSqlCipherRuntimeMode({ OTTO_DATABASE_ENCRYPTION: 'off' })).toBe(
      'disabled',
    );
    expect(() =>
      parseSqlCipherRuntimeMode({ OTTO_DATABASE_ENCRYPTION: 'maybe' }),
    ).toThrow(/must be required or disabled/i);
  });

  it('fails closed before database creation when custody material is absent', () => {
    const dataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-runtime-'),
    );
    temporaryDirectories.push(dataDirectory);

    expect(() =>
      createSqlCipherFileRuntime({ dataDirectory, environment: {} }),
    ).toThrow(/OTTO_DATABASE_ENCRYPTION_KEY_FILE is required/i);
    expect(fs.readdirSync(dataDirectory)).toEqual([]);
  });

  it('rejects a missing platform-native SQLCipher asset', () => {
    const dataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-runtime-'),
    );
    temporaryDirectories.push(dataDirectory);
    const keyPath = path.join(dataDirectory, 'offline.key');
    fs.writeFileSync(keyPath, Buffer.alloc(32, 5));

    expect(() =>
      createSqlCipherFileRuntime({
        dataDirectory,
        environment: {
          OTTO_DATABASE_ENCRYPTION_KEY_FILE: keyPath,
          OTTO_SQLCIPHER_NATIVE_BINDING: path.join(
            dataDirectory,
            'missing.node',
          ),
        },
      }),
    ).toThrow(/native asset is missing/i);
    expect(fs.readFileSync(keyPath)).toEqual(Buffer.alloc(32, 5));
  });
});
