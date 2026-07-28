/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';

import { Database, type DatabaseHandle } from './sqliteCompat.js';

export interface DatabaseReadiness {
  ready: true;
  schemaVersion: number;
}

export interface EnterpriseDatabaseLifecycleOptions {
  dataDirectory: string;
  databasePath: string;
  schemaVersion: number;
  legacyBackupPath?: string;
  beforeForeignKeys?: (database: DatabaseHandle) => void;
  initializeSchema: (database: DatabaseHandle) => void;
  onClose?: () => void;
  openDatabase?: (databasePath: string) => DatabaseHandle;
}

export interface EnterpriseDatabaseLifecycle {
  close(): void;
  getDatabase(): DatabaseHandle;
  getReadiness(): DatabaseReadiness;
}

function readSchemaVersion(database: DatabaseHandle): number {
  const schema = database.prepare('PRAGMA user_version').get() as
    | { user_version?: number }
    | undefined;
  return Number(schema?.user_version ?? 0);
}

function prepareLegacyBackup(input: {
  databasePath: string;
  legacyBackupPath?: string;
}): void {
  if (!input.legacyBackupPath || !fs.existsSync(input.databasePath)) return;
  if (fs.existsSync(input.legacyBackupPath)) return;
  if (fs.statSync(input.databasePath).size <= 0) return;
  fs.copyFileSync(
    input.databasePath,
    input.legacyBackupPath,
    fs.constants.COPYFILE_EXCL,
  );
}

export function createEnterpriseDatabaseLifecycle(
  options: EnterpriseDatabaseLifecycleOptions,
): EnterpriseDatabaseLifecycle {
  let database: DatabaseHandle | null = null;
  const openDatabase =
    options.openDatabase ?? ((databasePath: string) => new Database(databasePath));

  function close(): void {
    if (!database) return;
    const current = database;
    database = null;
    try {
      options.onClose?.();
    } finally {
      current.close();
    }
  }

  function getDatabase(): DatabaseHandle {
    if (database) return database;

    fs.mkdirSync(options.dataDirectory, { recursive: true });
    prepareLegacyBackup(options);

    const candidate = openDatabase(options.databasePath);
    try {
      const existingSchemaVersion = readSchemaVersion(candidate);
      if (
        Number.isInteger(existingSchemaVersion) &&
        existingSchemaVersion > options.schemaVersion
      ) {
        throw new Error(
          `Enterprise database schema version ${existingSchemaVersion} is newer than ` +
            `current version ${options.schemaVersion}; refusing downgrade`,
        );
      }
      candidate.pragma('journal_mode = WAL');
      options.beforeForeignKeys?.(candidate);
      candidate.pragma('foreign_keys = ON');
      options.initializeSchema(candidate);
      database = candidate;
      return candidate;
    } catch (error) {
      try {
        candidate.close();
      } catch {
        // Preserve the initialization error that made this connection unusable.
      }
      throw error;
    }
  }

  function getReadiness(): DatabaseReadiness {
    const current = getDatabase();
    const probe = current.prepare('SELECT 1 AS ready').get() as
      | { ready?: number }
      | undefined;
    if (probe?.ready !== 1) {
      throw new Error('Enterprise database readiness probe failed');
    }
    const schemaVersion = readSchemaVersion(current);
    if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) {
      throw new Error('Enterprise database schema version is unavailable');
    }
    return { ready: true, schemaVersion };
  }

  return { close, getDatabase, getReadiness };
}
