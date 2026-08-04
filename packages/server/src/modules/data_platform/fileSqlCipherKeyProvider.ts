/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  SqlCipherKeyMaterial,
  SqlCipherKeyProvider,
  SqlCipherKeyRotation,
} from './sqlCipherDatabaseLifecycle.js';

const FORMAT = 'otto-sqlcipher-keyring-v1';
const KEY_BYTES = 32;

interface SerializedKey {
  id: string;
  version: number;
  keyBase64: string;
}

interface SerializedKeyring {
  format: typeof FORMAT;
  activeVersion: number;
  pendingVersion?: number;
  keys: SerializedKey[];
}

interface LoadedKeyring {
  activeVersion: number;
  pendingVersion?: number;
  keys: SqlCipherKeyMaterial[];
}

function assertRegularFile(keyPath: string): void {
  const metadata = fs.lstatSync(keyPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('SQLCipher key path must be a regular file');
  }
}

function decodeKey(serialized: SerializedKey): SqlCipherKeyMaterial {
  if (!serialized || typeof serialized !== 'object') {
    throw new Error('SQLCipher keyring contains an invalid key record');
  }
  const key = Buffer.from(serialized.keyBase64, 'base64');
  if (
    !serialized.id?.trim() ||
    !Number.isSafeInteger(serialized.version) ||
    serialized.version <= 0 ||
    key.length !== KEY_BYTES
  ) {
    key.fill(0);
    throw new Error('SQLCipher keyring contains invalid key material');
  }
  return { id: serialized.id, version: serialized.version, key };
}

function parseKeyring(contents: Buffer, fallbackKeyId: string): LoadedKeyring {
  if (contents.length === KEY_BYTES) {
    return {
      activeVersion: 1,
      keys: [{ id: fallbackKeyId, version: 1, key: Buffer.from(contents) }],
    };
  }

  let serialized: SerializedKeyring;
  try {
    serialized = JSON.parse(contents.toString('utf8')) as SerializedKeyring;
  } catch {
    throw new Error(
      'SQLCipher keyring is neither a 32-byte raw key nor valid JSON',
    );
  }
  if (
    serialized.format !== FORMAT ||
    !Number.isSafeInteger(serialized.activeVersion) ||
    !Array.isArray(serialized.keys) ||
    serialized.keys.length === 0
  ) {
    throw new Error('SQLCipher keyring format is invalid');
  }

  const keys = serialized.keys.map(decodeKey);
  const versions = new Set(keys.map((entry) => entry.version));
  if (
    versions.size !== keys.length ||
    !versions.has(serialized.activeVersion) ||
    (serialized.pendingVersion !== undefined &&
      !versions.has(serialized.pendingVersion))
  ) {
    for (const entry of keys) entry.key.fill(0);
    throw new Error('SQLCipher keyring version references are invalid');
  }
  return {
    activeVersion: serialized.activeVersion,
    pendingVersion: serialized.pendingVersion,
    keys,
  };
}

function serializeKeyring(keyring: LoadedKeyring): string {
  const serialized: SerializedKeyring = {
    format: FORMAT,
    activeVersion: keyring.activeVersion,
    ...(keyring.pendingVersion === undefined
      ? {}
      : { pendingVersion: keyring.pendingVersion }),
    keys: keyring.keys.map((entry) => ({
      id: entry.id,
      version: entry.version,
      keyBase64: entry.key.toString('base64'),
    })),
  };
  return `${JSON.stringify(serialized, null, 2)}\n`;
}

function orderCandidates(keyring: LoadedKeyring): SqlCipherKeyMaterial[] {
  const order = [
    keyring.activeVersion,
    ...(keyring.pendingVersion === undefined ? [] : [keyring.pendingVersion]),
    ...keyring.keys.map((entry) => entry.version),
  ];
  const emitted = new Set<number>();
  return order.flatMap((version) => {
    if (emitted.has(version)) return [];
    emitted.add(version);
    const material = keyring.keys.find((entry) => entry.version === version);
    return material ? [material] : [];
  });
}

/**
 * Offline key-file provider with a two-phase keyring for crash-safe rekey.
 * For removable/air-gapped custody files use `writable: false`; rotation must
 * then be performed by the custody system and imported as a new version.
 */
