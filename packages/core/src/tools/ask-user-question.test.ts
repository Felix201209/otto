/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AskUserQuestionTool } from './ask-user-question.js';
import {
  ToolConfirmationOutcome,
  ToolQuestionConfirmationDetails,
} from './tools.js';
import type { Config } from '../config/config.js';

function makeConfig(): Config {
  return {} as Config;
}

function makeParams(
  overrides: Partial<ConstructorParameters<typeof AskUserQuestionTool>[0]> = {},
) {
  return {
    questions: [
      {
        question: 'Which auth method should we use?',
        header: 'Auth',
        options: [
          { label: 'OAuth', description: 'Standard OAuth2 flow' },
          { label: 'API Key', description: 'Static token' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('AskUserQuestionTool', () => {
  let tool: AskUserQuestionTool;

  beforeEach(() => {
    tool = new AskUserQuestionTool(makeConfig());
  });

  describe('validateToolParams', () => {
    it('accepts a valid single-question payload', () => {
      expect(tool.validateToolParams(makeParams() as any)).toBeNull();
    });

    it('rejects empty questions array', () => {
      expect(
        tool.validateToolParams({ questions: [] } as any),
      ).toMatch(/At least one question/);
    });

    it('rejects more than 4 questions', () => {
      const questions = Array.from({ length: 5 }, (_, i) => ({
        question: `Q${i}?`,
        header: `H${i}`,
        options: [
          { label: 'Yes', description: 'y' },
          { label: 'No', description: 'n' },
        ],
      }));
      expect(
        tool.validateToolParams({ questions } as any),
      ).toMatch(/At most 4 questions/);
    });

    it('rejects duplicate question texts', () => {
      expect(
        tool.validateToolParams({
          questions: [
            {
              question: 'Same?',
              header: 'A',
              options: [
                { label: 'x', description: 'x' },
                { label: 'y', description: 'y' },
              ],
            },
            {
              question: 'Same?',
              header: 'B',
              options: [
                { label: 'x', description: 'x' },
                { label: 'y', description: 'y' },
              ],
            },
          ],
        } as any),
      ).toMatch(/Duplicate question text/);
    });

    it('heals and truncates header longer than 12 characters', () => {
      const params: any = {
        questions: [
          {
            question: 'Q?',
            header: 'ThisHeaderIsTooLong',
            options: [
              { label: 'a', description: 'a' },
              { label: 'b', description: 'b' },
            ],
          },
        ],
      };
      expect(tool.validateToolParams(params)).toBeNull();
      expect(params.questions[0].header).toBe('ThisHeaderIs');
    });

    it('heals missing description and strings in options array', () => {
      const params: any = {
        questions: [
          {
            question: 'Q?',
            options: [
              'Option A',
              { label: 'Option B' },
            ],
          },
        ],
      };
      expect(tool.validateToolParams(params)).toBeNull();
      expect(params.questions[0].header).toBe('Question'); // default header
      expect(params.questions[0].options[0]).toEqual({ label: 'Option A', description: '' });
      expect(params.questions[0].options[1]).toEqual({ label: 'Option B', description: '' });
    });

    it('rejects fewer than 2 or more than 4 options', () => {
      expect(
        tool.validateToolParams({
          questions: [
            {
              question: 'Q?',
              header: 'H',
              options: [{ label: 'only', description: 'one' }],
            },
          ],
        } as any),
      ).toMatch(/2-4 options/);
    });

    it('rejects duplicate option labels within one question', () => {
      expect(
        tool.validateToolParams({
          questions: [
            {
              question: 'Q?',
              header: 'H',
              options: [
                { label: 'same', description: 'a' },
                { label: 'same', description: 'b' },
              ],
            },
          ],
        } as any),
      ).toMatch(/Duplicate option label/);
    });

    it('rejects explicit "Other" option (UI provides it)', () => {
      expect(
        tool.validateToolParams({
          questions: [
            {
              question: 'Q?',
              header: 'H',
              options: [
                { label: 'foo', description: 'a' },
                { label: 'Other', description: 'b' },
              ],
            },
          ],
        } as any),
      ).toMatch(/Do not include an "Other" option/);
    });

    it('rejects preview on multiSelect questions', () => {
      expect(
        tool.validateToolParams({
          questions: [
            {
              question: 'Q?',
              header: 'H',
              multiSelect: true,
              options: [
                { label: 'foo', description: 'a', preview: 'preview-text' },
                { label: 'bar', description: 'b' },
              ],
            },
          ],
        } as any),
      ).toMatch(/Preview is not supported on multiSelect/);
    });
  });

  describe('shouldConfirmExecute', () => {
    it('returns a question confirmation for valid params', async () => {
      const details = await tool.shouldConfirmExecute(
        makeParams() as any,
        new AbortController().signal,
      );
      expect(details).not.toBe(false);
      expect((details as any).type).toBe('question');
      expect((details as ToolQuestionConfirmationDetails).questions).toHaveLength(1);
      expect(typeof (details as any).onConfirm).toBe('function');
    });

    it('returns false for invalid params (execute will produce error)', async () => {
      const result = await tool.shouldConfirmExecute(
        { questions: [] } as any,
        new AbortController().signal,
      );
      expect(result).toBe(false);
    });
  });

  describe('end-to-end pause → resume → execute', () => {
    it('captures answers via onConfirm and renders them to the LLM', async () => {
      const params = makeParams();
      const details = (await tool.shouldConfirmExecute(
        params as any,
        new AbortController().signal,
      )) as ToolQuestionConfirmationDetails;

      // Simulate UI submitting the user's choice.
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { 'Which auth method should we use?': 'OAuth' },
      });

      const result = await tool.execute(
        params as any,
        new AbortController().signal,
      );
      expect(result.llmContent).toMatch(/User has answered/);
      expect(result.llmContent).toMatch(/"Which auth method should we use\?"="OAuth"/);
      expect(result.summary).toMatch(/Collected 1 answer/);
    });

    it('handles cancel path', async () => {
      const params = makeParams();
      const details = (await tool.shouldConfirmExecute(
        params as any,
        new AbortController().signal,
      )) as ToolQuestionConfirmationDetails;

      await details.onConfirm(ToolConfirmationOutcome.Cancel);

      const result = await tool.execute(
        params as any,
        new AbortController().signal,
      );
      expect(result.llmContent).toMatch(/declined/i);
    });

    it('handles feedback (Chat about this / Skip interview) path', async () => {
      const params = makeParams();
      const details = (await tool.shouldConfirmExecute(
        params as any,
        new AbortController().signal,
      )) as ToolQuestionConfirmationDetails;

      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: {},
        feedback: 'The user wants to clarify these questions.',
      });

      const result = await tool.execute(
        params as any,
        new AbortController().signal,
      );
      expect(result.llmContent).toMatch(/clarify/);
    });

    it('includes annotations (preview + notes) in LLM output', async () => {
      const params = {
        questions: [
          {
            question: 'Which layout?',
            header: 'Layout',
            options: [
              {
                label: 'Sidebar',
                description: 'left nav',
                preview: 'ASCII mockup of sidebar layout',
              },
              { label: 'Topbar', description: 'top nav' },
            ],
          },
        ],
      };
      const details = (await tool.shouldConfirmExecute(
        params as any,
        new AbortController().signal,
      )) as ToolQuestionConfirmationDetails;
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { 'Which layout?': 'Sidebar' },
        annotations: {
          'Which layout?': {
            preview: 'ASCII mockup of sidebar layout',
            notes: 'prefer dark theme',
          },
        },
      });
      const result = await tool.execute(
        params as any,
        new AbortController().signal,
      );
      expect(result.llmContent).toMatch(/selected preview/);
      expect(result.llmContent).toMatch(/user notes: prefer dark theme/);
    });

    it('handles multi-select answers (comma-joined)', async () => {
      const params = {
        questions: [
          {
            question: 'Which features?',
            header: 'Features',
            multiSelect: true,
            options: [
              { label: 'Search', description: 'full-text' },
              { label: 'Auth', description: 'login' },
              { label: 'Dark mode', description: 'theme' },
            ],
          },
        ],
      };
      const details = (await tool.shouldConfirmExecute(
        params as any,
        new AbortController().signal,
      )) as ToolQuestionConfirmationDetails;
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
        answers: { 'Which features?': 'Search, Auth, Dark mode' },
      });
      const result = await tool.execute(
        params as any,
        new AbortController().signal,
      );
      expect(result.llmContent).toMatch(/"Which features\?"="Search, Auth, Dark mode"/);
    });
  });

  describe('tool metadata', () => {
    it('has the correct name and icon', () => {
      expect(tool.name).toBe('ask_user_question');
      expect(tool.displayName).toBe('AskUserQuestion');
      expect(tool.icon).toBe('question');
    });

    it('does not allow sub-agent use (no TTY user)', () => {
      expect(tool.allowSubAgentUse).toBe(false);
    });

    it('exposes a meaningful pre-execution description', () => {
      expect(tool.getDescription(makeParams() as any)).toMatch(/Ask:/);
      expect(
        tool.getDescription({
          questions: [
            {
              question: 'Q1?',
              header: 'A',
              options: [
                { label: 'x', description: 'a' },
                { label: 'y', description: 'b' },
              ],
            },
            {
              question: 'Q2?',
              header: 'B',
              options: [
                { label: 'x', description: 'a' },
                { label: 'y', description: 'b' },
              ],
            },
          ],
        } as any),
      ).toMatch(/Ask 2 questions/);
    });
  });
});
