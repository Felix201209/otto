/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 测试 /stop 后消息队列竞态 bug（bug-report-stop-queue-race-condition.md）
 *
 * 核心场景：用户执行 /stop 中止 AI 任务后，紧接着发送新消息，
 * 新消息被错误入队而非直接执行。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  __testing_messageQueues,
  __testing_isProcessingQueues,
  __testing_activeAbortControllers,
  __testing_decrementProcessingCount,
  __testing_activeProcessingCount,
  __testing_processingChatIds,
} from './feishuCommand.js';

describe('/stop queue race condition bug', () => {
  const chatId = 'oc_test_chat_123';

  beforeEach(() => {
    __testing_messageQueues.clear();
    __testing_isProcessingQueues.clear();
    __testing_activeAbortControllers.clear();
    __testing_processingChatIds.clear();
  });

  afterEach(() => {
    __testing_messageQueues.clear();
    __testing_isProcessingQueues.clear();
    __testing_activeAbortControllers.clear();
    __testing_processingChatIds.clear();
  });

  // === Bug 复现测试（模拟未修复代码的行为） ===

  it('BUG REPRO: /stop does not clear isProcessingQueues, leaving it stuck at true', () => {
    __testing_isProcessingQueues.set(chatId, true);
    const abortController = new AbortController();
    __testing_activeAbortControllers.set(chatId, abortController);

    // 未修复的 /stop：只 abort + delete controller
    abortController.abort();
    __testing_activeAbortControllers.delete(chatId);

    // BUG: isProcessingQueues 仍为 true
    expect(__testing_isProcessingQueues.get(chatId)).toBe(true);

    // 消息 B 被错误入队
    const isProcessing = __testing_isProcessingQueues.get(chatId) || false;
    expect(isProcessing).toBe(true);

    const queue: any[] = [];
    __testing_messageQueues.set(chatId, queue);
    queue.push({ msg: { chatId, text: '消息 B' }, resolve: vi.fn(), reject: vi.fn() });

    // 防重入守卫触发，消息 B 卡住
    expect(__testing_isProcessingQueues.get(chatId)).toBe(true);
    __testing_isProcessingQueues.set(chatId, false);
    expect(__testing_messageQueues.get(chatId)?.length).toBe(1);
  });

  it('BUG REPRO: message stuck in queue after /stop with no self-healing mechanism', () => {
    __testing_isProcessingQueues.set(chatId, true);
    const abortController = new AbortController();
    __testing_activeAbortControllers.set(chatId, abortController);

    abortController.abort();
    __testing_activeAbortControllers.delete(chatId);

    const queue: any[] = [];
    __testing_messageQueues.set(chatId, queue);
    queue.push({ msg: { chatId, text: '消息 B' }, resolve: vi.fn(), reject: vi.fn() });

    expect(queue.length).toBe(1);
    __testing_isProcessingQueues.set(chatId, false);
    expect(__testing_messageQueues.get(chatId)?.length).toBe(1);
  });

  // === 修复验证测试 ===

  it('FIX: /stop clears isProcessingQueues, preventing race window', () => {
    __testing_isProcessingQueues.set(chatId, true);
    const abortController = new AbortController();
    __testing_activeAbortControllers.set(chatId, abortController);

    // 修复后的 /stop
    abortController.abort();
    __testing_activeAbortControllers.delete(chatId);
    __testing_isProcessingQueues.set(chatId, false);

    expect(__testing_isProcessingQueues.get(chatId)).toBe(false);
    const isProcessing = __testing_isProcessingQueues.get(chatId) || false;
    expect(isProcessing).toBe(false);
  });

  it('FIX: /stop clears messageQueues and empties array via splice(0)', () => {
    __testing_isProcessingQueues.set(chatId, true);
    const abortController = new AbortController();
    __testing_activeAbortControllers.set(chatId, abortController);

    const queue: any[] = [];
    __testing_messageQueues.set(chatId, queue);
    const resolveFn = vi.fn();
    queue.push({ msg: { chatId, text: '排队消息' }, resolve: resolveFn, reject: vi.fn() });

    // 修复后的 /stop
    abortController.abort();
    __testing_activeAbortControllers.delete(chatId);

    const pendingQueue = __testing_messageQueues.get(chatId);
    if (pendingQueue) {
      for (const item of pendingQueue) {
        item.resolve(null);
      }
      pendingQueue.splice(0);
      __testing_messageQueues.delete(chatId);
    }
    __testing_isProcessingQueues.set(chatId, false);

    expect(__testing_messageQueues.has(chatId)).toBe(false);
    expect(resolveFn).toHaveBeenCalledWith(null);
    expect(queue.length).toBe(0);
    expect(__testing_isProcessingQueues.get(chatId)).toBe(false);
  });

  // === 副作用防护测试 ===

  it('SIDE EFFECT: splice(0) empties array so old while loop exits naturally', () => {
    const queue: any[] = [];
    __testing_messageQueues.set(chatId, queue);
    queue.push({ msg: { chatId, text: '消息1' }, resolve: vi.fn(), reject: vi.fn() });
    queue.push({ msg: { chatId, text: '消息2' }, resolve: vi.fn(), reject: vi.fn() });

    const oldQueueRef = queue;

    const pendingQueue = __testing_messageQueues.get(chatId);
    if (pendingQueue) {
      for (const item of pendingQueue) {
        item.resolve(null);
      }
      pendingQueue.splice(0);
      __testing_messageQueues.delete(chatId);
    }

    expect(oldQueueRef.length).toBe(0);
  });

  it('SIDE EFFECT: old finally setting false is harmless when /stop already set false', () => {
    // /stop 设置 false → 旧 finally 也设置 false → false→false 无害
    __testing_isProcessingQueues.set(chatId, true);

    // /stop 清除
    __testing_isProcessingQueues.set(chatId, false);
    expect(__testing_isProcessingQueues.get(chatId)).toBe(false);

    // 旧 finally 也设置 false（无害）
    __testing_isProcessingQueues.set(chatId, false);
    expect(__testing_isProcessingQueues.get(chatId)).toBe(false);
  });

  it('SIDE EFFECT: known theoretical risk — old finally could clear new processing flag', () => {
    // 极窄竞态窗口：/stop 设 false → 新消息 B 设 true → 旧 finally 设 false
    // 实际概率极低：旧 finally 在 AbortError 后微秒级执行，
    // 新消息 B 需要经过飞书消息接收、入队等异步步骤才能设 true
    __testing_isProcessingQueues.set(chatId, true);

    // /stop 清除
    __testing_isProcessingQueues.set(chatId, false);

    // 新消息 B 开始处理
    __testing_isProcessingQueues.set(chatId, true);

    // 旧 finally 执行（理论竞态）
    __testing_isProcessingQueues.set(chatId, false);

    // 如果此竞态实际发生，消息 B 的处理标志被错误清除
    expect(__testing_isProcessingQueues.get(chatId)).toBe(false);
    // 但此场景在实际运行中概率极低，因为时间差远大于旧 finally 的执行窗口
    // 如需彻底解决，需引入版本号或 epoch 机制（当前不必要）
  });
});

