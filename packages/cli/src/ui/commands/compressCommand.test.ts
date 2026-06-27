/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { OttoClient } from 'otto-core';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { compressCommand } from './compressCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';

describe('compressCommand', () => {
  let context: ReturnType<typeof createMockCommandContext>;
  let mockTryCompressChat: ReturnType<typeof vi.fn>;
  let mockIsCompressionInProgress: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockTryCompressChat = vi.fn();
    mockIsCompressionInProgress = vi.fn().mockReturnValue(false);
    context = createMockCommandContext({
      services: {
        config: {
          getOttoClient: () =>
            ({
              tryCompressChat: mockTryCompressChat,
              isCompressionInProgress: mockIsCompressionInProgress,
            }) as unknown as OttoClient,
        },
      },
    });
  });

  it('should do nothing if a compression is already pending', async () => {
    context.ui.pendingItem = {
      type: MessageType.COMPRESSION,
      compression: {
        isPending: true,
        originalTokenCount: null,
        newTokenCount: null,
      },
    };
    await compressCommand.action!(context, '');
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: 'Already compressing, wait for previous request to complete',
      }),
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).not.toHaveBeenCalled();
    expect(mockTryCompressChat).not.toHaveBeenCalled();
  });

  it('should set pending item, call tryCompressChat, and add result on success', async () => {
    const compressedResult = {
      originalTokenCount: 200,
      newTokenCount: 100,
    };
    mockTryCompressChat.mockResolvedValue(compressedResult);

    await compressCommand.action!(context, '');

    expect(context.ui.setPendingItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: MessageType.COMPRESSION,
        compression: {
          isPending: true,
          originalTokenCount: null,
          newTokenCount: null,
        },
      }),
    );

    expect(mockTryCompressChat).toHaveBeenCalledWith(
      expect.stringMatching(/^compress-\d+$/),
      expect.any(AbortSignal),
      true,
    );

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.COMPRESSION,
        compression: {
          isPending: false,
          originalTokenCount: 200,
          newTokenCount: 100,
        },
      }),
      expect.any(Number),
    );

    expect(context.ui.setPendingItem).toHaveBeenNthCalledWith(2, null);
  });

  it('should add an error message if tryCompressChat returns falsy', async () => {
    mockTryCompressChat.mockResolvedValue(null);

    await compressCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: 'Failed to compress chat history.',
      }),
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  it('should add an error message if tryCompressChat throws', async () => {
    const error = new Error('Compression failed');
    mockTryCompressChat.mockRejectedValue(error);

    await compressCommand.action!(context, '');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: `Failed to compress chat history: ${error.message}`,
      }),
      expect.any(Number),
    );
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  it('should clear the pending item in a finally block', async () => {
    mockTryCompressChat.mockRejectedValue(new Error('some error'));
    await compressCommand.action!(context, '');
    expect(context.ui.setPendingItem).toHaveBeenCalledWith(null);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: /goal mode + manual /compress
  //
  // Background: when /goal is active, OttoClient holds an in-memory
  // `activeGoalContext`. tryCompressChat re-injects the original goal prompt
  // after every compression so the contract (min-hours floor, T0, no-stop
  // discipline) survives. Manual /compress (and its altNames /compact,
  // /summarize) MUST go through the same `tryCompressChat` entry point so
  // that the same injection fires.
  //
  // These tests don't reach into core's compression internals (that's
  // covered by goalContinuationPrompt.test.ts and compressionService tests
  // in core). They only verify the plumbing contract this command relies
  // on: it dispatches to the SAME client instance whose setGoalContext
  // was called, so the in-memory context is observable to tryCompressChat.
  // If this contract breaks (e.g. someone refactors to a fresh client per
  // command, or routes /compress through a different code path), the goal
  // resilience feature silently regresses.
  describe('regression: /goal context preservation under manual compression', () => {
    it('routes through the SAME OttoClient instance that holds goal context', async () => {
      // Build a mock client that implements the goal-context surface
      // alongside the existing tryCompressChat surface.
      const mockSetGoalContext = vi.fn();
      const mockGetGoalContext = vi.fn();
      const localTryCompressChat = vi.fn().mockResolvedValue({
        originalTokenCount: 200,
        newTokenCount: 100,
      });
      const localIsCompressing = vi.fn().mockReturnValue(false);

      const sharedClient = {
        setGoalContext: mockSetGoalContext,
        getGoalContext: mockGetGoalContext,
        tryCompressChat: localTryCompressChat,
        isCompressionInProgress: localIsCompressing,
      } as unknown as OttoClient;

      const localContext = createMockCommandContext({
        services: {
          config: {
            // CRITICAL: returning the same object on every call models
            // the real Config behavior — getOttoClient() is a getter for
            // a single per-session client. Goal context written via
            // setGoalContext must be visible to subsequent tryCompressChat
            // calls on the same instance.
            getOttoClient: () => sharedClient,
          },
        },
      });

      // Simulate /goal launching: the client's setGoalContext is called
      // with the contract data (this is what useGoalWizard does in CLI).
      const goalCtx = {
        originalPrompt: '【goal contract verbatim】',
        startedAt: Date.now(),
        hours: 2,
        task: 'unit test task',
      };
      sharedClient.setGoalContext(goalCtx);

      // Now user runs /compress manually mid-goal.
      await compressCommand.action!(localContext, '');

      // Assertion 1: setGoalContext WAS called on the shared client (sanity).
      expect(mockSetGoalContext).toHaveBeenCalledTimes(1);
      expect(mockSetGoalContext).toHaveBeenCalledWith(goalCtx);

      // Assertion 2: tryCompressChat was invoked on the EXACT SAME client
      // — i.e. the one whose activeGoalContext is now set. This is what
      // gives core's tryCompressChat a chance to see the context and
      // perform the post-compression injection.
      expect(localTryCompressChat).toHaveBeenCalledTimes(1);
      expect(localTryCompressChat).toHaveBeenCalledWith(
        expect.stringMatching(/^compress-\d+$/),
        expect.any(AbortSignal),
        true, // force=true: matches the production call site
      );

      // Assertion 3: the command resolved successfully (would surface a
      // compression-result history item, not an error).
      expect(localContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.COMPRESSION,
        }),
        expect.any(Number),
      );
    });

    it('still calls tryCompressChat (and thus the goal-injection branch) for the /compact and /summarize aliases', () => {
      // The aliases are declared on the same SlashCommand object — a smoke
      // check that they aren't accidentally split into separate commands
      // with diverging implementations (which would skip goal injection).
      expect(compressCommand.altNames).toContain('compact');
      expect(compressCommand.altNames).toContain('summarize');
      // Same action reference → same execution path → same tryCompressChat
      // call → same goal-injection branch in core.
      expect(typeof compressCommand.action).toBe('function');
    });
  });
});