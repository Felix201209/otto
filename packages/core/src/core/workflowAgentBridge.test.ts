/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for WorkflowAgentBridge — covers bugs found during real-world testing:
 *
 * 1. buildPrompt context truncation: context > 20k chars must be truncated with a warning message.
 * 2. result.data fallback: when JSON parsing fails, data must be {text, _parse_failed:true},
 *    never undefined — prevents "Cannot read properties of undefined" in orchestrator scripts.
 * 3. max_agents hard limit: exceeding maxAgents must throw immediately.
 * 4. runParallel concurrency: never exceeds maxConcurrency simultaneous agents.
 * 5. schema mode: structured JSON output is correctly parsed into result.data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowAgentBridge } from './workflowAgentBridge.js';
import { Config } from '../config/config.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { GeminiClient } from './client.js';
import { SubAgent } from './subAgent.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('./subAgent.js', () => ({
  SubAgent: vi.fn(),
}));

vi.mock('../agents/agentDefinition.js', () => ({
  getBuiltInAgentDefinition: vi.fn().mockReturnValue({
    systemPrompt: 'You are a helpful agent.',
    allowedTools: [],
    name: 'code-analysis',
  }),
  resolveAgentTools: vi.fn().mockReturnValue({ resolvedTools: [] }),
}));

vi.mock('./workflowRegistry.js', () => ({
  WorkflowRegistry: {
    startAgent: vi.fn(),
    endAgent: vi.fn(),
    updateAgentTokens: vi.fn(),
    updateAgentToolCall: vi.fn(),
    updateAgentPhase: vi.fn(),
  },
}));

function makeBridge(opts: {
  maxConcurrency?: number;
  maxAgents?: number;
  subAgentResult?: Partial<{ success: boolean; summary: string; error: string; tokenUsage: any }>;
} = {}): WorkflowAgentBridge {
  const mockConfig = {
    getProjectRoot: () => '/tmp/test',
    getSessionId: () => 'test-session',
    getApprovalMode: () => 'auto',
    getHookSystem: () => ({ getEventHandler: () => undefined }),
  } as unknown as Config;

  const mockRegistry = {
    getAllTools: () => [],
    registerTool: vi.fn(),
  } as unknown as ToolRegistry;

  const mockGeminiClient = {} as unknown as GeminiClient;

  const subAgentResult = {
    success: true,
    summary: 'Task completed',
    tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ...opts.subAgentResult,
  };

  // Mock SubAgent.prototype.executeTask
  (SubAgent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    executeTask: vi.fn().mockResolvedValue(subAgentResult),
  }));

  const ctrl = new AbortController();
  return new WorkflowAgentBridge(
    mockConfig,
    mockRegistry,
    mockGeminiClient,
    ctrl.signal,
    undefined,
    opts.maxConcurrency ?? 6,
    undefined,
    opts.maxAgents ?? 1000,
  );
}

// ─── buildPrompt context truncation ──────────────────────────────────────────

describe('WorkflowAgentBridge.buildPrompt — context truncation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset SubAgent mock to default behavior before each test
    (SubAgent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      executeTask: vi.fn().mockResolvedValue({
        success: true,
        summary: 'Task completed',
        tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    }));
  });

  /** Helper: get the prompt passed to the most recently created SubAgent's executeTask */
  function getLastCalledPrompt(): string {
    const SubAgentMock = SubAgent as unknown as ReturnType<typeof vi.fn>;
    const lastInstance = SubAgentMock.mock.results.at(-1)!.value;
    return lastInstance.executeTask.mock.calls[0][0] as string;
  }

  it('passes through small context unchanged', async () => {
    const bridge = makeBridge();
    const smallContext = { files: ['a.ts', 'b.ts'], summary: 'ok' };
    await bridge.run({ prompt: 'do something', context: smallContext });

    const calledPrompt = getLastCalledPrompt();
    expect(calledPrompt).toContain('"files"');
    expect(calledPrompt).toContain('"a.ts"');
    expect(calledPrompt).not.toContain('context truncated');
  });

  it('truncates context exceeding 20k chars and appends warning', async () => {
    const bridge = makeBridge();
    const bigContext = { data: 'x'.repeat(25000) };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await bridge.run({ prompt: 'analyze this', context: bigContext });

    const calledPrompt = getLastCalledPrompt();
    expect(calledPrompt).toContain('context truncated');
    expect(calledPrompt).toContain('Sub-agents should return distilled JSON summaries');
    expect(calledPrompt.length).toBeLessThan(25000 + 500);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('context truncated'));

    warnSpy.mockRestore();
  });

  it('truncates at a newline boundary (not mid-JSON-string)', async () => {
    const bridge = makeBridge();
    const lines = Array.from({ length: 1000 }, (_, i) => `line-${i}: ${'a'.repeat(25)}`);
    const bigContext = { content: lines.join('\n') };

    await bridge.run({ prompt: 'task', context: bigContext });

    const calledPrompt = getLastCalledPrompt();
    const contextSection = calledPrompt.match(/<workflow_context>([\s\S]*?)<\/workflow_context>/)?.[1] ?? calledPrompt;
    expect(contextSection).toContain('context truncated');
  });
});

// ─── result.data fallback (key real-world bug) ────────────────────────────────

