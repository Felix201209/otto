/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BaseTool, Icon, ToolResult } from '../tools/tools.js';
import { Type } from '@google/genai';
import {
  BUILT_IN_AGENT_TYPES,
  DEFAULT_SUBAGENT_AGENT_TYPE,
  getBuiltInAgentDefinition,
  resolveAgentTools,
} from './agentDefinition.js';

class TestTool extends BaseTool<Record<string, never>, ToolResult> {
  constructor(name: string, allowSubAgentUse = true) {
    super(
      name,
      name,
      `${name} description`,
      Icon.Hammer,
      {
        type: Type.OBJECT,
        properties: {},
      },
      true,
      false,
      false,
      allowSubAgentUse,
    );
  }

  async execute(): Promise<ToolResult> {
    return {
      llmContent: 'ok',
      returnDisplay: 'ok',
    };
  }
}

describe('built-in agent definitions', () => {
  it('exposes the default code-analysis agent for backwards compatibility', () => {
    expect(DEFAULT_SUBAGENT_AGENT_TYPE).toBe('code-analysis');
    expect(BUILT_IN_AGENT_TYPES).toContain('code-analysis');
  });

  it('provides code-explorer, code-reviewer, and test-planner agents', () => {
    expect(BUILT_IN_AGENT_TYPES).toEqual(
      expect.arrayContaining(['code-explorer', 'code-reviewer', 'test-planner']),
    );

    const codeExplorer = getBuiltInAgentDefinition('code-explorer', ['read_file'], 8);
    const codeReviewer = getBuiltInAgentDefinition('code-reviewer', ['read_file'], 8);
    const testPlanner = getBuiltInAgentDefinition('test-planner', ['read_file'], 8);

    expect(codeExplorer?.systemPrompt).toContain('trace execution paths');
    expect(codeReviewer?.systemPrompt).toContain('review code for bugs');
    expect(testPlanner?.systemPrompt).toContain('test strategy');
  });

  it('returns undefined for unknown agent types', () => {
    expect(getBuiltInAgentDefinition('unknown-agent', [], 5)).toBeUndefined();
  });
});

describe('resolveAgentTools', () => {
  it('keeps allowSubAgentUse as a hard safety boundary even with wildcard tools', () => {
    const readTool = new TestTool('read_file', true);
    const taskTool = new TestTool('task', false);

    const result = resolveAgentTools(
      {
        tools: ['*'],
      },
      [readTool, taskTool],
    );

    expect(result.resolvedTools).toEqual([readTool]);
    expect(result.invalidTools).toEqual([]);
  });

  it('uses explicit tools and reports unavailable tool names', () => {
    const readTool = new TestTool('read_file', true);
    const grepTool = new TestTool('search_file_content', true);

    const result = resolveAgentTools(
      {
        tools: ['read_file', 'missing_tool'],
      },
      [readTool, grepTool],
    );

    expect(result.resolvedTools).toEqual([readTool]);
    expect(result.validTools).toEqual(['read_file']);
    expect(result.invalidTools).toEqual(['missing_tool']);
  });

  it('removes tools listed in disallowedTools', () => {
    const readTool = new TestTool('read_file', true);
    const shellTool = new TestTool('run_shell_command', true);

    const result = resolveAgentTools(
      {
        tools: ['*'],
        disallowedTools: ['run_shell_command'],
      },
      [readTool, shellTool],
    );

    expect(result.resolvedTools).toEqual([readTool]);
  });
});
