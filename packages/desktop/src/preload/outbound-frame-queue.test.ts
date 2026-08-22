/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ClientToServer } from 'otto-server';
import {
  ReconnectFrameQueue,
  canQueueDisconnectedFrame,
} from './outbound-frame-queue.js';

const SAFE_READ_FRAME_TYPES = [
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
] as const satisfies ReadonlyArray<ClientToServer['type']>;

const STATE_CHANGING_FRAME_TYPES = [
  'hello',
  'subscribe',
  'unsubscribe',
  'create_session',
  'send_user_message',
  'tool_confirmation_response',
  'cancel',
  'set_model',
  'set_authorization_mode',
  'save_custom_model',
  'delete_custom_model',
  'delete_session',
  'rename_session',
  'set_setting',
  'save_search_config',
  'mcp_add',
  'mcp_remove',
  'run_doctor',
  'add_memory',
  'get_tools',
  'compress_context',
  'export_conversation',
  'add_knowledge',
  'remove_knowledge',
  'run_slash_command',
  'configure_enterprise',
  'switch_to_personal',
  'join_enterprise',
  'create_enterprise_invite',
  'add_friend',
  'accept_company_link',
  'scan_pending_auto_skills',
  'confirm_pending_auto_skill',
  'reject_pending_auto_skill',
  'create_schedule',
  'update_schedule',
  'delete_schedule',
] as const satisfies ReadonlyArray<ClientToServer['type']>;

function frameOfType(type: ClientToServer['type']): ClientToServer {
  return { type, payload: {} } as ClientToServer;
}

const ALL_FRAME_TYPES_ARE_CLASSIFIED: Exclude<
  ClientToServer['type'],
  | (typeof SAFE_READ_FRAME_TYPES)[number]
  | (typeof STATE_CHANGING_FRAME_TYPES)[number]
> extends never
  ? true
  : false = true;
const NO_FRAME_TYPE_HAS_CONFLICTING_CLASSIFICATION: Extract<
  (typeof SAFE_READ_FRAME_TYPES)[number],
  (typeof STATE_CHANGING_FRAME_TYPES)[number]
> extends never
  ? true
  : false = true;

describe('ReconnectFrameQueue', () => {
  it('classifies every current protocol frame exactly once', () => {
    expect(ALL_FRAME_TYPES_ARE_CLASSIFIED).toBe(true);
    expect(NO_FRAME_TYPE_HAS_CONFLICTING_CLASSIFICATION).toBe(true);
  });

  it.each(SAFE_READ_FRAME_TYPES)(
    'queues explicitly reviewed read-only %s frames',
    (type) => {
      const frame = frameOfType(type);
      const queue = new ReconnectFrameQueue();

      expect(canQueueDisconnectedFrame(frame)).toBe(true);
      expect(queue.enqueue(frame, 1)).toBe('queued');
      expect(queue.drain(1)).toEqual([frame]);
    },
  );

  it.each(STATE_CHANGING_FRAME_TYPES)(
    'never queues stale or state-changing %s frames',
    (type) => {
      const frame = frameOfType(type);
      const queue = new ReconnectFrameQueue();

      expect(canQueueDisconnectedFrame(frame)).toBe(false);
      expect(queue.enqueue(frame, 1)).toBe('rejected');
      expect(queue.size).toBe(0);
      expect(queue.drain(1)).toEqual([]);
    },
  );

  it('rejects unknown future protocol frames by default', () => {
    const frame = {
      type: 'future_state_changing_command',
      payload: {},
    } as unknown as ClientToServer;
    const queue = new ReconnectFrameQueue();

    expect(canQueueDisconnectedFrame(frame)).toBe(false);
    expect(queue.enqueue(frame, 1)).toBe('rejected');
    expect(queue.size).toBe(0);
    expect(queue.drain(1)).toEqual([]);
  });

  it('replays a fresh startup frame only in the same connection generation', () => {
    let now = 1_000;
    const queue = new ReconnectFrameQueue({ ttlMs: 10_000, now: () => now });
    const frame: ClientToServer = { type: 'list_sessions', payload: {} };

    expect(queue.enqueue(frame, 7)).toBe('queued');
    now += 9_999;
    expect(queue.drain(7)).toEqual([frame]);
    expect(queue.size).toBe(0);
  });

  it('drops frames at the expiry boundary instead of replaying old work', () => {
    let now = 2_000;
    const queue = new ReconnectFrameQueue({ ttlMs: 10_000, now: () => now });

    queue.enqueue({ type: 'get_models', payload: {} }, 3);
    now += 10_000;

    expect(queue.drain(3)).toEqual([]);
  });

  it('drops frames after a connection or endpoint generation changes', () => {
    const queue = new ReconnectFrameQueue();
    queue.enqueue({ type: 'list_sessions', payload: {} }, 4);

    expect(queue.drain(5)).toEqual([]);
  });

  it('bounds memory and retains only the newest startup frames', () => {
    const queue = new ReconnectFrameQueue({ maxFrames: 2 });
    const first: ClientToServer = { type: 'list_sessions', payload: {} };
    const second: ClientToServer = { type: 'get_models', payload: {} };
    const third: ClientToServer = { type: 'get_settings', payload: {} };

    queue.enqueue(first, 1);
    queue.enqueue(second, 1);
    queue.enqueue(third, 1);

    expect(queue.size).toBe(2);
    expect(queue.drain(1)).toEqual([second, third]);
  });

  it('clears pending frames on logout, suspend, or explicit disconnect', () => {
    const queue = new ReconnectFrameQueue();
    queue.enqueue({ type: 'list_sessions', payload: {} }, 1);

    queue.clear();

    expect(queue.size).toBe(0);
    expect(queue.drain(1)).toEqual([]);
  });

  it.each([
    { maxFrames: 0 },
    { ttlMs: 0 },
    { maxFrames: 1.5 },
  ])('rejects an invalid queue policy %#', (options) => {
    expect(
      () => new ReconnectFrameQueue(options),
    ).toThrow('reconnect frame queue policy is invalid');
  });
});
