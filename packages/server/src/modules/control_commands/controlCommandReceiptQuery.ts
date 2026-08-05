/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Control 指令回执查询（CONTROL-12）——响应恢复路径。
 *
 * 场景：Server 执行完毕后回执在网络传输中丢失，Control 重试查询时不得重复创建
 * 企业或管理员。本模块从队列表读取既有执行结果，重建「无秘密」签名回执。
 *
 * 不变式：
 *  - 仅对 command 已存在且产生终态（succeeded / failed / unknown_outcome /
 *    expired / cancelled）时返回回执；
 *  - 终态之前（accepted / running）返回 null，调用方据此决定等待或忽略；
 *  - 回执复用 buildControlCommandReceipt，不含账号秘密。
 */

import {
  buildControlCommandReceipt,
  type ControlCommandReceipt,
} from './controlCommandReceipt.js';
import type { ControlCommandQueueStore } from './controlCommandQueue.js';

/** 队列表中回执所需的列。 */
export interface StoredControlCommandReceiptRow {
  command_id: string;
  status: string;
  result_summary: string | null;
  resource_id: string | null;
  error_category: string | null;
  deployment_id: string;
  execution_version: number;
}

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'unknown_outcome',
  'expired',
  'cancelled',
]);

/** 建队列主表（含 execution_version 列）。与 controlCommandQueue 保持同 schema。 */
const QUEUE_TABLE_CREATE = `
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
    max_sequence INTEGER NOT NULL DEFAULT 0,
    execution_version INTEGER NOT NULL DEFAULT 1
  );
`;

function ensureTable(database: {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run?(...args: unknown[]): { changes: number | bigint };
    exec?(sql: string): void;
  };
  exec?(sql: string): void;
}): void {
  // 表不存在则按同 schema 建表；已存在但缺 execution_version 列则补齐。
  database.exec?.(QUEUE_TABLE_CREATE);
  try {
    database.prepare(
      'SELECT execution_version FROM control_command_queue LIMIT 1',
    ).get();
  } catch {
    database.prepare(
      'ALTER TABLE control_command_queue ADD COLUMN execution_version INTEGER NOT NULL DEFAULT 1',
    )?.run?.();
  }
}

function readRow(
  store: ControlCommandQueueStore,
  commandId: string,
): StoredControlCommandReceiptRow | null {
  const database = store.db();
  ensureTable(database);
  const row = database.prepare(
    `SELECT command_id, status, result_summary, resource_id, error_category,
            deployment_id, execution_version
     FROM control_command_queue WHERE command_id = ?`,
  ).get(commandId) as StoredControlCommandReceiptRow | undefined;
  return row ?? null;
}

/**
 * 查询一条指令的既有签名回执。
 *
 * @param store      队列存储
 * @param commandId  指令 ID
 * @param signingPrivateKey 部署签名私钥（PEM，可选；不提供则只给 digest）
 * @returns 终态回执；若指令不存在或尚未到达终态返回 null。
 */
export function queryControlCommandReceipt(
  store: ControlCommandQueueStore,
  commandId: string,
  signingPrivateKey?: string,
): ControlCommandReceipt | null {
  const row = readRow(store, commandId);
  if (!row) return null;
  if (!TERMINAL_STATUSES.has(row.status)) return null;
  return buildControlCommandReceipt({
    commandId: row.command_id,
    deploymentId: row.deployment_id,
    executionVersion: row.execution_version ?? 1,
    status: row.status as ControlCommandReceipt['status'],
    resultSummary: row.result_summary ?? 'executed',
    ...(row.resource_id ? { resourceId: row.resource_id } : {}),
    ...(row.error_category ? { errorCategory: row.error_category } : {}),
    signingPrivateKey,
  });
}
