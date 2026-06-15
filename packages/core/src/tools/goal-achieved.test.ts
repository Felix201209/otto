/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GoalAchievedTool, GoalAchievedParams } from './goal-achieved.js';
import { Config } from '../config/config.js';
import type { GoalContext } from '../utils/goalContinuationPrompt.js';
import { runGoalEvaluation } from '../agents/runGoalEvaluation.js';

vi.mock('../agents/runGoalEvaluation.js', () => ({
  runGoalEvaluation: vi.fn(),
}));

/**
 * Lightweight mock GeminiClient surface — only the bits goal-achieved
 * touches. Letting tests assert against `getGoalContext`/`clearGoalContext`
 * call counts is the most direct way to verify the side effect.
 */
function makeMockClient(initialCtx: GoalContext | null = null) {
  let ctx: GoalContext | null = initialCtx;
  const getGoalContext = vi.fn(() => ctx);
  const clearGoalContext = vi.fn(() => {
    ctx = null;
  });
  return {
    getGoalContext,
    clearGoalContext,
    getContentGenerator: vi.fn(),
    getContentGeneratorForModel: vi.fn(),
    getChat: vi.fn(() => ({
      cacheSafeParams: {
        get: vi.fn()
      }
    })),
    // Expose for assertions about post-call state.
    _peek: () => ctx,
  };
}

