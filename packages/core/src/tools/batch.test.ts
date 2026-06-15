/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BatchTool } from './batch.js';
import { Config } from '../config/config.js';

describe('BatchTool', () => {
  let mockConfig: Config;
  let batchTool: BatchTool;

  beforeEach(() => {
    mockConfig = {
      getToolRegistry: vi.fn(),
    } as unknown as Config;
    batchTool = new BatchTool(mockConfig);
  });

  describe('getDescription', () => {
    it('should return "No tools" for empty tool_calls', () => {
      const result = batchTool.getDescription({ tool_calls: [] });
      expect(result).toBe('No tools');
    });

    it('should return description for single tool call', () => {
      const result = batchTool.getDescription({
        tool_calls: [{ tool: 'read_file', parameters: {} }],
      });
      expect(result).toBe('1 tool: read_file');
    });

    it('should return description for multiple tool calls', () => {
      const result = batchTool.getDescription({
        tool_calls: [
          { tool: 'read_file', parameters: {} },
          { tool: 'write_file', parameters: {} },
          { tool: 'run_shell_command', parameters: {} },
        ],
      });
      expect(result).toBe('3 tools: read_file, write_file, run_shell_command');
    });

    it('should truncate long tool names list', () => {
      const result = batchTool.getDescription({
        tool_calls: [
          { tool: 'search_file_content', parameters: {} },
          { tool: 'run_shell_command', parameters: {} },
          { tool: 'write_file', parameters: {} },
          { tool: 'read_many_files', parameters: {} },
        ],
      });
      // Total tool names: "search_file_content, run_shell_command, write_file, read_many_files"
      // Length is 68, which exceeds 60, so it should be truncated
      expect(result).toContain('4 tools:');
      expect(result).toContain('...');
      expect(result.length).toBeLessThanOrEqual(80); // "4 tools: " (9) + truncated (57) + "..." (3) = 69 max
    });

    it('should handle undefined tool_calls', () => {
      const result = batchTool.getDescription({ tool_calls: undefined as any });
      expect(result).toBe('No tools');
    });

    it('should handle tool name aliases (robustness)', () => {
      const result = batchTool.getDescription({
        tool_calls: [
          { tool: '', parameters: {}, name: 'read_file' } as any,
          { tool: '', parameters: {}, function: 'write_file' } as any,
          { tool: '', parameters: {}, tool_name: 'glob' } as any,
        ],
      });
      expect(result).toBe('3 tools: read_file, write_file, glob');
    });

    it('should handle missing tool names', () => {
        // 业务实现：normalizeToolCalls 在缺失/无效 tool 名时回退为 'unknown'（小写）。
        // 见 packages/core/src/tools/batch.ts 中 normalizeToolCalls / fallback 'unknown'。
        const result = batchTool.getDescription({
          tool_calls: [{ tool: '', parameters: {} } as any],
        });
        expect(result).toBe('1 tool: unknown');
    });

    it('should handle stringified JSON tool calls (LLM hallucination)', () => {
        const result = batchTool.getDescription({
            tool_calls: [
                '{"tool": "read_file", "parameters": {}}',
                '{"tool": "write_file", "parameters": {}}'
            ] as any
        });
        expect(result).toBe('2 tools: read_file, write_file');
    });

    // ─────────── 回归测试：normalizeToolCalls 兜底行为 ───────────
    it('should fall back to "unknown" for invalid stringified JSON', () => {
      // 业务行为：JSON.parse 失败时返回 { tool: 'unknown', parameters: {} }
      const result = batchTool.getDescription({
        tool_calls: ['not a json string'] as any,
      });
      expect(result).toBe('1 tool: unknown');
    });

    it('should fall back to "unknown" for null/non-object tool_calls items', () => {
      const result = batchTool.getDescription({
        tool_calls: [null, 42, true] as any,
      });
      expect(result).toBe('3 tools: unknown, unknown, unknown');
    });

    it('should produce "0 tool: " when tool_calls is not an array (degenerate input)', () => {
      // 业务行为：getDescription 早返回 "No tools" 仅在 tool_calls 为 falsy 或 length===0 时；
      // 当 tool_calls 是非数组的 truthy 值（如字符串）时，
      // normalizeToolCalls 返回 []，最终格式化成 '0 tool: '。这是当前业务事实，本用例锁定该行为以防回归。
      const result = batchTool.getDescription({
        tool_calls: 'not an array' as any,
      });
      expect(result).toBe('0 tool: ');
    });

    it('should prefer "tool" over name/function/tool_name aliases', () => {
      // 业务实现：toolName = call.tool || call.name || call.function || call.tool_name || 'unknown'
      const result = batchTool.getDescription({
        tool_calls: [
          { tool: 'read_file', name: 'shadow_a', function: 'shadow_b', tool_name: 'shadow_c', parameters: {} } as any,
        ],
      });
      expect(result).toBe('1 tool: read_file');
    });
  });

  describe('execute', () => {
    it('should handle tool name aliases during execution', async () => {
      const mockTool = { execute: vi.fn().mockResolvedValue({ llmContent: 'success' }) };
      const mockRegistry = { getTool: vi.fn().mockReturnValue(mockTool) };
      (mockConfig.getToolRegistry as any).mockResolvedValue(mockRegistry);

      const params = {
        tool_calls: [
            { tool: '', parameters: { path: 'a' }, name: 'read_file' } as any
        ]
      };

      const result = await batchTool.execute(params, new AbortController().signal);

      expect(mockRegistry.getTool).toHaveBeenCalledWith('read_file');
      expect(mockTool.execute).toHaveBeenCalled();
      expect(result.llmContent).toContain('1/1 succeeded');
    });

    it('should handle stringified JSON tool calls during execution', async () => {
        const mockTool = { execute: vi.fn().mockResolvedValue({ llmContent: 'success' }) };
        const mockRegistry = { getTool: vi.fn().mockReturnValue(mockTool) };
        (mockConfig.getToolRegistry as any).mockResolvedValue(mockRegistry);

        const params = {
          tool_calls: [
              '{"tool": "read_file", "parameters": {"path": "a"}}'
          ] as any
        };

        const result = await batchTool.execute(params, new AbortController().signal);

        expect(mockRegistry.getTool).toHaveBeenCalledWith('read_file');
        expect(mockTool.execute).toHaveBeenCalled();
        expect(result.llmContent).toContain('1/1 succeeded');
      });
  });

  describe('validateToolParams', () => {
    it('should return error for empty tool_calls', () => {
      const result = batchTool.validateToolParams({ tool_calls: [] });
      expect(result).toBe('At least one tool call is required.');
    });

    it('should return error for too many tool calls', () => {
      const toolCalls = Array.from({ length: 21 }, (_, i) => ({
        tool: `tool_${i}`,
        parameters: {},
      }));
      const result = batchTool.validateToolParams({ tool_calls: toolCalls });
      expect(result).toBe('Maximum 20 tool calls allowed in batch.');
    });

    it('should return null for valid tool_calls', () => {
      const result = batchTool.validateToolParams({
        tool_calls: [{ tool: 'read_file', parameters: {} }],
      });
      expect(result).toBeNull();
    });
  });
});
