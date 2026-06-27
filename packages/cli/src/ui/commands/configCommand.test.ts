/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configCommand } from './configCommand.js';
import { CommandKind, CommandContext, SlashCommandActionReturn } from './types.js';
import { Config, ApprovalMode } from 'otto-core';
import type { LoadedSettings } from '../../config/settings.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

interface MockSettings {
  merged: {
    vimMode: boolean;
  };
  setValue: ReturnType<typeof vi.fn>;
}

function expectMessageContent(
  result: SlashCommandActionReturn | void,
  expected: string,
): void {
  expect(result).toBeDefined();
  if (!result || result.type !== 'message') {
    throw new Error('Expected message action result');
  }
  expect(result.content).toContain(expected);
}

describe('configCommand', () => {
  let mockConfig: Partial<Config>;
  let mockSettings: MockSettings;
  let mockContext: CommandContext;

  beforeEach(() => {
    mockConfig = {
      getAgentStyle: vi.fn().mockReturnValue('default'),
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getHealthyUseEnabled: vi.fn().mockReturnValue(false),
      setApprovalModeWithProjectSync: vi.fn(),
      setAgentStyle: vi.fn(),
      getVsCodePluginMode: vi.fn().mockReturnValue(false),
      getUserMemory: vi.fn().mockReturnValue(null),
      getOttoClient: vi.fn(),
    };

    mockSettings = {
      merged: {
        vimMode: false,
      },
      setValue: vi.fn(),
    };

    mockContext = createMockCommandContext({
      services: {
        config: mockConfig as Config,
        settings: mockSettings as unknown as LoadedSettings,
      },
      ui: {
        addItem: vi.fn(),
        toggleVimEnabled: vi.fn().mockResolvedValue(true),
      },
    });
  });

  it('should have correct name and aliases', () => {
    expect(configCommand.name).toBe('config');
    expect(configCommand.altNames).toEqual(['settings', 'preferences']);
  });

  it('should have built-in kind', () => {
    expect(configCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should have 9 subcommands', () => {
    expect(configCommand.subCommands).toHaveLength(9);
    const names = configCommand.subCommands!.map(cmd => cmd.name);
    expect(names).toContain('theme');
    expect(names).toContain('editor');
    expect(names).toContain('model');
    expect(names).toContain('vim');
    expect(names).toContain('agent-style');
    expect(names).toContain('yolo');
    expect(names).toContain('healthy-use');
    expect(names).toContain('language');
    expect(names).toContain('memory-mode');
  });

  it('should open settings menu dialog when no args provided', async () => {
    const result = await configCommand.action!(mockContext, '');
    expect(result).toMatchObject({ type: 'dialog', dialog: 'settings-menu' });
  });

  it('should open theme dialog for theme subcommand', async () => {
    const result = await configCommand.action!(mockContext, 'theme');
    expect(result).toMatchObject({ type: 'dialog', dialog: 'theme' });
  });

  it('should open editor dialog for editor subcommand', async () => {
    const result = await configCommand.action!(mockContext, 'editor');
    expect(result).toMatchObject({ type: 'dialog', dialog: 'editor' });
  });

  it('should open model dialog for model subcommand without args', async () => {
    const result = await configCommand.action!(mockContext, 'model');
    expect(result).toMatchObject({ type: 'dialog', dialog: 'model' });
  });

  it('should toggle vim mode for vim subcommand', async () => {
    const result = await configCommand.action!(mockContext, 'vim');
    expectMessageContent(result, '✅');
    expect(mockContext.ui?.toggleVimEnabled).toHaveBeenCalled();
  });

  it('should display agent style status for agent-style subcommand', async () => {
    const result = await configCommand.action!(mockContext, 'agent-style');
    expect(result).toBeDefined();
    expect(result.type).toBe('message');
  });

  it('should handle unknown subcommand', async () => {
    const result = await configCommand.action!(mockContext, 'unknown');
    expect(result).toBeDefined();
    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
  });

  it('should provide completion suggestions', async () => {
    const completions = await configCommand.completion!(mockContext, 'th');
    expect(completions).toContain('theme');
  });

  it('should provide all completion suggestions for empty partial', async () => {
    const completions = await configCommand.completion!(mockContext, '');
    expect(completions).toContain('theme');
    expect(completions).toContain('vim');
    expect(completions).toContain('yolo');
    expect(completions.length).toBeGreaterThan(5);
  });

  it('should handle yolo enable', async () => {
    const result = await configCommand.action!(mockContext, 'yolo on');
    expectMessageContent(result, 'enabled');
  });

  it('should handle yolo disable', async () => {
    mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
    const result = await configCommand.action!(mockContext, 'yolo off');
    expectMessageContent(result, 'disabled');
  });

  it('should handle healthy-use enable', async () => {
    const result = await configCommand.action!(mockContext, 'healthy-use on');
    expect(result).toBeDefined();
    expect(result.type).toBe('message');
  });

  it('should handle healthy-use disable', async () => {
    mockConfig.getHealthyUseEnabled = vi.fn().mockReturnValue(true);
    const result = await configCommand.action!(mockContext, 'healthy-use off');
    expect(result).toBeDefined();
    expect(result.type).toBe('message');
  });

  it('should handle agent-style switch to cursor', async () => {
    const result = await configCommand.action!(mockContext, 'agent-style cursor');
    expect(result).toBeDefined();
    expect(result.type).toBe('message');
    expect(mockConfig.setAgentStyle).toHaveBeenCalledWith('cursor');
  });
});
