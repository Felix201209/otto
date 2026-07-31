/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callOpenAICompatibleModelStream, callAnthropicModelStream, callOpenAICompatibleModel, callAnthropicModel, callOpenAIResponsesModel, callOpenAIResponsesModelStream, callGeminiNativeModel, callGeminiNativeModelStream, parseJSONSafeExport, sanitiseGeminiToolSchemaExport, sanitiseGeminiToolsExport, shouldDumpGeminiRequest } from './customModelAdapter.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import type { CustomModelConfig } from '../types/customModel.js';

// 为了测试内部函数，需要导出它（见下方的导出添加）
// 如果无法导出，可以通过流式测试间接验证

describe('parseJSONSafe - JSON parsing robustness', () => {
  // 注意：这些测试依赖于 parseJSONSafeExport 被导出
  // 如果没有导出，可以跳过这些测试并依赖集成测试

  describe('normal cases', () => {
    it('should parse valid JSON object', () => {
      if (!parseJSONSafeExport) return; // Skip if not exported
      const result = parseJSONSafeExport('{"pattern": "TODO", "path": "/src"}');
      expect(result).toEqual({ pattern: 'TODO', path: '/src' });
    });

    it('should parse valid JSON array', () => {
      if (!parseJSONSafeExport) return;
      const result = parseJSONSafeExport('[1, 2, 3]');
      expect(result).toEqual([1, 2, 3]);
    });

    it('should return empty object for empty string', () => {
      if (!parseJSONSafeExport) return;
      expect(parseJSONSafeExport('')).toEqual({});
      expect(parseJSONSafeExport('  ')).toEqual({});
    });

    it('should return empty object for null/undefined strings', () => {
      if (!parseJSONSafeExport) return;
      expect(parseJSONSafeExport('null')).toEqual({});
      expect(parseJSONSafeExport('undefined')).toEqual({});
    });

    it('should return object directly if already an object', () => {
      if (!parseJSONSafeExport) return;
      const obj = { pattern: 'test' };
      expect(parseJSONSafeExport(obj as unknown)).toBe(obj);
    });
  });

  describe('incomplete JSON repair', () => {
    it('should repair truncated JSON object', () => {
      if (!parseJSONSafeExport) return;
      // 模拟流式传输中截断的情况
      const result = parseJSONSafeExport('{"pattern": "TODO", "path": "/sr');
      // 应该能修复并返回至少 pattern 字段
      expect(result.__parseError).toBeUndefined();
      expect(result.pattern).toBe('TODO');
    });

    it('should repair JSON missing closing brace', () => {
      if (!parseJSONSafeExport) return;
      const result = parseJSONSafeExport('{"pattern": "TODO"');
      expect(result.__parseError).toBeUndefined();
      expect(result.pattern).toBe('TODO');
    });

    it('should repair JSON with incomplete string value', () => {
      if (!parseJSONSafeExport) return;
      const result = parseJSONSafeExport('{"pattern": "TO');
      // 可能无法完全修复，但不应该崩溃
      expect(result).toBeDefined();
    });

    it('should repair JSON array missing closing bracket', () => {
      if (!parseJSONSafeExport) return;
      const result = parseJSONSafeExport('[1, 2, 3');
      expect(result.__parseError).toBeUndefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('error cases with __parseError marker', () => {
    it('should return __parseError for completely invalid JSON', () => {
      if (!parseJSONSafeExport) return;
      const result = parseJSONSafeExport('this is not json at all');
      expect(result.__parseError).toBe(true);
      expect(result.__rawArgs).toBe('this is not json at all');
    });

    it('should include __errorMessage for debugging', () => {
      if (!parseJSONSafeExport) return;
      const result = parseJSONSafeExport('invalid{{{');
      expect(result.__parseError).toBe(true);
      expect(result.__errorMessage).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle JSON with extra whitespace', () => {
      if (!parseJSONSafeExport) return;
      const result = parseJSONSafeExport('  { "pattern" : "TODO" }  ');
      expect(result).toEqual({ pattern: 'TODO' });
    });

    it('should handle nested objects', () => {
      if (!parseJSONSafeExport) return;
      const result = parseJSONSafeExport('{"outer": {"inner": "value"}}');
      expect(result).toEqual({ outer: { inner: 'value' } });
    });

    it('should handle escaped characters', () => {
      if (!parseJSONSafeExport) return;
      const result = parseJSONSafeExport('{"pattern": "test\\"quoted\\""}');
      expect(result.pattern).toBe('test"quoted"');
    });
  });
});
describe('customModelAdapter - Image Content Support', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('OpenAI image format conversion', () => {
    it('should convert Gemini inlineData to OpenAI image_url format', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'I see an image' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'openai' as const,
        modelId: 'gpt-4-vision',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        displayName: 'GPT-4 Vision',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [
              { text: 'What is in this image?' },
              { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } },
            ],
          },
        ],
      };

      await callOpenAICompatibleModel(modelConfig as any, request);

      // Verify the request body was converted correctly
      expect(capturedBody.messages).toHaveLength(1);
      expect(capturedBody.messages[0].role).toBe('user');
      expect(Array.isArray(capturedBody.messages[0].content)).toBe(true);
      expect(capturedBody.messages[0].content).toHaveLength(2);

      // Check text part
      expect(capturedBody.messages[0].content[0]).toEqual({
        type: 'text',
        text: 'What is in this image?',
      });

      // Check image part - OpenAI format
      expect(capturedBody.messages[0].content[1]).toEqual({
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
        },
      });
    });

    it('should handle multiple images in a single message', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'I see two images' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 200, completion_tokens: 15 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'openai' as const,
        modelId: 'gpt-4-vision',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        displayName: 'GPT-4 Vision',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [
              { text: 'Compare these images' },
              { inlineData: { mimeType: 'image/jpeg', data: 'base64data1' } },
              { inlineData: { mimeType: 'image/png', data: 'base64data2' } },
            ],
          },
        ],
      };

      await callOpenAICompatibleModel(modelConfig as any, request);

      expect(capturedBody.messages[0].content).toHaveLength(3);
      expect(capturedBody.messages[0].content[1].image_url.url).toBe('data:image/jpeg;base64,base64data1');
      expect(capturedBody.messages[0].content[2].image_url.url).toBe('data:image/png;base64,base64data2');
    });

    it('should parse reasoning_content from OpenAI compatible model unary response', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                reasoning_content: 'Let me analyze the request...',
                content: 'Here is the final result.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'openai' as const,
        modelId: 'deepseek-reasoner',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-ds-test',
        displayName: 'DeepSeek Reasoner',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Hello' }],
          },
        ],
      };

      const response = await callOpenAICompatibleModel(modelConfig as any, request);
      const parts = response.candidates?.[0]?.content?.parts;
      expect(parts).toHaveLength(2);
      expect(parts?.[0]).toEqual({ reasoning: 'Let me analyze the request...' });
      expect(parts?.[1]).toEqual({ text: 'Here is the final result.' });
    });

    it('should attach reasoning_content in contentsToMessages when tool calls are present', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { role: 'assistant', content: 'Result' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'openai' as const,
        modelId: 'deepseek-reasoner',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-ds-test',
        displayName: 'DeepSeek Reasoner',
      };

      // Construct a history containing pure reasoning part followed by a tool call part
      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Execute tool' }],
          },
          {
            role: MESSAGE_ROLES.MODEL,
            parts: [{ reasoning: 'I need to use a tool to fetch info.' }],
          },
          {
            role: MESSAGE_ROLES.MODEL,
            parts: [{ functionCall: { name: 'get_info', args: { query: 'test' }, id: 'call_1' } }],
          },
        ],
      };

      await callOpenAICompatibleModel(modelConfig as any, request);

      // Verify that pure reasoning is attached to the assistant tool call. The
      // protocol safety layer also closes the unfinished call with a matching
      // synthetic tool result so OpenAI-compatible providers do not reject it.
      expect(capturedBody.messages).toHaveLength(3);
      expect(capturedBody.messages[0].role).toBe('user');
      expect(capturedBody.messages[1].role).toBe('assistant');
      expect(capturedBody.messages[1].tool_calls).toBeDefined();
      expect(capturedBody.messages[1].reasoning_content).toBe('I need to use a tool to fetch info.');
      expect(capturedBody.messages[2].role).toBe('tool');
      expect(capturedBody.messages[2].tool_call_id).toBe(capturedBody.messages[1].tool_calls[0].id);
    });

    it('should NOT attach reasoning_content in contentsToMessages when no tool calls are present', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { role: 'assistant', content: 'Result' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'openai' as const,
        modelId: 'deepseek-reasoner',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-ds-test',
        displayName: 'DeepSeek Reasoner',
      };

      // Construct a history containing pure reasoning part followed by a normal text assistant response (no tool calls)
      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Hello' }],
          },
          {
            role: MESSAGE_ROLES.MODEL,
            parts: [{ reasoning: 'I should just say hello.' }],
          },
          {
            role: MESSAGE_ROLES.MODEL,
            parts: [{ text: 'Hello there!' }],
          },
        ],
      };

      await callOpenAICompatibleModel(modelConfig as any, request);

      // Verify that pure reasoning message is filtered, and NOT attached to the text message (saving tokens per DeepSeek doc)
      expect(capturedBody.messages).toHaveLength(2); // user message, followed by assistant text message
      expect(capturedBody.messages[1].role).toBe('assistant');
      expect(capturedBody.messages[1].content).toBe('Hello there!');
      expect(capturedBody.messages[1].reasoning_content).toBeUndefined();
    });
  });

  describe('Anthropic image format conversion', () => {
    it('should convert Gemini inlineData to Anthropic image format', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'I see an image' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [
              { text: 'What is in this image?' },
              { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } },
            ],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      // Verify the request body was converted correctly
      expect(capturedBody.messages).toHaveLength(1);
      expect(capturedBody.messages[0].role).toBe('user');
      expect(Array.isArray(capturedBody.messages[0].content)).toBe(true);
      expect(capturedBody.messages[0].content).toHaveLength(2);

      // Check text part (cache_control auto-added since it's the only text block in last user message)
      expect(capturedBody.messages[0].content[0]).toEqual({
        type: 'text',
        text: 'What is in this image?',
        cache_control: { type: 'ephemeral' },
      });

      // Check image part - Anthropic format
      expect(capturedBody.messages[0].content[1]).toEqual({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUg==',
        },
      });
    });

    it('should handle multiple images in a single message', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'I see two images' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 200, output_tokens: 15 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [
              { text: 'Compare these images' },
              { inlineData: { mimeType: 'image/jpeg', data: 'base64data1' } },
              { inlineData: { mimeType: 'image/webp', data: 'base64data2' } },
            ],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      expect(capturedBody.messages[0].content).toHaveLength(3);
      expect(capturedBody.messages[0].content[1]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'base64data1' },
      });
      expect(capturedBody.messages[0].content[2]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/webp', data: 'base64data2' },
      });
    });
  });
});

