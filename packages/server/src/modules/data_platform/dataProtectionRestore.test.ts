/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createEncryptedBackupArchive } from './encryptedBackupArchive.js';
import { createEncryptedObjectStore } from './encryptedObjectStore.js';
import {
  restoreDataProtectionBackup,
  rollbackDataProtectionRestore,
} from './dataProtectionRestore.js';
import { Database } from './sqliteCompat.js';

const temporaryDirectories: string[] = [];

function createDatabase(
  filePath: string,
  value: string,
  schemaVersion = 14,
): void {
  const database = new Database(filePath);
  database.exec(`
    CREATE TABLE state (value TEXT NOT NULL);
    INSERT INTO state VALUES ('${value}');
    PRAGMA user_version = ${schemaVersion};
  `);
  database.close();
}

function readState(filePath: string): string {
  const database = new Database(filePath);
  try {
    return (
      database.prepare('SELECT value FROM state').get() as { value: string }
    ).value;
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('data protection restore', () => {
  it('validates, restores and can roll back the protected data set', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-restore-'));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, 'data');
    const sources = path.join(root, 'sources');
    fs.mkdirSync(dataDirectory);
    fs.mkdirSync(sources);
    createDatabase(path.join(dataDirectory, 'data.db'), 'old');
    fs.writeFileSync(
      path.join(dataDirectory, 'account-sync.key'),
      'old-account-key',
    );
    fs.writeFileSync(
      path.join(dataDirectory, 'privacy-deletions.jsonl'),
      'newer-current-tombstone',
    );
    fs.writeFileSync(
      path.join(dataDirectory, 'privacy-deletions.key'),
      'newer-current-key',
    );
    fs.mkdirSync(path.join(dataDirectory, 'attachments'));
    fs.writeFileSync(
      path.join(dataDirectory, 'attachments', 'old'),
      'old-object',
    );

    const restoredDatabase = path.join(sources, 'data.db');
    const restoredAccountKey = path.join(sources, 'account-sync.key');
    const restoredAttachmentKey = path.join(sources, 'attachment-storage.key');
    const restoredObject = path.join(sources, 'restored.otto-object');
    const restoredPrivacyLedger = path.join(sources, 'privacy-deletions.jsonl');
    const restoredPrivacyLedgerKey = path.join(sources, 'privacy-deletions.key');
    createDatabase(restoredDatabase, 'new');
    fs.writeFileSync(restoredAccountKey, 'new-account-key');
    fs.writeFileSync(restoredAttachmentKey, 'new-attachment-key');
    fs.writeFileSync(restoredObject, 'authenticated-object-bytes');
    fs.writeFileSync(restoredPrivacyLedger, 'older-backup-tombstone');
    fs.writeFileSync(restoredPrivacyLedgerKey, 'older-backup-key');
    const objectKey = `${'a'.repeat(2)}/${'b'.repeat(2)}/${'c'.repeat(64)}.otto-object`;
    const archivePath = path.join(root, 'backup.otto-backup');
    const encryptionKey = Buffer.alloc(32, 7);
    await createEncryptedBackupArchive({
      targetPath: archivePath,
      key: encryptionKey,
      files: [
        { sourcePath: restoredDatabase, archivePath: 'database/data.db' },
        {
          sourcePath: restoredAccountKey,
          archivePath: 'keys/account-sync.key',
        },
        {
          sourcePath: restoredAttachmentKey,
          archivePath: 'keys/attachment-storage.key',
        },
        {
          sourcePath: restoredPrivacyLedger,
          archivePath: 'privacy/privacy-deletions.jsonl',
        },
        {
          sourcePath: restoredPrivacyLedgerKey,
          archivePath: 'privacy/privacy-deletions.key',
        },
        { sourcePath: restoredObject, archivePath: `attachments/${objectKey}` },
      ],
    });

    const receipt = await restoreDataProtectionBackup({
      archivePath,
      dataDirectory,
      key: encryptionKey,
      maximumSchemaVersion: 14,
      now: () => new Date('2026-07-29T12:00:00.000Z'),
    });
    expect(receipt.schemaVersion).toBe(14);
    expect(receipt.attachmentObjects).toBe(1);
    expect(receipt.privacyDeletionLedgerRestored).toBe(false);
    expect(readState(path.join(dataDirectory, 'data.db'))).toBe('new');
    expect(
      fs.readFileSync(path.join(dataDirectory, 'account-sync.key'), 'utf8'),
    ).toBe('new-account-key');
    expect(
      fs.existsSync(
        path.join(dataDirectory, 'attachments', ...objectKey.split('/')),
      ),
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(dataDirectory, 'privacy-deletions.jsonl'), 'utf8'),
    ).toBe('newer-current-tombstone');

    rollbackDataProtectionRestore({
      dataDirectory,
      rollbackDirectory: receipt.rollbackDirectory,
    });
    expect(readState(path.join(dataDirectory, 'data.db'))).toBe('old');
    expect(
      fs.readFileSync(path.join(dataDirectory, 'account-sync.key'), 'utf8'),
    ).toBe('old-account-key');
    expect(
      fs.readFileSync(path.join(dataDirectory, 'attachments', 'old'), 'utf8'),
    ).toBe('old-object');
    expect(
      fs.readFileSync(path.join(dataDirectory, 'privacy-deletions.jsonl'), 'utf8'),
    ).toBe('newer-current-tombstone');
  });

  it('restores deletion tombstones on a fresh host and removes them on rollback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-restore-privacy-'));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, 'data');
    const sources = path.join(root, 'sources');
    fs.mkdirSync(dataDirectory);
    fs.mkdirSync(sources);
    createDatabase(path.join(dataDirectory, 'data.db'), 'old');
    const restoredDatabase = path.join(sources, 'data.db');
    const restoredPrivacyLedger = path.join(sources, 'privacy-deletions.jsonl');
    const restoredPrivacyLedgerKey = path.join(sources, 'privacy-deletions.key');
    createDatabase(restoredDatabase, 'new');
    fs.writeFileSync(restoredPrivacyLedger, 'encrypted-tombstone');
    fs.writeFileSync(restoredPrivacyLedgerKey, 'encrypted-ledger-key');
    const archivePath = path.join(root, 'privacy-backup.otto-backup');
    const key = Buffer.alloc(32, 10);
    await createEncryptedBackupArchive({
      targetPath: archivePath,
      key,
      files: [
        { sourcePath: restoredDatabase, archivePath: 'database/data.db' },
        { sourcePath: restoredPrivacyLedger, archivePath: 'privacy/privacy-deletions.jsonl' },
        { sourcePath: restoredPrivacyLedgerKey, archivePath: 'privacy/privacy-deletions.key' },
      ],
    });

    const receipt = await restoreDataProtectionBackup({
      archivePath,
      dataDirectory,
      key,
      maximumSchemaVersion: 14,
    });
    expect(receipt.privacyDeletionLedgerRestored).toBe(true);
    expect(
      fs.readFileSync(path.join(dataDirectory, 'privacy-deletions.jsonl'), 'utf8'),
    ).toBe('encrypted-tombstone');

    rollbackDataProtectionRestore({
      dataDirectory,
      rollbackDirectory: receipt.rollbackDirectory,
    });
    expect(fs.existsSync(path.join(dataDirectory, 'privacy-deletions.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dataDirectory, 'privacy-deletions.key'))).toBe(false);
  });

  it('refuses future schemas and a data directory used by a live server', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-restore-'));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, 'data');
    const sourceDatabase = path.join(root, 'future.db');
    fs.mkdirSync(dataDirectory);
    createDatabase(sourceDatabase, 'future', 99);
    const archivePath = path.join(root, 'future.otto-backup');
    const key = Buffer.alloc(32, 8);
    await createEncryptedBackupArchive({
      targetPath: archivePath,
      key,
      files: [{ sourcePath: sourceDatabase, archivePath: 'database/data.db' }],
    });
    await expect(
      restoreDataProtectionBackup({
        archivePath,
        dataDirectory,
        key,
        maximumSchemaVersion: 14,
      }),
    ).rejects.toThrow('schema 99 is unsupported');

    fs.writeFileSync(
      path.join(dataDirectory, 'enterprise-runtime.json'),
      JSON.stringify({ pid: process.pid }),
    );
    await expect(
      restoreDataProtectionBackup({
        archivePath,
        dataDirectory,
        key,
        maximumSchemaVersion: 100,
      }),
    ).rejects.toThrow('is still running');
  });

  it('rejects a backup whose referenced attachment cannot be authenticated', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-restore-'));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, 'data');
    const sources = path.join(root, 'sources');
    const objectRoot = path.join(sources, 'attachments');
    fs.mkdirSync(dataDirectory);
    fs.mkdirSync(sources);
    createDatabase(path.join(dataDirectory, 'data.db'), 'old');

    const restoredDatabase = path.join(sources, 'data.db');
    const attachmentKey = Buffer.alloc(32, 11);
    const attachmentKeyPath = path.join(sources, 'attachment-storage.key');
    fs.writeFileSync(attachmentKeyPath, attachmentKey);
    const objectStore = createEncryptedObjectStore({
      root: objectRoot,
      keyProvider: { getKey: () => attachmentKey, clear() {} },
    });
    const object = objectStore.put({
      namespace: 'org-1',
      objectId: 'attachment-1',
      content: Buffer.from('authenticated attachment'),
    });
    const database = new Database(restoredDatabase);
    database.exec(`
      CREATE TABLE direct_message_attachments (
        storage_backend TEXT NOT NULL,
        storage_key TEXT,
        byte_size INTEGER NOT NULL
      );
      INSERT INTO direct_message_attachments VALUES (
        'encrypted-filesystem', '${object.key}', 24
      );
      PRAGMA user_version = 14;
    `);
    database.close();
    const objectPath = path.join(objectRoot, ...object.key.split('/'));
    const corrupted = fs.readFileSync(objectPath);
    corrupted[corrupted.length - 1] ^= 1;
    fs.writeFileSync(objectPath, corrupted);

    const archivePath = path.join(root, 'corrupt-object.otto-backup');
    const archiveKey = Buffer.alloc(32, 12);
    await createEncryptedBackupArchive({
      targetPath: archivePath,
      key: archiveKey,
      files: [
        { sourcePath: restoredDatabase, archivePath: 'database/data.db' },
        {
          sourcePath: attachmentKeyPath,
          archivePath: 'keys/attachment-storage.key',
        },
        { sourcePath: objectPath, archivePath: `attachments/${object.key}` },
      ],
    });

    await expect(
      restoreDataProtectionBackup({
        archivePath,
        dataDirectory,
        key: archiveKey,
        maximumSchemaVersion: 14,
      }),
    ).rejects.toThrow();
    expect(readState(path.join(dataDirectory, 'data.db'))).toBe('old');
  });
});
