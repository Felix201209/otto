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
  { id: 'bing', label: 'Bing（免密钥）', hint: '直接读取公开搜索结果页' },
  { id: 'volcengine', label: '火山方舟', hint: '豆包 + Responses Web Search' },
  { id: 'bocha', label: '博查', hint: '结构化 Web Search API' },
  { id: 'gemini', label: 'Gemini', hint: 'Google Search Grounding' },
];

export function SearchPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const config = data.state.searchConfig;
  const [provider, setProvider] = useState<SearchProvider>('bing');
  const [apiUrl, setApiUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    if (!config) return;
    setProvider(config.provider);
    setApiUrl(config.apiUrl);
    setModel(config.model);
    setApiKey('');
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
  const hasSavedKey = config?.provider === provider && config.hasApiKey;
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
    });
    setApiKey('');
  };

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
      desc="配置 AI 调用的搜索服务。火山方舟使用 Responses API 内置 Web Search。"
      actions={
        <button
          type="button"
          className="otto-hub__btn otto-hub__btn--primary"
          disabled={!config || !canSave}
          onClick={save}
        >
          保存配置
        </button>
      }
    >
      {!config ? (
        <Empty>正在读取联网搜索配置…</Empty>
      ) : (
        <Card>
          <div className="otto-hub__setting otto-hub__setting--stack">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">搜索服务</div>
              <div className="otto-hub__field-hint">
                选择后会立即用于新会话；保存时也会热更新当前已打开的会话。
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
                    Responses API 地址
                  </label>
                  <div className="otto-hub__field-hint">
                    默认使用火山方舟北京地域，也可填写企业兼容网关；必须为 HTTPS。
                  </div>
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
                    豆包模型或推理接入点 ID
                  </label>
                  <div className="otto-hub__field-hint">
                    模型需要支持 Responses API 和内置 web_search 工具。
                  </div>
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
                <label className="otto-hub__field-label" htmlFor="search-api-key">
                  API Key
                </label>
                <div className="otto-hub__field-hint">
                  密钥单独保存在本机 0600 文件中，界面和 Server 回包都不会显示原文。
                </div>
              </div>
              <div className="otto-hub__inputrow">
                <input
                  id="search-api-key"
                  className="otto-hub__input"
                  type="password"
                  value={apiKey}
                  autoComplete="new-password"
                  placeholder={hasSavedKey ? '留空保留当前 API Key' : '粘贴 API Key'}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                {hasSavedKey ? (
                  <button type="button" className="otto-hub__btn" onClick={clearKey}>
                    清除密钥
                  </button>
                ) : null}
              </div>
              <div>
                <Badge tone={hasSavedKey ? 'accent' : undefined}>
                  {hasSavedKey ? 'API Key 已安全保存' : '尚未配置 API Key'}
                </Badge>
              </div>
            </div>
          ) : (
            <div className="otto-hub__setting">
              <div className="otto-hub__setting-text">
                <div className="otto-hub__field-label">
                  {provider === 'bing' ? '无需 API Key' : '使用模型配置'}
                </div>
                <div className="otto-hub__field-hint">
                  {provider === 'bing'
                    ? '适合开箱使用；如遇页面限制，可切换到火山方舟等正式 API。'
                    : 'Gemini 搜索会使用已配置的 Gemini Flash 模型与 Google Grounding。'}
                </div>
              </div>
            </div>
          )}
        </Card>
      )}
    </Panel>
  );
}
