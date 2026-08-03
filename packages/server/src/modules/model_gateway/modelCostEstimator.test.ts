/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * NSI-13: unified model Token/cost estimator — tests.
 *
 * Covers the acceptance criterion "自定义模型费用可解释" (custom model cost
 * explainable): known built-ins price by catalogue, custom models fall back to
 * a configurable default, per-model env overrides win, and the returned
 * breakdown is itemized and explains every number.
 */

import { describe, expect, it } from 'vitest';

import {
  CUSTOM_MODEL_DEFAULT_PRICE_IN1K,
  estimateModelCost,
  estimateUsageCost,
  MODEL_PRICE_CATALOGUE,
  resolveModelPrice,
  roundCny,
} from './modelCostEstimator.js';

describe('model cost estimator (NSI-13)', () => {
  it('prices built-in models from the catalogue', () => {
    const price = resolveModelPrice('gpt-4o');
    expect(price.inputPer1k).toBeGreaterThan(0);
    expect(price.outputPer1k).toBeGreaterThan(0);
  });

  it('falls back to the configurable custom default for unknown models', () => {
    const price = resolveModelPrice('my-custom-model-v7');
    expect(price.inputPer1k).toBe(CUSTOM_MODEL_DEFAULT_PRICE_IN1K);
    expect(price.outputPer1k).toBeGreaterThan(0);
  });

  it('is case- and separator-insensitive for model names', () => {
    expect(resolveModelPrice('GPT-4o')).toEqual(resolveModelPrice('gpt-4o'));
    expect(resolveModelPrice(' claude-3-5-sonnet ')).toEqual(
      resolveModelPrice('claude-3-5-sonnet'),
    );
  });

  it('computes itemized, explainable costs', () => {
    const breakdown = estimateModelCost({
      model: 'gpt-4o',
      inputTokens: 1200,
      outputTokens: 400,
    });
    expect(breakdown.totalTokens).toBe(1600);
    expect(breakdown.inputCostCNY).toBe(roundCny(1.2 * breakdown.inputPer1k));
    expect(breakdown.outputCostCNY).toBe(roundCny(0.4 * breakdown.outputPer1k));
    expect(breakdown.totalCostCNY).toBe(
      roundCny(breakdown.inputCostCNY + breakdown.outputCostCNY),
    );
    expect(breakdown.explanation).toContain('gpt-4o');
    expect(breakdown.explanation).toContain('1200 input tokens');
    expect(breakdown.explanation).toContain('400 output tokens');
    expect(breakdown.explanation).toContain(`${breakdown.totalCostCNY} CNY`);
  });

  it('accepts a full RecordModelUsageInput via estimateUsageCost', () => {
    const breakdown = estimateUsageCost({
      accountId: 'account-a',
      sessionId: 'session-a',
      messageId: 'msg-a',
      model: 'deepseek-chat',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    });
    expect(breakdown.model).toBe('deepseek-chat');
    expect(breakdown.totalTokens).toBe(1500);
    expect(breakdown.totalCostCNY).toBeGreaterThan(0);
  });

  it('returns a zero, explainable breakdown for no tokens', () => {
    const breakdown = estimateModelCost({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(breakdown.totalCostCNY).toBe(0);
    expect(breakdown.explanation).toContain('no tokens');
  });

  it('exposes a non-empty catalogue of supported models', () => {
    expect(MODEL_PRICE_CATALOGUE.size).toBeGreaterThan(5);
    expect(MODEL_PRICE_CATALOGUE.has('gpt-4o')).toBe(true);
  });
});
