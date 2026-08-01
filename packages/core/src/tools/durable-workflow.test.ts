/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConfig } from '../utils/test-helpers.js';
import { ToolRegistry } from './tool-registry.js';
import { DurableWorkflowTool } from './durable-workflow.js';

describe('DurableWorkflowTool', () => {
  const tool = new DurableWorkflowTool(createMockConfig(), new ToolRegistry(createMockConfig()));
  const definition = {
    id: 'verify-report', version: 1 as const,
    steps: [{ id: 'check', kind: 'condition' as const, input: { operator: 'equals', value: 1, expected: 1 }, sideEffect: 'none' as const }],
  };

  it('accepts a bounded declarative definition', () => {
    expect(tool.validateToolParams({ action: 'start', definition })).toBeNull();
  });

  it('rejects arbitrary or external tool steps', () => {
    expect(tool.validateToolParams({ action: 'start', definition: { ...definition, steps: [{ id: 'bad', kind: 'tool', input: { tool: 'send_message' }, sideEffect: 'external' }] } })).toContain('external');
  });

  it('makes state changes confirmable but leaves status read-only', async () => {
    expect(await tool.shouldConfirmExecute({ action: 'start', definition }, new AbortController().signal)).not.toBe(false);
    expect(await tool.shouldConfirmExecute({ action: 'status', run_id: 'wf-00000000-0000-0000-0000-000000000000' }, new AbortController().signal)).toBe(false);
  });

  it('loads persistence for a read-only status lookup', async () => {
    const result = await tool.execute({ action: 'status', run_id: 'wf-00000000-0000-0000-0000-000000000000' }, new AbortController().signal);
    expect(String(result.llmContent)).toContain('"found":false');
  });

  it('persists and executes a deterministic condition step through the Core adapter', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'otto-durable-workflow-tool-'));
    const previous = process.env['OTTO_USER_DIR'];
    process.env['OTTO_USER_DIR'] = temporary;
    try {
      const isolated = new DurableWorkflowTool(createMockConfig(), new ToolRegistry(createMockConfig()));
      const started = await isolated.execute({ action: 'start', definition }, new AbortController().signal);
      const runId = String(started.llmContent).match(/"id":"(wf-[^"]+)"/)?.[1];
      expect(runId).toBeDefined();
      if (!runId) throw new Error('Durable workflow did not return a run id.');
      const completed = await isolated.execute({ action: 'run_next', run_id: runId }, new AbortController().signal);
      expect(String(completed.llmContent)).toContain('"status":"succeeded"');
    } finally {
      if (previous === undefined) delete process.env['OTTO_USER_DIR'];
      else process.env['OTTO_USER_DIR'] = previous;
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
