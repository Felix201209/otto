/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { describe, it, expect, beforeEach, vi } from 'vitest';
import { contextCommand } from './contextCommand.js';
import { MessageType } from '../types.js';
import type { CommandContext } from './types.js';
import { uiTelemetryService } from 'otto-core';
import type { Config } from 'otto-core';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

vi.mock('otto-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('otto-core')>();
  return {
    ...actual,
    tokenLimit: vi.fn().mockReturnValue(1000000),
    getCoreSystemPrompt: vi.fn().mockReturnValue('Mock system prompt'),
  };
});

describe('contextCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    const mockConfig = {
      getCloudModelInfo: vi.fn().mockReturnValue({ displayName: 'Gemini 2.0 Flash' }),
      getMemoryTokenCount: vi.fn().mockReturnValue(100),
      getUserMemory: vi.fn().mockReturnValue({}),
      getAgentStyle: vi.fn().mockReturnValue('default'),
      getPreferredLanguage: vi.fn().mockReturnValue(undefined),
    };

    mockContext = createMockCommandContext({
      services: {
        config: mockConfig as unknown as Config,
        settings: {
          merged: {
            preferredModel: 'gemini-2.0-flash-exp',
          },
        },
      },
      session: {
        stats: {
          lastPromptTokenCount: 8000,
        },
      },
    });

    vi.spyOn(uiTelemetryService, 'getLastPromptTokenCount').mockReturnValue(8000);
    vi.spyOn(uiTelemetryService, 'getMetrics').mockReturnValue({
      models: {
        'gemini-2.0-flash-exp': {
          tokens: {
            tool: 50,
          },
        },
      },
    } as ReturnType<typeof uiTelemetryService.getMetrics>);
  });

  it('should be defined', () => {
    expect(contextCommand).toBeDefined();
  });

  it('should have correct name and description', () => {
    expect(contextCommand.name).toBe('context');
    expect(contextCommand.altNames).toEqual([]);
    expect(contextCommand.description).toBeTruthy();
  });

  it('should display token usage breakdown', async () => {
    await contextCommand.action!(mockContext, '');

    // addItem should be called twice: once for model info, once for breakdown
    expect(mockContext.ui.addItem).toHaveBeenCalledTimes(2);

    const breakdownCall = vi.mocked(mockContext.ui.addItem).mock.calls.find(
      (call) => call[0].type === MessageType.CONTEXT_BREAKDOWN
    );
    expect(breakdownCall).toBeDefined();

    const [item, timestamp] = breakdownCall;

    expect(item.type).toBe(MessageType.CONTEXT_BREAKDOWN);
    expect(item.maxTokens).toBeGreaterThan(0);
    expect(item.systemPromptTokens).toBeGreaterThanOrEqual(0);
    expect(item.systemToolsTokens).toBeGreaterThanOrEqual(0);
    expect(item.memoryFilesTokens).toBeGreaterThanOrEqual(0);
    expect(item.messagesTokens).toBeGreaterThanOrEqual(0);
    expect(item.reservedTokens).toBe(0); // Code sets it to 0
    expect(item.freeSpaceTokens).toBeGreaterThanOrEqual(0);
    expect(typeof timestamp).toBe('number');
  });

  it('should handle zero token usage', async () => {
    vi.spyOn(uiTelemetryService, 'getLastPromptTokenCount').mockReturnValue(0);
    vi.spyOn(uiTelemetryService, 'getMetrics').mockReturnValue({
      models: {
        'gemini-2.0-flash-exp': {
          tokens: {
            tool: 0,
          },
        },
      },
    } as ReturnType<typeof uiTelemetryService.getMetrics>);

    await contextCommand.action!(mockContext, '');

    const breakdownCall = vi.mocked(mockContext.ui.addItem).mock.calls.find(
      (call) => call[0].type === MessageType.CONTEXT_BREAKDOWN
    );
    expect(breakdownCall).toBeDefined();

    const [item] = breakdownCall;

    expect(item.type).toBe(MessageType.CONTEXT_BREAKDOWN);
    // If actualPromptTokens is 0, totalInputTokens is sum of static parts
    expect(item.totalInputTokens).toBeGreaterThanOrEqual(0);
  });
});
