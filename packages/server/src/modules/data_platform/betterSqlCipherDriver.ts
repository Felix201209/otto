/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import type { SqlCipherDriver } from './sqlCipherDatabaseLifecycle.js';
import type { DatabaseHandle, Stmt } from './sqliteCompat.js';

interface NativeStatement {
  run(...args: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

interface NativeDatabase {
  readonly inTransaction: boolean;
  exec(sql: string): void;
  pragma(directive: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): NativeStatement;
  close(): void;
}

export interface BetterSqlCipherDatabaseConstructor {
  new (
    filename: string,
    options: {
      readonly?: boolean;
      fileMustExist?: boolean;
      nativeBinding?: string;
      timeout?: number;
    },
  ): NativeDatabase;
}

function normalize(args: unknown[]): unknown[] {
  const coerce = (value: unknown): unknown =>
    value === undefined ? null : value;
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0])
  ) {
    return [
      Object.fromEntries(
        Object.entries(args[0] as Record<string, unknown>).map(
          ([key, value]) => [key, coerce(value)],
        ),
      ),
    ];
  }
  return args.map(coerce);
}

class BetterSqlCipherDatabase implements DatabaseHandle {
  constructor(readonly native: NativeDatabase) {}

  get inTransaction(): boolean {
    return this.native.inTransaction;
  }

  pragma(directive: string): void {
    this.native.pragma(directive);
  }

  exec(sql: string): void {
    this.native.exec(sql);
  }

  prepare(sql: string): Stmt {
    const statement = this.native.prepare(sql);
    return {
      run: (...args) => statement.run(...normalize(args)),
      get: (...args) => statement.get(...normalize(args)),
      all: (...args) => statement.all(...normalize(args)),
    };
  }

  close(): void {
    this.native.close();
  }
}

