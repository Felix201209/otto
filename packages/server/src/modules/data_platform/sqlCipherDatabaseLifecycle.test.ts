/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSqlCipherDatabaseLifecycle,
  type SqlCipherDriver,
  type SqlCipherKeyMaterial,
  type SqlCipherKeyProvider,
} from './sqlCipherDatabaseLifecycle.js';
import type { DatabaseHandle, Stmt } from './sqliteCompat.js';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');
const OLD_KEY = Buffer.alloc(32, 1);
const NEW_KEY = Buffer.alloc(32, 2);
const WRONG_KEY = Buffer.alloc(32, 3);
const temporaryDirectories: string[] = [];

class FakeConnection implements DatabaseHandle {
  readonly inTransaction = false;

  constructor(
    readonly databasePath: string,
    readonly key: Buffer,
  ) {}

  pragma(): void {}
  exec(): void {}
  prepare(): Stmt {
    return {
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => ({ ready: 1 }),
      all: () => [],
    };
  }
  close(): void {}
}

function encryptedBytes(key: Buffer): Buffer {
  return Buffer.from(`otto-sqlcipher:${key.toString('hex')}:payload`, 'utf8');
}

function createDriver(
  input: {
    failMigrationVerification?: boolean;
    failFinalMigrationVerification?: boolean;
    failRekey?: boolean;
  } = {},
): SqlCipherDriver & { migrations: number; rekeys: number } {
  return {
    migrations: 0,
    rekeys: 0,
    open({ databasePath, key, create }) {
      if (!fs.existsSync(databasePath)) {
        if (!create) throw new Error('database is missing');
        fs.writeFileSync(databasePath, encryptedBytes(key), { flag: 'wx' });
      }
      if (!fs.readFileSync(databasePath).equals(encryptedBytes(key))) {
        throw new Error('file is encrypted or is not a database');
      }
      return new FakeConnection(databasePath, key);
    },
    verify(database) {
      const connection = database as FakeConnection;
      if (
        input.failMigrationVerification &&
        connection.databasePath.includes('.sqlcipher-migration-')
      ) {
        throw new Error('cipher integrity check failed');
      }
      if (
        input.failFinalMigrationVerification &&
        path.basename(connection.databasePath) === 'data.db'
      ) {
        throw new Error('final cipher integrity check failed');
      }
      if (
        !fs
          .readFileSync(connection.databasePath)
          .equals(encryptedBytes(connection.key))
      ) {
        throw new Error('cipher integrity check failed');
      }
    },
    migratePlaintext({ sourcePath, destinationPath, key }) {
      this.migrations += 1;
      expect(
        fs.readFileSync(sourcePath).subarray(0, SQLITE_HEADER.length),
      ).toEqual(SQLITE_HEADER);
      fs.writeFileSync(destinationPath, encryptedBytes(key), { flag: 'wx' });
    },
    snapshot({ sourcePath, destinationPath }) {
      fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    },
    rekey({ databasePath, currentKey, nextKey }) {
      this.rekeys += 1;
      if (!fs.readFileSync(databasePath).equals(encryptedBytes(currentKey))) {
        throw new Error('current key rejected');
      }
      fs.writeFileSync(databasePath, encryptedBytes(nextKey));
      if (input.failRekey) throw new Error('simulated interrupted rekey');
    },
  };
}

function material(version: number, key: Buffer): SqlCipherKeyMaterial {
  return { id: `test-key-${version}`, version, key };
}

function createProvider(
  input: {
    candidates?: SqlCipherKeyMaterial[];
    current?: SqlCipherKeyMaterial;
    next?: SqlCipherKeyMaterial;
  } = {},
): SqlCipherKeyProvider & {
  committed: number[];
  aborted: number[];
  recovered: number[];
} {
  const current = input.current ?? material(1, OLD_KEY);
  const next = input.next ?? material(2, NEW_KEY);
  return {
    committed: [],
    aborted: [],
    recovered: [],
    getKeyCandidates: () => input.candidates ?? [current],
    beginRotation: () => ({ current, next }),
    commitRotation(rotation) {
      this.committed.push(rotation.next.version);
    },
    abortRotation(rotation) {
      this.aborted.push(rotation.next.version);
    },
    recover(version) {
      this.recovered.push(version);
    },
    clear() {},
  };
}

