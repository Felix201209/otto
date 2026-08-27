/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REQUIRED_SQLCIPHER_NODE_TARGETS,
  REQUIRED_SQLCIPHER_TARGETS,
  verifySqlCipherMatrixManifest,
  verifySqlCipherNativeAssets,
  verifySqlCipherNativeTarget,
  writeSqlCipherMatrixManifest,
} from '../verify-sqlcipher-native-assets.mjs';

const directories = [];

function fixture(input = {}) {
  const root =
    input.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'otto-native-assets-'));
  if (!input.root) directories.push(root);
  const target = input.target ?? 'linux-x64';
  const directory = path.join(root, target);
  fs.mkdirSync(directory, { recursive: true });
  const [platform, arch] = target.split('-');
  const nativeMagic =
    platform === 'win32'
      ? Buffer.from('MZ')
      : platform === 'darwin'
        ? Buffer.from('cffaedfe', 'hex')
        : Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  const binding =
    input.binding ?? Buffer.concat([nativeMagic, Buffer.from([1, 2, 3])]);
  fs.writeFileSync(path.join(directory, 'better_sqlite3.node'), binding);
  const buildCommit = input.manifest?.buildCommit ?? 'a'.repeat(40);
  const sourceRevision = input.manifest?.sourceRevision ?? 'b'.repeat(40);
  const runtime = input.runtime ?? input.manifest?.runtime ?? 'electron';
  const runtimeVersion = runtime === 'node' ? '22.23.1' : '43.1.0';
  const moduleAbi = runtime === 'node' ? '127' : '145';
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      properties: [
        { name: 'otto:target', value: target },
        { name: 'otto:buildCommit', value: buildCommit },
        { name: 'otto:sourceRevision', value: sourceRevision },
        { name: 'otto:runtime', value: runtime },
        { name: `otto:${runtime}Version`, value: runtimeVersion },
        { name: `otto:${runtime}ModuleAbi`, value: moduleAbi },
      ],
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
  const notices = Buffer.from('SQLCipher BSD-3-Clause\n');
  fs.writeFileSync(path.join(directory, 'THIRD_PARTY_NOTICES.md'), notices);
  const manifest = {
    format: 3,
    target,
    platform,
    arch,
    runtime,
    runtimeVersion,
    sqlcipherVersion: '4.16.0',
    betterSqlite3Version: '12.11.1',
    cipherSelfTest: true,
    plainSqliteRejected: true,
    license: 'BSD-3-Clause',
    source: 'https://github.com/sqlcipher/sqlcipher',
    sourceRevision,
    buildCommit,
    toolchain: {
      nodeVersion: runtime === 'node' ? runtimeVersion : '24.17.0',
      ...(runtime === 'node'
        ? { nodeModuleAbi: moduleAbi }
        : { electronVersion: runtimeVersion, electronModuleAbi: moduleAbi }),
      opensslVersion: '3.5.2',
    },
    sha256: createHash('sha256').update(binding).digest('hex'),
    notices: {
      path: 'THIRD_PARTY_NOTICES.md',
      sha256: createHash('sha256').update(notices).digest('hex'),
    },
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

  it('accepts a Node.js ABI asset and locks the exact two-target Linux server matrix', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-node-native-matrix-'),
    );
    directories.push(root);
    for (const target of REQUIRED_SQLCIPHER_NODE_TARGETS) {
      fixture({ root, target, runtime: 'node' });
    }
    const verified = verifySqlCipherNativeAssets(
      root,
      REQUIRED_SQLCIPHER_NODE_TARGETS,
      { runtime: 'node', expectedRuntimeVersion: '22.23.1' },
    );
    writeSqlCipherMatrixManifest(root, verified);
    expect(
      verifySqlCipherMatrixManifest(root, verified).manifest,
    ).toMatchObject({
      runtime: 'node',
      runtimeVersion: '22.23.1',
      targets: REQUIRED_SQLCIPHER_NODE_TARGETS,
    });
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

  it('rejects mutable source identities and cross-commit asset substitution', () => {
    const mutableSource = fixture({
      manifest: { sourceRevision: 'v4.16.0' },
    });
    expect(() =>
      verifySqlCipherNativeTarget(mutableSource.root, mutableSource.target),
    ).toThrow(/immutable Git commit/i);

    const wrongCommit = fixture();
    expect(() =>
      verifySqlCipherNativeTarget(wrongCommit.root, wrongCommit.target, {
        expectedBuildCommit: 'c'.repeat(40),
      }),
    ).toThrow(/buildCommit must be/i);
  });

  it('writes and verifies an exact, same-commit five-target matrix manifest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-native-matrix-'));
    directories.push(root);
    for (const target of REQUIRED_SQLCIPHER_TARGETS) {
      fixture({ root, target });
    }
    const verified = verifySqlCipherNativeAssets(
      root,
      REQUIRED_SQLCIPHER_TARGETS,
    );
    writeSqlCipherMatrixManifest(root, verified);
    expect(
      verifySqlCipherMatrixManifest(root, verified).manifest,
    ).toMatchObject({
      buildCommit: 'a'.repeat(40),
      sourceRevision: 'b'.repeat(40),
      targets: REQUIRED_SQLCIPHER_TARGETS,
    });

    fs.appendFileSync(
      path.join(root, 'linux-x64', 'better_sqlite3.node'),
      'tampered',
    );
    expect(() => verifySqlCipherMatrixManifest(root, verified)).toThrow(
      /does not match assets/i,
    );
  });

  it('rejects a matrix assembled from different source commits', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-native-mixed-'));
    directories.push(root);
    for (const target of REQUIRED_SQLCIPHER_TARGETS) {
      fixture({
        root,
        target,
        manifest: {
          buildCommit: target === 'win32-x64' ? 'c'.repeat(40) : 'a'.repeat(40),
        },
      });
    }
    expect(() =>
      verifySqlCipherNativeAssets(root, REQUIRED_SQLCIPHER_TARGETS),
    ).toThrow(/inconsistent buildCommit/i);
  });

  it('keeps CI source checkout and release consumption commit-bound', () => {
    const nativeWorkflow = fs.readFileSync(
      path.join(process.cwd(), '.github', 'workflows', 'sqlcipher-native.yml'),
      'utf8',
    );
    const releaseWorkflow = fs.readFileSync(
      path.join(process.cwd(), '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    expect(nativeWorkflow).toContain(
      'SQLCIPHER_SOURCE_REVISION: e2a6040f2ae5cfff2b3e08eb3320007d93cdf3fc',
    );
    expect(nativeWorkflow).toContain('--write-matrix-manifest');
    expect(nativeWorkflow).toContain('- runner: ubuntu-22.04');
    expect(nativeWorkflow).toContain('- runner: ubuntu-22.04-arm');
    expect(nativeWorkflow).toContain("GLIBC_MAX_VERSION: '2.35'");
    expect(nativeWorkflow).toContain(
      'sudo apt-get install -y binutils g++-12 gcc-12 libssl-dev make tcl',
    );
    expect(nativeWorkflow.match(/export CC=gcc-12/g)).toHaveLength(2);
    expect(nativeWorkflow.match(/export CXX=g\+\+-12/g)).toHaveLength(2);
    expect(nativeWorkflow.match(/readelf --version-info/g)).toHaveLength(2);
    expect(nativeWorkflow.match(/sort -Vu \| tail -n 1/g)).toHaveLength(2);
    expect(nativeWorkflow).toContain(
      'subject-path: native/sqlcipher/matrix-manifest.json',
    );
    expect(releaseWorkflow).toContain('--require-matrix-manifest');
    expect(releaseWorkflow).toContain(
      'gh attestation verify native/sqlcipher/matrix-manifest.json',
    );
  });
});