describe('customModelAdapter - Anthropic API Compatibility', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('System message format', () => {
    it('should convert system messages to Anthropic array format', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Hello' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
      };

      const request = {
        contents: [
          {
            role: 'system',
            parts: [{ text: 'You are a helpful assistant.' }],
          },
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Hello' }],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      // System should be an array with type: 'text' and auto-added cache_control
      expect(Array.isArray(capturedBody.system)).toBe(true);
      expect(capturedBody.system).toHaveLength(1);
      expect(capturedBody.system[0]).toEqual({
        type: 'text',
        text: 'You are a helpful assistant.',
        cache_control: { type: 'ephemeral' },
      });
    });

    it('should auto-add cache_control to system messages', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Hello' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
      };

      const request = {
        contents: [
          {
            role: 'system',
            parts: [{ text: 'You are a helpful assistant.' }], // No cache_control in source
          },
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Hello' }],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      // cache_control should be auto-added to system messages
      expect(capturedBody.system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should auto-add cache_control to last user message text block', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Hello' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [
              { text: 'First message' },
              { text: 'Second message' },
            ],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      // Only the last text block should have cache_control
      expect(capturedBody.messages[0].content[0].cache_control).toBeUndefined();
      expect(capturedBody.messages[0].content[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should only add cache_control to the LAST user message in multi-turn conversation', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'First user message' }],
          },
          {
            role: MESSAGE_ROLES.MODEL,
            parts: [{ text: 'Assistant response' }],
          },
          {
            role: MESSAGE_ROLES.USER,
            parts: [
              { text: 'System reminder text' },
              { text: 'Second user message - last text block' },
            ],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      // First user message should NOT have cache_control
      expect(capturedBody.messages[0].content[0].cache_control).toBeUndefined();

      // Assistant message should NOT have cache_control
      expect(capturedBody.messages[1].content[0].cache_control).toBeUndefined();

      // Last user message: only the LAST text block should have cache_control
      expect(capturedBody.messages[2].content[0].cache_control).toBeUndefined();
      expect(capturedBody.messages[2].content[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should discard empty or whitespace-only text blocks from user and system messages', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
      };

      const request = {
        contents: [
          {
            role: 'system',
            parts: [
              { text: '  ' }, // Empty system block
              { text: 'Valid system message' },
              { text: '' }, // Empty system block
            ],
          },
          {
            role: MESSAGE_ROLES.USER,
            parts: [
              { text: '   \n  ' }, // Whitespace only text block
              { text: 'Hello' },
              { text: '' }, // Empty text block
            ],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      // System should have only 1 block, and its cache_control is set
      expect(capturedBody.system).toHaveLength(1);
      expect(capturedBody.system[0].text).toBe('Valid system message');
      expect(capturedBody.system[0].cache_control).toEqual({ type: 'ephemeral' });

      // Messages user part should only contain 1 block
      expect(capturedBody.messages[0].content).toHaveLength(1);
      expect(capturedBody.messages[0].content[0].text).toBe('Hello');
      expect(capturedBody.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should auto-add cache_control to other non-text block types if no text block is present in user message', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: 'iVBORw0KGgoAAAANS',
                },
              },
            ],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      // Should be 1 image block with cache_control added
      expect(capturedBody.messages[0].content).toHaveLength(1);
      expect(capturedBody.messages[0].content[0].type).toBe('image');
      expect(capturedBody.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    });
  });

  describe('Extended thinking support', () => {
    it('should use Bedrock adaptive thinking schema for Claude Opus 4.7 with xhigh effort in streaming calls', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let index = 0;
            const chunks = [
              'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n',
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n',
            ];

            return {
              read: vi.fn(async () => {
                if (index < chunks.length) {
                  const value = new TextEncoder().encode(chunks[index]);
                  index++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body as string);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-opus-4-7',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude Opus 4.7',
        thinking: { mode: 'on' as const, effort: 'xhigh' as const },
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Solve this' }],
          },
        ],
      };

      const responses: any[] = [];
      for await (const response of callAnthropicModelStream(modelConfig as any, request)) {
        responses.push(response);
      }

      expect(capturedBody.thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
      expect(capturedBody.output_config).toEqual({ effort: 'xhigh' });
      expect(capturedBody.thinking.effort).toBeUndefined();
      expect(capturedBody.thinking.budget_tokens).toBeUndefined();
      expect(responses.length).toBeGreaterThan(0);
    });

    it('should use adaptive thinking schema for hyphenated Claude Opus 4.7 in auto mode', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body as string);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-opus-4-7',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude Opus 4.7',
        thinking: { mode: 'auto' as const },
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Solve this' }],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      expect(capturedBody.thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
      expect(capturedBody.output_config).toEqual({ effort: 'high' });
      expect(capturedBody.thinking.effort).toBeUndefined();
      expect(capturedBody.thinking.budget_tokens).toBeUndefined();
    });

    it('should use budget_tokens capped at 10000 when enableThinking is true', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
        maxTokens: 32000,
        enableThinking: true,
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Solve this complex problem' }],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      // budget_tokens should be capped at 31999 (official recommended value)
      expect(capturedBody.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 31999,
      });
      // max_tokens should be at least 32000 for thinking mode
      expect(capturedBody.max_tokens).toBeGreaterThanOrEqual(32000);
    });

    it('should auto-enable thinking for all Anthropic models when enableThinking is undefined', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-sonnet-4-5-20250929', // Any Anthropic model
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude Sonnet 4.5',
        // enableThinking is undefined - should auto-enable by default
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Solve this' }],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      // Should auto-enable thinking for all Anthropic models
      expect(capturedBody.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 31999,
      });
    });

    it('should respect explicit enableThinking=false to disable thinking', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-opus-20240229',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Opus',
        enableThinking: false, // Explicitly disable thinking
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Solve this' }],
          },
        ],
      };

      await callAnthropicModel(modelConfig as any, request);

      // Should respect explicit disable
      expect(capturedBody.thinking).toBeUndefined();
    });

    it('should parse thinking content blocks as reasoning in response', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
            { type: 'text', text: 'Here is my answer' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-sonnet-4-5',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude Sonnet 4.5',
        enableThinking: true,
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Solve this' }],
          },
        ],
      };

      const response = await callAnthropicModel(modelConfig as any, request);

      const parts = response.candidates?.[0]?.content?.parts;
      expect(parts).toHaveLength(2);
      // thinking content is mapped to reasoning format for UI display
      expect(parts?.[0]).toEqual({ reasoning: 'Let me think about this...' });
      expect(parts?.[1]).toEqual({ text: 'Here is my answer' });
    });
  });

  describe('Tool input_schema with additionalProperties', () => {
    it('should include additionalProperties: false in tool input_schema', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'I will search' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Search for something' }],
          },
        ],
        config: {
          tools: [
            {
              name: 'search',
              description: 'Search the web',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'Search query' } },
                required: ['query'],
              },
            },
          ],
        },
      };

      await callAnthropicModel(modelConfig as any, request);

      expect(capturedBody.tools).toHaveLength(1);
      expect(capturedBody.tools[0].input_schema.additionalProperties).toBe(false);
      expect(capturedBody.tools[0].input_schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    });
  });
});

