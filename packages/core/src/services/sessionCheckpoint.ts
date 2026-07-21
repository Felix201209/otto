/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Content } from '@google/genai';

export type SessionCheckpointState = 'running' | 'ready' | 'stalled' | 'ended';

export interface SessionCheckpointRecord {
  version: 1;
  sessionId: string;
  projectRoot?: string;
  state: SessionCheckpointState;
  updatedAt: string;
  turnCount: number;
  history: Content[];
  pendingRequest?: unknown;
  /** Deterministic summary of history omitted by the low-memory byte budget. */
  summary?: string;
  /** Last user task, retained even when its full request cannot fit. */
  lastTask?: string;
  reason?: string;
  stallCount?: number;
  recoveryCount?: number;
}

export interface SessionCheckpointWriteInput {
  sessionId: string;
  projectRoot?: string;
  history: readonly unknown[];
  turnCount: number;
  pendingRequest?: unknown;
}

export interface SessionCheckpointServiceOptions {
  rootDir?: string;
  now?: () => Date;
  maxAgeMs?: number;
  maxBytes?: number;
}

function defaultRoot(): string {
  const userDir = process.env['OTTO_USER_DIR']?.trim();
  if (userDir) return path.join(userDir, 'runtime', 'checkpoints');
  if (process.env['NODE_ENV'] === 'test' || process.env['VITEST']) {
    return path.join(
      os.tmpdir(),
      'otto-session-checkpoint-tests',
      String(process.pid),
    );
  }
  return path.join(os.homedir(), '.otto-user', 'runtime', 'checkpoints');
}

function safeSessionId(sessionId: string): string {
  return (
    sessionId
      .trim()
      .replace(/[^A-Za-z0-9_.-]/g, '_')
      .slice(0, 160) || 'default'
  );
}

function normalizeProjectRoot(value: string | undefined): string | undefined {
  return value
    ? path
        .resolve(value)
        .replace(/[\\/]+$/, '')
        .toLowerCase()
    : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (Array.isArray(record.parts))
    return record.parts.map(contentText).filter(Boolean).join(' ');
  if (Array.isArray(value))
    return value.map(contentText).filter(Boolean).join(' ');
  return '';
}

function summarizeOmittedHistory(history: Content[]): string | undefined {
  const lines = history
    .map((message) => {
      const text = contentText(message).replace(/\s+/g, ' ').trim();
      return text
        ? `- ${message.role ?? 'unknown'}: ${text.slice(0, 500)}`
        : '';
    })
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const summary = lines.join('\n');
  return summary.length > 4_000 ? `${summary.slice(0, 3_999)}…` : summary;
}

function trimHistory(
  history: readonly unknown[],
  maxBytes: number,
): {
  history: Content[];
  summary?: string;
} {
  const copy = JSON.parse(JSON.stringify(history)) as Content[];
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') <= maxBytes)
    return { history: copy };
  const head = copy.slice(0, 2);
  const tail: Content[] = [];
  let tailStart = copy.length;
  let used = Buffer.byteLength(JSON.stringify(head), 'utf8');
  for (let index = copy.length - 1; index >= 2; index -= 1) {
    const itemBytes = Buffer.byteLength(JSON.stringify(copy[index]), 'utf8');
    if (used + itemBytes > maxBytes) break;
    tail.unshift(copy[index]);
    tailStart = index;
    used += itemBytes;
  }
  return {
    history: [...head, ...tail],
    summary: summarizeOmittedHistory(copy.slice(2, tailStart)),
  };
}

function checkpointBytes(record: SessionCheckpointRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}

