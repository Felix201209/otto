/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createEncryptedObjectStore } from './encryptedObjectStore.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('encrypted object store', () => {
  it('round-trips ciphertext without exposing plaintext on disk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-objects-'));
    temporaryDirectories.push(root);
    const store = createEncryptedObjectStore({
      root,
      keyProvider: {
        getKey: () => Buffer.alloc(32, 7),
        clear() {},
      },
    });
    const content = Buffer.from('private attachment content');
    const object = store.put({
      namespace: 'org-1',
      objectId: 'att-1',
      content,
    });

    expect(store.read(object.key)).toEqual(content);
    expect(store.listKeys()).toEqual([object.key]);
    const raw = fs.readFileSync(path.join(root, ...object.key.split('/')));
    expect(raw.includes(content)).toBe(false);
    expect(store.sizeBytes()).toBe(raw.length);

    store.delete(object.key);
    expect(store.listKeys()).toEqual([]);
  });

  it('rejects traversal and authenticated-ciphertext tampering', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-objects-'));
    temporaryDirectories.push(root);
    const store = createEncryptedObjectStore({
      root,
      keyProvider: {
        getKey: () => Buffer.alloc(32, 9),
        clear() {},
      },
    });
    const object = store.put({
      namespace: 'org-1',
      objectId: 'att-1',
      content: Buffer.from('secret'),
    });
    expect(() => store.read('../../outside')).toThrow('key is invalid');

    const objectPath = path.join(root, ...object.key.split('/'));
    const raw = fs.readFileSync(objectPath);
    raw[raw.length - 1] ^= 1;
    fs.writeFileSync(objectPath, raw);
    expect(() => store.read(object.key)).toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed when an object shard is replaced by a symbolic link',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-objects-'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-outside-'));
      temporaryDirectories.push(root, outside);
      const store = createEncryptedObjectStore({
        root,
        keyProvider: {
          getKey: () => Buffer.alloc(32, 5),
          clear() {},
        },
      });
      const object = store.put({
        namespace: 'org-1',
        objectId: 'att-1',
        content: Buffer.from('secret'),
      });
      const shard = path.join(root, object.key.split('/')[0]);
      fs.rmSync(shard, { recursive: true });
      fs.symlinkSync(outside, shard, 'dir');

      expect(() => store.read(object.key)).toThrow('path is unsafe');
      expect(() =>
        store.put({
          namespace: 'org-1',
          objectId: 'att-1',
          content: Buffer.from('x'),
        }),
      ).toThrow('path is unsafe');
      expect(() => store.listKeys()).toThrow('contains a symbolic link');
    },
  );
});
