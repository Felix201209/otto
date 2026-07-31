/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { SearchProvider } from 'otto-server';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { Badge, Card, Empty, Panel } from './HubUI.js';

const DEFAULT_ARK_API_URL =
  'https://ark.cn-beijing.volces.com/api/v3/responses';
const DEFAULT_ARK_MODEL = 'doubao-seed-2-0-lite-260215';

const PROVIDERS: Array<{
  id: SearchProvider;
  label: string;
  hint: string;
}> = [
  { id: 'bing', label: '自动（推荐）', hint: 'Otto 内置免密钥搜索，并自动切换可用线路' },
  { id: 'volcengine', label: '火山方舟', hint: '豆包 + Responses Web Search' },
  { id: 'bocha', label: '博查', hint: '结构化 Web Search API' },
  { id: 'gemini', label: 'Gemini', hint: 'Google Search Grounding' },
];

const PROVIDER_LABELS: Record<SearchProvider, string> = {
  bing: 'Bing 内置线路',
  bocha: '博查',
  volcengine: '火山方舟',
  gemini: 'Gemini',
};

const HEALTH_LABELS = {
  untested: '待检测',
  healthy: '正常',
  degraded: '不稳定',
  open: '已熔断',
} as const;

export function SearchPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const config = data.state.searchConfig;
  const [provider, setProvider] = useState<SearchProvider>('bing');
  const [apiUrl, setApiUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [costPerRequestCny, setCostPerRequestCny] = useState('');
  const [monthlyRequestQuota, setMonthlyRequestQuota] = useState('');
  const [monthlyBudgetCny, setMonthlyBudgetCny] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (!config) return;
    setProvider(config.provider);
    setApiUrl(config.apiUrl);
    setModel(config.model);
    setApiKey('');
    setCostPerRequestCny(
      typeof config.costPerRequestCny === 'number'
        ? String(config.costPerRequestCny)
        : '',
    );
    setMonthlyRequestQuota(
      typeof config.monthlyRequestQuota === 'number'
        ? String(config.monthlyRequestQuota)
        : '',
    );
    setMonthlyBudgetCny(
      typeof config.monthlyBudgetCny === 'number'
        ? String(config.monthlyBudgetCny)
        : '',
    );
  }, [config]);

  const chooseProvider = (next: SearchProvider): void => {
    setProvider(next);
    setApiKey('');
    if (next === 'volcengine') {
      if (!apiUrl.trim()) setApiUrl(DEFAULT_ARK_API_URL);
      if (!model.trim()) setModel(DEFAULT_ARK_MODEL);
    }
  };

  const requiresKey = provider === 'volcengine' || provider === 'bocha';
  const hasSavedKey = Boolean(config?.configuredProviders.includes(provider));
  const parsedCost = costPerRequestCny.trim()
    ? Number(costPerRequestCny)
    : undefined;
  const parsedRequestQuota = monthlyRequestQuota.trim()
    ? Number(monthlyRequestQuota)
    : undefined;
  const parsedBudget = monthlyBudgetCny.trim()
    ? Number(monthlyBudgetCny)
    : undefined;
  const canSave = useMemo(() => {
    if (provider === 'volcengine') {
      return (
        apiUrl.trim().startsWith('https://') &&
        Boolean(model.trim()) &&
        (Boolean(apiKey.trim()) || Boolean(hasSavedKey))
      );
    }
    if (provider === 'bocha') {
      return Boolean(apiKey.trim()) || Boolean(hasSavedKey);
    }
    return true;
  }, [apiKey, apiUrl, hasSavedKey, model, provider]);

  const save = (): void => {
    if (!canSave) return;
    data.actions.saveSearchConfig({
      provider,
      apiUrl: provider === 'volcengine' ? apiUrl.trim() : '',
      model: provider === 'volcengine' ? model.trim() : '',
      apiKey: apiKey.trim(),
      ...(typeof parsedCost === 'number' && Number.isFinite(parsedCost) && parsedCost >= 0
        ? { costPerRequestCny: parsedCost }
        : {}),
      ...(typeof parsedRequestQuota === 'number' &&
      Number.isFinite(parsedRequestQuota) &&
      parsedRequestQuota >= 0
        ? { monthlyRequestQuota: Math.floor(parsedRequestQuota) }
        : {}),
      ...(typeof parsedBudget === 'number' && Number.isFinite(parsedBudget) && parsedBudget >= 0
        ? { monthlyBudgetCny: parsedBudget }
        : {}),
    });
    setApiKey('');
  };

  const diagnostics = config?.diagnostics;
  const successRate = diagnostics?.totalAttempts
    ? Math.round((diagnostics.totalSuccesses / diagnostics.totalAttempts) * 100)
    : 0;

  const clearKey = (): void => {
    data.actions.saveSearchConfig({
      provider,
      apiUrl: provider === 'volcengine' ? apiUrl.trim() : '',
      model: provider === 'volcengine' ? model.trim() : '',
      clearApiKey: true,
    });
    setApiKey('');
  };

  return (
    <Panel
      title="联网搜索"
      desc="默认就能用，不需要申请密钥或理解搜索服务。"
    >
      {!config ? (
        <Empty>正在读取联网搜索配置…</Empty>
      ) : (
        <>
          <Card className="otto-search-ready">
            <div className="otto-search-ready__mark" aria-hidden>
              <span />
            </div>
            <div className="otto-search-ready__copy">
              <div className="otto-search-ready__eyebrow">已自动开启</div>
              <strong>Otto 可以随时联网搜索</strong>
              <p>
                默认使用内置免密钥线路；一条线路不可用时会自动换下一条。
                {provider !== 'bing' ? ' 你的自定义线路失败时也会自动回到内置搜索。' : ''}
              </p>
            </div>
            <Badge tone="accent">无需配置</Badge>
          </Card>

          <Card className="otto-search-diagnostics">
            <div className="otto-search-diagnostics__header">
              <div>
                <div className="otto-hub__field-label">线路运行状态</div>
                <div className="otto-hub__field-hint">
                  自动记录切换、熔断、响应时间和企业用量，不记录搜索内容。
                </div>
              </div>
              <button
                type="button"
                className="otto-hub__btn"
                onClick={data.actions.refreshSearchConfig}
              >
                刷新状态
              </button>
            </div>
            <div className="otto-search-diagnostics__summary">
              <div>
                <span>调用</span>
                <strong>{diagnostics?.totalAttempts ?? 0}</strong>
              </div>
              <div>
                <span>成功率</span>
                <strong>{successRate}%</strong>
              </div>
              <div>
                <span>缓存命中</span>
                <strong>{diagnostics?.cacheHits ?? 0}</strong>
              </div>
              <div>
                <span>预估费用</span>
                <strong>¥{(diagnostics?.estimatedCostCny ?? 0).toFixed(4)}</strong>
              </div>
            </div>
            <div className="otto-search-diagnostics__quota">
              <span>
                当月请求：{diagnostics?.quota?.requestsUsed ?? 0}
                {typeof diagnostics?.quota?.requestLimit === 'number'
                  ? ` / ${diagnostics.quota.requestLimit}`
                  : ' / 不限'}
              </span>
              <span>
                当月预算：¥{(diagnostics?.quota?.budgetUsedCny ?? 0).toFixed(4)}
                {typeof diagnostics?.quota?.budgetLimitCny === 'number'
                  ? ` / ¥${diagnostics.quota.budgetLimitCny.toFixed(4)}`
                  : ' / 不限'}
              </span>
              <Badge tone={diagnostics?.quota?.blocked ? 'danger' : 'accent'}>
                {diagnostics?.quota?.blocked ? '额度已用完' : '额度正常'}
              </Badge>
            </div>
            <div className="otto-search-diagnostics__providers">
              {diagnostics?.providers.map((item) => (
                <div className="otto-search-provider" key={item.provider}>
                  <div className="otto-search-provider__name">
                    <span>{PROVIDER_LABELS[item.provider]}</span>
                    <Badge tone={item.status === 'healthy' ? 'accent' : undefined}>
                      {HEALTH_LABELS[item.status]}
                    </Badge>
                  </div>
                  <div className="otto-search-provider__metrics">
                    <span>{item.successes}/{item.attempts} 成功</span>
                    <span>{item.averageLatencyMs} ms</span>
                    <span>¥{item.estimatedCostCny.toFixed(4)}</span>
                  </div>
                  <div className="otto-search-provider__detail">
                    {item.status === 'open' && item.openUntil
                      ? `暂停至 ${new Date(item.openUntil).toLocaleTimeString()}`
                      : item.lastErrorCode
                        ? `最近失败：${item.lastErrorCode}`
                        : config.configuredProviders.includes(item.provider)
                          ? '线路已配置'
                          : '未配置备用凭据'}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <button
            type="button"
            className="otto-hub__advanced-trigger"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((value) => !value)}
          >
            <span>{advancedOpen ? '收起高级设置' : '我有自己的搜索服务'}</span>
            <span aria-hidden>{advancedOpen ? '−' : '+'}</span>
          </button>

          {advancedOpen ? (
            <Card>
              <div className="otto-hub__setting otto-hub__setting--stack">
                <div className="otto-hub__setting-text">
                  <div className="otto-hub__field-label">优先使用</div>
                  <div className="otto-hub__field-hint">
                    大多数人保持“自动”即可；这里仅供已有企业搜索服务时使用。
                  </div>
                </div>
                <div className="otto-hub__chiprow">
                  {PROVIDERS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={'otto-hub__chip' + (provider === item.id ? ' is-active' : '')}
                      aria-pressed={provider === item.id}
                      title={item.hint}
                      onClick={() => chooseProvider(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              {provider === 'volcengine' ? (
                <>
                  <div className="otto-hub__setting otto-hub__setting--stack">
                    <div className="otto-hub__setting-text">
                      <label className="otto-hub__field-label" htmlFor="search-api-url">
                        服务地址
                      </label>
                      <div className="otto-hub__field-hint">默认已填好，只有企业网关不同才需要修改。</div>
                    </div>
                    <input
                      id="search-api-url"
                      className="otto-hub__input"
                      type="url"
                      value={apiUrl}
                      spellCheck={false}
                      onChange={(event) => setApiUrl(event.target.value)}
                    />
                  </div>
                  <div className="otto-hub__setting otto-hub__setting--stack">
                    <div className="otto-hub__setting-text">
                      <label className="otto-hub__field-label" htmlFor="search-model">
                        模型或接入点 ID
                      </label>
                    </div>
                    <input
                      id="search-model"
                      className="otto-hub__input"
                      value={model}
                      spellCheck={false}
                      onChange={(event) => setModel(event.target.value)}
                    />
                  </div>
                </>
              ) : null}

              {requiresKey ? (
                <div className="otto-hub__setting otto-hub__setting--stack">
                  <div className="otto-hub__setting-text">
                    <label className="otto-hub__field-label" htmlFor="search-api-key">API Key</label>
                    <div className="otto-hub__field-hint">只保存在这台电脑，不会在界面中显示原文。</div>
                  </div>
                  <div className="otto-hub__inputrow">
                    <input
                      id="search-api-key"
                      className="otto-hub__input"
                      type="password"
                      value={apiKey}
                      autoComplete="new-password"
                      placeholder={hasSavedKey ? '留空即可继续使用已保存的密钥' : '粘贴 API Key'}
                      onChange={(event) => setApiKey(event.target.value)}
                    />
                    {hasSavedKey ? <button type="button" className="otto-hub__btn" onClick={clearKey}>清除</button> : null}
                  </div>
                  <div><Badge tone={hasSavedKey ? 'accent' : undefined}>{hasSavedKey ? '密钥已保存' : '尚未填写密钥'}</Badge></div>
                </div>
              ) : (
                <div className="otto-hub__setting">
                  <div className="otto-hub__setting-text">
                    <div className="otto-hub__field-label">{provider === 'bing' ? '无需 API Key' : '使用已有模型'}</div>
                    <div className="otto-hub__field-hint">
                      {provider === 'bing' ? '保存后恢复 Otto 自动搜索。' : 'Gemini 会使用你已经配置的 Gemini 模型。'}
                    </div>
                  </div>
                </div>
              )}

              <div className="otto-hub__setting otto-hub__setting--stack">
                <div className="otto-hub__setting-text">
                  <label className="otto-hub__field-label" htmlFor="search-request-cost">
                    单次调用成本（元）
                  </label>
                  <div className="otto-hub__field-hint">
                    可选。用于企业费用估算，不参与服务商实际扣费。
                  </div>
                </div>
                <input
                  id="search-request-cost"
                  className="otto-hub__input"
                  type="number"
                  min="0"
                  step="0.0001"
                  value={costPerRequestCny}
                  placeholder="例如 0.0100"
                  onChange={(event) => setCostPerRequestCny(event.target.value)}
                />
              </div>

              <div className="otto-hub__setting otto-hub__setting--stack">
                <div className="otto-hub__setting-text">
                  <div className="otto-hub__field-label">企业月度额度</div>
                  <div className="otto-hub__field-hint">
                    可选。达到请求次数或预算任一上限后，Otto 会停止对应供应商请求。
                  </div>
                </div>
                <div className="otto-hub__inputrow">
                  <input
                    className="otto-hub__input"
                    aria-label="每月搜索请求上限"
                    type="number"
                    min="0"
                    step="1"
                    value={monthlyRequestQuota}
                    placeholder="请求次数，不填则不限"
                    onChange={(event) => setMonthlyRequestQuota(event.target.value)}
                  />
                  <input
                    className="otto-hub__input"
                    aria-label="每月搜索预算上限"
                    type="number"
                    min="0"
                    step="0.01"
                    value={monthlyBudgetCny}
                    placeholder="预算金额，不填则不限"
                    onChange={(event) => setMonthlyBudgetCny(event.target.value)}
                  />
                </div>
              </div>

              <div className="otto-hub__setting otto-search-advanced__actions">
                <span className="otto-hub__field-hint">保存后立即用于当前与新会话。</span>
                <button type="button" className="otto-hub__btn otto-hub__btn--primary" disabled={!canSave} onClick={save}>保存</button>
              </div>
            </Card>
          ) : null}
        </>
      )}
    </Panel>
  );
}