function fitCheckpointRecord(
  input: SessionCheckpointRecord,
  maxBytes: number,
): SessionCheckpointRecord {
  const record = JSON.parse(JSON.stringify(input)) as SessionCheckpointRecord;
  // pendingRequest is redundant with lastTask and is the first field dropped
  // under pressure. It is already text-only, but this keeps tiny checkpoints
  // useful and prevents attachment payloads from ever dominating the file.
  if (checkpointBytes(record) > maxBytes) delete record.pendingRequest;
  while (checkpointBytes(record) > maxBytes && record.history.length > 2) {
    record.history.splice(2, 1);
  }
  const shrinkField = (field: 'summary' | 'lastTask' | 'reason') => {
    const value = record[field];
    if (!value || checkpointBytes(record) <= maxBytes) return;
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      record[field] = `${value.slice(0, middle)}…`;
      if (checkpointBytes(record) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    record[field] = low > 0 ? `${value.slice(0, low)}…` : undefined;
  };
  shrinkField('summary');
  shrinkField('lastTask');
  shrinkField('reason');
  while (checkpointBytes(record) > maxBytes && record.history.length > 0) {
    record.history.shift();
  }
  if (checkpointBytes(record) > maxBytes) {
    throw new Error(
      `Session checkpoint metadata exceeds hard limit (${maxBytes} bytes)`,
    );
  }
  return record;
}

export function buildCheckpointRecoveryHistory(
  record: SessionCheckpointRecord,
): Content[] {
  const recoveryParts = [
    record.summary ? `[Runtime recovery summary]\n${record.summary}` : '',
    record.lastTask ? `[Last unfinished user task]\n${record.lastTask}` : '',
    `[Checkpoint state] ${record.state}; saved ${record.updatedAt}`,
  ].filter(Boolean);
  if (recoveryParts.length === 1 && !record.summary && !record.lastTask)
    return record.history;
  return [
    ...record.history,
    { role: 'user', parts: [{ text: recoveryParts.join('\n\n') }] },
    {
      role: 'model',
      parts: [
        {
          text: 'The local Otto runtime checkpoint has been restored. I will use it as continuity context and verify current state before continuing.',
        },
      ],
    },
  ];
}

export class SessionCheckpointService {
  private readonly rootDir: string;
  private readonly now: () => Date;
  private readonly maxAgeMs: number;
  private readonly maxBytes: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: SessionCheckpointServiceOptions = {}) {
    this.rootDir = options.rootDir ?? defaultRoot();
    this.now = options.now ?? (() => new Date());
    this.maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.maxBytes = Math.max(1_024, options.maxBytes ?? 2 * 1024 * 1024);
  }

  markTurnStarted(input: SessionCheckpointWriteInput): Promise<void> {
    const trimmed = trimHistory(
      input.history,
      Math.max(256, Math.floor(this.maxBytes * 0.65)),
    );
    const lastTask =
      contentText(input.pendingRequest)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2_000) || undefined;
    return this.write({
      version: 1,
      sessionId: input.sessionId,
      projectRoot: input.projectRoot,
      state: 'running',
      updatedAt: this.now().toISOString(),
      turnCount: input.turnCount,
      history: trimmed.history,
      pendingRequest: lastTask,
      summary: trimmed.summary,
      lastTask,
    });
  }

  async markTurnReady(input: SessionCheckpointWriteInput): Promise<void> {
    const previous = await this.read(input.sessionId);
    const trimmed = trimHistory(input.history, this.maxBytes);
    return this.write({
      version: 1,
      sessionId: input.sessionId,
      projectRoot: input.projectRoot,
      state: 'ready',
      updatedAt: this.now().toISOString(),
      turnCount: input.turnCount,
      history: trimmed.history,
      summary: trimmed.summary ?? previous?.summary,
      lastTask: previous?.lastTask,
      recoveryCount: previous?.recoveryCount,
    });
  }

  async markStalled(sessionId: string, projectRoot?: string): Promise<void> {
    const previous = await this.read(sessionId);
    await this.write({
      version: 1,
      sessionId,
      projectRoot,
      state: 'stalled',
      updatedAt: this.now().toISOString(),
      turnCount: previous?.turnCount ?? 0,
      history: previous?.history ?? [],
      pendingRequest: previous?.pendingRequest,
      summary: previous?.summary,
      lastTask: previous?.lastTask,
      stallCount: (previous?.stallCount ?? 0) + 1,
      recoveryCount: previous?.recoveryCount,
    });
  }

  async markTurnInterrupted(
    sessionId: string,
    projectRoot: string | undefined,
    reason: string,
  ): Promise<void> {
    const previous = await this.read(sessionId);
    if (!previous || previous.state === 'ended') return;
    await this.write({
      ...previous,
      projectRoot,
      state: previous.state === 'stalled' ? 'stalled' : 'running',
      updatedAt: this.now().toISOString(),
      reason:
        reason.replace(/\s+/g, ' ').trim().slice(0, 300) || 'turn_incomplete',
    });
  }

  async markSessionEnded(
    sessionId: string,
    projectRoot: string | undefined,
    reason: string,
  ): Promise<void> {
    const previous = await this.read(sessionId);
    await this.write({
      version: 1,
      sessionId,
      projectRoot,
      state: 'ended',
      updatedAt: this.now().toISOString(),
      turnCount: previous?.turnCount ?? 0,
      history: previous?.history ?? [],
      reason,
      stallCount: previous?.stallCount,
      summary: previous?.summary,
      lastTask: previous?.lastTask,
      recoveryCount: previous?.recoveryCount,
    });
  }

  async markRecoveryApplied(sessionId: string): Promise<void> {
    const previous = await this.read(sessionId);
    if (!previous) return;
    await this.write({
      ...previous,
      updatedAt: this.now().toISOString(),
      recoveryCount: (previous.recoveryCount ?? 0) + 1,
    });
  }

  async getStatus(sessionId: string): Promise<SessionCheckpointRecord | null> {
    await this.writeQueue.catch(() => undefined);
    return this.read(sessionId);
  }

  async restoreLatest(
    sessionId: string,
    projectRoot?: string,
  ): Promise<SessionCheckpointRecord | null> {
    await this.writeQueue.catch(() => undefined);
    const record = await this.read(sessionId);
    if (
      !record ||
      record.version !== 1 ||
      !['running', 'stalled'].includes(record.state)
    )
      return null;
    if (
      normalizeProjectRoot(record.projectRoot) !==
      normalizeProjectRoot(projectRoot)
    )
      return null;
    const updatedAt = Date.parse(record.updatedAt);
    if (
      !Number.isFinite(updatedAt) ||
      this.now().getTime() - updatedAt > this.maxAgeMs
    )
      return null;
    return record;
  }

  private filePath(sessionId: string): string {
    return path.join(this.rootDir, `${safeSessionId(sessionId)}.json`);
  }

  private async read(
    sessionId: string,
  ): Promise<SessionCheckpointRecord | null> {
    try {
      return JSON.parse(
        await fs.readFile(this.filePath(sessionId), 'utf8'),
      ) as SessionCheckpointRecord;
    } catch {
      return null;
    }
  }

  private write(record: SessionCheckpointRecord): Promise<void> {
    const operation = async () => {
      await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32')
        await fs.chmod(this.rootDir, 0o700).catch(() => undefined);
      const filePath = this.filePath(record.sessionId);
      const tempPath = `${filePath}.tmp-${process.pid}`;
      const boundedRecord = fitCheckpointRecord(record, this.maxBytes);
      await fs.writeFile(tempPath, JSON.stringify(boundedRecord), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.rename(tempPath, filePath);
      if (process.platform !== 'win32')
        await fs.chmod(filePath, 0o600).catch(() => undefined);
    };
    const current = this.writeQueue.then(operation, operation);
    this.writeQueue = current.catch(() => undefined);
    return current;
  }
}
