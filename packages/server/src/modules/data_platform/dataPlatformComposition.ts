/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createEnterpriseBackupFacade,
  type EnterpriseBackupFacadeStore,
} from './enterpriseBackupFacade.js';
import {
  createEnterpriseDatabaseLifecycle,
  type EnterpriseDatabaseLifecycleOptions,
} from './enterpriseDatabaseLifecycle.js';
import { createFileEncryptionKeyProvider } from './fileEncryptionKeyProvider.js';
import {
  createSqlCipherDatabaseLifecycle,
  type SqlCipherDriver,
  type SqlCipherKeyProvider,
} from './sqlCipherDatabaseLifecycle.js';

export interface DataPlatformEncryptionKeyOptions {
  keyPath: string;
  keyBytes: number;
  invalidKeyMessage: string;
  createIfMissing?: boolean;
  managePermissions?: boolean;
}

export interface DataPlatformCompositionOptions {
  encryptionKey: DataPlatformEncryptionKeyOptions;
  database: EnterpriseDatabaseLifecycleOptions;
  databaseEncryption?: {
    keyProvider: SqlCipherKeyProvider;
    driver: SqlCipherDriver;
  };
}

/** Owns database resources, encryption-key lifetime and deferred backups. */
export function createDataPlatformComposition(
  options: DataPlatformCompositionOptions,
) {
  const encryptionKeyProvider = createFileEncryptionKeyProvider(
    options.encryptionKey,
  );
  if (options.databaseEncryption && options.database.openDatabase) {
    throw new Error(
      'database encryption cannot be combined with a custom openDatabase callback',
    );
  }
  const databaseEncryption = options.databaseEncryption
    ? createSqlCipherDatabaseLifecycle({
        dataDirectory: options.database.dataDirectory,
        databasePath: options.database.databasePath,
        ...options.databaseEncryption,
      })
    : null;
  const databaseLifecycle = createEnterpriseDatabaseLifecycle({
    ...options.database,
    ...(databaseEncryption
      ? { openDatabase: databaseEncryption.openDatabase }
      : {}),
  });

  function closeDatabase(): void {
    try {
      databaseLifecycle.close();
    } finally {
      try {
        encryptionKeyProvider.clear();
      } finally {
        databaseEncryption?.clearKeys();
      }
    }
  }

  return {
    encryptionKeyProvider,
    closeDatabase,
    getDatabase: databaseLifecycle.getDatabase,
    getReadiness: databaseLifecycle.getReadiness,
    getDatabaseEncryptionStatus() {
      if (!databaseEncryption)
        throw new Error('SQLCipher database encryption is disabled');
      return databaseEncryption.getStatus();
    },
    createDatabaseSnapshot(destinationPath: string) {
      if (!databaseEncryption)
        throw new Error('SQLCipher database encryption is disabled');
      databaseEncryption.createSnapshot(destinationPath);
    },
    openDatabaseSnapshot(databasePath: string) {
      if (!databaseEncryption)
        throw new Error('SQLCipher database encryption is disabled');
      return databaseEncryption.openSnapshot(databasePath);
    },
    rotateDatabaseKey() {
      if (!databaseEncryption)
        throw new Error('SQLCipher database encryption is disabled');
      databaseLifecycle.close();
      return databaseEncryption.rotateKey();
    },
    createBackup(store: EnterpriseBackupFacadeStore) {
      return createEnterpriseBackupFacade(store);
    },
  };
}
