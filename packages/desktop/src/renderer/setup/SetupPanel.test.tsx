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
    fireEvent.change(getByPlaceholderText('例如 gpt-5.1 / gpt-4o'), {
      target: { value: 'gpt-5.1' },
    });

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
    expect(getByText('已用占位符代替 API Key，粘贴后请自行填入。')).toBeTruthy();
  });
});
