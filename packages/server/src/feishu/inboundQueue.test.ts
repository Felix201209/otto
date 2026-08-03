/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FeishuInboundQueue } from './inboundQueue.js';

const tempDirs: string[] = [];

function pathForTest(): string {
  const dir = mkdtempSync(join(tmpdir(), 'otto-feishu-inbox-'));
  tempDirs.push(dir);
  return join(dir, 'queue.json');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function enqueue(queue: FeishuInboundQueue, eventId = 'om_event_1'): void {
  queue.enqueue({
    eventId,
    chatId: 'oc_chat',
    sessionId: 'session_feishu',
    sessionMessageId: `msg_${eventId}`,
    replyToMessageId: eventId,
  }, 1_000);
}

function enqueueForSession(
  queue: FeishuInboundQueue,
  eventId: string,
  sessionId: string,
  now: number,
): void {
  queue.enqueue({
    eventId,
    chatId: `chat_${sessionId}`,
    sessionId,
    sessionMessageId: `msg_${eventId}`,
    replyToMessageId: eventId,
  }, now);
}

describe('Feishu durable inbound queue', () => {
  it('persists routing state without duplicating message content', () => {
    const filePath = pathForTest();
    const queue = new FeishuInboundQueue(filePath);
    enqueue(queue);

    const raw = readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('prompt');
    expect(raw).not.toContain('hello otto');
    expect(new FeishuInboundQueue(filePath).nextDue(1_000)).toMatchObject({
      eventId: 'om_event_1',
      status: 'queued',
    });
  });

  it('recovers an interrupted running task after restart', () => {
    const filePath = pathForTest();
    const queue = new FeishuInboundQueue(filePath);
    enqueue(queue);
    queue.markRunning('om_event_1', 2_000);

    const restored = new FeishuInboundQueue(filePath);
    expect(restored.nextDue(Number.MAX_SAFE_INTEGER)).toMatchObject({
      eventId: 'om_event_1',
      status: 'queued',
      lastError: expect.stringContaining('restarted'),
    });
  });

  it('deduplicates completed events and retries failures with backoff', () => {
    const filePath = pathForTest();
    const queue = new FeishuInboundQueue(filePath);
    enqueue(queue);
    queue.markRunning('om_event_1', 2_000);
    const failed = queue.markFailed('om_event_1', new Error('temporary failure'), 8, 3_000);
    expect(failed.nextAttemptAtMs).toBeGreaterThan(3_000);
    expect(queue.nextDue(3_000)).toBeUndefined();
    expect(queue.nextDue(failed.nextAttemptAtMs!)).toMatchObject({ status: 'failed' });
    queue.markCompleted('om_event_1', 4_000);
    expect(queue.enqueue({
      eventId: 'om_event_1',
      chatId: 'oc_chat',
      sessionId: 'session_feishu',
      sessionMessageId: 'msg_duplicate',
      replyToMessageId: 'om_event_1',
    }, 5_000)).toMatchObject({ inserted: false });
  });

  it('turns repeatedly failing work into a visible dead-letter record', () => {
    const filePath = pathForTest();
    const queue = new FeishuInboundQueue(filePath);
    enqueue(queue);
    queue.markRunning('om_event_1', 2_000);
    expect(queue.markFailed('om_event_1', 'permanent failure', 1, 3_000))
      .toMatchObject({ status: 'dead', nextAttemptAtMs: null });
    expect(queue.summary()).toMatchObject({
      dead: 1,
      lastError: 'permanent failure',
    });
  });

  it('keeps strict ordering per session without blocking other sessions', () => {
    const queue = new FeishuInboundQueue(null);
    enqueueForSession(queue, 'om_a1', 'session_a', 1_000);
    enqueueForSession(queue, 'om_a2', 'session_a', 2_000);
    enqueueForSession(queue, 'om_b1', 'session_b', 3_000);

    expect(queue.nextDue(4_000)?.eventId).toBe('om_a1');
    queue.markRunning('om_a1', 4_000);
    const failed = queue.markFailed('om_a1', 'retry later', 8, 4_000);

    // session_a 的第二条必须等待第一条重试成功，但 session_b 不受影响。
    expect(queue.nextDue(4_000)?.eventId).toBe('om_b1');
    queue.markRunning('om_b1', 4_000);
    queue.markCompleted('om_b1', 4_000);
    expect(queue.nextDue(4_000)).toBeUndefined();
    expect(queue.nextDue(failed.nextAttemptAtMs!)?.eventId).toBe('om_a1');
    queue.markRunning('om_a1', failed.nextAttemptAtMs!);
    queue.markCompleted('om_a1', failed.nextAttemptAtMs!);
    expect(queue.nextDue(failed.nextAttemptAtMs!)?.eventId).toBe('om_a2');
  });

  it('ignores malformed queue files instead of blocking server startup', () => {
    const filePath = pathForTest();
    writeFileSync(filePath, '{not-json', 'utf8');
    expect(() => new FeishuInboundQueue(filePath)).not.toThrow();
  });
});
