/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { SearchPanel } from './SearchPanel.js';

afterEach(cleanup);

function searchData(provider: 'bing' | 'volcengine' = 'volcengine') {
  const saveSearchConfig = vi.fn();
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
      },
    },
    actions: { saveSearchConfig },
  } as unknown as UseSettingsData;
  return { value, saveSearchConfig };
}

describe('SearchPanel 联网搜索配置', () => {
  it('火山方舟密钥仅显示已保存状态，保存时发送完整配置但不回显旧密钥', () => {
    const { value, saveSearchConfig } = searchData();
    render(<SearchPanel data={value} />);

    expect(screen.getByRole('button', { name: '火山方舟' }).getAttribute('aria-pressed'))
      .toBe('true');
    expect(screen.getByText('API Key 已安全保存')).toBeTruthy();
    const keyInput = screen.getByLabelText('API Key') as HTMLInputElement;
    expect(keyInput.type).toBe('password');
    expect(keyInput.value).toBe('');
    expect(keyInput.placeholder).toContain('留空保留');

    fireEvent.change(screen.getByLabelText('豆包模型或推理接入点 ID'), {
      target: { value: 'doubao-seed-2-0-lite-260215' },
    });
    fireEvent.change(keyInput, { target: { value: 'new-ark-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

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

    fireEvent.click(screen.getByRole('button', { name: '火山方舟' }));
    expect((screen.getByLabelText('Responses API 地址') as HTMLInputElement).value)
      .toBe('https://ark.cn-beijing.volces.com/api/v3/responses');
    expect(
      (screen.getByLabelText('豆包模型或推理接入点 ID') as HTMLInputElement).value,
    ).toBe('doubao-seed-2-0-lite-260215');
  });

  it('切换 provider 时不会把火山方舟已保存的密钥误当作博查密钥', () => {
    const { value } = searchData('volcengine');
    render(<SearchPanel data={value} />);

    fireEvent.click(screen.getByRole('button', { name: '博查' }));
    expect((screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(screen.getByText('尚未配置 API Key')).toBeTruthy();
  });
});
