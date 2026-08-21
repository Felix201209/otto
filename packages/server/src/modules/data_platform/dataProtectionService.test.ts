/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createDataProtectionService,
  loadExistingDataProtectionEncryptionKey,
} from './dataProtectionService.js';
import { extractEncryptedBackupArchive } from './encryptedBackupArchive.js';
import { createEncryptedObjectStore } from './encryptedObjectStore.js';
import { Database } from './sqliteCompat.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createMinimalProtectionFixture(
  input: {
    replica?: boolean;
    recoveryKeyPath?: string;
  } = {},
) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'otto-data-protection-key-loss-'),
  );
  temporaryDirectories.push(root);
  const databasePath = path.join(root, 'data.db');
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE direct_message_attachments (
      storage_backend TEXT,
      storage_key TEXT
    );
    PRAGMA user_version = 14;
  `);
  const attachmentDirectory = path.join(root, 'attachments');
  const backupDirectory = path.join(root, 'backups');
  const replicaDirectory = input.replica ? path.join(root, 'replica') : null;
  const objectStore = createEncryptedObjectStore({
    root: attachmentDirectory,
    keyProvider: { getKey: () => Buffer.alloc(32, 4), clear() {} },
  });
  const service = createDataProtectionService({
    dataDirectory: root,
    databasePath,
    schemaVersion: 14,
    accountSyncKeyPath: path.join(root, 'missing-account.key'),
    attachmentKeyPath: path.join(root, 'missing-attachment.key'),
    fieldEncryptionKeyPath: path.join(root, 'missing-field.key'),
    attachmentDirectory,
    attachmentObjectStore: objectStore,
    getDatabase: () => database,
    createDatabaseSnapshot(destinationPath) {
      fs.copyFileSync(
        databasePath,
        destinationPath,
        fs.constants.COPYFILE_EXCL,
      );
    },
    openDatabaseSnapshot: (snapshotPath) =>
      new Database(snapshotPath, { readOnly: true }),
    backupDirectory,
    replicaDirectory,
    encryptionKeyRecoveryPath: input.recoveryKeyPath,
    minimumFreeBytes: 64 * 1024 * 1024,
  });
  return {
    root,
    database,
    service,
    backupDirectory,
    replicaDirectory,
    keyPath: path.join(root, 'backup-encryption.key'),
  };
}

describe('data protection service', () => {
  it('loads separately held recovery material for restore without recreating the active key', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-data-protection-restore-key-'),
    );
    const recoveryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-backup-key-recovery-'),
    );
    temporaryDirectories.push(root, recoveryRoot);
    const recoveryPath = path.join(recoveryRoot, 'backup.key');
    const expected = Buffer.alloc(32, 31);
    fs.writeFileSync(recoveryPath, `${expected.toString('base64')}\n`);

    const loaded = loadExistingDataProtectionEncryptionKey({
      dataDirectory: root,
      encryptionKeyRecoveryPath: recoveryPath,
    });

    expect(loaded.equals(expected)).toBe(true);
    expect(fs.existsSync(path.join(root, 'backup-encryption.key'))).toBe(false);
  });

  it('creates, validates, replicates and decrypts a complete online backup', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-data-protection-'),
    );
    temporaryDirectories.push(root);
    const recoveryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-backup-key-recovery-'),
    );
    temporaryDirectories.push(recoveryRoot);
    const archiveRecoveryKeyPath = path.join(
      recoveryRoot,
      'backup-encryption.key',
    );

    const databasePath = path.join(root, 'data.db');
    const attachmentDirectory = path.join(root, 'attachments');
    const backupDirectory = path.join(root, 'backups');
    const replicaDirectory = path.join(root, 'replica');
    const accountKeyPath = path.join(root, 'account-sync.key');
    const attachmentKeyPath = path.join(root, 'attachment-storage.key');
    const fieldKeyPath = path.join(root, 'field-encryption.key');
    const databaseKeyPath = path.join(root, 'database.keyring');
    const privacyLedgerPath = path.join(root, 'privacy-deletions.jsonl');
    const privacyLedgerKeyPath = path.join(root, 'privacy-deletions.key');
    fs.writeFileSync(accountKeyPath, Buffer.alloc(32, 2));
    fs.writeFileSync(attachmentKeyPath, Buffer.alloc(32, 3));
    fs.writeFileSync(fieldKeyPath, Buffer.alloc(32, 5));
    fs.writeFileSync(databaseKeyPath, 'wrapped database recovery material');
    fs.writeFileSync(privacyLedgerPath, 'encrypted deletion tombstone\n');
    fs.writeFileSync(privacyLedgerKeyPath, Buffer.alloc(32, 4));
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
      fieldEncryptionKeyPath: fieldKeyPath,
      databaseKeyRecoveryPath: databaseKeyPath,
      attachmentDirectory,
      privacyDeletionLedgerPath: privacyLedgerPath,
      privacyDeletionLedgerKeyPath: privacyLedgerKeyPath,
      attachmentObjectStore: objectStore,
      getDatabase: () => database,
      createDatabaseSnapshot(destinationPath) {
        fs.copyFileSync(
          databasePath,
          destinationPath,
          fs.constants.COPYFILE_EXCL,
        );
      },
      openDatabaseSnapshot: (snapshotPath) =>
        new Database(snapshotPath, { readOnly: true }),
      backupDirectory,
      replicaDirectory,
      encryptionKey: archiveKey.toString('base64'),
      encryptionKeyRecoveryPath: archiveRecoveryKeyPath,
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

    expect(fs.readFileSync(archiveRecoveryKeyPath, 'utf8').trim()).toBe(
      archiveKey.toString('base64'),
    );
    expect(
      fs.existsSync(path.join(replicaDirectory, 'backup-encryption.key')),
    ).toBe(false);
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
        'keys/field-encryption.key',
        'keys/database.keyring',
        'privacy/privacy-deletions.jsonl',
        'privacy/privacy-deletions.key',
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
    const archiveKey = Buffer.alloc(32, 9);
    fs.writeFileSync(
      path.join(root, 'backup-key-custody.json'),
      `${JSON.stringify({
        format: 1,
        keyId: createHash('sha256').update(archiveKey).digest('hex'),
        adoptedAt: '2026-01-01T00:00:00.000Z',
      })}\n`,
    );
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
      encryptionKey: archiveKey.toString('base64'),
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

  it('fails closed when an established backup key is missing or replaced', async () => {
    const fixture = createMinimalProtectionFixture();
    const first = await fixture.service.runBackup('manual');
    expect(first.lastError).toBeNull();
    expect(first.backupCount).toBe(1);
    expect(
      fs.existsSync(path.join(fixture.root, 'backup-key-custody.json')),
    ).toBe(true);
    const firstSuccessAt = first.lastSuccessAt;

    fs.rmSync(fixture.keyPath);
    const missing = await fixture.service.runBackup('scheduled');
    expect(missing.lastError).toContain(
      'backup encryption key is unavailable for existing backups',
    );
    expect(missing.lastSuccessAt).toBe(firstSuccessAt);
    expect(missing.backupCount).toBe(1);
    expect(fs.existsSync(fixture.keyPath)).toBe(false);

    fs.writeFileSync(
      fixture.keyPath,
      `${Buffer.alloc(32, 99).toString('base64')}\n`,
      { mode: 0o600 },
    );
    const replaced = await fixture.service.runBackup('manual');
    expect(replaced.lastError).toContain(
      'backup encryption key changed without an authorized rotation',
    );
    expect(replaced.lastSuccessAt).toBe(firstSuccessAt);
    expect(replaced.backupCount).toBe(1);
    fixture.database.close();
  });

  it('refuses to invent a key when only the replica proves backup history', async () => {
    const fixture = createMinimalProtectionFixture({ replica: true });
    fs.mkdirSync(fixture.replicaDirectory!, { recursive: true });
    fs.writeFileSync(
      path.join(
        fixture.replicaDirectory!,
        'otto-enterprise-20260801T000000Z-00000001.otto-backup',
      ),
      'historical replica',
    );

    const status = await fixture.service.runBackup('scheduled');

    expect(status.lastError).toContain(
      'backup encryption key is unavailable for existing backups',
    );
    expect(status.lastSuccessAt).toBeNull();
    expect(fs.existsSync(fixture.keyPath)).toBe(false);
    fixture.database.close();
  });

  it('marks a replica unhealthy when independent recovery custody is absent', async () => {
    const fixture = createMinimalProtectionFixture({ replica: true });

    const status = await fixture.service.runBackup('manual');

    expect(status.lastError).toBeNull();
    expect(status.lastReplicaError).toContain(
      'backup replica recovery key custody is not configured',
    );
    expect(
      fs
        .readdirSync(fixture.replicaDirectory!)
        .filter((name) => name.endsWith('.otto-backup')),
    ).toHaveLength(0);
    fixture.database.close();
  });

  it('uses separately held recovery material after the active key is lost', async () => {
    const recoveryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-backup-key-recovery-'),
    );
    temporaryDirectories.push(recoveryRoot);
    const recoveryKeyPath = path.join(recoveryRoot, 'backup-encryption.key');
    const fixture = createMinimalProtectionFixture({
      replica: true,
      recoveryKeyPath,
    });

    const first = await fixture.service.runBackup('manual');
    expect(first.lastError).toBeNull();
    expect(first.lastReplicaError).toBeNull();
    expect(fs.existsSync(recoveryKeyPath)).toBe(true);

    fs.rmSync(fixture.keyPath);
    const recovered = await fixture.service.runBackup('scheduled');

    expect(recovered.lastError).toBeNull();
    expect(recovered.lastReplicaError).toBeNull();
    expect(recovered.backupCount).toBe(2);
    expect(fs.existsSync(fixture.keyPath)).toBe(false);
    expect(
      fs
        .readdirSync(fixture.replicaDirectory!)
        .filter((name) => name.endsWith('.otto-backup')),
    ).toHaveLength(2);
    fixture.database.close();
  });

  it('does not create a local fallback when the recovery mount is unavailable', async () => {
    const recoveryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-backup-key-recovery-'),
    );
    temporaryDirectories.push(recoveryRoot);
    const unavailableDirectory = path.join(recoveryRoot, 'not-mounted');
    const fixture = createMinimalProtectionFixture({
      recoveryKeyPath: path.join(unavailableDirectory, 'backup.key'),
    });

    const status = await fixture.service.runBackup('scheduled');
    expect(status.lastError).toContain(
      'backup encryption recovery key directory is unavailable',
    );
    expect(status.backupCount).toBe(0);
    expect(fs.existsSync(unavailableDirectory)).toBe(false);
    fixture.database.close();
  });

  it('adopts a legacy backup only after proving the configured key can decrypt it', async () => {
    const fixture = createMinimalProtectionFixture();
    const first = await fixture.service.runBackup('manual');
    expect(first.lastError).toBeNull();
    const originalKey = fs.readFileSync(fixture.keyPath, 'utf8');
    const markerPath = path.join(fixture.root, 'backup-key-custody.json');
    fs.rmSync(markerPath);
    fs.writeFileSync(
      fixture.keyPath,
      `${Buffer.alloc(32, 77).toString('base64')}\n`,
      { mode: 0o600 },
    );

    const rejected = await fixture.service.runBackup('scheduled');
    expect(rejected.lastError).toContain(
      'backup encryption key cannot decrypt historical backups',
    );
    expect(rejected.backupCount).toBe(1);
    expect(fs.existsSync(markerPath)).toBe(false);

    fs.writeFileSync(fixture.keyPath, originalKey, { mode: 0o600 });
    const adopted = await fixture.service.runBackup('manual');
    expect(adopted.lastError).toBeNull();
    expect(adopted.backupCount).toBe(2);
    expect(fs.existsSync(markerPath)).toBe(true);
    fixture.database.close();
  });
});
