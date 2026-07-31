/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { verifySqlCipherNativeTarget } from '../verify-sqlcipher-native-assets.mjs';

const directories = [];

function fixture(input = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-native-assets-'));
  directories.push(root);
  const target = input.target ?? 'linux-x64';
  const directory = path.join(root, target);
  fs.mkdirSync(directory, { recursive: true });
  const binding =
    input.binding ?? Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
  fs.writeFileSync(path.join(directory, 'better_sqlite3.node'), binding);
  const [platform, arch] = target.split('-');
  const manifest = {
    format: 1,
    target,
    platform,
    arch,
    runtime: 'electron',
    runtimeVersion: '43.1.0',
    sqlcipherVersion: '4.16.0',
    betterSqlite3Version: '12.11.1',
    cipherSelfTest: true,
    license: 'BSD-3-Clause',
    sha256: createHash('sha256').update(binding).digest('hex'),
    ...input.manifest,
  };
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    root,
    target,
    bindingPath: path.join(directory, 'better_sqlite3.node'),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLCipher native asset gate', () => {
  it('accepts a self-tested target with matching binary identity and digest', () => {
    const input = fixture();
    expect(verifySqlCipherNativeTarget(input.root, input.target)).toMatchObject(
      {
        target: 'linux-x64',
        sqlcipherVersion: '4.16.0',
        cipherSelfTest: true,
      },
    );
  });

  it('rejects a binding replaced after its cipher self-test', () => {
    const input = fixture();
    fs.appendFileSync(input.bindingPath, 'tampered');
    expect(() => verifySqlCipherNativeTarget(input.root, input.target)).toThrow(
      /checksum does not match/i,
    );
  });

  it('rejects ordinary or wrong-platform native binaries', () => {
    const input = fixture({ binding: Buffer.from('not-an-elf') });
    expect(() => verifySqlCipherNativeTarget(input.root, input.target)).toThrow(
      /not a Linux ELF/i,
    );
  });

  it('requires a successful SQLCipher behavior self-test in the manifest', () => {
    const input = fixture({ manifest: { cipherSelfTest: false } });
    expect(() => verifySqlCipherNativeTarget(input.root, input.target)).toThrow(
      /cipherSelfTest must be true/i,
    );
  });
});
