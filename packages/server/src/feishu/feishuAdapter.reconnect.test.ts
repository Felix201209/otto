/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书 adapter 守护循环（断线重连 / 心跳僵尸探测 / 状态可见）单测。
 *
 * 全程 fake timers + 注入 fake gateway（gatewayFactory 接缝），验证契约：
 *   1. 断开后按指数退避重连（1s 起步、抖动可控），最终成功并归零退避；
 *   2. stop()（有意停止）后绝不再自动重连，无幽灵定时器泄漏；
 *   3. 初次 connect 失败（server 启动时断网）也进同一重连循环，网络恢复自愈；
 *   4. 重连成功后退避计数归零：下次断线从 1s 重新起步；
 *   5. 连接锁被另一进程持有 → 状态诚实上报持有者 pid，且持续重试可接管；
 *   6. 僵尸连接（自认为连着、底层 socket 已死）→ 心跳连续两拍探到后强制重连；
 *   7. SDK 内部自愈事件（onReconnecting/onReconnected）如实反映到状态。
 *
 * Math.random 固定为 0.5 → 抖动系数 0.8+0.5*0.4 = 1.0，退避序列精确为
 * 1s, 2s, 4s, ...，用例里的时间推进不需要容差。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FeishuAdapter, type FeishuGatewayLike } from './feishuAdapter.js';
import { FeishuGatewayLockError } from './vendor/gateway.js';
import type { FeishuCredentials } from './vendor/credentials.js';
import { InMemorySessionStore } from '../sessions.js';

const CREDS: FeishuCredentials = {
  appId: 'cli_app',
  appSecret: 'secret',
  domain: 'feishu',
  ownerOpenId: 'ou_owner',
  allowlist: [],
};

/** 可编程 fake gateway：控制 connect 成败序列、记录 disconnect、可注入健康快照。 */
interface FakeGw {
  gw: FeishuGatewayLike;
  connectCalls: () => number;
  disconnectCalls: () => number;
  /** 队列头非 null 时下一次 connect 抛该错误；空队列 = 成功（同步 fire onReady）。 */
  failWith: (errors: Array<Error | null>) => void;
  fireDisconnect: (e?: Error) => void;
  fireReconnecting: () => void;
  fireReconnected: () => void;
  setHealth: (h: { hasClient: boolean; socketOpen: boolean | null } | null) => void;
}

function makeFakeGateway(): FakeGw {
  let onReady: (() => void) | null = null;
  let onDisconnect: ((e?: Error) => void) | null = null;
  let onReconnecting: (() => void) | null = null;
  let onReconnected: (() => void) | null = null;
  let connects = 0;
  let disconnects = 0;
  let failQueue: Array<Error | null> = [];
  let health: { hasClient: boolean; socketOpen: boolean | null } | null = {
    hasClient: true,
    socketOpen: true,
  };

  const gw: FeishuGatewayLike = {
    onMessage: null,
    get onReady() {
      return onReady;
    },
    set onReady(fn) {
      onReady = fn;
    },
    get onDisconnect() {
      return onDisconnect;
    },
    set onDisconnect(fn) {
      onDisconnect = fn ?? null;
    },
    get onReconnecting() {
      return onReconnecting;
    },
    set onReconnecting(fn) {
      onReconnecting = fn ?? null;
    },
    get onReconnected() {
      return onReconnected;
    },
    set onReconnected(fn) {
      onReconnected = fn ?? null;
    },
    async connect() {
      connects += 1;
      const next = failQueue.shift();
      if (next) throw next;
      // 对齐真 gateway：onReady 在 connect resolve 前同步触发。
      onReady?.();
    },
    async disconnect() {
      disconnects += 1;
    },
    getConnectionHealth() {
      return health ?? { hasClient: true, socketOpen: null };
    },
    async sendStreamingCardWithFooter() {
      return {
        messageId: 'om_x',
        pushContent: async () => true,
        finalize: async () => true,
      };
    },
    async sendMarkdown() {
      return 'om_md';
    },
  };

  return {
    gw,
    connectCalls: () => connects,
    disconnectCalls: () => disconnects,
    failWith: (errors) => {
      failQueue = [...errors];
    },
    fireDisconnect: (e) => onDisconnect?.(e),
    fireReconnecting: () => onReconnecting?.(),
    fireReconnected: () => onReconnected?.(),
    setHealth: (h) => {
      health = h;
    },
  };
}

