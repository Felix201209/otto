/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { KeyProvider, WrappedKey } from './keyProvider.js';
import type {
  SqlCipherKeyMaterial,
  SqlCipherKeyProvider,
  SqlCipherKeyRotation,
} from './sqlCipherDatabaseLifecycle.js';

const FORMAT = 'otto-enveloped-sqlcipher-keyring-v1';

interface EnvelopedDek {
  id: string;
  version: number;
  wrapped: WrappedKey;
  createdAt: string;
}

export interface EnvelopedSqlCipherManifest {
  format: typeof FORMAT;
  activeVersion: number;
  pendingVersion?: number;
  entries: EnvelopedDek[];
}

export interface EnvelopeManifestStore {
  load(): EnvelopedSqlCipherManifest | null;
  save(manifest: EnvelopedSqlCipherManifest): void;
}

interface SerializedManifest {
  format: typeof FORMAT;
  activeVersion: number;
  pendingVersion?: number;
  entries: Array<{
    id: string;
    version: number;
    createdAt: string;
    wrapped: Omit<WrappedKey, 'ciphertext'> & { ciphertextBase64: string };
  }>;
}

function cloneManifest(
  manifest: EnvelopedSqlCipherManifest,
): EnvelopedSqlCipherManifest {
  return {
    ...manifest,
    entries: manifest.entries.map((entry) => ({
      ...entry,
      wrapped: {
        ...entry.wrapped,
        ciphertext: Buffer.from(entry.wrapped.ciphertext),
      },
    })),
  };
}

function parseManifest(
  serialized: SerializedManifest,
): EnvelopedSqlCipherManifest {
  if (
    serialized?.format !== FORMAT ||
    !Number.isSafeInteger(serialized.activeVersion) ||
    serialized.activeVersion <= 0 ||
    !Array.isArray(serialized.entries) ||
    serialized.entries.length === 0
  ) {
    throw new Error('SQLCipher envelope manifest is invalid');
  }
  const entries = serialized.entries.map((entry) => ({
    id: entry.id,
    version: entry.version,
    createdAt: entry.createdAt,
    wrapped: {
      provider: entry.wrapped.provider,
      keyId: entry.wrapped.keyId,
      keyVersion: entry.wrapped.keyVersion,
      ciphertext: Buffer.from(entry.wrapped.ciphertextBase64, 'base64'),
    },
  }));
  const versions = new Set<number>();
  for (const entry of entries) {
    if (
      !entry.id?.trim() ||
      !Number.isSafeInteger(entry.version) ||
      entry.version <= 0 ||
      !entry.createdAt ||
      entry.wrapped.ciphertext.length === 0 ||
      versions.has(entry.version)
    ) {
      throw new Error('SQLCipher envelope manifest contains an invalid entry');
    }
    versions.add(entry.version);
  }
  if (
    !versions.has(serialized.activeVersion) ||
    (serialized.pendingVersion !== undefined &&
      !versions.has(serialized.pendingVersion))
  ) {
    throw new Error(
      'SQLCipher envelope manifest version references are invalid',
    );
  }
  return {
    format: FORMAT,
    activeVersion: serialized.activeVersion,
    ...(serialized.pendingVersion === undefined
      ? {}
      : { pendingVersion: serialized.pendingVersion }),
    entries,
  };
}

function serializeManifest(manifest: EnvelopedSqlCipherManifest): string {
  const serialized: SerializedManifest = {
    format: FORMAT,
    activeVersion: manifest.activeVersion,
    ...(manifest.pendingVersion === undefined
      ? {}
      : { pendingVersion: manifest.pendingVersion }),
    entries: manifest.entries.map((entry) => ({
      id: entry.id,
      version: entry.version,
      createdAt: entry.createdAt,
      wrapped: {
        provider: entry.wrapped.provider,
        keyId: entry.wrapped.keyId,
        keyVersion: entry.wrapped.keyVersion,
        ciphertextBase64: entry.wrapped.ciphertext.toString('base64'),
      },
    })),
  };
  return `${JSON.stringify(serialized, null, 2)}\n`;
}

