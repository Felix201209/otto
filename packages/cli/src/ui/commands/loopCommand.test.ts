/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loopCommand } from './loopCommand.js';
import { CommandContext } from './types.js';
import { MessageType } from '../types.js';
import { LoopContext } from 'otto-core';

function makeMockClient(initialCtx: LoopContext | null = null) {
  let ctx: LoopContext | null = initialCtx;
  const getLoopContext = vi.fn(() => ctx);
  const setLoopContext = vi.fn((newCtx: LoopContext) => {
    ctx = newCtx;
  });
  const clearLoopContext = vi.fn(() => {
    ctx = null;
  });
  return {
    getLoopContext,
    setLoopContext,
    clearLoopContext,
    _peek: () => ctx,
  };
}

describe('loopCommand', () => {
  let mockClient: ReturnType<typeof makeMockClient>;
  let mockContext: CommandContext;

  beforeEach(() => {
    mockClient = makeMockClient(null);
    mockContext = {
      services: {
        config: {
          getGeminiClient: () => mockClient,
        },
      },
      ui: {
        addItem: vi.fn(),
      },
    } as unknown as CommandContext;
  });

  it('has the correct metadata', () => {
    expect(loopCommand.name).toBe('loop');
    expect(loopCommand.subCommands).toBeDefined();
    expect(loopCommand.subCommands?.[0].name).toBe('clear');
  });

  describe('rootAction', () => {
    it('returns loop help if no arguments are provided and no loop is active', async () => {
      const result = await loopCommand.action?.(mockContext, '');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'info',
      });
      expect(result?.content).toContain('/loop Watchdog Command');
    });

    it('returns current loop info if no arguments are provided but loop is active', async () => {
      const now = Date.now();
      mockClient = makeMockClient({
        prompt: 'run tests',
        intervalMs: 60000,
        expiresAt: now + 360000,
        startedAt: now,
        lastRunAt: 0,
        isPendingRun: false,
      });

      const result = await loopCommand.action?.(mockContext, '');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'info',
      });
      expect(result?.content).toContain('Active Watchdog Loop');
      expect(result?.content).toContain('run tests');
    });

    it('successfully registers a loop with valid interval and prompt', async () => {
      const result = await loopCommand.action?.(mockContext, '5m run tests');

      expect(result).toMatchObject({
        type: 'message',
        messageType: 'info',
        content: '🔄 Loop activated. Waiting for the first interval...',
      });

      const activeCtx = mockClient._peek();
      expect(activeCtx).not.toBeNull();
      expect(activeCtx?.prompt).toBe('run tests');
      expect(activeCtx?.intervalMs).toBe(5 * 60 * 1000);
      expect(mockContext.ui.addItem).toHaveBeenCalled();
    });

    it('returns error if interval format is invalid', async () => {
      const result = await loopCommand.action?.(mockContext, 'invalid_interval run tests');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
      });
      expect(result?.content).toContain('Invalid interval format');
    });

    it('returns error if interval is less than 1 minute', async () => {
      const result = await loopCommand.action?.(mockContext, '30s run tests');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
      });
      expect(result?.content).toContain('Minimum loop interval is 1 minute');
    });

    it('returns error if prompt is missing', async () => {
      const result = await loopCommand.action?.(mockContext, '5m');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
      });
      expect(result?.content).toContain('Prompt cannot be empty');
    });

    it('successfully registers a loop with a custom --expires value', async () => {
      const result = await loopCommand.action?.(mockContext, '5m run tests --expires 30m');

      expect(result).toMatchObject({
        type: 'message',
        messageType: 'info',
        content: '🔄 Loop activated. Waiting for the first interval...',
      });

      const activeCtx = mockClient._peek();
      expect(activeCtx).not.toBeNull();
      expect(activeCtx?.prompt).toBe('run tests');
      expect(activeCtx?.intervalMs).toBe(5 * 60 * 1000);

      const expectedExpiresAt = activeCtx!.startedAt + 30 * 60 * 1000;
      // Allow slight delta in time execution
      expect(Math.abs(activeCtx!.expiresAt - expectedExpiresAt)).toBeLessThan(100);
    });

    it('returns error if --expires format is invalid', async () => {
      const result = await loopCommand.action?.(mockContext, '5m run tests --expires invalid');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
      });
      expect(result?.content).toContain('Invalid expires duration format');
    });
  });

  describe('clearAction', () => {
    it('stops the active loop and notifies the user', async () => {
      const now = Date.now();
      mockClient = makeMockClient({
        prompt: 'run tests',
        intervalMs: 60000,
        expiresAt: now + 360000,
        startedAt: now,
        lastRunAt: 0,
        isPendingRun: false,
      });

      const clearSub = loopCommand.subCommands?.[0];
      expect(clearSub).toBeDefined();

      const result = await clearSub?.action?.(mockContext, '');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'info',
        content: '🔄 Active /loop stopped.',
      });

      expect(mockClient.clearLoopContext).toHaveBeenCalledTimes(1);
      expect(mockClient._peek()).toBeNull();
      expect(mockContext.ui.addItem).toHaveBeenCalled();
    });

    it('notifies if there is no active loop to clear', async () => {
      const clearSub = loopCommand.subCommands?.[0];
      const result = await clearSub?.action?.(mockContext, '');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'info',
        content: 'No active /loop watchdog to clear.',
      });
      expect(mockClient.clearLoopContext).not.toHaveBeenCalled();
    });
  });
});
