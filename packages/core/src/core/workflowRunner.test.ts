/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for workflowRunner — covers bugs found during real-world testing:
 *
 * 1. Orchestrator script JS error (e.g. result.data.xxx where data is undefined)
 *    should NOT discard all agent output — partial results must be surfaced.
 * 2. extractMeta must correctly parse multi-line meta blocks.
 * 3. runWorkflowScript must return success:false + preserve capturedLogs on script throw.
 * 4. AbortSignal must propagate correctly and re-throw as AbortError.
 * 5. Scripts with no return value must produce a graceful "(workflow completed with no return value)".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWorkflowScript, extractMeta } from './workflowRunner.js';
import { WorkflowAgentAPI, WorkflowAgentRunResult } from './workflowAgentBridge.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAbortSignal(aborted = false): AbortSignal {
  const ctrl = new AbortController();
  if (aborted) ctrl.abort();
  return ctrl.signal;
}

/** A mock WorkflowAgentAPI that returns preset results without network I/O. */
function makeMockAPI(
  runResult: Partial<WorkflowAgentRunResult> = {},
): WorkflowAgentAPI {
  const defaultResult: WorkflowAgentRunResult = {
    success: true,
    result: 'ok',
    data: { answer: 42 },
    tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...runResult,
  };
  return {
    run: vi.fn().mockResolvedValue(defaultResult),
    runParallel: vi.fn().mockResolvedValue([defaultResult]),
    setCurrentPhaseIndex: vi.fn(),
  };
}

// ─── extractMeta ─────────────────────────────────────────────────────────────

describe('extractMeta', () => {
  it('parses a simple single-line meta block', () => {
    const script = `export const meta = { name: 'test', description: '测试' };\n`;
    const meta = extractMeta(script);
    expect(meta.name).toBe('test');
    expect(meta.description).toBe('测试');
  });

  it('parses a multi-line meta block with phases', () => {
    const script = `
export const meta = {
  name: 'audit',
  description: '安全审计',
  phases: [
    { title: '收集', detail: '收集代码信息' },
    { title: '分析', detail: '分析漏洞' },
  ],
};
export default async function(agent) { return 'done'; }
`;
    const meta = extractMeta(script);
    expect(meta.name).toBe('audit');
    expect(meta.phases).toHaveLength(2);
    expect(meta.phases![0]!.title).toBe('收集');
    expect(meta.phases![1]!.title).toBe('分析');
  });

  it('returns empty object when no meta block exists', () => {
    const script = `export default async function(agent) { return 'done'; }`;
    expect(extractMeta(script)).toEqual({});
  });

  it('returns empty object on malformed meta', () => {
    const script = `export const meta = { name: INVALID_EXPR };\n`;
    expect(extractMeta(script)).toEqual({});
  });
});

// ─── runWorkflowScript — success paths ───────────────────────────────────────

describe('runWorkflowScript — success', () => {
  it('returns success:true and output from script return value', async () => {
    const script = `
export default async function(agent) {
  return 'all done';
}
`;
    const result = await runWorkflowScript(script, makeMockAPI(), makeAbortSignal());
    expect(result.success).toBe(true);
    expect(result.output).toBe('all done');
  });

  it('serializes non-string return values to JSON', async () => {
    const script = `
export default async function(agent) {
  return { files: ['a.ts', 'b.ts'], coverage: 92 };
}
`;
    const result = await runWorkflowScript(script, makeMockAPI(), makeAbortSignal());
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.coverage).toBe(92);
  });

  it('handles no return value gracefully', async () => {
    const script = `
export default async function(agent) {
  // no return
}
`;
    const result = await runWorkflowScript(script, makeMockAPI(), makeAbortSignal());
    expect(result.success).toBe(true);
    expect(result.output).toBe('(workflow completed with no return value)');
  });

  it('accumulates token usage across multiple agent calls', async () => {
    const api = makeMockAPI({
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    const script = `
export default async function(agent) {
  await agent('task 1', { label: 'A' });
  await agent('task 2', { label: 'B' });
  return 'done';
}
`;
    const result = await runWorkflowScript(script, api, makeAbortSignal());
    expect(result.totalTokenUsage.inputTokens).toBe(200);
    expect(result.totalTokenUsage.outputTokens).toBe(100);
    expect(result.totalTokenUsage.totalTokens).toBe(300);
  });

  it('supports agent.run({prompt}) call style', async () => {
    const api = makeMockAPI();
    const script = `
export default async function(agent) {
  const r = await agent.run({ prompt: 'analyze this', label: 'Test' });
  return r.result;
}
`;
    const result = await runWorkflowScript(script, api, makeAbortSignal());
    expect(result.success).toBe(true);
    expect(api.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'analyze this' }));
  });

  it('supports agent.runParallel([...]) call style', async () => {
    const api = makeMockAPI();
    const script = `
export default async function(agent) {
  const results = await agent.runParallel([
    { prompt: 'task A' },
    { prompt: 'task B' },
  ]);
  return results.length.toString();
}
`;
    const result = await runWorkflowScript(script, api, makeAbortSignal());
    expect(result.success).toBe(true);
    expect(api.runParallel).toHaveBeenCalledTimes(1);
  });
});