export function createFileSqlCipherKeyProvider(input: {
  keyPath: string;
  keyId?: string;
  createIfMissing?: boolean;
  writable?: boolean;
  managePermissions?: boolean;
}): SqlCipherKeyProvider {
  const keyId = input.keyId?.trim() || 'otto-file-sqlcipher-key';
  const writable = input.writable !== false;
  let cached: LoadedKeyring | null = null;

  function writeKeyring(keyring: LoadedKeyring): void {
    if (!writable) {
      throw new Error('read-only offline key cannot be changed by Otto');
    }
    fs.mkdirSync(path.dirname(input.keyPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${input.keyPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, serializeKeyring(keyring), {
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, input.keyPath);
      if (input.managePermissions !== false) {
        try {
          fs.chmodSync(input.keyPath, 0o600);
        } catch {
          // Windows protects this file through the data-directory ACL.
        }
      }
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the keyring write/rename result; orphan temp cleanup is best effort.
      }
    }
  }

  function createKeyring(): LoadedKeyring {
    const keyring: LoadedKeyring = {
      activeVersion: 1,
      keys: [{ id: keyId, version: 1, key: randomBytes(KEY_BYTES) }],
    };
    try {
      writeKeyring(keyring);
      return keyring;
    } catch (error) {
      for (const material of keyring.keys) material.key.fill(0);
      throw error;
    }
  }

  function load(): LoadedKeyring {
    if (cached) return cached;
    try {
      assertRegularFile(input.keyPath);
      cached = parseKeyring(fs.readFileSync(input.keyPath), keyId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (input.createIfMissing === false) {
        throw new Error('configured SQLCipher custody key file does not exist');
      }
      cached = createKeyring();
    }
    return cached;
  }

  function findVersion(
    keyring: LoadedKeyring,
    version: number,
  ): SqlCipherKeyMaterial {
    const material = keyring.keys.find((entry) => entry.version === version);
    if (!material)
      throw new Error(`SQLCipher key version ${version} is not staged`);
    return material;
  }

  function beginRotation(): SqlCipherKeyRotation {
    if (!writable)
      throw new Error('read-only offline key cannot be rotated by Otto');
    const keyring = load();
    const current = findVersion(keyring, keyring.activeVersion);
    if (keyring.pendingVersion !== undefined) {
      return {
        current,
        next: findVersion(keyring, keyring.pendingVersion),
      };
    }
    const nextVersion =
      Math.max(...keyring.keys.map((entry) => entry.version)) + 1;
    const next: SqlCipherKeyMaterial = {
      id: `${keyId}:v${nextVersion}`,
      version: nextVersion,
      key: randomBytes(KEY_BYTES),
    };
    keyring.pendingVersion = nextVersion;
    keyring.keys.push(next);
    writeKeyring(keyring);
    return { current, next };
  }

  function validateRotation(
    keyring: LoadedKeyring,
    rotation: SqlCipherKeyRotation,
  ): { current: SqlCipherKeyMaterial; next: SqlCipherKeyMaterial } {
    const current = findVersion(keyring, rotation.current.version);
    const next = findVersion(keyring, rotation.next.version);
    if (
      keyring.activeVersion !== current.version ||
      keyring.pendingVersion !== next.version ||
      !current.key.equals(rotation.current.key) ||
      !next.key.equals(rotation.next.key)
    ) {
      throw new Error(
        'SQLCipher key rotation does not match the persisted keyring',
      );
    }
    return { current, next };
  }

  return {
    getKeyCandidates() {
      return orderCandidates(load());
    },
    beginRotation,
    commitRotation(rotation) {
      if (!writable)
        throw new Error('read-only offline key cannot be changed by Otto');
      const keyring = load();
      const { current, next } = validateRotation(keyring, rotation);
      keyring.activeVersion = next.version;
      keyring.pendingVersion = undefined;
      keyring.keys = [next, current];
      writeKeyring(keyring);
    },
    abortRotation(rotation) {
      if (!writable)
        throw new Error('read-only offline key cannot be changed by Otto');
      const keyring = load();
      const { next } = validateRotation(keyring, rotation);
      keyring.pendingVersion = undefined;
      keyring.keys = keyring.keys.filter(
        (entry) => entry.version !== next.version,
      );
      writeKeyring(keyring);
      next.key.fill(0);
    },
    recover(version) {
      if (!writable) {
        if (load().activeVersion !== version) {
          throw new Error(
            'read-only offline key cannot promote a recovery version',
          );
        }
        return;
      }
      const keyring = load();
      findVersion(keyring, version);
      keyring.activeVersion = version;
      keyring.pendingVersion = undefined;
      const active = findVersion(keyring, version);
      keyring.keys = [
        active,
        ...keyring.keys
          .filter((entry) => entry.version !== version)
          .slice(0, 1),
      ];
      writeKeyring(keyring);
    },
    clear() {
      if (!cached) return;
      for (const material of cached.keys) material.key.fill(0);
      cached = null;
    },
  };
}
