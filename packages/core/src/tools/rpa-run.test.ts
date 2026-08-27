/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { createMockConfig } from '../utils/test-helpers.js';
import { RpaRunTool } from './rpa-run.js';

describe('RpaRunTool', () => {
  const tool = new RpaRunTool(createMockConfig());
  const workflow = {
    id: 'invoice-check',
    version: 1 as const,
    steps: [{ id: 'open', action: 'web.navigate' as const, args: { url: 'https://example.com' }, sideEffect: 'none' as const }],
  };

  it('accepts a bounded workflow definition', () => {
    expect(tool.validateToolParams({ action: 'start', workflow })).toBeNull();
  });

  it('rejects a secret embedded in workflow arguments', () => {
    expect(tool.validateToolParams({
      action: 'start',
      workflow: { ...workflow, steps: [{ ...workflow.steps[0], args: { password: 'never-store-me' } }] },
    })).toContain('secrets');
  });

  it('requires an explicit approval identifier', () => {
    expect(tool.validateToolParams({ action: 'approve', run_id: 'run-1' })).toContain('approval_id');
  });

  it('requires confirmation for every state-changing operation', async () => {
    expect(await tool.shouldConfirmExecute({ action: 'start', workflow }, new AbortController().signal)).not.toBe(false);
    expect(await tool.shouldConfirmExecute({ action: 'status', run_id: 'run-1' }, new AbortController().signal)).toBe(false);
  });

  it('loads the optional RPA runtime for a read-only status lookup', async () => {
    const result = await tool.execute({ action: 'status', run_id: 'rpa-00000000-0000-0000-0000-000000000000' }, new AbortController().signal);
    expect(String(result.llmContent)).toContain('"found":false');
  });

  it('fails closed without loading RPA after task authorization was revoked', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const runtime = vi.spyOn(tool as never, 'runner' as never);

    const result = await tool.execute(
      { action: 'status', run_id: 'rpa-00000000-0000-0000-0000-000000000000' },
      cancelled.signal,
    );

    expect(String(result.llmContent)).toContain('CANCELLED');
    expect(runtime).not.toHaveBeenCalled();
    runtime.mockRestore();
  });

  it('does not publish a late RPA result after cancellation wins the race', async () => {
    const localTool = new RpaRunTool(createMockConfig());
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    vi.spyOn(localTool as never, 'runner' as never).mockResolvedValue({
      runNext: () => pending,
    } as never);
    const controller = new AbortController();
    const execution = localTool.execute({ action: 'run_next', run_id: 'rpa-00000000-0000-0000-0000-000000000000' }, controller.signal);
    controller.abort();
    release(null);

    const result = await execution;
    expect(String(result.llmContent)).toContain('CANCELLED');
    expect(String(result.llmContent)).not.toContain('OK');
  });
});
