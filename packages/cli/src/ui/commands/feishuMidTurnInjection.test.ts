/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the Feishu-side mid-turn injection drain helper. Covers:
 *   - empty queue → no-op
 *   - text-only messages are drained and their Promises resolved
 *   - messages with pendingImages / pendingFiles are SKIPPED (left in queue)
 *   - notify callback fires once per drained message (best-effort, async)
 *   - drained items are removed from the queue atomically
 *   - multiple drains in sequence (re-entrant-safe at the message level)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  drainChatQueueForMidTurnInjection,
  __testing_messageQueues,
} from './feishuCommand.js';
import type { FeishuMessage } from '../../services/feishu/gateway.js';

function makeMsg(overrides: Partial<FeishuMessage> & { text: string }): FeishuMessage {
  return {
    text: overrides.text,
    messageId: overrides.messageId ?? 'mid_default',
    chatId: overrides.chatId ?? 'chat_test',
    chatType: overrides.chatType ?? 'p2p',
    senderOpenId: overrides.senderOpenId ?? 'ou_x',
    mentions: overrides.mentions ?? [],
    messageType: overrides.messageType ?? 'text',
    pendingImages: overrides.pendingImages,
    pendingFiles: overrides.pendingFiles,
  };
}

function enqueue(chatId: string, msg: FeishuMessage) {
  const resolve = vi.fn();
  const reject = vi.fn();
  let queue = __testing_messageQueues.get(chatId);
  if (!queue) {
    queue = [];
    __testing_messageQueues.set(chatId, queue);
  }
  queue.push({ msg, resolve, reject });
  return { resolve, reject };
}

const CHAT_ID = 'chat_unit_test';

describe('drainChatQueueForMidTurnInjection', () => {
  beforeEach(() => {
    __testing_messageQueues.delete(CHAT_ID);
  });

  it('returns [] when the queue is empty', () => {
    expect(drainChatQueueForMidTurnInjection(CHAT_ID)).toEqual([]);
  });

  it('returns [] when no queue has been created for this chat', () => {
    expect(drainChatQueueForMidTurnInjection('never_used_chat_id')).toEqual([]);
  });

  it('drains text-only messages, resolves their Promises, and clears the queue', () => {
    const { resolve: r1 } = enqueue(CHAT_ID, makeMsg({ text: 'first追加' }));
    const { resolve: r2 } = enqueue(CHAT_ID, makeMsg({ text: '  second 追加  ' }));

    const drained = drainChatQueueForMidTurnInjection(CHAT_ID);

    expect(drained).toEqual(['first追加', 'second 追加']); // trim applied
    expect(r1).toHaveBeenCalledExactlyOnceWith(null);
    expect(r2).toHaveBeenCalledExactlyOnceWith(null);
    expect(__testing_messageQueues.get(CHAT_ID)).toEqual([]);
  });

  it('skips messages with pendingImages and leaves them in queue', () => {
    const { resolve: r1 } = enqueue(
      CHAT_ID,
      makeMsg({
        text: 'has image',
        pendingImages: [{ imageKey: 'img_1', placeholder: '[img1]' }],
      }),
    );
    const { resolve: r2 } = enqueue(CHAT_ID, makeMsg({ text: 'pure text' }));

    const drained = drainChatQueueForMidTurnInjection(CHAT_ID);

    expect(drained).toEqual(['pure text']);
    // image-bearing message NOT resolved, NOT drained
    expect(r1).not.toHaveBeenCalled();
    expect(r2).toHaveBeenCalledExactlyOnceWith(null);

    // Remaining queue still contains the image message exactly once
    const remaining = __testing_messageQueues.get(CHAT_ID)!;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].msg.text).toBe('has image');
  });

  it('skips messages with pendingFiles and leaves them in queue', () => {
    enqueue(
      CHAT_ID,
      makeMsg({
        text: 'attached doc',
        pendingFiles: [{ fileKey: 'f1', fileName: 'a.pdf', placeholder: '[a.pdf]' }],
      }),
    );
    const drained = drainChatQueueForMidTurnInjection(CHAT_ID);
    expect(drained).toEqual([]);
    expect(__testing_messageQueues.get(CHAT_ID)).toHaveLength(1);
  });

  it('skips messages whose text is empty/whitespace', () => {
    const { resolve: rEmpty } = enqueue(CHAT_ID, makeMsg({ text: '   ' }));
    const { resolve: rReal } = enqueue(CHAT_ID, makeMsg({ text: 'real' }));

    const drained = drainChatQueueForMidTurnInjection(CHAT_ID);

    expect(drained).toEqual(['real']);
    expect(rEmpty).not.toHaveBeenCalled();
    expect(rReal).toHaveBeenCalledExactlyOnceWith(null);
    expect(__testing_messageQueues.get(CHAT_ID)).toHaveLength(1);
  });

  it('invokes notify exactly once per drained message', async () => {
    enqueue(CHAT_ID, makeMsg({ text: 'a', messageId: 'm1' }));
    enqueue(CHAT_ID, makeMsg({ text: 'b', messageId: 'm2' }));
    enqueue(
      CHAT_ID,
      makeMsg({
        text: 'with image',
        pendingImages: [{ imageKey: 'k', placeholder: 'p' }],
      }),
    );

    const notify = vi.fn(async () => undefined);
    const drained = drainChatQueueForMidTurnInjection(CHAT_ID, notify);

    expect(drained).toEqual(['a', 'b']);
    // notify fires fire-and-forget; let the microtask flush
    await new Promise((r) => setTimeout(r, 0));
    expect(notify).toHaveBeenCalledTimes(2);
    const notifiedIds = notify.mock.calls.map((c) => (c[0] as any).msg.messageId);
    expect(notifiedIds.sort()).toEqual(['m1', 'm2']);
  });

  it('a notify rejection does not throw out of drain', async () => {
    enqueue(CHAT_ID, makeMsg({ text: 'a' }));
    const notify = vi.fn(async () => {
      throw new Error('feishu API down');
    });
    expect(() => drainChatQueueForMidTurnInjection(CHAT_ID, notify)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a second drain immediately after the first returns [] (idempotent on empty)', () => {
    enqueue(CHAT_ID, makeMsg({ text: 'one' }));
    expect(drainChatQueueForMidTurnInjection(CHAT_ID)).toEqual(['one']);
    expect(drainChatQueueForMidTurnInjection(CHAT_ID)).toEqual([]);
  });

  it('only touches the requested chat — other chats untouched', () => {
    enqueue(CHAT_ID, makeMsg({ text: 'mine' }));
    enqueue('other_chat', makeMsg({ text: 'theirs', chatId: 'other_chat' }));

    drainChatQueueForMidTurnInjection(CHAT_ID);

    const other = __testing_messageQueues.get('other_chat');
    expect(other).toHaveLength(1);
    expect(other![0].msg.text).toBe('theirs');

    // cleanup
    __testing_messageQueues.delete('other_chat');
  });
});
