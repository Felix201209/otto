/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createEncryptedBackupArchive,
  extractEncryptedBackupArchive,
} from './encryptedBackupArchive.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('encrypted backup archive', () => {
  it('round-trips database, object and key files without plaintext leakage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-backup-archive-'));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, 'data.db');
    const objectPath = path.join(root, 'object.bin');
    const keyPath = path.join(root, 'attachment.key');
    fs.writeFileSync(databasePath, 'private database rows');
    fs.writeFileSync(objectPath, 'encrypted object bytes');
    fs.writeFileSync(keyPath, Buffer.alloc(32, 3));
    const archivePath = path.join(root, 'snapshot.otto-backup');
    const key = Buffer.alloc(32, 8);

    const created = await createEncryptedBackupArchive({
      targetPath: archivePath,
      key,
      files: [
        { sourcePath: databasePath, archivePath: 'data/data.db' },
        { sourcePath: objectPath, archivePath: 'attachments/a/object.bin' },
        { sourcePath: keyPath, archivePath: 'keys/attachment-storage.key' },
      ],
    });
    expect(created.fileCount).toBe(3);
    expect(
      fs
        .readFileSync(archivePath)
        .includes(Buffer.from('private database rows')),
    ).toBe(false);

    const extracted = path.join(root, 'extracted');
    await expect(
      extractEncryptedBackupArchive({
        archivePath,
        targetDirectory: extracted,
        key,
      }),
    ).resolves.toEqual({
      files: [
        'data/data.db',
        'attachments/a/object.bin',
        'keys/attachment-storage.key',
      ],
    });
    expect(
      fs.readFileSync(path.join(extracted, 'data', 'data.db'), 'utf8'),
    ).toBe('private database rows');
  });

  it('rejects the wrong key, tampering and unsafe archive paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-backup-archive-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'source');
    fs.writeFileSync(source, 'secret');
    const archivePath = path.join(root, 'snapshot.otto-backup');
    await expect(
      createEncryptedBackupArchive({
        targetPath: archivePath,
        key: Buffer.alloc(32, 1),
        files: [{ sourcePath: source, archivePath: '../outside' }],
      }),
    ).rejects.toThrow('path is invalid');
    await createEncryptedBackupArchive({
      targetPath: archivePath,
      key: Buffer.alloc(32, 1),
      files: [{ sourcePath: source, archivePath: 'safe/source' }],
    });
    await expect(
      extractEncryptedBackupArchive({
        archivePath,
        targetDirectory: path.join(root, 'wrong-key'),
        key: Buffer.alloc(32, 2),
      }),
    ).rejects.toThrow();

    const damaged = fs.readFileSync(archivePath);
    damaged[Math.floor(damaged.length / 2)] ^= 1;
    fs.writeFileSync(archivePath, damaged);
    await expect(
      extractEncryptedBackupArchive({
        archivePath,
        targetDirectory: path.join(root, 'damaged'),
        key: Buffer.alloc(32, 1),
      }),
    ).rejects.toThrow();
  });
});