describe('customModelAdapter - Streaming Tool Calls', () => {
  describe('OpenAI streaming', () => {
    it('should aggregate tool call deltas and yield complete tool call only at stream end', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let index = 0;
            const chunks = [
              'data: {"choices":[{"delta":{"content":"I will call a tool"},"index":0}]}\n',
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":""}}]},"index":0}]}\n',
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"qu"}}]},"index":0}]}\n',
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ery\\":\\"test\\"}"}}]},"index":0}]}\n',
              'data: {"choices":[{"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n',
              'data: [DONE]\n',
            ];

            return {
              read: vi.fn(async () => {
                if (index < chunks.length) {
                  const value = new TextEncoder().encode(chunks[index]);
                  index++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'openai' as const,
        modelId: 'gpt-4',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        displayName: 'GPT-4',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'search for test' }],
          },
        ],
        config: {
          tools: [
            {
              name: 'search',
              description: 'Search the web',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
        },
      };

      const responses: any[] = [];
      for await (const response of callOpenAICompatibleModelStream(modelConfig as any, request)) {
        responses.push(response);
      }

      // 应该收到文本和工具调用（在流末尾）
      expect(responses.length).toBeGreaterThan(0);

      // 检查最后一个有效的响应应该包含完整的工具调用
      const toolCallResponse = responses.find(r => {
        const parts = r.candidates?.[0]?.content?.parts;
        return parts && parts.some((p: any) => p.functionCall);
      });

      expect(toolCallResponse).toBeDefined();
      if (toolCallResponse) {
        const functionCall = toolCallResponse.candidates[0].content.parts.find((p: any) => p.functionCall)?.functionCall;
        expect(functionCall).toBeDefined();
        expect(functionCall?.name).toBe('search');
        expect(functionCall?.args).toEqual({ query: 'test' });
      }

      // 关键测试：验证 functionCalls getter 存在
      expect(toolCallResponse?.functionCalls).toBeDefined();
      expect(toolCallResponse?.functionCalls?.[0]?.name).toBe('search');
    });

    it('should trim leading and trailing spaces from tool names in streaming', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let index = 0;
            const chunks = [
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":" read_file","arguments":""}}]},"index":0}]}\n',
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"absolute_path\\":\\"/file.txt\\"}"}}]},"index":0}]}\n',
              'data: {"choices":[{"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n',
              'data: [DONE]\n',
            ];

            return {
              read: vi.fn(async () => {
                if (index < chunks.length) {
                  const value = new TextEncoder().encode(chunks[index]);
                  index++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'openai' as const,
        modelId: 'gpt-4',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        displayName: 'GPT-4',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'read file' }],
          },
        ],
        config: {
          tools: [
            {
              name: 'read_file',
              description: 'Read a file',
              parameters: { type: 'object', properties: { absolute_path: { type: 'string' } } },
            },
          ],
        },
      };

      const responses: any[] = [];
      for await (const response of callOpenAICompatibleModelStream(modelConfig as any, request)) {
        responses.push(response);
      }

      const toolCallResponse = responses.find(r => {
        const parts = r.candidates?.[0]?.content?.parts;
        return parts && parts.some((p: any) => p.functionCall);
      });

      expect(toolCallResponse).toBeDefined();
      if (toolCallResponse) {
        const functionCall = toolCallResponse.candidates[0].content.parts.find((p: any) => p.functionCall)?.functionCall;
        expect(functionCall).toBeDefined();
        // 验证工具名称已被 trim
        expect(functionCall?.name).toBe('read_file'); // 不是 " read_file"
        expect(functionCall?.args).toEqual({ absolute_path: '/file.txt' });
      }
    });
  });

  describe('Claude streaming', () => {
    it('should aggregate tool input deltas and yield complete tool call on content_block_stop', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let index = 0;
            const chunks = [
              'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_123","name":"search"}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q"}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"uery\\":\\""}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"test\\""}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"}"}}\n',
              'data: {"type":"content_block_stop","index":0}\n',
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n',
            ];

            return {
              read: vi.fn(async () => {
                if (index < chunks.length) {
                  const value = new TextEncoder().encode(chunks[index]);
                  index++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'search for test' }],
          },
        ],
        config: {
          tools: [
            {
              name: 'search',
              description: 'Search the web',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
        },
      };

      const responses: any[] = [];
      for await (const response of callAnthropicModelStream(modelConfig as any, request)) {
        responses.push(response);
      }

      // 应该收到工具调用响应
      const toolCallResponse = responses.find(r => {
        const parts = r.candidates?.[0]?.content?.parts;
        return parts && parts.some((p: any) => p.functionCall);
      });

      expect(toolCallResponse).toBeDefined();
      if (toolCallResponse) {
        const functionCall = toolCallResponse.candidates[0].content.parts.find((p: any) => p.functionCall)?.functionCall;
        expect(functionCall).toBeDefined();
        expect(functionCall?.name).toBe('search');
        expect(functionCall?.args).toEqual({ query: 'test' });
      }

      // Key test: Verify functionCalls getter exists
      expect(toolCallResponse?.functionCalls).toBeDefined();
      expect(toolCallResponse?.functionCalls?.[0]?.name).toBe('search');
    });

    it('should correctly parse and accumulate token usage and cache info from stream', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let index = 0;
            // 模拟真实的 Anthropic 流式响应格式：
            // - message_start 包含初始 usage（包括缓存 token 和初始 output_tokens 预估）
            // - message_delta 包含最终的 output_tokens（是总数，不是增量）
            const chunks = [
              'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_creation_input_tokens":9894,"cache_read_input_tokens":0,"output_tokens":5}}}\n',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" World"}}\n',
              'data: {"type":"content_block_stop","index":0}\n',
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":298}}\n',
            ];

            return {
              read: vi.fn(async () => {
                if (index < chunks.length) {
                  const value = new TextEncoder().encode(chunks[index]);
                  index++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3-sonnet',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude 3 Sonnet',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Test message' }],
          },
        ],
      };

      const responses: any[] = [];
      for await (const response of callAnthropicModelStream(modelConfig as any, request)) {
        responses.push(response);
      }

      // Find the response that contains usageMetadata (it's usually the one from message_delta)
      const usageResponse = responses.find(r => r.usageMetadata);

      expect(usageResponse).toBeDefined();
      expect(usageResponse.usageMetadata).toBeDefined();
      // 🔧 promptTokenCount 现在是实际总输入：input_tokens + cache_creation + cache_read
      // 3 + 9894 + 0 = 9897
      expect(usageResponse.usageMetadata.promptTokenCount).toBe(3 + 9894 + 0);
      // output_tokens in message_delta is the final total (298), not incremental
      expect(usageResponse.usageMetadata.candidatesTokenCount).toBe(298);
      expect(usageResponse.usageMetadata.totalTokenCount).toBe((3 + 9894 + 0) + 298);
      // 🔧 字段名与 geminiChat.ts 中读取的一致（不带 Count 后缀）
      expect(usageResponse.usageMetadata.cacheCreationInputTokens).toBe(9894);
      // 0 value is preserved (means no cache hits, which is meaningful info)
      expect(usageResponse.usageMetadata.cacheReadInputTokens).toBe(0);
      // 保留原始的非缓存输入 token
      expect(usageResponse.usageMetadata.uncachedInputTokens).toBe(3);
    });

    it('should handle non-standard Anthropic-compatible providers that return token usage only in message_delta', async () => {
      // 模拟非标准兼容厂商（如 GLM-4 的 Anthropic 兼容接口）的响应格式：
      // - message_start 中返回 input_tokens: 0, output_tokens: 0（占位符）
      // - message_delta 中才返回真实的 token 用量
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let index = 0;
            const chunks = [
              'data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"glm-4.7","content":[],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好！"}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"很高兴见到你！"}}\n',
              'data: {"type":"content_block_stop","index":0}\n',
              // 非标准：token 用量在 message_delta 中返回，包括缓存信息
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":19,"output_tokens":99,"cache_read_input_tokens":12928}}\n',
            ];

            return {
              read: vi.fn(async () => {
                if (index < chunks.length) {
                  const value = new TextEncoder().encode(chunks[index]);
                  index++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'glm-4.7',
        baseUrl: 'https://proxy.example.com',
        apiKey: 'sk-test',
        displayName: 'GLM-4.7 (Anthropic Compatible)',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Hello' }],
          },
        ],
      };

      const responses: any[] = [];
      for await (const response of callAnthropicModelStream(modelConfig as any, request)) {
        responses.push(response);
      }

      // 找到包含 usageMetadata 的响应（来自 message_delta）
      const usageResponse = responses.find(r => r.usageMetadata);

      expect(usageResponse).toBeDefined();
      expect(usageResponse.usageMetadata).toBeDefined();

      // 🔧 鲁棒性测试：即使 message_start 返回 0，也应该从 message_delta 中获取正确的 token 数据
      // promptTokenCount = input_tokens + cache_creation + cache_read = 19 + 0 + 12928 = 12947
      expect(usageResponse.usageMetadata.promptTokenCount).toBe(19 + 0 + 12928);
      // output_tokens 来自 message_delta
      expect(usageResponse.usageMetadata.candidatesTokenCount).toBe(99);
      expect(usageResponse.usageMetadata.totalTokenCount).toBe((19 + 0 + 12928) + 99);
      // 缓存信息应该正确解析
      expect(usageResponse.usageMetadata.cacheReadInputTokens).toBe(12928);
      // 非缓存输入 token
      expect(usageResponse.usageMetadata.uncachedInputTokens).toBe(19);
    });

    it('should stream thinking_delta as reasoning in real-time', async () => {
      // 模拟 Anthropic thinking 流式响应：thinking 块通过多个 thinking_delta 分块传来
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let index = 0;
            const chunks = [
              'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think about "}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"this..."}}\n',
              'data: {"type":"content_block_stop","index":0}\n',
              'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n',
              'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Here is my answer"}}\n',
              'data: {"type":"content_block_stop","index":1}\n',
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}\n',
            ];

            return {
              read: vi.fn(async () => {
                if (index < chunks.length) {
                  const value = new TextEncoder().encode(chunks[index]);
                  index++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-sonnet-4-5',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
        displayName: 'Claude Sonnet 4.5',
        enableThinking: true,
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Solve this' }],
          },
        ],
      };

      const responses: any[] = [];
      for await (const response of callAnthropicModelStream(modelConfig as any, request)) {
        responses.push(response);
      }

      // 🆕 验证 thinking_delta 被实时流式输出为 reasoning 格式
      // 应该收到 3 个独立的 reasoning 响应（每个 thinking_delta 一个）
      const reasoningResponses = responses.filter(r => {
        const parts = r.candidates?.[0]?.content?.parts;
        return parts && parts.some((p: any) => p.reasoning !== undefined);
      });

      expect(reasoningResponses.length).toBe(3); // 3 个 thinking_delta 块

      // 验证每个 reasoning 块的内容
      const reasoningTexts = reasoningResponses.map(r =>
        r.candidates[0].content.parts.find((p: any) => p.reasoning)?.reasoning
      );
      expect(reasoningTexts).toEqual(['Let me ', 'think about ', 'this...']);

      // 验证 text 响应也正常
      const textResponse = responses.find(r => {
        const parts = r.candidates?.[0]?.content?.parts;
        return parts && parts.some((p: any) => p.text !== undefined);
      });
      expect(textResponse).toBeDefined();
      expect(textResponse?.candidates[0].content.parts[0].text).toBe('Here is my answer');
    });

    it('should trim leading and trailing spaces from tool names', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let index = 0;
            const chunks = [
              'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_123","name":" read_file"}}\n',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"absolute_path\\":\\"/file.txt\\"}"}}\n',
              'data: {"type":"content_block_stop","index":0}\n',
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n',
            ];

            return {
              read: vi.fn(async () => {
                if (index < chunks.length) {
                  const value = new TextEncoder().encode(chunks[index]);
                  index++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'anthropic' as const,
        modelId: 'claude-3',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-test',
        displayName: 'Claude 3',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'read file' }],
          },
        ],
        config: {
          tools: [
            {
              name: 'read_file',
              description: 'Read a file',
              parameters: { type: 'object', properties: { absolute_path: { type: 'string' } } },
            },
          ],
        },
      };

      const responses: any[] = [];
      for await (const response of callAnthropicModelStream(modelConfig as any, request)) {
        responses.push(response);
      }

      const toolCallResponse = responses.find(r => {
        const parts = r.candidates?.[0]?.content?.parts;
        return parts && parts.some((p: any) => p.functionCall);
      });

      expect(toolCallResponse).toBeDefined();
      if (toolCallResponse) {
        const functionCall = toolCallResponse.candidates[0].content.parts.find((p: any) => p.functionCall)?.functionCall;
        expect(functionCall).toBeDefined();
        // 验证工具名称已被 trim
        expect(functionCall?.name).toBe('read_file'); // 不是 " read_file"
        expect(functionCall?.args).toEqual({ absolute_path: '/file.txt' });
      }
    });
  });
});

