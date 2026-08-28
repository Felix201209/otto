/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Caption, Empty, Panel } from './HubUI.js';

export interface PersonalTokenUsageProfileView {
  accountId: string;
  periodDays: number;
  source: 'client_reported';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  averageTokensPerRequest: number;
  lastUsedAt: string | null;
  byModel: Array<{
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestCount: number;
  }>;
  daily: Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestCount: number;
  }>;
}

export type PersonalTokenUsageLoader = (
  periodDays: number,
) => Promise<PersonalTokenUsageProfileView>;

function defaultLoader(periodDays: number): Promise<PersonalTokenUsageProfileView> {
  const bridge = window.otto as typeof window.otto & {
    enterpriseUsageProfile(days?: number): Promise<PersonalTokenUsageProfileView>;
  };
  return bridge.enterpriseUsageProfile(periodDays);
}

function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '暂时无法读取 Token 画像';
}

export function PersonalTokenUsagePanel({
  loadProfile = defaultLoader,
}: {
  loadProfile?: PersonalTokenUsageLoader;
}): React.JSX.Element {
  const [periodDays, setPeriodDays] = useState(30);
  const [profile, setProfile] = useState<PersonalTokenUsageProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setProfile(await loadProfile(periodDays));
    } catch (cause) {
      setProfile(null);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [loadProfile, periodDays]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const maxDailyTokens = useMemo(
    () => Math.max(1, ...(profile?.daily.map((day) => day.totalTokens) ?? [])),
    [profile],
  );

  return (
    <Panel
      title="我的 Token"
      desc="查看当前账号的模型使用规模、来源和变化趋势。"
      actions={(
        <>
          <label className="otto-token-profile__period">
            <span>统计周期</span>
            <select
              aria-label="统计周期"
              value={periodDays}
              onChange={(event) => setPeriodDays(Number(event.target.value))}
              disabled={loading}
            >
              <option value={7}>近 7 天</option>
              <option value={30}>近 30 天</option>
              <option value={90}>近 90 天</option>
            </select>
          </label>
          <button className="otto-hub__btn" type="button" onClick={() => void refresh()} disabled={loading}>
            {loading ? '读取中…' : '刷新'}
          </button>
        </>
      )}
    >
      {error ? (
        <div className="otto-token-profile__error" role="alert">
          <span>{error}</span>
          <button className="otto-hub__btn" type="button" onClick={() => void refresh()}>重试</button>
        </div>
      ) : null}

      {loading && !profile && !error ? <Empty>正在读取你的 Token 使用画像…</Empty> : null}

      {!loading && profile?.totalTokens === 0 ? (
        <Empty>当前周期还没有 Token 使用记录。完成一次模型对话后，这里会自动形成画像。</Empty>
      ) : null}

      {profile && profile.totalTokens > 0 ? (
        <>
          <div className="otto-token-profile__metrics" aria-label="Token 使用概览">
            <div><span>总 Token</span><strong>{formatTokens(profile.totalTokens)}</strong></div>
            <div><span>输入</span><strong>{formatTokens(profile.inputTokens)}</strong></div>
            <div><span>输出</span><strong>{formatTokens(profile.outputTokens)}</strong></div>
            <div><span>请求次数</span><strong>{formatTokens(profile.requestCount)}</strong></div>
            <div><span>单次平均</span><strong>{formatTokens(profile.averageTokensPerRequest)}</strong></div>
          </div>

          <section>
            <Caption>按模型分布</Caption>
            <Card className="otto-token-profile__models">
              {profile.byModel.map((item, index) => {
                const share = profile.totalTokens > 0
                  ? Math.round((item.totalTokens / profile.totalTokens) * 100)
                  : 0;
                return (
                  <div className="otto-token-profile__model" key={`${item.model ?? 'unknown'}-${index}`}>
                    <div>
                      <strong>{item.model || '未标记模型'}</strong>
                      <span>{formatTokens(item.requestCount)} 次请求</span>
                    </div>
                    <div className="otto-token-profile__model-value">
                      <strong>{formatTokens(item.totalTokens)}</strong>
                      <span>{share}%</span>
                    </div>
                    <div className="otto-token-profile__bar" aria-label={`${share}%`}>
                      <span style={{ width: `${share}%` }} />
                    </div>
                  </div>
                );
              })}
            </Card>
          </section>

          <section>
            <Caption>每日趋势</Caption>
            <Card className="otto-token-profile__trend">
              {profile.daily.map((day) => (
                <div className="otto-token-profile__day" key={day.date}>
                  <span>{day.date}</span>
                  <div aria-hidden><i style={{ width: `${Math.round((day.totalTokens / maxDailyTokens) * 100)}%` }} /></div>
                  <strong>{formatTokens(day.totalTokens)}</strong>
                </div>
              ))}
            </Card>
          </section>
        </>
      ) : null}

      <div className="otto-token-profile__source">
        数据来自客户端回传的聚合观察值，只包含 Token 数量、模型和时间，不包含对话正文或密钥；不等同于模型供应商账单。
      </div>
    </Panel>
  );
}