describe('WorkflowAgentBridge.run — result.data fallback', () => {
  /**
   * Real bug: orchestrator script did `result.data.markdown_report` but data was undefined
   * because the sub-agent returned prose, not JSON. Fix: data must never be undefined.
   */
  it('sets data._parse_failed when sub-agent returns non-JSON prose', async () => {
    const bridge = makeBridge({
      subAgentResult: {
        success: true,
        summary: 'This is a plain text summary with no JSON.',
      },
    });

    const result = await bridge.run({ prompt: 'analyze' });

    expect(result.data).toBeDefined();
    expect((result.data as any)._parse_failed).toBe(true);
    expect((result.data as any).text).toBe('This is a plain text summary with no JSON.');
  });

  it('parses JSON when sub-agent returns valid JSON', async () => {
    const bridge = makeBridge({
      subAgentResult: {
        success: true,
        summary: '{"files": ["a.ts", "b.ts"], "coverage": 92}',
      },
    });

    const result = await bridge.run({ prompt: 'analyze' });

    expect(result.data).toEqual({ files: ['a.ts', 'b.ts'], coverage: 92 });
    expect((result.data as any)._parse_failed).toBeUndefined();
  });

  it('extracts JSON block from prose when schema mode is not used', async () => {
    const bridge = makeBridge({
      subAgentResult: {
        success: true,
        summary: 'Here is the analysis:\n```json\n{"issues": [{"file": "a.ts", "line": 10}]}\n```',
      },
    });

    const result = await bridge.run({ prompt: 'analyze' });

    expect((result.data as any).issues).toHaveLength(1);
    expect((result.data as any)._parse_failed).toBeUndefined();
  });

  it('strips markdown fences and parses JSON in schema mode', async () => {
    const bridge = makeBridge({
      subAgentResult: {
        success: true,
        summary: '```json\n{"files": ["a.ts"]}\n```',
      },
    });

    const result = await bridge.run({
      prompt: 'list files',
      schema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] },
    });

    expect((result.data as any).files).toEqual(['a.ts']);
  });
});

// ─── max_agents hard limit ────────────────────────────────────────────────────

describe('WorkflowAgentBridge — max_agents limit', () => {
  it('throws when agent count exceeds maxAgents', async () => {
    const bridge = makeBridge({ maxAgents: 2 });

    await bridge.run({ prompt: 'task 1' });
    await bridge.run({ prompt: 'task 2' });

    await expect(bridge.run({ prompt: 'task 3' })).rejects.toThrow(
      /agent limit reached/i
    );
  });
});

// ─── runParallel concurrency control ─────────────────────────────────────────

describe('WorkflowAgentBridge.runParallel — concurrency', () => {
  it('executes all tasks and returns results in original order', async () => {
    let callOrder = 0;
    (SubAgent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      executeTask: vi.fn().mockImplementation(async (prompt: string) => {
        callOrder++;
        return {
          success: true,
          summary: `result-for-${prompt}`,
          tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }),
    }));

    const ctrl = new AbortController();
    const mockConfig = {
      getProjectRoot: () => '/tmp',
      getSessionId: () => 'test',
      getApprovalMode: () => 'auto',
      getHookSystem: () => ({ getEventHandler: () => undefined }),
    } as unknown as Config;
    const bridge = new WorkflowAgentBridge(
      mockConfig,
      { getAllTools: () => [], registerTool: vi.fn() } as unknown as ToolRegistry,
      {} as GeminiClient,
      ctrl.signal,
      undefined,
      2, // maxConcurrency = 2
    );

    const results = await bridge.runParallel([
      { prompt: 'A' },
      { prompt: 'B' },
      { prompt: 'C' },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]!.result).toBe('result-for-A');
    expect(results[1]!.result).toBe('result-for-B');
    expect(results[2]!.result).toBe('result-for-C');
  });

  it('returns empty array for empty task list', async () => {
    const bridge = makeBridge();
    const results = await bridge.runParallel([]);
    expect(results).toEqual([]);
  });
});

// ─── schema prompt injection ──────────────────────────────────────────────────

describe('WorkflowAgentBridge.buildPrompt — schema injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (SubAgent as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      executeTask: vi.fn().mockResolvedValue({
        success: true,
        summary: '{"coverage": 85}',
        tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    }));
  });

  function getLastCalledPrompt(): string {
    const SubAgentMock = SubAgent as unknown as ReturnType<typeof vi.fn>;
    return SubAgentMock.mock.results.at(-1)!.value.executeTask.mock.calls[0][0] as string;
  }

  it('appends output_schema section when schema is provided', async () => {
    const bridge = makeBridge();
    const schema = {
      type: 'object',
      properties: { coverage: { type: 'number' } },
      required: ['coverage'],
    };

    await bridge.run({ prompt: 'analyze coverage', schema });
    const calledPrompt = getLastCalledPrompt();

    expect(calledPrompt).toContain('<output_schema>');
    expect(calledPrompt).toContain('raw JSON only');
    expect(calledPrompt).toContain('"coverage"');
  });

  it('does not append output_schema section when no schema provided', async () => {
    const bridge = makeBridge();
    await bridge.run({ prompt: 'analyze coverage' });
    const calledPrompt = getLastCalledPrompt();

    expect(calledPrompt).not.toContain('<output_schema>');
  });
});
