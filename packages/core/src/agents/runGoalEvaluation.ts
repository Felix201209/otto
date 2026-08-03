/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { ContentGenerator } from '../core/contentGenerator.js';
import type { CacheSafeParams } from '../services/cacheSafeParams.js';
import { runForkedAgent } from './runForkedAgent.js';

export interface RunGoalEvaluationOptions {
  contentGenerator: ContentGenerator;
  model: string;
  task: string;
  criteria: string;
  reason: string;
  cacheSafeSnapshot: CacheSafeParams | null;
  signal: AbortSignal;
}

export interface GoalEvaluationVerdict {
  status: 'approved' | 'rejected' | 'failed';
  feedback: string;
}

export const GOAL_EVALUATION_SYSTEM_PROMPT = [
  '[Otto - GOAL EVALUATION JUDGE]',
  'You are a highly critical, meticulous, and objective quality assurance judge.',
  'Your sole purpose is to evaluate whether the AI agent\'s /goal task is TRULY and OBJECTIVELY complete based on the conversation history and the agent\'s justification.',
  '',
  'Constraints:',
  '- You have NO tools available. Do not pretend to call any.',
  '- This is a single-turn answer. There will be no follow-up round.',
  '- Be extremely strict. Do not take the agent\'s claims at face value. Look for concrete evidence in the conversation history (e.g., test outputs, file modifications, command run results).',
  '- If any criterion is unmet, not fully verified, or if there are remaining errors, you MUST reject the completion.',
  '',
  'Output Format (CRITICAL):',
  '- If you APPROVE the goal completion, your response MUST start with:',
  '  [GOAL_EVALUATION: APPROVED]',
  '  Followed by a concise explanation of why the criteria are fully met.',
  '- If you REJECT the goal completion, your response MUST start with:',
  '  [GOAL_EVALUATION: REJECTED]',
  '  Followed by a clear, bulleted list of unmet criteria, remaining gaps, or unverified items that the agent must resolve. Be specific (e.g., "The test packages/core/src/auth.test.ts was not run to verify the fix").',
].join('\n');

/**
 * Runs the evaluator model (typically deepseek-v4-flash) to evaluate goal completion.
 */
export async function runGoalEvaluation(
  opts: RunGoalEvaluationOptions,
): Promise<GoalEvaluationVerdict> {
  const task = (opts.task ?? '').trim();
  const criteria = (opts.criteria ?? '').trim();
  const reason = (opts.reason ?? '').trim();

  const promptText = [
    'Please evaluate the goal completion status.',
    '',
    '--- GOAL OBJECTIVE ---',
    `Task: ${task}`,
    '',
    '--- OBJECTIVE COMPLETION CRITERIA ---',
    criteria,
    '',
    '--- AGENT JUSTIFICATION ---',
    `The agent called the goal_achieved tool with this justification:\n"${reason}"`,
    '',
    '--- YOUR JUDGMENT ---',
    'Evaluate the conversation history above and the agent justification. Output [GOAL_EVALUATION: APPROVED] or [GOAL_EVALUATION: REJECTED] followed by your feedback.',
  ].join('\n');

  const userContent: Content = {
    role: 'user',
    parts: [{ text: promptText }],
  };

  const result = await runForkedAgent({
    contentGenerator: opts.contentGenerator,
    model: opts.model,
    userContent,
    systemInstruction: GOAL_EVALUATION_SYSTEM_PROMPT,
    cacheSafeSnapshot: opts.cacheSafeSnapshot,
    signal: opts.signal,
  });

  if (result.status === 'success') {
    const text = result.text.trim();
    if (text.includes('[GOAL_EVALUATION: APPROVED]')) {
      return {
        status: 'approved',
        feedback: text,
      };
    } else {
      return {
        status: 'rejected',
        feedback: text,
      };
    }
  }

  return {
    status: 'failed',
    feedback: result.error ?? 'Evaluator invocation failed.',
  };
}