function rawKeyLiteral(key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('SQLCipher driver requires a 32-byte raw key');
  }
  return `"x'${key.toString('hex')}'"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function configureKey(database: NativeDatabase, key: Buffer): void {
  // SQLCipher PRAGMAs do not support bound parameters. The only interpolated
  // value is a length-checked, hex-encoded key and verbose SQL logging is off.
  database.pragma(`key = ${rawKeyLiteral(key)}`);
  database.pragma('cipher_memory_security = ON');
}

function assertCipherRuntime(database: NativeDatabase): void {
  const cipherVersion = database.pragma('cipher_version', { simple: true });
  if (typeof cipherVersion !== 'string' || !cipherVersion.trim()) {
    throw new Error(
      'native database asset is not SQLCipher; refusing to use ordinary SQLite',
    );
  }
}

function assertCipher(database: NativeDatabase): void {
  assertCipherRuntime(database);
  // Force the key to be evaluated before checking page authentication.
  database.prepare('SELECT count(*) AS table_count FROM sqlite_master').get();
  const cipherErrors = database.pragma('cipher_integrity_check');
  if (!Array.isArray(cipherErrors) || cipherErrors.length !== 0) {
    throw new Error('SQLCipher cipher_integrity_check failed');
  }
  const integrity = database.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok')
    throw new Error('SQLCipher database integrity_check failed');
}

function exportDatabase(input: {
  source: NativeDatabase;
  destinationPath: string;
  destinationKey: Buffer;
}): void {
  if (fs.existsSync(input.destinationPath)) {
    throw new Error('SQLCipher export destination already exists');
  }
  const schemaVersion = Number(
    input.source.pragma('user_version', { simple: true }) ?? 0,
  );
  // better-sqlite3 opens an existing source with SQLITE_OPEN_CREATE disabled
  // when fileMustExist is true. SQLite reuses those connection flags for
  // ATTACH, so the destination must exist before SQLCipher can attach and
  // initialize it. Create it exclusively to preserve the no-overwrite guard.
  const destinationDescriptor = fs.openSync(input.destinationPath, 'wx', 0o600);
  fs.closeSync(destinationDescriptor);
  let attached = false;
  let exported = false;
  try {
    input.source.exec('BEGIN IMMEDIATE;');
    input.source.exec(
      `ATTACH DATABASE ${sqlString(input.destinationPath)} AS encrypted ` +
        `KEY ${rawKeyLiteral(input.destinationKey)};`,
    );
    attached = true;
    input.source.prepare("SELECT sqlcipher_export('encrypted')").get();
    input.source.pragma(`encrypted.user_version = ${schemaVersion}`);
    input.source.exec('COMMIT;');
    exported = true;
  } catch (error) {
    try {
      if (input.source.inTransaction) input.source.exec('ROLLBACK;');
    } catch {
      // Preserve the export error.
    }
    throw error;
  } finally {
    if (attached) {
      try {
        input.source.exec('DETACH DATABASE encrypted;');
      } catch {
        // A failed transaction may already have detached the destination.
      }
    }
    if (!exported) {
      try {
        fs.unlinkSync(input.destinationPath);
      } catch {
        // Preserve the export error; callers will never accept this output.
      }
    }
  }
}

function loadConstructor(): BetterSqlCipherDatabaseConstructor {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line no-restricted-syntax -- native addon loading must remain runtime-selected
  const loaded = require('better-sqlite3') as
    | BetterSqlCipherDatabaseConstructor
    | { default: BetterSqlCipherDatabaseConstructor };
  return 'default' in loaded ? loaded.default : loaded;
}

/**
 * Adapter for Otto's `better_sqlite3.node` build compiled against the official
 * Zetetic SQLCipher amalgamation. The binding path is mandatory so a registry
 * prebuild containing ordinary SQLite can never be selected by accident.
 */
export function createBetterSqlCipherDriver(input: {
  nativeBindingPath: string;
  DatabaseConstructor?: BetterSqlCipherDatabaseConstructor;
  timeoutMs?: number;
}): SqlCipherDriver {
  const nativeBindingPath = path.resolve(input.nativeBindingPath);
  if (!input.DatabaseConstructor && !fs.existsSync(nativeBindingPath)) {
    throw new Error(`SQLCipher native asset is missing: ${nativeBindingPath}`);
  }
  const DatabaseConstructor = input.DatabaseConstructor ?? loadConstructor();

  function openNative(options: {
    databasePath: string;
    key: Buffer;
    create: boolean;
    readOnly?: boolean;
  }): NativeDatabase {
    const database = new DatabaseConstructor(options.databasePath, {
      readonly: options.readOnly ?? false,
      fileMustExist: !options.create,
      nativeBinding: nativeBindingPath,
      timeout: input.timeoutMs ?? 5_000,
    });
    try {
      configureKey(database, options.key);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  return {
    open(options) {
      return new BetterSqlCipherDatabase(openNative(options));
    },
    verify(database) {
      if (!(database instanceof BetterSqlCipherDatabase)) {
        throw new Error('SQLCipher driver received a foreign database handle');
      }
      assertCipher(database.native);
    },
    migratePlaintext({ sourcePath, destinationPath, key }) {
      const source = new DatabaseConstructor(sourcePath, {
        fileMustExist: true,
        nativeBinding: nativeBindingPath,
        timeout: input.timeoutMs ?? 5_000,
      });
      try {
        source.pragma('cipher_memory_security = ON');
        assertCipherRuntime(source);
        source
          .prepare('SELECT count(*) AS table_count FROM sqlite_master')
          .get();
        if (source.pragma('integrity_check', { simple: true }) !== 'ok') {
          throw new Error('plaintext SQLite source integrity_check failed');
        }
        source.pragma('wal_checkpoint(TRUNCATE)');
        exportDatabase({ source, destinationPath, destinationKey: key });
      } finally {
        source.close();
      }
    },
    snapshot({ sourcePath, destinationPath, key }) {
      const source = openNative({
        databasePath: sourcePath,
        key,
        create: false,
      });
      try {
        assertCipher(source);
        exportDatabase({ source, destinationPath, destinationKey: key });
      } finally {
        source.close();
      }
    },
    rekey({ databasePath, currentKey, nextKey }) {
      const database = openNative({
        databasePath,
        key: currentKey,
        create: false,
      });
      try {
        assertCipher(database);
        database.pragma(`rekey = ${rawKeyLiteral(nextKey)}`);
      } finally {
        database.close();
      }
    },
  };
}
