/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { selectAggregatedToolGroup } from './toolGroupAggregate.js';
import { IndividualToolCallDisplay, ToolCallStatus } from '../../types.js';

function call(
  overrides: Partial<IndividualToolCallDisplay> = {},
): IndividualToolCallDisplay {
  return {
    callId: Math.random().toString(36).slice(2),
    name: 'ReadFile',
    toolId: 'read_file',
    description: 'AGENTS.md',
    resultDisplay: 'ok',
    status: ToolCallStatus.Success,
    confirmationDetails: undefined,
    renderOutputAsMarkdown: false,
    forceMarkdown: false,
    ...overrides,
  };
}

describe('selectAggregatedToolGroup', () => {
  it('aggregates 2+ successful read_file calls into one block', () => {
    const result = selectAggregatedToolGroup([
      call({ description: 'AGENTS.md' }),
      call({ description: 'esbuild.config.js' }),
      call({ description: '.gitlab-ci.yml' }),
    ]);
    expect(result).not.toBeNull();
    expect(result?.toolId).toBe('read_file');
    expect(result?.items).toEqual([
      'AGENTS.md',
      'esbuild.config.js',
      '.gitlab-ci.yml',
    ]);
  });

  it('does not aggregate a single read_file call', () => {
    const result = selectAggregatedToolGroup([call({ description: 'a.md' })]);
    expect(result).toBeNull();
  });

  it('does not aggregate when tools are of mixed types', () => {
    const result = selectAggregatedToolGroup([
      call({ toolId: 'read_file', name: 'ReadFile' }),
      call({ toolId: 'run_shell_command', name: 'Bash' }),
    ]);
    expect(result).toBeNull();
  });

  it('does not aggregate non-read_file tools (e.g. glob)', () => {
    const result = selectAggregatedToolGroup([
      call({ toolId: 'glob', name: 'FindFiles', description: '*.md' }),
      call({ toolId: 'glob', name: 'FindFiles', description: '*.ts' }),
    ]);
    expect(result).toBeNull();
  });

  it('does not aggregate if any call is still executing', () => {
    const result = selectAggregatedToolGroup([
      call({ status: ToolCallStatus.Success }),
      call({ status: ToolCallStatus.Executing }),
    ]);
    expect(result).toBeNull();
  });

  it('does not aggregate if any call failed', () => {
    const result = selectAggregatedToolGroup([
      call({ status: ToolCallStatus.Success }),
      call({ status: ToolCallStatus.Error }),
    ]);
    expect(result).toBeNull();
  });

  it('does not aggregate if any call awaits confirmation', () => {
    const result = selectAggregatedToolGroup([
      call(),
      call({
        status: ToolCallStatus.Confirming,
        confirmationDetails: {} as IndividualToolCallDisplay['confirmationDetails'],
      }),
    ]);
    expect(result).toBeNull();
  });

  it('does not aggregate if any call has sub tool calls', () => {
    const result = selectAggregatedToolGroup([
      call(),
      call({ subToolCalls: [call()] }),
    ]);
    expect(result).toBeNull();
  });

  it('does not aggregate if any call has batch sub tools', () => {
    const result = selectAggregatedToolGroup([
      call(),
      call({
        batchSubTools: [
          { tool: 'read_file', displayName: 'ReadFile', summary: 'x' },
        ],
      }),
    ]);
    expect(result).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(selectAggregatedToolGroup([])).toBeNull();
  });
});
