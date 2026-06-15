/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';
import { GeminiEventType, type ServerGeminiStreamEvent, type Config } from 'otto-core';
import { RemoteSession } from './remoteSession.js';
import { MessageType, type RemoteMessage } from './remoteProtocol.js';

/**
 * RemoteSession Thought / Reasoning 事件转发测试
 *
 * 重点：
 * 1. Thought 事件 → THOUGHT 消息
 * 2. Reasoning 事件 → REASONING_CHUNK（isComplete=false）
 * 3. 同一轮所有 chunk 共享 thoughtId
 * 4. 收尾时（finalizeThought）发送 isComplete=true 空 chunk
 * 5. content 出现 / 新轮次 / clearSessionData / sendError 都会触发收尾
 */

// 创建一个最小可用的 WebSocket mock：捕获所有 send 调用
function createMockWebSocket(): { ws: WebSocket; sent: RemoteMessage[] } {
  const sent: RemoteMessage[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: (data: string) => {
      try {
        sent.push(JSON.parse(data) as RemoteMessage);
      } catch {
        // ignore non-JSON
      }
    },
  } as unknown as WebSocket;
  return { ws, sent };
}

// 最小 Config mock，仅满足构造时的访问
function createMockConfig(): Config {
  return {
    getMaxSessionTurns: () => 0,
    getApprovalMode: () => 'default',
    getHookSystem: () => ({ getEventHandler: () => null }),
  } as unknown as Config;
}

// 反射调用 private 方法
function invokePrivate<T = unknown>(target: unknown, method: string, ...args: unknown[]): T {
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== 'function') {
    throw new Error(`private method not found: ${method}`);
  }
  return (fn as (...a: unknown[]) => T).apply(target, args);
}

