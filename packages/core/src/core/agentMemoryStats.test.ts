/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildAgentMemoryReport,
  estimateHistoryChars,
  estimateUnknownChars,
  formatBytes,
} from './agentMemoryStats.js';
import type { Content } from '../types/extendedContent.js';

describe('agentMemoryStats', () => {
  it('builds a stable delta report from memory snapshots', () => {
    const report = buildAgentMemoryReport({
      start: {
        timestamp: 100,
        rssBytes: 1000,
        heapUsedBytes: 200,
        externalBytes: 30,
        arrayBuffersBytes: 10,
      },
      end: {
        timestamp: 175,
        rssBytes: 1500,
        heapUsedBytes: 180,
        externalBytes: 50,
        arrayBuffersBytes: 12,
      },
      history: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'world' }] },
      ] as Content[],
      pendingToolResultParts: 3,
    });

    expect(report.durationMs).toBe(75);
    expect(report.delta.rssBytes).toBe(500);
    expect(report.delta.heapUsedBytes).toBe(-20);
    expect(report.historyMessages).toBe(2);
    expect(report.historyChars).toBeGreaterThanOrEqual(10);
    expect(report.pendingToolResultParts).toBe(3);
  });

  it('estimates nested prompt/history payload size without JSON stringifying everything', () => {
    const history = [
      {
        role: 'user',
        parts: [
          { text: 'short' },
          { functionResponse: { name: 'read_file', response: { content: 'abcdef' } } },
        ],
      },
    ] as Content[];

    expect(estimateHistoryChars(history)).toBeGreaterThanOrEqual('shortabcdef'.length);
    expect(estimateUnknownChars({ a: ['xx', 7, true] })).toBeGreaterThanOrEqual(6);
  });

  it('formats memory values for compact UI surfaces', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(-2 * 1024 * 1024)).toBe('-2.00 MB');
  });
});
