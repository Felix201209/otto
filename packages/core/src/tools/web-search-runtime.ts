/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { WebSearchProvider } from '../config/config.js';
import type { ToolResult } from './tools.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 200;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 60 * 1000;
const RATE_LIMIT_OPEN_MS = 2 * 60 * 1000;

export interface CachedWebSearchResult {
  llmContent: unknown;
  returnDisplay: ToolResult['returnDisplay'];
  sources?: Array<{ web?: { uri?: string; title?: string } }>;
}

export type SearchProviderHealthStatus =
  'untested' | 'healthy' | 'degraded' | 'open';

export interface SearchProviderDiagnostic {
  provider: WebSearchProvider;
  status: SearchProviderHealthStatus;
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  averageLatencyMs: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastErrorCode?: string;
  openUntil?: number;
  estimatedCostCny: number;
}

export interface WebSearchDiagnosticsSnapshot {
  tenantId: string;
  cacheEntries: number;
  cacheHits: number;
  totalAttempts: number;
  totalSuccesses: number;
  estimatedCostCny: number;
  providers: SearchProviderDiagnostic[];
  quota?: SearchQuotaDiagnostic;
  updatedAt: number;
}

export interface SearchQuotaDiagnostic {
  periodStart: number;
  periodEnd: number;
  requestLimit?: number;
  requestsUsed: number;
  budgetLimitCny?: number;
  budgetUsedCny: number;
  blocked: boolean;
  blockedReason?: string;
}

export interface SearchTelemetryEvent {
  tenantId: string;
  provider?: WebSearchProvider;
  kind: 'provider_attempt' | 'cache_hit' | 'circuit_skip';
  success: boolean;
  latencyMs: number;
  errorCode?: string;
  estimatedCostCny: number;
  timestamp: number;
}

interface ProviderHealthState {
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  totalLatencyMs: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastErrorCode?: string;
  openUntil?: number;
}

interface TenantProviderUsage {
  attempts: number;
  successes: number;
  failures: number;
  estimatedCostCny: number;
}

interface TenantUsageState {
  cacheHits: number;
  providers: Map<WebSearchProvider, TenantProviderUsage>;
}

interface CacheEntry {
  value: CachedWebSearchResult;
  expiresAt: number;
}

const providers: readonly WebSearchProvider[] = [
  'bocha',
  'volcengine',
  'gemini',
  'bing',
];
const healthByTenant = new Map<
  string,
  Map<WebSearchProvider, ProviderHealthState>
>();
const usageByTenant = new Map<string, TenantUsageState>();
const cache = new Map<string, CacheEntry>();

function normalizedTenantId(tenantId: string): string {
  return tenantId.trim() || 'local';
}

function providerHealth(
  tenantId: string,
  provider: WebSearchProvider,
): ProviderHealthState {
  const tenantKey = normalizedTenantId(tenantId);
  let tenant = healthByTenant.get(tenantKey);
  if (!tenant) {
    tenant = new Map();
    healthByTenant.set(tenantKey, tenant);
  }
  let state = tenant.get(provider);
  if (!state) {
    state = {
      attempts: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      totalLatencyMs: 0,
    };
    tenant.set(provider, state);
  }
  return state;
}

function tenantUsage(tenantId: string): TenantUsageState {
  const key = tenantId.trim() || 'local';
  let state = usageByTenant.get(key);
  if (!state) {
    state = { cacheHits: 0, providers: new Map() };
    usageByTenant.set(key, state);
  }
  return state;
}

function tenantProviderUsage(
  tenantId: string,
  provider: WebSearchProvider,
): TenantProviderUsage {
  const tenant = tenantUsage(tenantId);
  let usage = tenant.providers.get(provider);
  if (!usage) {
    usage = { attempts: 0, successes: 0, failures: 0, estimatedCostCny: 0 };
    tenant.providers.set(provider, usage);
  }
  return usage;
}

function cloneResult(value: CachedWebSearchResult): CachedWebSearchResult {
  return {
    ...value,
    sources: value.sources?.map((source) => ({
      web: source.web ? { ...source.web } : undefined,
    })),
  };
}

function cacheKey(query: string, tenantId = 'local'): string {
  const tenant = tenantId.trim() || 'local';
  const normalizedQuery = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return `${tenant}\u0000${normalizedQuery}`;
}

