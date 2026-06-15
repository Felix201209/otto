/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { TaskTool } from './task.js';

describe('TaskTool', () => {
  it('uses the selected agent display name as the execution description', () => {
    const tool = new TaskTool({} as any, {} as any);

    expect(
      tool.getDescription({
        agent_type: 'code-reviewer',
        prompt: 'Review the latest commit',
        description: '审查最近提交',
        max_turns: 8,
      }),
    ).toBe('Code Reviewer');
  });

  it('keeps the default code-analysis display name when agent_type is omitted', () => {
    const tool = new TaskTool({} as any, {} as any);

    expect(
      tool.getDescription({
        prompt: 'Explore the project',
        description: '探索项目',
        max_turns: 8,
      }),
    ).toBe('Code Analysis Expert');
  });

  it('falls back to the provided description for an unknown agent_type', () => {
    const tool = new TaskTool({} as any, {} as any);

    expect(
      tool.getDescription({
        agent_type: 'unknown-agent',
        prompt: 'Do custom analysis',
        description: '自定义分析',
        max_turns: 8,
      }),
    ).toBe('自定义分析');
  });
});
