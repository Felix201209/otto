/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildGoalContinuationMessage,
  buildGoalClearMessage,
  type GoalContext,
} from './goalContinuationPrompt.js';

describe('buildGoalContinuationMessage', () => {
  const baseCtx: GoalContext = {
    originalPrompt:
      '你现在开启【目标驱动模式】(/goal)。本模式具有以下不可违反的契约：\n... 完整契约内容 ...',
    startedAt: new Date('2026-05-22T08:30:00.000Z').getTime(),
    hours: 2,
    task: '为 relay 模块补 0% 覆盖率',
  };

  it('embeds the original prompt verbatim (no summarization, no truncation)', () => {
    const out = buildGoalContinuationMessage(baseCtx);
    expect(out).toContain(baseCtx.originalPrompt);
  });

  it('renders T0 in BOTH ISO UTC and local-time form for timezone disambiguation', () => {
    const out = buildGoalContinuationMessage(baseCtx);
    // ISO 8601 UTC component
    expect(out).toContain('2026-05-22T08:30:00.000Z');
    // local + tz offset markers (the exact local string varies by runner TZ,
    // so we only assert the structural markers)
    expect(out).toMatch(/\(local: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\)/);
  });

  it('echoes the minimum-hours floor', () => {
    const out = buildGoalContinuationMessage(baseCtx);
    expect(out).toContain('最低工作时长下限：2 小时');
    // and inside the immediate-action block where the floor matters most
    expect(out).toContain('elapsed ≥ 2 小时');
  });

  it('hours value flows through to both anchor and finish-condition blocks', () => {
    const out = buildGoalContinuationMessage({ ...baseCtx, hours: 5 });
    expect(out).toContain('最低工作时长下限：5 小时');
    expect(out).toContain('elapsed ≥ 5 小时');
    expect(out).not.toContain('2 小时');
  });

  it('demands an immediate local_time call (no vague "let me continue" reply)', () => {
    const out = buildGoalContinuationMessage(baseCtx);
    expect(out).toContain('local_time');
    // Header tells the model not to stall on filler text.
    expect(out).toMatch(/不要先输出.*客套话|不要把.*压缩.*当作收尾理由/);
  });

  it('makes both finish-condition branches explicit (A: early-complete, B: complete + floor)', () => {
    const out = buildGoalContinuationMessage(baseCtx);
    // Condition A — all criteria met → finish even if elapsed < floor
    expect(out).toContain('收尾条件 A');
    // Condition B — all criteria met AND elapsed >= floor
    expect(out).toContain('收尾条件 B');
  });

  it('marks the message as a post-compression restoration in its header', () => {
    const out = buildGoalContinuationMessage(baseCtx);
    // The header is what tells the model "you just went through compression" —
    // it must be present so the model doesn't treat the injection as a fresh task.
    expect(out).toContain('Goal Mode Context Restoration');
    expect(out).toContain('Post-Compression');
  });

  it('produces a string suitable for direct inclusion as a user message', () => {
    const out = buildGoalContinuationMessage(baseCtx);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    // Must not start or end with control characters that would confuse models.
    expect(out.charCodeAt(0)).toBeGreaterThanOrEqual(0x20);
  });

  it('is deterministic for the same input (no Date.now() leakage, no randomness)', () => {
    const a = buildGoalContinuationMessage(baseCtx);
    const b = buildGoalContinuationMessage(baseCtx);
    expect(a).toBe(b);
  });

  it('handles fractional hours (e.g. 0.5h) without artifacts', () => {
    const out = buildGoalContinuationMessage({ ...baseCtx, hours: 0.5 });
    expect(out).toContain('最低工作时长下限：0.5 小时');
    expect(out).toContain('elapsed ≥ 0.5 小时');
  });
});

describe('buildGoalClearMessage', () => {
  it('marks itself as a /goal clear notification (so the model knows the contract is gone)', () => {
    const out = buildGoalClearMessage();
    // Header must be unambiguous — the model should be able to tell at a
    // glance that this is not the START of a goal contract but the END.
    expect(out).toContain('Goal Mode Cleared by User');
    expect(out).toContain('/goal clear');
  });

  it('explicitly cancels the minimum-hours floor and the no-stop discipline', () => {
    const out = buildGoalClearMessage();
    // These two clauses ARE the goal contract; clearing must override both.
    expect(out).toMatch(/最低工作时长下限.*作废/);
    expect(out).toMatch(/no-stop|不许停|纪律.*作废/);
  });

  it('keeps system safety rails ON (those are independent of goal mode)', () => {
    const out = buildGoalClearMessage();
    // Critical: even when the user cancels the goal, hard safety rails
    // (no rm -rf, no PowerShell, no batch-kill node, etc.) must stay
    // active. The clear message must say so explicitly so the model
    // doesn't treat /goal clear as "anything goes from now on".
    expect(out).toMatch(/系统硬红线|safety rails/);
    expect(out).toMatch(/继续生效|stay (on|active)/);
  });

  it('tells the model to stop pushing the goal agenda but NOT to run unrequested wrap-up work', () => {
    const out = buildGoalClearMessage();
    // The model must not interpret "clear" as "deliver a final summary
    // of everything you did". It should just stand down and wait.
    expect(out).toMatch(/不要做.*收尾汇总|等待用户/);
  });

  it('is deterministic and content-free of timing data (no Date.now leak)', () => {
    // No GoalContext input, no Date.now call → output must be byte-identical
    // across calls. If a future contributor adds dynamic content, they must
    // also update consumers (the message is treated as a system prompt that
    // could be cached / replayed).
    expect(buildGoalClearMessage()).toBe(buildGoalClearMessage());
  });

  it('produces a non-empty string suitable for direct submit_prompt injection', () => {
    const out = buildGoalClearMessage();
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(50);
  });
});
