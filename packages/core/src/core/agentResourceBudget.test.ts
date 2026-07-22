/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getAgentResourceBudget } from './agentResourceBudget.js';

describe('getAgentResourceBudget', () => {
  it('uses a conservative low-device profile for small machines', () => {
    const budget = getAgentResourceBudget({}, 4 * 1024 * 1024 * 1024, 4);

    expect(budget.deviceClass).toBe('low');
    expect(budget.taskMaxConcurrency).toBe(1);
    expect(budget.workflowDefaultMaxConcurrency).toBe(2);
    expect(budget.workflowDefaultMaxAgents).toBeLessThan(50);
    expect(budget.subAgentHistoryMaxChars).toBe(60000);
  });

  it('keeps high-device defaults bounded instead of allowing runaway fan-out', () => {
    const budget = getAgentResourceBudget({}, 32 * 1024 * 1024 * 1024, 16);

    expect(budget.deviceClass).toBe('high');
    expect(budget.workflowDefaultMaxConcurrency).toBe(4);
    expect(budget.workflowMaxConcurrencyCeiling).toBe(8);
    expect(budget.workflowDefaultMaxAgents).toBe(64);
    expect(budget.subAgentHistoryMaxChars).toBe(120000);
  });

  it('clamps environment overrides to profile ceilings', () => {
    const budget = getAgentResourceBudget(
      {
        OTTO_AGENT_PROFILE: 'standard',
        OTTO_TASK_MAX_CONCURRENCY: '99',
        OTTO_WORKFLOW_MAX_CONCURRENCY: '99',
        OTTO_WORKFLOW_MAX_AGENTS: '9999',
        OTTO_SUBAGENT_HISTORY_MAX_CHARS: '999999',
      },
      16 * 1024 * 1024 * 1024,
      8,
    );

    expect(budget.taskMaxConcurrency).toBe(6);
    expect(budget.workflowDefaultMaxConcurrency).toBe(6);
    expect(budget.workflowDefaultMaxAgents).toBe(160);
    expect(budget.subAgentHistoryMaxChars).toBe(240000);
  });
});
