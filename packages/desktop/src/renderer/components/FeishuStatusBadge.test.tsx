/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书状态徽标的状态映射单测（纯函数 deriveFeishuBadgeState）。
 *
 * 徽标的诚实性契约：锁被别的进程持有时显示「另一进程持有」而非已连接；
 * 重连中显示第 N 次与下次重试倒计时；未配置/未启用一律「未配置」。
 */

import { describe, it, expect } from 'vitest';
import {
  deriveFeishuBadgeState,
  type FeishuStatusResult,
} from './FeishuStatusBadge.js';

/** 构造一份守护状态（默认已连接），按需覆盖。 */
function res(
  over: Partial<NonNullable<FeishuStatusResult['feishu']>['status']> = {},
  feishuOver: Partial<FeishuStatusResult['feishu']> = {},
): FeishuStatusResult {
  return {
    text: 'x',
    running: true,
    feishu: {
      enabled: true,
      connected: true,
      status: {
        configured: true,
        running: true,
        connected: true,
        reconnecting: false,
        lastConnectedAt: null,
        lastDisconnectAt: null,
        lastDisconnectReason: null,
        reconnectAttempts: 0,
        nextRetryAt: null,
        lockHeldByOtherPid: null,
        ...over,
      },
      ...feishuOver,
    },
  };
}

describe('deriveFeishuBadgeState 状态映射', () => {
  it('查询无结果 → 状态未知', () => {
    expect(deriveFeishuBadgeState(null).kind).toBe('unknown');
  });

  it('未启用 / 无守护详情 / 凭证未配置 → 未配置', () => {
    expect(
      deriveFeishuBadgeState(res({}, { enabled: false })).kind,
    ).toBe('unconfigured');
    expect(
      deriveFeishuBadgeState({ text: 'x', running: false }).kind,
    ).toBe('unconfigured');
    expect(deriveFeishuBadgeState(res({ configured: false })).kind).toBe(
      'unconfigured',
    );
  });

  it('已连接 → connected', () => {
    const v = deriveFeishuBadgeState(res());
    expect(v.kind).toBe('connected');
    expect(v.label).toContain('已连接');
  });

  it('锁被另一进程持有 → 诚实显示持有者 pid（绝不显示已连接）', () => {
    const v = deriveFeishuBadgeState(
      res({ connected: false, reconnecting: true, lockHeldByOtherPid: 4242 }),
    );
    expect(v.kind).toBe('lock');
    expect(v.label).toContain('4242');
    expect(v.label).not.toContain('已连接');
  });

  it('重连中 → 显示第 N 次与下次重试倒计时', () => {
    const now = 1_000_000;
    const v = deriveFeishuBadgeState(
      res({
        connected: false,
        reconnecting: true,
        reconnectAttempts: 3,
        nextRetryAt: now + 4_000,
      }),
      now,
    );
    expect(v.kind).toBe('reconnecting');
    expect(v.label).toContain('第 3 次');
    expect(v.label).toContain('4s 后重试');
  });

  it('启用了但既没连上也没在抢救 → 离线', () => {
    const v = deriveFeishuBadgeState(
      res({ connected: false, reconnecting: false }),
    );
    expect(v.kind).toBe('offline');
  });
});
