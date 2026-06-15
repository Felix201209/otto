/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { WebFetchTool } from './web-fetch.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ToolConfirmationOutcome } from './tools.js';

describe('WebFetchTool', () => {
  const mockConfig = {
    getApprovalMode: vi.fn(),
    setApprovalMode: vi.fn(),
    getProxy: vi.fn(),
  } as unknown as Config;

  describe('shouldConfirmExecute', () => {
    it('should return confirmation details with the correct prompt and urls', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = { prompt: 'fetch https://example.com' };
      const confirmationDetails = await tool.shouldConfirmExecute(params);

      expect(confirmationDetails).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt: 'fetch https://example.com',
        urls: ['https://example.com'],
        onConfirm: expect.any(Function),
      });
    });

    it('should convert github urls to raw format', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = {
        prompt:
          'fetch https://github.com/google/gemini-react/blob/main/README.md',
      };
      const confirmationDetails = await tool.shouldConfirmExecute(params);

      expect(confirmationDetails).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt:
          'fetch https://github.com/google/gemini-react/blob/main/README.md',
        urls: [
          'https://raw.githubusercontent.com/google/gemini-react/main/README.md',
        ],
        onConfirm: expect.any(Function),
      });
    });

    it('should return false if approval mode is AUTO_EDIT', async () => {
      const tool = new WebFetchTool({
        ...mockConfig,
        getApprovalMode: () => ApprovalMode.AUTO_EDIT,
      } as unknown as Config);
      const params = { prompt: 'fetch https://example.com' };
      const confirmationDetails = await tool.shouldConfirmExecute(params);

      expect(confirmationDetails).toBe(false);
    });

    it('should call setApprovalMode when onConfirm is called with ProceedAlways', async () => {
      const setApprovalMode = vi.fn();
      const tool = new WebFetchTool({
        ...mockConfig,
        setApprovalMode,
      } as unknown as Config);
      const params = { prompt: 'fetch https://example.com' };
      const confirmationDetails = await tool.shouldConfirmExecute(params);

      if (
        confirmationDetails &&
        typeof confirmationDetails === 'object' &&
        'onConfirm' in confirmationDetails
      ) {
        await confirmationDetails.onConfirm(
          ToolConfirmationOutcome.ProceedAlways,
        );
      }

      expect(setApprovalMode).toHaveBeenCalledWith(ApprovalMode.AUTO_EDIT);
    });
  });

  describe('execute', () => {
    const createTemporaryChatMock = vi.fn().mockResolvedValue({
      setTools: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: 'Response from custom gemini flash' }],
              role: 'model',
            },
            index: 0,
          },
        ],
      }),
    });

    const baseMockConfig = {
      getApprovalMode: vi.fn(),
      setApprovalMode: vi.fn(),
      getProxy: vi.fn(),
      getGeminiClient: () => ({
        createTemporaryChat: createTemporaryChatMock,
      }),
    };

    it('selects custom Gemini Flash model when custom models are used', async () => {
      const getModelMock = vi.fn().mockReturnValue('custom:openai:gpt-4o@hash');
      const getCustomModelsMock = vi.fn().mockReturnValue([
        {
          displayName: 'My Custom Flash',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'key',
          modelId: 'gemini-2.5-flash',
          enabled: true,
        },
        {
          displayName: 'Some Other Model',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'key',
          modelId: 'gpt-4o',
          enabled: true,
        }
      ]);

      const testConfig = {
        ...baseMockConfig,
        getModel: getModelMock,
        getCustomModels: getCustomModelsMock,
      } as unknown as Config;

      const tool = new WebFetchTool(testConfig);
      const params = { prompt: 'fetch https://example.com' };

      const result = await tool.execute(params, new AbortController().signal);

      // Verify createTemporaryChat was called with custom Gemini Flash ID
      expect(createTemporaryChatMock).toHaveBeenCalledWith(
        'web_fetch',
        'custom:openai:gemini-2.5-flash@yomiri',
        expect.any(Object)
      );
      expect(result.llmContent).toBe('Response from custom gemini flash');
    });

    it('returns tool unavailable when custom models are used but no custom Gemini Flash is found', async () => {
      const getModelMock = vi.fn().mockReturnValue('custom:openai:gpt-4o@hash');
      const getCustomModelsMock = vi.fn().mockReturnValue([
        {
          displayName: 'Some Other Model',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'key',
          modelId: 'gpt-4o',
          enabled: true,
        }
      ]);

      const testConfig = {
        ...baseMockConfig,
        getModel: getModelMock,
        getCustomModels: getCustomModelsMock,
      } as unknown as Config;

      const tool = new WebFetchTool(testConfig);
      const params = { prompt: 'fetch https://example.com' };

      const result = await tool.execute(params, new AbortController().signal);

      expect(result.llmContent).toContain('is currently unavailable because you are using custom models');
      expect(result.returnDisplay).toBe('Tool unavailable: Gemini Flash required');
    });
  });
});
