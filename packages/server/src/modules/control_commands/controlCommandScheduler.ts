/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Control 指令调度器 / transport（CONTROL-12）——把纯队列/outbox 接到可注入时钟的
 * 运行时驱动。
 *
 * 职责：
 *  - 主动领取（claim）一个可执行指令，交给 execute 钩子；
 *  - execute 完成后写入回执，并把回执投递到 outbox（异步、可重试、指数退避、死信）；
 *  - 时钟可注入（now()），便于测试和真实调度；
 *  - 与网络层解耦：scheduler 只负责状态推进，不关心 HTTP 协议。
 */

import type { ControlCommandRunResult } from './controlCommandQueue.js';
import {
  claimPendingControlCommand,
  completeControlCommandInRepository,
  type ControlCommandQueueStore,
  type QueuedControlCommandRow,
} from './controlCommandQueue.js';
import { buildControlCommandReceipt } from './controlCommandReceipt.js';
import {
  claimReadyOutboxRows,
  completeOutboxInRepository,
  failOutboxDeliveryInRepository,
  recoverInFlightOutboxRows,
  enqueueOutboxInRepository,
  type ControlCommandOutboxStore,
} from './controlCommandOutbox.js';
import type { ControlCommandEnvelope, ControlCommandType } from './controlCommandEnvelope.js';

export interface ControlCommandSchedulerDeps {
  queue: ControlCommandQueueStore;
  outbox: ControlCommandOutboxStore;
  /** 可注入时钟（ms epoch）。 */
  now?(): number;
  /** 执行一个已领取指令（应幂等、仅返回不含秘密的结果）。 */
  execute(command: ControlCommandEnvelope): ControlCommandRunResult;
  /** 部署签名私钥（PEM，可选），用于回执签名。 */
  signingPrivateKey?: string;
  /** 返回目标是否成功投递（网络层注入）。 */
  deliver?(commandId: string, receipt: unknown): boolean;
  /** 领取租约时长（ms），默认 30s。 */
  leaseMs?: number;
  /** 每次收 outbox 的批量大小，默认 10。 */
  outboxBatchSize?: number;
  /** outbox 最大投递尝试次数，默认 5。 */
  outboxMaxAttempts?: number;
  /** outbox 指数退避基数（ms），默认 1000（1s→2s→4s…）。 */
  outboxBackoffBaseMs?: number;
  /** delivering 视为崩溃的时间阈值（ms），默认 60s。 */
  outboxStaleAfterMs?: number;
}

export interface ControlCommandScheduler {
  /** 领取并执行最多一条可执行指令；返回是否执行了。 */
  drainOnce(): { executed: boolean };
  /** 投递最多一批已完成的回执；返回投递成功的数量。 */
  flushOutbox(targetNow?: number): { delivered: number; recovered: number };
  /** 崩溃恢复：把 stuck 的 delivering 拉回 pending。 */
  recoverOutbox(): { recovered: number };
}

function rowToEnvelope(row: QueuedControlCommandRow): ControlCommandEnvelope {
  return {
    commandId: row.command_id,
    type: row.type as ControlCommandType,
    schemaVersion: row.schema_version,
    sequence: row.sequence,
    deploymentId: row.deployment_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key ?? undefined,
    payloadDigest: row.payload_digest,
    payload: row.payload_json
      ? (JSON.parse(row.payload_json) as Record<string, unknown>)
      : {},
    signature: row.signature,
  };
}

export function createControlCommandScheduler(
  deps: ControlCommandSchedulerDeps,
): ControlCommandScheduler {
  const now = deps.now ?? (() => Date.now());
  const leaseMs = deps.leaseMs ?? 30_000;
  const batchSize = deps.outboxBatchSize ?? 10;
  const maxAttempts = deps.outboxMaxAttempts ?? 5;
  const backoffBaseMs = deps.outboxBackoffBaseMs ?? 1_000;
  const staleAfterMs = deps.outboxStaleAfterMs ?? 60_000;
  const deliver = deps.deliver ?? (() => true);

  function drainOnce(): { executed: boolean } {
    const row = claimPendingControlCommand(deps.queue, leaseMs);
    if (!row) return { executed: false };

    try {
      const envelope = rowToEnvelope(row);
      const result = deps.execute(envelope);
      completeControlCommandInRepository(deps.queue, row.command_id, result);

      // 投递完成后，把回执写入 outbox（异步投递意图）。
      enqueueOutboxInRepository(deps.outbox, row.command_id, now());
      return { executed: true };
    } catch (e) {
      // 执行抛错 → failed 终态，也投递回执（带错误分类）。
      const summary = e instanceof Error ? e.message : 'execution error';
      completeControlCommandInRepository(deps.queue, row.command_id, {
        status: 'failed',
        resultSummary: summary,
        errorCategory: 'execution_error',
      });
      enqueueOutboxInRepository(deps.outbox, row.command_id, now());
      return { executed: true };
    } finally {
      void deps;
    }
  }

  function flushOutbox(targetNow?: number): { delivered: number; recovered: number } {
    const t = targetNow ?? now();
    const { rows } = claimReadyOutboxRows(deps.outbox, t, batchSize, maxAttempts);
    const recovered = recoverInFlightOutboxRows(deps.outbox, t, staleAfterMs).length;
    let delivered = 0;
    for (const row of rows) {
      const commandId = row.command_id;
      const commandRow = deps.queue.db().prepare(
        'SELECT status, result_summary, resource_id, error_category, deployment_id FROM control_command_queue WHERE command_id = ?',
      ).get(commandId) as
        | {
            status: string;
            result_summary: string | null;
            resource_id: string | null;
            error_category: string | null;
            deployment_id: string;
          }
        | undefined;
      if (!commandRow) {
        failOutboxDeliveryInRepository(deps.outbox, commandId, t, maxAttempts, backoffBaseMs);
        continue;
      }
      const receipt = buildControlCommandReceipt({
        commandId,
        deploymentId: commandRow.deployment_id,
        executionVersion: 1,
        status: commandRow.status as ControlCommandReceiptStatus,
        resultSummary: commandRow.result_summary ?? 'executed',
        ...(commandRow.resource_id ? { resourceId: commandRow.resource_id } : {}),
        ...(commandRow.error_category ? { errorCategory: commandRow.error_category } : {}),
        ...(deps.signingPrivateKey ? { signingPrivateKey: deps.signingPrivateKey } : {}),
      });
      if (deliver(commandId, receipt)) {
        if (completeOutboxInRepository(deps.outbox, commandId, t)) delivered += 1;
      } else {
        failOutboxDeliveryInRepository(deps.outbox, commandId, t, maxAttempts, backoffBaseMs);
      }
    }
    return { delivered, recovered };
  }

  function recoverOutbox(): { recovered: number } {
    const n = recoverInFlightOutboxRows(deps.outbox, now(), staleAfterMs).length;
    return { recovered: n };
  }

  return { drainOnce, flushOutbox, recoverOutbox };
}

type ControlCommandReceiptStatus =
  | 'accepted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown_outcome'
  | 'expired'
  | 'cancelled';
