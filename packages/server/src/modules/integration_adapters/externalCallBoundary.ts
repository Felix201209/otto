/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * The single contract for observable, interceptable server-side provider calls.
 * Credentials and request bodies deliberately do not belong in this contract.
 */

export type ExternalCallKind =
  | 'model'
  | 'sms'
  | 's3'
  | 'kms'
  | 'control'
  | 'email'
  | 'http';

export interface ExternalCallMetadata {
  kind: ExternalCallKind;
  /** Stable product feature or task name that caused the call. */
  origin: string;
  provider: string;
  tokenUsage?: { input: number; output: number };
  estimatedCost?: { amount: number; currency: string };
}

export interface ExternalWriteMetadata extends ExternalCallMetadata {
  idempotencyKey: string;
}

export type ExternalCallOutcome =
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'committed';

export interface ExternalCallAuditEvent extends ExternalCallMetadata {
  idempotencyKey?: string;
  retryCount: number;
  outcome: ExternalCallOutcome;
  occurredAtMs: number;
  error?: string;
}

export interface ExternalWriteRecord {
  idempotencyKey: string;
  operationFingerprint: string;
  metadata: ExternalCallMetadata;
  status: 'prepared' | 'failed' | 'committed';
  attempts: number;
  lastError?: string;
  updatedAtMs: number;
}

export interface ExternalWriteJournal {
  get(idempotencyKey: string): ExternalWriteRecord | undefined;
  put(record: ExternalWriteRecord): void;
}

export class InMemoryExternalWriteJournal implements ExternalWriteJournal {
  private readonly records = new Map<string, ExternalWriteRecord>();

  get(idempotencyKey: string): ExternalWriteRecord | undefined {
    const record = this.records.get(idempotencyKey);
    return record ? { ...record, metadata: { ...record.metadata } } : undefined;
  }

  put(record: ExternalWriteRecord): void {
    this.records.set(record.idempotencyKey, {
      ...record,
      metadata: { ...record.metadata },
    });
  }
}

export class ExternalCallBlockedError extends Error {
  constructor() {
    super('external call was blocked by policy');
    this.name = 'ExternalCallBlockedError';
  }
}

export interface ExternalCallBoundaryOptions {
  allow?: (metadata: Readonly<ExternalCallMetadata>) => boolean | Promise<boolean>;
  audit: (event: Readonly<ExternalCallAuditEvent>) => void | Promise<void>;
  journal?: ExternalWriteJournal;
  now?: () => number;
}

export interface ExternalCallAttempt {
  idempotencyKey: string;
  retryCount: number;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Audit only a bounded summary; provider request headers and bodies never enter here.
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 500);
}

function validateMetadata(metadata: ExternalCallMetadata): void {
  if (!metadata.origin.trim()) throw new Error('external call origin is required');
  if (!metadata.provider.trim()) throw new Error('external call provider is required');
}

function fingerprint(metadata: ExternalCallMetadata): string {
  return `${metadata.kind}\0${metadata.origin}\0${metadata.provider}`;
}

export class ExternalCallBoundary {
  private readonly now: () => number;

  constructor(private readonly options: ExternalCallBoundaryOptions) {
    this.now = options.now ?? Date.now;
  }

  private async emit(
    metadata: ExternalCallMetadata,
    outcome: ExternalCallOutcome,
    retryCount: number,
    idempotencyKey?: string,
    error?: unknown,
  ): Promise<void> {
    await this.options.audit({
      ...metadata,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      retryCount,
      outcome,
      occurredAtMs: this.now(),
      ...(error === undefined ? {} : { error: safeError(error) }),
    });
  }

  private async assertAllowed(
    metadata: ExternalCallMetadata,
    retryCount: number,
    idempotencyKey?: string,
  ): Promise<void> {
    validateMetadata(metadata);
    if ((await this.options.allow?.(metadata)) === false) {
      await this.emit(metadata, 'blocked', retryCount, idempotencyKey);
      throw new ExternalCallBlockedError();
    }
  }

  async read<T>(metadata: ExternalCallMetadata, call: () => Promise<T>): Promise<T> {
    await this.assertAllowed(metadata, 0);
    try {
      const result = await call();
      await this.emit(metadata, 'succeeded', 0);
      return result;
    } catch (error) {
      await this.emit(metadata, 'failed', 0, undefined, error);
      throw error;
    }
  }

  async write<T>(
    metadata: ExternalWriteMetadata,
    call: (attempt: ExternalCallAttempt) => Promise<T>,
  ): Promise<T | undefined> {
    if (!IDEMPOTENCY_KEY.test(metadata.idempotencyKey)) {
      throw new Error('a valid external write idempotency key is required');
    }
    const { idempotencyKey, ...callMetadata } = metadata;
    validateMetadata(callMetadata);
    const operationFingerprint = fingerprint(callMetadata);
    const journal = this.requireJournal();
    const existing = journal.get(idempotencyKey);
    if (
      existing?.operationFingerprint !== undefined &&
      existing.operationFingerprint !== operationFingerprint
    ) {
      throw new Error('idempotency key is bound to a different external operation');
    }
    if (existing?.status === 'committed') return undefined;

    const record: ExternalWriteRecord = existing ?? {
      idempotencyKey,
      operationFingerprint,
      metadata: callMetadata,
      status: 'prepared',
      attempts: 0,
      updatedAtMs: this.now(),
    };
    journal.put(record);
    return this.executeWrite(record, call);
  }

  async recover<T>(
    idempotencyKey: string,
    call: (attempt: ExternalCallAttempt) => Promise<T>,
  ): Promise<T | undefined> {
    const record = this.requireJournal().get(idempotencyKey);
    if (!record) throw new Error('external write recovery record was not found');
    if (record.status === 'committed') return undefined;
    return this.executeWrite(record, call);
  }

  private async executeWrite<T>(
    record: ExternalWriteRecord,
    call: (attempt: ExternalCallAttempt) => Promise<T>,
  ): Promise<T> {
    const retryCount = record.attempts;
    await this.assertAllowed(record.metadata, retryCount, record.idempotencyKey);
    const attempted = {
      ...record,
      status: 'prepared' as const,
      attempts: record.attempts + 1,
      updatedAtMs: this.now(),
    };
    const journal = this.requireJournal();
    journal.put(attempted);
    try {
      const result = await call({
        idempotencyKey: record.idempotencyKey,
        retryCount,
      });
      const { lastError: _lastError, ...committed } = attempted;
      journal.put({
        ...committed,
        status: 'committed',
        updatedAtMs: this.now(),
      });
      await this.emit(
        record.metadata,
        'committed',
        retryCount,
        record.idempotencyKey,
      );
      return result;
    } catch (error) {
      journal.put({
        ...attempted,
        status: 'failed',
        lastError: safeError(error),
        updatedAtMs: this.now(),
      });
      await this.emit(
        record.metadata,
        'failed',
        retryCount,
        record.idempotencyKey,
        error,
      );
      throw error;
    }
  }

  private requireJournal(): ExternalWriteJournal {
    if (!this.options.journal) {
      throw new Error('external writes require a durable write journal');
    }
    return this.options.journal;
  }
}
