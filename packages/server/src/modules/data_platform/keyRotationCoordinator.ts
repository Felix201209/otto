/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import type { EnvelopedSqlCipherKeyProvider } from './envelopedSqlCipherKeyProvider.js';

export type RotationKind = 'kek' | 'dek';
export type RotationPhase =
  | 'prepare'
  | 'rewrap'
  | 'rekey'
  | 'verify'
  | 'activate'
  | 'retire'
  | 'rollback'
  | 'recovery';

export interface KeyRotationAuditEvent {
  eventId: string;
  occurredAt: string;
  actorId: string;
  operation: RotationKind | 'recovery';
  phase: RotationPhase;
  result: 'started' | 'succeeded' | 'failed';
  fromVersion?: string;
  toVersion?: string;
  requestId?: string;
  errorType?: string;
}

export interface KeyRotationTarget {
  getStatus(): { dekVersion: number; kekVersion: string };
  prepareDekRotation(): Promise<{ nextDekVersion: number }>;
  cancelPreparedDek(nextDekVersion: number): Promise<void>;
  rotatePreparedDek(): Promise<{
    dekVersion: number;
    recoveryReference: string;
  }>;
  verify(): Promise<void>;
  rollback(recoveryReference: string): Promise<void>;
  prepareKekRotation(): Promise<{
    rotationId: string;
    previousKekVersions: string[];
    activeKekVersion: string;
    dekVersions: number[];
  }>;
  activateKekRotation(rotationId: string): Promise<void>;
  abortKekRotation(rotationId: string): Promise<void>;
}

export interface BackupKeyRotationTarget {
  prepare(
    kind: RotationKind,
    versions: { fromVersion: string; toVersion?: string },
  ): Promise<void>;
  activate(
    kind: RotationKind,
    versions: { fromVersion: string; toVersion: string },
  ): Promise<void>;
  rollback(
    kind: RotationKind,
    versions: { fromVersion: string; toVersion?: string },
  ): Promise<void>;
  retire(
    kind: RotationKind,
    versions: { fromVersion: string; toVersion: string },
  ): Promise<void>;
}

export interface KeyRotationLease {
  acquire(key: string, owner: string, ttlMs: number): Promise<boolean>;
  release(key: string, owner: string): Promise<boolean>;
}

export interface KeyRotationCoordinator {
  rotateKek(input: { actorId: string }): Promise<{
    previousKekVersions: string[];
    activeKekVersion: string;
    dekVersions: number[];
  }>;
  rotateDek(input: {
    actorId: string;
    maintenanceWindowConfirmed: boolean;
  }): Promise<{ dekVersion: number; recoveryReference: string }>;
  recover<T>(input: {
    actorId: string;
    approverIds: string[];
    requestId: string;
    trustDomain: 'server-database' | 'server-backup' | 'client-e2ee';
    recover(): Promise<T>;
  }): Promise<T>;
}

export interface AutomaticKeyRotationTask {
  runOnce(): Promise<void>;
  start(pollIntervalMs?: number): () => void;
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\0\r\n]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function errorType(error: unknown): string {
  if (error instanceof Error && error.name.trim())
    return error.name.slice(0, 80);
  return 'UnknownError';
}

