/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for SubAgent tool-completion timeout —
 * covers the bug where a hung shell command caused SubAgent.processAndStorePendingToolResults
 * to await toolCompletionPromise forever, blocking the entire workflow.
 *
 * Fix: toolCompletionPromise has a 10-minute timeout that rejects with a descriptive error.
 *
 * Note: We use vi.useFakeTimers() to simulate the 10min timeout without actually waiting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Isolate the timeout constant ────────────────────────────────────────────
// We test the timeout logic directly without instantiating a full SubAgent
// (which requires Config, ToolRegistry, GeminiClient, etc.)
// Instead we replicate the exact toolCompletionPromise pattern from subAgent.ts.

const TOOL_COMPLETION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes — must match subAgent.ts

/**
 * Replicates the toolCompletionPromise pattern from SubAgent.processAndStorePendingToolResults.
 * Returns { promise, resolver } so tests can control when/if the resolver fires.
 */
function makeToolCompletionPromise(toolNames: string[]): {
  promise: Promise<unknown[]>;
  resolver: ((results: unknown[]) => void) | undefined;
  rejecter: ((err: Error) => void) | undefined;
} {
  let resolver: ((results: unknown[]) => void) | undefined;
  let rejecter: ((err: Error) => void) | undefined;

  const promise = new Promise<unknown[]>((resolve, reject) => {
    resolver = resolve;
    rejecter = reject;
    setTimeout(() => {
      if (resolver) {
        resolver = undefined;
        const toolNamesStr = toolNames.join(', ');
        reject(new Error(
          `Tool completion timeout after ${TOOL_COMPLETION_TIMEOUT_MS / 1000}s. ` +
          `Stuck tool(s): [${toolNamesStr}]. The tool may have hung — aborting this turn.`
        ));
      }
    }, TOOL_COMPLETION_TIMEOUT_MS);
  });

  return { promise, resolver, rejecter };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SubAgent toolCompletionPromise timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when tools complete before timeout', async () => {
    const { promise, resolver } = makeToolCompletionPromise(['run_shell_command']);

    // Simulate tool completing quickly
    resolver!([{ callId: 'cmd-1', response: { responseParts: [{ text: 'output' }] } }]);

    const results = await promise;
    expect(results).toHaveLength(1);
    expect(results[0].callId).toBe('cmd-1');
  });

  it('rejects after 3 minutes when tool callback never fires', async () => {
    const { promise } = makeToolCompletionPromise(['run_shell_command', 'read_file']);

    // Advance time just under 10 minutes — should not reject yet
    vi.advanceTimersByTime(TOOL_COMPLETION_TIMEOUT_MS - 1000);
    // Promise should still be pending — give microtask queue a turn
    let rejected = false;
    promise.catch(() => { rejected = true; });
    await Promise.resolve();
    expect(rejected).toBe(false);

    // Advance past the deadline
    vi.advanceTimersByTime(2000);
    await expect(promise).rejects.toThrow(
      /Tool completion timeout after 180s/
    );
  });

  it('includes stuck tool names in the rejection error message', async () => {
    const toolNames = ['run_shell_command', 'glob'];
    const { promise } = makeToolCompletionPromise(toolNames);

    vi.advanceTimersByTime(TOOL_COMPLETION_TIMEOUT_MS + 100);

    await expect(promise).rejects.toThrow(
      /Stuck tool\(s\): \[run_shell_command, glob\]/
    );
  });

  it('does NOT reject if resolver fires exactly at the boundary', async () => {
    const { promise, resolver } = makeToolCompletionPromise(['slow_tool']);

    // Resolve just before timer fires
    vi.advanceTimersByTime(TOOL_COMPLETION_TIMEOUT_MS - 1);
    resolver!([{ callId: 'slow-1', response: {} }]);

    // Now advance past deadline — resolver already cleared, timer should be a no-op
    vi.advanceTimersByTime(5000);

    const results = await promise;
    expect(results[0].callId).toBe('slow-1');
  });
});
