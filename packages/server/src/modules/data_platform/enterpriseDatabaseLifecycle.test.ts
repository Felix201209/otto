/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createEnterpriseDatabaseLifecycle } from './enterpriseDatabaseLifecycle.js';
import { Database } from './sqliteCompat.js';

const temporaryDirectories: string[] = [];
const closeCallbacks: Array<() => void> = [];

function createPaths(): {
  dataDirectory: string;
  databasePath: string;
  backupPath: string;
} {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-db-life-'));
  temporaryDirectories.push(dataDirectory);
  const databasePath = path.join(dataDirectory, 'data.db');
  return {
    dataDirectory,
    databasePath,
    backupPath: `${databasePath}.pre-b2b-v2.bak`,
  };
}

afterEach(() => {
  for (const close of closeCallbacks.splice(0)) {
    try {
      close();
    } catch {
      // Cleanup should not hide the assertion that failed.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('enterprise database lifecycle', () => {
  it('owns one connection, preserves a legacy backup, and reports readiness', () => {
    const paths = createPaths();
    const seed = new Database(paths.databasePath);
    seed.exec('CREATE TABLE legacy_record (value TEXT); PRAGMA user_version = 1;');
    seed.close();

    let initializeCount = 0;
    let duringInitialization = -1;
    const initializationOrder: string[] = [];
    const lifecycle = createEnterpriseDatabaseLifecycle({
      ...paths,
      legacyBackupPath: paths.backupPath,
      schemaVersion: 2,
      beforeForeignKeys(database) {
        initializationOrder.push('beforeForeignKeys');
        database.prepare('SELECT 1').get();
      },
      initializeSchema(database) {
        initializeCount += 1;
        initializationOrder.push('initializeSchema');
        duringInitialization = Number(
          (database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number })
            .foreign_keys,
        );
        database.exec('CREATE TABLE current_record (value TEXT);');
      },
    });
    closeCallbacks.push(lifecycle.close);

    const first = lifecycle.getDatabase();
    expect(lifecycle.getDatabase()).toBe(first);
    expect(initializeCount).toBe(1);
    expect(initializationOrder).toEqual(['beforeForeignKeys', 'initializeSchema']);
    expect(duringInitialization).toBe(1);
    expect(lifecycle.getReadiness()).toEqual({ ready: true, schemaVersion: 2 });
    expect(fs.existsSync(paths.backupPath)).toBe(true);

    const backup = new Database(paths.backupPath);
    expect(
      backup.prepare("SELECT name FROM sqlite_master WHERE name = 'legacy_record'").get(),
    ).toEqual({ name: 'legacy_record' });
    expect(
      backup.prepare("SELECT name FROM sqlite_master WHERE name = 'current_record'").get(),
    ).toBeUndefined();
    backup.close();
  });

  it('clears owned state on close and opens a fresh connection', () => {
    const paths = createPaths();
    let initializeCount = 0;
    let closeCount = 0;
    let openCount = 0;
    const lifecycle = createEnterpriseDatabaseLifecycle({
      ...paths,
      schemaVersion: 1,
      initializeSchema() {
        initializeCount += 1;
      },
      onClose() {
        closeCount += 1;
      },
      openDatabase(databasePath) {
        openCount += 1;
        return new Database(databasePath);
      },
    });
    closeCallbacks.push(lifecycle.close);

    lifecycle.getDatabase();
    lifecycle.close();
    lifecycle.getDatabase().prepare('SELECT 1').get();

    expect(openCount).toBe(2);
    expect(initializeCount).toBe(2);
    expect(closeCount).toBe(1);
  });

  it('rejects a newer schema without caching the failed connection', () => {
    const paths = createPaths();
    const seed = new Database(paths.databasePath);
    seed.exec('PRAGMA user_version = 3;');
    seed.close();
    const lifecycle = createEnterpriseDatabaseLifecycle({
      ...paths,
      schemaVersion: 2,
      initializeSchema() {},
    });
    closeCallbacks.push(lifecycle.close);

    expect(() => lifecycle.getDatabase()).toThrow(
      /schema version 3.*current version 2.*refusing downgrade/i,
    );

    const repaired = new Database(paths.databasePath);
    repaired.exec('PRAGMA user_version = 1;');
    repaired.close();
    expect(lifecycle.getReadiness()).toEqual({ ready: true, schemaVersion: 2 });
  });

  it('retries the complete initialization after a migration failure', () => {
    const paths = createPaths();
    let attempts = 0;
    const lifecycle = createEnterpriseDatabaseLifecycle({
      ...paths,
      schemaVersion: 1,
      initializeSchema() {
        attempts += 1;
        if (attempts === 1) throw new Error('migration interrupted');
      },
    });
    closeCallbacks.push(lifecycle.close);

    expect(() => lifecycle.getDatabase()).toThrow('migration interrupted');
    expect(lifecycle.getReadiness()).toEqual({ ready: true, schemaVersion: 1 });
    expect(attempts).toBe(2);
  });

  it('owns schema version stamping after successful initialization', () => {
    const paths = createPaths();
    const lifecycle = createEnterpriseDatabaseLifecycle({
      ...paths,
      schemaVersion: 1,
      initializeSchema() {},
    });
    closeCallbacks.push(lifecycle.close);

    expect(lifecycle.getReadiness()).toEqual({ ready: true, schemaVersion: 1 });
  });

  it('fails before opening SQLite when the database path is a network share', () => {
    const lifecycle = createEnterpriseDatabaseLifecycle({
      dataDirectory: String.raw`\\server\share\otto`,
      databasePath: String.raw`\\server\share\otto\data.db`,
      schemaVersion: 1,
      initializeSchema() {},
    });

    expect(() => lifecycle.getDatabase()).toThrow(/SQLite.*network/i);
  });
});
