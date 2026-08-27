/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createBetterSqlCipherDriver,
  type BetterSqlCipherDatabaseConstructor,
} from './betterSqlCipherDriver.js';

const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);
const realNativeBindingPath = path.join(
  repositoryRoot,
  'native',
  'sqlcipher-node',
  `${process.platform}-${process.arch}`,
  'better_sqlite3.node',
);

interface Command {
  kind: 'exec' | 'pragma' | 'prepare';
  value: string;
}

function createFakeConstructor(input: { cipherVersion?: string | null } = {}): {
  Constructor: BetterSqlCipherDatabaseConstructor;
  instances: Array<{ commands: Command[]; closed: boolean }>;
} {
  const instances: Array<{
    commands: Command[];
    closed: boolean;
    inTransaction: boolean;
  }> = [];
  class FakeDatabase {
    readonly commands: Command[] = [];
    closed = false;
    inTransaction = false;

    constructor(
      _filename: string,
      options: {
        readonly?: boolean;
        fileMustExist?: boolean;
        nativeBinding?: string;
        timeout?: number;
      },
    ) {
      if (
        Object.prototype.hasOwnProperty.call(options, 'readonly') &&
        typeof options.readonly !== 'boolean'
      ) {
        throw new TypeError('Expected the "readonly" option to be a boolean');
      }
      instances.push(this);
    }

    exec(sql: string): void {
      this.commands.push({ kind: 'exec', value: sql });
      if (sql === 'BEGIN IMMEDIATE;') this.inTransaction = true;
      if (sql === 'COMMIT;' || sql === 'ROLLBACK;') this.inTransaction = false;
    }

    pragma(directive: string, options?: { simple?: boolean }): unknown {
      this.commands.push({ kind: 'pragma', value: directive });
      if (directive === 'cipher_version' && options?.simple) {
        return input.cipherVersion === undefined
          ? '4.7.0'
          : input.cipherVersion;
      }
      if (directive === 'cipher_integrity_check') return [];
      if (directive === 'integrity_check' && options?.simple) return 'ok';
      if (directive === 'user_version' && options?.simple) return 18;
      return undefined;
    }

    prepare(sql: string) {
      this.commands.push({ kind: 'prepare' as const, value: sql });
      return {
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => ({ table_count: 1 }),
        all: () => [],
      };
    }

    close(): void {
      this.closed = true;
    }
  }
  return {
    Constructor: FakeDatabase as unknown as BetterSqlCipherDatabaseConstructor,
    instances,
  };
}

function createPaths(): {
  root: string;
  databasePath: string;
  bindingPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-driver-'));
  temporaryDirectories.push(root);
  return {
    root,
    databasePath: path.join(root, 'data.db'),
    bindingPath: path.join(root, 'better_sqlite3.node'),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('better SQLCipher driver', () => {
  it('applies the raw key before schema access and verifies page authentication', () => {
    const paths = createPaths();
    const fake = createFakeConstructor();
    const key = Buffer.alloc(32, 0xab);
    const driver = createBetterSqlCipherDriver({
      nativeBindingPath: paths.bindingPath,
      DatabaseConstructor: fake.Constructor,
    });

    const database = driver.open({
      databasePath: paths.databasePath,
      key,
      create: true,
    });
    driver.verify(database);
    database.close();

    expect(fake.instances[0]!.commands).toEqual([
      { kind: 'pragma', value: `key = "x'${key.toString('hex')}'"` },
      { kind: 'pragma', value: 'cipher_memory_security = ON' },
      { kind: 'pragma', value: 'cipher_version' },
      {
        kind: 'prepare',
        value: 'SELECT count(*) AS table_count FROM sqlite_master',
      },
      { kind: 'pragma', value: 'cipher_integrity_check' },
      { kind: 'pragma', value: 'integrity_check' },
    ]);
    expect(fake.instances[0]!.closed).toBe(true);
  });

  it('rejects an ordinary SQLite native asset', () => {
    const paths = createPaths();
    const fake = createFakeConstructor({ cipherVersion: null });
    const driver = createBetterSqlCipherDriver({
      nativeBindingPath: paths.bindingPath,
      DatabaseConstructor: fake.Constructor,
    });
    const database = driver.open({
      databasePath: paths.databasePath,
      key: Buffer.alloc(32, 1),
      create: true,
    });

    expect(() => driver.verify(database)).toThrow(/not SQLCipher/i);
    database.close();
  });

  it('uses sqlcipher_export for lossless plaintext migration', () => {
    const paths = createPaths();
    const fake = createFakeConstructor();
    const driver = createBetterSqlCipherDriver({
      nativeBindingPath: paths.bindingPath,
      DatabaseConstructor: fake.Constructor,
    });
    const destinationPath = path.join(paths.root, "encrypted-'copy.db");

    driver.migratePlaintext({
      sourcePath: paths.databasePath,
      destinationPath,
      key: Buffer.alloc(32, 7),
    });

    const commands = fake.instances[0]!.commands;
    expect(commands[0]).toEqual({
      kind: 'pragma',
      value: 'cipher_memory_security = ON',
    });
    expect(
      commands.some(
        (command) =>
          command.kind === 'pragma' && command.value.startsWith('key ='),
      ),
    ).toBe(false);
    expect(commands).toContainEqual({
      kind: 'prepare',
      value: "SELECT sqlcipher_export('encrypted')",
    });
    expect(
      commands.some(
        (command) =>
          command.kind === 'exec' &&
          command.value.includes("encrypted-''copy.db") &&
          command.value.includes(' AS encrypted KEY "x\''),
      ),
    ).toBe(true);
    expect(commands).toContainEqual({
      kind: 'pragma',
      value: 'encrypted.user_version = 18',
    });
  });

  it.runIf(fs.existsSync(realNativeBindingPath))(
    'migrates a real plaintext database into authenticated SQLCipher',
    () => {
      const paths = createPaths();
      const destinationPath = path.join(paths.root, 'encrypted.db');
      const key = Buffer.alloc(32, 0x5a);
      const plaintext = new DatabaseSync(paths.databasePath);
      plaintext.exec(`
        PRAGMA user_version = 18;
        CREATE TABLE migration_probe (value TEXT NOT NULL);
        INSERT INTO migration_probe (value) VALUES ('preserved');
      `);
      plaintext.close();

      const driver = createBetterSqlCipherDriver({
        nativeBindingPath: realNativeBindingPath,
      });
      driver.migratePlaintext({
        sourcePath: paths.databasePath,
        destinationPath,
        key,
      });

      const encrypted = driver.open({
        databasePath: destinationPath,
        key,
        create: false,
      });
      try {
        driver.verify(encrypted);
        expect(
          encrypted.prepare('SELECT value FROM migration_probe').get(),
        ).toEqual({ value: 'preserved' });
        expect(encrypted.prepare('PRAGMA user_version').get()).toEqual({
          user_version: 18,
        });
      } finally {
        encrypted.close();
      }

      const ordinarySqlite = new DatabaseSync(destinationPath, {
        readOnly: true,
      });
      try {
        expect(() =>
          ordinarySqlite.prepare('SELECT count(*) FROM sqlite_master').get(),
        ).toThrow();
      } finally {
        ordinarySqlite.close();
      }
    },
  );
});
