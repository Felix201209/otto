/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/** SetupPanel 交互单测：「复制 custom-models.json」不把明文 key 写进剪贴板。 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { SetupPanel } from './SetupPanel.js';

const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  writeText.mockClear();
  // jsdom 无 navigator.clipboard，按需注入可覆盖的 mock。
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText, readText: async () => '' },
    configurable: true,
  });
});

function renderPanel(): ReturnType<typeof render> {
  return render(
    <SetupPanel models={[]} onClose={() => {}} onSave={() => {}} />,
  );
}

describe('SetupPanel 复制路径', () => {
  it('复制 custom-models.json：剪贴板内容用占位符代替明文 key', async () => {
    const { getByText, getByPlaceholderText } = renderPanel();
    fireEvent.change(getByPlaceholderText('sk-...'), {
      target: { value: 'sk-real-secret-123' },
    });
    // 模型输入框占位符现含「回车或点添加」（多选批量后）；输入的待添加项也算进 effectiveModelIds。
    fireEvent.change(getByPlaceholderText(/回车或点添加/), {
      target: { value: 'gpt-5.1' },
    });

    // 离线兜底默认折叠，先展开「高级：手动落盘方式」才见复制按钮。
    fireEvent.click(getByText('高级：手动落盘方式'));
    const btn = getByText('复制 custom-models.json') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0];
    expect(text).toContain('<你的API_KEY>');
    expect(text).not.toContain('sk-real-secret-123');
  });

  it('复制按钮旁展示占位符提示', () => {
    const { getByText } = renderPanel();
    // 展开高级块后才显示复制路径及其占位符提示。
    fireEvent.click(getByText('高级：手动落盘方式'));
    expect(getByText('已用占位符代替 API Key，粘贴后请自行填入。')).toBeTruthy();
  });
});

describe('SetupPanel 编辑模型', () => {
  it('编辑时预填全部非敏感字段，key 留空，并发 replaceId', () => {
    const onSave = vi.fn();
    const { getByRole, getByDisplayValue, getByPlaceholderText, getByText } = render(
      <SetupPanel
        models={[{
          id: 'custom:openai:deepseek-chat@abc',
          displayName: '工作模型',
          provider: 'openai',
          baseUrl: 'https://api.deepseek.com/v1',
          modelId: 'deepseek-chat',
          maxTokens: 64000,
          enabled: false,
        }]}
        onClose={() => {}}
        onSave={onSave}
      />,
    );
    fireEvent.click(getByRole('button', { name: '编辑 工作模型' }));
    expect(getByDisplayValue('https://api.deepseek.com/v1')).toBeTruthy();
    expect(getByDisplayValue('deepseek-chat')).toBeTruthy();
    expect(getByDisplayValue('工作模型')).toBeTruthy();
    expect(getByDisplayValue('64000')).toBeTruthy();
    expect((getByPlaceholderText('留空则保留当前 API Key') as HTMLInputElement).value).toBe('');
    fireEvent.click(getByText('保存修改'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      replaceId: 'custom:openai:deepseek-chat@abc',
      apiKey: '',
      enabled: false,
      maxTokens: 64000,
    }));
  });
});
