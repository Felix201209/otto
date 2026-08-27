#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  restoreDataProtectionBackup,
  rollbackDataProtectionRestore,
  verifyDataProtectionBackup,
} from './dataProtectionRestore.js';
import { loadExistingDataProtectionEncryptionKey } from './dataProtectionService.js';
import {
  createSqlCipherFileRuntime,
  parseSqlCipherRuntimeMode,
} from './sqlCipherRuntime.js';

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function requiredArgument(name: string): string {
  const value = argument(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const dataDirectory = path.resolve(
    argument('--data-dir') ||
      process.env.OTTO_ENTERPRISE_DIR ||
      path.join(process.env.HOME || process.cwd(), '.otto-enterprise'),
  );
  if (command === 'rollback') {
    rollbackDataProtectionRestore({
      dataDirectory,
      rollbackDirectory: requiredArgument('--rollback-dir'),
    });
    process.stdout.write(
      `${JSON.stringify({ rolledBack: true, dataDirectory })}\n`,
    );
    return;
  }
  const maximumSchemaVersion = Number(requiredArgument('--max-schema'));
  if (!Number.isInteger(maximumSchemaVersion) || maximumSchemaVersion <= 0) {
    throw new Error('--max-schema must be a positive integer');
  }
  const archivePath = path.resolve(requiredArgument('--archive'));
  const sqlCipherRuntime =
    parseSqlCipherRuntimeMode() === 'required'
      ? createSqlCipherFileRuntime({ dataDirectory })
      : null;
  const key = loadExistingDataProtectionEncryptionKey({
    dataDirectory,
    encryptionKey: process.env.OTTO_BACKUP_ENCRYPTION_KEY,
    encryptionKeyPath: process.env.OTTO_BACKUP_ENCRYPTION_KEY_FILE,
    encryptionKeyRecoveryPath:
      process.env.OTTO_BACKUP_ENCRYPTION_KEY_RECOVERY_FILE,
  });
  if (command === 'verify') {
    const result = await verifyDataProtectionBackup({
      archivePath,
      key,
      maximumSchemaVersion,
      temporaryRoot: path.join(dataDirectory, 'backups'),
      ...(sqlCipherRuntime
        ? { openDatabase: sqlCipherRuntime.openProtectedDatabase }
        : {}),
    });
    process.stdout.write(
      `${JSON.stringify({ verified: true, archivePath, ...result })}\n`,
    );
    return;
  }
  if (command !== 'restore') {
    throw new Error('command must be verify, restore or rollback');
  }
  const receipt = await restoreDataProtectionBackup({
    archivePath,
    dataDirectory,
    key,
    maximumSchemaVersion,
    accountSyncKeyPath:
      process.env.OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE?.trim() || undefined,
    attachmentKeyPath:
      process.env.OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE?.trim() || undefined,
    fieldEncryptionKeyPath:
      process.env.OTTO_FIELD_ENCRYPTION_KEY_FILE?.trim() || undefined,
    ...(sqlCipherRuntime
      ? {
          databaseKeyPath: sqlCipherRuntime.keyPath,
          openDatabase: sqlCipherRuntime.openProtectedDatabase,
        }
      : {}),
  });
  const receiptPath = argument('--receipt');
  if (receiptPath) {
    fs.writeFileSync(
      path.resolve(receiptPath),
      `${JSON.stringify(receipt, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
