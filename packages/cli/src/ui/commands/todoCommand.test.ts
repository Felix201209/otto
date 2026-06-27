/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { todoCommand } from './todoCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { todoStore } from 'otto-core';

describe('todoCommand', () => {
  let context: ReturnType<typeof createMockCommandContext>;

  beforeEach(() => {
    context = createMockCommandContext();
    vi.spyOn(todoStore, 'clear');
  });

  it('should clear todoStore and show success message on "/todo clear"', async () => {
    await todoCommand.action!(context, 'clear');
    expect(todoStore.clear).toHaveBeenCalled();
    expect(context.ui.setDebugMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Tasks panel has been successfully cleared|任务面板已成功清空/),
    );
  });

  it('should clear todoStore and show success message on empty args', async () => {
    await todoCommand.action!(context, '');
    expect(todoStore.clear).toHaveBeenCalled();
  });

  it('should show unknown subcommand message on invalid args', async () => {
    await todoCommand.action!(context, 'invalid_action');
    expect(todoStore.clear).not.toHaveBeenCalled();
    expect(context.ui.setDebugMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Unknown subcommand|未知的子命令/),
    );
  });
});