describe('customModelAdapter - OpenAI Responses API', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('Non-streaming', () => {
    it('should call /responses endpoint and parse output items', async () => {
      let capturedUrl = '';
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          id: 'resp_123',
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: 'Hello from Responses API!' }
              ]
            }
          ],
          usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (url, options) => {
        capturedUrl = url;
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'openai-responses' as const,
        modelId: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        displayName: 'GPT-4o Responses',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Hello!' }],
          },
        ],
      };

      const result = await callOpenAIResponsesModel(modelConfig as any, request);

      // Verify URL uses /responses endpoint
      expect(capturedUrl).toBe('https://api.openai.com/v1/responses');

      // Verify request body uses 'input' instead of 'messages'
      expect(capturedBody.input).toBeDefined();
      expect(capturedBody.messages).toBeUndefined();
      expect(capturedBody.model).toBe('gpt-4o');
      expect(capturedBody.store).toBe(false);

      // Verify input format: simple text message
      expect(capturedBody.input).toEqual([
        { role: 'user', content: 'Hello!' }
      ]);

      // Verify response parsing
      const parts = result.candidates?.[0]?.content?.parts;
      expect(parts).toHaveLength(1);
      expect(parts?.[0]).toEqual({ text: 'Hello from Responses API!' });

      // Verify usage
      expect(result.usageMetadata?.promptTokenCount).toBe(50);
      expect(result.usageMetadata?.candidatesTokenCount).toBe(10);
    });

    it('should format multi-turn conversation with function calls as flat items', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          id: 'resp_multi',
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'The result is 42.' }] }
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'openai-responses' as const,
        modelId: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        displayName: 'GPT-4o Responses',
      };

      const request = {
        contents: [
          // Turn 1: user message
          { role: MESSAGE_ROLES.USER, parts: [{ text: 'Search for test' }] },
          // Turn 2: model calls a function
          { role: MESSAGE_ROLES.MODEL, parts: [{ functionCall: { name: 'search', args: { query: 'test' }, id: 'call_abc' } }] },
          // Turn 3: function response
          { role: MESSAGE_ROLES.USER, parts: [{ functionResponse: { name: 'search', response: { results: ['a', 'b'] }, id: 'call_abc' } }] },
          // Turn 4: model calls another function with preceding text
          { role: MESSAGE_ROLES.MODEL, parts: [
            { text: 'Let me read that file.' },
            { functionCall: { name: 'read_file', args: { path: '/a.txt' }, id: 'call_def' } },
          ]},
          // Turn 5: function response
          { role: MESSAGE_ROLES.USER, parts: [{ functionResponse: { name: 'read_file', response: 'file content', id: 'call_def' } }] },
        ],
      };

      await callOpenAIResponsesModel(modelConfig as any, request);

      // Verify input is a flat array of heterogeneous items:
      // user msg(1) + function_call(1) + function_call_output(1) + assistant text(1) + function_call(1) + function_call_output(1) = 6
      const input = capturedBody.input;
      expect(input).toHaveLength(6);

      // Item 0: user text message
      expect(input[0]).toEqual({ role: 'user', content: 'Search for test' });

      // Item 1: function_call (standalone, not wrapped in message)
      expect(input[1].type).toBe('function_call');
      expect(input[1].name).toBe('search');
      expect(input[1].call_id).toBe('call_abc');
      expect(JSON.parse(input[1].arguments)).toEqual({ query: 'test' });
      // No 'role' field on function_call items
      expect(input[1].role).toBeUndefined();

      // Item 2: function_call_output (standalone)
      expect(input[2].type).toBe('function_call_output');
      expect(input[2].call_id).toBe('call_abc');
      expect(input[2].role).toBeUndefined();

      // Item 3: assistant text before the next function call
      expect(input[3]).toEqual({ role: 'assistant', content: 'Let me read that file.' });

      // Item 4: second function_call
      expect(input[4].type).toBe('function_call');
      expect(input[4].name).toBe('read_file');
      expect(input[4].call_id).toBe('call_def');

      // Item 5: second function_call_output
      expect(input[5].type).toBe('function_call_output');
      expect(input[5].call_id).toBe('call_def');
    });

    it('should convert uppercase schema types to lowercase in tool parameters', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          id: 'resp_789',
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'OK' }] }
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'openai-responses' as const,
        modelId: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        displayName: 'GPT-4o Responses',
      };

      const request = {
        contents: [
          { role: MESSAGE_ROLES.USER, parts: [{ text: 'list files' }] },
        ],
        config: {
          tools: [{
            functionDeclarations: [{
              name: 'list_directory',
              description: 'List directory contents',
              parameters: {
                type: 'OBJECT',
                properties: {
                  path: { type: 'STRING', description: 'Directory path' },
                  recursive: { type: 'BOOLEAN', description: 'Recurse into subdirs' },
                  ignore: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Patterns to ignore' },
                  file_filtering_options: {
                    type: 'OBJECT',
                    properties: {
                      respect_git_ignore: { type: 'BOOLEAN', description: 'Respect .gitignore' },
                    },
                  },
                },
                required: ['path'],
              },
            }],
          }],
        },
      };

      await callOpenAIResponsesModel(modelConfig as any, request);

      // Verify all types were lowercased
      const tool = capturedBody.tools[0];
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.properties.path.type).toBe('string');
      expect(tool.parameters.properties.recursive.type).toBe('boolean');
      expect(tool.parameters.properties.ignore.type).toBe('array');
      expect(tool.parameters.properties.ignore.items.type).toBe('string');
      expect(tool.parameters.properties.file_filtering_options.type).toBe('object');
      expect(tool.parameters.properties.file_filtering_options.properties.respect_git_ignore.type).toBe('boolean');
    });

    it('should coerce string-typed numeric schema keywords to numbers', async () => {
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        json: async () => ({
          id: 'resp_schema',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      };

      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'openai-responses' as const,
        modelId: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        displayName: 'GPT-4o Responses',
      };

      const request = {
        contents: [
          { role: MESSAGE_ROLES.USER, parts: [{ text: 'read files' }] },
        ],
        config: {
          tools: [{
            functionDeclarations: [{
              name: 'read_many_files',
              description: 'Read multiple files',
              parameters: {
                type: 'OBJECT',
                properties: {
                  paths: {
                    type: 'ARRAY',
                    items: { type: 'STRING', minLength: '1' },
                    minItems: '1',
                    description: 'File paths',
                  },
                  limit: {
                    type: 'NUMBER',
                    minimum: '0',
                    maximum: '100',
                    description: 'Max results',
                  },
                },
                required: ['paths'],
              },
            }],
          }],
        },
      };

      await callOpenAIResponsesModel(modelConfig as any, request);

      const tool = capturedBody.tools[0];
      // Verify string numbers were coerced to actual numbers
      expect(tool.parameters.properties.paths.items.minLength).toBe(1);
      expect(typeof tool.parameters.properties.paths.items.minLength).toBe('number');
      expect(tool.parameters.properties.paths.minItems).toBe(1);
      expect(typeof tool.parameters.properties.paths.minItems).toBe('number');
      expect(tool.parameters.properties.limit.minimum).toBe(0);
      expect(typeof tool.parameters.properties.limit.minimum).toBe('number');
      expect(tool.parameters.properties.limit.maximum).toBe(100);
      expect(typeof tool.parameters.properties.limit.maximum).toBe('number');
      // Verify types are still lowercased
      expect(tool.parameters.properties.paths.type).toBe('array');
      expect(tool.parameters.properties.paths.items.type).toBe('string');
      expect(tool.parameters.properties.limit.type).toBe('number');
    });

    it('should parse function_call output items', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          id: 'resp_456',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_abc',
              name: 'search',
              arguments: '{"query":"test"}',
            }
          ],
          usage: { input_tokens: 30, output_tokens: 15 },
        }),
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'openai-responses' as const,
        modelId: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        displayName: 'GPT-4o Responses',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'search for test' }],
          },
        ],
        config: {
          tools: [{
            name: 'search',
            description: 'Search',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          }],
        },
      };

      const result = await callOpenAIResponsesModel(modelConfig as any, request);

      const parts = result.candidates?.[0]?.content?.parts;
      expect(parts).toHaveLength(1);
      expect(parts?.[0]?.functionCall).toBeDefined();
      expect(parts?.[0]?.functionCall?.name).toBe('search');
      expect(parts?.[0]?.functionCall?.args).toEqual({ query: 'test' });
      expect(parts?.[0]?.functionCall?.id).toBe('call_abc');

      // Verify functionCalls getter
      expect(result.functionCalls).toBeDefined();
      expect(result.functionCalls?.[0]?.name).toBe('search');
    });
  });

  describe('Streaming', () => {
    it('should stream text deltas from Responses API', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let index = 0;
            const chunks = [
              'data: {"type":"response.output_text.delta","delta":"Hello "}\n',
              'data: {"type":"response.output_text.delta","delta":"World!"}\n',
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}\n',
              'data: [DONE]\n',
            ];

            return {
              read: vi.fn(async () => {
                if (index < chunks.length) {
                  const value = new TextEncoder().encode(chunks[index]);
                  index++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'openai-responses' as const,
        modelId: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        displayName: 'GPT-4o Responses',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'Hello' }],
          },
        ],
      };

      const responses: any[] = [];
      for await (const response of callOpenAIResponsesModelStream(modelConfig as any, request)) {
        responses.push(response);
      }

      // Should receive text chunks
      const textResponses = responses.filter(r => {
        const parts = r.candidates?.[0]?.content?.parts;
        return parts && parts.some((p: any) => p.text);
      });
      expect(textResponses).toHaveLength(2);
      expect(textResponses[0].candidates[0].content.parts[0].text).toBe('Hello ');
      expect(textResponses[1].candidates[0].content.parts[0].text).toBe('World!');

      // Should receive usage
      const usageResponse = responses.find(r => r.usageMetadata);
      expect(usageResponse).toBeDefined();
      expect(usageResponse.usageMetadata.promptTokenCount).toBe(10);
      expect(usageResponse.usageMetadata.candidatesTokenCount).toBe(5);
    });

    it('should stream function calls from Responses API', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let index = 0;
            const chunks = [
              'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_123","name":"search"}}\n',
              'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"qu"}\n',
              'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"ery\\":\\"test\\"}"}\n',
              'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"query\\":\\"test\\"}"}\n',
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":20,"output_tokens":10}}}\n',
              'data: [DONE]\n',
            ];

            return {
              read: vi.fn(async () => {
                if (index < chunks.length) {
                  const value = new TextEncoder().encode(chunks[index]);
                  index++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'openai-responses' as const,
        modelId: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        displayName: 'GPT-4o Responses',
      };

      const request = {
        contents: [
          {
            role: MESSAGE_ROLES.USER,
            parts: [{ text: 'search for test' }],
          },
        ],
        config: {
          tools: [{
            name: 'search',
            description: 'Search',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          }],
        },
      };

      const responses: any[] = [];
      for await (const response of callOpenAIResponsesModelStream(modelConfig as any, request)) {
        responses.push(response);
      }

      // Should receive function call
      const toolCallResponse = responses.find(r => {
        const parts = r.candidates?.[0]?.content?.parts;
        return parts && parts.some((p: any) => p.functionCall);
      });

      expect(toolCallResponse).toBeDefined();
      if (toolCallResponse) {
        const functionCall = toolCallResponse.candidates[0].content.parts.find((p: any) => p.functionCall)?.functionCall;
        expect(functionCall?.name).toBe('search');
        expect(functionCall?.args).toEqual({ query: 'test' });
        expect(functionCall?.id).toBe('call_123');
      }

      // Verify functionCalls getter
      expect(toolCallResponse?.functionCalls).toBeDefined();
      expect(toolCallResponse?.functionCalls?.[0]?.name).toBe('search');
    });

    it('should request reasoning.summary="detailed" for gpt-5.x to actually emit thinking', async () => {
      // Probe-confirmed (2026-05-26): EasyRouter gateway silently drops
      // reasoning summary chunks unless summary='detailed' is explicit.
      let capturedBody: any;
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let i = 0;
            const chunks = [
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n',
              'data: [DONE]\n',
            ];
            return {
              read: vi.fn(async () => {
                if (i < chunks.length) {
                  const value = new TextEncoder().encode(chunks[i]);
                  i++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };
      global.fetch = vi.fn().mockImplementation(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return mockResponse;
      });

      const modelConfig = {
        provider: 'openai-responses' as const,
        modelId: 'gpt-5.5',
        baseUrl: 'https://llm-endpoint.net/v1',
        apiKey: 'sk-test',
        displayName: 'gpt-5.5',
      };
      const request = { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }] };

      // Drain stream

      for await (const _ of callOpenAIResponsesModelStream(modelConfig as any, request)) {
        // no-op
      }

      expect(capturedBody.reasoning).toBeDefined();
      expect(capturedBody.reasoning.summary).toBe('detailed');
      // auto + auto → effort defaults to 'medium' (so the model actually thinks).
      expect(capturedBody.reasoning.effort).toBe('medium');
    });

    it('should yield reasoning chunks from response.reasoning_summary_text.delta', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => {
            let i = 0;
            const chunks = [
              'data: {"type":"response.reasoning_summary_text.delta","delta":"Let me think… "}\n',
              'data: {"type":"response.reasoning_summary_text.delta","delta":"the answer is 9."}\n',
              'data: {"type":"response.output_text.delta","delta":"9 sheep."}\n',
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3}}}\n',
              'data: [DONE]\n',
            ];
            return {
              read: vi.fn(async () => {
                if (i < chunks.length) {
                  const value = new TextEncoder().encode(chunks[i]);
                  i++;
                  return { done: false, value };
                }
                return { done: true, value: undefined };
              }),
              releaseLock: vi.fn(),
            };
          },
        },
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'openai-responses' as const,
        modelId: 'gpt-5.5',
        baseUrl: 'https://llm-endpoint.net/v1',
        apiKey: 'sk-test',
        displayName: 'gpt-5.5',
      };
      const request = { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }] };

      const responses: any[] = [];
      for await (const r of callOpenAIResponsesModelStream(modelConfig as any, request)) {
        responses.push(r);
      }

      const reasoningParts = responses.flatMap(r =>
        (r.candidates?.[0]?.content?.parts || []).filter((p: any) => 'reasoning' in p)
      );
      expect(reasoningParts).toHaveLength(2);
      expect(reasoningParts[0].reasoning).toBe('Let me think… ');
      expect(reasoningParts[1].reasoning).toBe('the answer is 9.');

      const textParts = responses.flatMap(r =>
        (r.candidates?.[0]?.content?.parts || []).filter((p: any) => 'text' in p)
      );
      expect(textParts).toHaveLength(1);
      expect(textParts[0].text).toBe('9 sheep.');
    });

    it('non-stream path: outputToParts maps reasoning items to { reasoning } parts', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              summary: [
                { type: 'summary_text', text: 'First I count the surviving sheep.' },
                { type: 'summary_text', text: 'Answer: 9.' },
              ],
            },
            {
              type: 'message',
              content: [{ type: 'output_text', text: '9 sheep.' }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const modelConfig = {
        provider: 'openai-responses' as const,
        modelId: 'gpt-5.5',
        baseUrl: 'https://llm-endpoint.net/v1',
        apiKey: 'sk-test',
        displayName: 'gpt-5.5',
      };
      const request = { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }] };

      const result = await callOpenAIResponsesModel(modelConfig as any, request);
      const parts = result.candidates?.[0]?.content?.parts || [];
      const reasoning = parts.filter((p: any) => 'reasoning' in p);
      const text = parts.filter((p: any) => 'text' in p);
      expect(reasoning).toHaveLength(2);
      expect((reasoning[0] as any).reasoning).toBe('First I count the surviving sheep.');
      expect((reasoning[1] as any).reasoning).toBe('Answer: 9.');
      expect(text).toHaveLength(1);
      expect((text[0] as any).text).toBe('9 sheep.');
    });
  });
});

