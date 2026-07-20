/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ATOA_DIRECT_MESSAGE_MAX_LENGTH,
  ATOA_REQUEST_PREFIX,
  ATOA_RESPONSE_PREFIX,
  ATOA_CONTEXT_SOURCES,
  buildAtoaRequest,
  buildAtoaResponse,
  displayDirectMessageContent,
  parseAtoaMessage,
} from './atoaProtocol.js';

describe('企业 A2A 消息协议', () => {
  it('构造和解析请求，并限制问题长度', () => {
    const content = buildAtoaRequest(`  ${'问题'.repeat(800)}  `, {
      id: 'request-1',
      mode: 'answer',
      requestedSources: ['current_chat', 'work_logs'],
    });
    const parsed = parseAtoaMessage(content);

    expect(content.startsWith(ATOA_REQUEST_PREFIX)).toBe(true);
    expect(parsed).toMatchObject({
      kind: 'request',
      payload: {
        v: 1,
        id: 'request-1',
        mode: 'answer',
        requestedSources: ['current_chat', 'work_logs'],
      },
    });
    expect(parsed?.kind === 'request' && parsed.payload.question.length).toBe(1200);
    const display = displayDirectMessageContent(content);
    expect(display).toContain('等待对方明确选择资料范围或拒绝');
    expect(display).not.toContain('本机工作数据');
  });

  it('回复使用服务端消息 id 对账，并在聊天里隐藏协议前缀', () => {
    const content = buildAtoaResponse({
      requestId: 'direct-message-1',
      question: '你今天方便开会吗？',
      answer: '建议先发一个 15:00 的候选时间。',
      mode: 'consult',
      grantedSources: ['schedules'],
    });
    const parsed = parseAtoaMessage(content);

    expect(content.startsWith(ATOA_RESPONSE_PREFIX)).toBe(true);
    expect(parsed).toMatchObject({
      kind: 'response',
      payload: {
        requestId: 'direct-message-1',
        question: '你今天方便开会吗？',
        answer: '建议先发一个 15:00 的候选时间。',
        mode: 'consult',
        grantedSources: ['schedules'],
      },
    });
    expect(displayDirectMessageContent(content)).toBe(
      '双方 Otto 协商结果（已授权：日程）：\n建议先发一个 15:00 的候选时间。',
    );
  });

  it('双方协商请求携带发送方 Otto 的真实提案，并对字段做有界裁剪', () => {
    const content = buildAtoaRequest('比较双方日程', {
      id: 'consult-1',
      mode: 'consult',
      requestedSources: [...ATOA_CONTEXT_SOURCES, 'schedules'],
      initiatorProposal: `  ${'候选计划'.repeat(1000)}  `,
    });
    const parsed = parseAtoaMessage(content);

    expect(parsed).toMatchObject({
      kind: 'request',
      payload: {
        id: 'consult-1',
        mode: 'consult',
        requestedSources: [...ATOA_CONTEXT_SOURCES],
      },
    });
    expect(
      parsed?.kind === 'request' && parsed.payload.initiatorProposal?.length,
    ).toBeGreaterThan(0);
    expect(
      parsed?.kind === 'request' && parsed.payload.initiatorProposal?.length,
    ).toBeLessThan(4000);
    expect(content.length).toBeLessThanOrEqual(ATOA_DIRECT_MESSAGE_MAX_LENGTH);
    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(
      ATOA_DIRECT_MESSAGE_MAX_LENGTH,
    );
    expect(displayDirectMessageContent(content)).toContain('双方 Otto 协商');
  });

  it('按最终序列化结果动态裁剪请求和回复，字符串及 UTF-8 均不超过私聊上限', () => {
    const request = buildAtoaRequest(`  ${'问题\n'.repeat(1200)}  `, {
      id: 'boundary-request',
      mode: 'consult',
      requestedSources: [...ATOA_CONTEXT_SOURCES],
      initiatorProposal: `  ${'候选方案😀\n'.repeat(1200)}  `,
    });
    const response = buildAtoaResponse({
      requestId: 'boundary-response',
      question: `${'问题😀\n'.repeat(1200)}`,
      answer: `${'协商结论😀\n'.repeat(1200)}`,
      mode: 'consult',
      grantedSources: [...ATOA_CONTEXT_SOURCES],
    });

    for (const content of [request, response]) {
      expect(content.length).toBeLessThanOrEqual(
        ATOA_DIRECT_MESSAGE_MAX_LENGTH,
      );
      expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(
        ATOA_DIRECT_MESSAGE_MAX_LENGTH,
      );
      expect(parseAtoaMessage(content)).not.toBeNull();
    }

    const parsedRequest = parseAtoaMessage(request);
    expect(
      parsedRequest?.kind === 'request' &&
        parsedRequest.payload.initiatorProposal,
    ).toBeTruthy();
    const parsedResponse = parseAtoaMessage(response);
    expect(
      parsedResponse?.kind === 'response' && parsedResponse.payload.question,
    ).toBeTruthy();
    expect(
      parsedResponse?.kind === 'response' && parsedResponse.payload.answer,
    ).toBeTruthy();
  });

  it('兼容旧版请求和回复，但拒绝未知 mode、来源、超长或伪造字段', () => {
    const legacyRequest = `${ATOA_REQUEST_PREFIX}${JSON.stringify({
      v: 1,
      id: 'legacy-1',
      question: '旧版问题',
      createdAt: '2026-07-20T00:00:00.000Z',
    })}`;
    expect(parseAtoaMessage(legacyRequest)).toMatchObject({
      kind: 'request',
      payload: { mode: 'answer', requestedSources: [] },
    });

    for (const payload of [
      {
        v: 1,
        id: 'bad-mode',
        question: '问题',
        createdAt: '2026-07-20T00:00:00.000Z',
        mode: 'admin',
      },
      {
        v: 1,
        id: 'bad-source',
        question: '问题',
        createdAt: '2026-07-20T00:00:00.000Z',
        requestedSources: ['all_files'],
      },
      {
        v: 1,
        id: 'too-long',
        question: 'x'.repeat(1201),
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      {
        v: 1,
        id: '',
        question: '问题',
        createdAt: 'not-a-date',
      },
    ]) {
      expect(
        parseAtoaMessage(`${ATOA_REQUEST_PREFIX}${JSON.stringify(payload)}`),
      ).toBeNull();
    }
  });

  it('普通消息和损坏的协议消息不会被误判为 A2A', () => {
    expect(parseAtoaMessage('普通聊天消息')).toBeNull();
    expect(parseAtoaMessage(`${ATOA_REQUEST_PREFIX}{bad-json`)).toBeNull();
    expect(displayDirectMessageContent('普通聊天消息')).toBe('普通聊天消息');
  });
});