function createPaths(): { dataDirectory: string; databasePath: string } {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'otto-sqlcipher-'),
  );
  temporaryDirectories.push(dataDirectory);
  return { dataDirectory, databasePath: path.join(dataDirectory, 'data.db') };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLCipher database lifecycle', () => {
  it('migrates plaintext only after verifying the encrypted replacement', () => {
    const paths = createPaths();
    const plaintext = Buffer.concat([
      SQLITE_HEADER,
      Buffer.from('legacy rows'),
    ]);
    fs.writeFileSync(paths.databasePath, plaintext);
    const driver = createDriver();
    const lifecycle = createSqlCipherDatabaseLifecycle({
      ...paths,
      driver,
      keyProvider: createProvider(),
    });

    lifecycle.openDatabase(paths.databasePath).close();

    expect(driver.migrations).toBe(1);
    expect(fs.readFileSync(paths.databasePath)).toEqual(
      encryptedBytes(OLD_KEY),
    );
    const status = lifecycle.getStatus();
    expect(status.keyVersion).toBe(1);
    expect(status.migratedFromPlaintext).toBe(true);
    expect(status.recoveryPath).toBeTruthy();
    expect(fs.readFileSync(status.recoveryPath!)).toEqual(plaintext);
  });

  it('leaves the plaintext database untouched when migration verification fails', () => {
    const paths = createPaths();
    const plaintext = Buffer.concat([
      SQLITE_HEADER,
      Buffer.from('do not lose me'),
    ]);
    fs.writeFileSync(paths.databasePath, plaintext);
    const lifecycle = createSqlCipherDatabaseLifecycle({
      ...paths,
      driver: createDriver({ failMigrationVerification: true }),
      keyProvider: createProvider(),
    });

    expect(() => lifecycle.openDatabase(paths.databasePath)).toThrow(
      'cipher integrity check failed',
    );
    expect(fs.readFileSync(paths.databasePath)).toEqual(plaintext);
    expect(
      fs.readdirSync(paths.dataDirectory).filter((name) => name !== 'data.db'),
    ).toEqual([]);
  });

  it('restores plaintext WAL sidecars when final replacement verification fails', () => {
    const paths = createPaths();
    const plaintext = Buffer.concat([SQLITE_HEADER, Buffer.from('main pages')]);
    fs.writeFileSync(paths.databasePath, plaintext);
    fs.writeFileSync(`${paths.databasePath}-wal`, 'committed wal pages');
    fs.writeFileSync(`${paths.databasePath}-shm`, 'wal index');
    const lifecycle = createSqlCipherDatabaseLifecycle({
      ...paths,
      driver: createDriver({ failFinalMigrationVerification: true }),
      keyProvider: createProvider(),
    });

    expect(() => lifecycle.openDatabase(paths.databasePath)).toThrow(
      'final cipher integrity check failed',
    );
    expect(fs.readFileSync(paths.databasePath)).toEqual(plaintext);
    expect(fs.readFileSync(`${paths.databasePath}-wal`, 'utf8')).toBe(
      'committed wal pages',
    );
    expect(fs.readFileSync(`${paths.databasePath}-shm`, 'utf8')).toBe(
      'wal index',
    );
  });

  it('fails closed on a wrong key and never treats ciphertext as plaintext', () => {
    const paths = createPaths();
    fs.writeFileSync(paths.databasePath, encryptedBytes(OLD_KEY));
    const lifecycle = createSqlCipherDatabaseLifecycle({
      ...paths,
      driver: createDriver(),
      keyProvider: createProvider({ candidates: [material(7, WRONG_KEY)] }),
    });

    expect(() => lifecycle.openDatabase(paths.databasePath)).toThrow(
      /none of the configured SQLCipher keys/i,
    );
    expect(fs.readFileSync(paths.databasePath)).toEqual(
      encryptedBytes(OLD_KEY),
    );
  });

  it('recovers an interrupted key-provider commit from a persisted candidate', () => {
    const paths = createPaths();
    fs.writeFileSync(paths.databasePath, encryptedBytes(NEW_KEY));
    const provider = createProvider({
      candidates: [material(1, OLD_KEY), material(2, NEW_KEY)],
    });
    const lifecycle = createSqlCipherDatabaseLifecycle({
      ...paths,
      driver: createDriver(),
      keyProvider: provider,
    });

    lifecycle.openDatabase(paths.databasePath).close();

    expect(provider.recovered).toEqual([2]);
    expect(lifecycle.getStatus().keyVersion).toBe(2);
  });

  it('rotates the key only after retaining an encrypted recovery snapshot', () => {
    const paths = createPaths();
    fs.writeFileSync(paths.databasePath, encryptedBytes(OLD_KEY));
    const provider = createProvider();
    const driver = createDriver();
    const lifecycle = createSqlCipherDatabaseLifecycle({
      ...paths,
      driver,
      keyProvider: provider,
    });

    const result = lifecycle.rotateKey();

    expect(driver.rekeys).toBe(1);
    expect(provider.committed).toEqual([2]);
    expect(fs.readFileSync(paths.databasePath)).toEqual(
      encryptedBytes(NEW_KEY),
    );
    expect(fs.readFileSync(result.recoveryPath)).toEqual(
      encryptedBytes(OLD_KEY),
    );
    expect(result.keyVersion).toBe(2);
  });

  it('restores the previous encrypted snapshot when rekey verification fails', () => {
    const paths = createPaths();
    fs.writeFileSync(paths.databasePath, encryptedBytes(OLD_KEY));
    fs.writeFileSync(`${paths.databasePath}-wal`, 'stale pre-rotation wal');
    const provider = createProvider();
    const lifecycle = createSqlCipherDatabaseLifecycle({
      ...paths,
      driver: createDriver({ failRekey: true }),
      keyProvider: provider,
    });

    expect(() => lifecycle.rotateKey()).toThrow('simulated interrupted rekey');

    expect(provider.aborted).toEqual([2]);
    expect(fs.readFileSync(paths.databasePath)).toEqual(
      encryptedBytes(OLD_KEY),
    );
    expect(fs.existsSync(`${paths.databasePath}-wal`)).toBe(false);
  });
});
