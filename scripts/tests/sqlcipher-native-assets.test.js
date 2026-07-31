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
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'file',
        name: 'better_sqlite3.node',
        hashes: [
          {
            alg: 'SHA-256',
            content: createHash('sha256').update(binding).digest('hex'),
          },
        ],
      },
    },
    components: [
      { type: 'library', name: 'SQLCipher', version: '4.16.0' },
      { type: 'library', name: 'better-sqlite3', version: '12.11.1' },
    ],
    ...input.sbom,
  };
  const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, 'sbom.cdx.json'), sbomBytes);
  const manifest = {
    format: 2,
    target,
    platform,
    arch,
    runtime: 'electron',
    runtimeVersion: '43.1.0',
    sqlcipherVersion: '4.16.0',
    betterSqlite3Version: '12.11.1',
    cipherSelfTest: true,
    plainSqliteRejected: true,
    license: 'BSD-3-Clause',
    sha256: createHash('sha256').update(binding).digest('hex'),
    sbom: {
      format: 'CycloneDX',
      path: 'sbom.cdx.json',
      sha256: createHash('sha256').update(sbomBytes).digest('hex'),
    },
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
        plainSqliteRejected: true,
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

  it('requires proof that ordinary SQLite rejected the encrypted database', () => {
    const input = fixture({ manifest: { plainSqliteRejected: false } });
    expect(() => verifySqlCipherNativeTarget(input.root, input.target)).toThrow(
      /plainSqliteRejected must be true/i,
    );
  });

  it('requires a checksummed CycloneDX SBOM that identifies both native dependencies', () => {
    const missingComponent = fixture({
      sbom: {
        components: [{ type: 'library', name: 'SQLCipher', version: '4.16.0' }],
      },
    });
    expect(() =>
      verifySqlCipherNativeTarget(
        missingComponent.root,
        missingComponent.target,
      ),
    ).toThrow(/SBOM.*better-sqlite3/i);

    const tampered = fixture();
    fs.appendFileSync(
      path.join(tampered.root, tampered.target, 'sbom.cdx.json'),
      'tampered',
    );
    expect(() =>
      verifySqlCipherNativeTarget(tampered.root, tampered.target),
    ).toThrow(/SBOM checksum/i);
  });
});
