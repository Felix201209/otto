import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode, type Config } from 'otto-core';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { agentStyleCommand } from './agentStyleCommand.js';
import type { CommandContext } from './types.js';

describe('agentStyleCommand plain-language aliases', () => {
  let config: Partial<Config>;
  let context: CommandContext;

  beforeEach(() => {
    config = {
      getAgentStyle: vi.fn().mockReturnValue('default'),
      setAgentStyle: vi.fn(),
      setApprovalModeWithProjectSync: vi.fn(),
      getOttoClient: vi.fn(),
    };
    context = createMockCommandContext({ services: { config: config as Config } });
  });

  it('accepts office and engineering without exposing implementation brands', async () => {
    await agentStyleCommand.action!(context, 'office');
    expect(config.setAgentStyle).toHaveBeenCalledWith('antigravity');
    expect(config.setApprovalModeWithProjectSync).toHaveBeenCalledWith(
      ApprovalMode.DEFAULT,
      true,
    );

    await agentStyleCommand.action!(context, 'engineering');
    expect(config.setAgentStyle).toHaveBeenCalledWith('augment');
  });

  it('shows and completes plain aliases while legacy ids stay hidden', async () => {
    const result = await agentStyleCommand.action!(context, 'status');
    expect(result).toMatchObject({ type: 'message' });
    if (!result || result.type !== 'message') throw new Error('Expected message result');

    expect(result.content).toContain('/agent-style office');
    expect(result.content).not.toContain('/agent-style antigravity');
    expect(await agentStyleCommand.completion!(context, 'of')).toContain('office');
    expect(await agentStyleCommand.completion!(context, 'anti')).toEqual([]);
  });
});