export function createKeyRotationCoordinator(input: {
  target: KeyRotationTarget;
  backups: BackupKeyRotationTarget;
  lease: KeyRotationLease;
  audit: { append(event: KeyRotationAuditEvent): Promise<void> };
  leaseTtlMs: number;
  now?: () => Date;
}): KeyRotationCoordinator {
  if (
    !Number.isSafeInteger(input.leaseTtlMs) ||
    input.leaseTtlMs < 30_000 ||
    input.leaseTtlMs > 3_600_000
  ) {
    throw new Error('key rotation lease TTL is invalid');
  }
  const now = input.now ?? (() => new Date());

  async function audit(
    actorId: string,
    operation: KeyRotationAuditEvent['operation'],
    phase: RotationPhase,
    result: KeyRotationAuditEvent['result'],
    detail: Pick<
      KeyRotationAuditEvent,
      'fromVersion' | 'toVersion' | 'requestId' | 'errorType'
    > = {},
  ): Promise<void> {
    await input.audit.append({
      eventId: randomUUID(),
      occurredAt: now().toISOString(),
      actorId,
      operation,
      phase,
      result,
      ...detail,
    });
  }

  async function withLease<T>(
    actorId: string,
    operation: RotationKind,
    run: () => Promise<T>,
  ): Promise<T> {
    const owner = `${actorId}:${randomUUID()}`;
    const key = `security:key-rotation:${operation}`;
    if (!(await input.lease.acquire(key, owner, input.leaseTtlMs))) {
      throw new Error(`${operation.toUpperCase()} rotation is already running`);
    }
    let result!: T;
    let operationError: unknown;
    try {
      result = await run();
    } catch (error) {
      operationError = error;
    }
    let releaseError: unknown;
    try {
      if (!(await input.lease.release(key, owner))) {
        releaseError = new Error('key rotation lease ownership was lost');
      }
    } catch (error) {
      releaseError = error;
    }
    if (operationError && releaseError) {
      throw new AggregateError(
        [operationError, releaseError],
        'key rotation failed and its distributed lease could not be released',
      );
    }
    if (operationError) throw operationError;
    if (releaseError) throw releaseError;
    return result;
  }

  return {
    async rotateKek(request) {
      const actorId = requiredIdentifier(request.actorId, 'rotation actor');
      return withLease(actorId, 'kek', async () => {
        const status = input.target.getStatus();
        const fromVersion = status.kekVersion;
        await audit(actorId, 'kek', 'prepare', 'started', { fromVersion });
        let rotationId: string | undefined;
        let activated = false;
        try {
          const rotated = await input.target.prepareKekRotation();
          rotationId = rotated.rotationId;
          const versions = {
            fromVersion,
            toVersion: rotated.activeKekVersion,
          };
          await audit(actorId, 'kek', 'rewrap', 'succeeded', versions);
          await input.backups.prepare('kek', versions);
          await input.target.verify();
          await audit(actorId, 'kek', 'verify', 'succeeded', versions);
          await input.backups.activate('kek', versions);
          await input.target.activateKekRotation(rotationId);
          activated = true;
          await audit(actorId, 'kek', 'activate', 'succeeded', versions);
          await input.backups.retire('kek', versions);
          await audit(actorId, 'kek', 'retire', 'succeeded', versions);
          return rotated;
        } catch (error) {
          if (!activated) {
            await input.backups.rollback('kek', { fromVersion });
            if (rotationId) await input.target.abortKekRotation(rotationId);
          }
          await audit(actorId, 'kek', 'rollback', 'succeeded', {
            fromVersion,
            errorType: errorType(error),
          });
          throw error;
        }
      });
    },
    async rotateDek(request) {
      if (!request.maintenanceWindowConfirmed) {
        throw new Error('DEK rotation requires a confirmed maintenance window');
      }
      const actorId = requiredIdentifier(request.actorId, 'rotation actor');
      return withLease(actorId, 'dek', async () => {
        const status = input.target.getStatus();
        const fromVersion = String(status.dekVersion);
        const prepared = await input.target.prepareDekRotation();
        const toVersion = String(prepared.nextDekVersion);
        const versions = { fromVersion, toVersion };
        let recoveryReference: string | undefined;
        try {
          await audit(actorId, 'dek', 'prepare', 'succeeded', versions);
          await input.backups.prepare('dek', versions);
          const rotated = await input.target.rotatePreparedDek();
          recoveryReference = rotated.recoveryReference;
          await audit(actorId, 'dek', 'rekey', 'succeeded', versions);
          await input.target.verify();
          await audit(actorId, 'dek', 'verify', 'succeeded', versions);
          await input.backups.activate('dek', versions);
          await audit(actorId, 'dek', 'activate', 'succeeded', versions);
          await input.backups.retire('dek', versions);
          await audit(actorId, 'dek', 'retire', 'succeeded', versions);
          return rotated;
        } catch (error) {
          await input.backups.rollback('dek', versions);
          if (recoveryReference) {
            await input.target.rollback(recoveryReference);
          } else {
            await input.target.cancelPreparedDek(prepared.nextDekVersion);
          }
          await audit(actorId, 'dek', 'rollback', 'succeeded', {
            ...versions,
            errorType: errorType(error),
          });
          throw error;
        }
      });
    },
    async recover(request) {
      const actorId = requiredIdentifier(request.actorId, 'recovery actor');
      const requestId = requiredIdentifier(
        request.requestId,
        'recovery request',
      );
      const approvers = new Set(
        request.approverIds.map((value) =>
          requiredIdentifier(value, 'recovery approver'),
        ),
      );
      if (approvers.size < 2) {
        throw new Error('recovery requires two distinct approvers');
      }
      if (request.trustDomain === 'client-e2ee') {
        throw new Error(
          'client E2EE private keys and recovery material cannot be recovered by the server KMS',
        );
      }
      await audit(actorId, 'recovery', 'recovery', 'started', { requestId });
      try {
        const result = await request.recover();
        await audit(actorId, 'recovery', 'recovery', 'succeeded', {
          requestId,
        });
        return result;
      } catch (error) {
        await audit(actorId, 'recovery', 'recovery', 'failed', {
          requestId,
          errorType: errorType(error),
        });
        throw error;
      }
    },
  };
}