export function createFileEnvelopeManifestStore(
  manifestPath: string,
): EnvelopeManifestStore {
  const resolvedPath = path.resolve(manifestPath);
  return {
    load() {
      try {
        const metadata = fs.lstatSync(resolvedPath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error('SQLCipher envelope manifest must be a regular file');
        }
        return parseManifest(
          JSON.parse(
            fs.readFileSync(resolvedPath, 'utf8'),
          ) as SerializedManifest,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    save(manifest) {
      fs.mkdirSync(path.dirname(resolvedPath), {
        recursive: true,
        mode: 0o700,
      });
      const temporaryPath = `${resolvedPath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporaryPath, serializeManifest(manifest), {
          flag: 'wx',
          mode: 0o600,
        });
        fs.renameSync(temporaryPath, resolvedPath);
        try {
          fs.chmodSync(resolvedPath, 0o600);
        } catch {
          // Windows deployments protect the data directory with an ACL.
        }
      } finally {
        try {
          fs.unlinkSync(temporaryPath);
        } catch {
          // Atomic rename is authoritative; orphan temp cleanup is best effort.
        }
      }
    },
  };
}

export interface EnvelopedSqlCipherKeyProvider extends SqlCipherKeyProvider {
  prepareDekRotation(): Promise<SqlCipherKeyRotation>;
  cancelPreparedDekRotation(rotation: SqlCipherKeyRotation): void;
  prepareKekRotation(): Promise<{
    rotationId: string;
    previousKekVersions: string[];
    activeKekVersion: string;
    dekVersions: number[];
  }>;
  activateKekRotation(rotationId: string): void;
  abortKekRotation(rotationId: string): void;
  getEnvelopeStatus(): {
    provider: WrappedKey['provider'];
    keyId: string;
    kekVersion: string;
    activeDekVersion: number;
    pendingDekVersion: number | null;
    retainedDekVersions: number[];
  };
}

function entryByVersion(
  manifest: EnvelopedSqlCipherManifest,
  version: number,
): EnvelopedDek {
  const entry = manifest.entries.find(
    (candidate) => candidate.version === version,
  );
  if (!entry)
    throw new Error(`SQLCipher DEK version ${version} is unavailable`);
  return entry;
}

function orderedVersions(manifest: EnvelopedSqlCipherManifest): number[] {
  return [
    manifest.activeVersion,
    ...(manifest.pendingVersion === undefined ? [] : [manifest.pendingVersion]),
    ...manifest.entries.map((entry) => entry.version),
  ].filter((version, index, values) => values.indexOf(version) === index);
}

export async function initializeEnvelopedSqlCipherKeyProvider(input: {
  databaseId: string;
  keyProvider: KeyProvider;
  manifestStore: EnvelopeManifestStore;
  createIfMissing?: boolean;
  now?: () => Date;
}): Promise<EnvelopedSqlCipherKeyProvider> {
  const databaseId = input.databaseId.trim();
  if (!databaseId || databaseId.length > 256 || /[\0\r\n]/.test(databaseId)) {
    throw new Error('SQLCipher envelope database id is invalid');
  }
  await input.keyProvider.healthCheck();
  const context = { purpose: 'database-dek' as const, scopeId: databaseId };
  const now = input.now ?? (() => new Date());
  let manifest = input.manifestStore.load();
  const keys = new Map<number, SqlCipherKeyMaterial>();
  const preparedKekRotations = new Map<
    string,
    {
      manifest: EnvelopedSqlCipherManifest;
      summary: {
        rotationId: string;
        previousKekVersions: string[];
        activeKekVersion: string;
        dekVersions: number[];
      };
    }
  >();

  if (!manifest) {
    if (input.createIfMissing !== true) {
      throw new Error(
        'SQLCipher envelope manifest is unavailable; refusing plaintext or default-key fallback',
      );
    }
    const key = randomBytes(32);
    try {
      const wrapped = await input.keyProvider.wrap(key, context);
      manifest = {
        format: FORMAT,
        activeVersion: 1,
        entries: [
          {
            id: randomUUID(),
            version: 1,
            wrapped,
            createdAt: now().toISOString(),
          },
        ],
      };
      input.manifestStore.save(manifest);
      keys.set(1, { id: manifest.entries[0]!.id, version: 1, key });
    } catch (error) {
      key.fill(0);
      throw error;
    }
  } else {
    try {
      for (const version of orderedVersions(manifest)) {
        const entry = entryByVersion(manifest, version);
        const key = await input.keyProvider.unwrap(entry.wrapped, context);
        keys.set(version, { id: entry.id, version, key });
      }
    } catch (error) {
      for (const material of keys.values()) material.key.fill(0);
      keys.clear();
      throw new AggregateError(
        [error],
        'unable to unwrap the SQLCipher DEK; refusing to start',
      );
    }
  }

  function material(version: number): SqlCipherKeyMaterial {
    const value = keys.get(version);
    if (!value)
      throw new Error(`SQLCipher DEK version ${version} is not loaded`);
    return value;
  }

  function persist(next: EnvelopedSqlCipherManifest): void {
    input.manifestStore.save(next);
    manifest = cloneManifest(next);
  }

  function validateRotation(rotation: SqlCipherKeyRotation): void {
    if (
      manifest!.activeVersion !== rotation.current.version ||
      manifest!.pendingVersion !== rotation.next.version ||
      !material(rotation.current.version).key.equals(rotation.current.key) ||
      !material(rotation.next.version).key.equals(rotation.next.key)
    ) {
      throw new Error(
        'prepared SQLCipher DEK rotation does not match the envelope manifest',
      );
    }
  }

  function abortRotation(rotation: SqlCipherKeyRotation): void {
    validateRotation(rotation);
    const nextManifest = cloneManifest(manifest!);
    nextManifest.pendingVersion = undefined;
    nextManifest.entries = nextManifest.entries.filter(
      (entry) => entry.version !== rotation.next.version,
    );
    persist(nextManifest);
    material(rotation.next.version).key.fill(0);
    keys.delete(rotation.next.version);
  }

  return {
    getKeyCandidates() {
      return orderedVersions(manifest!).map(material);
    },
    async prepareDekRotation() {
      const current = material(manifest!.activeVersion);
      if (manifest!.pendingVersion !== undefined) {
        return { current, next: material(manifest!.pendingVersion) };
      }
      const nextVersion =
        Math.max(...manifest!.entries.map((entry) => entry.version)) + 1;
      const key = randomBytes(32);
      try {
        const wrapped = await input.keyProvider.wrap(key, context);
        const nextManifest: EnvelopedSqlCipherManifest = {
          ...cloneManifest(manifest!),
          pendingVersion: nextVersion,
          entries: [
            ...manifest!.entries,
            {
              id: randomUUID(),
              version: nextVersion,
              wrapped,
              createdAt: now().toISOString(),
            },
          ],
        };
        input.manifestStore.save(nextManifest);
        manifest = cloneManifest(nextManifest);
        const next = {
          id: entryByVersion(manifest, nextVersion).id,
          version: nextVersion,
          key,
        };
        keys.set(nextVersion, next);
        return { current, next };
      } catch (error) {
        key.fill(0);
        throw error;
      }
    },
    beginRotation() {
      if (manifest!.pendingVersion === undefined) {
        throw new Error('SQLCipher DEK rotation must be prepared before rekey');
      }
      return {
        current: material(manifest!.activeVersion),
        next: material(manifest!.pendingVersion),
      };
    },
    commitRotation(rotation) {
      validateRotation(rotation);
      const currentEntry = entryByVersion(manifest!, rotation.current.version);
      const nextEntry = entryByVersion(manifest!, rotation.next.version);
      persist({
        format: FORMAT,
        activeVersion: rotation.next.version,
        entries: [nextEntry, currentEntry],
      });
      for (const version of [...keys.keys()]) {
        if (
          version === rotation.next.version ||
          version === rotation.current.version
        )
          continue;
        material(version).key.fill(0);
        keys.delete(version);
      }
    },
    abortRotation,
    cancelPreparedDekRotation(rotation) {
      if (manifest!.pendingVersion === rotation.next.version) {
        abortRotation(rotation);
      }
    },
    recover(version) {
      entryByVersion(manifest!, version);
      const activeEntry = entryByVersion(manifest!, version);
      const previous = manifest!.entries.find(
        (entry) => entry.version !== version,
      );
      persist({
        format: FORMAT,
        activeVersion: version,
        entries: [activeEntry, ...(previous ? [previous] : [])],
      });
    },
    async prepareKekRotation() {
      if (preparedKekRotations.size > 0) {
        throw new Error('a KEK rotation is already prepared');
      }
      await input.keyProvider.healthCheck();
      const previousKekVersions = [
        ...new Set(manifest!.entries.map((entry) => entry.wrapped.keyVersion)),
      ];
      const entries: EnvelopedDek[] = [];
      for (const entry of manifest!.entries) {
        const wrapped = await input.keyProvider.rewrap(entry.wrapped, context);
        const verification = await input.keyProvider.unwrap(wrapped, context);
        try {
          if (!verification.equals(material(entry.version).key)) {
            throw new Error('rewrapped SQLCipher DEK verification failed');
          }
        } finally {
          verification.fill(0);
        }
        entries.push({ ...entry, wrapped });
      }
      const nextManifest = { ...cloneManifest(manifest!), entries };
      const activeKekVersion = entryByVersion(
        nextManifest,
        nextManifest.activeVersion,
      ).wrapped.keyVersion;
      const rotationId = randomUUID();
      const summary = {
        rotationId,
        previousKekVersions,
        activeKekVersion,
        dekVersions: nextManifest.entries.map((entry) => entry.version),
      };
      preparedKekRotations.set(rotationId, {
        manifest: nextManifest,
        summary,
      });
      return { ...summary };
    },
    activateKekRotation(rotationId) {
      const prepared = preparedKekRotations.get(rotationId);
      if (!prepared) throw new Error('prepared KEK rotation is unavailable');
      persist(prepared.manifest);
      preparedKekRotations.delete(rotationId);
    },
    abortKekRotation(rotationId) {
      if (!preparedKekRotations.delete(rotationId)) {
        throw new Error('prepared KEK rotation is unavailable');
      }
    },
    getEnvelopeStatus() {
      const active = entryByVersion(manifest!, manifest!.activeVersion);
      return {
        provider: active.wrapped.provider,
        keyId: active.wrapped.keyId,
        kekVersion: active.wrapped.keyVersion,
        activeDekVersion: manifest!.activeVersion,
        pendingDekVersion: manifest!.pendingVersion ?? null,
        retainedDekVersions: manifest!.entries.map((entry) => entry.version),
      };
    },
    clear() {
      for (const value of keys.values()) value.key.fill(0);
      keys.clear();
      preparedKekRotations.clear();
    },
  };
}
