/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDataProtectionService } from './dataProtectionService.js';
import { extractEncryptedBackupArchive } from './encryptedBackupArchive.js';
import { createEncryptedObjectStore } from './encryptedObjectStore.js';
import { Database } from './sqliteCompat.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('data protection service', () => {
  it('creates, validates, replicates and decrypts a complete online backup', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-data-protection-'),
    );
    temporaryDirectories.push(root);
    const databasePath = path.join(root, 'data.db');
    const attachmentDirectory = path.join(root, 'attachments');
    const backupDirectory = path.join(root, 'backups');
    const replicaDirectory = path.join(root, 'replica');
    const accountKeyPath = path.join(root, 'account-sync.key');
    const attachmentKeyPath = path.join(root, 'attachment-storage.key');
    fs.writeFileSync(accountKeyPath, Buffer.alloc(32, 2));
    fs.writeFileSync(attachmentKeyPath, Buffer.alloc(32, 3));
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE direct_message_attachments (
        id TEXT PRIMARY KEY,
        storage_backend TEXT NOT NULL,
        storage_key TEXT
      );
      CREATE TABLE protected_rows (value TEXT NOT NULL);
      INSERT INTO protected_rows VALUES ('private enterprise content');
      PRAGMA user_version = 14;
    `);
    const objectStore = createEncryptedObjectStore({
      root: attachmentDirectory,
      keyProvider: { getKey: () => Buffer.alloc(32, 3), clear() {} },
    });
    const retainedObject = objectStore.put({
      namespace: 'org-1',
      objectId: 'retained',
      content: Buffer.from('private attachment'),
    });
    objectStore.put({
      namespace: 'org-1',
      objectId: 'orphan',
      content: Buffer.from('orphan attachment'),
    });
    database
      .prepare('INSERT INTO direct_message_attachments VALUES (?, ?, ?)')
      .run('att-1', objectStore.backend, retainedObject.key);
    const archiveKey = Buffer.alloc(32, 8);
    const service = createDataProtectionService({
      dataDirectory: root,
      databasePath,
      schemaVersion: 14,
      accountSyncKeyPath: accountKeyPath,
      attachmentKeyPath,
      attachmentDirectory,
      attachmentObjectStore: objectStore,
      getDatabase: () => database,
      backupDirectory,
      replicaDirectory,
      encryptionKey: archiveKey.toString('base64'),
      minimumFreeBytes: 64 * 1024 * 1024,
      appVersion: () => '1.9.8',
      buildCommit: () => 'abc123',
    });

    const status = await service.runBackup('manual');
    expect(status.lastError).toBeNull();
    expect(status.backupCount).toBe(1);
    expect(status.latestSchemaVersion).toBe(14);
    expect(status.lastReplicaError).toBeNull();
    expect(status.orphanObjectsRemoved).toBe(1);
    expect(objectStore.listKeys()).toEqual([retainedObject.key]);
    expect(status.latestBackupPath).toBeTruthy();
    expect(
      fs.existsSync(
        path.join(replicaDirectory, path.basename(status.latestBackupPath!)),
      ),
    ).toBe(true);

    const extracted = path.join(root, 'extracted');
    const contents = await extractEncryptedBackupArchive({
      archivePath: status.latestBackupPath!,
      targetDirectory: extracted,
      key: archiveKey,
    });
    expect(contents.files).toEqual(
      expect.arrayContaining([
        'database/data.db',
        'manifest.json',
        'keys/account-sync.key',
        'keys/attachment-storage.key',
        `attachments/${retainedObject.key}`,
      ]),
    );
    const restored = new Database(path.join(extracted, 'database', 'data.db'));
    expect(restored.prepare('SELECT value FROM protected_rows').get()).toEqual({
      value: 'private enterprise content',
    });
    restored.close();
    database.close();
  });

  it('retains the newest minimum even when old backups exceed retention', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-data-protection-'),
    );
    temporaryDirectories.push(root);
    const databasePath = path.join(root, 'data.db');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE direct_message_attachments (storage_backend TEXT, storage_key TEXT);
      PRAGMA user_version = 14;
    `);
    const backupDirectory = path.join(root, 'backups');
    fs.mkdirSync(backupDirectory);
    for (let index = 0; index < 4; index += 1) {
      const file = path.join(
        backupDirectory,
        `otto-enterprise-2026010${index + 1}T000000Z-0000000${index}.otto-backup`,
      );
      fs.writeFileSync(file, 'old');
      fs.utimesSync(
        file,
        new Date(2026, 0, index + 1),
        new Date(2026, 0, index + 1),
      );
    }
    const objectStore = createEncryptedObjectStore({
      root: path.join(root, 'attachments'),
      keyProvider: { getKey: () => Buffer.alloc(32, 4), clear() {} },
    });
    const service = createDataProtectionService({
      dataDirectory: root,
      databasePath,
      schemaVersion: 14,
      accountSyncKeyPath: path.join(root, 'missing-account.key'),
      attachmentKeyPath: path.join(root, 'missing-attachment.key'),
      attachmentDirectory: path.join(root, 'attachments'),
      attachmentObjectStore: objectStore,
      getDatabase: () => database,
      backupDirectory,
      encryptionKey: Buffer.alloc(32, 9).toString('base64'),
      retentionDays: 1,
      minimumRetained: 3,
      minimumFreeBytes: 64 * 1024 * 1024,
      now: () => new Date('2026-07-29T12:00:00.000Z'),
    });

    const status = await service.runBackup('manual');
    expect(status.lastError).toBeNull();
    expect(status.backupCount).toBe(3);
    database.close();
  });
});