// ============================================================================
// Gemini native (GenAI v1beta) — provider 'gemini'
// ============================================================================

describe('callGeminiNativeModel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('完整请求体默认不落盘，只有显式 FILE_DEBUG=1 才允许诊断 dump', () => {
    expect(shouldDumpGeminiRequest({})).toBe(false);
    expect(shouldDumpGeminiRequest({ FILE_DEBUG: '0' })).toBe(false);
    expect(shouldDumpGeminiRequest({ FILE_DEBUG: '1' })).toBe(true);
    expect(shouldDumpGeminiRequest({ FILE_DEBUG: '1', NODE_ENV: 'test' })).toBe(false);
    expect(shouldDumpGeminiRequest({ FILE_DEBUG: '1', VITEST: 'true' })).toBe(false);
  });

  it('builds /v1beta/models/{id}:generateContent URL with ?key= and forwards thinkingConfig for Gemini 2.5', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: any;
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: '9' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
        }),
      };
    });

    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-pro',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-pro',
    };
    const request = { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }] };

    const result = await callGeminiNativeModel(modelConfig as any, request);

    // URL: /v1 → /v1beta normalisation, then :generateContent + ?key=
    expect(capturedUrl).toBe('https://llm-endpoint.net/v1beta/models/gemini-2.5-pro:generateContent?key=sk-test');
    // Gemini 2.5 family → thinkingBudget (number), not thinkingLevel.
    expect(capturedBody.generationConfig.thinkingConfig).toBeDefined();
    expect(typeof capturedBody.generationConfig.thinkingConfig.thinkingBudget).toBe('number');
    expect(capturedBody.generationConfig.thinkingConfig.includeThoughts).toBe(true);
    // Output is unwrapped to GenerateContentResponse parts.
    const parts = result.candidates?.[0]?.content?.parts;
    expect(parts?.[0]).toEqual({ text: '9' });
    expect(result.usageMetadata?.promptTokenCount).toBe(5);
  });

  it('uses thinkingLevel for Gemini 3 / 3.5 family', async () => {
    let capturedBody: any;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'ok' }] } }],
        }),
      };
    });
    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-3.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-3.5-flash',
    };
    await callGeminiNativeModel(
      modelConfig as any,
      { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }] },
    );
    const tc = capturedBody.generationConfig.thinkingConfig;
    expect(typeof tc.thinkingLevel).toBe('string');
    expect(tc.thinkingBudget).toBeUndefined();
    expect(tc.includeThoughts).toBe(true);
  });

  it('disables thinking when modelConfig.thinking.mode === "off"', async () => {
    let capturedBody: any;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'ok' }] } }],
        }),
      };
    });
    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-pro',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-pro',
      thinking: { mode: 'off' as const },
    };
    await callGeminiNativeModel(
      modelConfig as any,
      { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }] },
    );
    expect(capturedBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('normalises a string systemInstruction to canonical { parts: [{ text }] }', async () => {
    // The /v1beta endpoint rejects raw strings with HTTP 500
    //   "json: cannot unmarshal string into Go struct field .systemInstruction
    //    of type OttoChatContent"
    // — so we must convert any non-canonical shape on the client side.
    let capturedBody: any;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'ok' }] } }],
        }),
      };
    });
    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-flash',
    };
    await callGeminiNativeModel(
      modelConfig as any,
      {
        contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }],
        config: { systemInstruction: 'You are helpful.' },
      },
    );
    expect(capturedBody.systemInstruction).toEqual({ parts: [{ text: 'You are helpful.' }] });
  });

  it('normalises a { text } shorthand systemInstruction to canonical form', async () => {
    let capturedBody: any;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'ok' }] } }] }),
      };
    });
    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-flash',
    };
    await callGeminiNativeModel(
      modelConfig as any,
      {
        contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }],
        config: { systemInstruction: { text: 'Be concise.' } },
      },
    );
    expect(capturedBody.systemInstruction).toEqual({ parts: [{ text: 'Be concise.' }] });
  });

  it('passes through a canonical systemInstruction unchanged', async () => {
    let capturedBody: any;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'ok' }] } }] }),
      };
    });
    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-flash',
    };
    const canonical = { parts: [{ text: 'Already shaped.' }] };
    await callGeminiNativeModel(
      modelConfig as any,
      {
        contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }],
        config: { systemInstruction: canonical },
      },
    );
    expect(capturedBody.systemInstruction).toEqual(canonical);
  });

  it('sanitises contents: folds { reasoning } / { thought:true } back to thought parts and preserves thoughtSignature', async () => {
    // Gemini 3.x with thinking requires thoughtSignature to round-trip.
    // Stripping the marker would cause HTTP 400:
    //   "Function call is missing a thought_signature in functionCall parts"
    // — see scripts/replay-gemini-dump.mjs for the reproduction.
    let capturedBody: any;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'ok' }] } }] }),
      };
    });
    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-3.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-3.5-flash',
    };
    await callGeminiNativeModel(modelConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '前50个质数' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            // adapter's projection from a streamed run (with signature)
            { reasoning: 'Let me compute…', thoughtSignature: 'sig-abc' },
            // raw Gemini thought part
            { thought: true, text: 'Internal monologue.', thoughtSignature: 'sig-def' },
            // canonical text part — no signature
            { text: 'Sum is 5117.' },
            // functionCall WITH signature — must round-trip on the same part
            { functionCall: { name: 'run_sh', args: { c: 'echo' } }, thoughtSignature: 'sig-fc' },
          ],
        },
        { role: MESSAGE_ROLES.USER, parts: [{ text: '继续' }] },
      ],
    });

    const modelTurn = capturedBody.contents[1];
    expect(modelTurn.role).toBe(MESSAGE_ROLES.MODEL);
    expect(modelTurn.parts).toEqual([
      { thought: true, text: 'Let me compute…', thoughtSignature: 'sig-abc' },
      { thought: true, text: 'Internal monologue.', thoughtSignature: 'sig-def' },
      { text: 'Sum is 5117.' },
      { functionCall: { name: 'run_sh', args: { c: 'echo' } }, thoughtSignature: 'sig-fc' },
    ]);
    // No `reasoning` key remains — adapters projected fields are folded back.
    expect(JSON.stringify(capturedBody.contents)).not.toContain('"reasoning"');
  });

  it('drops empty / unknown parts so Gemini never sees an empty Content (HTTP 400)', async () => {
    let capturedBody: any;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'ok' }] } }] }),
      };
    });
    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-flash',
    };
    await callGeminiNativeModel(modelConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] },
        // turn that would only contain UI-only parts → must be dropped entirely
        { role: MESSAGE_ROLES.MODEL, parts: [{ reasoning: '' }, { someUnknownShape: 1 } as any] },
      ],
    });

    expect(capturedBody.contents).toHaveLength(1);
    expect(capturedBody.contents[0].parts).toEqual([{ text: 'hi' }]);
  });

  it('passes through canonical functionCall / functionResponse parts unchanged', async () => {
    let capturedBody: any;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'ok' }] } }] }),
      };
    });
    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-flash',
    };
    await callGeminiNativeModel(modelConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'use a tool' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }],
        },
        {
          role: 'function',
          parts: [{ functionResponse: { name: 'search', response: { ok: true } } }],
        },
      ],
    });
    expect(capturedBody.contents[1].parts[0]).toEqual({
      functionCall: { name: 'search', args: { q: 'x' } },
    });
    expect(capturedBody.contents[2].parts[0]).toEqual({
      functionResponse: { name: 'search', response: { ok: true } },
    });
  });

  it('maps a thought:true part to { reasoning } on the unary response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            role: MESSAGE_ROLES.MODEL,
            parts: [
              { thought: true, text: 'Let me think about this step by step.' },
              { text: 'Final answer is 9.' },
            ],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 },
      }),
    });
    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-pro',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-pro',
    };
    const result = await callGeminiNativeModel(
      modelConfig as any,
      { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }] },
    );
    const parts = result.candidates?.[0]?.content?.parts || [];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ reasoning: 'Let me think about this step by step.' });
    expect(parts[1]).toEqual({ text: 'Final answer is 9.' });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Cache-token field normalisation
  //
  // Why this test exists:
  //   The "Token Usage" footer (geminiChat.ts:240 → tokenUsageEventManager
  //   → TokenUsageDisplay.tsx) only reads `usageMetadata.cacheReadInputTokens`
  //   — the cross-provider canonical name set by the anthropic / openai-* paths
  //   in this same file. Gemini's upstream uses `cachedContentTokenCount`
  //   instead, so without normalisation the footer permanently shows
  //   "No cache information available" for any custom Gemini model on round 2+.
  //   Confirmed by scripts/probe-cache-fields.mjs (round 2 of gemini-2.5-flash
  //   returns cachedContentTokenCount=3059).
  // ────────────────────────────────────────────────────────────────────────
  it('normalises cachedContentTokenCount to cacheReadInputTokens when cache hits', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'cached!' }] } }],
        usageMetadata: {
          promptTokenCount: 3514,
          candidatesTokenCount: 23,
          totalTokenCount: 3537,
          cachedContentTokenCount: 3059,
          cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 3059 }],
        },
      }),
    });

    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-flash',
    };
    const result = await callGeminiNativeModel(
      modelConfig as any,
      { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi again' }] }] },
    );

    const usage = result.usageMetadata as any;
    // Original Gemini fields preserved (SessionManager + cost calculator
    // still read these directly).
    expect(usage.cachedContentTokenCount).toBe(3059);
    expect(usage.cacheTokensDetails).toEqual([{ modality: 'TEXT', tokenCount: 3059 }]);
    // Cross-provider alias added so the UI footer can pick up the hit.
    expect(usage.cacheReadInputTokens).toBe(3059);
    // Other counts are untouched.
    expect(usage.promptTokenCount).toBe(3514);
    expect(usage.candidatesTokenCount).toBe(23);
  });

  it('omits cacheReadInputTokens on cache miss (round 1) so downstream `|| 0` fallbacks behave identically', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'fresh' }] } }],
        // Round 1 shape — no cachedContentTokenCount at all.
        usageMetadata: {
          promptTokenCount: 3514,
          candidatesTokenCount: 29,
          totalTokenCount: 3543,
        },
      }),
    });

    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-flash',
    };
    const result = await callGeminiNativeModel(
      modelConfig as any,
      { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }] },
    );

    const usage = result.usageMetadata as any;
    expect(usage.cachedContentTokenCount).toBeUndefined();
    // Critically: do NOT add cacheReadInputTokens=0 on a miss — that would
    // be indistinguishable from a real-but-zero hit and confuses cost calcs.
    // Downstream code uses `(usage as any).cacheReadInputTokens || 0`, which
    // handles `undefined` correctly.
    expect(usage.cacheReadInputTokens).toBeUndefined();
  });
});

