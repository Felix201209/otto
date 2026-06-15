/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolCallStatus } from '../../types.js';
import { shouldCollapseToolResult } from './toolResultCollapse.js';

describe('shouldCollapseToolResult', () => {
  const base = {
    status: ToolCallStatus.Success,
    resultDisplay: '(42 lines)',
  };

  it('collapses a completed read_file result (string body)', () => {
    expect(
      shouldCollapseToolResult({ ...base, toolId: 'read_file' }),
    ).toBe(true);
  });

  it('collapses list_directory, glob, search_file_content, read_many_files', () => {
    for (const toolId of [
      'list_directory',
      'glob',
      'search_file_content',
      'read_many_files',
    ]) {
      expect(shouldCollapseToolResult({ ...base, toolId })).toBe(true);
    }
  });

  it('does NOT collapse while the tool is still executing', () => {
    expect(
      shouldCollapseToolResult({
        toolId: 'read_file',
        status: ToolCallStatus.Executing,
        resultDisplay: 'partial...',
      }),
    ).toBe(false);
  });

  it('does NOT collapse on error (keep the message visible)', () => {
    expect(
      shouldCollapseToolResult({
        toolId: 'read_file',
        status: ToolCallStatus.Error,
        resultDisplay: 'File not found.',
      }),
    ).toBe(false);
  });

  it('does NOT collapse tools outside the read/search family', () => {
    for (const toolId of ['edit', 'write_file', 'replace', 'todo_write']) {
      expect(
        shouldCollapseToolResult({
          ...base,
          toolId,
        }),
      ).toBe(false);
    }
  });

  it('does NOT collapse when there is no result to begin with', () => {
    expect(
      shouldCollapseToolResult({
        toolId: 'read_file',
        status: ToolCallStatus.Success,
        resultDisplay: undefined,
      }),
    ).toBe(false);
  });

  it('does NOT collapse object (non-string) results like diffs', () => {
    expect(
      shouldCollapseToolResult({
        toolId: 'read_file',
        status: ToolCallStatus.Success,
        resultDisplay: { fileDiff: 'x', fileName: 'a.ts' } as never,
      }),
    ).toBe(false);
  });
});
