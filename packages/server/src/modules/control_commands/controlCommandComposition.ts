/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import {
  validateControlCommandEnvelope,
  type ControlCommandEnvelope,
} from './controlCommandEnvelope.js';
import {
  acceptControlCommandInRepository,
  claimPendingControlCommand,
  completeControlCommandInRepository,
  assertMonotonicSequence,
  controlCommandExists,
  ControlCommandIdConflictError,
  type ControlCommandQueueStore,
  type ControlCommandRunResult,
} from './controlCommandQueue.js';
import {
  buildControlCommandReceipt,
  type ControlCommandReceipt,
} from './controlCommandReceipt.js';

export interface ControlCommandExecutionDependencies {
  /** 本 Server 的部署 ID（绑定校验）。 */
  deploymentId: string;
  /** 本 Server 当前的部署状态检查（不能只信任队列）。 */
  isDeploymentValid?(deploymentId: string): boolean;
  /** 执行业务（此处对接 SERVER-16 原子企业开通）。返回 { status, resultSummary, resourceId?, errorCategory? }。 */
  execute(command: ControlCommandEnvelope): ControlCommandRunResult;
  /** 当前轮次 epoch/monotonic 时钟（用于签名密钥轮换/执行版本）。 */
  executionVersion?(): number;
}

export interface ControlCommandProcessor {
  /** 接收并校验一条指令信封。返回回执或失败原因。 */
  ingest(envelope: ControlCommandEnvelope): Promise<{ receipt: ControlCommandReceipt }> | { receipt: ControlCommandReceipt } | { error: string };
  /** 领取并执行一条待处理指令（轮询/主动领取）。 */
  drainOne(): ControlCommandReceipt | null;
}

/**
 * 建立 Control 指令处理管线：信封校验（纯）→ 单调序列 → 幂等入队 →
 * 领取 → 业务执行（SERVER-16）→ 签名回执。
 *
 * 签名校验依赖信任根的密钥环（由上层注入 public keys），此处通过
 * verifyControlSignature 钩子注入以避免硬编码信任根。
 */
export function createControlCommandProcessor(input: {
  db(): Database;
  now?(): number;
  deploymentId: string;
  verifyControlSignature(envelope: ControlCommandEnvelope): { valid: boolean; keyId: string | null };
  execute(command: ControlCommandEnvelope): ControlCommandRunResult;
  signingPrivateKey?: string;
  /** 当前执行版本（签名密钥轮换/回执版本）。 */
  executionVersion?(): number;
}): ControlCommandProcessor {
  const now = input.now ?? Date.now;
  const store: ControlCommandQueueStore = {
    db: input.db,
    now,
  };

  return {
    ingest(envelope: ControlCommandEnvelope) {
      // 1) 签名校验（信任根）。
      const sig = input.verifyControlSignature(envelope);
      if (!sig.valid) {
        return { error: 'invalid_signature' };
      }
      // 2) 字段级校验 + 时间窗 + payload 摘要 + 部署绑定（纯）。
      const fieldCheck = validateControlCommandEnvelope(envelope, {
        serverDeploymentId: input.deploymentId,
        now: now(),
      });
      if (!fieldCheck.ok) {
        return fieldCheck.code === 'expired' ? { error: 'expired' } : { error: fieldCheck.code };
      }
      const enqueueInput = {
        commandId: envelope.commandId,
        type: envelope.type,
        schemaVersion: envelope.schemaVersion,
        sequence: envelope.sequence,
        deploymentId: envelope.deploymentId,
        issuedAt: envelope.issuedAt,
        expiresAt: envelope.expiresAt,
        idempotencyKey: envelope.idempotencyKey,
        payloadDigest: envelope.payloadDigest,
        payloadJson: JSON.stringify(envelope.payload),
        signature: envelope.signature,
      };
      // 3) 仅完整信封一致的同 commandId 才是幂等重放。
      if (controlCommandExists(store, envelope.commandId)) {
        try {
          const replay = acceptControlCommandInRepository(store, enqueueInput);
          const version = input.executionVersion?.() ?? 1;
          return {
            receipt: buildControlCommandReceipt({
              commandId: envelope.commandId,
              deploymentId: envelope.deploymentId,
              executionVersion: version,
              status: replay.status,
              resultSummary: 'replayed',
              signingPrivateKey: input.signingPrivateKey,
            }),
          };
        } catch (error) {
          if (error instanceof ControlCommandIdConflictError) {
            return { error: error.code };
          }
          throw error;
        }
      }
      // 4) 单调序列。
      const mono = assertMonotonicSequence(store, envelope.commandId, envelope.sequence);
      if (!mono.ok) {
        return { error: mono.code };
      }
      // 5) 幂等入队。
      const accepted = acceptControlCommandInRepository(store, enqueueInput);
      const version = input.executionVersion?.() ?? 1;
      return {
        receipt: buildControlCommandReceipt({
          commandId: envelope.commandId,
          deploymentId: envelope.deploymentId,
          executionVersion: version,
          status: accepted.status,
          resultSummary: accepted.status === 'expired' ? 'expired-on-accept' : 'accepted',
          signingPrivateKey: input.signingPrivateKey,
        }),
      };
    },

    drainOne() {
      const row = claimPendingControlCommand(store, 60_000);
      if (!row) return null;
      // 由于入队时已完整保存信封字段，从队列行重建信封以执行业务。
      const envelope: ControlCommandEnvelope = {
        commandId: row.command_id,
        deploymentId: row.deployment_id,
        type: row.type as ControlCommandEnvelope['type'],
        schemaVersion: row.schema_version,
        sequence: row.sequence,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        idempotencyKey: row.idempotency_key ?? undefined,
        payloadDigest: row.payload_digest,
        payload: row.payload_json ? JSON.parse(row.payload_json) as Record<string, unknown> : {},
        signature: row.signature,
      };
      let run: ControlCommandRunResult;
      try {
        run = input.execute(envelope);
      } catch (error) {
        run = {
          status: 'failed',
          resultSummary: error instanceof Error ? error.message : 'execution error',
          errorCategory: 'execution_error',
        };
      }
      completeControlCommandInRepository(store, row.command_id, run);
      return buildControlCommandReceipt({
        commandId: row.command_id,
        deploymentId: row.deployment_id,
        executionVersion: (input.executionVersion?.() ?? 1),
        status: run.status,
        resultSummary: run.resultSummary,
        resourceId: run.resourceId,
        errorCategory: run.errorCategory,
        signingPrivateKey: input.signingPrivateKey,
      });
    },
  };
}