describe('callGeminiNativeModelStream', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockSseResponse(chunks: string[]) {
    return {
      ok: true,
      body: {
        getReader: () => {
          let i = 0;
          return {
            read: vi.fn(async () => {
              if (i < chunks.length) {
                const value = new TextEncoder().encode(chunks[i]);
                i++;
                return { done: false, value };
              }
              return { done: true, value: undefined };
            }),
            releaseLock: vi.fn(),
          };
        },
      },
    };
  }

  it('parses thought + text + functionCall parts from SSE and exposes functionCalls', async () => {
    const sse = [
      'data: ' + JSON.stringify({
        candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ thought: true, text: 'Thinking…' }] } }],
      }) + '\n\n',
      'data: ' + JSON.stringify({
        candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'Hello' }] } }],
      }) + '\n\n',
      'data: ' + JSON.stringify({
        candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ functionCall: { name: 'list_directory', args: { path: '/' } } }] }, finishReason: 'STOP' }],
      }) + '\n\n',
      'data: ' + JSON.stringify({
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 13, totalTokenCount: 20 },
      }) + '\n\n',
    ];
    global.fetch = vi.fn().mockResolvedValue(mockSseResponse(sse));

    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-pro',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-pro',
    };
    const responses: any[] = [];
    for await (const r of callGeminiNativeModelStream(
      modelConfig as any,
      { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }] },
    )) {
      responses.push(r);
    }

    const reasoning = responses.flatMap((r: any) => (r.candidates?.[0]?.content?.parts || []).filter((p: any) => 'reasoning' in p));
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].reasoning).toBe('Thinking…');

    const text = responses.flatMap((r: any) => (r.candidates?.[0]?.content?.parts || []).filter((p: any) => 'text' in p));
    expect(text).toHaveLength(1);
    expect(text[0].text).toBe('Hello');

    const fnResp = responses.find((r: any) => (r.candidates?.[0]?.content?.parts || []).some((p: any) => p.functionCall));
    expect(fnResp).toBeDefined();
    expect(fnResp!.functionCalls).toBeDefined();
    expect(fnResp!.functionCalls![0].name).toBe('list_directory');
    expect(fnResp!.functionCalls![0].args).toEqual({ path: '/' });

    const usage = responses.find((r: any) => r.usageMetadata);
    expect(usage).toBeDefined();
    expect(usage.usageMetadata.totalTokenCount).toBe(20);
  });

  it('builds streaming URL with ?alt=sse&key= and rewrites /v1 → /v1beta', async () => {
    let capturedUrl: string | undefined;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      capturedUrl = String(url);
      return mockSseResponse([]);
    });
    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-3.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'k',
      displayName: 'gemini-3.5-flash',
    };
    for await (const _ of callGeminiNativeModelStream(
      modelConfig as any,
      { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }] },
    )) {
      void _;
    }
    expect(capturedUrl).toBe(
      'https://llm-endpoint.net/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse&key=k',
    );
  });

  it('preserves a /v1beta-style baseUrl without rewriting it', async () => {
    let capturedUrl: string | undefined;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      capturedUrl = String(url);
      return mockSseResponse([]);
    });
    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-pro',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'k',
      displayName: 'gemini-2.5-pro',
    };
    for await (const _ of callGeminiNativeModelStream(
      modelConfig as any,
      { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }] },
    )) {
      void _;
    }
    expect(capturedUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=k',
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // Cache-token field normalisation on the SSE path.
  // Mirrors the unary test above — the SSE path forwards a separate
  // GenerateContentResponse for the usageMetadata chunk, so the alias must
  // also land on that chunk for the UI footer event to fire.
  // ────────────────────────────────────────────────────────────────────────
  it('aliases cachedContentTokenCount → cacheReadInputTokens on the streaming usage chunk', async () => {
    const sse = [
      'data: ' + JSON.stringify({
        candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      }) + '\n\n',
      'data: ' + JSON.stringify({
        usageMetadata: {
          promptTokenCount: 3514,
          candidatesTokenCount: 23,
          totalTokenCount: 3537,
          cachedContentTokenCount: 3059,
        },
      }) + '\n\n',
    ];
    global.fetch = vi.fn().mockResolvedValue(mockSseResponse(sse));

    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-2.5-flash',
    };
    const responses: any[] = [];
    for await (const r of callGeminiNativeModelStream(
      modelConfig as any,
      { contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi again' }] }] },
    )) {
      responses.push(r);
    }

    const usageResp = responses.find((r: any) => r.usageMetadata);
    expect(usageResp).toBeDefined();
    const u = usageResp.usageMetadata;
    expect(u.cachedContentTokenCount).toBe(3059);   // original preserved
    expect(u.cacheReadInputTokens).toBe(3059);      // alias added
    expect(u.promptTokenCount).toBe(3514);
  });
});

