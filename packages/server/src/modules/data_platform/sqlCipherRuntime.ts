/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import { createBetterSqlCipherDriver } from './betterSqlCipherDriver.js';
import type { OpenProtectedDatabase } from './dataProtectionRestore.js';
import { createFileSqlCipherKeyProvider } from './fileSqlCipherKeyProvider.js';
import { createSqlCipherDatabaseLifecycle } from './sqlCipherDatabaseLifecycle.js';

export type SqlCipherRuntimeMode = 'required' | 'disabled';

export function parseSqlCipherRuntimeMode(
  environment: NodeJS.ProcessEnv = process.env,
): SqlCipherRuntimeMode {
  const configured = environment.OTTO_DATABASE_ENCRYPTION?.trim().toLowerCase();
  if (['required', 'on', 'true', '1'].includes(configured ?? ''))
    return 'required';
  if (['disabled', 'off', 'false', '0'].includes(configured ?? ''))
    return 'disabled';
  if (configured) {
    throw new Error('OTTO_DATABASE_ENCRYPTION must be required or disabled');
  }
  // Tests retain the ordinary SQLite adapter. Every non-test runtime fails
  // closed unless an operator explicitly opts out for emergency compatibility.
  return environment.NODE_ENV === 'test' ? 'disabled' : 'required';
}

export function defaultSqlCipherNativeBindingPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.OTTO_SQLCIPHER_NATIVE_BINDING?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(
    process.cwd(),
    'native',
    'sqlcipher',
    `${process.platform}-${process.arch}`,
    'better_sqlite3.node',
  );
}

export interface SqlCipherFileRuntime {
  keyPath: string;
  keyProvider: ReturnType<typeof createFileSqlCipherKeyProvider>;
  driver: ReturnType<typeof createBetterSqlCipherDriver>;
  openProtectedDatabase: OpenProtectedDatabase;
}

/**
 * Creates the built-in offline-file runtime. Desktop OS-keystore and KMS hosts
 * inject their own SqlCipherKeyProvider through the data-platform composition;
 * this function intentionally never copies a custody key into the data folder.
 */
export function createSqlCipherFileRuntime(input: {
  dataDirectory: string;
  environment?: NodeJS.ProcessEnv;
}): SqlCipherFileRuntime {
  const environment = input.environment ?? process.env;
  const configuredKeyPath =
    environment.OTTO_DATABASE_ENCRYPTION_KEY_FILE?.trim();
  if (!configuredKeyPath) {
    throw new Error(
      'OTTO_DATABASE_ENCRYPTION_KEY_FILE is required for offline SQLCipher custody',
    );
  }
  const keyPath = path.resolve(configuredKeyPath);
  const nativeBindingPath = defaultSqlCipherNativeBindingPath(environment);
  const driver = createBetterSqlCipherDriver({ nativeBindingPath });
  const keyProvider = createFileSqlCipherKeyProvider({
    keyPath,
    keyId:
      environment.OTTO_DATABASE_ENCRYPTION_KEY_ID?.trim() ||
      'offline-database-key',
    createIfMissing: false,
    writable: environment.OTTO_DATABASE_ENCRYPTION_KEY_READONLY !== 'true',
    managePermissions: false,
  });

  const openProtectedDatabase: OpenProtectedDatabase = (
    databasePath,
    recoveryKeyPath,
  ) => {
    const restoreKeyPath =
      recoveryKeyPath && fs.existsSync(recoveryKeyPath)
        ? recoveryKeyPath
        : keyPath;
    const restoreProvider = createFileSqlCipherKeyProvider({
      keyPath: restoreKeyPath,
      keyId: 'database-backup-recovery-key',
      createIfMissing: false,
      writable: false,
      managePermissions: false,
    });
    const lifecycle = createSqlCipherDatabaseLifecycle({
      dataDirectory: path.dirname(databasePath),
      databasePath,
      keyProvider: restoreProvider,
      driver,
    });
    try {
      const database = lifecycle.openSnapshot(databasePath);
      const close = database.close.bind(database);
      database.close = () => {
        try {
          close();
        } finally {
          restoreProvider.clear();
        }
      };
      return database;
    } catch (error) {
      restoreProvider.clear();
      throw error;
    }
  };

  return { keyPath, keyProvider, driver, openProtectedDatabase };
}
