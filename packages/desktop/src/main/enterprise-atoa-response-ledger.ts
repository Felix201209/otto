/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { AtoaContextSource } from './federation-atoa-protocol.js';

const LEDGER_VERSION = 1 as const;
const LEDGER_SUFFIX = '.a2a-response';
const SHA256 = /^[a-f0-9]{64}$/u;
const DEFAULT_SUBMITTED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_ANSWER_LENGTH = 2_400;
const MAX_ERROR_LENGTH = 1_000;

export type EnterpriseAtoaResponseStatus =
  'generated' | 'submitting' | 'submitted';

export interface EnterpriseAtoaResponseKey {
  serverUrl: string;
  accountId: string;
  scope: string;
  contactId: string;
  requestMessageId: string;
}

export interface EnterpriseAtoaResponseRecord extends EnterpriseAtoaResponseKey {
  v: typeof LEDGER_VERSION;
  requestHash: string;
  answer: string;
  answerHash: string;
  grantedSources: AtoaContextSource[];
  status: EnterpriseAtoaResponseStatus;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt: string | null;
  submittedAt: string | null;
}

export interface EnterpriseAtoaResponseLedgerOptions {
  directory: string;
  protect(plaintext: string): string;
  unprotect(ciphertext: string): string;
  now?: () => Date;
  submittedRetentionMs?: number;
}

export interface StageEnterpriseAtoaResponseInput extends EnterpriseAtoaResponseKey {
  requestHash: string;
  answer: string;
  grantedSources: AtoaContextSource[];
}

export interface EnterpriseAtoaResponseLookup extends EnterpriseAtoaResponseKey {
  requestHash: string;
}

const ALLOWED_SOURCES = new Set<AtoaContextSource>([
  'current_chat',
  'enterprise_knowledge',
  'work_logs',
  'schedules',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashEnterpriseAtoaRequest(value: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('A2A request material is required');
  }
  return sha256(value);
}

function normalizedServerUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('A2A response ledger server URL is invalid');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('A2A response ledger server URL is invalid');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
  return parsed.toString().replace(/\/$/u, '');
}

