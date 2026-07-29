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

export interface DataPlatformEncryptionKeyOptions {
  keyPath: string;
  keyBytes: number;
  invalidKeyMessage: string;
}

export interface DataPlatformCompositionOptions {
  encryptionKey: DataPlatformEncryptionKeyOptions;
  database: EnterpriseDatabaseLifecycleOptions;
}

/** Owns database resources, encryption-key lifetime and deferred backups. */
export function createDataPlatformComposition(
  options: DataPlatformCompositionOptions,
) {
  const encryptionKeyProvider = createFileEncryptionKeyProvider(
    options.encryptionKey,
  );
  const databaseLifecycle = createEnterpriseDatabaseLifecycle(options.database);

  function closeDatabase(): void {
    try {
      databaseLifecycle.close();
    } finally {
      encryptionKeyProvider.clear();
    }
  }

  return {
    encryptionKeyProvider,
    closeDatabase,
    getDatabase: databaseLifecycle.getDatabase,
    getReadiness: databaseLifecycle.getReadiness,
    createBackup(store: EnterpriseBackupFacadeStore) {
      return createEnterpriseBackupFacade(store);
    },
  };
}
