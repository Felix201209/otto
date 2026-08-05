/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-12 —— 传输/恢复层测试：事务性 outbox、receipt 查询、调度器。
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Database } from '../data_platform/index.js';
import {
  acceptControlCommandInRepository,
  completeControlCommandInRepository,
  enqueueOutboxInRepository,
  claimReadyOutboxRows,
  completeOutboxInRepository,
  failOutboxDeliveryInRepository,
  recoverInFlightOutboxRows,
  summarizeOutboxInRepository,
  queryControlCommandReceipt,
  createControlCommandScheduler,
  type ControlCommandQueueStore,
  type ControlCommandOutboxStore,
} from './index.js';

const NOW_MS = 1_700_000_000_000;
const { privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function makeStores(): {
  db: Database;
  queue: ControlCommandQueueStore;
  outbox: ControlCommandOutboxStore;
} {
  const db = new Database(':memory:');
  return {
    db,
    queue: { db: () => db, now: () => NOW_MS },
    outbox: { db: () => db },
  };
}

function enqueueCommand(store: ControlCommandQueueStore, commandId = 'cmd-1'): void {
  acceptControlCommandInRepository(store, {
    commandId,
    type: 'enterprise.initiate',
    schemaVersion: 1,
    sequence: 1,
    deploymentId: 'dep-1',
    issuedAt: new Date(NOW_MS - 1000).toISOString(),
    expiresAt: new Date(NOW_MS + 60_000).toISOString(),
    idempotencyKey: 'ik-1',
    payloadDigest: 'digest',
    signature: 'sig',
  });
}

describe('control command outbox (CONTROL-12)', () => {
  it('enqueue 幂等：同 commandId 不重复', () => {
    const { outbox } = makeStores();
    expect(enqueueOutboxInRepository(outbox, 'a', NOW_MS)).toBe(true);
    expect(enqueueOutboxInRepository(outbox, 'a', NOW_MS)).toBe(false);
  });

  it('claim → complete 状态推进 pending→delivering→delivered', () => {
    const { outbox } = makeStores();
    enqueueOutboxInRepository(outbox, 'a', NOW_MS);
    const claimed = claimReadyOutboxRows(outbox, NOW_MS, 10, 5);
    expect(claimed.claimed).toBe(1);
    expect(claimed.rows[0].state).toBe('delivering');
    expect(completeOutboxInRepository(outbox, 'a', NOW_MS)).toBe(true);
    expect(summarizeOutboxInRepository(outbox).delivered).toBe(1);
  });

  it('多实例独占：同一条只有一次 claim 成功', () => {
    const { outbox } = makeStores();
    enqueueOutboxInRepository(outbox, 'a', NOW_MS);
    const a = claimReadyOutboxRows(outbox, NOW_MS, 10, 5);
    const b = claimReadyOutboxRows(outbox, NOW_MS, 10, 5);
    expect(a.claimed).toBe(1);
    // 第二条已被标 delivering，不再可见
    expect(b.claimed).toBe(0);
  });

  it('不会重新领取已经达到重试上限的异常 pending 条目', () => {
    const { db, outbox } = makeStores();
    enqueueOutboxInRepository(outbox, 'a', NOW_MS);
    db.prepare(
      'UPDATE control_command_outbox SET delivery_attempts = ? WHERE command_id = ?',
    ).run(5, 'a');
    expect(claimReadyOutboxRows(outbox, NOW_MS, 10, 5).claimed).toBe(0);
  });

  it('失败按指数退避延后，超限走死信', () => {
    const { outbox } = makeStores();
    enqueueOutboxInRepository(outbox, 'a', NOW_MS);
    // 第 1 次：attempt 1, pending, next = +1000
    claimReadyOutboxRows(outbox, NOW_MS, 10, 3);
    failOutboxDeliveryInRepository(outbox, 'a', NOW_MS, 3, 1000);
    expect(summarizeOutboxInRepository(outbox).pending).toBe(1);
    // 退避未到点 → 不可见
    expect(claimReadyOutboxRows(outbox, NOW_MS + 100, 10, 3).claimed).toBe(0);
    // 到点 → 可见，第 2 次 attempt=2, next = +2000
    expect(claimReadyOutboxRows(outbox, NOW_MS + 2000, 10, 3).claimed).toBe(1);
    failOutboxDeliveryInRepository(outbox, 'a', NOW_MS + 2000, 3, 1000);
    expect(summarizeOutboxInRepository(outbox).pending).toBe(1);
    // 到点 → 第 3 次 attempt=3 达上限 → dead
    expect(claimReadyOutboxRows(outbox, NOW_MS + 6000, 10, 3).claimed).toBe(1);
    failOutboxDeliveryInRepository(outbox, 'a', NOW_MS + 6000, 3, 1000);
    expect(summarizeOutboxInRepository(outbox).dead).toBe(1);
  });

  it('崩溃恢复：stuck delivering 拉回 pending', () => {
    const { outbox } = makeStores();
    enqueueOutboxInRepository(outbox, 'a', NOW_MS);
    claimReadyOutboxRows(outbox, NOW_MS, 10, 5);
    expect(summarizeOutboxInRepository(outbox).delivering).toBe(1);
    const recovered = recoverInFlightOutboxRows(outbox, NOW_MS + 120_000, 60_000);
    expect(recovered).toEqual(['a']);
    expect(summarizeOutboxInRepository(outbox).pending).toBe(1);
  });
});

describe('control command receipt query (CONTROL-12)', () => {
  it('未到达终态返回 null（accepted 不可查）', () => {
    const { queue } = makeStores();
    enqueueCommand(queue);
    expect(queryControlCommandReceipt(queue, 'cmd-1')).toBeNull();
  });

  it('终态（succeeded）返回无秘密签名回执', () => {
    const { queue } = makeStores();
    enqueueCommand(queue);
    completeControlCommandInRepository(queue, 'cmd-1', {
      status: 'succeeded',
      resultSummary: 'enterprise created',
      resourceId: 'ent-1',
    });
    const receipt = queryControlCommandReceipt(queue, 'cmd-1', privateKey);
    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe('succeeded');
    expect(receipt!.resourceId).toBe('ent-1');
    expect(receipt!.signature).toBeTruthy();
    // 无秘密：绝不包含 payload / 密码 / 令牌
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('secret');
  });

  it('failed 终态同样可查（带错误分类）', () => {
    const { queue } = makeStores();
    enqueueCommand(queue);
    completeControlCommandInRepository(queue, 'cmd-1', {
      status: 'failed',
      resultSummary: 'boom',
      errorCategory: 'execution_error',
    });
    const receipt = queryControlCommandReceipt(queue, 'cmd-1');
    expect(receipt!.status).toBe('failed');
    expect(receipt!.errorCategory).toBe('execution_error');
  });

  it('未知 commandId 返回 null', () => {
    const { queue } = makeStores();
    expect(queryControlCommandReceipt(queue, 'nope')).toBeNull();
  });
});

describe('control command scheduler (CONTROL-12)', () => {
  it('drain 领取并执行，写入终态 + 投递回执到 outbox', () => {
    const { queue, outbox } = makeStores();
    enqueueCommand(queue);
    const scheduler = createControlCommandScheduler({
      queue,
      outbox,
      now: () => NOW_MS,
      execute: () => ({
        status: 'succeeded',
        resultSummary: 'ok',
        resourceId: 'ent-1',
      }),
      signingPrivateKey: privateKey,
    });
    expect(scheduler.drainOnce().executed).toBe(true);
    // 队列终态
    const receipt = queryControlCommandReceipt(queue, 'cmd-1');
    expect(receipt!.status).toBe('succeeded');
    // outbox 有待投递条目
    expect(summarizeOutboxInRepository(outbox).pending).toBe(1);
  });

  it('执行抛错 → failed 终态，仍投递回执', () => {
    const { queue, outbox } = makeStores();
    enqueueCommand(queue);
    const scheduler = createControlCommandScheduler({
      queue,
      outbox,
      now: () => NOW_MS,
      execute: () => {
        throw new Error('boom');
      },
    });
    scheduler.drainOnce();
    const receipt = queryControlCommandReceipt(queue, 'cmd-1');
    expect(receipt!.status).toBe('failed');
    expect(receipt!.errorCategory).toBe('execution_error');
  });

  it('无待执行指令 → drain 返回 executed=false', () => {
    const { queue, outbox } = makeStores();
    const scheduler = createControlCommandScheduler({
      queue,
      outbox,
      now: () => NOW_MS,
      execute: () => ({ status: 'succeeded', resultSummary: 'x' }),
    });
    expect(scheduler.drainOnce().executed).toBe(false);
  });

  it('flushOutbox 投递成功 → delivered；投递失败 → 退避', () => {
    const { queue, outbox } = makeStores();
    enqueueCommand(queue);
    const scheduler = createControlCommandScheduler({
      queue,
      outbox,
      now: () => NOW_MS,
      execute: () => ({ status: 'succeeded', resultSummary: 'ok' }),
      deliver: () => true,
    });
    scheduler.drainOnce();
    let r = scheduler.flushOutbox(NOW_MS);
    expect(r.delivered).toBe(1);
    expect(summarizeOutboxInRepository(outbox).delivered).toBe(1);

    // 再一次 drain+flush，模拟另一条失败路径
    enqueueCommand(queue, 'cmd-2');
    const s2 = createControlCommandScheduler({
      queue,
      outbox,
      now: () => NOW_MS,
      execute: () => ({ status: 'succeeded', resultSummary: 'ok' }),
      deliver: () => false,
    });
    s2.drainOnce();
    r = s2.flushOutbox(NOW_MS);
    expect(r.delivered).toBe(0);
    expect(summarizeOutboxInRepository(outbox).pending).toBe(1);
  });

  it('exclusive claim：第二条不该再被执行', () => {
    const { queue, outbox } = makeStores();
    enqueueCommand(queue);
    let runs = 0;
    const scheduler = createControlCommandScheduler({
      queue,
      outbox,
      now: () => NOW_MS,
      execute: () => {
        runs += 1;
        return { status: 'succeeded', resultSummary: 'ok' };
      },
    });
    scheduler.drainOnce();
    // 已终态，再次 drain 应无动作
    scheduler.drainOnce();
    expect(runs).toBe(1);
  });
});