// ─── runWorkflowScript — error paths (key real-world bugs) ───────────────────

describe('runWorkflowScript — error handling', () => {
  /**
   * Bug reproduced: orchestrator script accesses result.data.markdown_report
   * but data was undefined → TypeError crashes the entire workflow, discarding
   * all agent output. Fix: partial output must be preserved in error.
   */
  it('preserves partial console.log output when orchestrator script throws', async () => {
    const api = makeMockAPI({ result: 'Agent output text', data: undefined });
    const script = `
export default async function(agent) {
  const r = await agent('analyze', { label: 'step1' });
  console.log('Step 1 done: ' + r.result);
  // Simulate accessing a missing field — real bug: result.data.markdown_report
  const x = r.data.nonexistent_field.deeper;
  return x;
}
`;
    const result = await runWorkflowScript(script, api, makeAbortSignal());
    expect(result.success).toBe(false);
    expect(result.error).toContain('TypeError');
    // Partial output from console.log must be preserved
    expect(result.error).toContain('Step 1 done');
    expect(result.output).toContain('Step 1 done');
  });

  it('returns success:false with error message on script syntax error', async () => {
    const script = `
export default async function(agent) {
  const x = {{{; // syntax error
}
`;
    // vm.Script compilation throws — caught before execution
    const result = await runWorkflowScript(script, makeMockAPI(), makeAbortSignal());
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns success:false when script has no default export', async () => {
    const script = `
export const notDefault = () => {};
`;
    const result = await runWorkflowScript(script, makeMockAPI(), makeAbortSignal());
    expect(result.success).toBe(false);
    // Either a syntax error (from leftover export keyword after transpile) or
    // a "must export a default" error — both are valid failure modes
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('re-throws AbortError without wrapping in success:false', async () => {
    const ctrl = new AbortController();
    const api: WorkflowAgentAPI = {
      run: vi.fn().mockImplementation(() => {
        ctrl.abort();
        const err = new Error('AbortError');
        err.name = 'AbortError';
        return Promise.reject(err);
      }),
      runParallel: vi.fn(),
      setCurrentPhaseIndex: vi.fn(),
    };
    const script = `
export default async function(agent) {
  await agent('task', { label: 'T' });
  return 'done';
}
`;
    await expect(
      runWorkflowScript(script, api, ctrl.signal)
    ).rejects.toThrow('AbortError');
  });

  it('does not discard tokenUsage even when script throws after agent calls', async () => {
    const api = makeMockAPI({
      tokenUsage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
    });
    const script = `
export default async function(agent) {
  await agent('task 1');
  throw new Error('deliberate error');
}
`;
    const result = await runWorkflowScript(script, api, makeAbortSignal());
    expect(result.success).toBe(false);
    // Token usage from completed agents must still be reported
    expect(result.totalTokenUsage.totalTokens).toBe(75);
  });
});

// ─── phase() integration ─────────────────────────────────────────────────────

describe('runWorkflowScript — phase tracking', () => {
  it('calls phase() without throwing and updates agentAPI.currentPhaseIndex', async () => {
    const api = {
      ...makeMockAPI(),
      currentPhaseIndex: 0,
    };
    const script = `
export const meta = {
  name: 'test',
  description: 'test',
  phases: [{ title: '阶段一' }, { title: '阶段二' }],
};
export default async function(agent) {
  phase('阶段一');
  await agent('task 1');
  phase('阶段二');
  await agent('task 2');
  return 'done';
}
`;
    const result = await runWorkflowScript(script, api as WorkflowAgentAPI, makeAbortSignal());
    expect(result.success).toBe(true);
    // After script completes, phase index should be at index 1 (阶段二)
    expect((api as any).currentPhaseIndex).toBe(1);
  });
});
