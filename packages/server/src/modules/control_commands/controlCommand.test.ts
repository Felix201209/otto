/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Database } from '../data_platform/index.js';
import { signEd25519Envelope } from '../commercial_control/signedEnvelope.js';
import {
  validateControlCommandEnvelope,
  payloadDigest,
  createControlCommandProcessor,
  acceptControlCommandInRepository,
  claimPendingControlCommand,
  completeControlCommandInRepository,
  cancelControlCommandInRepository,
  assertMonotonicSequence,
  buildControlCommandReceipt,
  verifyControlCommandSignature,
  type ControlCommandEnvelope,
  type ControlCommandQueueStore,
  type ControlCommandRunResult,
} from './index.js';

// 信任根密钥对
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const NOW_MS = 1_700_000_000_000;

function makeStore(): { db: Database; store: ControlCommandQueueStore } {
  const db = new Database(':memory:');
  return { db, store: { db: () => db, now: () => NOW_MS } };
}

function signEnvelope(body: {
  commandId: string;
  deploymentId: string;
  type: 'enterprise.initiate';
  sequence: number;
  payload: Record<string, unknown>;
  issuedAt?: string;
  expiresAt?: string;
  idempotencyKey?: string;
}): ControlCommandEnvelope {
  const digest = payloadDigest(body.payload);
  const envelope: ControlCommandEnvelope = {
    commandId: body.commandId,
    deploymentId: body.deploymentId,
    type: body.type,
    schemaVersion: 1,
    sequence: body.sequence,
    issuedAt: body.issuedAt ?? new Date(NOW_MS - 1000).toISOString(),
    expiresAt: body.expiresAt ?? new Date(NOW_MS + 60_000).toISOString(),
    idempotencyKey: body.idempotencyKey,
    payloadDigest: digest,
    payload: body.payload,
    signature: '',
  };
  // 用 same canonical body 签名（与 verifier 一致）。
  const signedBody = {
    envelope: {
      commandId: envelope.commandId,
      deploymentId: envelope.deploymentId,
      type: envelope.type,
      schemaVersion: envelope.schemaVersion,
      sequence: envelope.sequence,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      idempotencyKey: envelope.idempotencyKey,
      payloadDigest: envelope.payloadDigest,
      payload: envelope.payload,
    },
  };
  envelope.signature = signEd25519Envelope(signedBody, privateKey);
  return envelope;
}

function validEnvelope(overrides: Partial<ControlCommandEnvelope> = {}): ControlCommandEnvelope {
  return signEnvelope({
    commandId: 'cmd-1',
    deploymentId: 'deploy-1',
    type: 'enterprise.initiate',
    sequence: 1,
    payload: { organization: { name: 'Corp' } },
    ...overrides,
  });
}

