/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Content } from '../types/extendedContent.js';
import {
  MicroCompactService,
  COMPACTABLE_TOOLS,
  CLEARED_TOOL_RESULT_MARKER,
} from './microCompactService.js';

describe('MicroCompactService', () => {
  let service: MicroCompactService;

  beforeEach(() => {
    service = new MicroCompactService({
      idleThresholdMinutes: 60,
      keepRecentToolResults: 2,
      enabled: true,
    });
  });

  describe('shouldMicroCompact', () => {
    it('should not trigger when recently active', () => {
      service.updateLastAssistantMessageTime();
      expect(service.shouldMicroCompact()).toBe(false);
    });

    it('should not trigger when disabled', () => {
      service.setEnabled(false);
      expect(service.shouldMicroCompact()).toBe(false);
    });

    // ─────────── 回归测试：shouldMicroCompact 双触发条件 ───────────
    it('should trigger when idle exceeds idleThresholdMinutes', () => {
      // 条件1：长时间空闲（>= idleThresholdMinutes，本测试用例为 60 分钟）
      (service as any).lastAssistantMessageTime = Date.now() - (61 * 60 * 1000);
      expect(service.shouldMicroCompact()).toBe(true);
    });

    it('should trigger when token usage is high AND idle > 6 minutes', () => {
      // 条件2：tokenUsageRatio >= tokenUsageThreshold（默认 0.7）且 idle > 6 分钟
      (service as any).lastAssistantMessageTime = Date.now() - (7 * 60 * 1000); // 7 分钟前
      expect(service.shouldMicroCompact(0.75)).toBe(true);
    });

    it('should NOT trigger token-based path when idle <= 6 minutes', () => {
      // 即使 token 用量超阈值，如果 idle <= 6 分钟，缓存仍热，不触发
      (service as any).lastAssistantMessageTime = Date.now() - (5 * 60 * 1000);
      expect(service.shouldMicroCompact(0.95)).toBe(false);
    });

    it('should NOT trigger token-based path when ratio below threshold', () => {
      (service as any).lastAssistantMessageTime = Date.now() - (10 * 60 * 1000);
      // tokenUsageThreshold 默认 0.7，0.5 < 0.7 不触发
      expect(service.shouldMicroCompact(0.5)).toBe(false);
    });

    it('should NOT trigger when disabled even if idle exceeds threshold', () => {
      service.setEnabled(false);
      (service as any).lastAssistantMessageTime = Date.now() - (61 * 60 * 1000);
      expect(service.shouldMicroCompact()).toBe(false);
      expect(service.shouldMicroCompact(0.99)).toBe(false);
    });
  });

  describe('microCompactMessages', () => {
    const createHistoryWithToolResults = (): Content[] => [
      // env messages (skip 2)
      { role: 'user', parts: [{ text: 'Environment' }] },
      { role: 'model', parts: [{ text: 'Got it!' }] },
      // tool call 1
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: '/a.txt' }, id: 'call_1' } } as any] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'File content A (very long)' }, id: 'call_1' } } as any] },
      // tool call 2
      { role: 'model', parts: [{ functionCall: { name: 'search_file_content', args: { pattern: 'foo' }, id: 'call_2' } } as any] },
      { role: 'user', parts: [{ functionResponse: { name: 'search_file_content', response: { output: 'Search results...' }, id: 'call_2' } } as any] },
      // tool call 3 (non-compactable)
      { role: 'model', parts: [{ functionCall: { name: 'save_memory', args: { fact: 'test' }, id: 'call_3' } } as any] },
      { role: 'user', parts: [{ functionResponse: { name: 'save_memory', response: { output: 'Saved' }, id: 'call_3' } } as any] },
      // tool call 4
      { role: 'model', parts: [{ functionCall: { name: 'glob', args: { pattern: '*.ts' }, id: 'call_4' } } as any] },
      { role: 'user', parts: [{ functionResponse: { name: 'glob', response: { output: 'file1.ts\nfile2.ts' }, id: 'call_4' } } as any] },
      // tool call 5
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: '/b.txt' }, id: 'call_5' } } as any] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'File content B' }, id: 'call_5' } } as any] },
    ];

    it('should not clear when not idle enough (gated by shouldMicroCompact at call site)', () => {
      // 业务设计：microCompactMessages 本身不再检查 idle 时间，只看 enabled。
      // idle 判断由调用方在调用前通过 shouldMicroCompact() 把关
      // （见 packages/core/src/core/client.ts 的 runMicroCompactFallback 调用链）。
      // 因此本用例从 shouldMicroCompact 的 gate 视角验证："recently active 时不应该触发微压缩"。
      const history = createHistoryWithToolResults();
      service.updateLastAssistantMessageTime(); // just active

      // gate：active 状态下 shouldMicroCompact 应返回 false，调用方不会调用 microCompactMessages
      expect(service.shouldMicroCompact()).toBe(false);

      // 直接调用（绕过 gate）会按设计执行清理 —— 验证"绕过 gate"行为符合业务设计
      const result = service.microCompactMessages(history, 2);
      // 4 个可压缩工具结果（read_file x2, search_file_content, glob），keepRecent=2 → 清掉 2 个
      expect(result.applied).toBe(true);
      expect(result.clearedCount).toBe(2);
    });

    it('should clear old compactable tool results when idle', () => {
      const history = createHistoryWithToolResults();

      // 模拟超过空闲阈值：直接修改内部状态
      (service as any).lastAssistantMessageTime = Date.now() - (61 * 60 * 1000); // 61 minutes ago

      const result = service.microCompactMessages(history, 2);

      expect(result.applied).toBe(true);
      // 4 compactable tool results (read_file x2, search_file_content, glob), keepRecent=2
      // So 2 should be cleared (the oldest 2)
      expect(result.clearedCount).toBe(2);

      // First compactable result should be cleared
      const firstToolResponse = (history[3].parts![0] as any).functionResponse;
      expect(firstToolResponse.response.output).toBe(CLEARED_TOOL_RESULT_MARKER);

      // save_memory is non-compactable, should NOT be cleared
      const nonCompactableResponse = (history[7].parts![0] as any).functionResponse;
      expect(nonCompactableResponse.response.output).toBe('Saved');

      // Last compactable result should be kept
      const lastToolResponse = (history[11].parts![0] as any).functionResponse;
      expect(lastToolResponse.response.output).toBe('File content B');
    });

    it('should not clear already-cleared results', () => {
      const history = createHistoryWithToolResults();

      // Pre-clear the first one
      (history[3].parts![0] as any).functionResponse.response = { output: CLEARED_TOOL_RESULT_MARKER };

      (service as any).lastAssistantMessageTime = Date.now() - (61 * 60 * 1000);
      const result = service.microCompactMessages(history, 2);

      // Only 3 non-cleared compactable results, keepRecent=2, so only 1 more cleared
      expect(result.clearedCount).toBe(1);
    });

    it('should skip environment messages', () => {
      // Put a tool result in env messages
      const history: Content[] = [
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'env file' }, id: 'env_1' } } as any] },
        { role: 'model', parts: [{ text: 'Got it!' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: '/x.txt' }, id: 'call_x' } } as any] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'X content' }, id: 'call_x' } } as any] },
      ];

      (service as any).lastAssistantMessageTime = Date.now() - (61 * 60 * 1000);
      service.microCompactMessages(history, 2);

      // Env message should not be touched
      const envResponse = (history[0].parts![0] as any).functionResponse;
      expect(envResponse.response.output).toBe('env file');
    });

    it('should return disabled reason when disabled', () => {
      service.setEnabled(false);
      const result = service.microCompactMessages([], 2);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('disabled');
    });
  });

  describe('reset', () => {
    it('should reset lastAssistantMessageTime', () => {
      (service as any).lastAssistantMessageTime = 0;
      expect(service.getIdleMinutes()).toBeGreaterThan(0);
      service.reset();
      expect(service.getIdleMinutes()).toBeLessThan(1);
    });
  });

  describe('COMPACTABLE_TOOLS', () => {
    it('should include common high-frequency tools', () => {
      expect(COMPACTABLE_TOOLS.has('read_file')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('run_shell_command')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('search_file_content')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('glob')).toBe(true);
    });

    it('should not include state-changing tools', () => {
      expect(COMPACTABLE_TOOLS.has('save_memory')).toBe(false);
      expect(COMPACTABLE_TOOLS.has('todo_write')).toBe(false);
      expect(COMPACTABLE_TOOLS.has('use_skill')).toBe(false);
    });
  });

  describe('getConfig', () => {
    it('should return current configuration', () => {
      const config = service.getConfig();
      expect(config.idleThresholdMinutes).toBe(60);
      expect(config.keepRecentToolResults).toBe(2);
      expect(config.enabled).toBe(true);
    });
  });
});
