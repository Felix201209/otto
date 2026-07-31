/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { DatabaseHandle } from './sqliteCompat.js';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');
const SQLCIPHER_KEY_BYTES = 32;

export interface SqlCipherKeyMaterial {
  /** Stable provider identifier; never contains the key itself. */
  id: string;
  /** Monotonically increasing provider version. */
  version: number;
  /** 256-bit SQLCipher raw key. */
  key: Buffer;
}

export interface SqlCipherKeyRotation {
  current: SqlCipherKeyMaterial;
  next: SqlCipherKeyMaterial;
}

/**
 * Key providers may be backed by an OS keystore, KMS/HSM, or an offline file.
 * `beginRotation` must durably stage `next` before returning it so a process
 * crash between SQLCipher rekey and provider commit remains recoverable.
 */
export interface SqlCipherKeyProvider {
  getKeyCandidates(): readonly SqlCipherKeyMaterial[];
  beginRotation(): SqlCipherKeyRotation;
  commitRotation(rotation: SqlCipherKeyRotation): void;
  abortRotation(rotation: SqlCipherKeyRotation): void;
  /** Promote a staged/recovery candidate that successfully opened the DB. */
  recover(version: number): void;
  clear(): void;
}

export interface SqlCipherDriver {
  /** The implementation must apply PRAGMA key before any schema access. */
  open(input: {
    databasePath: string;
    key: Buffer;
    create: boolean;
    readOnly?: boolean;
  }): DatabaseHandle;
  /** Must check cipher availability and PRAGMA cipher_integrity_check. */
  verify(database: DatabaseHandle): void;
  /**
   * Export a checkpointed plaintext SQLite source with sqlcipher_export().
   * The destination must be created exclusively and encrypted with `key`.
   */
  migratePlaintext(input: {
    sourcePath: string;
    destinationPath: string;
    key: Buffer;
  }): void;
  /** Create a consistent encrypted snapshot, including committed WAL pages. */
  snapshot(input: {
    sourcePath: string;
    destinationPath: string;
    key: Buffer;
  }): void;
  /** Perform SQLCipher PRAGMA rekey without exposing the raw key in logs. */
  rekey(input: {
    databasePath: string;
    currentKey: Buffer;
    nextKey: Buffer;
  }): void;
}

export interface SqlCipherDatabaseStatus {
  encrypted: true;
  keyId: string;
  keyVersion: number;
  migratedFromPlaintext: boolean;
  recoveryPath?: string;
}

export interface SqlCipherDatabaseLifecycle {
  openDatabase(databasePath: string): DatabaseHandle;
  openSnapshot(databasePath: string): DatabaseHandle;
  rotateKey(): { keyVersion: number; recoveryPath: string };
  createSnapshot(destinationPath: string): void;
  getStatus(): SqlCipherDatabaseStatus;
  clearKeys(): void;
}

function assertKeyMaterial(material: SqlCipherKeyMaterial): void {
  if (!material.id.trim()) throw new Error('SQLCipher key id is required');
  if (!Number.isSafeInteger(material.version) || material.version <= 0) {
    throw new Error('SQLCipher key version must be a positive integer');
  }
  if (
    !Buffer.isBuffer(material.key) ||
    material.key.length !== SQLCIPHER_KEY_BYTES
  ) {
    throw new Error('SQLCipher requires a 32-byte raw key');
  }
}

function readKeyCandidates(
  provider: SqlCipherKeyProvider,
): SqlCipherKeyMaterial[] {
  const candidates = [...provider.getKeyCandidates()];
  if (candidates.length === 0) {
    throw new Error(
      'no SQLCipher key is available; refusing to create a plaintext database',
    );
  }
  const versions = new Set<number>();
  for (const candidate of candidates) {
    assertKeyMaterial(candidate);
    if (versions.has(candidate.version)) {
      throw new Error(`duplicate SQLCipher key version ${candidate.version}`);
    }
    versions.add(candidate.version);
  }
  return candidates;
}

function isPlaintextSqlite(databasePath: string): boolean {
  if (!fs.existsSync(databasePath)) return false;
  const descriptor = fs.openSync(databasePath, 'r');
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const read = fs.readSync(descriptor, header, 0, header.length, 0);
    return read === SQLITE_HEADER.length && header.equals(SQLITE_HEADER);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function createRecoveryPath(
  dataDirectory: string,
  databasePath: string,
  reason: 'plaintext' | 'rotation',
): string {
  const recoveryDirectory = path.join(dataDirectory, 'database-recovery');
  fs.mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  const name = path.basename(databasePath);
  return path.join(
    recoveryDirectory,
    `${name}.${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.bak`,
  );
}

function replaceWithRecovery(input: {
  databasePath: string;
  replacementPath: string;
  recoveryPath: string;
}): void {
  const movedSidecars: Array<{ source: string; recovery: string }> = [];
  fs.renameSync(input.databasePath, input.recoveryPath);
  try {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const source = `${input.databasePath}${suffix}`;
      if (!fs.existsSync(source)) continue;
      const recovery = `${input.recoveryPath}${suffix}`;
      fs.renameSync(source, recovery);
      movedSidecars.push({ source, recovery });
    }
    fs.renameSync(input.replacementPath, input.databasePath);
  } catch (error) {
    for (const sidecar of movedSidecars.reverse()) {
      if (fs.existsSync(sidecar.recovery)) {
        fs.renameSync(sidecar.recovery, sidecar.source);
      }
    }
    if (
      fs.existsSync(input.recoveryPath) &&
      !fs.existsSync(input.databasePath)
    ) {
      fs.renameSync(input.recoveryPath, input.databasePath);
    }
    throw error;
  }
}

