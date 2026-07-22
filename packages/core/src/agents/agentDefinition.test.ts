/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BaseTool, Icon, ToolResult } from '../tools/tools.js';
import { Type } from '@google/genai';
import {
  BUILT_IN_AGENT_TYPES,
  DEFAULT_SUBAGENT_AGENT_TYPE,
  READ_ONLY_ANALYSIS_TOOLS,
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

  it('keeps the default code-analysis agent on the lightweight read-only toolset', () => {
    const agent = getBuiltInAgentDefinition('code-analysis', READ_ONLY_ANALYSIS_TOOLS, 8);

    expect(agent?.tools).toEqual(READ_ONLY_ANALYSIS_TOOLS);
    expect(agent?.tools).not.toContain('*');
    expect(agent?.tools).not.toContain('write_file');
    expect(agent?.tools).not.toContain('run_shell_command');
    expect(agent?.tools).not.toContain('ppt_generate');
  });

  it('keeps explicit workflow orchestrators full-access for advanced flows', () => {
    const agent = getBuiltInAgentDefinition('workflow-orchestrator', ['read_file', 'write_file'], 8);

    expect(agent?.tools).toEqual(['*']);
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

  it('resolves the default code-analysis agent without inheriting every sub-agent tool', () => {
    const readTool = new TestTool('read_file', true);
    const grepTool = new TestTool('search_file_content', true);
    const writeTool = new TestTool('write_file', true);
    const pptTool = new TestTool('ppt_generate', true);
    const taskTool = new TestTool('task', false);
    const agent = getBuiltInAgentDefinition('code-analysis', [], 8)!;

    const result = resolveAgentTools(
      agent,
      [readTool, grepTool, writeTool, pptTool, taskTool],
    );

    expect(result.resolvedTools).toEqual([grepTool, readTool]);
    expect(result.invalidTools).toEqual(
      READ_ONLY_ANALYSIS_TOOLS.filter(
        (toolName) => toolName !== 'read_file' && toolName !== 'search_file_content',
      ),
    );
  });
});
