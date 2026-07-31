/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLocalAttachmentObjectStore } from './attachmentObjectStore.js';
import { createEncryptedObjectStore } from './encryptedObjectStore.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('local AttachmentObjectStore adapter', () => {
  it('stores ciphertext under opaque non-identifying keys with local encryption', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-attachment-store-'),
    );
    temporaryDirectories.push(root);
    const legacy = createEncryptedObjectStore({
      root,
      keyProvider: {
        getKey: () => Buffer.alloc(32, 4),
        clear() {},
      },
    });
    const store = createLocalAttachmentObjectStore({ encryptedStore: legacy });
    const ciphertext = Buffer.from('already encrypted by the client');
    const digest = createHash('sha256').update(ciphertext).digest('hex');

    const first = await store.putCiphertext({
      ciphertext,
      ciphertextSha256: digest,
      encryption: 'e2ee-client-v1',
    });
    const second = await store.putCiphertext({
      ciphertext,
      ciphertextSha256: digest,
      encryption: 'e2ee-client-v1',
    });

    expect(first.backend).toBe('encrypted-filesystem');
    expect(first.key).not.toBe(second.key);
    expect(first.key).not.toContain('organization');
    expect(first.key).not.toContain('filename');
    await expect(store.getCiphertext(first.key)).resolves.toEqual(ciphertext);
    expect(
      fs.readFileSync(path.join(root, ...first.key.split('/'))),
    ).not.toContain(ciphertext);
  });

  it('rejects a caller checksum mismatch before writing', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-attachment-store-'),
    );
    temporaryDirectories.push(root);
    const legacy = createEncryptedObjectStore({
      root,
      keyProvider: {
        getKey: () => Buffer.alloc(32, 5),
        clear() {},
      },
    });
    const store = createLocalAttachmentObjectStore({ encryptedStore: legacy });

    await expect(
      store.putCiphertext({
        ciphertext: Buffer.from('ciphertext'),
        ciphertextSha256: '0'.repeat(64),
        encryption: 'e2ee-client-v1',
      }),
    ).rejects.toThrow(/checksum/i);
    expect(legacy.listKeys()).toEqual([]);
  });
});
