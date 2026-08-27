/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { ClientToServer } from 'otto-server';

export const OUTBOUND_QUEUE_MAX_FRAMES = 64;
export const OUTBOUND_QUEUE_TTL_MS = 10_000;

/**
 * Only idempotent, read-only snapshots may survive a transient transport
 * break. Keep this as an allowlist: a newly added protocol command must be
 * reviewed explicitly before it can ever be replayed after reconnect.
 *
 * Deliberately excluded even though they may look harmless:
 * - hello: the socket lifecycle owns the handshake;
 * - subscribe/unsubscribe: they mutate connection state and stale ordering can
 *   cancel or duplicate the renderer's current subscription;
 * - run_doctor/export_conversation: they may perform I/O;
 * - every create/save/set/add/remove/delete/run/scan/confirm/cancel command.
 */
const RECONNECT_SAFE_READ_FRAME_TYPES = new Set<ClientToServer['type']>([
  'list_sessions',
  'get_history',
  'get_product_workspace',
  'get_pending_auto_skills',
  'get_schedules',
  'get_models',
  'get_settings',
  'get_search_config',
  'mcp_list',
  'get_context_breakdown',
  'get_stats',
  'get_todos',
  'get_memory',
  'get_skills',
  'get_workflows',
  'get_extensions',
  'get_ide_status',
  'get_knowledge',
  'search_knowledge',
  'list_slash_commands',
]);

interface QueuedOutboundFrame {
  frame: ClientToServer;
  queuedAt: number;
  connectionGeneration: number;
}

export interface ReconnectFrameQueueOptions {
  maxFrames?: number;
  ttlMs?: number;
  now?: () => number;
}

export type ReconnectFrameEnqueueResult = 'queued' | 'rejected';

/**
 * Unknown and state-changing frames fail closed. The user has to repeat an
 * action after the UI reports a live connection again; only explicitly
 * reviewed read snapshots are eligible for the short reconnect queue.
 */
export function canQueueDisconnectedFrame(frame: ClientToServer): boolean {
  return RECONNECT_SAFE_READ_FRAME_TYPES.has(frame.type);
}

/**
 * Short-lived compatibility queue for explicitly allowlisted read frames.
 * Expiry is an additional safety boundary; callers must not treat queuing as a
 * delivery guarantee.
 *
 * It is intentionally bounded, expires entries, and binds every frame to the
 * current logical connection. Endpoint changes, logout/suspend, or a new
 * connection generation cannot replay frames accepted by an older context.
 */
export class ReconnectFrameQueue {
  private readonly maxFrames: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private entries: QueuedOutboundFrame[] = [];

  constructor(options: ReconnectFrameQueueOptions = {}) {
    this.maxFrames = options.maxFrames ?? OUTBOUND_QUEUE_MAX_FRAMES;
    this.ttlMs = options.ttlMs ?? OUTBOUND_QUEUE_TTL_MS;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.maxFrames) ||
      this.maxFrames < 1 ||
      !Number.isSafeInteger(this.ttlMs) ||
      this.ttlMs < 1
    ) {
      throw new Error('reconnect frame queue policy is invalid');
    }
  }

  enqueue(
    frame: ClientToServer,
    connectionGeneration: number,
  ): ReconnectFrameEnqueueResult {
    if (!canQueueDisconnectedFrame(frame)) return 'rejected';
    this.prune(this.now(), connectionGeneration);
    while (this.entries.length >= this.maxFrames) this.entries.shift();
    this.entries.push({
      frame,
      queuedAt: this.now(),
      connectionGeneration,
    });
    return 'queued';
  }

  drain(connectionGeneration: number): ClientToServer[] {
    const now = this.now();
    const ready = this.entries
      .filter(
        (entry) =>
          entry.connectionGeneration === connectionGeneration &&
          now - entry.queuedAt < this.ttlMs,
      )
      .map((entry) => entry.frame);
    this.entries = [];
    return ready;
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }

  private prune(now: number, connectionGeneration: number): void {
    this.entries = this.entries.filter(
      (entry) =>
        entry.connectionGeneration === connectionGeneration &&
        now - entry.queuedAt < this.ttlMs,
    );
  }
}
