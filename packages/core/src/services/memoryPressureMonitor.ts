/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';

export type MemoryPressureLevel = 'normal' | 'warning' | 'critical';

export interface MemoryPressureSnapshot {
  level: MemoryPressureLevel;
  timestamp: number;
  rssBytes: number;
  heapUsedBytes: number;
  freeSystemBytes: number;
  totalSystemBytes: number;
  freeSystemRatio: number;
  reason: string;
}

export interface MemoryPressureThresholds {
  warningFreeSystemRatio: number;
  criticalFreeSystemRatio: number;
  warningRssBytes: number;
  criticalRssBytes: number;
}

export interface MemoryPressureMonitorOptions {
  intervalMs?: number;
  thresholds?: Partial<MemoryPressureThresholds>;
  readMemory?: () => Omit<MemoryPressureSnapshot, 'level' | 'timestamp' | 'reason'>;
  now?: () => number;
}

export type MemoryPressureListener = (snapshot: MemoryPressureSnapshot) => void;

const MB = 1024 * 1024;

const DEFAULT_THRESHOLDS: MemoryPressureThresholds = {
  warningFreeSystemRatio: 0.12,
  criticalFreeSystemRatio: 0.06,
  warningRssBytes: 768 * MB,
  criticalRssBytes: 1024 * MB,
};

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readDefaultMemory() {
  const usage = process.memoryUsage();
  const totalSystemBytes = os.totalmem();
  const freeSystemBytes = os.freemem();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    freeSystemBytes,
    totalSystemBytes,
    freeSystemRatio: totalSystemBytes > 0 ? freeSystemBytes / totalSystemBytes : 1,
  };
}

function classify(
  input: Omit<MemoryPressureSnapshot, 'level' | 'timestamp' | 'reason'>,
  thresholds: MemoryPressureThresholds,
): Pick<MemoryPressureSnapshot, 'level' | 'reason'> {
  if (input.freeSystemRatio <= thresholds.criticalFreeSystemRatio) {
    return { level: 'critical', reason: 'system_free_memory_critical' };
  }
  if (input.rssBytes >= thresholds.criticalRssBytes) {
    return { level: 'critical', reason: 'process_rss_critical' };
  }
  if (input.freeSystemRatio <= thresholds.warningFreeSystemRatio) {
    return { level: 'warning', reason: 'system_free_memory_low' };
  }
  if (input.rssBytes >= thresholds.warningRssBytes) {
    return { level: 'warning', reason: 'process_rss_high' };
  }
  return { level: 'normal', reason: 'within_budget' };
}

export class MemoryPressureMonitor {
  private readonly intervalMs: number;
  private readonly thresholds: MemoryPressureThresholds;
  private readonly readMemory: () => Omit<MemoryPressureSnapshot, 'level' | 'timestamp' | 'reason'>;
  private readonly now: () => number;
  private listeners: MemoryPressureListener[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private latest: MemoryPressureSnapshot;

  constructor(options: MemoryPressureMonitorOptions = {}) {
    this.intervalMs = options.intervalMs ?? envNumber('OTTO_MEMORY_MONITOR_INTERVAL_MS') ?? 15_000;
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      warningFreeSystemRatio:
        envNumber('OTTO_MEMORY_WARNING_FREE_RATIO') ?? DEFAULT_THRESHOLDS.warningFreeSystemRatio,
      criticalFreeSystemRatio:
        envNumber('OTTO_MEMORY_CRITICAL_FREE_RATIO') ?? DEFAULT_THRESHOLDS.criticalFreeSystemRatio,
      warningRssBytes:
        (envNumber('OTTO_MEMORY_WARNING_RSS_MB') ?? DEFAULT_THRESHOLDS.warningRssBytes / MB) * MB,
      criticalRssBytes:
        (envNumber('OTTO_MEMORY_CRITICAL_RSS_MB') ?? DEFAULT_THRESHOLDS.criticalRssBytes / MB) * MB,
      ...options.thresholds,
    };
    this.readMemory = options.readMemory ?? readDefaultMemory;
    this.now = options.now ?? Date.now;
    this.latest = this.sample();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  subscribe(listener: MemoryPressureListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  getSnapshot(): MemoryPressureSnapshot {
    return this.latest;
  }

  check(): MemoryPressureSnapshot {
    const previousLevel = this.latest.level;
    const next = this.sample();
    this.latest = next;
    if (next.level !== previousLevel || next.level !== 'normal') {
      for (const listener of this.listeners) {
        try {
          listener(next);
        } catch {
          // Memory protection must not crash the runtime.
        }
      }
    }
    return next;
  }

  isPressureActive(): boolean {
    return this.latest.level !== 'normal';
  }

  getTaskConcurrencyLimit(defaultLimit: number): number {
    if (this.latest.level === 'critical') return 1;
    if (this.latest.level === 'warning') return Math.max(1, Math.min(defaultLimit, 1));
    return defaultLimit;
  }

  private sample(): MemoryPressureSnapshot {
    const memory = this.readMemory();
    const classified = classify(memory, this.thresholds);
    return {
      ...memory,
      ...classified,
      timestamp: this.now(),
    };
  }
}

let globalMonitor: MemoryPressureMonitor | undefined;

export function getMemoryPressureMonitor(): MemoryPressureMonitor {
  globalMonitor ??= new MemoryPressureMonitor();
  return globalMonitor;
}

export function resetMemoryPressureMonitorForTests(): void {
  globalMonitor?.stop();
  globalMonitor = undefined;
}