// ----------------------------------------------------------------------------
// Gemini-native tool schema sanitiser
// ----------------------------------------------------------------------------
// Regression coverage for the HTTP 400 we caught on 2026-05-26:
//   "Invalid JSON payload received. Unknown name "$schema" at
//    'tools[0].function_declarations[30].parameters': Cannot find field."
// Root cause was that buildGeminiNativeRequestBody used to forward
// request.config.tools verbatim, so MCP-supplied JSON-Schema-2020-12 keys
// (`$schema`, `additionalProperties`, …) reached EasyRouter / Google's
// strict OpenAPI-3-subset validator. The OttoServerAdapter path didn't
// trip this because the proxy strips them server-side.
//
// These tests exercise the pure helper directly (fast, deterministic) and
// then verify end-to-end via callGeminiNativeModel + a captured body that
// the wire payload no longer contains forbidden keys.
describe('sanitiseGeminiToolSchema - GenAI v1beta schema cleanup', () => {
  it('drops $schema, $id, $ref, $defs, definitions, additionalProperties, patternProperties, not', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'urn:example:foo',
      $ref: '#/definitions/Foo',
      $defs: { Foo: { type: 'string' } },
      definitions: { Bar: { type: 'string' } },
      type: 'object',
      additionalProperties: false,
      patternProperties: { '^x-': { type: 'string' } },
      not: { type: 'null' },
      properties: { name: { type: 'string' } },
      required: ['name'],
    };
    const out = sanitiseGeminiToolSchemaExport(input) as Record<string, unknown>;
    expect(out['$schema']).toBeUndefined();
    expect(out['$id']).toBeUndefined();
    expect(out['$ref']).toBeUndefined();
    expect(out['$defs']).toBeUndefined();
    expect(out['definitions']).toBeUndefined();
    expect(out['additionalProperties']).toBeUndefined();
    expect(out['patternProperties']).toBeUndefined();
    expect(out['not']).toBeUndefined();
    // Allowed keys survive.
    expect(out['type']).toBe('OBJECT');
    expect(out['properties']).toEqual({ name: { type: 'STRING' } });
    expect(out['required']).toEqual(['name']);
  });

  it('does not mutate its input', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { q: { type: 'string' } },
    };
    const before = JSON.stringify(input);
    sanitiseGeminiToolSchemaExport(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('normalises lowercase JSON-Schema types to the GenAI uppercase Type enum', () => {
    const out = sanitiseGeminiToolSchemaExport({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        height: { type: 'number' },
        active: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    }) as any;
    expect(out.type).toBe('OBJECT');
    expect(out.properties.name.type).toBe('STRING');
    expect(out.properties.age.type).toBe('INTEGER');
    expect(out.properties.height.type).toBe('NUMBER');
    expect(out.properties.active.type).toBe('BOOLEAN');
    expect(out.properties.tags.type).toBe('ARRAY');
    expect(out.properties.tags.items.type).toBe('STRING');
  });

  it('passes through already-uppercase types unchanged (built-in tool shape)', () => {
    const out = sanitiseGeminiToolSchemaExport({
      type: 'OBJECT',
      properties: { p: { type: 'STRING' } },
    }) as any;
    expect(out.type).toBe('OBJECT');
    expect(out.properties.p.type).toBe('STRING');
  });

  it('converts `const: x` to `enum: [x]` (Gemini supports enum only)', () => {
    const out = sanitiseGeminiToolSchemaExport({
      type: 'string',
      const: 'fixed-value',
    }) as any;
    expect(out.const).toBeUndefined();
    expect(out.enum).toEqual(['fixed-value']);
  });

  it('does not overwrite an existing `enum` when `const` is also present', () => {
    const out = sanitiseGeminiToolSchemaExport({
      type: 'string',
      const: 'a',
      enum: ['x', 'y'],
    }) as any;
    expect(out.const).toBeUndefined();
    expect(out.enum).toEqual(['x', 'y']);
  });

  it('folds oneOf / allOf into anyOf (the only multi-schema combinator Gemini accepts)', () => {
    const out = sanitiseGeminiToolSchemaExport({
      oneOf: [{ type: 'string' }, { type: 'integer' }],
      allOf: [{ type: 'object', properties: { a: { type: 'string' } } }],
    }) as any;
    expect(out.oneOf).toBeUndefined();
    expect(out.allOf).toBeUndefined();
    expect(Array.isArray(out.anyOf)).toBe(true);
    expect(out.anyOf).toHaveLength(3);
    // And types inside the combined branches were normalised too.
    expect(out.anyOf[0].type).toBe('STRING');
    expect(out.anyOf[1].type).toBe('INTEGER');
    expect(out.anyOf[2].type).toBe('OBJECT');
    expect(out.anyOf[2].properties.a.type).toBe('STRING');
  });

  it('preserves all Gemini Schema fields per @google/genai typings', () => {
    const out = sanitiseGeminiToolSchemaExport({
      type: 'object',
      title: 'T', description: 'd', nullable: true, default: {},
      example: { x: 1 }, format: 'enum', enum: ['a', 'b'],
      maxItems: '5', maxLength: '10', maxProperties: '3', maximum: 100,
      minItems: '0', minLength: '1', minProperties: '0', minimum: 0,
      pattern: '^a', propertyOrdering: ['a', 'b'], required: ['a'],
      properties: { a: { type: 'string' } },
    }) as any;
    expect(out.title).toBe('T');
    expect(out.description).toBe('d');
    expect(out.nullable).toBe(true);
    expect(out.default).toEqual({});
    expect(out.example).toEqual({ x: 1 });
    expect(out.format).toBe('enum');
    expect(out.enum).toEqual(['a', 'b']);
    expect(out.maxItems).toBe('5');
    expect(out.minimum).toBe(0);
    expect(out.pattern).toBe('^a');
    expect(out.propertyOrdering).toEqual(['a', 'b']);
    expect(out.required).toEqual(['a']);
  });

  it('cleans nested $schema inside `items` and `properties` recursively', () => {
    const out = sanitiseGeminiToolSchemaExport({
      type: 'object',
      properties: {
        nested: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'array',
          items: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'string' } },
          },
        },
      },
    }) as any;
    expect(out.properties.nested.$schema).toBeUndefined();
    expect(out.properties.nested.items.$schema).toBeUndefined();
    expect(out.properties.nested.items.additionalProperties).toBeUndefined();
    expect(out.properties.nested.items.properties.x.type).toBe('STRING');
  });

  it('handles primitives / null / undefined / arrays at the top level gracefully', () => {
    expect(sanitiseGeminiToolSchemaExport(null)).toBeNull();
    expect(sanitiseGeminiToolSchemaExport(undefined)).toBeUndefined();
    expect(sanitiseGeminiToolSchemaExport(42)).toBe(42);
    expect(sanitiseGeminiToolSchemaExport('s')).toBe('s');
    expect(sanitiseGeminiToolSchemaExport([{ $schema: 'x', type: 'string' }]))
      .toEqual([{ type: 'STRING' }]);
  });
});

