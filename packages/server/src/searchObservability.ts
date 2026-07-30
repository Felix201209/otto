/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  SearchProviderDiagnostic,
  SearchQuotaDecision,
  SearchQuotaDiagnostic,
  SearchTelemetryEvent,
  WebSearchDiagnosticsSnapshot,
  WebSearchProvider,
} from 'otto-core';
import { loadUserSettingsSubset } from './userSettings.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function searchTelemetryFilePath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.otto-user', 'search-telemetry.jsonl');
}

function rotateIfNeeded(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_LOG_BYTES) return;
    const previous = `${file}.1`;
    try {
      fs.rmSync(previous);
    } catch {
      // 首次轮换没有旧文件。
    }
    fs.renameSync(file, previous);
  } catch {
    // 文件尚未创建。
  }
}

/**
 * 只记录运行元数据，不记录查询词、网页内容、账号姓名或密钥。
 */
export function recordSearchTelemetryEvent(
  event: SearchTelemetryEvent,
  homeDir = os.homedir(),
): void {
  const file = searchTelemetryFilePath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  rotateIfNeeded(file);
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

interface ProviderUsageSummary {
  attempts: number;
  successes: number;
  failures: number;
  estimatedCostCny: number;
}

function emptyProviderUsage(): Record<WebSearchProvider, ProviderUsageSummary> {
  return {
    bing: { attempts: 0, successes: 0, failures: 0, estimatedCostCny: 0 },
    bocha: { attempts: 0, successes: 0, failures: 0, estimatedCostCny: 0 },
    gemini: { attempts: 0, successes: 0, failures: 0, estimatedCostCny: 0 },
    volcengine: { attempts: 0, successes: 0, failures: 0, estimatedCostCny: 0 },
  };
}

function readEvents(file: string): SearchTelemetryEvent[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SearchTelemetryEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function monthBounds(now: number): { start: number; end: number } {
  const date = new Date(now);
  return {
    start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

export function getSearchQuotaStatus(
  tenantId: string,
  homeDir = os.homedir(),
  now = Date.now(),
): SearchQuotaDiagnostic {
  const settings = loadUserSettingsSubset(homeDir);
  const file = searchTelemetryFilePath(homeDir);
  const period = monthBounds(now);
  const attempts = [...readEvents(`${file}.1`), ...readEvents(file)].filter(
    (event) =>
      event.tenantId === (tenantId.trim() || 'local') &&
      event.kind === 'provider_attempt' &&
      event.timestamp >= period.start &&
      event.timestamp < period.end,
  );
  const requestsUsed = attempts.length;
  const budgetUsedCny = Number(
    attempts
      .reduce((sum, event) => sum + Math.max(0, event.estimatedCostCny || 0), 0)
      .toFixed(6),
  );
  const requestBlocked =
    typeof settings.searchMonthlyRequestQuota === 'number' &&
    requestsUsed >= settings.searchMonthlyRequestQuota;
  const budgetBlocked =
    typeof settings.searchMonthlyBudgetCny === 'number' &&
    budgetUsedCny >= settings.searchMonthlyBudgetCny;
  return {
    periodStart: period.start,
    periodEnd: period.end,
    requestLimit: settings.searchMonthlyRequestQuota,
    requestsUsed,
    budgetLimitCny: settings.searchMonthlyBudgetCny,
    budgetUsedCny,
    blocked: requestBlocked || budgetBlocked,
    blockedReason: requestBlocked
      ? 'monthly_request_quota_exhausted'
      : budgetBlocked
        ? 'monthly_budget_exhausted'
        : undefined,
  };
}

export function checkSearchQuota(
  tenantId: string,
  estimatedCostCny: number,
  homeDir = os.homedir(),
  now = Date.now(),
): SearchQuotaDecision {
  const status = getSearchQuotaStatus(tenantId, homeDir, now);
  if (
    typeof status.requestLimit === 'number' &&
    status.requestsUsed >= status.requestLimit
  ) {
    return { allowed: false, reason: 'monthly_request_quota_exhausted' };
  }
  if (
    typeof status.budgetLimitCny === 'number' &&
    status.budgetUsedCny + Math.max(0, estimatedCostCny) > status.budgetLimitCny
  ) {
    return { allowed: false, reason: 'monthly_budget_exhausted' };
  }
  return { allowed: true };
}

export function mergePersistedSearchDiagnostics(
  live: WebSearchDiagnosticsSnapshot,
  homeDir = os.homedir(),
  now = Date.now(),
): WebSearchDiagnosticsSnapshot {
  const file = searchTelemetryFilePath(homeDir);
  const events = [...readEvents(`${file}.1`), ...readEvents(file)].filter(
    (event) =>
      event.tenantId === live.tenantId &&
      event.timestamp >= now - RETENTION_MS &&
      event.timestamp <= now + 5 * 60 * 1000,
  );
  if (events.length === 0) {
    return {
      ...live,
      quota: getSearchQuotaStatus(live.tenantId, homeDir, now),
      updatedAt: now,
    };
  }

  const usage = emptyProviderUsage();
  let cacheHits = 0;
  for (const event of events) {
    if (event.kind === 'cache_hit') {
      cacheHits += 1;
      continue;
    }
    if (event.kind !== 'provider_attempt' || !event.provider) continue;
    const item = usage[event.provider];
    item.attempts += 1;
    if (event.success) item.successes += 1;
    else item.failures += 1;
    item.estimatedCostCny += Math.max(0, event.estimatedCostCny || 0);
  }

  const providers = live.providers.map((provider): SearchProviderDiagnostic => {
    const persisted = usage[provider.provider];
    return {
      ...provider,
      attempts: persisted.attempts,
      successes: persisted.successes,
      failures: persisted.failures,
      estimatedCostCny: Number(persisted.estimatedCostCny.toFixed(6)),
    };
  });
  return {
    ...live,
    cacheHits,
    totalAttempts: providers.reduce((sum, item) => sum + item.attempts, 0),
    totalSuccesses: providers.reduce((sum, item) => sum + item.successes, 0),
    estimatedCostCny: Number(
      providers
        .reduce((sum, item) => sum + item.estimatedCostCny, 0)
        .toFixed(6),
    ),
    providers,
    quota: getSearchQuotaStatus(live.tenantId, homeDir, now),
    updatedAt: now,
  };
}
