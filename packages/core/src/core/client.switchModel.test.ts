/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { OttoClient, getStableEnvironmentIdentityContext } from './client.js';

describe('OttoClient environment identity context', () => {
  it('does not persist a concrete model name in user history', () => {
    const context = getStableEnvironmentIdentityContext();

    expect(context).toContain('Current Model');
    expect(context).toContain('system instruction');
    expect(context).not.toMatch(/glm|gemini|claude|gpt|deepseek|qwen/i);
  });
});

describe('OttoClient.switchModel', () => {
  it('切换 live chat 后同步刷新包含 Current Model 的系统提示词', async () => {
    let currentModel = 'custom:openai:glm-old@test';
    const setSpecifiedModel = vi.fn();
    const updateSystemPrompt = vi.fn(async () => undefined);
    const client = Object.create(OttoClient.prototype) as OttoClient;
    const harness = client as unknown as {
      isCompressing: boolean;
      sessionTokenCount: number;
      config: {
        getModel: () => string;
        setModel: (model: string) => void;
      };
      chat: {
        getHistory: () => never[];
        setSpecifiedModel: typeof setSpecifiedModel;
        addHistory: ReturnType<typeof vi.fn>;
      };
      compressionService: {
        compressToFit: ReturnType<typeof vi.fn>;
      };
      setTools: ReturnType<typeof vi.fn>;
      updateSystemPromptWithMcpPrompts: typeof updateSystemPrompt;
      formatModelForDisplay: (model: string) => string;
      resetCompressionFlag: ReturnType<typeof vi.fn>;
    };

    harness.isCompressing = false;
    harness.sessionTokenCount = 0;
    harness.config = {
      getModel: () => currentModel,
      setModel: (model: string) => {
        currentModel = model;
      },
    };
    harness.chat = {
      getHistory: () => [],
      setSpecifiedModel,
      addHistory: vi.fn(),
    };
    harness.compressionService = {
      compressToFit: vi.fn(async () => ({
        success: true,
        skipReason: '上下文无需压缩',
      })),
    };
    harness.setTools = vi.fn(async () => undefined);
    harness.updateSystemPromptWithMcpPrompts = updateSystemPrompt;
    harness.formatModelForDisplay = (model: string) => model;
    harness.resetCompressionFlag = vi.fn();

    const result = await client.switchModel(
      'custom:openai-responses:gpt-5.6-sol@test',
      new AbortController().signal,
    );

    expect(result.success).toBe(true);
    expect(setSpecifiedModel).toHaveBeenCalledWith(
      'custom:openai-responses:gpt-5.6-sol@test',
    );
    expect(updateSystemPrompt).toHaveBeenCalledTimes(1);
  });
});
