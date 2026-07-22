/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { IndividualToolCallDisplay, ToolCallStatus } from '../../types.js';
import {
  summarizeToolConversation,
  summarizeToolGroupConversation,
} from './toolConversationSummary.js';

function call(
  overrides: Partial<IndividualToolCallDisplay> = {},
): IndividualToolCallDisplay {
  return {
    callId: Math.random().toString(36).slice(2),
    name: 'ReadFile',
    toolId: 'read_file',
    description: 'src/app.ts',
    resultDisplay: '(42 lines)',
    status: ToolCallStatus.Success,
    confirmationDetails: undefined,
    ...overrides,
  };
}

describe('summarizeToolConversation', () => {
  it('prefers explicit tool summaries', () => {
    expect(
      summarizeToolConversation({
        toolId: 'run_shell_command',
        name: 'Shell',
        description: 'npm test',
        resultDisplay: 'long output',
        status: ToolCallStatus.Success,
        summary: 'Tests passed.',
      }),
    ).toBe('Tests passed');
  });

  it('summarizes completed read_file calls by target and line count', () => {
    expect(
      summarizeToolConversation({
        toolId: 'read_file',
        name: 'ReadFile',
        description: 'src/app.ts',
        resultDisplay: '(42 lines)',
        status: ToolCallStatus.Success,
      }),
    ).toBe('Read src/app.ts (42 lines)');
  });

  it('summarizes search results without exposing raw tool chatter', () => {
    expect(
      summarizeToolConversation({
        toolId: 'search_file_content',
        name: 'SearchText',
        description: 'TODO',
        resultDisplay: 'Found 12 matches',
        status: ToolCallStatus.Success,
      }),
    ).toBe('Searched TODO; found 12 matches');
  });

  it('makes failed tool calls actionable', () => {
    expect(
      summarizeToolConversation({
        toolId: 'read_file',
        name: 'ReadFile',
        description: 'missing.ts',
        resultDisplay: 'File not found.',
        status: ToolCallStatus.Error,
      }),
    ).toBe('Needs attention: missing.ts failed — File not found.');
  });
});

describe('summarizeToolGroupConversation', () => {
  it('summarizes a successful read batch', () => {
    expect(summarizeToolGroupConversation([call(), call({ description: 'README.md' })])).toBe(
      'Read 2 files',
    );
  });

  it('surfaces failures in a group', () => {
    expect(
      summarizeToolGroupConversation([
        call(),
        call({ status: ToolCallStatus.Error, resultDisplay: 'boom' }),
      ]),
    ).toBe('Needs attention: 1 of 2 actions failed');
  });
});
