/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { EncryptionKeyProvider } from './fileEncryptionKeyProvider.js';

const OBJECT_MAGIC = Buffer.from('OTTOOBJ1');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedObjectMetadata {
  lastModifiedAtMs: number;
  pendingSinceMs: number | null;
}

export interface EncryptedObjectStore {
  readonly backend: 'encrypted-filesystem';
  put(input: { namespace: string; objectId: string; content: Buffer }): {
    backend: 'encrypted-filesystem';
    key: string;
  };
  read(key: string): Buffer;
  markCommitted(key: string): void;
  inspect(key: string): EncryptedObjectMetadata | null;
  delete(key: string): void;
  listKeys(): string[];
  sizeBytes(): number;
}

function safeObjectKey(namespace: string, objectId: string): string {
  const digest = createHash('sha256')
    .update(namespace)
    .update('\0')
    .update(objectId)
    .digest('hex');
  return `${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}.otto-object`;
}

function assertSafeRelativeKey(key: string): string {
  const normalized = key.replace(/\\/g, '/');
  if (
    !/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.otto-object$/.test(normalized)
  ) {
    throw new Error('object storage key is invalid');
  }
  return normalized;
}

function ensureStorageRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('object storage root must be a real directory');
  }
  try {
    fs.chmodSync(root, 0o700);
  } catch {
    // Windows applies the account ACL to the private data directory.
  }
}

function filesBelow(root: string, current = root): string[] {
  if (!fs.existsSync(current)) return [];
  const output: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('object storage contains a symbolic link');
    }
    if (entry.isDirectory()) output.push(...filesBelow(root, absolute));
    else if (entry.isFile()) {
      output.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  return output.sort();
}

/** Stores authenticated ciphertext outside SQLite and never trusts caller paths. */
export function createEncryptedObjectStore(input: {
  root: string;
  keyProvider: EncryptionKeyProvider;
}): EncryptedObjectStore {
  const root = path.resolve(input.root);

  function resolveKey(key: string): string {
    const safeKey = assertSafeRelativeKey(key);
    ensureStorageRoot(root);
    let parent = root;
    for (const segment of safeKey.split('/').slice(0, -1)) {
      parent = path.join(parent, segment);
      if (!fs.existsSync(parent)) continue;
      const metadata = fs.lstatSync(parent);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('object storage path is unsafe');
      }
    }
    const absolute = path.resolve(root, ...safeKey.split('/'));
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      throw new Error('object storage key escapes its root');
    }
    if (fs.existsSync(absolute)) {
      const metadata = fs.lstatSync(absolute);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('object storage object is unsafe');
      }
    }
    return absolute;
  }

  function resolvePendingPath(target: string): string {
    const pendingPath = `${target}.pending`;
    if (fs.existsSync(pendingPath)) {
      const metadata = fs.lstatSync(pendingPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('object storage pending marker is unsafe');
      }
    }
    return pendingPath;
  }

  function ensureObjectParent(target: string): void {
    const relative = path.relative(root, path.dirname(target));
    let parent = root;
    for (const segment of relative.split(path.sep)) {
      parent = path.join(parent, segment);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
      const metadata = fs.lstatSync(parent);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('object storage path is unsafe');
      }
    }
  }

  return {
    backend: 'encrypted-filesystem',
    put({ namespace, objectId, content }) {
      if (!namespace.trim() || !objectId.trim() || content.length === 0) {
        throw new Error('object storage input is invalid');
      }
      ensureStorageRoot(root);
      const key = safeObjectKey(namespace, objectId);
      const target = resolveKey(key);
      ensureObjectParent(target);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(
        'aes-256-gcm',
        input.keyProvider.getKey(),
        nonce,
      );
      cipher.setAAD(Buffer.from(key));
      const ciphertext = Buffer.concat([
        cipher.update(content),
        cipher.final(),
      ]);
      const payload = Buffer.concat([
        OBJECT_MAGIC,
        nonce,
        cipher.getAuthTag(),
        ciphertext,
      ]);
      const pendingPath = resolvePendingPath(target);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      let objectPublished = false;
      try {
        // The marker is created before the object becomes visible. It remains
        // until the caller commits the authoritative SQLite metadata row.
        fs.writeFileSync(pendingPath, 'pending\n', { mode: 0o600 });
        fs.writeFileSync(temporary, payload, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, target);
        objectPublished = true;
      } finally {
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          // Preserve the storage error that caused cleanup.
        }
        if (!objectPublished) fs.rmSync(pendingPath, { force: true });
      }
      return { backend: 'encrypted-filesystem', key };
    },
    read(key) {
      const safeKey = assertSafeRelativeKey(key);
      const payload = fs.readFileSync(resolveKey(safeKey));
      const minimumBytes = OBJECT_MAGIC.length + NONCE_BYTES + TAG_BYTES + 1;
      if (
        payload.length < minimumBytes ||
        !payload.subarray(0, OBJECT_MAGIC.length).equals(OBJECT_MAGIC)
      ) {
        throw new Error('encrypted object format is invalid');
      }
      const nonceStart = OBJECT_MAGIC.length;
      const tagStart = nonceStart + NONCE_BYTES;
      const ciphertextStart = tagStart + TAG_BYTES;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        input.keyProvider.getKey(),
        payload.subarray(nonceStart, tagStart),
      );
      decipher.setAAD(Buffer.from(safeKey));
      decipher.setAuthTag(payload.subarray(tagStart, ciphertextStart));
      return Buffer.concat([
        decipher.update(payload.subarray(ciphertextStart)),
        decipher.final(),
      ]);
    },
    markCommitted(key) {
      const target = resolveKey(key);
      fs.rmSync(resolvePendingPath(target), { force: true });
    },
    inspect(key) {
      const target = resolveKey(key);
      if (!fs.existsSync(target)) return null;
      const objectMetadata = fs.statSync(target);
      const pendingPath = resolvePendingPath(target);
      const pendingMetadata = fs.existsSync(pendingPath)
        ? fs.statSync(pendingPath)
        : null;
      return {
        lastModifiedAtMs: objectMetadata.mtimeMs,
        pendingSinceMs: pendingMetadata?.mtimeMs ?? null,
      };
    },
    delete(key) {
      const target = resolveKey(key);
      fs.rmSync(target, { force: true });
      fs.rmSync(resolvePendingPath(target), { force: true });
    },
    listKeys() {
      ensureStorageRoot(root);
      return filesBelow(root).filter((key) => {
        try {
          assertSafeRelativeKey(key);
          return true;
        } catch {
          return false;
        }
      });
    },
    sizeBytes() {
      return this.listKeys().reduce(
        (total, key) => total + fs.statSync(resolveKey(key)).size,
        0,
      );
    },
  };
}
