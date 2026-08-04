/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import { extractEncryptedBackupArchive } from './encryptedBackupArchive.js';
import { createEncryptedObjectStore } from './encryptedObjectStore.js';
import { createFileEncryptionKeyProvider } from './fileEncryptionKeyProvider.js';
import { Database, type DatabaseHandle } from './sqliteCompat.js';

export type OpenProtectedDatabase = (
  databasePath: string,
  databaseKeyRecoveryPath?: string,
) => DatabaseHandle;

const openPlainDatabase: OpenProtectedDatabase = (databasePath) =>
  new Database(databasePath, { readOnly: true });

export interface DataProtectionRestoreReceipt {
  restoredAt: string;
  archivePath: string;
  dataDirectory: string;
  rollbackDirectory: string;
  schemaVersion: number;
  attachmentObjects: number;
  privacyDeletionLedgerRestored: boolean;
}

export function assertDataProtectionServiceStopped(
  dataDirectory: string,
): void {
  const lockPath = path.join(dataDirectory, 'enterprise-runtime.json');
  if (!fs.existsSync(lockPath)) return;
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      pid?: number;
    };
    if (Number.isInteger(lock.pid) && lock.pid! > 0) {
      try {
        process.kill(lock.pid!, 0);
        throw new Error(
          `enterprise server process ${lock.pid} is still running`,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('enterprise server process')
        ) {
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw new Error(
            `cannot safely verify enterprise server process ${lock.pid}`,
          );
        }
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('enterprise server process') ||
        error.message.startsWith(
          'cannot safely verify enterprise server process',
        ))
    ) {
      throw error;
    }
  }
  fs.rmSync(lockPath, { force: true });
}

