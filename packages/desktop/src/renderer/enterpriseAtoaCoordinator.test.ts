/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { buildAtoaRequest, parseAtoaMessage } from './atoaProtocol.js';
import { processEnterpriseAtoaRequest } from './enterpriseAtoaCoordinator.js';

const inboxRequest = (content: string) => ({
  id: 'direct-message-1',
  senderAccountId: 'peer-1',
  recipientAccountId: 'me',
  peerAccountId: 'peer-1',
  peer: {
    id: 'peer-1',
    username: 'alice',
    name: 'Alice',
    department: '产品部',
    positionTitle: '产品经理',
    role: 'member',
  },
  content,
  createdAt: '2026-07-20T00:00:00.000Z',
  readAt: null,
});

describe('企业 A2A 请求协调器', () => {
  it('拒绝时不读取任何资料、不调用模型，并发出明确拒绝回执', async () => {
    const collectContext = vi.fn();
    const askOtto = vi.fn();
    const sendMessage = vi.fn(
      async (_peerAccountId: string, _content: string) => undefined,
    );
    const status = await processEnterpriseAtoaRequest({
      request: inboxRequest(buildAtoaRequest('能帮我吗？', 'req-1')),
      requestPermission: vi.fn(async () => ({ kind: 'deny' as const })),
      authorizeOnce: vi.fn(async () => ({
        grantDigest: 'a'.repeat(64),
        allowedSources: [],
        authorizedMessageIds: [],
      })),
      collectContext,
      askOtto,
      sendMessage,
    });

    expect(status).toBe('denied');
    expect(collectContext).not.toHaveBeenCalled();
    expect(askOtto).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
    const response = parseAtoaMessage(sendMessage.mock.calls[0][1]);
    expect(response).toMatchObject({
      kind: 'response',
      payload: { mode: 'answer', grantedSources: [] },
    });
    expect(response?.kind === 'response' && response.payload.answer).toContain(
      '未授权',
    );
  });

  it('协商时只收集接收方勾选范围，并让第二个 Otto 比较发起方提案', async () => {
    const request = inboxRequest(
      buildAtoaRequest('协商明天的评审时间', {
        id: 'req-consult',
        mode: 'consult',
        requestedSources: ['current_chat', 'schedules'],
        initiatorProposal: '发起方 Otto 建议明天 15:00。',
      }),
    );
    const collectContext = vi.fn(async () => ({
      context: '接收方日程：明天 16:00 后有空。',
      loadedSources: ['schedules' as const],
      failedSources: [],
    }));
    const askOtto = vi.fn(async () => '双方可考虑明天 16:30，仍需本人确认。');
    const sendMessage = vi.fn(
      async (_peerAccountId: string, _content: string) => undefined,
    );

    const status = await processEnterpriseAtoaRequest({
      request,
      requestPermission: vi.fn(async ({ peer, payload }) => {
        expect(peer.name).toBe('Alice');
        expect(payload.mode).toBe('consult');
        return { kind: 'allow' as const, sources: ['schedules' as const] };
      }),
      authorizeOnce: vi.fn(async () => ({
        grantDigest: 'b'.repeat(64),
        allowedSources: ['schedules' as const],
        authorizedMessageIds: [],
      })),
      collectContext,
      askOtto,
      sendMessage,
    });

    expect(status).toBe('answered');
    expect(collectContext).toHaveBeenCalledWith(['schedules'], []);
    expect(askOtto).toHaveBeenCalledWith({
      question: '协商明天的评审时间',
      workContext: '接收方日程：明天 16:00 后有空。',
      mode: 'consult',
      initiatorProposal: '发起方 Otto 建议明天 15:00。',
    });
    const response = parseAtoaMessage(sendMessage.mock.calls[0][1]);
    expect(response).toMatchObject({
      kind: 'response',
      payload: {
        mode: 'consult',
        grantedSources: ['schedules'],
        answer: '双方可考虑明天 16:30，仍需本人确认。',
      },
    });
  });

  it('模型失败时发出一次真实失败回执，避免重复弹窗和重复扣费', async () => {
    const sendMessage = vi.fn(
      async (_peerAccountId: string, _content: string) => undefined,
    );
    const collectContext = vi.fn(async () => ({
      context: '',
      loadedSources: [],
      failedSources: [],
    }));
    const status = await processEnterpriseAtoaRequest({
      request: inboxRequest(buildAtoaRequest('给我结论', 'req-fail')),
      requestPermission: vi.fn(async () => ({
        kind: 'allow' as const,
        sources: ['current_chat' as const],
        messageIds: ['message-authorized'],
      })),
      authorizeOnce: vi.fn(async () => ({
        grantDigest: 'd'.repeat(64),
        allowedSources: [],
        authorizedMessageIds: [],
      })),
      collectContext,
      askOtto: vi.fn(async () => {
        throw new Error('没有模型');
      }),
      sendMessage,
    });
    expect(status).toBe('failed');
    expect(collectContext).toHaveBeenCalledWith([], []);
    const response = parseAtoaMessage(sendMessage.mock.calls[0][1]);
    expect(response?.kind === 'response' && response.payload.answer).toContain(
      '未能完成',
    );
  });

  it('普通消息或损坏协议不会触发权限请求', async () => {
    const requestPermission = vi.fn();
    const sendMessage = vi.fn();
    await expect(
      processEnterpriseAtoaRequest({
        request: inboxRequest('普通消息'),
        requestPermission,
        authorizeOnce: vi.fn(async () => ({
          grantDigest: 'c'.repeat(64),
          allowedSources: [],
          authorizedMessageIds: [],
        })),
        collectContext: vi.fn(),
        askOtto: vi.fn(),
        sendMessage,
      }),
    ).resolves.toBe('ignored');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
