/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 *
 * TurnCheckpoint — crash-safe turn recovery.
 *
 * If Otto crashes mid-turn (power loss, OOM, process kill), the next session
 * can resume without repeating irreversible side-effects (tool calls that
 * already executed).
 *
 * ## Storage
 * ~/.otto-user/checkpoints/turn-{turnId}.json
 *
 * ## Replay semantics
 * Every tool is classified into one of three buckets:
 *
 * | Classification   | Behavior on recovery                         |
 * |------------------|----------------------------------------------|
 * | REPLAYABLE       | Always re-execute (read-only, e.g. list_dir) |
 * | IDEMPOTENT       | Skip if already completed in this turn       |
 * | NEVER_REPLAYED   | Always skip — the checkpoint must capture    |
 *                    | enough for the agent to continue reasoning   |
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { TurnState } from './turnStateMachine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Operation classification for crash recovery. */
export enum ToolReplayClass {
  /** Read-only operations — safe to re-execute. */
  REPLAYABLE = 'replayable',
  /** Side-effectful but safe to repeat if we don't know whether it ran. */
  IDEMPOTENT = 'idempotent',
  /** Irreversible side-effect — MUST NOT be re-executed after completion. */
  NEVER_REPLAYED = 'never_replayed',
}

/** Map of tool-name → replay classification. */
export const TOOL_REPLAY_CLASSIFICATION: Readonly<Record<string, ToolReplayClass>> = {
  // Read-only — safe to re-execute
  read_file: ToolReplayClass.REPLAYABLE,
  list_directory: ToolReplayClass.REPLAYABLE,
  search_files: ToolReplayClass.REPLAYABLE,
  grep: ToolReplayClass.REPLAYABLE,
  get_weather: ToolReplayClass.REPLAYABLE,
  get_time: ToolReplayClass.REPLAYABLE,
  // Idempotent — side-effects but safe to repeat
  write_file: ToolReplayClass.IDEMPOTENT,
  edit_file: ToolReplayClass.IDEMPOTENT,
  create_directory: ToolReplayClass.IDEMPOTENT,
  // NEVER_REPLAYED — irreversible
  send_message: ToolReplayClass.NEVER_REPLAYED,
  send_email: ToolReplayClass.NEVER_REPLAYED,
  deploy_service: ToolReplayClass.NEVER_REPLAYED,
  purchase_item: ToolReplayClass.NEVER_REPLAYED,
  delete_file: ToolReplayClass.NEVER_REPLAYED,
  run_sql: ToolReplayClass.NEVER_REPLAYED,
  db_migration: ToolReplayClass.NEVER_REPLAYED,
};

/** Default classification for tools not in the map. */
export const DEFAULT_REPLAY_CLASS = ToolReplayClass.IDEMPOTENT;

/**
 * Returns the replay classification for a tool.
 * Unknown tools default to IDEMPOTENT — conservative but safe.
 */
export function classifyTool(toolName: string): ToolReplayClass {
  return TOOL_REPLAY_CLASSIFICATION[toolName] ?? DEFAULT_REPLAY_CLASS;
}

/** Record of a single completed tool execution. */
export interface CompletedToolEntry {
  /** Tool name. */
  name: string;
  /** Tool call ID (for dedup). */
  callId: string;
  /** When the tool completed (ISO). */
  completedAt: string;
  /** Result summary (truncated to 2KB for storage). */
  resultSummary?: string;
  /** Replay classification at the time of execution. */
  replayClass: ToolReplayClass;
}

/** A turn checkpoint persisted to disk. */
export interface TurnCheckpoint {
  /** Turn ID (unique per execution). */
  turnId: string;
  /** Parent session ID. */
  sessionId: string;
  /** Current turn state machine state. */
  state: TurnState;
  /** Tools that have already been executed in this turn. */
  completedTools: CompletedToolEntry[];
  /** Last tool result summary (for agent context on resume). */
  lastToolResult?: string;
  /** ISO timestamp of last write. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// TurnCheckpointManager
// ---------------------------------------------------------------------------

export class TurnCheckpointManager {
  private readonly checkpointsDir: string;

  constructor(baseDir?: string) {
    const dir = baseDir || process.env.OTTO_USER_DIR || path.join(homedir(), '.otto-user');
    this.checkpointsDir = path.join(dir, 'checkpoints');
  }

  /** Filesystem path for a turn checkpoint file. */
  private filePath(turnId: string): string {
    return path.join(this.checkpointsDir, `turn-${turnId}.json`);
  }