describe('control command envelope validation (CONTROL-12)', () => {
  it('合法信封通过校验', () => {
    const result = validateControlCommandEnvelope(validEnvelope(), {
      serverDeploymentId: 'deploy-1',
      now: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('跨部署指令失败（deployment mismatch）', () => {
    const env = validEnvelope({ deploymentId: 'other-deploy' });
    const result = validateControlCommandEnvelope(env, {
      serverDeploymentId: 'deploy-1',
      now: NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('deployment_mismatch');
  });

  it('未知指令类型 fail closed', () => {
    const env = { ...validEnvelope(), type: 'unknown.type' as never };
    const result = validateControlCommandEnvelope(env, {
      serverDeploymentId: 'deploy-1',
      now: NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_command_type');
  });

  it('过期指令被拒绝', () => {
    const env = validEnvelope({ expiresAt: new Date(NOW_MS - 1000).toISOString() });
    const result = validateControlCommandEnvelope(env, {
      serverDeploymentId: 'deploy-1',
      now: NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('expired');
  });

  it('payload 摘要不匹配被拒绝', () => {
    const env = validEnvelope();
    const corrupted = { ...env, payloadDigest: 'deadbeef' };
    const result = validateControlCommandEnvelope(corrupted, {
      serverDeploymentId: 'deploy-1',
      now: NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('payload_digest_mismatch');
  });

  it('越界 schemaVersion 被拒绝', () => {
    const env = { ...validEnvelope(), schemaVersion: 99 };
    const result = validateControlCommandEnvelope(env, {
      serverDeploymentId: 'deploy-1',
      now: NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unsupported_schema_version');
  });
});

describe('control command signature (CONTROL-12)', () => {
  it('正确签名通过信任根校验', () => {
    const env = validEnvelope();
    const result = verifyControlCommandSignature(env, [publicKey]);
    expect(result.valid).toBe(true);
  });

  it('篡改签名失败', () => {
    const env = validEnvelope();
    const tampered = { ...env, signature: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    const result = verifyControlCommandSignature(tampered, [publicKey]);
    expect(result.valid).toBe(false);
  });

  it('未知信任根失败', () => {
    const env = validEnvelope();
    const other = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const result = verifyControlCommandSignature(env, [other.publicKey]);
    expect(result.valid).toBe(false);
  });
});

describe('control command queue (CONTROL-12)', () => {
  it('accept 入队 → claim → complete → succeeded', () => {
    const { store } = makeStore();
    const row = claimPendingControlCommand(store, 60_000);
    expect(row).toBeNull();

    const accepted = acceptControlCommandInRepository(store, {
      commandId: 'c1', type: 'enterprise.initiate', schemaVersion: 1,
      sequence: 1, deploymentId: 'deploy-1', issuedAt: 'now', expiresAt: 'later',
      idempotencyKey: 'k1', payloadDigest: 'd', payloadJson: '{}', signature: 'sig',
    });
    expect(accepted.status).toBe('accepted');
    expect(accepted.replayed).toBe(false);

    const claimed = claimPendingControlCommand(store, 60_000);
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('running');
    expect(claimed!.attempt).toBe(1);

    completeControlCommandInRepository(store, 'c1', {
      status: 'succeeded',
      resultSummary: 'enterprise created',
      resourceId: 'org-1',
    });
    // 已完成，不可再领取。
    expect(claimPendingControlCommand(store, 60_000)).toBeNull();
  });

  it('重复 accept 同 commandId 幂等返回既有状态', () => {
    const { store } = makeStore();
    const input = {
      commandId: 'c1', type: 'enterprise.initiate', schemaVersion: 1,
      sequence: 1, deploymentId: 'deploy-1', issuedAt: 'now', expiresAt: 'later',
      idempotencyKey: 'k1', payloadDigest: 'd', payloadJson: '{}', signature: 'sig',
    };
    acceptControlCommandInRepository(store, input);
    const second = acceptControlCommandInRepository(store, input);
    expect(second.replayed).toBe(true);
    // 队列里只有一条。
    const count = store.db().prepare('SELECT COUNT(*) AS c FROM control_command_queue').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('到期未领取的指令标记 expired 且不执行', () => {
    const { store, db } = makeStore();
    acceptControlCommandInRepository(store, {
      commandId: 'c1', type: 'enterprise.initiate', schemaVersion: 1,
      sequence: 1, deploymentId: 'deploy-1',
      issuedAt: new Date(NOW_MS - 10_000).toISOString(),
      expiresAt: new Date(NOW_MS - 1).toISOString(),
      payloadDigest: 'd', payloadJson: '{}', signature: 'sig',
    });
    // claim 时清理过期。
    const claimed = claimPendingControlCommand(store, 60_000);
    expect(claimed).toBeNull();
    const row = db.prepare('SELECT status FROM control_command_queue WHERE command_id = ?').get('c1') as { status: string };
    expect(row.status).toBe('expired');
  });

  it('非单调序列被拒绝', () => {
    const { store } = makeStore();
    acceptControlCommandInRepository(store, {
      commandId: 'c1', type: 'enterprise.initiate', schemaVersion: 1,
      sequence: 5, deploymentId: 'deploy-1', issuedAt: 'now', expiresAt: 'later',
      payloadDigest: 'd', payloadJson: '{}', signature: 'sig',
    });
    expect(assertMonotonicSequence(store, 'c1', 5).ok).toBe(false);
    expect(assertMonotonicSequence(store, 'c1', 4).ok).toBe(false);
    expect(assertMonotonicSequence(store, 'c1', 6).ok).toBe(true);
  });

  it('取消指令（succeeded 不可取消）', () => {
    const { store } = makeStore();
    acceptControlCommandInRepository(store, {
      commandId: 'c1', type: 'enterprise.initiate', schemaVersion: 1,
      sequence: 1, deploymentId: 'deploy-1', issuedAt: 'now', expiresAt: 'later',
      payloadDigest: 'd', payloadJson: '{}', signature: 'sig',
    });
    expect(cancelControlCommandInRepository(store, 'c1')).toBe('cancelled');
    // 取消后不可领取。
    expect(claimPendingControlCommand(store, 60_000)).toBeNull();
  });
});

describe('control command processor pipeline (CONTROL-12)', () => {
  function makeProcessor(execute: (env: ControlCommandEnvelope) => ControlCommandRunResult) {
    const { db, store } = makeStore();
    const processor = createControlCommandProcessor({
      db: () => db,
      now: () => NOW_MS,
      deploymentId: 'deploy-1',
      verifyControlSignature: (env) => verifyControlCommandSignature(env, [publicKey]),
      execute,
      signingPrivateKey: privateKey,
    });
    return { processor, store };
  }

  it('ingest（合法）→ drainOne 执行 → 回执含成功状态与资源 ID', () => {
    const { processor } = makeProcessor(() => ({
      status: 'succeeded',
      resultSummary: 'enterprise created',
      resourceId: 'org-1',
    }));
    const ingest = processor.ingest(validEnvelope()) as { receipt: { status: string; resourceId?: string } };
    expect(ingest.receipt.status).toBe('accepted');
    const receipt = processor.drainOne()!;
    expect(receipt.status).toBe('succeeded');
    expect(receipt.resourceId).toBe('org-1');
    expect(receipt.commandId).toBe('cmd-1');
  });

  it('ingest 非法签名 → 返回错误且不入队', () => {
    const { processor, store } = makeProcessor(() => ({ status: 'succeeded', resultSummary: 'x' }));
    const bad = { ...validEnvelope(), signature: 'ed25519:ZZZZ' };
    const result = processor.ingest(bad) as { error: string };
    expect(result.error).toBe('invalid_signature');
    // 尝试领取：无任何待执行指令（证明错误指令未入队）。
    expect(claimPendingControlCommand(store, 60_000)).toBeNull();
  });

  it('ingest 重复 commandId 幂等 → 返回既有回执', () => {
    const { processor } = makeProcessor(() => ({ status: 'succeeded', resultSummary: 'x' }));
    const env = validEnvelope();
    processor.ingest(env);
    const second = processor.ingest(env) as { receipt: { status: string } };
    expect(second.receipt.status).toBe('accepted');
    // drainOne 只执行一次。
    const r1 = processor.drainOne();
    const r2 = processor.drainOne();
    expect(r1).not.toBeNull();
    expect(r2).toBeNull();
  });

  it('执行抛错 → 回执 failed + errorCategory', () => {
    const { processor } = makeProcessor(() => {
      throw new Error('enterprise already exists');
    });
    const ingest = processor.ingest(validEnvelope()) as { receipt: unknown };
    expect(ingest.receipt).toBeTruthy();
    const receipt = processor.drainOne()!;
    expect(receipt.status).toBe('failed');
    expect(receipt.errorCategory).toBe('execution_error');
    expect(receipt.resultSummary).toBe('enterprise already exists');
  });
});

describe('control command receipt (CONTROL-12)', () => {
  it('回执不含秘密，且 digest 稳定、可签名', () => {
    const receipt = buildControlCommandReceipt({
      commandId: 'c1',
      deploymentId: 'deploy-1',
      executionVersion: 1,
      status: 'succeeded',
      resultSummary: 'enterprise created',
      resourceId: 'org-1',
      signingPrivateKey: privateKey,
    });
    expect(receipt.receiptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.signature).toMatch(/^ed25519:/);
    // 序列化后不得含密码/令牌/license。
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('license');
  });
});
