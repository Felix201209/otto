/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MessageFactory,
  MessageType,
  MessageValidator,
  type RemoteMessage,
} from './remoteProtocol.js';

describe('remoteProtocol thinking messages', () => {
  describe('THOUGHT', () => {
    it('should create THOUGHT message with thoughtId / subject / description', () => {
      const message = MessageFactory.createThought(
        't_abc123',
        'Looking at code',
        'Tracing the WebSocket handler flow…',
      );

      expect(message.type).toBe(MessageType.THOUGHT);
      expect(message.payload).toEqual({
        thoughtId: 't_abc123',
        subject: 'Looking at code',
        description: 'Tracing the WebSocket handler flow…',
      });
      expect(typeof message.id).toBe('string');
      expect(typeof message.timestamp).toBe('number');
    });

    it('should validate as THOUGHT message', () => {
      const message = MessageFactory.createThought('t_x', 's', 'd');
      expect(MessageValidator.isThoughtMessage(message)).toBe(true);
      // Cross-type checks
      expect(MessageValidator.isReasoningChunkMessage(message)).toBe(false);
      expect(MessageValidator.isOutputMessage(message)).toBe(false);
    });

    it('should reject malformed THOUGHT in validator', () => {
      const bad: RemoteMessage = {
        id: 'x',
        type: MessageType.THOUGHT,
        // missing subject/description fields
        payload: { thoughtId: 't_1' } as never,
        timestamp: Date.now(),
      };
      expect(MessageValidator.isThoughtMessage(bad)).toBe(false);
    });
  });

  describe('REASONING_CHUNK', () => {
    it('should create chunk with isComplete=false', () => {
      const message = MessageFactory.createReasoningChunk(
        't_xyz',
        'Step 1: parse input.',
        false,
      );

      expect(message.type).toBe(MessageType.REASONING_CHUNK);
      expect(message.payload).toEqual({
        thoughtId: 't_xyz',
        text: 'Step 1: parse input.',
        isComplete: false,
      });
    });

    it('should create finalize chunk with empty text + isComplete=true', () => {
      const message = MessageFactory.createReasoningChunk('t_xyz', '', true);

      expect(message.payload.thoughtId).toBe('t_xyz');
      expect(message.payload.text).toBe('');
      expect(message.payload.isComplete).toBe(true);
    });

    it('should validate as REASONING_CHUNK message', () => {
      const message = MessageFactory.createReasoningChunk('t_x', 'hi', false);
      expect(MessageValidator.isReasoningChunkMessage(message)).toBe(true);
      expect(MessageValidator.isThoughtMessage(message)).toBe(false);
    });

    it('should reject malformed REASONING_CHUNK in validator', () => {
      const bad: RemoteMessage = {
        id: 'x',
        type: MessageType.REASONING_CHUNK,
        // isComplete missing
        payload: { thoughtId: 't_1', text: 'hi' } as never,
        timestamp: Date.now(),
      };
      expect(MessageValidator.isReasoningChunkMessage(bad)).toBe(false);
    });
  });

  describe('aggregation by thoughtId', () => {
    it('should preserve thoughtId across multiple chunks', () => {
      // 模拟客户端聚合：相同 thoughtId 的所有 chunk 累加成完整 reasoning
      const tid = 't_round_1';
      const chunks = [
        MessageFactory.createReasoningChunk(tid, 'Hello ', false),
        MessageFactory.createReasoningChunk(tid, 'world', false),
        MessageFactory.createReasoningChunk(tid, '!', false),
        MessageFactory.createReasoningChunk(tid, '', true), // finalize
      ];

      const buffer = chunks
        .filter((m) => !m.payload.isComplete)
        .map((m) => m.payload.text)
        .join('');

      expect(buffer).toBe('Hello world!');
      expect(chunks.every((m) => m.payload.thoughtId === tid)).toBe(true);
      expect(chunks[chunks.length - 1].payload.isComplete).toBe(true);
    });

    it('should support distinct thoughtIds across rounds', () => {
      // 每轮新生成 thoughtId，客户端可分段渲染
      const r1 = MessageFactory.createReasoningChunk('t_r1', 'a', false);
      const r2 = MessageFactory.createReasoningChunk('t_r2', 'b', false);
      expect(r1.payload.thoughtId).not.toBe(r2.payload.thoughtId);
    });
  });

  describe('MessageType registration', () => {
    it('should include THOUGHT and REASONING_CHUNK in MessageType enum', () => {
      expect(Object.values(MessageType)).toContain('thought');
      expect(Object.values(MessageType)).toContain('reasoning_chunk');
    });

    it('should pass generic isValidMessage check', () => {
      const t = MessageFactory.createThought('t_x', 's', 'd');
      const r = MessageFactory.createReasoningChunk('t_x', 'hi', false);
      expect(MessageValidator.isValidMessage(t)).toBe(true);
      expect(MessageValidator.isValidMessage(r)).toBe(true);
    });
  });
});
