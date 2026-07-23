/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MemoryPressureMonitor } from './memoryPressureMonitor.js';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

describe('MemoryPressureMonitor', () => {
  it('reports normal memory when process and system memory are within budget', () => {
    const monitor = new MemoryPressureMonitor({
      readMemory: () => ({
        rssBytes: 200 * MB,
        heapUsedBytes: 80 * MB,
        freeSystemBytes: 8 * GB,
        totalSystemBytes: 16 * GB,
        freeSystemRatio: 0.5,
      }),
    });

    expect(monitor.getSnapshot().level).toBe('normal');
    expect(monitor.isPressureActive()).toBe(false);
  });

  it('escalates to warning and critical based on system free memory', () => {
    let freeSystemRatio = 0.1;
    const monitor = new MemoryPressureMonitor({
      readMemory: () => ({
        rssBytes: 200 * MB,
        heapUsedBytes: 80 * MB,
        freeSystemBytes: freeSystemRatio * 16 * GB,
        totalSystemBytes: 16 * GB,
        freeSystemRatio,
      }),
    });

    expect(monitor.getSnapshot().level).toBe('warning');

    freeSystemRatio = 0.05;
    expect(monitor.check().level).toBe('critical');

    freeSystemRatio = 0.5;
    expect(monitor.check().level).toBe('normal');
  });

  it('clamps task concurrency during memory pressure', () => {
    const monitor = new MemoryPressureMonitor({
      readMemory: () => ({
        rssBytes: 2 * GB,
        heapUsedBytes: 300 * MB,
        freeSystemBytes: 4 * GB,
        totalSystemBytes: 16 * GB,
        freeSystemRatio: 0.25,
      }),
    });

    expect(monitor.getSnapshot().level).toBe('critical');
    expect(monitor.getTaskConcurrencyLimit(4)).toBe(1);
  });
});
