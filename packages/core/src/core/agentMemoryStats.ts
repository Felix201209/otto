/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '../types/extendedContent.js';

export interface AgentMemorySnapshot {
  timestamp: number;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface AgentMemoryDelta {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface AgentMemoryReport {
  start: AgentMemorySnapshot;
  end: AgentMemorySnapshot;
  delta: AgentMemoryDelta;
  durationMs: number;
  historyChars: number;
  historyMessages: number;
  pendingToolResultParts: number;
}

export function readProcessMemorySnapshot(now: number = Date.now()): AgentMemorySnapshot {
  const usage = process.memoryUsage();
  return {
    timestamp: now,
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

export function buildAgentMemoryReport(params: {
  start: AgentMemorySnapshot;
  end?: AgentMemorySnapshot;
  history?: Content[];
  pendingToolResultParts?: number;
}): AgentMemoryReport {
  const end = params.end ?? readProcessMemorySnapshot();
  const history = params.history ?? [];

  return {
    start: params.start,
    end,
    delta: {
      rssBytes: end.rssBytes - params.start.rssBytes,
      heapUsedBytes: end.heapUsedBytes - params.start.heapUsedBytes,
      externalBytes: end.externalBytes - params.start.externalBytes,
      arrayBuffersBytes: end.arrayBuffersBytes - params.start.arrayBuffersBytes,
    },
    durationMs: Math.max(0, end.timestamp - params.start.timestamp),
    historyChars: estimateHistoryChars(history),
    historyMessages: history.length,
    pendingToolResultParts: params.pendingToolResultParts ?? 0,
  };
}

export function estimateHistoryChars(history: Content[]): number {
  return history.reduce((total, message) => total + estimateUnknownChars(message), 0);
}

export function estimateUnknownChars(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).length;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + estimateUnknownChars(item), 0);
  }
  if (typeof value === 'object') {
    let total = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      total += key.length + estimateUnknownChars(item);
    }
    return total;
  }
  return 0;
}

export function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : '';
  const absolute = Math.abs(bytes);
  if (absolute < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB'];
  let value = absolute / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${sign}${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
