/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { WorklogEstimateConfiguration } from './worklogTypes.js';

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** These values are disclosed estimates, not measured business outcomes. */
export const ESTIMATE: WorklogEstimateConfiguration = {
  manualTimeMultiplier: envNum('OTTO_ESTIMATE_MANUAL_MULT', 2),
  cnyPerHour: envNum('OTTO_ESTIMATE_CNY_PER_HOUR', 50),
  defaultTokensPerTask: 2_000,
  defaultCostPerTaskCNY: 0.028,
  laborPerTokenCap: envNum('OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP', 50),
};

export function normalizeCostCNY(cost: unknown): number {
  const value = typeof cost === 'number' ? cost : Number(cost);
  return Number.isFinite(value) && value > 0
    ? value
    : ESTIMATE.defaultCostPerTaskCNY;
}

export function normalizeTokens(tokens: unknown): number {
  const value = typeof tokens === 'number' ? tokens : Number(tokens);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : ESTIMATE.defaultTokensPerTask;
}
