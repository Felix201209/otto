/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  cacheWebSearchResult,
  canAttemptSearchProvider,
  classifySearchError,
  getCachedWebSearchResult,
  getWebSearchDiagnostics,
  recordSearchCacheHit,
  recordSearchProviderAttempt,
  resetWebSearchRuntimeForTests,
} from './web-search-runtime.js';

describe('web search runtime', () => {
  beforeEach(() => resetWebSearchRuntimeForTests());

  it('caches normalized queries and expires them after five minutes', () => {
    cacheWebSearchResult(
      '  Otto   Search ',
      {
        llmContent: 'result',
        returnDisplay: 'ok',
      },
      1000,
    );
    expect(getCachedWebSearchResult('otto search', 2000)?.llmContent).toBe(
      'result',
    );
    expect(getCachedWebSearchResult('otto search', 302_001)).toBeUndefined();
  });

  it('opens a provider circuit after three failures and closes it after cooldown', () => {
    for (let index = 0; index < 3; index += 1) {
      recordSearchProviderAttempt({
        tenantId: 'org-a',
        provider: 'bocha',
        success: false,
        latencyMs: 100,
        errorCode: 'network',
        now: 1000 + index,
      });
    }
    expect(canAttemptSearchProvider('bocha', 2000, 'org-a').allowed).toBe(false);
    expect(canAttemptSearchProvider('bocha', 2000, 'org-b').allowed).toBe(true);
    expect(canAttemptSearchProvider('bocha', 62_000, 'org-a').allowed).toBe(true);
  });

  it('isolates usage and estimated cost by tenant', () => {
    recordSearchProviderAttempt({
      tenantId: 'org-a',
      provider: 'volcengine',
      success: true,
      latencyMs: 80,
      estimatedCostCny: 0.02,
      now: 1000,
    });
    recordSearchCacheHit('org-a', 1001);
    recordSearchProviderAttempt({
      tenantId: 'org-b',
      provider: 'volcengine',
      success: false,
      latencyMs: 90,
      errorCode: 'timeout',
      estimatedCostCny: 0.02,
      now: 1002,
    });

    const a = getWebSearchDiagnostics('org-a', 2000);
    const b = getWebSearchDiagnostics('org-b', 2000);
    expect(a.totalAttempts).toBe(1);
    expect(a.totalSuccesses).toBe(1);
    expect(a.cacheHits).toBe(1);
    expect(a.estimatedCostCny).toBe(0.02);
    expect(b.totalAttempts).toBe(1);
    expect(b.totalSuccesses).toBe(0);
  });

  it('does not share cached results across tenants', () => {
    cacheWebSearchResult(
      'private enterprise query',
      { llmContent: 'org-a result', returnDisplay: 'ok' },
      1000,
      'org-a',
    );
    expect(
      getCachedWebSearchResult('private enterprise query', 2000, 'org-a')
        ?.llmContent,
    ).toBe('org-a result');
    expect(
      getCachedWebSearchResult('private enterprise query', 2000, 'org-b'),
    ).toBeUndefined();
  });

  it('classifies actionable provider failures', () => {
    expect(classifySearchError('HTTP 429 Too Many Requests')).toBe(
      'rate_limited',
    );
    expect(classifySearchError('request timed out')).toBe('timeout');
    expect(classifySearchError('captcha verification page')).toBe(
      'verification',
    );
  });
});
