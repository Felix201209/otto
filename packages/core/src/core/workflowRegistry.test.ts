/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { WorkflowRegistry } from './workflowRegistry.js';

describe('WorkflowRegistry cancellation', () => {
  beforeEach(() => WorkflowRegistry.clear());

  it('atomically cancels the workflow and every running agent', () => {
    WorkflowRegistry.startWorkflow('wf-1', 'cancel me', [
      { name: 'phase', description: 'work' },
    ]);
    WorkflowRegistry.startAgent('wf-1', 'agent-running', 'running', 'prompt', undefined, 0);
    WorkflowRegistry.startAgent('wf-1', 'agent-done', 'done', 'prompt', undefined, 0);
    WorkflowRegistry.endAgent('wf-1', 'agent-done', 'completed', 'ok');

    WorkflowRegistry.cancelWorkflow('wf-1');

    const record = WorkflowRegistry.getById('wf-1')!;
    expect(record.status).toBe('cancelled');
    expect(record.endTime).toEqual(expect.any(Number));
    expect(record.phases[0]!.agents).toMatchObject([
      { agentId: 'agent-running', status: 'cancelled', endTime: expect.any(Number) },
      { agentId: 'agent-done', status: 'completed' },
    ]);
  });

  it('is idempotent and late results cannot overwrite cancelled state', () => {
    WorkflowRegistry.startWorkflow('wf-2', 'cancel race', []);
    WorkflowRegistry.startAgent('wf-2', 'agent-1', 'agent', 'prompt');
    WorkflowRegistry.cancelWorkflow('wf-2');
    const firstEndTime = WorkflowRegistry.getById('wf-2')!.endTime;

    WorkflowRegistry.cancelWorkflow('wf-2');
    WorkflowRegistry.endAgent('wf-2', 'agent-1', 'completed', 'late');
    WorkflowRegistry.endWorkflow('wf-2', 'completed');

    const record = WorkflowRegistry.getById('wf-2')!;
    expect(record.status).toBe('cancelled');
    expect(record.endTime).toBe(firstEndTime);
    expect(record.agents[0]!.status).toBe('cancelled');
  });

  it('does not start new agents after cancellation', () => {
    WorkflowRegistry.startWorkflow('wf-3', 'cancel queue', []);
    WorkflowRegistry.cancelWorkflow('wf-3');
    WorkflowRegistry.startAgent('wf-3', 'late-agent', 'late', 'prompt');

    expect(WorkflowRegistry.getById('wf-3')!.agents).toHaveLength(0);
  });
});