describe('RemoteSession thinking events', () => {
  let session: RemoteSession;
  let sent: RemoteMessage[];

  beforeEach(() => {
    const mock = createMockWebSocket();
    sent = mock.sent;
    session = new RemoteSession(mock.ws, createMockConfig(), 'test-session');
  });

  describe('Thought event → THOUGHT message', () => {
    it('forwards subject + description with a generated thoughtId', async () => {
      const event: ServerGeminiStreamEvent = {
        type: GeminiEventType.Thought,
        value: {
          subject: 'Looking at code',
          description: 'Analysing the WebSocket flow',
        },
      };

      await invokePrivate(session, 'handleOtherEvent', event);

      const msgs = sent.filter((m) => m.type === MessageType.THOUGHT);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].payload.subject).toBe('Looking at code');
      expect(msgs[0].payload.description).toBe('Analysing the WebSocket flow');
      expect(typeof msgs[0].payload.thoughtId).toBe('string');
      expect(msgs[0].payload.thoughtId.length).toBeGreaterThan(0);
      expect(msgs[0].sessionId).toBe('test-session');
    });

    it('reuses the same thoughtId across consecutive Thought events', async () => {
      const e1: ServerGeminiStreamEvent = {
        type: GeminiEventType.Thought,
        value: { subject: 'A', description: 'a' },
      };
      const e2: ServerGeminiStreamEvent = {
        type: GeminiEventType.Thought,
        value: { subject: 'B', description: 'b' },
      };

      await invokePrivate(session, 'handleOtherEvent', e1);
      await invokePrivate(session, 'handleOtherEvent', e2);

      const ids = sent
        .filter((m) => m.type === MessageType.THOUGHT)
        .map((m) => m.payload.thoughtId);
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(ids[1]);
    });
  });

  describe('Reasoning event → REASONING_CHUNK message', () => {
    it('emits chunk with isComplete=false', async () => {
      const event: ServerGeminiStreamEvent = {
        type: GeminiEventType.Reasoning,
        value: { text: 'Step 1: parse input.' },
      };

      await invokePrivate(session, 'handleOtherEvent', event);

      const chunks = sent.filter((m) => m.type === MessageType.REASONING_CHUNK);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].payload.text).toBe('Step 1: parse input.');
      expect(chunks[0].payload.isComplete).toBe(false);
      expect(typeof chunks[0].payload.thoughtId).toBe('string');
    });

    it('skips empty reasoning text but does not break the flow', async () => {
      const empty: ServerGeminiStreamEvent = {
        type: GeminiEventType.Reasoning,
        value: { text: '' },
      };
      await invokePrivate(session, 'handleOtherEvent', empty);

      const chunks = sent.filter((m) => m.type === MessageType.REASONING_CHUNK);
      // 空 text 不应作为正常 chunk 发出
      expect(chunks).toHaveLength(0);
    });

    it('preserves thoughtId across consecutive Reasoning chunks', async () => {
      for (let i = 0; i < 3; i++) {
        await invokePrivate(session, 'handleOtherEvent', {
          type: GeminiEventType.Reasoning,
          value: { text: `chunk ${i}` },
        } as ServerGeminiStreamEvent);
      }

      const chunks = sent.filter((m) => m.type === MessageType.REASONING_CHUNK);
      expect(chunks).toHaveLength(3);
      const ids = new Set(chunks.map((m) => m.payload.thoughtId));
      expect(ids.size).toBe(1); // 同一轮共享
      // 客户端聚合后能拿到完整文本
      const aggregated = chunks
        .filter((m) => !m.payload.isComplete)
        .map((m) => m.payload.text)
        .join('');
      expect(aggregated).toBe('chunk 0chunk 1chunk 2');
    });

    it('mixed Thought and Reasoning share the same thoughtId in one round', async () => {
      await invokePrivate(session, 'handleOtherEvent', {
        type: GeminiEventType.Thought,
        value: { subject: 'Plan', description: 'Plan it out' },
      } as ServerGeminiStreamEvent);
      await invokePrivate(session, 'handleOtherEvent', {
        type: GeminiEventType.Reasoning,
        value: { text: 'detail' },
      } as ServerGeminiStreamEvent);

      const allIds = sent
        .filter(
          (m) =>
            m.type === MessageType.THOUGHT ||
            m.type === MessageType.REASONING_CHUNK,
        )
        .map((m) => m.payload.thoughtId);
      expect(new Set(allIds).size).toBe(1);
    });
  });

  describe('finalizeThought collapses the round', () => {
    it('emits isComplete=true with empty text', async () => {
      // 先发出 reasoning，然后调用 finalizeThought
      await invokePrivate(session, 'handleOtherEvent', {
        type: GeminiEventType.Reasoning,
        value: { text: 'x' },
      } as ServerGeminiStreamEvent);
      const tidBefore = (
        sent.find((m) => m.type === MessageType.REASONING_CHUNK) as RemoteMessage
      ).payload.thoughtId;

      invokePrivate(session, 'finalizeThought');

      const closing = sent.filter(
        (m) =>
          m.type === MessageType.REASONING_CHUNK && m.payload.isComplete === true,
      );
      expect(closing).toHaveLength(1);
      expect(closing[0].payload.text).toBe('');
      expect(closing[0].payload.thoughtId).toBe(tidBefore);
    });

    it('is idempotent when no thought is in progress', () => {
      invokePrivate(session, 'finalizeThought');
      invokePrivate(session, 'finalizeThought');

      const closing = sent.filter(
        (m) =>
          m.type === MessageType.REASONING_CHUNK && m.payload.isComplete === true,
      );
      expect(closing).toHaveLength(0);
    });

    it('starts a fresh thoughtId after finalize', async () => {
      // round 1
      await invokePrivate(session, 'handleOtherEvent', {
        type: GeminiEventType.Reasoning,
        value: { text: 'r1' },
      } as ServerGeminiStreamEvent);
      invokePrivate(session, 'finalizeThought');

      // round 2
      await invokePrivate(session, 'handleOtherEvent', {
        type: GeminiEventType.Reasoning,
        value: { text: 'r2' },
      } as ServerGeminiStreamEvent);

      const chunks = sent.filter(
        (m) =>
          m.type === MessageType.REASONING_CHUNK && !m.payload.isComplete,
      );
      expect(chunks).toHaveLength(2);
      expect(chunks[0].payload.thoughtId).not.toBe(chunks[1].payload.thoughtId);
    });
  });

  describe('handleContentEvent finalizes the in-progress thought', () => {
    it('automatically closes thought when AI text starts arriving', async () => {
      await invokePrivate(session, 'handleOtherEvent', {
        type: GeminiEventType.Reasoning,
        value: { text: 'thinking' },
      } as ServerGeminiStreamEvent);

      // 模拟内容事件到来
      await invokePrivate(session, 'handleContentEvent', 'Hello');

      // 应该看到一个 isComplete=true 的收尾 chunk
      const closing = sent.filter(
        (m) =>
          m.type === MessageType.REASONING_CHUNK && m.payload.isComplete === true,
      );
      expect(closing).toHaveLength(1);

      // 应该有 OUTPUT 消息
      const outputs = sent.filter((m) => m.type === MessageType.OUTPUT);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].payload.content).toBe('Hello');
    });
  });

  describe('clearSessionData finalizes the in-progress thought', () => {
    it('emits isComplete=true on session clear', async () => {
      await invokePrivate(session, 'handleOtherEvent', {
        type: GeminiEventType.Reasoning,
        value: { text: 'partial' },
      } as ServerGeminiStreamEvent);

      session.clearSessionData();

      const closing = sent.filter(
        (m) =>
          m.type === MessageType.REASONING_CHUNK && m.payload.isComplete === true,
      );
      expect(closing).toHaveLength(1);
    });
  });

  describe('sendError finalizes the in-progress thought', () => {
    it('emits isComplete=true before ERROR + idle status', async () => {
      await invokePrivate(session, 'handleOtherEvent', {
        type: GeminiEventType.Reasoning,
        value: { text: 'partial' },
      } as ServerGeminiStreamEvent);

      invokePrivate(session, 'sendError', 'something failed');

      const types = sent.map((m) => m.type);
      // 顺序：先 reasoning chunk(false) → 收尾 chunk(true) → ERROR → STATUS(idle)
      const closingIdx = sent.findIndex(
        (m) =>
          m.type === MessageType.REASONING_CHUNK && m.payload.isComplete === true,
      );
      const errorIdx = types.indexOf(MessageType.ERROR);
      expect(closingIdx).toBeGreaterThanOrEqual(0);
      expect(errorIdx).toBeGreaterThanOrEqual(0);
      expect(closingIdx).toBeLessThan(errorIdx);
    });
  });

  describe('LoopDetected event finalizes the in-progress thought', () => {
    it('emits closing chunk before idle status when loop detected', async () => {
      // 先有思考
      await invokePrivate(session, 'handleOtherEvent', {
        type: GeminiEventType.Reasoning,
        value: { text: 'partial' },
      } as ServerGeminiStreamEvent);

      // 再触发 LoopDetected
      await invokePrivate(session, 'handleOtherEvent', {
        type: GeminiEventType.LoopDetected,
        value: 'consecutive_identical_tool_calls',
      } as ServerGeminiStreamEvent);

      const closingIdx = sent.findIndex(
        (m) =>
          m.type === MessageType.REASONING_CHUNK && m.payload.isComplete === true,
      );
      const idleIdx = sent.findIndex(
        (m) =>
          m.type === MessageType.STATUS && m.payload.status === 'idle',
      );
      expect(closingIdx).toBeGreaterThanOrEqual(0);
      expect(idleIdx).toBeGreaterThanOrEqual(0);
      expect(closingIdx).toBeLessThan(idleIdx);
    });
  });
});
