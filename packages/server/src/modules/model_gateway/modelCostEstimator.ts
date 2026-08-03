/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * NSI-13: unified model Token/cost estimation for custom and built-in models.
 *
 * High-level goals from NSI-13:
 *   - unify how custom-model Token/cost estimates are produced;
 *   - make custom-model costs explainable (itemized input/output/overhead).
 *
 * This module is intentionally pure (no database) so it:
 *   - can be unit-tested without fixtures,
 *   - is usable by both the model gateway and the billing/execution-receipt path,
 *   - keeps disclosed estimates separate from measured billing outcomes.
 */

import type { RecordModelUsageInput } from './modelUsageTypes.js';

/** Price per 1000 tokens, in CNY. */
export interface ModelPrice {
  readonly inputPer1k: number;
  readonly outputPer1k: number;
}

/** Itemized, explainable cost breakdown for a single model call. */
export interface ModelCostBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputPer1k: number;
  outputPer1k: number;
  inputCostCNY: number;
  outputCostCNY: number;
  totalCostCNY: number;
  /** Human-readable explanation used for the "费用可解释" acceptance evidence. */
  explanation: string;
}

const ZERO = { inputPer1k: 0, outputPer1k: 0 };

function envNum(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function modelKey(model: string | null | undefined): string {
  return (model ?? '').trim().toLowerCase();
}

/**
 * Built-in price catalogue. Values are disclosed default estimates and can be
 * overridden via environment variables for a given model:
 *   OTTO_MODEL_PRICE_<UPPER_SNAKE>_IN1K
 *   OTTO_MODEL_PRICE_<UPPER_SNAKE>_OUT1K
 * Custom (unrecognized) models fall back to a configurable default.
 */
export const MODEL_PRICE_CATALOGUE: ReadonlyMap<string, ModelPrice> = new Map<
  string,
  ModelPrice
>([
  // Indicative default per-1k-token CNY estimates (input / output).
  ['gpt-4o', { inputPer1k: 0.0019, outputPer1k: 0.0076 }],
  ['gpt-4o-mini', { inputPer1k: 0.00015, outputPer1k: 0.0006 }],
  ['gpt-4.1', { inputPer1k: 0.0019, outputPer1k: 0.0076 }],
  ['o1', { inputPer1k: 0.0108, outputPer1k: 0.0432 }],
  ['o1-mini', { inputPer1k: 0.00082, outputPer1k: 0.0033 }],
  ['claude-3-5-sonnet', { inputPer1k: 0.0023, outputPer1k: 0.0115 }],
  ['claude-3-7-sonnet', { inputPer1k: 0.0023, outputPer1k: 0.0115 }],
  ['claude-3-5-haiku', { inputPer1k: 0.00064, outputPer1k: 0.0032 }],
  ['gemini-2.5-pro', { inputPer1k: 0.00105, outputPer1k: 0.0042 }],
  ['gemini-2.5-flash', { inputPer1k: 0.00023, outputPer1k: 0.0009 }],
  ['deepseek-chat', { inputPer1k: 0.00027, outputPer1k: 0.0011 }],
  ['deepseek-reasoner', { inputPer1k: 0.00055, outputPer1k: 0.0022 }],
  ['qwen-max', { inputPer1k: 0.0013, outputPer1k: 0.0052 }],
  ['qwen-plus', { inputPer1k: 0.00039, outputPer1k: 0.0016 }],
  ['doubao-pro-32k', { inputPer1k: 0.00064, outputPer1k: 0.00257 }],
  ['doubao-lite-32k', { inputPer1k: 0.00026, outputPer1k: 0.00103 }],
]);

/** Configurable default price for unrecognized (custom) models, in CNY/1k. */
export const CUSTOM_MODEL_DEFAULT_PRICE_IN1K = envNum(
  'OTTO_CUSTOM_MODEL_PRICE_IN1K',
) ?? 0.0005;
export const CUSTOM_MODEL_DEFAULT_PRICE_OUT1K = envNum(
  'OTTO_CUSTOM_MODEL_PRICE_OUT1K',
) ?? 0.002;

function envKeyFor(model: string, suffix: 'IN1K' | 'OUT1K'): string {
  const snake = modelKey(model).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `OTTO_MODEL_PRICE_${snake.toUpperCase()}_${suffix}`;
}

/**
 * Resolves the price for a model: built-in catalogue (with env override) or a
 * per-model env override, falling back to the custom default for unknown models.
 */
export function resolveModelPrice(model: string | null | undefined): ModelPrice {
  const key = modelKey(model);
  if (!key) return ZERO;

  const inEnv = envNum(envKeyFor(key, 'IN1K'));
  const outEnv = envNum(envKeyFor(key, 'OUT1K'));
  if (inEnv != null || outEnv != null) {
    return {
      inputPer1k: inEnv ?? CUSTOM_MODEL_DEFAULT_PRICE_IN1K,
      outputPer1k: outEnv ?? CUSTOM_MODEL_DEFAULT_PRICE_OUT1K,
    };
  }

  const builtIn = MODEL_PRICE_CATALOGUE.get(key);
  if (builtIn) return builtIn;

  return {
    inputPer1k: CUSTOM_MODEL_DEFAULT_PRICE_IN1K,
    outputPer1k: CUSTOM_MODEL_DEFAULT_PRICE_OUT1K,
  };
}

function safeTokens(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Rounds a CNY amount to a stable, readable precision. */
export function roundCny(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Estimates cost from token counts. Returns an explainable breakdown.
 * Zero-cost models or missing model yield an all-zero breakdown.
 */
export function estimateModelCost(
  input: Pick<RecordModelUsageInput, 'model' | 'inputTokens' | 'outputTokens'>,
): ModelCostBreakdown {
  const modelName = (input.model ?? '').trim() || 'custom';
  const inputTokens = safeTokens(input.inputTokens);
  const outputTokens = safeTokens(input.outputTokens);
  const price = resolveModelPrice(modelName);

  const inputCostCNY = roundCny((inputTokens / 1000) * price.inputPer1k);
  const outputCostCNY = roundCny((outputTokens / 1000) * price.outputPer1k);

  let explanation: string;
  if (inputTokens === 0 && outputTokens === 0) {
    explanation = `Model "${modelName}" reported no tokens; cost 0 CNY.`;
  } else if (price.inputPer1k === 0 && price.outputPer1k === 0) {
    explanation = `Model "${modelName}" has zero configured price; cost 0 CNY.`;
  } else {
    explanation =
      `Model "${modelName}": ${inputTokens} input tokens × ${price.inputPer1k}/1k ` +
      `= ${inputCostCNY} CNY; ${outputTokens} output tokens × ${price.outputPer1k}/1k ` +
      `= ${outputCostCNY} CNY; total ${roundCny(inputCostCNY + outputCostCNY)} CNY.`;
  }

  return {
    model: modelName,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputPer1k: price.inputPer1k,
    outputPer1k: price.outputPer1k,
    inputCostCNY,
    outputCostCNY,
    totalCostCNY: roundCny(inputCostCNY + outputCostCNY),
    explanation,
  };
}

/** Convenience: estimate cost directly from a RecordModelUsageInput. */
export function estimateUsageCost(
  input: RecordModelUsageInput,
): ModelCostBreakdown {
  return estimateModelCost({
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  });
}
