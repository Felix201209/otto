// @vitest-environment jsdom

/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonalTokenUsagePanel } from './PersonalTokenUsagePanel.js';

afterEach(cleanup);

const profile = {
  accountId: 'account-1',
  periodDays: 30,
  source: 'client_reported' as const,
  inputTokens: 7_200,
  outputTokens: 2_800,
  totalTokens: 10_000,
  requestCount: 20,
  averageTokensPerRequest: 500,
  lastUsedAt: '2026-08-27T10:00:00.000Z',
  byModel: [
    { model: 'qwen-max', inputTokens: 6_000, outputTokens: 2_000, totalTokens: 8_000, requestCount: 15 },
    { model: null, inputTokens: 1_200, outputTokens: 800, totalTokens: 2_000, requestCount: 5 },
  ],
  daily: [
    { date: '2026-08-26', inputTokens: 2_000, outputTokens: 1_000, totalTokens: 3_000, requestCount: 8 },
    { date: '2026-08-27', inputTokens: 5_200, outputTokens: 1_800, totalTokens: 7_000, requestCount: 12 },
  ],
};

describe('PersonalTokenUsagePanel', () => {
  it('shows personal totals, model distribution, daily trend and data provenance', async () => {
    const loadProfile = vi.fn().mockResolvedValue(profile);
    render(<PersonalTokenUsagePanel loadProfile={loadProfile} />);

    expect(await screen.findByText('10,000')).toBeTruthy();
    expect(loadProfile).toHaveBeenCalledWith(30);
    expect(screen.getByText('7,200')).toBeTruthy();
    expect(screen.getByText('2,800')).toBeTruthy();
    expect(screen.getByText('20')).toBeTruthy();
    expect(screen.getByText('500')).toBeTruthy();
    expect(screen.getByText('qwen-max')).toBeTruthy();
    expect(screen.getByText('未标记模型')).toBeTruthy();
    expect(screen.getByText('2026-08-27')).toBeTruthy();
    expect(screen.getByText(/客户端回传的聚合观察值/)).toBeTruthy();
    expect(screen.getByText(/不等同于模型供应商账单/)).toBeTruthy();
  });

  it('reloads the selected period and offers a retry after an error', async () => {
    const loadProfile = vi.fn()
      .mockRejectedValueOnce(new Error('网络不可用'))
      .mockResolvedValue({ ...profile, periodDays: 7 });
    render(<PersonalTokenUsagePanel loadProfile={loadProfile} />);

    expect((await screen.findByRole('alert')).textContent).toContain('网络不可用');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('10,000')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('统计周期'), { target: { value: '7' } });
    await waitFor(() => expect(loadProfile).toHaveBeenLastCalledWith(7));
  });

  it('shows a clear empty state without fabricating a model or trend', async () => {
    const loadProfile = vi.fn().mockResolvedValue({
      ...profile,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      averageTokensPerRequest: 0,
      lastUsedAt: null,
      byModel: [],
      daily: [],
    });
    render(<PersonalTokenUsagePanel loadProfile={loadProfile} />);

    expect(await screen.findByText(/当前周期还没有 Token 使用记录/)).toBeTruthy();
    expect(screen.queryByText('qwen-max')).toBeNull();
  });
});
