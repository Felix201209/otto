/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Control 指令回执（CONTROL-12）。
 *
 * 回执只含：commandId、执行版本、结果摘要、资源 ID、错误分类与部署签名。
 * 绝不回传账号秘密（密码/令牌/License 内容/E2EE 材料）。
 */

import { createHash } from 'node:crypto';
import { canonicalJson, signEd25519Envelope, type ControlCommandStatus } from './types.js';

export interface ControlCommandReceiptInput {
  commandId: string;
  deploymentId: string;
  executionVersion: number;
  status: ControlCommandStatus;
  resultSummary: string;
  resourceId?: string;
  errorCategory?: string;
  /** 部署签名私钥（ed25519 PEM）。 */
  signingPrivateKey?: string;
}

export interface ControlCommandReceipt {
  commandId: string;
  deploymentId: string;
  executionVersion: number;
  status: ControlCommandStatus;
  resultSummary: string;
  resourceId?: string;
  errorCategory?: string;
  receiptDigest: string;
  signature?: string;
}

export interface ControlCommandStatusResult {
  status: ControlCommandStatus;
  resultSummary: string;
  errorCategory?: string;
}

/** 回执的不含秘密的规范摘要。 */
export function receiptPayload(input: Omit<ControlCommandReceiptInput, 'signingPrivateKey'>): Record<string, unknown> {
  return {
    commandId: input.commandId,
    deploymentId: input.deploymentId,
    executionVersion: input.executionVersion,
    status: input.status,
    resultSummary: input.resultSummary,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.errorCategory ? { errorCategory: input.errorCategory } : {}),
  };
}

/** 构建签名回执（若提供私钥则签名；否则只给 digest）。 */
export function buildControlCommandReceipt(
  input: ControlCommandReceiptInput,
): ControlCommandReceipt {
  const digest = createHash('sha256')
    .update(canonicalJson(receiptPayload(input)))
    .digest('hex');
  const receipt: ControlCommandReceipt = {
    commandId: input.commandId,
    deploymentId: input.deploymentId,
    executionVersion: input.executionVersion,
    status: input.status,
    resultSummary: input.resultSummary,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.errorCategory ? { errorCategory: input.errorCategory } : {}),
    receiptDigest: digest,
  };
  if (input.signingPrivateKey) {
    receipt.signature = signEd25519Envelope(receiptPayload(input), input.signingPrivateKey);
  }
  return receipt;
}

/** 从执行结果构造「无秘密」状态视图。 */
export function statusResultFromRun(
  status: ControlCommandStatus,
  resultSummary: string,
  errorCategory?: string,
): ControlCommandStatusResult {
  return { status, resultSummary, ...(errorCategory ? { errorCategory } : {}) };
}

export function statusResultFromError(
  error: unknown,
  fallbackSummary: string,
): ControlCommandStatusResult {
  const summary = error instanceof Error ? error.message : fallbackSummary;
  return { status: 'failed', resultSummary: summary, errorCategory: 'execution_error' };
}

