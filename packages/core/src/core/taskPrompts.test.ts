/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { TaskPrompts } from './taskPrompts.js';

describe('TaskPrompts.buildFinalTurnReminder', () => {
  it('declares the final turn and forbids further tool calls', () => {
    const reminder = TaskPrompts.buildFinalTurnReminder(15, 15);
    expect(reminder).toContain('FINAL TURN NOTICE');
    expect(reminder).toContain('15/15');
    expect(reminder).toMatch(/MUST NOT call any more tools/i);
    expect(reminder).toMatch(/text only/i);
  });

  it('lists the required report sections so partial findings stay structured', () => {
    const reminder = TaskPrompts.buildFinalTurnReminder(8, 10);
    expect(reminder).toContain('Analysis Summary');
    expect(reminder).toContain('Findings & Recommendations');
    expect(reminder).toContain('Open Questions');
  });

  it('reports the actual turn ratio when forced earlier than max', () => {
    const reminder = TaskPrompts.buildFinalTurnReminder(7, 10);
    expect(reminder).toContain('7/10');
  });
});

describe('TaskPrompts.buildPartialResultSummary', () => {
  const header = '⚠️ Reached max turns (15). Partial findings from sub-agent below:';
  const credits = 'Continuing may consume additional credits. Please review carefully.';
  const fallback = '(Sub-agent did not produce a final summary before reaching the turn limit.)';

  it('preserves the sub-agent final report verbatim under the warning header', () => {
    const report = '## Analysis Summary\nFound the bug at foo.ts:42.\n\n## Recommendations\nFix the null check.';
    const summary = TaskPrompts.buildPartialResultSummary(report, header, credits, fallback);

    expect(summary.startsWith(header)).toBe(true);
    expect(summary).toContain(credits);
    expect(summary).toContain('Found the bug at foo.ts:42.');
    expect(summary).toContain('Fix the null check.');
  });

  it('falls back to a no-summary notice when the sub-agent produced no text', () => {
    const summary = TaskPrompts.buildPartialResultSummary(undefined, header, credits, fallback);
    expect(summary).toContain(header);
    expect(summary).toContain(fallback);
  });

  it('treats empty / whitespace-only reports as no summary', () => {
    const summary = TaskPrompts.buildPartialResultSummary('   \n  \t', header, credits, fallback);
    expect(summary).toContain(fallback);
  });

  it('separates header and body with a blank line for readability', () => {
    const report = 'real findings';
    const summary = TaskPrompts.buildPartialResultSummary(report, header, credits, fallback);
    // header\ncredits\n\nbody
    expect(summary).toBe(`${header}\n${credits}\n\n${report}`);
  });
});
