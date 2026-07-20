/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ClientToServer, ServerToClient } from 'otto-server';
import {
  askLocalPeerOtto,
  buildPeerOttoPrompt,
  normalizePeerOttoQuestion,
  type PeerOttoTransport,
} from './peerOttoRunner.js';

describe('真实企业 A2A 本机 Agent 执行器', () => {
  it('把员工问题和明确限定上下文交给真实 A2A Agent，而不是拼固定回复', () => {
    const prompt = buildPeerOttoPrompt('今天 15:00 能评审吗？', '今天有 3 项工作，15:00 有项目复盘。');
    expect(prompt).toContain('今天 15:00 能评审吗？');
    expect(prompt).toContain('15:00 有项目复盘');
    expect(prompt).toContain('强制禁用全部工具');
    expect(prompt).toContain('不能替员工做承诺');
  });

  it('双方 Otto 协商时明确比较发起方提案与接收方授权资料', () => {
    const prompt = buildPeerOttoPrompt(
      '为项目评审协商时间和合作计划',
      '日程：16:00 后有空。',
      {
        mode: 'consult',
        initiatorProposal: '发起方 Otto 建议 15:00 开会并先审接口。',
      },
    );
    expect(prompt).toContain('双方 Otto 协商');
    expect(prompt).toContain('发起方 Otto 提案');
    expect(prompt).toContain('15:00 开会');
    expect(prompt).toContain('16:00 后有空');
    expect(prompt).toContain('不能擅自承诺');
  });

  it('发起协商时由自己的 Otto 先基于本方授权资料形成提案', () => {
    const prompt = buildPeerOttoPrompt(
      '协商项目评审时间',
      '我的日程：15:00 有复盘，16:00 后可用。',
      { mode: 'consult_initiator' },
    );
    expect(prompt).toContain('协商的发起方 Otto');
    expect(prompt).toContain('形成一份有界提案');
    expect(prompt).toContain('16:00 后可用');
    expect(prompt).toContain('不要声称已经发送');
  });

  it('确认框与模型只使用同一份规范化问题，不发送未展示尾部', () => {
    const visible = '已展示问题'.repeat(300);
    const normalized = normalizePeerOttoQuestion(`  ${visible}未展示尾部  `);
    const prompt = buildPeerOttoPrompt(normalized, '无私有上下文');
    expect(normalized).toHaveLength(1200);
    expect(prompt).toContain(normalized);
    expect(prompt).not.toContain('未展示尾部');
  });

  it('创建隔离的 tool-free A2A 会话，等待服务端完成并自动回收后返回答案', async () => {
    const sent: ClientToServer[] = [];
    let handler: ((frame: ServerToClient) => void) | null = null;
    const transport: PeerOttoTransport = {
      isConnected: () => true,
      onFrame: (next) => {
        handler = next;
        return vi.fn();
      },
      send: (frame) => {
        sent.push(frame);
        if (frame.type === 'create_session') {
          handler?.({
            type: 'session_created',
            payload: {
              clientRequestId: frame.payload.clientRequestId!,
              session: {
                sessionId: 'a2a-local-session', source: 'local', title: 'A2A 自动协助',
                status: 'idle', agentProfileId: 'otto-enterprise-a2a',
                createdAt: 1, updatedAt: 1, messageCount: 0,
              },
            },
          });
        }
        if (frame.type === 'send_user_message') {
          handler?.({
            type: 'chat_chunk',
            payload: { sessionId: 'a2a-local-session', messageId: 'answer-1', delta: '15:00 ' },
          });
          handler?.({
            type: 'chat_complete',
            payload: {
              sessionId: 'a2a-local-session', messageId: 'answer-1',
              text: '15:00 有复盘，建议改约 16:00。', finishReason: 'stop',
            },
          });
        }
      },
    };

    await expect(askLocalPeerOtto({
      question: '15:00 能评审吗？',
      workContext: '15:00 有项目复盘。',
      transport,
      requestId: 'request-1',
      clientMessageId: 'message-1',
      timeoutMs: 1_000,
    })).resolves.toBe('15:00 有复盘，建议改约 16:00。');

    expect(sent[0]).toEqual({
      type: 'create_session',
      payload: {
        title: 'A2A 自动协助',
        agentProfileId: 'otto-enterprise-a2a',
        clientRequestId: 'request-1',
      },
    });
    expect(sent).toContainEqual({
      type: 'subscribe',
      payload: { sessionId: 'a2a-local-session' },
    });
    expect(sent).toContainEqual({
      type: 'send_user_message',
      payload: expect.objectContaining({
        sessionId: 'a2a-local-session', source: 'local', clientMessageId: 'message-1',
      }),
    });
    expect(sent.some((frame) => frame.type === 'unsubscribe')).toBe(false);
    expect(sent.some((frame) => frame.type === 'delete_session')).toBe(false);
  });

  it('本机 Otto 未连接时明确失败，不发送伪造回答', async () => {
    const transport: PeerOttoTransport = {
      isConnected: () => false,
      onFrame: vi.fn(() => vi.fn()),
      send: vi.fn(),
    };
    await expect(askLocalPeerOtto({
      question: '可以帮忙吗？', workContext: '无', transport,
    })).rejects.toThrow('本机 Otto 未连接');
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('服务端错误会立即失败并清理，不等待超时', async () => {
    let handler: ((frame: ServerToClient) => void) | null = null;
    const transport: PeerOttoTransport = {
      isConnected: () => true,
      onFrame: (next) => { handler = next; return vi.fn(); },
      send: (frame) => {
        if (frame.type === 'create_session') {
          handler?.({
            type: 'error',
            payload: { code: 'no_model', message: '没有可用模型' },
          });
        }
      },
    };
    await expect(askLocalPeerOtto({
      question: '可以帮忙吗？', workContext: '无', transport, timeoutMs: 60_000,
    })).rejects.toThrow('没有可用模型');
  });

  it('登出或切换账号时取消正在运行的会话', async () => {
    let handler: ((frame: ServerToClient) => void) | null = null;
    const sent: ClientToServer[] = [];
    const controller = new AbortController();
    const transport: PeerOttoTransport = {
      isConnected: () => true,
      onFrame: (next) => { handler = next; return vi.fn(); },
      send: (frame) => {
        sent.push(frame);
        if (frame.type === 'create_session') {
          handler?.({
            type: 'session_created',
            payload: {
              clientRequestId: frame.payload.clientRequestId!,
              session: {
                sessionId: 'cancel-session', source: 'local', title: 'A2A 自动协助',
                status: 'idle', agentProfileId: 'otto-enterprise-a2a',
                createdAt: 1, updatedAt: 1, messageCount: 0,
              },
            },
          });
        }
      },
    };
    const pending = askLocalPeerOtto({
      question: '继续吗？', workContext: '无', transport, signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow('A2A 请求已取消');
    expect(sent.some((frame) => frame.type === 'unsubscribe')).toBe(false);
    expect(sent.some((frame) => frame.type === 'delete_session')).toBe(false);
  });
});
