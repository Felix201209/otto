/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkSearchQuota,
  getSearchQuotaStatus,
  mergePersistedSearchDiagnostics,
  recordSearchTelemetryEvent,
  searchTelemetryFilePath,
} from './searchObservability.js';

let home = '';
afterEach(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = '';
});

describe('search observability', () => {
  it('persists only metadata and aggregates by tenant', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-search-observability-'));
    recordSearchTelemetryEvent(
      {
        tenantId: 'org-a',
        provider: 'bocha',
        kind: 'provider_attempt',
        success: true,
        latencyMs: 120,
        estimatedCostCny: 0.03,
        timestamp: 1000,
      },
      home,
    );
    recordSearchTelemetryEvent(
      {
        tenantId: 'org-b',
        provider: 'bocha',
        kind: 'provider_attempt',
        success: false,
        latencyMs: 100,
        errorCode: 'timeout',
        estimatedCostCny: 0.03,
        timestamp: 1001,
      },
      home,
    );
    recordSearchTelemetryEvent(
      {
        tenantId: 'org-a',
        kind: 'cache_hit',
        success: true,
        latencyMs: 0,
        estimatedCostCny: 0,
        timestamp: 1002,
      },
      home,
    );

    const raw = fs.readFileSync(searchTelemetryFilePath(home), 'utf8');
    expect(raw).not.toContain('query');
    expect(raw).not.toContain('apiKey');
    const merged = mergePersistedSearchDiagnostics(
      {
        tenantId: 'org-a',
        cacheEntries: 1,
        cacheHits: 0,
        totalAttempts: 0,
        totalSuccesses: 0,
        estimatedCostCny: 0,
        updatedAt: 2000,
        providers: ['bocha', 'volcengine', 'gemini', 'bing'].map(
          (provider) => ({
            provider: provider as 'bocha' | 'volcengine' | 'gemini' | 'bing',
            status: 'untested' as const,
            attempts: 0,
            successes: 0,
            failures: 0,
            consecutiveFailures: 0,
            averageLatencyMs: 0,
            estimatedCostCny: 0,
          }),
        ),
      },
      home,
      2000,
    );
    expect(merged.totalAttempts).toBe(1);
    expect(merged.totalSuccesses).toBe(1);
    expect(merged.cacheHits).toBe(1);
    expect(merged.estimatedCostCny).toBe(0.03);
  });

  it('enforces monthly request and budget limits per tenant', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-search-quota-'));
    const settingsDir = path.join(home, '.otto-user');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        searchMonthlyRequestQuota: 2,
        searchMonthlyBudgetCny: 0.05,
      }),
    );
    const now = Date.UTC(2026, 6, 20, 12);
    recordSearchTelemetryEvent(
      {
        tenantId: 'org-a',
        provider: 'bocha',
        kind: 'provider_attempt',
        success: true,
        latencyMs: 100,
        estimatedCostCny: 0.03,
        timestamp: now - 1000,
      },
      home,
    );

    expect(checkSearchQuota('org-a', 0.03, home, now)).toEqual({
      allowed: false,
      reason: 'monthly_budget_exhausted',
    });
    expect(checkSearchQuota('org-a', 0.01, home, now).allowed).toBe(true);
    recordSearchTelemetryEvent(
      {
        tenantId: 'org-a',
        provider: 'bing',
        kind: 'provider_attempt',
        success: true,
        latencyMs: 80,
        estimatedCostCny: 0,
        timestamp: now,
      },
      home,
    );
    const status = getSearchQuotaStatus('org-a', home, now);
    expect(status.requestsUsed).toBe(2);
    expect(status.blocked).toBe(true);
    expect(status.blockedReason).toBe('monthly_request_quota_exhausted');
    expect(checkSearchQuota('org-b', 0.03, home, now).allowed).toBe(true);
  });
});
