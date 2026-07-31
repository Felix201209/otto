// @vitest-environment jsdom

/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { SearchPanel } from './SearchPanel.js';

afterEach(cleanup);

function searchData(provider: 'bing' | 'volcengine' = 'volcengine') {
  const saveSearchConfig = vi.fn();
  const refreshSearchConfig = vi.fn();
  const value = {
    state: {
      searchConfig: {
        provider,
        apiUrl:
          provider === 'volcengine'
            ? 'https://ark.cn-beijing.volces.com/api/v3/responses'
            : '',
        model: provider === 'volcengine' ? 'doubao-old-model' : '',
        hasApiKey: provider === 'volcengine',
        configuredProviders:
          provider === 'volcengine'
            ? ['bing', 'volcengine', 'gemini']
            : ['bing', 'gemini'],
        diagnostics: {
          tenantId: 'org-a',
          cacheEntries: 2,
          cacheHits: 3,
          totalAttempts: 10,
          totalSuccesses: 8,
          estimatedCostCny: 0.12,
          updatedAt: 1_000,
          providers: ['bing', 'bocha', 'volcengine', 'gemini'].map((item) => ({
            provider: item,
            status: item === provider ? 'healthy' : 'untested',
            attempts: item === provider ? 10 : 0,
            successes: item === provider ? 8 : 0,
            failures: item === provider ? 2 : 0,
            consecutiveFailures: 0,
            averageLatencyMs: item === provider ? 320 : 0,
            estimatedCostCny: item === provider ? 0.12 : 0,
          })),
        },
      },
    },
    actions: { saveSearchConfig, refreshSearchConfig },
  } as unknown as UseSettingsData;
  return { value, saveSearchConfig, refreshSearchConfig };
}

describe('SearchPanel 联网搜索配置', () => {
  it('默认只告诉用户搜索已自动开启，不暴露专业配置', () => {
    const { value } = searchData('bing');
    render(<SearchPanel data={value} />);

    expect(screen.getByText('Otto 可以随时联网搜索')).toBeTruthy();
    expect(screen.getByText('无需配置')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '火山方舟' })).toBeNull();
    expect(screen.getByText('80%')).toBeTruthy();
    expect(screen.getAllByText('¥0.1200')).toHaveLength(2);
  });

  it('管理员可刷新线路诊断状态', () => {
    const { value, refreshSearchConfig } = searchData('bing');
    render(<SearchPanel data={value} />);
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(refreshSearchConfig).toHaveBeenCalledTimes(1);
  });

  it('火山方舟密钥仅显示已保存状态，保存时发送完整配置但不回显旧密钥', () => {
    const { value, saveSearchConfig } = searchData();
    render(<SearchPanel data={value} />);

    fireEvent.click(screen.getByRole('button', { name: /我有自己的搜索服务/ }));
    expect(screen.getByRole('button', { name: '火山方舟' }).getAttribute('aria-pressed'))
      .toBe('true');
    expect(screen.getByText('密钥已保存')).toBeTruthy();
    const keyInput = screen.getByLabelText('API Key') as HTMLInputElement;
    expect(keyInput.type).toBe('password');
    expect(keyInput.value).toBe('');
    expect(keyInput.placeholder).toContain('留空即可继续使用');

    fireEvent.change(screen.getByLabelText('模型或接入点 ID'), {
      target: { value: 'doubao-seed-2-0-lite-260215' },
    });
    fireEvent.change(keyInput, { target: { value: 'new-ark-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(saveSearchConfig).toHaveBeenCalledWith({
      provider: 'volcengine',
      apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/responses',
      model: 'doubao-seed-2-0-lite-260215',
      apiKey: 'new-ark-key',
    });
  });

  it('从 Bing 切到火山方舟时预填官方 API 地址和当前默认豆包模型', () => {
    const { value } = searchData('bing');
    render(<SearchPanel data={value} />);

    fireEvent.click(screen.getByRole('button', { name: /我有自己的搜索服务/ }));
    fireEvent.click(screen.getByRole('button', { name: '火山方舟' }));
    expect((screen.getByLabelText('服务地址') as HTMLInputElement).value)
      .toBe('https://ark.cn-beijing.volces.com/api/v3/responses');
    expect(
      (screen.getByLabelText('模型或接入点 ID') as HTMLInputElement).value,
    ).toBe('doubao-seed-2-0-lite-260215');
  });

  it('切换 provider 时不会把火山方舟已保存的密钥误当作博查密钥', () => {
    const { value } = searchData('volcengine');
    render(<SearchPanel data={value} />);

    fireEvent.click(screen.getByRole('button', { name: /我有自己的搜索服务/ }));
    fireEvent.click(screen.getByRole('button', { name: '博查' }));
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(screen.getByText('尚未填写密钥')).toBeTruthy();
  });
});
