/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Control 指令队列状态机（CONTROL-12）。
 *
 * 执行结果状态：accepted / running / succeeded / failed / unknown_outcome /
 * expired / cancelled。
 *
 * 不变量：
 *  - 每张指令以其 (commandId, idempotencyKey) 唯一；
 *  - 同 commandId 重复 accept 返回既有记录（幂等），不重复执行；
 *  - sequence 单调：不接受 sequence <= 已见最大序列的指令（乱序拒绝）；
 *  - 过期指令在领取时被标记 expired 且不执行；
 *  - 领取通过租约(exclusive execution) 语义，多实例场景下由 store 保证单一执行者。
 *
 * 存储层通过 ControlCommandQueueStore 接口抽象——默认提供 SQLite 实现，
 * 未来可换成 PostgreSQL 多实例实现。
 */

import type { Database } from '../data_platform/index.js';

export type ControlCommandStatus =
  | 'accepted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown_outcome'
  | 'expired'
  | 'cancelled';

export interface ControlCommandLeaseView {
  commandId: string;
  attempt: number;
  lockedUntilMs: number;
}

/** 队列存储接口（可插拔）。 */
export interface ControlCommandQueueStore {
  db(): Database;
  now(): number;
}

export interface ControlCommandRunResult {
  /** 执行后的状态。 */
  status: Exclude<ControlCommandStatus, 'accepted' | 'running'>;
  /** 结果摘要（不含秘密）。 */
  resultSummary: string;
  /** 资源 ID（如企业/CEO ID），可空。 */
  resourceId?: string;
  /** 错误分类（供重试/死信决策）。 */
  errorCategory?: string;
}

export interface ControlCommandEnqueueInput {
  commandId: string;
  type: string;
  schemaVersion: number;
  sequence: number;
  deploymentId: string;
  issuedAt: string;
  expiresAt: string;
  idempotencyKey?: string;
  payloadDigest: string;
  payloadJson?: string;
  signature: string;
}

export interface AcceptedControlCommand {
  commandId: string;
  status: ControlCommandStatus;
  attempt: number;
  replayed: boolean;
}

export class ControlCommandIdConflictError extends Error {
  readonly code = 'command_id_conflict';

  constructor() {
    super('command_id_conflict');
    this.name = 'ControlCommandIdConflictError';
  }
}

export interface QueuedControlCommandRow {
  command_id: string;
  type: string;
  schema_version: number;
  sequence: number;
  deployment_id: string;
  issued_at: string;
  expires_at: string;
  idempotency_key: string | null;
  payload_digest: string;
  payload_json: string | null;
  signature: string;
  status: ControlCommandStatus;
  attempt: number;
  result_summary: string | null;
  resource_id: string | null;
  error_category: string | null;
  locked_until_ms: number | null;
  last_error: string | null;
}

function tableExists(database: Database, table: string): boolean {
  try {
    return Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table));
  } catch {
    return false;
  }
}

function ensureTable(database: Database): void {
  if (tableExists(database, 'control_command_queue')) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS control_command_queue (
      command_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      deployment_id TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      idempotency_key TEXT,
      payload_digest TEXT NOT NULL,
      signature TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      result_summary TEXT,
      resource_id TEXT,
      error_category TEXT,
      locked_until_ms INTEGER,
      last_error TEXT,
      max_sequence INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function commandMatchesStoredEnvelope(
  existing: QueuedControlCommandRow,
  input: ControlCommandEnqueueInput,
): boolean {
  return (
    existing.type === input.type &&
    existing.schema_version === input.schemaVersion &&
    existing.sequence === input.sequence &&
    existing.deployment_id === input.deploymentId &&
    existing.issued_at === input.issuedAt &&
    existing.expires_at === input.expiresAt &&
    existing.idempotency_key === (input.idempotencyKey ?? null) &&
    existing.payload_digest === input.payloadDigest &&
    existing.signature === input.signature &&
    existing.payload_json === (input.payloadJson ?? null)
  );
}

function replayExistingCommand(
  existing: QueuedControlCommandRow,
  input: ControlCommandEnqueueInput,
): AcceptedControlCommand {
  if (!commandMatchesStoredEnvelope(existing, input)) {
    throw new ControlCommandIdConflictError();
  }
  return {
    commandId: existing.command_id,
    status: existing.status,
    attempt: existing.attempt,
    replayed: true,
  };
}

function parseControlCommandTimestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error('control_command_timestamp_invalid');
  }
  return milliseconds;
}

function expireQueuedControlCommands(database: Database, now: number): void {
  const rows = database.prepare(
    `SELECT command_id, expires_at
     FROM control_command_queue
     WHERE status IN ('accepted', 'running')`,
  ).all() as Array<Pick<
    QueuedControlCommandRow,
    'command_id' | 'expires_at'
  >>;
  const expire = database.prepare(
    `UPDATE control_command_queue
     SET status = 'expired', locked_until_ms = NULL
     WHERE command_id = ? AND status IN ('accepted', 'running')`,
  );

  for (const row of rows) {
    const expiresAtMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      expire.run(row.command_id);
    }
  }
}

/**
 * 接受（入队）一个已通过字段与签名校验的指令。
 * - 幂等：同 commandId 且完整信封一致 → 返回既有状态 + replayed=true；
 * - 冲突：同 commandId 的任一持久化信封字段不同 → command_id_conflict；
 * - 单调序列：commandId 的 sequence 必须 > 已见最大序列，否则拒绝；
 * - 过期：入队即标记 expired 且不执行。
 */