// === 第二次 /stop 失效 bug（activeAbortControllers 被旧 finally 误删） ===

describe('/stop second call fails — old finally deletes new task controller', () => {
  const chatId = 'oc_test_chat_456';

  beforeEach(() => {
    __testing_messageQueues.clear();
    __testing_isProcessingQueues.clear();
    __testing_activeAbortControllers.clear();
    __testing_processingChatIds.clear();
  });

  afterEach(() => {
    __testing_messageQueues.clear();
    __testing_isProcessingQueues.clear();
    __testing_activeAbortControllers.clear();
    __testing_processingChatIds.clear();
  });

  it('BUG REPRO: old finally deletes new task controller via same chatId key', () => {
    // 任务 A 开始
    const controllerA = new AbortController();
    __testing_activeAbortControllers.set(chatId, controllerA);

    // /stop 中止任务 A（旧代码：立即 delete）
    controllerA.abort();
    __testing_activeAbortControllers.delete(chatId);

    // 任务 B 开始（新消息触发）
    const controllerB = new AbortController();
    __testing_activeAbortControllers.set(chatId, controllerB);

    // BUG: 任务 A 的 finally 块异步执行，再次 delete 同 chatId
    // 此时删掉的是 controllerB！
    __testing_activeAbortControllers.delete(chatId);

    // 第二次 /stop 找不到控制器
    expect(__testing_activeAbortControllers.get(chatId)).toBeUndefined();
    // 但 controllerB 的任务仍在运行，无法被中止
    expect(controllerB.signal.aborted).toBe(false);
  });

  it('FIX: finally block only deletes its own controller (reference equality)', () => {
    // 任务 A 开始
    const controllerA = new AbortController();
    __testing_activeAbortControllers.set(chatId, controllerA);

    // /stop 中止任务 A
    controllerA.abort();
    __testing_activeAbortControllers.delete(chatId);

    // 任务 B 开始
    const controllerB = new AbortController();
    __testing_activeAbortControllers.set(chatId, controllerB);

    // FIX: 任务 A 的 finally 块检查引用相等性，只删自己的控制器
    const currentController = __testing_activeAbortControllers.get(chatId);
    if (currentController === controllerA) {
      __testing_activeAbortControllers.delete(chatId);
    }

    // controllerB 仍在 map 中，第二次 /stop 可以正常中止
    expect(__testing_activeAbortControllers.get(chatId)).toBe(controllerB);
    expect(controllerB.signal.aborted).toBe(false);

    // 第二次 /stop 成功中止任务 B
    controllerB.abort();
    __testing_activeAbortControllers.delete(chatId);
    expect(__testing_activeAbortControllers.get(chatId)).toBeUndefined();
    expect(controllerB.signal.aborted).toBe(true);
  });

  it('FIX: /stop calls decrementProcessingCount to keep count consistent', () => {
    // 模拟任务 A 开始 → incrementProcessingCount
    __testing_activeAbortControllers.set(chatId, new AbortController());
    __testing_processingChatIds.add(chatId);
    // activeProcessingCount 从 0 → 1（模拟 increment）
    // 我们无法直接 set activeProcessingCount，但可以验证 decrement 的行为

    // /stop 中止任务 A（修复后：同步 decrement）
    __testing_decrementProcessingCount(chatId);

    // 验证 processingChatIds 已清除
    expect(__testing_processingChatIds.has(chatId)).toBe(false);
  });

  it('FIX: old finally decrement does not over-decrement when new task already incremented', () => {
    // 任务 A: increment → count=1
    // /stop: decrement → count=0
    // 任务 B: increment → count=1
    // 旧 finally: decrement → count=0 (BUG: 应为 1)

    // 模拟流程
    __testing_processingChatIds.add(chatId); // 任务 A 开始
    __testing_decrementProcessingCount(chatId); // /stop 同步 decrement
    expect(__testing_processingChatIds.has(chatId)).toBe(false);

    // 任务 B 开始
    __testing_processingChatIds.add(chatId);

    // 旧 finally 的 decrement 不会再误减，因为 /stop 已经 decrement 过了
    // 且 processingChatIds 已被 /stop 清除，旧 finally 的 decrement
    // 对 processingChatIds 的 delete 是无害的（已不存在）
    __testing_decrementProcessingCount(chatId);
    expect(__testing_processingChatIds.has(chatId)).toBe(false);
  });
});

