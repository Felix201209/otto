/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { HabitAnalyzer } from './habitAnalyzer.js';
import { RecurringTaskRegistry } from '../services/recurringTaskRegistry.js';

describe('HabitAnalyzer background safety', () => {
  it('does not schedule model analysis by default', () => {
    const registry = new RecurringTaskRegistry({ allowPaidBackground: true });
    const analyzer = new HabitAnalyzer({ taskRegistry: registry });

    expect(analyzer.start()).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it('registers opted-in analysis with cost, source and input version', () => {
    const registry = new RecurringTaskRegistry({ allowPaidBackground: true });
    const analyzer = new HabitAnalyzer({
      backgroundModelCallsEnabled: true,
      taskRegistry: registry,
    });
    analyzer.feed({
      action: 'edit', category: 'code', success: true,
      timestamp: '2026-08-27T00:00:00.000Z', toolName: 'patch',
    });

    expect(analyzer.start()).toBe(true);
    expect(registry.list()).toMatchObject([{
      name: 'habit-analyzer-model-analysis',
      source: 'packages/core/src/orchestration/habitAnalyzer.ts',
      estimatedCostUsdPerRun: 0.01,
      inputVersion: '1:2026-08-27T00:00:00.000Z',
      stop: expect.any(Function),
    }]);
    analyzer.stop();
    expect(registry.list()).toEqual([]);
  });

  it('applies explicit runtime opt-in and opt-out immediately', () => {
    const registry = new RecurringTaskRegistry({ allowPaidBackground: true });
    const analyzer = new HabitAnalyzer({ taskRegistry: registry });

    analyzer.setBackgroundModelCallsEnabled(true);
    expect(registry.list()).toHaveLength(1);

    analyzer.setBackgroundModelCallsEnabled(false);
    expect(registry.list()).toEqual([]);
  });
});
