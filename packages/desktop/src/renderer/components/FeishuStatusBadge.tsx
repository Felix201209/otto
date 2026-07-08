/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书连接状态徽标（设置页飞书区域挂载）。
 *
 * 数据通路（全真实，无一处假报）：
 *   renderer 定时调 window.otto.feishuStatus()
 *     → main 进程真查当前 server 的 GET /health
 *     → server 侧 FeishuAdapter.getStatus()（断线守护的第一手状态）。
 *
 * 状态语义（与守护循环一一对应）：
 *   ✅ 已连接        —— WS 长连接就绪；
 *   🔄 重连中        —— 断线后守护在退避重试（显示第 N 次、约几秒后重试）；
 *   ⚠️ 另一进程持有  —— 连接锁被别的进程（如 CLI daemon）拿着，本进程如实
 *                      不连（避免消息被处理两遍），对方退出后自动接管；
 *   ❌ 离线          —— 启用了但当前既没连上也没在抢救（罕见，心跳会拉回）；
 *   ─  未配置        —— 没有飞书凭证 / server 未启用飞书网关。
 *
 * 状态推导抽成纯函数 deriveFeishuBadgeState 导出，单测直接测映射逻辑。
 */

import React, { useEffect, useState } from 'react';
import type { FeishuStatusDetail } from '../../preload/index.js';

/** 轮询周期：状态展示不追求实时，5s 足够跟上重连节奏且不扰动 server。 */
const POLL_INTERVAL_MS = 5_000;

/** feishuStatus() 的返回形状（preload 透传 main 的查询结果）。 */
export interface FeishuStatusResult {
  text: string;
  running: boolean;
  feishu?: FeishuStatusDetail;
}

export interface FeishuBadgeView {
  kind: 'connected' | 'reconnecting' | 'lock' | 'offline' | 'unconfigured' | 'unknown';
  /** 徽标短文案（含状态符号）。 */
  label: string;
  /** 状态点颜色（语义色，独立于主题弱化灰）。 */
  dotColor: string;
}

/** 把守护状态映射为徽标视图（纯函数，可单测）。now 注入便于测试。 */
export function deriveFeishuBadgeState(
  res: FeishuStatusResult | null,
  now: number = Date.now(),
): FeishuBadgeView {
  if (!res) {
    return { kind: 'unknown', label: '─ 状态未知', dotColor: '#9ca3af' };
  }
  const feishu = res.feishu;
  const st = feishu?.status;
  if (!feishu || !feishu.enabled || !st || !st.configured) {
    return { kind: 'unconfigured', label: '─ 未配置', dotColor: '#9ca3af' };
  }
  if (st.connected) {
    return { kind: 'connected', label: '✅ 已连接', dotColor: '#34d399' };
  }
  if (st.lockHeldByOtherPid != null) {
    return {
      kind: 'lock',
      label: `⚠️ 另一进程持有（pid ${st.lockHeldByOtherPid}）`,
      dotColor: '#fbbf24',
    };
  }
  if (st.reconnecting) {
    const eta =
      st.nextRetryAt != null
        ? Math.max(0, Math.round((st.nextRetryAt - now) / 1000))
        : null;
    return {
      kind: 'reconnecting',
      label: `🔄 重连中（第 ${st.reconnectAttempts} 次${eta !== null ? `，${eta}s 后重试` : ''}）`,
      dotColor: '#fbbf24',
    };
  }
  return { kind: 'offline', label: '❌ 离线', dotColor: '#f87171' };
}

export interface FeishuStatusBadgeProps {
  /** 每次拿到最新状态时上抛（SetupPanel 用它同步长文案），可选。 */
  onStatus?: (res: FeishuStatusResult) => void;
}

/** 飞书连接状态徽标：挂载即开始轮询，卸载即停（无定时器泄漏）。 */
export function FeishuStatusBadge({
  onStatus,
}: FeishuStatusBadgeProps): React.JSX.Element {
  const [result, setResult] = useState<FeishuStatusResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await window.otto?.feishuStatus();
        if (!cancelled && res) {
          setResult(res);
          onStatus?.(res);
        }
      } catch {
        // 查询失败保留上一帧状态（title 里仍是最近一次真话），下轮再试。
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // onStatus 由父组件以稳定引用传入（useCallback/一次性函数）；不进依赖数组，
    // 避免父组件每次渲染重建轮询循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = deriveFeishuBadgeState(result);
  return (
    <span
      className="otto-badge otto-badge--feishu"
      style={{ fontSize: '11px' }}
      title={result?.text ?? '正在查询飞书连接状态…'}
      data-feishu-state={view.kind}
    >
      <span
        aria-hidden
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          background: view.dotColor,
          display: 'inline-block',
        }}
      />
      {view.label}
    </span>
  );
}