describe('GoalAchievedTool', () => {
  const abortSignal = new AbortController().signal;
  const baseCtx: GoalContext = {
    originalPrompt: '...goal contract verbatim...',
    startedAt: Date.now() - 60_000, // started 1 minute ago
    hours: 2,
    task: 'cover relay module to 80%',
  };

  let mockClient: ReturnType<typeof makeMockClient>;
  let tool: GoalAchievedTool;

  beforeEach(() => {
    mockClient = makeMockClient(baseCtx);
    const mockConfig = {
      getGeminiClient: () => mockClient,
      getUsageStatisticsEnabled: () => false,
    } as unknown as Config;
    tool = new GoalAchievedTool(mockConfig);
  });

  // ─── parameter validation ───────────────────────────────────────────

  describe('validateToolParams', () => {
    it('accepts a non-empty reason string', () => {
      const params: GoalAchievedParams = { reason: 'all tests pass' };
      expect(tool.validateToolParams(params)).toBeNull();
    });

    it('accepts an arbitrarily long reason (no length floor by design)', () => {
      // Per design discussion: a length floor would suggest verbosity equals
      // quality, which it doesn't. Trust the model's structured reason.
      const longReason = 'reason'.repeat(1_000);
      expect(tool.validateToolParams({ reason: longReason })).toBeNull();
    });

    it('rejects empty string reason', () => {
      const err = tool.validateToolParams({ reason: '' });
      expect(err).toBeTruthy();
      expect(err).toMatch(/reason/i);
    });

    it('rejects whitespace-only reason', () => {
      const err = tool.validateToolParams({ reason: '   \n\t  ' });
      expect(err).toBeTruthy();
    });

    it('rejects missing reason via schema', () => {
      // Casting to bypass TS — runtime is what we care about.
      const err = tool.validateToolParams({} as GoalAchievedParams);
      expect(err).toBeTruthy();
    });
  });

  // ─── execute: happy path (active goal) ──────────────────────────────

  describe('execute (active goal)', () => {
    it('calls clearGoalContext on the GeminiClient', async () => {
      await tool.execute(
        { reason: 'criteria 1, 2, 3 all met (cited evidence)' },
        abortSignal,
      );
      expect(mockClient.clearGoalContext).toHaveBeenCalledTimes(1);
      expect(mockClient._peek()).toBeNull();
    });

    it('returns llmContent that explicitly tells the model the contract is released', async () => {
      // Critical: this string is what the model sees next turn. If it
      // doesn't say "contract released, you may stop pushing the agenda",
      // the model could keep going per the original /goal discipline.
      const result = await tool.execute(
        { reason: 'all coverage targets reached and validated' },
        abortSignal,
      );
      const llm = String(result.llmContent);
      expect(llm).toMatch(/contract released|no longer applies/i);
      expect(llm).toMatch(/minimum-hours floor|no-stop/i);
    });

    it('preserves system safety rails reminder in the model-facing message', async () => {
      // Even when the goal is complete, "no rm -rf / no PowerShell / no
      // batch-kill node" must stay on. The ack message is the last chance
      // to remind the model of that before it switches into "free mode".
      const result = await tool.execute(
        { reason: 'done, criteria met' },
        abortSignal,
      );
      const llm = String(result.llmContent);
      expect(llm).toMatch(/safety rails|stay on/i);
    });

    it('echoes the reason in returnDisplay for user audit', async () => {
      const reason =
        'covered 12 modules, raised total branch coverage from 47% to 82%, all snapshot diffs reviewed';
      const result = await tool.execute({ reason }, abortSignal);
      // returnDisplay is a structured object on the happy path so the UI
      // layer can render a multi-line bordered card. We assert on the
      // shape (`type` discriminator + `reason` field carrying the user's
      // raw text) rather than a string match, because the rendering is
      // the UI's job and string-matching here would couple this test to
      // CLI/webview presentation choices.
      expect(result.returnDisplay).toEqual({
        type: 'goal_achieved_display',
        reason,
      });
    });

    it('returnDisplay preserves whitespace / newlines in the reason verbatim', async () => {
      // Critical for readability: the model is told to "逐条说明 each
      // criterion"; renderers must keep the paragraph structure intact.
      const reason = 'criterion 1: tests pass\ncriterion 2: coverage ≥ 80%\ncriterion 3: lint clean';
      const result = await tool.execute({ reason }, abortSignal);
      expect(result.returnDisplay).toEqual({
        type: 'goal_achieved_display',
        reason, // exact match — no trimming, no escaping
      });
    });

    it('sets summary to "goal achieved"', async () => {
      const result = await tool.execute(
        { reason: 'done' },
        abortSignal,
      );
      expect(result.summary).toBe('goal achieved');
    });

    it('tells the model not to produce an unrequested wrap-up summary', async () => {
      // The instruction clause matters: without it, models commonly emit
      // a 2-screen wrap-up the user didn't ask for. We want a brief ack
      // and then "wait for next instruction".
      const result = await tool.execute(
        { reason: 'all done' },
        abortSignal,
      );
      expect(String(result.llmContent)).toMatch(
        /not produce an unrequested wrap-up|wait for the user/i,
      );
    });
  });

  // ─── execute: with independent evaluator ────────────────────────────

  describe('execute (with independent evaluator)', () => {
    let mockConfigWithCloudModels: Config;

    beforeEach(() => {
      mockClient = makeMockClient(baseCtx);
      mockConfigWithCloudModels = {
        getGeminiClient: () => mockClient,
        getUsageStatisticsEnabled: () => false,
        getCloudModels: () => [{ name: 'deepseek-v4-flash', available: true }],
        getCustomModels: () => [],
      } as unknown as Config;
      tool = new GoalAchievedTool(mockConfigWithCloudModels);
      vi.clearAllMocks();
    });

    it('clears goal context and finishes if evaluator approves', async () => {
      vi.mocked(runGoalEvaluation).mockResolvedValueOnce({
        status: 'approved',
        feedback: '[GOAL_EVALUATION: APPROVED] All clear.',
      });

      const result = await tool.execute({ reason: 'all criteria satisfied' }, abortSignal);

      expect(runGoalEvaluation).toHaveBeenCalledTimes(1);
      expect(mockClient.clearGoalContext).toHaveBeenCalledTimes(1);
      expect(mockClient._peek()).toBeNull();
      expect(result.summary).toBe('goal achieved');
    });

    it('rejects completion, leaves context active, and returns feedback if evaluator rejects', async () => {
      vi.mocked(runGoalEvaluation).mockResolvedValueOnce({
        status: 'rejected',
        feedback: '[GOAL_EVALUATION: REJECTED] You missed the tests.',
      });

      const result = await tool.execute({ reason: 'all criteria satisfied' }, abortSignal);

      expect(runGoalEvaluation).toHaveBeenCalledTimes(1);
      expect(mockClient.clearGoalContext).not.toHaveBeenCalled();
      expect(mockClient._peek()).not.toBeNull(); // Goal context is preserved
      expect(result.summary).toBe('goal completion rejected');
      expect(result.returnDisplay).toEqual({
        type: 'goal_rejected_display',
        feedback: '[GOAL_EVALUATION: REJECTED] You missed the tests.',
      });
    });

    it('falls back to happy path (self-judgment) if runGoalEvaluation returns failed/error', async () => {
      vi.mocked(runGoalEvaluation).mockResolvedValueOnce({
        status: 'failed',
        feedback: 'API error',
      });

      const result = await tool.execute({ reason: 'all criteria satisfied' }, abortSignal);

      expect(runGoalEvaluation).toHaveBeenCalledTimes(1);
      expect(mockClient.clearGoalContext).toHaveBeenCalledTimes(1);
      expect(mockClient._peek()).toBeNull(); // Cleared on fallback
      expect(result.summary).toBe('goal achieved');
    });
  });

  // ─── execute: graceful behavior when no goal is active ──────────────

  describe('execute (no active goal — graceful no-op)', () => {
    beforeEach(() => {
      mockClient = makeMockClient(null); // no active context
      const mockConfig = {
        getGeminiClient: () => mockClient,
        getUsageStatisticsEnabled: () => false,
      } as unknown as Config;
      tool = new GoalAchievedTool(mockConfig);
    });

    it('does NOT call clearGoalContext when there is nothing to clear', async () => {
      await tool.execute({ reason: 'misfire' }, abortSignal);
      expect(mockClient.clearGoalContext).not.toHaveBeenCalled();
    });

    it('returns a no-active-goal notice instead of an error', async () => {
      const result = await tool.execute(
        { reason: 'misfire' },
        abortSignal,
      );
      // Important: does NOT include "Error:" prefix that would destabilize
      // the tool loop. The model called this incorrectly, but we recover
      // gracefully and tell it what to do next.
      expect(String(result.llmContent)).not.toMatch(/^Error/);
      expect(String(result.llmContent)).toMatch(
        /No active \/goal mode|outside goal mode/i,
      );
    });

    it('user-facing display flags the no-op visibly', async () => {
      const result = await tool.execute(
        { reason: 'misfire' },
        abortSignal,
      );
      expect(String(result.returnDisplay)).toMatch(/⚠|outside .*goal mode|ignored/i);
    });
  });

  // ─── execute: defensive — client unavailable ────────────────────────

  describe('execute (defensive — getGeminiClient throws)', () => {
    beforeEach(() => {
      const mockConfig = {
        // Simulate the client init race: getGeminiClient throws if called
        // too early. Should not crash the tool loop.
        getGeminiClient: () => {
          throw new Error('client not yet initialized');
        },
        getUsageStatisticsEnabled: () => false,
      } as unknown as Config;
      tool = new GoalAchievedTool(mockConfig);
    });

    it('still returns a usable result instead of propagating the error', async () => {
      const result = await tool.execute(
        { reason: 'all done' },
        abortSignal,
      );
      // Falls into the "no active goal" branch since hadActiveGoal stays false.
      // Critically: no exception thrown.
      expect(result).toBeDefined();
      expect(typeof result.llmContent).toBe('string');
      expect(typeof result.returnDisplay).toBe('string');
    });
  });

  // ─── execute: invalid params (defense in depth) ─────────────────────

  describe('execute (invalid params)', () => {
    it('returns validation error result for empty reason', async () => {
      const result = await tool.execute(
        { reason: '' },
        abortSignal,
      );
      expect(String(result.llmContent)).toMatch(/^Error: Invalid parameters/);
      // Must NOT have side-effected clearGoalContext on validation failure.
      expect(mockClient.clearGoalContext).not.toHaveBeenCalled();
    });
  });

  // ─── tool metadata (visible to the model in tool list) ──────────────

  describe('tool metadata', () => {
    it('description teaches the model when NOT to call this tool', async () => {
      // The single most important sentence in the description is the
      // "do not call when stuck — report the obstacle instead" guidance.
      // Without it, a frustrated model might use goal_achieved as an
      // escape hatch from a hard task.
      const desc = tool.schema.description ?? '';
      expect(desc).toMatch(/do not call|do NOT call|not call this tool/i);
      expect(desc).toMatch(/obstacle|impossible|stuck/i);
    });

    it('description warns that vague reasons are insufficient', async () => {
      const desc = tool.schema.description ?? '';
      expect(desc).toMatch(/vague|specific|"done"|"looks good"/);
    });

    it('reason is required in the schema', () => {
      // If the model could call this tool with no args, we lose the
      // entire "force structured commitment" property.
      const schema = tool.schema.parameters as { required?: string[] };
      expect(schema.required).toContain('reason');
    });
  });
});
