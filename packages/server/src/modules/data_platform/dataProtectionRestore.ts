/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { extractEncryptedBackupArchive } from './encryptedBackupArchive.js';
import { createEncryptedObjectStore } from './encryptedObjectStore.js';
import { createFileEncryptionKeyProvider } from './fileEncryptionKeyProvider.js';

export interface DataProtectionRestoreReceipt {
  restoredAt: string;
  archivePath: string;
  dataDirectory: string;
  rollbackDirectory: string;
  schemaVersion: number;
  attachmentObjects: number;
}

function assertServiceStopped(dataDirectory: string): void {
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
  attachmentsDirectory: string;
  attachmentKeyPath: string;
}): void {
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
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
): number {
  if (!fs.existsSync(databasePath))
    throw new Error('backup does not contain database/data.db');
  const database = new DatabaseSync(databasePath, { readOnly: true });
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
    const schemaVersion = validateRestoredDatabase(
      path.join(extractionDirectory, 'database', 'data.db'),
      input.maximumSchemaVersion,
    );
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
      attachmentsDirectory: path.join(extractionDirectory, 'attachments'),
      attachmentKeyPath: path.join(
        extractionDirectory,
        'keys',
        'attachment-storage.key',
      ),
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

/**
 * Restores only after authentication and SQLite checks, preserving the previous
 * database, attachment objects and encryption keys for an explicit rollback.
 */
export async function restoreDataProtectionBackup(input: {
  archivePath: string;
  dataDirectory: string;
  key: Buffer;
  maximumSchemaVersion: number;
  now?: () => Date;
}): Promise<DataProtectionRestoreReceipt> {
  const archivePath = path.resolve(input.archivePath);
  const dataDirectory = path.resolve(input.dataDirectory);
  assertServiceStopped(dataDirectory);
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
    const schemaVersion = validateRestoredDatabase(
      restoredDatabase,
      input.maximumSchemaVersion,
    );
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
      attachmentsDirectory: restoredAttachments,
      attachmentKeyPath: restoredAttachmentKey,
    });
    fs.mkdirSync(rollbackDirectory, { recursive: true, mode: 0o700 });
    for (const name of [
      'data.db',
      'data.db-wal',
      'data.db-shm',
      'attachments',
      'account-sync.key',
      'attachment-storage.key',
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
      moveIfPresent(
        path.join(stagingDirectory, 'keys', 'account-sync.key'),
        path.join(dataDirectory, 'account-sync.key'),
      );
      moveIfPresent(
        restoredAttachmentKey,
        path.join(dataDirectory, 'attachment-storage.key'),
      );
    } catch (error) {
      for (const name of [
        'data.db',
        'data.db-wal',
        'data.db-shm',
        'attachments',
        'account-sync.key',
        'attachment-storage.key',
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
      throw error;
    }
    const receipt: DataProtectionRestoreReceipt = {
      restoredAt: (input.now?.() ?? new Date()).toISOString(),
      archivePath,
      dataDirectory,
      rollbackDirectory,
      schemaVersion,
      attachmentObjects: attachmentObjects.length,
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
  assertServiceStopped(dataDirectory);
  const expectedRoot = path.join(dataDirectory, 'backups', 'restore-rollbacks');
  if (!rollbackDirectory.startsWith(`${expectedRoot}${path.sep}`)) {
    throw new Error('restore rollback directory is outside the protected root');
  }
  if (!fs.existsSync(path.join(rollbackDirectory, 'restore-receipt.json'))) {
    throw new Error('restore rollback receipt is missing');
  }
  for (const name of [
    'data.db',
    'data.db-wal',
    'data.db-shm',
    'attachments',
    'account-sync.key',
    'attachment-storage.key',
  ]) {
    fs.rmSync(path.join(dataDirectory, name), { recursive: true, force: true });
    moveIfPresent(
      path.join(rollbackDirectory, name),
      path.join(dataDirectory, name),
    );
  }
}
