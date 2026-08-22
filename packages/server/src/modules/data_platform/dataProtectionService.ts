/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createEncryptedBackupArchive,
  verifyEncryptedBackupArchiveKey,
} from './encryptedBackupArchive.js';
import type { EncryptedObjectStore } from './encryptedObjectStore.js';
import { Database, type DatabaseHandle } from './sqliteCompat.js';

const BACKUP_NAME_PATTERN =
  /^otto-enterprise-(\d{8}T\d{6}Z)-([0-9a-f]{8})\.otto-backup$/;

export interface DataProtectionStatus {
  enabled: boolean;
  running: boolean;
  backupDirectory: string;
  replicaDirectory: string | null;
  intervalHours: number;
  retentionDays: number;
  minimumRetained: number;
  backupCount: number;
  latestBackupAt: string | null;
  latestBackupPath: string | null;
  latestBackupBytes: number | null;
  latestBackupSha256: string | null;
  latestSchemaVersion: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastReplicaAt: string | null;
  lastReplicaError: string | null;
  lastOrphanSweepAt: string | null;
  orphanObjectsRemoved: number;
  availableBytes: number | null;
  minimumFreeBytes: number;
  capacityWarning: boolean;
}

export interface DataProtectionServiceOptions {
  dataDirectory: string;
  databasePath: string;
  schemaVersion: number;
  accountSyncKeyPath: string;
  attachmentKeyPath: string;
  fieldEncryptionKeyPath: string;
  /** Exportable offline keyring or a KMS/keystore recovery envelope. */
  databaseKeyRecoveryPath?: string;
  attachmentDirectory: string;
  privacyDeletionLedgerPath?: string;
  privacyDeletionLedgerKeyPath?: string;
  attachmentObjectStore: EncryptedObjectStore;
  getDatabase(): DatabaseHandle;
  createDatabaseSnapshot?: (destinationPath: string) => void | Promise<void>;
  openDatabaseSnapshot?: (databasePath: string) => DatabaseHandle;
  backupDirectory?: string;
  replicaDirectory?: string | null;
  encryptionKey?: string;
  encryptionKeyPath?: string;
  /** Separate offline/secret-volume custody copy; never place beside backup archives. */
  encryptionKeyRecoveryPath?: string;
  intervalHours?: number;
  retentionDays?: number;
  minimumRetained?: number;
  orphanGraceMs?: number;
  minimumFreeBytes?: number;
  appVersion?: () => string;
  buildCommit?: () => string;
  now?: () => Date;
}

export interface DataProtectionService {
  getStatus(): DataProtectionStatus;
  runBackup(
    reason?: 'scheduled' | 'manual' | 'startup',
  ): Promise<DataProtectionStatus>;
  sweepOrphanAttachments(): number;
  start(): () => void;
}

export function parseDataProtectionEncryptionKey(value: string): Buffer {
  const clean = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(clean)
    ? Buffer.from(clean, 'hex')
    : Buffer.from(clean, 'base64');
  if (key.length !== 32)
    throw new Error('backup encryption key must be 32 bytes');
  return key;
}