function validateAttachmentObjects(input: {
  databasePath: string;
  databaseKeyRecoveryPath?: string;
  attachmentsDirectory: string;
  attachmentKeyPath: string;
  openDatabase?: OpenProtectedDatabase;
}): void {
  const database = (input.openDatabase ?? openPlainDatabase)(
    input.databasePath,
    input.databaseKeyRecoveryPath,
  );
  let rows: Array<{ storage_key: string; byte_size: number }> = [];
  try {
    const columns = new Set(
      (
        database
          .prepare('PRAGMA table_info(direct_message_attachments)')
          .all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!columns.has('storage_backend') || !columns.has('storage_key')) return;
    rows = database
      .prepare(
        `SELECT storage_key, byte_size FROM direct_message_attachments
         WHERE storage_backend = 'encrypted-filesystem'`,
      )
      .all() as Array<{ storage_key: string; byte_size: number }>;
  } finally {
    database.close();
  }
  if (rows.length === 0) return;
  if (!fs.existsSync(input.attachmentKeyPath)) {
    throw new Error('backup with attachments is missing its encryption key');
  }
  const keyProvider = createFileEncryptionKeyProvider({
    keyPath: input.attachmentKeyPath,
    keyBytes: 32,
    invalidKeyMessage: 'restored attachment encryption key is invalid',
  });
  const objectStore = createEncryptedObjectStore({
    root: input.attachmentsDirectory,
    keyProvider,
  });
  try {
    for (const row of rows) {
      if (!row.storage_key)
        throw new Error('restored attachment storage key is missing');
      const content = objectStore.read(row.storage_key);
      if (content.length !== Number(row.byte_size)) {
        throw new Error('restored attachment content size mismatch');
      }
    }
  } finally {
    keyProvider.clear();
  }
}

function validateRestoredDatabase(
  databasePath: string,
  maximumSchemaVersion: number,
  openDatabase: OpenProtectedDatabase = openPlainDatabase,
  databaseKeyRecoveryPath?: string,
): number {
  if (!fs.existsSync(databasePath))
    throw new Error('backup does not contain database/data.db');
  const database = openDatabase(databasePath, databaseKeyRecoveryPath);
  try {
    const quickCheck = database.prepare('PRAGMA quick_check').get() as
      { quick_check?: string } | undefined;
    if (quickCheck?.quick_check !== 'ok')
      throw new Error('restored database quick_check failed');
    if (database.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error('restored database foreign_key_check failed');
    }
    const row = database.prepare('PRAGMA user_version').get() as
      { user_version?: number } | undefined;
    const schemaVersion = Number(row?.user_version ?? 0);
    if (
      !Number.isInteger(schemaVersion) ||
      schemaVersion <= 0 ||
      schemaVersion > maximumSchemaVersion
    ) {
      throw new Error(
        `restored database schema ${schemaVersion} is unsupported`,
      );
    }
    return schemaVersion;
  } finally {
    database.close();
  }
}

function databaseContainsEncryptedMessages(
  databasePath: string,
  openDatabase: OpenProtectedDatabase = openPlainDatabase,
  databaseKeyRecoveryPath?: string,
): boolean {
  const database = openDatabase(databasePath, databaseKeyRecoveryPath);
  try {
    const columns = new Set(
      (
        database.prepare('PRAGMA table_info(direct_messages)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!columns.has('content_ciphertext')) return false;
    return Boolean(
      database
        .prepare(
          'SELECT 1 FROM direct_messages WHERE content_ciphertext IS NOT NULL LIMIT 1',
        )
        .get(),
    );
  } finally {
    database.close();
  }
}

function listAttachmentObjects(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const output: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('restored attachment contains a symbolic link');
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const relative = path
          .relative(directory, absolute)
          .split(path.sep)
          .join('/');
        if (
          !/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.otto-object$/.test(
            relative,
          )
        ) {
          throw new Error('restored attachment object path is invalid');
        }
        output.push(relative);
      }
    }
  };
  visit(directory);
  return output.sort();
}

export async function verifyDataProtectionBackup(input: {
  archivePath: string;
  key: Buffer;
  maximumSchemaVersion: number;
  temporaryRoot?: string;
  openDatabase?: OpenProtectedDatabase;
}): Promise<{
  schemaVersion: number;
  attachmentObjects: number;
  files: string[];
}> {
  const temporaryRoot = path.resolve(
    input.temporaryRoot ?? path.dirname(input.archivePath),
  );
  fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
  const extractionDirectory = fs.mkdtempSync(
    path.join(temporaryRoot, '.otto-verify-'),
  );
  try {
    const extracted = await extractEncryptedBackupArchive({
      archivePath: input.archivePath,
      targetDirectory: extractionDirectory,
      key: input.key,
    });
    const databaseKeyRecoveryPath = path.join(
      extractionDirectory,
      'keys',
      'database.keyring',
    );
    const openDatabase = input.openDatabase ?? openPlainDatabase;
    const schemaVersion = validateRestoredDatabase(
      path.join(extractionDirectory, 'database', 'data.db'),
      input.maximumSchemaVersion,
      openDatabase,
      databaseKeyRecoveryPath,
    );
    if (
      databaseContainsEncryptedMessages(
        path.join(extractionDirectory, 'database', 'data.db'),
        openDatabase,
        databaseKeyRecoveryPath,
      ) &&
      !fs.existsSync(
        path.join(extractionDirectory, 'keys', 'field-encryption.key'),
      )
    ) {
      throw new Error(
        'backup with encrypted fields is missing its encryption key',
      );
    }
    const attachmentObjects = listAttachmentObjects(
      path.join(extractionDirectory, 'attachments'),
    );
    if (
      attachmentObjects.length > 0 &&
      !fs.existsSync(
        path.join(extractionDirectory, 'keys', 'attachment-storage.key'),
      )
    ) {
      throw new Error('backup with attachments is missing its encryption key');
    }
    validateAttachmentObjects({
      databasePath: path.join(extractionDirectory, 'database', 'data.db'),
      databaseKeyRecoveryPath,
      attachmentsDirectory: path.join(extractionDirectory, 'attachments'),
      attachmentKeyPath: path.join(
        extractionDirectory,
        'keys',
        'attachment-storage.key',
      ),
      openDatabase,
    });
    return {
      schemaVersion,
      attachmentObjects: attachmentObjects.length,
      files: extracted.files,
    };
  } finally {
    fs.rmSync(extractionDirectory, { recursive: true, force: true });
  }
}

function moveIfPresent(source: string, target: string): void {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.renameSync(source, target);
}

function restoreEncryptionKey(input: {
  sourcePath: string;
  configuredPath: string;
  defaultPath: string;
  label: string;
}): void {
  if (!fs.existsSync(input.sourcePath)) return;
  if (input.configuredPath === input.defaultPath) {
    moveIfPresent(input.sourcePath, input.configuredPath);
    return;
  }
  if (!fs.existsSync(input.configuredPath)) {
    throw new Error(
      `customer-managed ${input.label} encryption key is missing`,
    );
  }
  const metadata = fs.lstatSync(input.configuredPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      `customer-managed ${input.label} encryption key path is unsafe`,
    );
  }
  if (
    !fs
      .readFileSync(input.configuredPath)
      .equals(fs.readFileSync(input.sourcePath))
  ) {
    throw new Error(
      `customer-managed ${input.label} encryption key does not match the backup`,
    );
  }
}