/** 推平 start()/attemptConnect 内部的微任务链（不动定时器）。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('FeishuAdapter 守护循环（断线重连 + 心跳）', () => {
  let store: InMemorySessionStore;
  let fake: FakeGw;
  let adapter: FeishuAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 抖动系数=1.0，退避精确可算
    store = new InMemorySessionStore();
    fake = makeFakeGateway();
    adapter = new FeishuAdapter({
      store,
      broadcast: (sessionId, frame) => store.publish(sessionId, frame),
      credentials: CREDS,
      gatewayFactory: () => fake.gw,
    });
  });

  afterEach(async () => {
    await adapter.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('断开后按退避重连（1s→2s），最终成功并恢复已连接', async () => {
    await adapter.start();
    await flushMicrotasks();
    expect(adapter.isConnected()).toBe(true);
    expect(fake.connectCalls()).toBe(1);

    // 掉线：接下来两次重连失败，第三次成功。
    fake.failWith([new Error('网络不可达'), new Error('网络不可达')]);
    fake.fireDisconnect(new Error('WS closed'));
    expect(adapter.isConnected()).toBe(false);
    const s1 = adapter.getStatus();
    expect(s1.reconnecting).toBe(true);
    expect(s1.reconnectAttempts).toBe(1);
    expect(s1.lastDisconnectReason).toContain('WS closed');
    // 第 1 次重试：1s 后。
    expect(s1.nextRetryAt).toBe(Date.now() + 1_000);

    await vi.advanceTimersByTimeAsync(1_000); // 第 1 次重试 → 失败
    expect(fake.connectCalls()).toBe(2);
    expect(adapter.getStatus().reconnectAttempts).toBe(2);

    await vi.advanceTimersByTimeAsync(2_000); // 第 2 次重试（退避 2s）→ 失败
    expect(fake.connectCalls()).toBe(3);

    await vi.advanceTimersByTimeAsync(4_000); // 第 3 次重试（退避 4s）→ 成功
    expect(fake.connectCalls()).toBe(4);
    expect(adapter.isConnected()).toBe(true);
    // 成功 → 退避/状态归零。
    const s2 = adapter.getStatus();
    expect(s2.reconnectAttempts).toBe(0);
    expect(s2.nextRetryAt).toBeNull();
    expect(s2.reconnecting).toBe(false);
    expect(s2.lastConnectedAt).toBe(Date.now());
  });

  it('stop()（有意停止）后绝不自动重连，无幽灵定时器', async () => {
    await adapter.start();
    await flushMicrotasks();
    expect(adapter.isConnected()).toBe(true);

    // 掉线进入重连排程，然后用户主动 stop。
    fake.failWith([new Error('x')]);
    fake.fireDisconnect(new Error('WS closed'));
    expect(adapter.getStatus().reconnecting).toBe(true);

    await adapter.stop();
    const before = fake.connectCalls();
    // 推进 30 分钟：重连排程、心跳全部不得再触发任何建连。
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fake.connectCalls()).toBe(before);
    expect(vi.getTimerCount()).toBe(0); // 定时器全部清干净，无泄漏
    const s = adapter.getStatus();
    expect(s.running).toBe(false);
    expect(s.connected).toBe(false);
    expect(s.reconnecting).toBe(false);
  });

  it('初次 connect 失败（启动时断网）→ 进重连循环，网络恢复后自己连上', async () => {
    fake.failWith([new Error('启动断网'), new Error('还没恢复')]);
    await adapter.start();
    await flushMicrotasks();
    expect(adapter.isConnected()).toBe(false);
    expect(fake.connectCalls()).toBe(1);
    const s = adapter.getStatus();
    expect(s.reconnecting).toBe(true);
    expect(s.reconnectAttempts).toBe(1);
    expect(s.lastDisconnectReason).toContain('启动断网');

    await vi.advanceTimersByTimeAsync(1_000); // 重试 1 → 仍失败
    expect(fake.connectCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000); // 重试 2 → 成功（网络恢复）
    expect(fake.connectCalls()).toBe(3);
    expect(adapter.isConnected()).toBe(true);
    expect(adapter.getStatus().reconnectAttempts).toBe(0);
  });

  it('重连成功后退避归零：下次断线从 1s 重新起步', async () => {
    // 先制造一轮多次失败的重连（退避已抬升），再成功。
    fake.failWith([new Error('a'), new Error('b'), new Error('c')]);
    await adapter.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000); // 3 次重试后成功
    expect(adapter.isConnected()).toBe(true);

    // 再次掉线：第 1 次重试应回到 1s（而非沿用抬升后的退避）。
    fake.fireDisconnect(new Error('again'));
    const s = adapter.getStatus();
    expect(s.reconnectAttempts).toBe(1);
    expect(s.nextRetryAt).toBe(Date.now() + 1_000);
  });

  it('连接锁被另一进程持有 → 诚实上报持有者 pid，持续重试可接管', async () => {
    fake.failWith([new FeishuGatewayLockError('另一进程持有', 4242)]);
    await adapter.start();
    await flushMicrotasks();

    const s = adapter.getStatus();
    expect(s.connected).toBe(false); // 绝不谎报已连接
    expect(s.lockHeldByOtherPid).toBe(4242);
    expect(s.reconnecting).toBe(true);
    expect(s.lastDisconnectReason).toContain('4242');

    // 对方进程退出（锁可拿了）→ 下一次重试接管成功。
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.isConnected()).toBe(true);
    expect(adapter.getStatus().lockHeldByOtherPid).toBeNull();
  });

  it('僵尸连接：心跳连续两拍探到 socket 已死 → 强制收尾并重连', async () => {
    await adapter.start();
    await flushMicrotasks();
    expect(adapter.isConnected()).toBe(true);
    const disconnectsBefore = fake.disconnectCalls();

    // 底层 socket 悄悄死了，但没有任何回调触发（僵尸态）。
    fake.setHealth({ hasClient: true, socketOpen: false });

    await vi.advanceTimersByTimeAsync(60_000); // 第 1 拍：记 strike，不动手
    expect(adapter.isConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000); // 第 2 拍：强制重连
    await flushMicrotasks();
    expect(fake.disconnectCalls()).toBe(disconnectsBefore + 1); // 旧连接被干净收尾
    expect(adapter.getStatus().lastDisconnectReason).toContain('僵尸');

    // 恢复健康探测返回，让重连成功闭环。
    fake.setHealth({ hasClient: true, socketOpen: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.isConnected()).toBe(true);
  });

  it('SDK 内部自愈事件如实反映：onReconnecting → 未连接；onReconnected → 恢复', async () => {
    await adapter.start();
    await flushMicrotasks();
    expect(adapter.isConnected()).toBe(true);

    fake.fireReconnecting();
    const s1 = adapter.getStatus();
    expect(s1.connected).toBe(false);
    expect(s1.reconnecting).toBe(true);
    expect(s1.lastDisconnectReason).toContain('SDK 内部重连');

    fake.fireReconnected();
    const s2 = adapter.getStatus();
    expect(s2.connected).toBe(true);
    expect(s2.reconnecting).toBe(false);
    expect(s2.reconnectAttempts).toBe(0);
  });
});