function restoreDatabaseSetFromRecovery(
  recoveryPath: string,
  databasePath: string,
): void {
  fs.renameSync(recoveryPath, databasePath);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const recoverySidecar = `${recoveryPath}${suffix}`;
    if (fs.existsSync(recoverySidecar)) {
      fs.renameSync(recoverySidecar, `${databasePath}${suffix}`);
    }
  }
}

export function createSqlCipherDatabaseLifecycle(input: {
  dataDirectory: string;
  databasePath: string;
  keyProvider: SqlCipherKeyProvider;
  driver: SqlCipherDriver;
}): SqlCipherDatabaseLifecycle {
  let status: SqlCipherDatabaseStatus | null = null;

  function assertConfiguredPath(databasePath: string): void {
    if (path.resolve(databasePath) !== path.resolve(input.databasePath)) {
      throw new Error(
        'SQLCipher lifecycle refused an unexpected database path',
      );
    }
  }

  function openAndVerify(
    databasePath: string,
    material: SqlCipherKeyMaterial,
    create: boolean,
    readOnly = false,
  ): DatabaseHandle {
    const database = input.driver.open({
      databasePath,
      key: material.key,
      create,
      readOnly,
    });
    try {
      input.driver.verify(database);
      return database;
    } catch (error) {
      try {
        database.close();
      } catch {
        // Keep the integrity/key error as the primary failure.
      }
      throw error;
    }
  }

  function recordStatus(
    material: SqlCipherKeyMaterial,
    update: Pick<SqlCipherDatabaseStatus, 'migratedFromPlaintext'> & {
      recoveryPath?: string;
    },
  ): void {
    status = {
      encrypted: true,
      keyId: material.id,
      keyVersion: material.version,
      ...update,
    };
  }

  function migratePlaintext(material: SqlCipherKeyMaterial): DatabaseHandle {
    const temporaryPath = `${input.databasePath}.sqlcipher-migration-${randomUUID()}.tmp`;
    let recoveryPath: string | undefined;
    try {
      input.driver.migratePlaintext({
        sourcePath: input.databasePath,
        destinationPath: temporaryPath,
        key: material.key,
      });
      openAndVerify(temporaryPath, material, false, true).close();

      recoveryPath = createRecoveryPath(
        input.dataDirectory,
        input.databasePath,
        'plaintext',
      );
      replaceWithRecovery({
        databasePath: input.databasePath,
        replacementPath: temporaryPath,
        recoveryPath,
      });

      try {
        const database = openAndVerify(input.databasePath, material, false);
        recordStatus(material, {
          migratedFromPlaintext: true,
          recoveryPath,
        });
        return database;
      } catch (error) {
        const rejectedPath = `${temporaryPath}.rejected`;
        if (fs.existsSync(input.databasePath))
          fs.renameSync(input.databasePath, rejectedPath);
        restoreDatabaseSetFromRecovery(recoveryPath, input.databasePath);
        removeIfPresent(rejectedPath);
        throw error;
      }
    } finally {
      removeIfPresent(temporaryPath);
      if (recoveryPath && !fs.existsSync(recoveryPath)) {
        try {
          const recoveryDirectory = path.dirname(recoveryPath);
          if (fs.readdirSync(recoveryDirectory).length === 0)
            fs.rmdirSync(recoveryDirectory);
        } catch {
          // Empty-directory cleanup is best effort only.
        }
      }
    }
  }

  function openExistingCiphertext(
    candidates: SqlCipherKeyMaterial[],
  ): DatabaseHandle {
    const failures: unknown[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      try {
        const database = openAndVerify(input.databasePath, candidate, false);
        if (index > 0) {
          try {
            input.keyProvider.recover(candidate.version);
          } catch (error) {
            database.close();
            throw error;
          }
        }
        recordStatus(candidate, { migratedFromPlaintext: false });
        return database;
      } catch (error) {
        failures.push(error);
      }
    }
    throw new AggregateError(
      failures,
      'none of the configured SQLCipher keys can open the database; refusing plaintext fallback',
    );
  }

  function openDatabase(databasePath: string): DatabaseHandle {
    assertConfiguredPath(databasePath);
    fs.mkdirSync(input.dataDirectory, { recursive: true, mode: 0o700 });
    const candidates = readKeyCandidates(input.keyProvider);
    const active = candidates[0]!;

    if (
      !fs.existsSync(input.databasePath) ||
      fs.statSync(input.databasePath).size === 0
    ) {
      const database = openAndVerify(input.databasePath, active, true);
      recordStatus(active, { migratedFromPlaintext: false });
      return database;
    }
    if (isPlaintextSqlite(input.databasePath)) return migratePlaintext(active);
    return openExistingCiphertext(candidates);
  }

  function createSnapshot(destinationPath: string): void {
    const candidates = readKeyCandidates(input.keyProvider);
    const current = status
      ? candidates.find((candidate) => candidate.version === status!.keyVersion)
      : candidates[0];
    if (!current)
      throw new Error('active SQLCipher key is unavailable for snapshot');
    if (fs.existsSync(destinationPath)) {
      throw new Error('SQLCipher snapshot destination already exists');
    }
    input.driver.snapshot({
      sourcePath: input.databasePath,
      destinationPath,
      key: current.key,
    });
    openAndVerify(destinationPath, current, false, true).close();
  }

  function openSnapshot(databasePath: string): DatabaseHandle {
    const candidates = readKeyCandidates(input.keyProvider);
    const current = status
      ? candidates.find((candidate) => candidate.version === status!.keyVersion)
      : candidates[0];
    if (!current)
      throw new Error('active SQLCipher key is unavailable for snapshot');
    return openAndVerify(databasePath, current, false, true);
  }

  function restoreRotationSnapshot(
    recoveryPath: string,
    rotation: SqlCipherKeyRotation,
  ): void {
    const rejectedPath = `${input.databasePath}.failed-rotation-${randomUUID()}`;
    const rejectedSidecars: Array<{ original: string; rejected: string }> = [];
    if (fs.existsSync(input.databasePath))
      fs.renameSync(input.databasePath, rejectedPath);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const original = `${input.databasePath}${suffix}`;
      if (!fs.existsSync(original)) continue;
      const rejected = `${rejectedPath}${suffix}`;
      fs.renameSync(original, rejected);
      rejectedSidecars.push({ original, rejected });
    }
    try {
      fs.copyFileSync(
        recoveryPath,
        input.databasePath,
        fs.constants.COPYFILE_EXCL,
      );
      openAndVerify(input.databasePath, rotation.current, false, true).close();
    } catch (error) {
      removeIfPresent(input.databasePath);
      if (fs.existsSync(rejectedPath))
        fs.renameSync(rejectedPath, input.databasePath);
      for (const sidecar of rejectedSidecars) {
        if (fs.existsSync(sidecar.rejected)) {
          fs.renameSync(sidecar.rejected, sidecar.original);
        }
      }
      throw new AggregateError(
        [error],
        'SQLCipher rekey failed and the recovery snapshot could not be restored',
      );
    }
    removeIfPresent(rejectedPath);
    for (const sidecar of rejectedSidecars) removeIfPresent(sidecar.rejected);
  }

  function rotateKey(): { keyVersion: number; recoveryPath: string } {
    if (
      !fs.existsSync(input.databasePath) ||
      isPlaintextSqlite(input.databasePath)
    ) {
      throw new Error(
        'SQLCipher key rotation requires an existing encrypted database',
      );
    }
    const rotation = input.keyProvider.beginRotation();
    assertKeyMaterial(rotation.current);
    assertKeyMaterial(rotation.next);
    if (rotation.next.version <= rotation.current.version) {
      throw new Error(
        'next SQLCipher key version must be newer than the current version',
      );
    }
    if (rotation.current.key.equals(rotation.next.key)) {
      throw new Error('next SQLCipher key must differ from the current key');
    }

    const recoveryPath = createRecoveryPath(
      input.dataDirectory,
      input.databasePath,
      'rotation',
    );
    let snapshotCreated = false;
    try {
      input.driver.snapshot({
        sourcePath: input.databasePath,
        destinationPath: recoveryPath,
        key: rotation.current.key,
      });
      snapshotCreated = true;
      openAndVerify(recoveryPath, rotation.current, false, true).close();
      input.driver.rekey({
        databasePath: input.databasePath,
        currentKey: rotation.current.key,
        nextKey: rotation.next.key,
      });
      openAndVerify(input.databasePath, rotation.next, false, true).close();
      input.keyProvider.commitRotation(rotation);
      recordStatus(rotation.next, {
        migratedFromPlaintext: false,
        recoveryPath,
      });
      return { keyVersion: rotation.next.version, recoveryPath };
    } catch (error) {
      let restoreError: unknown;
      if (snapshotCreated) {
        try {
          restoreRotationSnapshot(recoveryPath, rotation);
        } catch (caught) {
          restoreError = caught;
        }
      }
      try {
        input.keyProvider.abortRotation(rotation);
      } catch (abortError) {
        restoreError ??= abortError;
      }
      if (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'SQLCipher key rotation failed and recovery requires operator action',
        );
      }
      throw error;
    }
  }

  function getStatus(): SqlCipherDatabaseStatus {
    if (!status) throw new Error('SQLCipher database has not been opened');
    return { ...status };
  }

  return {
    openDatabase,
    openSnapshot,
    rotateKey,
    createSnapshot,
    getStatus,
    clearKeys: input.keyProvider.clear,
  };
}