export function acceptControlCommandInRepository(
  store: ControlCommandQueueStore,
  input: ControlCommandEnqueueInput,
): AcceptedControlCommand {
  const database = store.db();
  ensureTable(database);
  parseControlCommandTimestamp(input.issuedAt);
  const expiresMs = parseControlCommandTimestamp(input.expiresAt);

  const existing = database.prepare(
    'SELECT * FROM control_command_queue WHERE command_id = ?',
  ).get(input.commandId) as QueuedControlCommandRow | undefined;
  if (existing) return replayExistingCommand(existing, input);

  const now = store.now();
  const status: ControlCommandStatus = expiresMs <= now ? 'expired' : 'accepted';

  try {
    database.prepare(
      `INSERT INTO control_command_queue
         (command_id, type, schema_version, sequence, deployment_id, issued_at,
          expires_at, idempotency_key, payload_digest, signature, payload_json, status, attempt, max_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      input.commandId, input.type,
      input.schemaVersion, input.sequence,
      input.deploymentId, input.issuedAt,
      input.expiresAt, input.idempotencyKey ?? null,
      input.payloadDigest, input.signature,
      input.payloadJson ?? null, status, input.sequence,
    );
  } catch (error) {
    const raced = database.prepare(
      'SELECT * FROM control_command_queue WHERE command_id = ?',
    ).get(input.commandId) as QueuedControlCommandRow | undefined;
    if (!raced) throw error;
    return replayExistingCommand(raced, input);
  }
  return {
    commandId: input.commandId,
    status,
    attempt: 0,
    replayed: false,
  };
}

/** 领取一个可执行指令（exclusive execution）。返回 null 表示暂无。 */
export function claimPendingControlCommand(
  store: ControlCommandQueueStore,
  leaseMs: number,
): QueuedControlCommandRow | null {
  const database = store.db();
  ensureTable(database);
  const now = store.now();
  expireQueuedControlCommands(database, now);
  // 进程崩溃后，仍在业务时间窗内的过期 running 租约重新进入队列。
  database.prepare(
    `UPDATE control_command_queue
     SET status = 'accepted', locked_until_ms = NULL
     WHERE status = 'running' AND locked_until_ms IS NOT NULL
       AND locked_until_ms <= ?`,
  ).run(now);

  const row = database.prepare(
    `SELECT * FROM control_command_queue
     WHERE status = 'accepted' AND (locked_until_ms IS NULL OR locked_until_ms < ?)
     ORDER BY sequence ASC, command_id ASC LIMIT 1`,
  ).get(now) as QueuedControlCommandRow | undefined;
  if (!row) return null;

  const attempt = (row.attempt ?? 0) + 1;
  const claim = database.prepare(
    `UPDATE control_command_queue
     SET status = 'running', attempt = ?, locked_until_ms = ?
     WHERE command_id = ? AND status = 'accepted'`,
  );
  // 原子独占：仅当 UPDATE 命中（该指令仍处 accepted）才算领成功；
  // 若命中 0 行说明其它实例已先行领取，应交回控制权（返回 null）防止重复执行。
  if (Number(claim.run(attempt, now + leaseMs, row.command_id).changes) === 0) {
    return null;
  }
  return { ...row, status: 'running' as const, attempt, locked_until_ms: now + leaseMs };
}

/** 记录执行结果。 */
export function completeControlCommandInRepository(
  store: ControlCommandQueueStore,
  commandId: string,
  result: ControlCommandRunResult,
): void {
  const database = store.db();
  ensureTable(database);
  database.prepare(
    `UPDATE control_command_queue
     SET status = ?, result_summary = ?, resource_id = ?, error_category = ?,
         locked_until_ms = NULL
     WHERE command_id = ?`,
  ).run(
    result.status, result.resultSummary, result.resourceId ?? null,
    result.errorCategory ?? null, commandId,
  );
}

/** 判断指令是否已存在（幂等重放检测）。 */
export function controlCommandExists(
  store: ControlCommandQueueStore,
  commandId: string,
): boolean {
  const database = store.db();
  ensureTable(database);
  return Boolean(database.prepare(
    'SELECT 1 FROM control_command_queue WHERE command_id = ?',
  ).get(commandId));
}

/** 单调序列校验 + 推进（由收取方在验证信封后调用）。 */
export function assertMonotonicSequence(
  store: ControlCommandQueueStore,
  commandId: string,
  sequence: number,
): { ok: true } | { ok: false; code: string; reason: string } {
  const database = store.db();
  ensureTable(database);
  const row = database.prepare(
    'SELECT max_sequence FROM control_command_queue WHERE command_id = ?',
  ).get(commandId) as { max_sequence: number } | undefined;
  if (row && sequence <= row.max_sequence) {
    return {
      ok: false,
      code: 'non_monotonic_sequence',
      reason: `sequence ${sequence} <= already seen ${row.max_sequence}`,
    };
  }
  return { ok: true };
}

/** 取消一个未执行完成的指令（幂等）。 */
export function cancelControlCommandInRepository(
  store: ControlCommandQueueStore,
  commandId: string,
): ControlCommandStatus {
  const database = store.db();
  ensureTable(database);
  const row = database.prepare(
    'SELECT status FROM control_command_queue WHERE command_id = ?',
  ).get(commandId) as { status: ControlCommandStatus } | undefined;
  if (!row) return 'cancelled';
  if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
    return row.status;
  }
  database.prepare(
    `UPDATE control_command_queue SET status = 'cancelled', locked_until_ms = NULL
     WHERE command_id = ?`,
  ).run(commandId);
  return 'cancelled';
}