/**
 * Restores only after authentication and SQLite checks, preserving the previous
 * database, attachment objects and encryption keys for an explicit rollback.
 */
export async function restoreDataProtectionBackup(input: {
  archivePath: string;
  dataDirectory: string;
  key: Buffer;
  maximumSchemaVersion: number;
  accountSyncKeyPath?: string;
  attachmentKeyPath?: string;
  fieldEncryptionKeyPath?: string;
  databaseKeyPath?: string;
  openDatabase?: OpenProtectedDatabase;
  now?: () => Date;
}): Promise<DataProtectionRestoreReceipt> {
  const archivePath = path.resolve(input.archivePath);
  const dataDirectory = path.resolve(input.dataDirectory);
  const defaultFieldEncryptionKeyPath = path.join(
    dataDirectory,
    'field-encryption.key',
  );
  const defaultDatabaseKeyPath = path.join(dataDirectory, 'database.keyring');
  const databaseKeyPath = path.resolve(
    input.databaseKeyPath || defaultDatabaseKeyPath,
  );
  const defaultAccountSyncKeyPath = path.join(
    dataDirectory,
    'account-sync.key',
  );
  const accountSyncKeyPath = path.resolve(
    input.accountSyncKeyPath || defaultAccountSyncKeyPath,
  );
  const defaultAttachmentKeyPath = path.join(
    dataDirectory,
    'attachment-storage.key',
  );
  const attachmentKeyPath = path.resolve(
    input.attachmentKeyPath || defaultAttachmentKeyPath,
  );
  const fieldEncryptionKeyPath = path.resolve(
    input.fieldEncryptionKeyPath || defaultFieldEncryptionKeyPath,
  );
  assertDataProtectionServiceStopped(dataDirectory);
  if (
    !fs.existsSync(archivePath) ||
    fs.lstatSync(archivePath).isSymbolicLink()
  ) {
    throw new Error('backup archive is missing or unsafe');
  }
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const operationId = (input.now?.() ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const stagingDirectory = fs.mkdtempSync(
    path.join(path.dirname(dataDirectory), '.otto-restore-staging-'),
  );
  const rollbackDirectory = path.join(
    dataDirectory,
    'backups',
    'restore-rollbacks',
    operationId,
  );
  try {
    await extractEncryptedBackupArchive({
      archivePath,
      targetDirectory: stagingDirectory,
      key: input.key,
    });
    const restoredDatabase = path.join(stagingDirectory, 'database', 'data.db');
    const restoredDatabaseKey = path.join(
      stagingDirectory,
      'keys',
      'database.keyring',
    );
    if (input.databaseKeyPath && !fs.existsSync(restoredDatabaseKey)) {
      throw new Error(
        'encrypted database backup is missing its recovery keyring',
      );
    }
    const openDatabase = input.openDatabase ?? openPlainDatabase;
    const schemaVersion = validateRestoredDatabase(
      restoredDatabase,
      input.maximumSchemaVersion,
      openDatabase,
      restoredDatabaseKey,
    );
    if (
      databaseContainsEncryptedMessages(
        restoredDatabase,
        openDatabase,
        restoredDatabaseKey,
      ) &&
      !fs.existsSync(
        path.join(stagingDirectory, 'keys', 'field-encryption.key'),
      )
    ) {
      throw new Error(
        'backup with encrypted fields is missing its encryption key',
      );
    }
    const restoredAttachments = path.join(stagingDirectory, 'attachments');
    const attachmentObjects = listAttachmentObjects(restoredAttachments);
    const restoredAttachmentKey = path.join(
      stagingDirectory,
      'keys',
      'attachment-storage.key',
    );
    if (attachmentObjects.length > 0 && !fs.existsSync(restoredAttachmentKey)) {
      throw new Error('backup with attachments is missing its encryption key');
    }
    validateAttachmentObjects({
      databasePath: restoredDatabase,
      databaseKeyRecoveryPath: restoredDatabaseKey,
      attachmentsDirectory: restoredAttachments,
      attachmentKeyPath: restoredAttachmentKey,
      openDatabase,
    });
    const restoredPrivacyLedger = path.join(
      stagingDirectory,
      'privacy',
      'privacy-deletions.jsonl',
    );
    const restoredPrivacyLedgerKey = path.join(
      stagingDirectory,
      'privacy',
      'privacy-deletions.key',
    );
    const hasRestoredPrivacyLedger = fs.existsSync(restoredPrivacyLedger);
    const hasRestoredPrivacyLedgerKey = fs.existsSync(restoredPrivacyLedgerKey);
    if (hasRestoredPrivacyLedger !== hasRestoredPrivacyLedgerKey) {
      throw new Error('backup privacy deletion ledger is incomplete');
    }
    const currentPrivacyLedger = path.join(
      dataDirectory,
      'privacy-deletions.jsonl',
    );
    const currentPrivacyLedgerKey = path.join(
      dataDirectory,
      'privacy-deletions.key',
    );
    const hasCurrentPrivacyLedger = fs.existsSync(currentPrivacyLedger);
    const hasCurrentPrivacyLedgerKey = fs.existsSync(currentPrivacyLedgerKey);
    if (hasCurrentPrivacyLedger !== hasCurrentPrivacyLedgerKey) {
      throw new Error('current privacy deletion ledger is incomplete');
    }
    let privacyDeletionLedgerRestored = false;
    fs.mkdirSync(rollbackDirectory, { recursive: true, mode: 0o700 });
    for (const name of [
      'data.db',
      'data.db-wal',
      'data.db-shm',
      'attachments',
      'database.keyring',
      'account-sync.key',
      'attachment-storage.key',
      'field-encryption.key',
    ]) {
      moveIfPresent(
        path.join(dataDirectory, name),
        path.join(rollbackDirectory, name),
      );
    }
    try {
      moveIfPresent(restoredDatabase, path.join(dataDirectory, 'data.db'));
      moveIfPresent(
        restoredAttachments,
        path.join(dataDirectory, 'attachments'),
      );
      restoreEncryptionKey({
        sourcePath: restoredDatabaseKey,
        configuredPath: databaseKeyPath,
        defaultPath: defaultDatabaseKeyPath,
        label: 'database',
      });
      restoreEncryptionKey({
        sourcePath: path.join(stagingDirectory, 'keys', 'account-sync.key'),
        configuredPath: accountSyncKeyPath,
        defaultPath: defaultAccountSyncKeyPath,
        label: 'account sync',
      });
      restoreEncryptionKey({
        sourcePath: restoredAttachmentKey,
        configuredPath: attachmentKeyPath,
        defaultPath: defaultAttachmentKeyPath,
        label: 'attachment',
      });
      const restoredFieldEncryptionKey = path.join(
        stagingDirectory,
        'keys',
        'field-encryption.key',
      );
      restoreEncryptionKey({
        sourcePath: restoredFieldEncryptionKey,
        configuredPath: fieldEncryptionKeyPath,
        defaultPath: defaultFieldEncryptionKeyPath,
        label: 'field',
      });
      if (!hasCurrentPrivacyLedger && hasRestoredPrivacyLedger) {
        moveIfPresent(restoredPrivacyLedger, currentPrivacyLedger);
        moveIfPresent(restoredPrivacyLedgerKey, currentPrivacyLedgerKey);
        privacyDeletionLedgerRestored = true;
      }
    } catch (error) {
      for (const name of [
        'data.db',
        'data.db-wal',
        'data.db-shm',
        'attachments',
        'database.keyring',
        'account-sync.key',
        'attachment-storage.key',
        'field-encryption.key',
      ]) {
        fs.rmSync(path.join(dataDirectory, name), {
          recursive: true,
          force: true,
        });
        moveIfPresent(
          path.join(rollbackDirectory, name),
          path.join(dataDirectory, name),
        );
      }
      if (privacyDeletionLedgerRestored) {
        fs.rmSync(currentPrivacyLedger, { force: true });
        fs.rmSync(currentPrivacyLedgerKey, { force: true });
      }
      throw error;
    }
    const receipt: DataProtectionRestoreReceipt = {
      restoredAt: (input.now?.() ?? new Date()).toISOString(),
      archivePath,
      dataDirectory,
      rollbackDirectory,
      schemaVersion,
      attachmentObjects: attachmentObjects.length,
      privacyDeletionLedgerRestored,
    };
    fs.writeFileSync(
      path.join(rollbackDirectory, 'restore-receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { mode: 0o600 },
    );
    return receipt;
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

/** Reinstates the exact pre-restore state after a failed service health check. */
export function rollbackDataProtectionRestore(input: {
  dataDirectory: string;
  rollbackDirectory: string;
}): void {
  const dataDirectory = path.resolve(input.dataDirectory);
  const rollbackDirectory = path.resolve(input.rollbackDirectory);
  assertDataProtectionServiceStopped(dataDirectory);
  const expectedRoot = path.join(dataDirectory, 'backups', 'restore-rollbacks');
  if (!rollbackDirectory.startsWith(`${expectedRoot}${path.sep}`)) {
    throw new Error('restore rollback directory is outside the protected root');
  }
  const receiptPath = path.join(rollbackDirectory, 'restore-receipt.json');
  if (!fs.existsSync(receiptPath)) {
    throw new Error('restore rollback receipt is missing');
  }
  const receipt = JSON.parse(
    fs.readFileSync(receiptPath, 'utf8'),
  ) as Partial<DataProtectionRestoreReceipt>;
  for (const name of [
    'data.db',
    'data.db-wal',
    'data.db-shm',
    'attachments',
    'database.keyring',
    'account-sync.key',
    'attachment-storage.key',
    'field-encryption.key',
  ]) {
    fs.rmSync(path.join(dataDirectory, name), { recursive: true, force: true });
    moveIfPresent(
      path.join(rollbackDirectory, name),
      path.join(dataDirectory, name),
    );
  }
  if (receipt.privacyDeletionLedgerRestored) {
    fs.rmSync(path.join(dataDirectory, 'privacy-deletions.jsonl'), {
      force: true,
    });
    fs.rmSync(path.join(dataDirectory, 'privacy-deletions.key'), {
      force: true,
    });
  }
}