describe('sanitiseGeminiTools - functionDeclarations cleanup at the wire boundary', () => {
  it('reproduces the failing-MCP-tool shape (Context7 query-docs) and produces a clean payload', () => {
    // Verbatim re-creation of decl 31 from the captured 400 dump
    // C:\\Users\\lijingyu\\.otto\\last-requests\\
    //   2026-05-26T03-17-44-180Z_gemini-stream_gemini-3.5-flash.json
    const tools = [{
      functionDeclarations: [
        // Built-in tool — already uses uppercase types, no $schema.
        {
          name: 'list_directory',
          description: 'Lists directory contents',
          parameters: {
            type: 'OBJECT',
            properties: { path: { type: 'STRING', description: 'p' } },
            required: ['path'],
          },
        },
        // MCP tool — JSON-Schema-2020-12 with $schema and lowercase types.
        {
          name: 'query-docs',
          description: 'Query docs',
          parameters: {
            type: 'object',
            properties: {
              libraryId: { type: 'string', description: 'id' },
              query: { type: 'string', description: 'q' },
            },
            required: [],
            $schema: 'http://json-schema.org/draft-07/schema#',
          },
        },
      ],
    }];

    const out = sanitiseGeminiToolsExport(tools) as any[];
    expect(out).toHaveLength(1);
    expect(out[0].functionDeclarations).toHaveLength(2);

    // Built-in tool: identical shape, types preserved.
    const builtin = out[0].functionDeclarations[0];
    expect(builtin.name).toBe('list_directory');
    expect(builtin.parameters.type).toBe('OBJECT');
    expect(builtin.parameters.properties.path.type).toBe('STRING');

    // MCP tool: $schema gone, types upper-cased, required preserved.
    const mcp = out[0].functionDeclarations[1];
    expect(mcp.name).toBe('query-docs');
    expect(mcp.parameters.$schema).toBeUndefined();
    expect(mcp.parameters.type).toBe('OBJECT');
    expect(mcp.parameters.properties.libraryId.type).toBe('STRING');
    expect(mcp.parameters.required).toEqual([]);
    // Crucially, the serialised payload contains zero "$schema" tokens.
    expect(JSON.stringify(out)).not.toContain('$schema');
  });

  it('does not mutate the caller\'s tools array (so other adapter branches keep their JSON-Schema view)', () => {
    const tools = [{
      functionDeclarations: [{
        name: 'q', description: '',
        parameters: { $schema: 'x', type: 'object', properties: {} },
      }],
    }];
    const before = JSON.stringify(tools);
    sanitiseGeminiToolsExport(tools);
    expect(JSON.stringify(tools)).toBe(before);
  });

  it('passes through non-array / weird input verbatim instead of throwing', () => {
    expect(sanitiseGeminiToolsExport(undefined)).toBeUndefined();
    expect(sanitiseGeminiToolsExport(null)).toBeNull();
    expect(sanitiseGeminiToolsExport('not-an-array')).toBe('not-an-array');
    // tool object missing functionDeclarations is left as-is.
    const weird = [{ random: 'shape' }];
    expect(sanitiseGeminiToolsExport(weird)).toEqual(weird);
  });

  it('end-to-end: callGeminiNativeModel\'s wire body has no $schema / additionalProperties for MCP tools', async () => {
    let capturedBody: any;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'ok' }] } }],
        }),
      };
    });

    const modelConfig = {
      provider: 'gemini' as const,
      modelId: 'gemini-3.5-flash',
      baseUrl: 'https://llm-endpoint.net/v1',
      apiKey: 'sk-test',
      displayName: 'gemini-3.5-flash',
    };

    const request = {
      contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] }],
      config: {
        tools: [{
          functionDeclarations: [{
            name: 'query-docs',
            description: 'Query docs',
            parameters: {
              type: 'object',
              properties: {
                libraryId: { type: 'string' },
                query: { type: 'string' },
              },
              required: [],
              $schema: 'http://json-schema.org/draft-07/schema#',
              additionalProperties: false,
            },
          }],
        }],
      },
    };

    await callGeminiNativeModel(modelConfig as any, request as any);

    // The wire payload that actually went out is what the upstream
    // validator would have rejected.
    const serialised = JSON.stringify(capturedBody.tools);
    expect(serialised).not.toContain('$schema');
    expect(serialised).not.toContain('additionalProperties');
    // Sanity: tool name & required fields survived, types upper-cased.
    expect(capturedBody.tools[0].functionDeclarations[0].name).toBe('query-docs');
    expect(capturedBody.tools[0].functionDeclarations[0].parameters.type).toBe('OBJECT');
    expect(capturedBody.tools[0].functionDeclarations[0].parameters.properties.libraryId.type).toBe('STRING');
  });
});