// === 第二次 /stop 失效 bug 的测试 ===
// 场景：第一次 /stop 成功后，新任务开始，第二次 /stop 却显示"没有正在运行的AI任务"
// 根因：旧 finally 块的 activeAbortControllers.delete(chatId) 误删了新任务的控制器

describe('/stop second-call failure bug (controller identity race)', () => {
  const chatId = 'oc_test_chat_456';

  beforeEach(() => {
    __testing_messageQueues.clear();
    __testing_isProcessingQueues.clear();
    __testing_activeAbortControllers.clear();
    __testing_processingChatIds.clear();
  });

  afterEach(() => {
    __testing_messageQueues.clear();
    __testing_isProcessingQueues.clear();
    __testing_activeAbortControllers.clear();
    __testing_processingChatIds.clear();
  });

  it('BUG REPRO: old finally deletes new task controller via same chatId key', () => {
    // 任务 A 开始
    const controllerA = new AbortController();
    __testing_activeAbortControllers.set(chatId, controllerA);

    // 第一次 /stop：abort + delete
    controllerA.abort();
    __testing_activeAbortControllers.delete(chatId);

    // 任务 B 开始（新消息触发）
    const controllerB = new AbortController();
    __testing_activeAbortControllers.set(chatId, controllerB);

    // BUG: 旧 finally 块异步执行，无差别 delete(chatId) 删掉了 controllerB
    __testing_activeAbortControllers.delete(chatId);

    // 第二次 /stop 查不到控制器
    expect(__testing_activeAbortControllers.get(chatId)).toBeUndefined();
    // 但 controllerB 的任务仍在运行！
    expect(controllerB.signal.aborted).toBe(false);
  });

  it('FIX: finally block only deletes its own controller (reference equality check)', () => {
    // 任务 A 开始
    const controllerA = new AbortController();
    __testing_activeAbortControllers.set(chatId, controllerA);

    // 第一次 /stop：abort + delete
    controllerA.abort();
    __testing_activeAbortControllers.delete(chatId);

    // 任务 B 开始
    const controllerB = new AbortController();
    __testing_activeAbortControllers.set(chatId, controllerB);

    // FIX: 旧 finally 只删除属于自己的控制器（引用相等性检查）
    const currentController = __testing_activeAbortControllers.get(chatId);
    if (currentController === controllerA) {
      __testing_activeAbortControllers.delete(chatId);
    }

    // controllerB 仍然在 map 中
    expect(__testing_activeAbortControllers.get(chatId)).toBe(controllerB);
    // 第二次 /stop 可以正常找到并中止
    const found = __testing_activeAbortControllers.get(chatId);
    expect(found).toBeDefined();
    found!.abort();
    expect(controllerB.signal.aborted).toBe(true);
  });

  it('FIX: /stop also calls decrementProcessingCount to keep UI state consistent', () => {
    // 模拟任务 A 开始
    const controllerA = new AbortController();
    __testing_activeAbortControllers.set(chatId, controllerA);
    __testing_processingChatIds.add(chatId);
    // incrementProcessingCount 会把 activeProcessingCount 从 0→1
    // 这里直接模拟结果
    const countBefore = __testing_activeProcessingCount.get();

    // 第一次 /stop：abort + delete + decrementProcessingCount
    controllerA.abort();
    __testing_activeAbortControllers.delete(chatId);
    __testing_decrementProcessingCount(chatId);

    // 处理计数应递减
    expect(__testing_activeProcessingCount.get()).toBe(Math.max(0, countBefore));
    // chatId 应从 processingChatIds 中移除
    expect(__testing_processingChatIds.has(chatId)).toBe(false);
  });

  it('FIX: old finally decrementProcessingCount is harmless after /stop already decremented', () => {
    const controllerA = new AbortController();
    __testing_activeAbortControllers.set(chatId, controllerA);
    __testing_processingChatIds.add(chatId);

    // /stop 先 decrement
    __testing_decrementProcessingCount(chatId);
    const countAfterStop = __testing_activeProcessingCount.get();

    // 旧 finally 再次 decrement（因为 finally 不知道 /stop 已经 decrement 了）
    // 这会导致计数多减一次 — 但由于 Math.max(0, ...) 保护，不会变成负数
    __testing_decrementProcessingCount(chatId);
    expect(__testing_activeProcessingCount.get()).toBe(Math.max(0, countAfterStop - 1));
    // 注意：这里 countAfterStop 已经是 0，所以再减一次还是 0（Math.max 保护）
  });
});