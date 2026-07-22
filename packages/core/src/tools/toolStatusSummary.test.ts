/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  summarizeUserVisibleTool,
  summarizeUserVisibleToolGroup,
} from './toolStatusSummary.js';

describe('summarizeUserVisibleTool', () => {
  it('prefers explicit summaries and trims trailing periods', () => {
    expect(
      summarizeUserVisibleTool({
        toolId: 'run_shell_command',
        name: 'Shell',
        description: 'npm test',
        status: 'success',
        resultText: 'long output',
        summary: 'Tests passed.',
      }),
    ).toBe('Tests passed');
  });

  it('turns raw search output into a user-facing summary', () => {
    expect(
      summarizeUserVisibleTool({
        toolId: 'search_file_content',
        name: 'SearchText',
        description: 'TODO',
        status: 'success',
        resultText: 'Found 12 matches',
      }),
    ).toBe('Searched TODO; found 12 matches');
  });

  it('makes failures actionable without exposing full tool chatter', () => {
    expect(
      summarizeUserVisibleTool({
        toolId: 'read_file',
        name: 'ReadFile',
        description: 'missing.ts',
        status: 'error',
        resultText: 'File not found.',
      }),
    ).toBe('Needs attention: missing.ts failed — File not found.');
  });
});

describe('summarizeUserVisibleToolGroup', () => {
  it('summarizes successful read batches', () => {
    expect(
      summarizeUserVisibleToolGroup([
        { toolId: 'read_file', status: 'success' },
        { toolId: 'read_file', status: 'success' },
      ]),
    ).toBe('Read 2 files');
  });
});