export function createEnterpriseSharedCacheRotationLease(cache: {
  acquireLease(key: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(key: string, owner: string): Promise<boolean>;
}): KeyRotationLease {
  return {
    acquire: (key, owner, ttlMs) => cache.acquireLease(key, owner, ttlMs),
    release: (key, owner) => cache.releaseLease(key, owner),
  };
}

/**
 * Safe to start on every replica: persisted due-state avoids busy looping and
 * the coordinator's distributed lease elects the single rotation executor.
 */
export function createAutomaticKeyRotationTask(input: {
  coordinator: KeyRotationCoordinator;
  state: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  actorId: string;
  kekIntervalMs: number;
  dekIntervalMs: number;
  isDekMaintenanceWindow(): boolean | Promise<boolean>;
  now?: () => Date;
  onError?: (error: unknown) => void;
}): AutomaticKeyRotationTask {
  const actorId = requiredIdentifier(input.actorId, 'automatic rotation actor');
  for (const [label, value] of [
    ['KEK', input.kekIntervalMs],
    ['DEK', input.dekIntervalMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 60_000) {
      throw new Error(`${label} rotation interval is invalid`);
    }
  }
  const now = input.now ?? (() => new Date());

  async function isDue(key: string, intervalMs: number, time: Date) {
    const stored = await input.state.get(key);
    if (stored === null) return true;
    const timestamp = Date.parse(stored);
    if (!Number.isFinite(timestamp)) {
      throw new Error(`automatic rotation state ${key} is invalid`);
    }
    return time.getTime() - timestamp >= intervalMs;
  }

  async function runOnce(): Promise<void> {
    const time = now();
    const completedAt = time.toISOString();
    if (
      await isDue('key-rotation:last-kek-success', input.kekIntervalMs, time)
    ) {
      await input.coordinator.rotateKek({ actorId });
      await input.state.set('key-rotation:last-kek-success', completedAt);
    }
    if (
      (await input.isDekMaintenanceWindow()) &&
      (await isDue('key-rotation:last-dek-success', input.dekIntervalMs, time))
    ) {
      await input.coordinator.rotateDek({
        actorId,
        maintenanceWindowConfirmed: true,
      });
      await input.state.set('key-rotation:last-dek-success', completedAt);
    }
  }

  return {
    runOnce,
    start(pollIntervalMs = 60_000) {
      if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10_000) {
        throw new Error('automatic rotation poll interval is invalid');
      }
      const timer = setInterval(() => {
        void runOnce().catch((error) => input.onError?.(error));
      }, pollIntervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/** Binds the async envelope stages to the existing verified SQLCipher rekey. */
export function createEnvelopedSqlCipherRotationTarget(input: {
  keyProvider: EnvelopedSqlCipherKeyProvider;
  rotateDatabaseKey(): { keyVersion: number; recoveryPath: string };
  verifyDatabase(): void | Promise<void>;
  rollbackDatabase(recoveryPath: string): void | Promise<void>;
}): KeyRotationTarget {
  return {
    getStatus() {
      const status = input.keyProvider.getEnvelopeStatus();
      return {
        dekVersion: status.activeDekVersion,
        kekVersion: status.kekVersion,
      };
    },
    async prepareDekRotation() {
      const rotation = await input.keyProvider.prepareDekRotation();
      return { nextDekVersion: rotation.next.version };
    },
    async cancelPreparedDek(nextDekVersion) {
      const rotation = input.keyProvider.beginRotation();
      if (rotation.next.version !== nextDekVersion) {
        throw new Error('prepared DEK version changed before cancellation');
      }
      input.keyProvider.cancelPreparedDekRotation(rotation);
    },
    async rotatePreparedDek() {
      const result = input.rotateDatabaseKey();
      return {
        dekVersion: result.keyVersion,
        recoveryReference: result.recoveryPath,
      };
    },
    async verify() {
      await input.verifyDatabase();
    },
    async rollback(recoveryReference) {
      await input.rollbackDatabase(recoveryReference);
    },
    prepareKekRotation: () => input.keyProvider.prepareKekRotation(),
    async activateKekRotation(rotationId) {
      input.keyProvider.activateKekRotation(rotationId);
    },
    async abortKekRotation(rotationId) {
      input.keyProvider.abortKekRotation(rotationId);
    },
  };
}
