/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Control 指令事务性 outbox（CONTROL-12）。
 *
 * 目的：避免「指令已入队/已执行，但投递给 Control 的确认丢失」→ Server 与 Control
 * 状态不一致。方案：把「指令入队 + 待投递确认」放进同一个 SQLite 事务，先持久化
 * 投递意图，再异步投递；投递成功后才标记 delivered。这样崩溃重启后能安全重试，
 * 且不会重复创建企业（执行侧靠 queue 幂等保证）。
 *
 * 语义：
 *  - 投递条目与指令共享主键 command_id；
 *  - outbox 状态机：pending → delivering → delivered；失败保留 pending 累加重试次数；
 *  - pollPendingOutbox 单调推进；deliveryAttempts 累计，超过 maxAttempts 进入 dead；
 *  - recoverInFlightOutbox 用于进程崩溃后把 stuck 的 delivering 拉回 pending。
 */

import type { Database } from '../data_platform/index.js';

export type OutboxState = 'pending' | 'delivering' | 'delivered' | 'dead';

export interface ControlCommandOutboxRow {
  command_id: string;
  state: OutboxState;
  delivery_attempts: number;
  next_attempt_at_ms: number | null;
  last_error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ControlCommandOutboxStore {
  db(): Database;
}

/** outbox 表 schema（独立建表，勿与队列主表耦合）。 */
export const CONTROL_COMMAND_OUTBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS control_command_outbox (
    command_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'pending',
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER,
    last_error TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
`;

function ensureTable(database: Database, now: number): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(CONTROL_COMMAND_OUTBOX_SCHEMA);
    database.exec('COMMIT');
  } catch (e) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* noop */
    }
    throw e;
  }
  void now;
}

/**
 * 在事务内写入一条待投递 outbox 条目（交付意图）。
 * 调用方应把「指令入队 + 本调用」放进同一事务，保证原子性。
 * @returns 是否新增（false 表示已存在，幂等）。
 */
export function enqueueOutboxInRepository(
  store: ControlCommandOutboxStore,
  commandId: string,
  now: number,
): boolean {
  const database = store.db();
  ensureTable(database, now);
  const existing = database.prepare(
    'SELECT 1 FROM control_command_outbox WHERE command_id = ?',
  ).get(commandId);
  if (existing) return false;
  database.prepare(
    `INSERT INTO control_command_outbox
       (command_id, state, delivery_attempts, next_attempt_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, 'pending', 0, NULL, ?, ?)`,
  ).run(commandId, now, now);
  return true;
}

export interface OutboxDrainResult {
  claimed: number;
  rows: ControlCommandOutboxRow[];
}

/**
 * 领取一批到期可投递的 outbox 条目（exclusive，避免多实例双投递）。
 * maxAttempts 之内的条目交付失败后保持 pending 并按 next_attempt_at_ms 延后退避。
 */
export function claimReadyOutboxRows(
  store: ControlCommandOutboxStore,
  now: number,
  batchSize: number,
  maxAttempts: number,
): OutboxDrainResult {
  const database = store.db();
  ensureTable(database, now);
  const rows = database.prepare(
    `SELECT * FROM control_command_outbox
     WHERE state = 'pending'
       AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
     ORDER BY created_at_ms ASC LIMIT ?`,
  ).all(now, batchSize) as ControlCommandOutboxRow[];

  const claimed: ControlCommandOutboxRow[] = [];
  const flip = database.prepare(
    `UPDATE control_command_outbox
     SET state = 'delivering', updated_at_ms = ?
     WHERE command_id = ? AND state = 'pending'`,
  );
  for (const row of rows) {
    // 原子独占：仅当命中（仍 pending）才算领到，防多实例双投递。
    if (Number(flip.run(now, row.command_id).changes) === 1) {
      claimed.push({ ...row, state: 'delivering' });
    }
  }
  return { claimed: claimed.length, rows: claimed };
}

/**
 * 投递成功：标记 delivered。
 * @returns 是否命中并成功更新。
 */
export function completeOutboxInRepository(
  store: ControlCommandOutboxStore,
  commandId: string,
  now: number,
): boolean {
  const database = store.db();
  ensureTable(database, now);
  return Number(database.prepare(
    `UPDATE control_command_outbox
     SET state = 'delivered', delivery_attempts = delivery_attempts + 1, updated_at_ms = ?
     WHERE command_id = ? AND state = 'delivering'`,
  ).run(now, commandId).changes) === 1;
}

/**
 * 投递失败：累加次数并按指数退避延后下次尝试；超限标 dead。
 * @returns 更新后的行；null 表示未命中（可能已被其它实例投递完成）。
 */
export function failOutboxDeliveryInRepository(
  store: ControlCommandOutboxStore,
  commandId: string,
  now: number,
  maxAttempts: number,
  backoffBaseMs: number,
): ControlCommandOutboxRow | null {
  const database = store.db();
  ensureTable(database, now);
  const row = database.prepare(
    'SELECT * FROM control_command_outbox WHERE command_id = ? AND state = ?',
  ).get(commandId, 'delivering') as ControlCommandOutboxRow | undefined;
  if (!row) return null;

  const attempts = (row.delivery_attempts ?? 0) + 1;
  const over = attempts >= maxAttempts;
  const next = over
    ? null
    : now + backoffBaseMs * Math.pow(2, attempts - 1); // 指数退避 2^n
  const state: OutboxState = over ? 'dead' : 'pending';
  database.prepare(
    `UPDATE control_command_outbox
     SET state = ?, delivery_attempts = ?, next_attempt_at_ms = ?,
         last_error = ?, updated_at_ms = ?
     WHERE command_id = ?`,
  ).run(
    state,
    attempts,
    next,
    over ? `max attempts (${maxAttempts}) exceeded` : 'delivery failed',
    now,
    commandId,
  );
  return {
    ...row,
    state,
    delivery_attempts: attempts,
    next_attempt_at_ms: next,
    last_error: over ? `max attempts (${maxAttempts}) exceeded` : 'delivery failed',
    updated_at_ms: now,
  };
}

/**
 * 进程崩溃恢复：把长时间 stuck 在 delivering 的条目拉回 pending（幂等重投）。
 * 返回被恢复的 command_id 列表。
 */
export function recoverInFlightOutboxRows(
  store: ControlCommandOutboxStore,
  now: number,
  staleAfterMs: number,
): string[] {
  const database = store.db();
  ensureTable(database, now);
  const cutoff = now - staleAfterMs;
  const rows = database.prepare(
    `SELECT command_id FROM control_command_outbox
     WHERE state = 'delivering' AND updated_at_ms < ?`,
  ).all(cutoff) as Array<{ command_id: string }>;
  const recovered = database.prepare(
    `UPDATE control_command_outbox
     SET state = 'pending', updated_at_ms = ?, last_error = 'recovered after crash'
     WHERE state = 'delivering' AND updated_at_ms < ?`,
  );
  recovered.run(now, cutoff);
  return rows.map((r) => r.command_id);
}

/** 汇总 outbox 各状态计数（用于监控/运维）。 */
export function summarizeOutboxInRepository(
  store: ControlCommandOutboxStore,
): Record<OutboxState, number> {
  const database = store.db();
  try {
    database.exec(CONTROL_COMMAND_OUTBOX_SCHEMA);
  } catch {
    /* noop */
  }
  const rows = database.prepare(
    'SELECT state, COUNT(*) AS c FROM control_command_outbox GROUP BY state',
  ).all() as Array<{ state: OutboxState; c: number }>;
  const summary: Record<OutboxState, number> = {
    pending: 0,
    delivering: 0,
    delivered: 0,
    dead: 0,
  };
  for (const r of rows) {
    if (r.state in summary) summary[r.state] = r.c;
  }
  return summary;
}