export function loadOrCreateDataProtectionEncryptionKey(
  options: Pick<
    DataProtectionServiceOptions,
    | 'dataDirectory'
    | 'encryptionKey'
    | 'encryptionKeyPath'
    | 'encryptionKeyRecoveryPath'
  >,
  hasExistingBackups = false,
): Buffer {
  if (options.encryptionKey?.trim()) {
    return parseDataProtectionEncryptionKey(options.encryptionKey);
  }
  const keyPath = path.resolve(
    options.encryptionKeyPath ??
      path.join(options.dataDirectory, 'backup-encryption.key'),
  );
  if (fs.existsSync(keyPath)) {
    const metadata = fs.lstatSync(keyPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('backup encryption key path is unsafe');
    }
    return parseDataProtectionEncryptionKey(fs.readFileSync(keyPath, 'utf8'));
  }
  const recoveryPath = options.encryptionKeyRecoveryPath?.trim()
    ? path.resolve(options.encryptionKeyRecoveryPath)
    : null;
  if (recoveryPath && fs.existsSync(recoveryPath)) {
    const metadata = fs.lstatSync(recoveryPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('backup encryption recovery key path is unsafe');
    }
    return parseDataProtectionEncryptionKey(
      fs.readFileSync(recoveryPath, 'utf8'),
    );
  }
  if (hasExistingBackups) {
    throw new Error(
      'backup encryption key is unavailable for existing backups',
    );
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  fs.writeFileSync(keyPath, `${key.toString('base64')}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return key;
}

export function loadExistingDataProtectionEncryptionKey(
  options: Pick<
    DataProtectionServiceOptions,
    | 'dataDirectory'
    | 'encryptionKey'
    | 'encryptionKeyPath'
    | 'encryptionKeyRecoveryPath'
  >,
): Buffer {
  if (options.encryptionKey?.trim()) {
    return parseDataProtectionEncryptionKey(options.encryptionKey);
  }
  const keyPath = path.resolve(
    options.encryptionKeyPath ??
      path.join(options.dataDirectory, 'backup-encryption.key'),
  );
  if (!fs.existsSync(keyPath)) {
    const recoveryPath = options.encryptionKeyRecoveryPath?.trim()
      ? path.resolve(options.encryptionKeyRecoveryPath)
      : null;
    if (!recoveryPath || !fs.existsSync(recoveryPath)) {
      throw new Error('backup encryption key is unavailable');
    }
    const recoveryMetadata = fs.lstatSync(recoveryPath);
    if (recoveryMetadata.isSymbolicLink() || !recoveryMetadata.isFile()) {
      throw new Error('backup encryption recovery key path is unsafe');
    }
    return parseDataProtectionEncryptionKey(
      fs.readFileSync(recoveryPath, 'utf8'),
    );
  }
  const metadata = fs.lstatSync(keyPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('backup encryption key path is unsafe');
  }
  return parseDataProtectionEncryptionKey(fs.readFileSync(keyPath, 'utf8'));
}

function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function safeDirectoryPath(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved)) {
    const metadata = fs.lstatSync(resolved);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`${label} must be a real directory`);
    }
  }
  return resolved;
}

function ensureSafeDirectory(directory: string, label: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function availableBytes(directory: string): number | null {
  try {
    const stats = fs.statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function listBackupFiles(directory: string): Array<{
  name: string;
  path: string;
  createdAt: number;
  bytes: number;
}> {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_NAME_PATTERN.test(entry.name))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      const metadata = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        createdAt: metadata.mtimeMs,
        bytes: metadata.size,
      };
    })
    .sort((left, right) => right.createdAt - left.createdAt);
}

function validateSnapshot(
  databasePath: string,
  expectedSchema: number,
  openDatabase: (databasePath: string) => DatabaseHandle = (snapshotPath) =>
    new Database(snapshotPath, { readOnly: true }),
): number {
  const database = openDatabase(databasePath);
  try {
    const quickCheck = database.prepare('PRAGMA quick_check').get() as
      { quick_check?: string } | undefined;
    if (quickCheck?.quick_check !== 'ok')
      throw new Error('backup SQLite quick_check failed');
    const foreignKeyIssue = database.prepare('PRAGMA foreign_key_check').get();
    if (foreignKeyIssue)
      throw new Error('backup SQLite foreign_key_check failed');
    const row = database.prepare('PRAGMA user_version').get() as
      { user_version?: number } | undefined;
    const schemaVersion = Number(row?.user_version ?? 0);
    if (schemaVersion !== expectedSchema) {
      throw new Error(
        `backup schema ${schemaVersion} does not match runtime schema ${expectedSchema}`,
      );
    }
    return schemaVersion;
  } finally {
    database.close();
  }
}

function readPersistedStatus(
  statusPath: string,
): Partial<DataProtectionStatus> {
  try {
    const metadata = fs.lstatSync(statusPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return {};
    return JSON.parse(
      fs.readFileSync(statusPath, 'utf8'),
    ) as Partial<DataProtectionStatus>;
  } catch {
    return {};
  }
}

interface BackupKeyCustodyMarker {
  format: 1;
  keyId: string;
  adoptedAt: string;
}

function backupEncryptionKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}

function backupKeyCustodyMarkerPath(dataDirectory: string): string {
  return path.join(dataDirectory, 'backup-key-custody.json');
}

function readBackupKeyCustodyMarker(
  dataDirectory: string,
): BackupKeyCustodyMarker | null {
  const markerPath = backupKeyCustodyMarkerPath(dataDirectory);
  if (!fs.existsSync(markerPath)) return null;
  const metadata = fs.lstatSync(markerPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('backup encryption key custody marker is unsafe');
  }
  let parsed: Partial<BackupKeyCustodyMarker>;
  try {
    parsed = JSON.parse(
      fs.readFileSync(markerPath, 'utf8'),
    ) as Partial<BackupKeyCustodyMarker>;
  } catch {
    throw new Error('backup encryption key custody marker is invalid');
  }
  if (parsed.format !== 1 || !/^[0-9a-f]{64}$/.test(parsed.keyId ?? '')) {
    throw new Error('backup encryption key custody marker is invalid');
  }
  return parsed as BackupKeyCustodyMarker;
}

function writeBackupKeyCustodyMarker(
  dataDirectory: string,
  keyId: string,
  adoptedAt: string,
): void {
  const markerPath = backupKeyCustodyMarkerPath(dataDirectory);
  const temporary = `${markerPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ format: 1, keyId, adoptedAt }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  fs.renameSync(temporary, markerPath);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function ensureBackupEncryptionKeyRecovery(
  options: DataProtectionServiceOptions,
  key: Buffer,
  backupDirectory: string,
  replicaDirectory: string | null,
): boolean {
  const configured = options.encryptionKeyRecoveryPath?.trim();
  if (!configured) return false;
  const recoveryPath = path.resolve(configured);
  const recoveryDirectory = path.dirname(recoveryPath);
  if (!fs.existsSync(recoveryDirectory)) {
    throw new Error('backup encryption recovery key directory is unavailable');
  }
  const recoveryDirectoryMetadata = fs.lstatSync(recoveryDirectory);
  if (
    recoveryDirectoryMetadata.isSymbolicLink() ||
    !recoveryDirectoryMetadata.isDirectory()
  ) {
    throw new Error('backup encryption recovery key directory is unsafe');
  }
  const resolvedRecoveryPath = path.join(
    fs.realpathSync(recoveryDirectory),
    path.basename(recoveryPath),
  );
  const protectedRoots = [
    options.dataDirectory,
    backupDirectory,
    replicaDirectory,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .map((root) =>
      fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root),
    );
  if (protectedRoots.some((root) => pathIsWithin(root, resolvedRecoveryPath))) {
    throw new Error(
      'backup encryption recovery key must be outside data and backup directories',
    );
  }
  if (fs.existsSync(resolvedRecoveryPath)) {
    const metadata = fs.lstatSync(resolvedRecoveryPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('backup encryption recovery key path is unsafe');
    }
    const recoveryKey = parseDataProtectionEncryptionKey(
      fs.readFileSync(resolvedRecoveryPath, 'utf8'),
    );
    if (!recoveryKey.equals(key)) {
      throw new Error(
        'backup encryption recovery key does not match active key',
      );
    }
    return true;
  }
  fs.writeFileSync(resolvedRecoveryPath, `${key.toString('base64')}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return true;
}

async function ensureBackupKeyContinuity(input: {
  dataDirectory: string;
  key: Buffer;
  hasHistoricalEvidence: boolean;
  latestHistoricalArchive: string | null;
  now: Date;
}): Promise<string> {
  const keyId = backupEncryptionKeyId(input.key);
  const marker = readBackupKeyCustodyMarker(input.dataDirectory);
  if (marker) {
    if (marker.keyId !== keyId) {
      throw new Error(
        'backup encryption key changed without an authorized rotation',
      );
    }
    return keyId;
  }
  if (input.hasHistoricalEvidence) {
    if (!input.latestHistoricalArchive) {
      throw new Error(
        'backup key custody marker is missing and no historical archive is available',
      );
    }
    try {
      await verifyEncryptedBackupArchiveKey({
        archivePath: input.latestHistoricalArchive,
        key: input.key,
      });
    } catch {
      throw new Error(
        'backup encryption key cannot decrypt historical backups',
      );
    }
  }
  writeBackupKeyCustodyMarker(
    input.dataDirectory,
    keyId,
    input.now.toISOString(),
  );
  return keyId;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 1 ? Math.floor(value!) : fallback;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error(`cannot safely verify enterprise process ${pid}`);
  }
}

/** Provides verifiable online backups without blocking normal database writes. */
export function createDataProtectionService(
  options: DataProtectionServiceOptions,
): DataProtectionService {
  const now = options.now ?? (() => new Date());
  const backupDirectory = safeDirectoryPath(
    options.backupDirectory ?? path.join(options.dataDirectory, 'backups'),
    'backup directory',
  );
  const replicaDirectory = options.replicaDirectory
    ? safeDirectoryPath(options.replicaDirectory, 'backup replica directory')
    : null;
  const intervalHours = positiveInteger(options.intervalHours, 24);
  const retentionDays = positiveInteger(options.retentionDays, 30);
  const minimumRetained = positiveInteger(options.minimumRetained, 3);
  const orphanGraceMs = options.orphanGraceMs ?? 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(orphanGraceMs) || orphanGraceMs < 60_000) {
    throw new Error('local attachment orphan grace period is invalid');
  }
  const minimumFreeBytes = Math.max(
    64 * 1024 * 1024,
    positiveInteger(options.minimumFreeBytes, 2 * 1024 ** 3),
  );
  const statusPath = path.join(backupDirectory, 'data-protection-status.json');
  const runtimeLockPath = path.join(
    options.dataDirectory,
    'enterprise-runtime.json',
  );
  const runtimeLockToken = randomBytes(16).toString('hex');
  const persisted = readPersistedStatus(statusPath);
  const initialAvailable = availableBytes(backupDirectory);
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let status: DataProtectionStatus = {
    enabled: true,
    running: false,
    backupDirectory,
    replicaDirectory,
    intervalHours,
    retentionDays,
    minimumRetained,
    backupCount: listBackupFiles(backupDirectory).length,
    latestBackupAt: persisted.latestBackupAt ?? null,
    latestBackupPath: persisted.latestBackupPath ?? null,
    latestBackupBytes: persisted.latestBackupBytes ?? null,
    latestBackupSha256: persisted.latestBackupSha256 ?? null,
    latestSchemaVersion: persisted.latestSchemaVersion ?? null,
    lastAttemptAt: persisted.lastAttemptAt ?? null,
    lastSuccessAt: persisted.lastSuccessAt ?? null,
    lastError: persisted.lastError ?? null,
    lastReplicaAt: persisted.lastReplicaAt ?? null,
    lastReplicaError: persisted.lastReplicaError ?? null,
    lastOrphanSweepAt: persisted.lastOrphanSweepAt ?? null,
    orphanObjectsRemoved: persisted.orphanObjectsRemoved ?? 0,
    availableBytes: initialAvailable,
    minimumFreeBytes,
    capacityWarning:
      initialAvailable !== null && initialAvailable < minimumFreeBytes,
  };

  const ensureRuntimeDirectories = () => {
    ensureSafeDirectory(options.dataDirectory, 'enterprise data directory');
    ensureSafeDirectory(backupDirectory, 'backup directory');
    if (replicaDirectory) {
      ensureSafeDirectory(replicaDirectory, 'backup replica directory');
    }
  };

  const persistStatus = () => {
    const temporary = `${statusPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, statusPath);
  };

  const refreshCapacity = () => {
    const free = availableBytes(backupDirectory);
    status = {
      ...status,
      availableBytes: free,
      capacityWarning: free !== null && free < minimumFreeBytes,
    };
  };

  const prune = async (directory: string) => {
    const cutoff = now().getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const backups = listBackupFiles(directory);
    for (const [index, item] of backups.entries()) {
      if (index < minimumRetained || item.createdAt >= cutoff) continue;
      await rm(item.path, { force: true });
      await rm(`${item.path}.json`, { force: true });
    }
  };

  const writeMetadata = async (
    archivePath: string,
    metadata: Record<string, unknown>,
  ) => {
    const target = `${archivePath}.json`;
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, target);
  };

  const replicate = async (
    archivePath: string,
    recoveryMaterialConfigured: boolean,
  ) => {
    if (!replicaDirectory) return;
    if (!recoveryMaterialConfigured) {
      throw new Error('backup replica recovery key custody is not configured');
    }
    const target = path.join(replicaDirectory, path.basename(archivePath));
    const temporary = `${target}.${process.pid}.tmp`;
    await cp(archivePath, temporary, { force: false, errorOnExist: true });
    if (sha256File(temporary) !== sha256File(archivePath)) {
      await rm(temporary, { force: true });
      throw new Error('backup replica hash verification failed');
    }
    await rename(temporary, target);
    await cp(`${archivePath}.json`, `${target}.json`, {
      force: false,
      errorOnExist: true,
    });
    await prune(replicaDirectory);
  };

  function sweepOrphanAttachments(): number {
    ensureRuntimeDirectories();
    const database = options.getDatabase();
    const referenced = new Set(
      (
        database
          .prepare(
            `SELECT storage_key FROM direct_message_attachments
           WHERE storage_backend = 'encrypted-filesystem' AND storage_key IS NOT NULL`,
          )
          .all() as Array<{ storage_key: string }>
      ).map((row) => row.storage_key),
    );
    const referenceCheck = database.prepare(
      `SELECT 1 AS referenced FROM direct_message_attachments
       WHERE storage_backend = 'encrypted-filesystem' AND storage_key = ?
       LIMIT 1`,
    );
    const cutoff = now().getTime() - orphanGraceMs;
    const isProtected = (
      metadata: ReturnType<EncryptedObjectStore['inspect']>,
    ): boolean =>
      metadata === null ||
      !Number.isFinite(metadata.lastModifiedAtMs) ||
      metadata.lastModifiedAtMs >= cutoff ||
      (metadata.pendingSinceMs !== null &&
        (!Number.isFinite(metadata.pendingSinceMs) ||
          metadata.pendingSinceMs >= cutoff));
    let removed = 0;
    for (const key of options.attachmentObjectStore.listKeys()) {
      if (referenced.has(key)) continue;
      if (isProtected(options.attachmentObjectStore.inspect(key))) continue;
      // Recheck the authoritative row immediately before deletion. A writer
      // creates its pending marker before publishing the object and removes it
      // only after COMMIT, closing the object-write/metadata-commit race.
      if (referenceCheck.get(key) as { referenced: number } | undefined) {
        continue;
      }
      if (isProtected(options.attachmentObjectStore.inspect(key))) continue;
      options.attachmentObjectStore.delete(key);
      removed += 1;
    }
    status = {
      ...status,
      lastOrphanSweepAt: now().toISOString(),
      orphanObjectsRemoved: removed,
    };
    persistStatus();
    return removed;
  }

  async function runBackup(
    reason: 'scheduled' | 'manual' | 'startup' = 'manual',
  ): Promise<DataProtectionStatus> {
    if (running) return { ...status, running: true };
    ensureRuntimeDirectories();
    running = true;
    status = {
      ...status,
      running: true,
      lastAttemptAt: now().toISOString(),
      lastError: null,
    };
    persistStatus();
    const workDirectory = path.join(
      backupDirectory,
      `.backup-${process.pid}-${randomBytes(6).toString('hex')}`,
    );
    try {
      const historicalBackups = [
        ...listBackupFiles(backupDirectory),
        ...(replicaDirectory ? listBackupFiles(replicaDirectory) : []),
      ].sort((left, right) => right.createdAt - left.createdAt);
      const hasHistoricalEvidence =
        historicalBackups.length > 0 ||
        Boolean(status.lastSuccessAt) ||
        Boolean(status.latestBackupSha256) ||
        fs.existsSync(backupKeyCustodyMarkerPath(options.dataDirectory));
      const backupEncryptionKey = loadOrCreateDataProtectionEncryptionKey(
        options,
        hasHistoricalEvidence,
      );
      const backupKeyId = await ensureBackupKeyContinuity({
        dataDirectory: options.dataDirectory,
        key: backupEncryptionKey,
        hasHistoricalEvidence,
        latestHistoricalArchive: historicalBackups[0]?.path ?? null,
        now: now(),
      });
      const recoveryMaterialConfigured = ensureBackupEncryptionKeyRecovery(
        options,
        backupEncryptionKey,
        backupDirectory,
        replicaDirectory,
      );
      refreshCapacity();
      const estimatedBytes =
        (fs.existsSync(options.databasePath)
          ? fs.statSync(options.databasePath).size
          : 0) + options.attachmentObjectStore.sizeBytes();
      if (
        status.availableBytes !== null &&
        status.availableBytes <
          Math.max(minimumFreeBytes, estimatedBytes * 2 + 64 * 1024 * 1024)
      ) {
        throw new Error('insufficient disk space for verified backup');
      }
      await mkdir(workDirectory, { recursive: false, mode: 0o700 });
      const snapshotPath = path.join(workDirectory, 'data.db');
      if (options.createDatabaseSnapshot) {
        await options.createDatabaseSnapshot(snapshotPath);
      } else {
        const source = new DatabaseSync(options.databasePath);
        try {
          // `node:sqlite` does not expose its module-level backup helper on all
          // supported Node 22 builds. VACUUM INTO is SQLite's native online
          // snapshot primitive and keeps this recovery path portable.
          const snapshotLiteral = `'${snapshotPath.replace(/'/g, "''")}'`;
          source.exec(`VACUUM INTO ${snapshotLiteral}`);
        } finally {
          source.close();
        }
      }
      const schemaVersion = validateSnapshot(
        snapshotPath,
        options.schemaVersion,
        options.openDatabaseSnapshot,
      );
      const createdAt = now();
      const timestamp = createdAt
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
      const archiveName = `otto-enterprise-${timestamp}-${randomBytes(4).toString('hex')}.otto-backup`;
      const archivePath = path.join(backupDirectory, archiveName);
      const manifestPath = path.join(workDirectory, 'manifest.json');
      const objectKeys = options.attachmentObjectStore.listKeys();
      const manifest = {
        format: 1,
        createdAt: createdAt.toISOString(),
        reason,
        schemaVersion,
        appVersion: options.appVersion?.() ?? 'unknown',
        buildCommit: options.buildCommit?.() ?? 'unknown',
        attachmentObjects: objectKeys.length,
        backupKeyId,
        backupKeyRecoveryConfigured: recoveryMaterialConfigured,
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      const files = [
        { sourcePath: snapshotPath, archivePath: 'database/data.db' },
        { sourcePath: manifestPath, archivePath: 'manifest.json' },
      ];
      if (
        options.databaseKeyRecoveryPath &&
        !fs.existsSync(options.databaseKeyRecoveryPath)
      ) {
        throw new Error('database encryption recovery material is missing');
      }
      for (const [sourcePath, archivePath] of [
        ...(options.databaseKeyRecoveryPath
          ? [
              [
                options.databaseKeyRecoveryPath,
                'keys/database.keyring',
              ] as const,
            ]
          : []),
        [options.accountSyncKeyPath, 'keys/account-sync.key'],
        [options.attachmentKeyPath, 'keys/attachment-storage.key'],
        [options.fieldEncryptionKeyPath, 'keys/field-encryption.key'],
      ] as const) {
        if (typeof sourcePath === 'string' && fs.existsSync(sourcePath)) {
          files.push({ sourcePath, archivePath });
        }
      }
      const privacyLedgerPath = options.privacyDeletionLedgerPath;
      const privacyLedgerKeyPath = options.privacyDeletionLedgerKeyPath;
      if (privacyLedgerPath || privacyLedgerKeyPath) {
        if (!privacyLedgerPath || !privacyLedgerKeyPath) {
          throw new Error(
            'privacy deletion ledger paths must be configured together',
          );
        }
        if (fs.existsSync(privacyLedgerPath)) {
          if (!fs.existsSync(privacyLedgerKeyPath)) {
            throw new Error('privacy deletion ledger key is missing');
          }
          files.push(
            {
              sourcePath: privacyLedgerPath,
              archivePath: 'privacy/privacy-deletions.jsonl',
            },
            {
              sourcePath: privacyLedgerKeyPath,
              archivePath: 'privacy/privacy-deletions.key',
            },
          );
        }
      }
      for (const key of objectKeys) {
        files.push({
          sourcePath: path.join(options.attachmentDirectory, ...key.split('/')),
          archivePath: `attachments/${key}`,
        });
      }
      const result = await createEncryptedBackupArchive({
        files,
        targetPath: archivePath,
        key: backupEncryptionKey,
      });
      const metadata = { ...manifest, ...result, archiveName };
      await writeMetadata(archivePath, metadata);
      let lastReplicaAt = status.lastReplicaAt;
      let lastReplicaError: string | null = null;
      try {
        await replicate(archivePath, recoveryMaterialConfigured);
        if (replicaDirectory) lastReplicaAt = now().toISOString();
      } catch (error) {
        lastReplicaError =
          error instanceof Error ? error.message : 'backup replication failed';
      }
      await prune(backupDirectory);
      sweepOrphanAttachments();
      refreshCapacity();
      status = {
        ...status,
        backupCount: listBackupFiles(backupDirectory).length,
        latestBackupAt: createdAt.toISOString(),
        latestBackupPath: archivePath,
        latestBackupBytes: result.bytes,
        latestBackupSha256: result.sha256,
        latestSchemaVersion: schemaVersion,
        lastSuccessAt: now().toISOString(),
        lastError: null,
        lastReplicaAt,
        lastReplicaError,
      };
    } catch (error) {
      status = {
        ...status,
        lastError: error instanceof Error ? error.message : 'backup failed',
      };
    } finally {
      running = false;
      status = { ...status, running: false };
      await rm(workDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      persistStatus();
    }
    return { ...status };
  }

  function start(): () => void {
    stopped = false;
    ensureRuntimeDirectories();
    if (fs.existsSync(runtimeLockPath)) {
      try {
        const existing = JSON.parse(
          fs.readFileSync(runtimeLockPath, 'utf8'),
        ) as {
          pid?: number;
        };
        if (
          Number.isInteger(existing.pid) &&
          existing.pid! > 0 &&
          processIsAlive(existing.pid!)
        ) {
          throw new Error(
            `enterprise data directory is already used by process ${existing.pid}`,
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith(
            'enterprise data directory is already used',
          ) ||
            error.message.startsWith('cannot safely verify enterprise process'))
        ) {
          throw error;
        }
        fs.rmSync(runtimeLockPath, { force: true });
      }
    }
    fs.writeFileSync(
      runtimeLockPath,
      `${JSON.stringify({ pid: process.pid, token: runtimeLockToken })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const intervalMs = intervalHours * 60 * 60 * 1000;
    const latest = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : 0;
    const firstDelay = Math.max(
      30_000,
      intervalMs - Math.max(0, Date.now() - latest),
    );
    const schedule = (delay: number) => {
      timer = setTimeout(async () => {
        if (stopped) return;
        await runBackup(status.lastSuccessAt ? 'scheduled' : 'startup');
        if (!stopped) schedule(intervalMs);
      }, delay);
      timer.unref?.();
    };
    schedule(firstDelay);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        const current = JSON.parse(
          fs.readFileSync(runtimeLockPath, 'utf8'),
        ) as {
          token?: string;
        };
        if (current.token === runtimeLockToken)
          fs.rmSync(runtimeLockPath, { force: true });
      } catch {
        // A missing or replaced lock does not prevent shutdown.
      }
    };
  }

  return {
    getStatus() {
      refreshCapacity();
      return { ...status, running };
    },
    runBackup,
    sweepOrphanAttachments,
    start,
  };
}