function requiredText(value: string, name: string, maxLength = 300): string {
  if (typeof value !== 'string') {
    throw new Error(`A2A response ledger ${name} is invalid`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    [...normalized].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(`A2A response ledger ${name} is invalid`);
  }
  return normalized;
}

function normalizeKey(
  input: EnterpriseAtoaResponseKey,
): EnterpriseAtoaResponseKey {
  return {
    serverUrl: normalizedServerUrl(input.serverUrl),
    accountId: requiredText(input.accountId, 'account id'),
    scope: requiredText(input.scope, 'scope'),
    contactId: requiredText(input.contactId, 'contact id'),
    requestMessageId: requiredText(
      input.requestMessageId,
      'request message id',
    ),
  };
}

function normalizeSources(sources: AtoaContextSource[]): AtoaContextSource[] {
  if (!Array.isArray(sources)) {
    throw new Error('A2A response ledger granted sources are invalid');
  }
  const normalized = [...new Set(sources)];
  if (normalized.some((source) => !ALLOWED_SOURCES.has(source))) {
    throw new Error('A2A response ledger granted sources are invalid');
  }
  return normalized.sort();
}

function sameKey(
  left: EnterpriseAtoaResponseKey,
  right: EnterpriseAtoaResponseKey,
): boolean {
  return (
    left.serverUrl === right.serverUrl &&
    left.accountId === right.accountId &&
    left.scope === right.scope &&
    left.contactId === right.contactId &&
    left.requestMessageId === right.requestMessageId
  );
}

function keyDigest(key: EnterpriseAtoaResponseKey): string {
  return sha256(
    JSON.stringify([
      key.serverUrl,
      key.accountId,
      key.scope,
      key.contactId,
      key.requestMessageId,
    ]),
  );
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validateRecord(
  value: unknown,
  expectedKey?: EnterpriseAtoaResponseKey,
): EnterpriseAtoaResponseRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A2A response ledger record is invalid');
  }
  const raw = value as Record<string, unknown>;
  const key = normalizeKey({
    serverUrl: raw.serverUrl as string,
    accountId: raw.accountId as string,
    scope: raw.scope as string,
    contactId: raw.contactId as string,
    requestMessageId: raw.requestMessageId as string,
  });
  if (expectedKey && !sameKey(key, expectedKey)) {
    throw new Error('A2A response ledger key binding is invalid');
  }
  if (
    raw.v !== LEDGER_VERSION ||
    typeof raw.requestHash !== 'string' ||
    !SHA256.test(raw.requestHash) ||
    typeof raw.answer !== 'string' ||
    !raw.answer.trim() ||
    raw.answer.length > MAX_ANSWER_LENGTH ||
    typeof raw.answerHash !== 'string' ||
    !SHA256.test(raw.answerHash) ||
    sha256(raw.answer) !== raw.answerHash ||
    (raw.status !== 'generated' &&
      raw.status !== 'submitting' &&
      raw.status !== 'submitted') ||
    !Number.isInteger(raw.attempts) ||
    (raw.attempts as number) < 0 ||
    (raw.error !== null &&
      (typeof raw.error !== 'string' || raw.error.length > MAX_ERROR_LENGTH)) ||
    !isIsoDate(raw.createdAt) ||
    !isIsoDate(raw.updatedAt) ||
    (raw.lastAttemptAt !== null && !isIsoDate(raw.lastAttemptAt)) ||
    (raw.submittedAt !== null && !isIsoDate(raw.submittedAt))
  ) {
    throw new Error('A2A response ledger record is invalid');
  }
  if (
    (raw.status === 'submitted') !== (raw.submittedAt !== null) ||
    (raw.status === 'submitting' && raw.lastAttemptAt === null)
  ) {
    throw new Error('A2A response ledger state is invalid');
  }
  const grantedSources = normalizeSources(
    raw.grantedSources as AtoaContextSource[],
  );
  return {
    v: LEDGER_VERSION,
    ...key,
    requestHash: raw.requestHash,
    answer: raw.answer,
    answerHash: raw.answerHash,
    grantedSources,
    status: raw.status,
    attempts: raw.attempts as number,
    error: raw.error as string | null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lastAttemptAt: raw.lastAttemptAt as string | null,
    submittedAt: raw.submittedAt as string | null,
  };
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicWrite(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

export class EnterpriseAtoaResponseLedger {
  private readonly now: () => Date;
  private readonly submittedRetentionMs: number;

  constructor(private readonly options: EnterpriseAtoaResponseLedgerOptions) {
    if (!options.directory) {
      throw new Error('A2A response ledger directory is required');
    }
    this.now = options.now ?? (() => new Date());
    this.submittedRetentionMs =
      options.submittedRetentionMs ?? DEFAULT_SUBMITTED_RETENTION_MS;
    if (
      !Number.isSafeInteger(this.submittedRetentionMs) ||
      this.submittedRetentionMs < 60_000
    ) {
      throw new Error('A2A response ledger retention is invalid');
    }
  }

  load(
    input: EnterpriseAtoaResponseLookup,
  ): EnterpriseAtoaResponseRecord | null {
    const key = normalizeKey(input);
    const requestHash = this.requireRequestHash(input.requestHash);
    const filePath = this.filePath(key);
    try {
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('A2A response ledger path is not a regular file');
      }
      const protectedRecord = readFileSync(filePath, 'utf8');
      let plaintext: string;
      try {
        plaintext = this.options.unprotect(protectedRecord);
      } catch {
        throw new Error('A2A response ledger ciphertext authentication failed');
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(plaintext);
      } catch {
        throw new Error('A2A response ledger record is invalid');
      }
      const record = validateRecord(decoded, key);
      if (record.requestHash !== requestHash) {
        throw new Error('A2A response ledger request hash mismatch');
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  stageGenerated(
    input: StageEnterpriseAtoaResponseInput,
  ): EnterpriseAtoaResponseRecord {
    const key = normalizeKey(input);
    const requestHash = this.requireRequestHash(input.requestHash);
    const answer = input.answer.trim();
    if (!answer || answer.length > MAX_ANSWER_LENGTH) {
      throw new Error('A2A response ledger answer is invalid');
    }
    const grantedSources = normalizeSources(input.grantedSources);
    const existing = this.load({ ...key, requestHash });
    if (existing) {
      if (
        existing.answerHash !== sha256(answer) ||
        JSON.stringify(existing.grantedSources) !==
          JSON.stringify(grantedSources)
      ) {
        throw new Error(
          'A2A response ledger key is already bound to another result',
        );
      }
      return existing;
    }
    const timestamp = this.timestamp();
    const record: EnterpriseAtoaResponseRecord = {
      v: LEDGER_VERSION,
      ...key,
      requestHash,
      answer,
      answerHash: sha256(answer),
      grantedSources,
      status: 'generated',
      attempts: 0,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAttemptAt: null,
      submittedAt: null,
    };
    this.save(record);
    return record;
  }

  markSubmitting(
    input: EnterpriseAtoaResponseLookup,
  ): EnterpriseAtoaResponseRecord {
    const current = this.required(input);
    if (current.status === 'submitted') return current;
    const timestamp = this.timestamp();
    const next: EnterpriseAtoaResponseRecord = {
      ...current,
      status: 'submitting',
      attempts: current.attempts + 1,
      error: null,
      updatedAt: timestamp,
      lastAttemptAt: timestamp,
      submittedAt: null,
    };
    this.save(next);
    return next;
  }

  markSubmissionFailed(
    input: EnterpriseAtoaResponseLookup & { error: string },
  ): EnterpriseAtoaResponseRecord {
    const current = this.required(input);
    if (current.status === 'submitted') return current;
    const error = input.error.trim().slice(0, MAX_ERROR_LENGTH);
    if (!error)
      throw new Error('A2A response ledger submission error is required');
    const next: EnterpriseAtoaResponseRecord = {
      ...current,
      status: 'generated',
      error,
      updatedAt: this.timestamp(),
      submittedAt: null,
    };
    this.save(next);
    return next;
  }

  markSubmitted(
    input: EnterpriseAtoaResponseLookup,
  ): EnterpriseAtoaResponseRecord {
    const current = this.required(input);
    if (current.status === 'submitted') return current;
    const timestamp = this.timestamp();
    const next: EnterpriseAtoaResponseRecord = {
      ...current,
      status: 'submitted',
      error: null,
      updatedAt: timestamp,
      submittedAt: timestamp,
    };
    this.save(next);
    return next;
  }

  cleanupSubmitted(): { removed: number; retained: number } {
    if (!existsSync(this.options.directory)) return { removed: 0, retained: 0 };
    const cutoff = this.now().getTime() - this.submittedRetentionMs;
    let removed = 0;
    let retained = 0;
    for (const name of readdirSync(this.options.directory)) {
      if (!name.endsWith(LEDGER_SUFFIX)) continue;
      const filePath = path.join(this.options.directory, name);
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('A2A response ledger path is not a regular file');
      }
      let record: EnterpriseAtoaResponseRecord;
      try {
        record = validateRecord(
          JSON.parse(this.options.unprotect(readFileSync(filePath, 'utf8'))),
        );
      } catch {
        throw new Error('A2A response ledger cleanup validation failed');
      }
      if (
        path.basename(this.filePath(record)) !== name ||
        record.status !== 'submitted' ||
        record.submittedAt === null ||
        Date.parse(record.submittedAt) > cutoff
      ) {
        retained += 1;
        continue;
      }
      rmSync(filePath, { force: true });
      fsyncDirectory(this.options.directory);
      removed += 1;
    }
    return { removed, retained };
  }

  private required(
    input: EnterpriseAtoaResponseLookup,
  ): EnterpriseAtoaResponseRecord {
    const record = this.load(input);
    if (!record) throw new Error('A2A response ledger record was not found');
    return record;
  }

  private requireRequestHash(value: string): string {
    if (typeof value !== 'string' || !SHA256.test(value)) {
      throw new Error('A2A response ledger request hash is invalid');
    }
    return value;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error('A2A response ledger clock is invalid');
    }
    return value.toISOString();
  }

  private filePath(key: EnterpriseAtoaResponseKey): string {
    return path.join(
      this.options.directory,
      `${keyDigest(normalizeKey(key))}${LEDGER_SUFFIX}`,
    );
  }

  private save(record: EnterpriseAtoaResponseRecord): void {
    const validated = validateRecord(record, normalizeKey(record));
    let protectedRecord: string;
    try {
      protectedRecord = this.options.protect(JSON.stringify(validated));
    } catch {
      throw new Error('A2A response ledger protection failed');
    }
    if (typeof protectedRecord !== 'string' || !protectedRecord) {
      throw new Error('A2A response ledger protection failed');
    }
    atomicWrite(this.filePath(validated), protectedRecord);
  }
}