function pruneCache(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function getCachedWebSearchResult(
  query: string,
  now = Date.now(),
  tenantId = 'local',
): CachedWebSearchResult | undefined {
  pruneCache(now);
  const key = cacheKey(query, tenantId);
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  return cloneResult(entry.value);
}

export function cacheWebSearchResult(
  query: string,
  result: CachedWebSearchResult,
  now = Date.now(),
  tenantId = 'local',
): void {
  const key = cacheKey(query, tenantId);
  cache.delete(key);
  cache.set(key, {
    value: cloneResult(result),
    expiresAt: now + CACHE_TTL_MS,
  });
  pruneCache(now);
}

export function classifySearchError(message: string): string {
  const normalized = message.toLowerCase();
  if (/429|rate.?limit|too many requests/.test(normalized))
    return 'rate_limited';
  if (/401|403|unauthori[sz]ed|forbidden|api key/.test(normalized))
    return 'authentication';
  if (/timeout|timed out|abort/.test(normalized)) return 'timeout';
  if (/verification|captcha|unrecognized page/.test(normalized))
    return 'verification';
  if (/circuit/.test(normalized)) return 'circuit_open';
  if (/network|fetch failed|econn|enotfound|dns/.test(normalized))
    return 'network';
  return 'provider_error';
}

export function canAttemptSearchProvider(
  provider: WebSearchProvider,
  now = Date.now(),
  tenantId = 'local',
): { allowed: boolean; retryAt?: number } {
  const state = providerHealth(tenantId, provider);
  if (state.openUntil && state.openUntil > now) {
    return { allowed: false, retryAt: state.openUntil };
  }
  if (state.openUntil && state.openUntil <= now) {
    state.openUntil = undefined;
  }
  return { allowed: true };
}

export function recordSearchProviderAttempt(input: {
  tenantId: string;
  provider: WebSearchProvider;
  success: boolean;
  latencyMs: number;
  errorCode?: string;
  estimatedCostCny?: number;
  now?: number;
}): SearchTelemetryEvent {
  const now = input.now ?? Date.now();
  const cost = Math.max(0, input.estimatedCostCny ?? 0);
  const health = providerHealth(input.tenantId, input.provider);
  const usage = tenantProviderUsage(input.tenantId, input.provider);

  health.attempts += 1;
  health.totalLatencyMs += Math.max(0, input.latencyMs);
  health.lastAttemptAt = now;
  usage.attempts += 1;
  usage.estimatedCostCny += cost;

  if (input.success) {
    health.successes += 1;
    health.consecutiveFailures = 0;
    health.lastSuccessAt = now;
    health.lastErrorCode = undefined;
    health.openUntil = undefined;
    usage.successes += 1;
  } else {
    const errorCode = input.errorCode ?? 'provider_error';
    health.failures += 1;
    health.consecutiveFailures += 1;
    health.lastErrorCode = errorCode;
    usage.failures += 1;
    if (errorCode === 'rate_limited') {
      health.openUntil = now + RATE_LIMIT_OPEN_MS;
    } else if (health.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      health.openUntil = now + CIRCUIT_OPEN_MS;
    }
  }

  return {
    tenantId: input.tenantId.trim() || 'local',
    provider: input.provider,
    kind: 'provider_attempt',
    success: input.success,
    latencyMs: Math.max(0, input.latencyMs),
    errorCode: input.success ? undefined : input.errorCode,
    estimatedCostCny: cost,
    timestamp: now,
  };
}

export function recordSearchCacheHit(
  tenantId: string,
  now = Date.now(),
): SearchTelemetryEvent {
  tenantUsage(tenantId).cacheHits += 1;
  return {
    tenantId: tenantId.trim() || 'local',
    kind: 'cache_hit',
    success: true,
    latencyMs: 0,
    estimatedCostCny: 0,
    timestamp: now,
  };
}

export function searchCircuitSkipEvent(
  tenantId: string,
  provider: WebSearchProvider,
  now = Date.now(),
): SearchTelemetryEvent {
  return {
    tenantId: tenantId.trim() || 'local',
    provider,
    kind: 'circuit_skip',
    success: false,
    latencyMs: 0,
    errorCode: 'circuit_open',
    estimatedCostCny: 0,
    timestamp: now,
  };
}

export function getWebSearchDiagnostics(
  tenantId = 'local',
  now = Date.now(),
): WebSearchDiagnosticsSnapshot {
  pruneCache(now);
  const tenant = tenantUsage(tenantId);
  const diagnostics = providers.map((provider): SearchProviderDiagnostic => {
    const health = providerHealth(tenantId, provider);
    const usage = tenant.providers.get(provider) ?? {
      attempts: 0,
      successes: 0,
      failures: 0,
      estimatedCostCny: 0,
    };
    const open = Boolean(health.openUntil && health.openUntil > now);
    const status: SearchProviderHealthStatus = open
      ? 'open'
      : health.attempts === 0
        ? 'untested'
        : health.consecutiveFailures > 0
          ? 'degraded'
          : 'healthy';
    return {
      provider,
      status,
      attempts: usage.attempts,
      successes: usage.successes,
      failures: usage.failures,
      consecutiveFailures: health.consecutiveFailures,
      averageLatencyMs:
        health.attempts > 0
          ? Math.round(health.totalLatencyMs / health.attempts)
          : 0,
      lastAttemptAt: health.lastAttemptAt,
      lastSuccessAt: health.lastSuccessAt,
      lastErrorCode: health.lastErrorCode,
      openUntil: open ? health.openUntil : undefined,
      estimatedCostCny: Number(usage.estimatedCostCny.toFixed(6)),
    };
  });
  return {
    tenantId: tenantId.trim() || 'local',
    cacheEntries: [...cache.keys()].filter((key) =>
      key.startsWith(`${tenantId.trim() || 'local'}\u0000`),
    ).length,
    cacheHits: tenant.cacheHits,
    totalAttempts: diagnostics.reduce((sum, item) => sum + item.attempts, 0),
    totalSuccesses: diagnostics.reduce((sum, item) => sum + item.successes, 0),
    estimatedCostCny: Number(
      diagnostics
        .reduce((sum, item) => sum + item.estimatedCostCny, 0)
        .toFixed(6),
    ),
    providers: diagnostics,
    updatedAt: now,
  };
}

export function resetWebSearchRuntimeForTests(): void {
  healthByTenant.clear();
  usageByTenant.clear();
  cache.clear();
}
