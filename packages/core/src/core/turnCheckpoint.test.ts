/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for TurnCheckpointManager — crash recovery checkpoint system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

import {
  TurnCheckpointManager,
  TurnCheckpoint,
  CompletedToolEntry,
  ToolReplayClass,
  classifyTool,
  DEFAULT_REPLAY_CLASS,
} from './turnCheckpoint.js';
import { TurnState } from './turnStateMachine.js';

let tmpDir: string;
let manager: TurnCheckpointManager;

beforeEach(async () => {
  tmpDir = path.join(
    tmpdir(),
    `otto-turn-checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  manager = new TurnCheckpointManager(
    path.join(tmpDir, '.otto-user'),
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeCheckpoint(
  overrides: Partial<TurnCheckpoint> = {},
): TurnCheckpoint {
  return {
    turnId: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'sess-test-001',
    state: TurnState.EXECUTING_TOOL,
    completedTools: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeToolEntry(
  overrides: Partial<CompletedToolEntry> = {},
): CompletedToolEntry {
  return {
    name: 'test_tool',
    callId: `fc-${Date.now()}`,
    completedAt: new Date().toISOString(),
    resultSummary: 'OK',
    replayClass: ToolReplayClass.IDEMPOTENT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. save & load
// ---------------------------------------------------------------------------

describe('TurnCheckpointManager — save & load', () => {
  it('should save a checkpoint to disk', async () => {
    const cp = makeCheckpoint();
    await manager.save(cp);

    const loaded = await manager.load(cp.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.turnId).toBe(cp.turnId);
    expect(loaded!.sessionId).toBe(cp.sessionId);
    expect(loaded!.state).toBe(cp.state);
    expect(loaded!.completedTools).toEqual(cp.completedTools);
  });

  it('should return null when no checkpoint exists', async () => {
    const loaded = await manager.load('nonexistent-session');
    expect(loaded).toBeNull();
  });

  it('should update timestamp on each save', async () => {
    const cp = makeCheckpoint();
    await manager.save(cp);

    const loaded1 = await manager.load(cp.sessionId);
    const ts1 = new Date(loaded1!.timestamp).getTime();

    // Wait a tiny bit then re-save
    await new Promise((r) => setTimeout(r, 10));
    await manager.save(cp);

    const loaded2 = await manager.load(cp.sessionId);
    const ts2 = new Date(loaded2!.timestamp).getTime();

    expect(ts2).toBeGreaterThanOrEqual(ts1);
  });

  it('should load the most recent checkpoint for a session', async () => {
    const old = makeCheckpoint({ timestamp: '2025-01-01T00:00:00.000Z', state: TurnState.PLANNING });
    const recent = makeCheckpoint({ timestamp: '2025-06-01T00:00:00.000Z', state: TurnState.EXECUTING_TOOL });
    old.sessionId = recent.sessionId;
    old.turnId = 'turn-old';
    recent.turnId = 'turn-recent';

    await manager.save(old);
    await manager.save(recent);

    const loaded = await manager.load(old.sessionId);
    expect(loaded).not.toBeNull();
    // Most recent should win
    expect(loaded!.turnId).toBe('turn-recent');
    expect(loaded!.state).toBe(TurnState.EXECUTING_TOOL);
  });
});

// ---------------------------------------------------------------------------
// 2. clear
// ---------------------------------------------------------------------------

describe('TurnCheckpointManager — clear', () => {
  it('should remove a checkpoint after successful completion', async () => {
    const cp = makeCheckpoint();
    await manager.save(cp);

    await manager.clear(cp.turnId);

    const loaded = await manager.load(cp.sessionId);
    expect(loaded).toBeNull();
  });

  it('should not throw when clearing a non-existent checkpoint', async () => {
    await expect(manager.clear('nonexistent-turn-id')).resolves.toBeUndefined();
  });

  it('should leave other checkpoints intact after clearing one', async () => {
    const cp1 = makeCheckpoint({ sessionId: 'sess-a', turnId: 't1' });
    const cp2 = makeCheckpoint({ sessionId: 'sess-b', turnId: 't2' });

    await manager.save(cp1);
    await manager.save(cp2);
    await manager.clear('t1');

    expect(await manager.load('sess-a')).toBeNull();
    expect(await manager.load('sess-b')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. listIncomplete
// ---------------------------------------------------------------------------

describe('TurnCheckpointManager — listIncomplete', () => {
  it('should return empty array when no checkpoints exist', async () => {
    const incomplete = await manager.listIncomplete();
    expect(incomplete).toEqual([]);
  });

  it('should list all incomplete turns across sessions', async () => {
    const cp1 = makeCheckpoint({ sessionId: 'sess-x', state: TurnState.EXECUTING_TOOL });
    const cp2 = makeCheckpoint({ sessionId: 'sess-y', state: TurnState.PLANNING });

    await manager.save(cp1);
    await manager.save(cp2);

    const incomplete = await manager.listIncomplete();
    expect(incomplete).toHaveLength(2);
    const ids = incomplete.map((c) => c.turnId).sort();
    expect(ids).toEqual([cp1.turnId, cp2.turnId].sort());
  });

  it('should exclude terminal-state checkpoints', async () => {
    const running = makeCheckpoint({ state: TurnState.EXECUTING_TOOL, turnId: 't-running' });
    const completed = makeCheckpoint({ state: TurnState.COMPLETED, turnId: 't-done' });
    const failed = makeCheckpoint({ state: TurnState.FAILED, turnId: 't-failed' });
    const cancelled = makeCheckpoint({ state: TurnState.CANCELLED, turnId: 't-cancel' });

    await manager.save(running);
    await manager.save(completed);
    await manager.save(failed);
    await manager.save(cancelled);

    const incomplete = await manager.listIncomplete();
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].turnId).toBe('t-running');
  });

  it('should sort by timestamp descending', async () => {
    const older = makeCheckpoint({
      turnId: 't-older',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    const newer = makeCheckpoint({
      turnId: 't-newer',
      timestamp: '2025-06-01T00:00:00.000Z',
    });

    await manager.save(older);
    await manager.save(newer);

    const incomplete = await manager.listIncomplete();
    expect(incomplete[0].turnId).toBe('t-newer');
    expect(incomplete[1].turnId).toBe('t-older');
  });
});

// ---------------------------------------------------------------------------
// 4. crash recovery — tool already executed → not replayed
// ---------------------------------------------------------------------------

describe('TurnCheckpointManager — crash recovery', () => {
  it('should skip NEVER_REPLAYED tools that already completed', () => {
    const cp = makeCheckpoint({
      completedTools: [
        {
          name: 'send_message',
          callId: 'fc-send-1',
          completedAt: new Date().toISOString(),
          resultSummary: 'Message sent successfully',
          replayClass: ToolReplayClass.NEVER_REPLAYED,
        },
      ],
    });

    const shouldSkip = manager.shouldSkipTool(cp, 'send_message', 'fc-send-1');
    expect(shouldSkip).toBe(true);
  });

  it('should re-execute IDEMPOTENT tools (skip=false)', () => {
    const cp = makeCheckpoint({
      completedTools: [
        {
          name: 'write_file',
          callId: 'fc-write-1',
          completedAt: new Date().toISOString(),
          resultSummary: 'Written',
          replayClass: ToolReplayClass.IDEMPOTENT,
        },
      ],
    });

    const shouldSkip = manager.shouldSkipTool(cp, 'write_file', 'fc-write-1');
    expect(shouldSkip).toBe(false);
  });

  it('should re-execute REPLAYABLE tools (skip=false)', () => {
    const cp = makeCheckpoint({
      completedTools: [
        {
          name: 'read_file',
          callId: 'fc-read-1',
          completedAt: new Date().toISOString(),
          resultSummary: 'File contents...',
          replayClass: ToolReplayClass.REPLAYABLE,
        },
      ],
    });

    const shouldSkip = manager.shouldSkipTool(cp, 'read_file', 'fc-read-1');
    expect(shouldSkip).toBe(false);
  });

  it('should not skip tools that have NOT been completed yet', () => {
    const cp = makeCheckpoint({
      completedTools: [
        {
          name: 'write_file',
          callId: 'fc-write-1',
          completedAt: new Date().toISOString(),
          replayClass: ToolReplayClass.IDEMPOTENT,
        },
      ],
    });

    // This tool was never completed — should NOT be skipped
    const shouldSkip = manager.shouldSkipTool(cp, 'send_message', 'fc-send-1');
    expect(shouldSkip).toBe(false);
  });

  it('should not skip tools with different callIds (dedup by name+callId)', () => {
    const cp = makeCheckpoint({
      completedTools: [
        {
          name: 'send_message',
          callId: 'fc-send-1',
          completedAt: new Date().toISOString(),
          replayClass: ToolReplayClass.NEVER_REPLAYED,
        },
      ],
    });

    // Same tool name but different callId — it's a new invocation
    const shouldSkip = manager.shouldSkipTool(cp, 'send_message', 'fc-send-2');
    expect(shouldSkip).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. crash before tool → tool still needs executing
// ---------------------------------------------------------------------------

describe('TurnCheckpointManager — crash before tool execution', () => {
  it('should report that an un-completed tool is NOT in the completed list', () => {
    const cp = makeCheckpoint({
      completedTools: [],
    });

    const shouldSkip = manager.shouldSkipTool(cp, 'any_tool', 'fc-any');
    expect(shouldSkip).toBe(false);
  });

  it('should allow loading checkpoint state to see which tools ran', async () => {
    // Simulate: three tools where only first two completed before crash
    const cp = makeCheckpoint({
      state: TurnState.EXECUTING_TOOL,
      completedTools: [
        makeToolEntry({ name: 'read_file', callId: 'fc-r1', replayClass: ToolReplayClass.REPLAYABLE }),
        makeToolEntry({ name: 'write_file', callId: 'fc-w1', replayClass: ToolReplayClass.IDEMPOTENT }),
      ],
    });

    await manager.save(cp);

    // On recovery, load the checkpoint
    const recovered = await manager.load(cp.sessionId);
    expect(recovered).not.toBeNull();
    expect(recovered!.completedTools).toHaveLength(2);
    expect(recovered!.completedTools[0].name).toBe('read_file');
    expect(recovered!.completedTools[1].name).toBe('write_file');
  });

  it('should correctly classify known and unknown tools', () => {
    expect(classifyTool('send_message')).toBe(ToolReplayClass.NEVER_REPLAYED);
    expect(classifyTool('write_file')).toBe(ToolReplayClass.IDEMPOTENT);
    expect(classifyTool('read_file')).toBe(ToolReplayClass.REPLAYABLE);
    expect(classifyTool('some_custom_tool_xyz')).toBe(DEFAULT_REPLAY_CLASS);
  });
});

// ---------------------------------------------------------------------------
// 6. formatForRecovery
// ---------------------------------------------------------------------------

describe('TurnCheckpointManager.formatForRecovery', () => {
  it('should produce a human-readable summary', () => {
    const cp: TurnCheckpoint = {
      turnId: 'turn-abc123def456',
      sessionId: 'sess-xyz789...',
      state: TurnState.EXECUTING_TOOL,
      completedTools: [
        {
          name: 'read_file',
          callId: 'fc-read01',
          completedAt: '2025-06-01T00:00:00.000Z',
          replayClass: ToolReplayClass.REPLAYABLE,
        },
        {
          name: 'send_message',
          callId: 'fc-send01',
          completedAt: '2025-06-01T00:00:01.000Z',
          replayClass: ToolReplayClass.NEVER_REPLAYED,
        },
      ],
      timestamp: '2025-06-01T00:00:02.000Z',
    };

    const summary = TurnCheckpointManager.formatForRecovery(cp);
    expect(summary).toContain('turn-abc123de');
    expect(summary).toContain('sess-xyz789');
    expect(summary).toContain('executing_tool');
    expect(summary).toContain('read_file');
    expect(summary).toContain('send_message');
    expect(summary).toContain('🔒'); // NEVER_REPLAYED marker
  });
});

// ---------------------------------------------------------------------------
// 7. integration — full save/load/lifecycle in a single test
// ---------------------------------------------------------------------------

describe('TurnCheckpointManager — lifecycle', () => {
  it('should support full save → load → append tools → clear cycle', async () => {
    const cp = makeCheckpoint();

    // Phase 1: save initial state
    await manager.save(cp);

    // Phase 2: load
    let loaded = await manager.load(cp.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.completedTools).toHaveLength(0);

    // Phase 3: tool executed → append to checkpoint
    cp.completedTools.push(
      makeToolEntry({ name: 'tool_a', callId: 'fc-a' }),
    );
    cp.state = TurnState.OBSERVING_RESULT;
    await manager.save(cp);

    loaded = await manager.load(cp.sessionId);
    expect(loaded!.completedTools).toHaveLength(1);
    expect(loaded!.state).toBe(TurnState.OBSERVING_RESULT);

    // Phase 4: another tool
    cp.completedTools.push(
      makeToolEntry({ name: 'send_message', callId: 'fc-s', replayClass: ToolReplayClass.NEVER_REPLAYED }),
    );
    await manager.save(cp);

    loaded = await manager.load(cp.sessionId);
    expect(loaded!.completedTools).toHaveLength(2);
    expect(
      manager.shouldSkipTool(loaded!, 'send_message', 'fc-s'),
    ).toBe(true);
    expect(
      manager.shouldSkipTool(loaded!, 'tool_a', 'fc-a'),
    ).toBe(false);

    // Phase 5: turn complete → clear
    await manager.clear(cp.turnId);
    loaded = await manager.load(cp.sessionId);
    expect(loaded).toBeNull();
  });
});
