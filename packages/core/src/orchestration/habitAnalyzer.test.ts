/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { HabitAnalyzer, type OperationRecord } from './habitAnalyzer.js';

function operation(index: number): OperationRecord {
  return {
    action: index % 2 === 0 ? 'search:customer' : 'open:customer',
    category: 'crm',
    success: true,
    timestamp: new Date(2026, 7, 21, 9, index).toISOString(),
    toolName: index % 2 === 0 ? 'search' : 'open',
  };
}

function feedOperations(analyzer: HabitAnalyzer, count = 20): void {
  for (let index = 0; index < count; index += 1) {
    analyzer.feed(operation(index));
  }
}

function modelConfig() {
  const sendMessage = vi.fn().mockResolvedValue({
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify({
            insights: [{
              type: 'workflow',
              title: '模型洞察',
              description: '测试',
              evidence: [],
            }],
          }),
        }],
      },
    }],
  });
  const createTemporaryChat = vi.fn().mockResolvedValue({ sendMessage });
  const config = {
    getOttoClient: vi.fn(() => ({ createTemporaryChat })),
  } as unknown as Config;

  return { config, createTemporaryChat, sendMessage };
}

describe('HabitAnalyzer background model safety', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to local analysis without calling the model', async () => {
    const analyzer = new HabitAnalyzer();
    const { config, createTemporaryChat } = modelConfig();
    analyzer.setConfig(config);
    feedOperations(analyzer);

    const insights = await analyzer.runAnalysis();

    expect(insights.length).toBeGreaterThan(0);
    expect(createTemporaryChat).not.toHaveBeenCalled();
  });

  it('calls the model only after explicit opt-in', async () => {
    const analyzer = new HabitAnalyzer({ llmAnalysisEnabled: true });
    const { config, createTemporaryChat, sendMessage } = modelConfig();
    analyzer.setConfig(config);
    feedOperations(analyzer);

    const insights = await analyzer.runAnalysis();

    expect(createTemporaryChat).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(insights[0]?.title).toBe('模型洞察');
  });

  it('does not analyze the same operation revision twice', async () => {
    const analyzer = new HabitAnalyzer({ llmAnalysisEnabled: true });
    const { config, createTemporaryChat } = modelConfig();
    analyzer.setConfig(config);
    feedOperations(analyzer);

    expect(await analyzer.runAnalysis()).not.toHaveLength(0);
    expect(await analyzer.runAnalysis()).toEqual([]);
    expect(createTemporaryChat).toHaveBeenCalledTimes(1);

    analyzer.feed(operation(20));
    expect(await analyzer.runAnalysis()).not.toHaveLength(0);
    expect(createTemporaryChat).toHaveBeenCalledTimes(2);
  });

  it('clears both startup and interval timers when stopped', async () => {
    vi.useFakeTimers();
    const analyzer = new HabitAnalyzer({
      analysisIntervalMs: 2 * 60 * 60 * 1000,
      llmAnalysisEnabled: true,
    });
    const { config, createTemporaryChat } = modelConfig();
    analyzer.setConfig(config);
    feedOperations(analyzer);

    analyzer.start();
    analyzer.stop();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);

    expect(createTemporaryChat).not.toHaveBeenCalled();
    expect(await analyzer.runAnalysis()).toEqual([]);
  });
});
