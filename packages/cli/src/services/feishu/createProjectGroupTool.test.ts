/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { CreateProjectGroupTool } from './createProjectGroupTool.js';
import type { FeishuGateway } from './gateway.js';

// Stub the legacy registration/scopes/logger modules so importing the tool
// doesn't drag in any side-effecting auth or feishu network code.
vi.mock('./registration.js', () => ({
  probeCredentials: vi.fn(async () => ({
    grantedScopes: ['im:chat', 'im:message.group_msg'],
  })),
}));
vi.mock('./scopes.js', () => ({
  SENSITIVE_GROUP_MSG_SCOPE: 'im:message.group_msg',
  buildScopeApplyUrl: () => 'https://example.test/apply',
  buildEventSubUrl: () => 'https://example.test/events',
  buildPermissionPageUrl: () => 'https://example.test/perm',
}));
vi.mock('./logger.js', () => ({
  dlog: vi.fn(),
  dwarn: vi.fn(),
  derror: vi.fn(),
}));

function makeGateway(overrides: Partial<FeishuGateway> = {}): FeishuGateway {
  return {
    createGroupChat: vi.fn(async () => 'chat_new_123'),
    sendMessage: vi.fn(async () => undefined),
    getAppId: () => 'app_id',
    getAppSecret: () => 'app_secret',
    getDomain: () => 'feishu',
    ...overrides,
  } as unknown as FeishuGateway;
}

function makeFs() {
  return {
    existsSync: vi.fn(() => true), // skip mkdir entirely
    mkdirSync: vi.fn(),
  };
}

function makeTool(deps: Partial<Parameters<typeof CreateProjectGroupTool['prototype']['constructor']>[0]> = {}) {
  const fs = makeFs();
  const gateway = makeGateway();
  const onProjectCreated = vi.fn(async () => undefined);
  const tool = new CreateProjectGroupTool({
    gateway,
    getSenderOpenId: () => 'ou_user_x',
    getActiveChatId: () => null,
    onProjectCreated,
    fs,
    ...deps,
  });
  return { tool, gateway, onProjectCreated, fs };
}

const ABORT = new AbortController().signal;

describe('CreateProjectGroupTool.validateToolParams', () => {
  it('rejects missing project_path', () => {
    const { tool } = makeTool();
    expect(tool.validateToolParams({ project_path: '', group_name: 'g' } as any))
      .toMatch(/project_path/);
  });

  it('rejects missing group_name', () => {
    const { tool } = makeTool();
    expect(tool.validateToolParams({ project_path: '/x', group_name: '' } as any))
      .toMatch(/group_name/);
  });

  it('rejects an unknown agent value', () => {
    const { tool } = makeTool();
    expect(
      tool.validateToolParams({
        project_path: '/x',
        group_name: 'g',
        agent: 'gpt' as never,
      }),
    ).toMatch(/agent/);
  });

  it('accepts agent="claude-code" and agent="codex"', () => {
    const { tool } = makeTool();
    expect(
      tool.validateToolParams({ project_path: '/x', group_name: 'g', agent: 'claude-code' }),
    ).toBeNull();
    expect(
      tool.validateToolParams({ project_path: '/x', group_name: 'g', agent: 'codex' }),
    ).toBeNull();
  });

  it('accepts no agent (default)', () => {
    const { tool } = makeTool();
    expect(tool.validateToolParams({ project_path: '/x', group_name: 'g' })).toBeNull();
  });
});

describe('CreateProjectGroupTool.execute — agent threading', () => {
  it('omits agent in onProjectCreated when none was provided (default → self)', async () => {
    const { tool, gateway, onProjectCreated } = makeTool();
    const res = await tool.execute(
      { project_path: '/proj', group_name: 'My Project' },
      ABORT,
    );
    expect(res.llmContent).toContain('Successfully created project directory');
    expect(gateway.createGroupChat).toHaveBeenCalledWith('My Project', 'ou_user_x');
    expect(onProjectCreated).toHaveBeenCalledTimes(1);
    const [chatId, absPath, agent] = onProjectCreated.mock.calls[0];
    expect(chatId).toBe('chat_new_123');
    expect(absPath).toMatch(/proj$/);
    expect(agent).toBeUndefined();
  });

  it('threads agent="codex" through to onProjectCreated and welcome message', async () => {
    const { tool, gateway, onProjectCreated } = makeTool();
    const res = await tool.execute(
      { project_path: '/proj', group_name: 'Codex Project', agent: 'codex' },
      ABORT,
    );
    expect(res.llmContent).toContain('bound to codex');
    expect(onProjectCreated.mock.calls[0][2]).toBe('codex');

    // Welcome message must mention the bound Codex agent so the user
    // understands routing has changed.
    const welcome = (gateway.sendMessage as any).mock.calls[0][1] as string;
    expect(welcome).toContain('本机 Codex');
    expect(welcome).not.toContain('本机 Claude Code');
  });

  it('threads agent="claude-code" through to onProjectCreated and welcome message', async () => {
    const { tool, gateway, onProjectCreated } = makeTool();
    const res = await tool.execute(
      { project_path: '/proj', group_name: 'CC Project', agent: 'claude-code' },
      ABORT,
    );
    expect(res.llmContent).toContain('bound to claude-code');
    expect(onProjectCreated.mock.calls[0][2]).toBe('claude-code');

    const welcome = (gateway.sendMessage as any).mock.calls[0][1] as string;
    expect(welcome).toContain('本机 Claude Code');
    expect(welcome).not.toContain('本机 Codex');
  });

  it('does not pre-bind an agent in the welcome message when agent is omitted', async () => {
    const { tool, gateway } = makeTool();
    await tool.execute({ project_path: '/proj', group_name: 'Plain' }, ABORT);
    const welcome = (gateway.sendMessage as any).mock.calls[0][1] as string;
    expect(welcome).not.toContain('默认派发方');
  });
});

describe('CreateProjectGroupTool.execute — error paths', () => {
  it('returns an error result when senderOpenId is unknown', async () => {
    const { tool } = makeTool({ getSenderOpenId: () => undefined });
    const res = await tool.execute(
      { project_path: '/x', group_name: 'g' },
      ABORT,
    );
    expect(res.llmContent).toContain('Error');
    expect(res.llmContent).toContain('sender openId is unknown');
  });

  it('returns an error result when gateway.createGroupChat resolves null', async () => {
    const gateway = makeGateway({
      createGroupChat: vi.fn(async () => null),
    } as any);
    const { tool } = makeTool({ gateway });
    const res = await tool.execute(
      { project_path: '/x', group_name: 'g' },
      ABORT,
    );
    expect(res.llmContent).toContain('failed to create group chat');
  });

  it('returns a validation error before any side effects when agent is invalid', async () => {
    const { tool, gateway, onProjectCreated } = makeTool();
    const res = await tool.execute(
      { project_path: '/x', group_name: 'g', agent: 'bogus' as never },
      ABORT,
    );
    expect(res.llmContent).toContain('Error');
    expect(gateway.createGroupChat).not.toHaveBeenCalled();
    expect(onProjectCreated).not.toHaveBeenCalled();
  });
});
