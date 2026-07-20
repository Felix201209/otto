/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ATOA_REQUEST_PREFIX,
  ATOA_RESPONSE_PREFIX,
  buildAtoaRequest,
  buildAtoaResponse,
  displayDirectMessageContent,
  parseAtoaMessage,
} from './atoaProtocol.js';

describe('企业 A2A 消息协议', () => {
  it('构造和解析请求，并限制问题长度', () => {
    const content = buildAtoaRequest(`  ${'问题'.repeat(800)}  `, 'request-1');
    const parsed = parseAtoaMessage(content);

    expect(content.startsWith(ATOA_REQUEST_PREFIX)).toBe(true);
    expect(parsed).toMatchObject({
      kind: 'request',
      payload: {
        v: 1,
        id: 'request-1',
      },
    });
    expect(parsed?.kind === 'request' && parsed.payload.question.length).toBe(1200);
    const display = displayDirectMessageContent(content);
    expect(display).toContain('等待对方确认后由其 Otto 回答');
    expect(display).not.toContain('本机工作数据');
  });

  it('回复使用服务端消息 id 对账，并在聊天里隐藏协议前缀', () => {
    const content = buildAtoaResponse({
      requestId: 'direct-message-1',
      question: '你今天方便开会吗？',
      answer: '建议先发一个 15:00 的候选时间。',
    });
    const parsed = parseAtoaMessage(content);

    expect(content.startsWith(ATOA_RESPONSE_PREFIX)).toBe(true);
    expect(parsed).toMatchObject({
      kind: 'response',
      payload: {
        requestId: 'direct-message-1',
        question: '你今天方便开会吗？',
        answer: '建议先发一个 15:00 的候选时间。',
      },
    });
    expect(displayDirectMessageContent(content)).toBe(
      '对方 Otto 回复：\n建议先发一个 15:00 的候选时间。',
    );
  });

  it('普通消息和损坏的协议消息不会被误判为 A2A', () => {
    expect(parseAtoaMessage('普通聊天消息')).toBeNull();
    expect(parseAtoaMessage(`${ATOA_REQUEST_PREFIX}{bad-json`)).toBeNull();
    expect(displayDirectMessageContent('普通聊天消息')).toBe('普通聊天消息');
  });
});
