/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { WebFetchTool } from './web-fetch.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ToolConfirmationOutcome } from './tools.js';

const securityMocks = vi.hoisted(() => ({
  assertPublicWebUrl: vi.fn().mockResolvedValue(new URL('https://example.com')),
  safeFetchPublicUrl: vi.fn(),
}));

vi.mock('./web-fetch-security.js', () => securityMocks);

describe('WebFetchTool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

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
      getOttoClient: () => ({
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

    it('custom model without Gemini Flash directly receives fetched page content', async () => {
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
      securityMocks.safeFetchPublicUrl.mockResolvedValueOnce(
        new Response(
          '<html><body><h1>Example page</h1><p>DeepSeek can read this.</p></body></html>',
          { status: 200 },
        ),
      );

      const result = await tool.execute(params, new AbortController().signal);

      expect(result.llmContent).toContain('Web content fetched successfully');
      expect(String(result.llmContent).toLowerCase()).toContain('example page');
      expect(result.llmContent).toContain('DeepSeek can read this.');
      expect(result.returnDisplay).toContain('https://example.com');
      expect(createTemporaryChatMock).not.toHaveBeenCalled();
    });

    it('blocks private destinations before any model or fetch is called', async () => {
      securityMocks.assertPublicWebUrl.mockRejectedValueOnce(
        new Error('web_fetch blocked non-public address: 127.0.0.1'),
      );
      const testConfig = {
        ...baseMockConfig,
        getModel: vi.fn().mockReturnValue('gemini-2.5-flash'),
      } as unknown as Config;

      const result = await new WebFetchTool(testConfig).execute(
        { prompt: 'fetch http://127.0.0.1/admin' },
        new AbortController().signal,
      );

      expect(String(result.llmContent)).toContain('blocked non-public address');
      expect(createTemporaryChatMock).not.toHaveBeenCalled();
      expect(securityMocks.safeFetchPublicUrl).not.toHaveBeenCalled();
    });
  });
});