  /**
   * Save (or update) a turn checkpoint.
   * Creates the checkpoints directory if it doesn't exist.
   */
  async save(checkpoint: TurnCheckpoint): Promise<void> {
    await fs.mkdir(this.checkpointsDir, { recursive: true });
    checkpoint.timestamp = new Date().toISOString();
    const file = this.filePath(checkpoint.turnId);
    await fs.writeFile(file, JSON.stringify(checkpoint, null, 2), 'utf-8');
  }

  /**
   * Load the latest turn checkpoint for a session.
   * Returns null if no checkpoint exists.
   */
  async load(sessionId: string): Promise<TurnCheckpoint | null> {
    const incomplete = await this.listIncomplete();

    // Filter to this session and pick the most recent one
    const sessionCheckpoints = incomplete
      .filter((cp) => cp.sessionId === sessionId)
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );

    return sessionCheckpoints.length > 0 ? sessionCheckpoints[0] : null;
  }

  /**
   * Remove a turn checkpoint after the turn completes successfully.
   */
  async clear(turnId: string): Promise<void> {
    try {
      const file = this.filePath(turnId);
      await fs.unlink(file);
    } catch {
      // Already gone — fine.
    }
  }

  /**
   * List all incomplete turn checkpoints (turns that never reached a
   * terminal state).  Sorted by timestamp descending.
   */
  async listIncomplete(): Promise<TurnCheckpoint[]> {
    try {
      const files = await fs.readdir(this.checkpointsDir);
      const checkpoints: TurnCheckpoint[] = [];

      for (const file of files) {
        if (!file.startsWith('turn-') || !file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(
            path.join(this.checkpointsDir, file),
            'utf-8',
          );
          const cp = JSON.parse(raw) as TurnCheckpoint;

          // Only keep truly incomplete turns (not COMPLETED / FAILED / CANCELLED)
          const terminalStates: TurnState[] = [
            TurnState.COMPLETED,
            TurnState.FAILED,
            TurnState.CANCELLED,
          ];
          if (
            cp.turnId &&
            cp.sessionId &&
            cp.state &&
            !terminalStates.includes(cp.state)
          ) {
            checkpoints.push(cp);
          }
        } catch {
          // Corrupt file — skip.
        }
      }

      return checkpoints.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
    } catch {
      return [];
    }
  }

  /**
   * Determine whether a completed tool should be re-executed on recovery.
   *
   * Rules:
   * - REPLAYABLE tools → always re-execute
   * - IDEMPOTENT tools → re-execute (the checkpoint just tells us it ran,
   *   but repeating is safe)
   * - NEVER_REPLAYED tools → skip — the result was already captured
   *
   * @returns true if the tool should be skipped (already executed + NEVER_REPLAYED).
   */
  shouldSkipTool(
    checkpoint: TurnCheckpoint,
    toolName: string,
    callId: string,
  ): boolean {
    const completed = checkpoint.completedTools.find(
      (t) => t.name === toolName && t.callId === callId,
    );
    if (!completed) return false;

    return completed.replayClass === ToolReplayClass.NEVER_REPLAYED;
  }

  /**
   * Build a human-readable summary of an incomplete turn for the user.
   */
  static formatForRecovery(cp: TurnCheckpoint): string {
    const lines: string[] = [];
    lines.push(`Turn: ${cp.turnId.slice(0, 16)}...`);
    lines.push(`  Session:  ${cp.sessionId.slice(0, 16)}...`);
    lines.push(`  State:    ${cp.state}`);
    lines.push(`  Timestamp: ${cp.timestamp}`);
    lines.push(`  Completed tools (${cp.completedTools.length}):`);
    for (const tool of cp.completedTools) {
      const replayLabel =
        tool.replayClass === ToolReplayClass.NEVER_REPLAYED
          ? ' 🔒'
          : tool.replayClass === ToolReplayClass.IDEMPOTENT
            ? ' ♻️'
            : '';
      lines.push(
        `    - ${tool.name} (${tool.callId.slice(0, 8)}...)${replayLabel}`,
      );
    }
    return lines.join('\n');
  }
}
