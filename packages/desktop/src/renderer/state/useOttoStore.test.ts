/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * applyFrame reducer 单测（renderer 状态心脏）。
 *
 * applyFrame / reducer / mergeTextDelta 是文件私有（不改源码 export），故通过
 * renderHook(useOttoStore) + mock transport 打帧的方式间接覆盖每个帧分支：
 *   mock 的 transport.onFrame 捕获 hook 注册的 frame handler，用 act() 调它推帧，
 *   再断言 result.current.state。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type {
  ServerToClient,
  SessionSummary,
  OttoMessage,
} from 'otto-server';

// ── mock transport：捕获 frame / connection handler，connect 立即 resolve(true) ──
let capturedHandler: ((f: ServerToClient) => void) | null = null;
let _capturedConnHandler: ((connected: boolean) => void) | null = null;
const sendSpy = vi.fn();
const usageSpy = vi.fn(async () => ({ recorded: true, source: 'client_reported' as const }));
const knowledgeSpy = vi.fn(async () => ({ status: 'added' as const, added: true }));
const organizationFeaturesSpy = vi.fn(async () => ({
  enterprise_tree: true,
  park_service: true,
  feishu_auto_reply: true,
  direct_messages: true,
  atoa: true,
  knowledge: true,
}));

vi.mock('../transport.js', () => ({
  connect: vi.fn(async () => true),
  send: (...args: unknown[]) => sendSpy(...args),
  onFrame: (handler: (f: ServerToClient) => void) => {
    capturedHandler = handler;
    return () => {
      capturedHandler = null;
    };
  },
  // 模拟 preload：注册时立即以「已连接」回调一次（onConnectionChange 契约）。
  onConnectionChange: (handler: (connected: boolean) => void) => {
    _capturedConnHandler = handler;
    handler(true);
    return () => {
      _capturedConnHandler = null;
    };
  },
  isConnected: () => true,
}));

import { useOttoStore } from './useOttoStore.js';
import { clearEnterpriseOrganizationFeaturesCache } from './enterpriseOrganizationFeatures.js';

/** 渲染 hook 并返回推帧函数 + result。 */
function setup(enterpriseOrganizationId?: string) {
  const view = renderHook(() => useOttoStore({ enterpriseOrganizationId }));
  const push = (frame: ServerToClient) => {
    act(() => {
      capturedHandler?.(frame);
    });
  };
  return { view, push };
}

function makeSession(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 's1',
    source: 'local',
    title: '会话',
    status: 'idle',
    createdAt: 1000,
    updatedAt: 1000,
    messageCount: 0,
    ...over,
  };
}

function makeMsg(over: Partial<OttoMessage> = {}): OttoMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'assistant',
    content: [{ type: 'text', value: '' }],
    timestamp: 1000,
    source: 'local',
    ...over,
  };
}

beforeEach(() => {
  capturedHandler = null;
  sendSpy.mockClear();
  usageSpy.mockReset();
  usageSpy.mockResolvedValue({ recorded: true, source: 'client_reported' });
  knowledgeSpy.mockReset();
  knowledgeSpy.mockResolvedValue({ status: 'added', added: true });
  organizationFeaturesSpy.mockReset();
  organizationFeaturesSpy.mockResolvedValue({
    enterprise_tree: true,
    park_service: true,
    feishu_auto_reply: true,
    direct_messages: true,
    atoa: true,
    knowledge: true,
  });
  clearEnterpriseOrganizationFeaturesCache();
  Object.defineProperty(window, 'otto', {
    configurable: true,
    value: {
      enterpriseUsageRecord: usageSpy,
      enterpriseKnowledgeRecord: knowledgeSpy,
      enterpriseOrganizationFeaturesGet: organizationFeaturesSpy,
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('applyFrame 各帧分支', () => {
  it('sessions_list：批量 upsert + 无选中时默认选第一个', async () => {
    const { view, push } = setup();
    push({
      type: 'sessions_list',
      payload: {
        sessions: [
          makeSession({ sessionId: 'a' }),
          makeSession({ sessionId: 'b' }),
        ],
      },
    });
    expect(view.result.current.state.sessionIds).toEqual(['a', 'b']);
    expect(view.result.current.state.activeSessionId).toBe('a');
  });

  it('sessions_list：选中仍在快照里则保持不动', () => {
    const { view, push } = setup();
    push({
      type: 'sessions_list',
      payload: { sessions: [makeSession({ sessionId: 'a' }), makeSession({ sessionId: 'b' })] },
    });
    expect(view.result.current.state.activeSessionId).toBe('a');
    // 第二份快照仍含 a → 选中保持不变（不因刷新而跳到别处）。
    push({
      type: 'sessions_list',
      payload: { sessions: [makeSession({ sessionId: 'b' }), makeSession({ sessionId: 'a' })] },
    });
    expect(view.result.current.state.activeSessionId).toBe('a');
  });

  it('sessions_list 是权威快照：快照里没有的会话被剔除（删除落地）', () => {
    const { view, push } = setup();
    push({
      type: 'sessions_list',
      payload: { sessions: [makeSession({ sessionId: 'a' }), makeSession({ sessionId: 'b' })] },
    });
    // 塞一条 b 的消息，验证删除后其消息缓存也被回收。
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'bm', sessionId: 'b' }) } });
    expect(view.result.current.state.messages['b']).toHaveLength(1);
    // 新快照只剩 a（b 被删）。
    push({ type: 'sessions_list', payload: { sessions: [makeSession({ sessionId: 'a' })] } });
    expect(view.result.current.state.sessionIds).toEqual(['a']);
    expect(view.result.current.state.sessions['b']).toBeUndefined();
    expect(view.result.current.state.messages['b']).toBeUndefined();
  });

  it('sessions_list：删掉当前选中会话 → 落到快照第一个', () => {
    const { view, push } = setup();
    push({
      type: 'sessions_list',
      payload: { sessions: [makeSession({ sessionId: 'a' }), makeSession({ sessionId: 'b' })] },
    });
    expect(view.result.current.state.activeSessionId).toBe('a'); // 默认选第一个
    // 删掉当前选中的 a：新快照只剩 b → active 落到 b。
    push({ type: 'sessions_list', payload: { sessions: [makeSession({ sessionId: 'b' })] } });
    expect(view.result.current.state.activeSessionId).toBe('b');
  });

  it('sessions_list：删光所有会话 → activeSessionId 置 null', () => {
    const { view, push } = setup();
    push({ type: 'sessions_list', payload: { sessions: [makeSession({ sessionId: 'a' })] } });
    expect(view.result.current.state.activeSessionId).toBe('a');
    push({ type: 'sessions_list', payload: { sessions: [] } });
    expect(view.result.current.state.activeSessionId).toBeNull();
    expect(view.result.current.state.sessionIds).toEqual([]);
    // 空快照仍标记为已加载（sessionsLoaded），供 App 引导 effect 判空建会话。
    expect(view.result.current.state.sessionsLoaded).toBe(true);
  });

  it('session_upsert：新增不重复 / 更新已存在', () => {
    const { view, push } = setup();
    push({ type: 'session_upsert', payload: { session: makeSession({ sessionId: 'a', title: 'T1' }) } });
    push({ type: 'session_upsert', payload: { session: makeSession({ sessionId: 'a', title: 'T2' }) } });
    expect(view.result.current.state.sessionIds).toEqual(['a']); // 不重复
    expect(view.result.current.state.sessions['a'].title).toBe('T2'); // 更新
  });

  it('session_created：忽略内部 A2A 临时会话，且不清除用户自己的待创建请求', () => {
    const { view, push } = setup();
    act(() => view.result.current.actions.createSession('用户会话'));
    const pendingRequestId = view.result.current.state.pendingCreateRequestId;
    expect(pendingRequestId).toBeTruthy();

    push({
      type: 'session_created',
      payload: {
        clientRequestId: 'a2a-internal-request',
        session: makeSession({
          sessionId: 'a2a-internal-session',
          agentProfileId: 'otto-enterprise-a2a',
        }),
      },
    });

    expect(view.result.current.state.sessionIds).not.toContain('a2a-internal-session');
    expect(view.result.current.state.sessions['a2a-internal-session']).toBeUndefined();
    expect(view.result.current.state.pendingCreateRequestId).toBe(pendingRequestId);
    expect(view.result.current.state.activeSessionId).toBeNull();
  });

  it('history：整列替换该 session 消息', () => {
    const { view, push } = setup();
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'old' }) } });
    push({
      type: 'history',
      payload: { sessionId: 's1', messages: [makeMsg({ id: 'h1' }), makeMsg({ id: 'h2' })] },
    });
    expect(view.result.current.state.messages['s1'].map((m) => m.id)).toEqual(['h1', 'h2']);
  });

  it('history：server 返回截断历史时保留更完整的本地缓存并对账同 id 消息', () => {
    const { view, push } = setup();
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'h1', content: [{ type: 'text', value: 'local-old' }] }) } });
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'h2' }) } });
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'h3' }) } });
    push({
      type: 'history',
      payload: {
        sessionId: 's1',
        messages: [makeMsg({ id: 'h1', content: [{ type: 'text', value: 'server-new' }] })],
      },
    });
    const messages = view.result.current.state.messages['s1'];
    expect(messages.map((message) => message.id)).toEqual(['h1', 'h2', 'h3']);
    expect(messages[0].content[0]).toEqual({ type: 'text', value: 'server-new' });
  });

  it('message_start：append + 相同 id 覆盖（流式占位→定稿对账）', () => {
    const { view, push } = setup();
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'm1', content: [{ type: 'text', value: 'v1' }] }) } });
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'm1', content: [{ type: 'text', value: 'v2' }] }) } });
    const list = view.result.current.state.messages['s1'];
    expect(list).toHaveLength(1); // 同 id 覆盖，不追加
    expect(list[0].content[0]).toEqual({ type: 'text', value: 'v2' });
  });

  it('chat_chunk：mergeTextDelta 把 delta 并进末尾 text 片段 + isStreaming', () => {
    const { view, push } = setup();
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'm1', content: [{ type: 'text', value: 'Hello' }] }) } });
    push({ type: 'chat_chunk', payload: { sessionId: 's1', messageId: 'm1', delta: ' world' } });
    const m = view.result.current.state.messages['s1'][0];
    expect(m.content).toEqual([{ type: 'text', value: 'Hello world' }]);
    expect(m.isStreaming).toBe(true);
  });

  it('chat_chunk：空 content 时起首段', () => {
    const { view, push } = setup();
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'm1', content: [] }) } });
    push({ type: 'chat_chunk', payload: { sessionId: 's1', messageId: 'm1', delta: 'X' } });
    expect(view.result.current.state.messages['s1'][0].content).toEqual([{ type: 'text', value: 'X' }]);
  });

  it('chat_chunk：末尾非 text 时新起一段', () => {
    const { view, push } = setup();
    push({
      type: 'message_start',
      payload: {
        message: makeMsg({
          id: 'm1',
          content: [
            {
              type: 'image_reference',
              value: { id: 'i', fileName: 'a.png', data: '', mimeType: 'image/png', originalSize: 0, compressedSize: 0 },
            },
          ],
        }),
      },
    });
    push({ type: 'chat_chunk', payload: { sessionId: 's1', messageId: 'm1', delta: 'txt' } });
    const content = view.result.current.state.messages['s1'][0].content;
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: 'text', value: 'txt' });
  });

  it('chat_reasoning：累加 reasoning', () => {
    const { view, push } = setup();
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'm1' }) } });
    push({ type: 'chat_reasoning', payload: { sessionId: 's1', messageId: 'm1', delta: '想' } });
    push({ type: 'chat_reasoning', payload: { sessionId: 's1', messageId: 'm1', delta: '法' } });
    const m = view.result.current.state.messages['s1'][0];
    expect(m.reasoning).toBe('想法');
    expect(m.isReasoning).toBe(true);
  });

  it('chat_complete：isStreaming/isReasoning=false，tokenUsage 有则覆盖', () => {
    const { view, push } = setup();
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'm1', isStreaming: true, isReasoning: true }) } });
    push({
      type: 'chat_complete',
      payload: {
        sessionId: 's1',
        messageId: 'm1',
        tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    });
    const m = view.result.current.state.messages['s1'][0];
    expect(m.isStreaming).toBe(false);
    expect(m.isReasoning).toBe(false);
    expect(m.tokenUsage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it('chat_complete：将当前登录会话的 provider Token 用量异步上报', () => {
    const { push } = setup();
    push({
      type: 'session_upsert',
      payload: { session: makeSession({ sessionId: 's1', model: 'deepseek-v4-pro' }) },
    });
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'm1' }) } });
    push({
      type: 'chat_complete',
      payload: {
        sessionId: 's1',
        messageId: 'm1',
        tokenUsage: {
          inputTokens: 11, outputTokens: 22, totalTokens: 33, model: 'provider-model-id',
        },
      },
    });

    expect(usageSpy).toHaveBeenCalledWith({
      sessionId: 's1',
      messageId: 'm1',
      model: 'provider-model-id',
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 33,
    });
  });

  it('Token 上报失败不阻断 chat_complete 收口，也不污染对话错误状态', () => {
    usageSpy.mockRejectedValueOnce(new Error('企业用量服务暂不可用'));
    const { view, push } = setup();
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'm1', isStreaming: true }) } });
    push({
      type: 'chat_complete',
      payload: {
        sessionId: 's1',
        messageId: 'm1',
        tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    });

    expect(view.result.current.state.messages['s1'][0].isStreaming).toBe(false);
    expect(view.result.current.state.messages['s1'][0].tokenUsage?.totalTokens).toBe(3);
    expect(view.result.current.state.lastError).toBeNull();
  });

  it('knowledge_activity 只把本次新捕获条目主动同步到已启用的组织知识库', async () => {
    const { push } = setup('org-enabled');
    push({
      type: 'knowledge_activity',
      payload: {
        action: 'auto_capture',
        sessionId: 's1',
        written: 1,
        captured: [{
          id: 'kb_123',
          category: 'solution',
          content: '合同审查先核对违约条款。',
          tags: ['contract'],
          createdAt: '2026-07-15T00:00:00.000Z',
          confidence: 0.9,
        }],
        recent: [{
          id: 'kb_old',
          category: 'preference',
          content: '旧条目不应重复同步',
          tags: [],
          createdAt: '2026-07-14T00:00:00.000Z',
        }],
      },
    } as ServerToClient);

    await waitFor(() => expect(knowledgeSpy).toHaveBeenCalledTimes(1));
    expect(knowledgeSpy).toHaveBeenCalledWith({
      sourceId: 'auto:s1:kb_123',
      sourceSessionId: 's1',
      sourceFingerprint: 'kb_123',
      category: 'solution',
      content: '合同审查先核对违约条款。',
      confidence: 0.9,
      sourceType: 'auto_capture',
      sourceLabel: 'Otto 对话知识观察',
      tags: ['contract'],
      verified: false,
      impactScore: 0.5,
      significanceSignals: [],
      observedAt: '2026-07-15T00:00:00.000Z',
    });
  });

  it('同步重复知识观察，让企业侧按跨会话证据晋级而不是保存整段对话', async () => {
    const { push } = setup('org-retention');
    push({
      type: 'knowledge_activity',
      payload: {
        action: 'auto_capture',
        sessionId: 'session-2',
        written: 0,
        captured: [],
        observations: [{
          category: 'solution',
          content: '根因是缓存键未包含企业编号。\n修复后跨企业缓存隔离测试通过。',
          tags: ['cache', 'tenant'],
          sourceSessionId: 'session-2',
          confidence: 0.91,
          fingerprint: 'fp-retained',
          verified: true,
          impactScore: 0.88,
          significanceSignals: ['successful_tool_result'],
          observedAt: '2026-07-30T00:00:00.000Z',
        }],
        recent: [],
      },
    } as ServerToClient);

    await waitFor(() => expect(knowledgeSpy).toHaveBeenCalledOnce());
    expect(knowledgeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'auto:session-2:fp-retained',
      sourceSessionId: 'session-2',
      sourceType: 'auto_capture',
      verified: true,
      impactScore: 0.88,
    }));
  });

  it('组织 knowledge=false 时保留个人本地捕获但不上传企业知识', async () => {
    organizationFeaturesSpy.mockResolvedValueOnce({
      enterprise_tree: true,
      park_service: true,
      feishu_auto_reply: true,
      direct_messages: true,
      atoa: true,
      knowledge: false,
    });
    const { view, push } = setup('org-disabled');
    push({
      type: 'knowledge_activity',
      payload: {
        action: 'auto_capture',
        sessionId: 's1',
        written: 1,
        captured: [{
          id: 'kb_local_only',
          category: 'solution',
          content: '这条仍然已经由 core 写入个人本地知识。',
          tags: [],
          createdAt: '2026-07-21T00:00:00.000Z',
        }],
        recent: [],
      },
    } as ServerToClient);

    await waitFor(() => expect(organizationFeaturesSpy).toHaveBeenCalledOnce());
    expect(knowledgeSpy).not.toHaveBeenCalled();
    expect(view.result.current.state.lastError).toBeNull();
  });

  it('chat_complete(cancelled)：工具执行阶段取消也清掉 isProcessingTools，停止按钮不再卡住', () => {
    const { view, push } = setup();
    push({
      type: 'message_start',
      payload: {
        message: makeMsg({
          id: 'm1',
          isStreaming: false,
          isProcessingTools: true,
          associatedToolCalls: [
            {
              id: 't1',
              toolName: 'edit',
              parameters: {},
              status: 'executing' as never,
              startTime: Date.now() - 20,
            },
          ],
        }),
      },
    });

    push({
      type: 'chat_complete',
      payload: {
        sessionId: 's1',
        messageId: 'm1',
        finishReason: 'cancelled',
        text: '已生成的部分',
      },
    });

    const m = view.result.current.state.messages['s1'][0];
    expect(m.isStreaming).toBe(false);
    expect(m.isReasoning).toBe(false);
    expect(m.isProcessingTools).toBe(false);
    expect(m.associatedToolCalls?.[0]?.status).toBe('cancelled');
  });

  it('chat_complete：无 tokenUsage 则保留旧值', () => {
    const { view, push } = setup();
    push({
      type: 'message_start',
      payload: { message: makeMsg({ id: 'm1', tokenUsage: { inputTokens: 9, outputTokens: 9, totalTokens: 18 } }) },
    });
    push({ type: 'chat_complete', payload: { sessionId: 's1', messageId: 'm1' } });
    expect(view.result.current.state.messages['s1'][0].tokenUsage).toEqual({
      inputTokens: 9,
      outputTokens: 9,
      totalTokens: 18,
    });
  });

  it('chat_complete：带 text 时覆盖 content 对账自愈（切走期间丢的 chunk 补齐）', () => {
    const { view, push } = setup();
    // 模拟切走再切回：本地 content 只有缺头的一截（切走期间的 delta 丢了）。
    push({
      type: 'message_start',
      payload: {
        message: makeMsg({
          id: 'm1',
          content: [{ type: 'text', value: '尾巴' }],
          isStreaming: true,
        }),
      },
    });
    push({
      type: 'chat_complete',
      payload: { sessionId: 's1', messageId: 'm1', text: '完整开头+尾巴' },
    });
    const m = view.result.current.state.messages['s1'][0];
    expect(m.content).toEqual([{ type: 'text', value: '完整开头+尾巴' }]);
    expect(m.isStreaming).toBe(false);
  });

  it('chat_complete：不带 text 时保留本地 content（旧 server 兼容）', () => {
    const { view, push } = setup();
    push({
      type: 'message_start',
      payload: {
        message: makeMsg({ id: 'm1', content: [{ type: 'text', value: '本地已有' }] }),
      },
    });
    push({ type: 'chat_complete', payload: { sessionId: 's1', messageId: 'm1' } });
    expect(view.result.current.state.messages['s1'][0].content).toEqual([
      { type: 'text', value: '本地已有' },
    ]);
  });

  it('tool_calls_update：有 messageId 挂指定消息 + isProcessingTools 推导', () => {
    const { view, push } = setup();
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'm1' }) } });
    push({
      type: 'tool_calls_update',
      payload: {
        sessionId: 's1',
        messageId: 'm1',
        toolCalls: [
          { id: 't1', toolName: 'edit', parameters: {}, status: 'executing' as never },
        ],
      },
    });
    const m = view.result.current.state.messages['s1'][0];
    expect(m.associatedToolCalls).toHaveLength(1);
    expect(m.isProcessingTools).toBe(true); // executing → 处理中
  });

  it('tool_calls_update：无 messageId 挂最后一条 assistant', () => {
    const { view, push } = setup();
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'u1', role: 'user' }) } });
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'a1', role: 'assistant' }) } });
    push({
      type: 'tool_calls_update',
      payload: {
        sessionId: 's1',
        toolCalls: [{ id: 't1', toolName: 'x', parameters: {}, status: 'success' as never }],
      },
    });
    const list = view.result.current.state.messages['s1'];
    const assistant = list.find((m) => m.id === 'a1')!;
    expect(assistant.associatedToolCalls).toHaveLength(1);
    expect(assistant.isProcessingTools).toBe(false); // success 非处理中
    // user 消息不应被挂
    expect(list.find((m) => m.id === 'u1')!.associatedToolCalls).toBeUndefined();
  });

  it('tool_calls_update：无 assistant 时原样返回（不崩）', () => {
    const { view, push } = setup();
    push({ type: 'message_start', payload: { message: makeMsg({ id: 'u1', role: 'user' }) } });
    const before = view.result.current.state.messages['s1'];
    push({
      type: 'tool_calls_update',
      payload: { sessionId: 's1', toolCalls: [{ id: 't1', toolName: 'x', parameters: {}, status: 'success' as never }] },
    });
    expect(view.result.current.state.messages['s1']).toBe(before); // 引用不变 = 原样
  });

  it('session_status：更新已存在 session', () => {
    const { view, push } = setup();
    push({ type: 'session_upsert', payload: { session: makeSession({ sessionId: 's1', status: 'idle' }) } });
    push({ type: 'session_status', payload: { sessionId: 's1', status: 'thinking' } });
    expect(view.result.current.state.sessions['s1'].status).toBe('thinking');
  });

  it.each(['idle', 'error'] as const)(
    'session_status(%s)：权威终态清理历史里残留的工具处理中标记',
    (status) => {
      const { view, push } = setup();
      push({
        type: 'session_upsert',
        payload: { session: makeSession({ sessionId: 's1', status: 'streaming' }) },
      });
      push({
        type: 'message_start',
        payload: {
          message: makeMsg({
            id: 'm1',
            isStreaming: true,
            isProcessingTools: true,
          }),
        },
      });

      push({ type: 'session_status', payload: { sessionId: 's1', status } });

      const message = view.result.current.state.messages['s1'][0];
      expect(message.isStreaming).toBe(false);
      expect(message.isProcessingTools).toBe(false);
      expect(view.result.current.state.sessions['s1'].status).toBe(status);
    },
  );

  it('session_status：session 不存在时原样返回', () => {
    const { view, push } = setup();
    const before = view.result.current.state;
    push({ type: 'session_status', payload: { sessionId: 'ghost', status: 'error' } });
    expect(view.result.current.state).toBe(before);
  });

  it('models_list：填 models，current 有则覆盖', () => {
    const { view, push } = setup();
    push({
      type: 'models_list',
      payload: {
        models: [{ id: 'm', displayName: 'M', provider: 'openai' }],
        current: 'm',
      },
    });
    expect(view.result.current.state.models).toHaveLength(1);
    expect(view.result.current.state.currentModel).toBe('m');
  });

  it('models_list：当前模型被服务端标记不可用时清除旧选择', () => {
    const { view, push } = setup();
    push({
      type: 'models_list',
      payload: {
        models: [{ id: 'm', displayName: 'M', provider: 'otto' }],
        current: 'm',
      },
    });
    push({
      type: 'models_list',
      payload: {
        models: [
          {
            id: 'm',
            displayName: 'M',
            provider: 'otto',
            managed: true,
            enabled: false,
          },
        ],
      },
    });
    expect(view.result.current.state.currentModel).toBeNull();
  });

  it('模型切换：旧 models_list 回包不得把乐观选择跳回上一个模型', () => {
    const { view, push } = setup();
    push({
      type: 'sessions_list',
      payload: { sessions: [makeSession({ sessionId: 's1', model: 'old-model' })] },
    });
    push({
      type: 'models_list',
      payload: {
        models: [
          { id: 'old-model', displayName: '旧模型', provider: 'otto' },
          { id: 'new-model', displayName: '新模型', provider: 'otto' },
        ],
        current: 'old-model',
      },
    });

    act(() => view.result.current.actions.setModel('new-model'));
    expect(view.result.current.state.currentModel).toBe('new-model');

    // 首次 get_models 的旧响应可能晚于点击返回；在 set_model 的确认到达前必须忽略旧 current。
    push({
      type: 'models_list',
      payload: {
        models: [
          { id: 'old-model', displayName: '旧模型', provider: 'otto' },
          { id: 'new-model', displayName: '新模型', provider: 'otto' },
        ],
        current: 'old-model',
      },
    });
    expect(view.result.current.state.currentModel).toBe('new-model');

    push({
      type: 'models_list',
      payload: {
        models: [
          { id: 'old-model', displayName: '旧模型', provider: 'otto' },
          { id: 'new-model', displayName: '新模型', provider: 'otto' },
        ],
        current: 'new-model',
      },
    });
    expect(view.result.current.state.currentModel).toBe('new-model');
    expect(view.result.current.state.pendingModelSwitch).toBeUndefined();
  });

  it('模型确认会修复 pending 期间被旧会话快照覆盖的 session.model', () => {
    const { view, push } = setup();
    push({
      type: 'sessions_list',
      payload: {
        sessions: [
          makeSession({ sessionId: 'a', model: 'old-model' }),
          makeSession({ sessionId: 'b', model: 'model-b' }),
        ],
      },
    });
    push({
      type: 'models_list',
      payload: {
        models: [
          { id: 'old-model', displayName: '旧模型', provider: 'otto' },
          { id: 'new-model', displayName: '新模型', provider: 'otto' },
          { id: 'model-b', displayName: 'B', provider: 'otto' },
        ],
        current: 'old-model',
      },
    });

    act(() => view.result.current.actions.setModel('new-model'));
    // pending 期间到达的旧 sessions_list / session_upsert 会携带服务端切换前摘要。
    push({
      type: 'sessions_list',
      payload: {
        sessions: [
          makeSession({ sessionId: 'a', model: 'old-model' }),
          makeSession({ sessionId: 'b', model: 'model-b' }),
        ],
      },
    });
    push({
      type: 'session_upsert',
      payload: { session: makeSession({ sessionId: 'a', model: 'old-model' }) },
    });
    expect(view.result.current.state.currentModel).toBe('new-model');
    expect(view.result.current.state.sessions['a'].model).toBe('old-model');

    push({
      type: 'models_list',
      payload: { models: view.result.current.state.models, current: 'new-model' },
    });
    expect(view.result.current.state.pendingModelSwitch).toBeUndefined();
    expect(view.result.current.state.sessions['a'].model).toBe('new-model');

    act(() => view.result.current.actions.selectSession('b'));
    expect(view.result.current.state.currentModel).toBe('model-b');
    act(() => view.result.current.actions.selectSession('a'));
    expect(view.result.current.state.currentModel).toBe('new-model');
  });

  it('会话切换时模型药丸同步各自 session.model，两个会话不串', () => {
    const { view, push } = setup();
    push({
      type: 'sessions_list',
      payload: {
        sessions: [
          makeSession({ sessionId: 'a', model: 'model-a' }),
          makeSession({ sessionId: 'b', model: 'model-b' }),
        ],
      },
    });
    expect(view.result.current.state.activeSessionId).toBe('a');
    expect(view.result.current.state.currentModel).toBe('model-a');

    act(() => view.result.current.actions.selectSession('b'));
    expect(view.result.current.state.currentModel).toBe('model-b');
    act(() => view.result.current.actions.selectSession('a'));
    expect(view.result.current.state.currentModel).toBe('model-a');
  });

  it('非当前会话的 pending 确认不覆盖当前会话模型', () => {
    const { view, push } = setup();
    push({
      type: 'sessions_list',
      payload: {
        sessions: [
          makeSession({ sessionId: 'a', model: 'model-a' }),
          makeSession({ sessionId: 'b', model: 'model-b' }),
        ],
      },
    });
    push({
      type: 'models_list',
      payload: {
        models: [
          { id: 'model-a', displayName: 'A', provider: 'otto' },
          { id: 'model-a-new', displayName: 'A2', provider: 'otto' },
          { id: 'model-b', displayName: 'B', provider: 'otto' },
        ],
        current: 'model-a',
      },
    });
    act(() => view.result.current.actions.setModel('model-a-new'));
    act(() => view.result.current.actions.selectSession('b'));
    expect(view.result.current.state.currentModel).toBe('model-b');

    push({
      type: 'models_list',
      payload: {
        models: view.result.current.state.models,
        current: 'model-a-new',
      },
    });
    expect(view.result.current.state.pendingModelSwitch).toBeUndefined();
    expect(view.result.current.state.currentModel).toBe('model-b');
  });

  it.each(['unknown_model', 'model_switch_failed'])(
    '模型切换：服务端返回 %s 时回滚 UI 与会话摘要',
    (code) => {
      const { view, push } = setup();
      push({
        type: 'sessions_list',
        payload: { sessions: [makeSession({ sessionId: 's1', model: 'old-model' })] },
      });
      push({
        type: 'models_list',
        payload: {
          models: [
            { id: 'old-model', displayName: '旧模型', provider: 'otto' },
            { id: 'new-model', displayName: '新模型', provider: 'otto' },
          ],
          current: 'old-model',
        },
      });

      act(() => view.result.current.actions.setModel('new-model'));
      push({
        type: 'error',
        payload: { sessionId: 's1', code, message: '模型切换失败' },
      });

      expect(view.result.current.state.currentModel).toBe('old-model');
      expect(view.result.current.state.sessions['s1'].model).toBe('old-model');
      expect(view.result.current.state.pendingModelSwitch).toBeUndefined();
      expect(view.result.current.state.lastError).toBe('模型切换失败');
    },
  );

  it('error：写 lastError', () => {
    const { view, push } = setup();
    push({ type: 'error', payload: { code: 'x', message: '出错了' } });
    expect(view.result.current.state.lastError).toBe('出错了');
  });

  it('error：收口在途消息（清 isStreaming/isReasoning/isProcessingTools 解 busy 卡死）', () => {
    const { view, push } = setup();
    // 流式中途：assistant 占位仍 isStreaming=true（server 出错只发 error、不发 chat_complete）。
    push({
      type: 'message_start',
      payload: {
        message: makeMsg({
          id: 'm1',
          isStreaming: true,
          isReasoning: true,
          isProcessingTools: true,
        }),
      },
    });
    push({ type: 'error', payload: { sessionId: 's1', code: 'core_error', message: '模型报错' } });
    const m = view.result.current.state.messages['s1'][0];
    expect(m.isStreaming).toBe(false);
    expect(m.isReasoning).toBe(false);
    expect(m.isProcessingTools).toBe(false);
    expect(view.result.current.state.lastError).toBe('模型报错');
  });

  it('error：无 sessionId 时兜底收口全部会话的在途消息', () => {
    const { view, push } = setup();
    push({
      type: 'message_start',
      payload: { message: makeMsg({ id: 'a1', sessionId: 'a', isStreaming: true }) },
    });
    push({
      type: 'message_start',
      payload: { message: makeMsg({ id: 'b1', sessionId: 'b', isStreaming: true }) },
    });
    push({ type: 'error', payload: { code: 'x', message: '全局错误' } });
    expect(view.result.current.state.messages['a'][0].isStreaming).toBe(false);
    expect(view.result.current.state.messages['b'][0].isStreaming).toBe(false);
  });

  it('feishu_push_result(ok:false)：写 lastError', () => {
    const { view, push } = setup();
    push({
      type: 'feishu_push_result',
      payload: { sessionId: 's1', feishuChatId: 'oc', messageId: 'm', ok: false, error: '断网' },
    });
    expect(view.result.current.state.lastError).toContain('断网');
  });

  it('feishu_push_result(ok:true)：不动 state', () => {
    const { view, push } = setup();
    const before = view.result.current.state;
    push({
      type: 'feishu_push_result',
      payload: { sessionId: 's1', feishuChatId: 'oc', messageId: 'm', ok: true },
    });
    expect(view.result.current.state).toBe(before);
  });

  it('welcome / 未知帧：返回原 state（恒等）', () => {
    const { view, push } = setup();
    const before = view.result.current.state;
    push({ type: 'welcome', payload: { protocolVersion: '1', serverVersion: '0.1.0' } });
    expect(view.result.current.state).toBe(before);
  });
});

describe('deleteSession / renameSession actions（发帧）', () => {
  it('deleteSession(id) → 发 delete_session 帧', () => {
    const { view } = setup();
    act(() => {
      view.result.current.actions.deleteSession('sX');
    });
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'delete_session',
      payload: { sessionId: 'sX' },
    });
  });

  it('deleteSession(空 id) → 不发帧', () => {
    const { view } = setup();
    sendSpy.mockClear();
    act(() => {
      view.result.current.actions.deleteSession('');
    });
    expect(
      sendSpy.mock.calls.some(
        (c) => (c[0] as { type?: string })?.type === 'delete_session',
      ),
    ).toBe(false);
  });

  it('renameSession(id, title) → 发 rename_session 帧（title 已 trim）', () => {
    const { view } = setup();
    act(() => {
      view.result.current.actions.renameSession('sX', '  新名  ');
    });
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'rename_session',
      payload: { sessionId: 'sX', title: '新名' },
    });
  });

  it('renameSession(id, 纯空白) → 不发帧', () => {
    const { view } = setup();
    sendSpy.mockClear();
    act(() => {
      view.result.current.actions.renameSession('sX', '   ');
    });
    expect(
      sendSpy.mock.calls.some(
        (c) => (c[0] as { type?: string })?.type === 'rename_session',
      ),
    ).toBe(false);
  });
});

describe('目录附件发送', () => {
  it('把 Composer 的目录附件转换成 folder_reference 协议片段', () => {
    const { view, push } = setup();
    push({
      type: 'session_upsert',
      payload: { session: makeSession({ sessionId: 'folder-session' }) },
    });
    act(() => view.result.current.actions.selectSession('folder-session'));
    sendSpy.mockClear();

    act(() => {
      view.result.current.actions.sendMessage('', 'local', [{
        folderName: '客户资料',
        folderPath: 'C:\\Users\\tester\\Documents\\客户资料',
      }]);
    });

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'send_user_message',
      payload: expect.objectContaining({
        sessionId: 'folder-session',
        content: [{
          type: 'folder_reference',
          value: {
            folderName: '客户资料',
            folderPath: 'C:\\Users\\tester\\Documents\\客户资料',
          },
        }],
      }),
    });
  });
});

describe('真实工作目录切换', () => {
  it('只为当前会话发送 set_session_workspace，由服务端回包更新摘要', () => {
    const { view, push } = setup();
    push({
      type: 'session_upsert',
      payload: { session: makeSession({ sessionId: 'workspace-session', workspacePath: '/Users/test' }) },
    });
    act(() => view.result.current.actions.selectSession('workspace-session'));
    sendSpy.mockClear();

    act(() => view.result.current.actions.setWorkspace('/Users/test/project'));
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'set_session_workspace',
      payload: { sessionId: 'workspace-session', workspacePath: '/Users/test/project' },
    });
    expect(view.result.current.state.sessions['workspace-session'].workspacePath).toBe('/Users/test');

    push({
      type: 'session_upsert',
      payload: { session: makeSession({ sessionId: 'workspace-session', workspacePath: '/Users/test/project' }) },
    });
    expect(view.result.current.state.sessions['workspace-session'].workspacePath)
      .toBe('/Users/test/project');
  });
});

describe('Agent profile 启动动作', () => {
  it('A2A 本地协助会话在服务端确认后才发送一次任务提示', async () => {
    const { view, push } = setup();

    act(() => {
      view.result.current.actions.launchAgentProfileWithPrompt(
        'Otto 协助：同事',
        'otto-enterprise-work',
        '请总结这段企业聊天。',
      );
    });
    const createFrame = sendSpy.mock.calls.map(([frame]) => frame).find(
      (frame) => (frame as { type?: string }).type === 'create_session',
    ) as { payload: { clientRequestId: string } };
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'create_session',
      payload: {
        title: 'Otto 协助：同事',
        agentProfileId: 'otto-enterprise-work',
        clientRequestId: createFrame.payload.clientRequestId,
      },
    });

    push({
      type: 'session_created',
      payload: {
        session: makeSession({
          sessionId: 'a2a-session',
          title: 'Otto 协助：同事',
          agentProfileId: 'otto-enterprise-work',
        }),
        clientRequestId: createFrame.payload.clientRequestId,
      },
    });

    await waitFor(() => {
      expect(sendSpy).toHaveBeenCalledWith({
        type: 'send_user_message',
        payload: expect.objectContaining({
          sessionId: 'a2a-session',
          source: 'local',
          content: [{ type: 'text', value: '请总结这段企业聊天。' }],
        }),
      });
    });
    const sentPrompts = sendSpy.mock.calls.filter(
      ([frame]) => (frame as { type?: string }).type === 'send_user_message',
    );
    expect(sentPrompts).toHaveLength(1);
  });

  it('用 clientRequestId 隔离并发启动，并按顺序继承工作目录、授权和附件', () => {
    const { view, push } = setup();

    act(() => {
      view.result.current.actions.launchAgentProfileWithPrompt(
        'PPT',
        'ppt',
        '制作发布会',
        'local',
        [{ fileName: 'brief.pdf', filePath: '/tmp/brief.pdf' }],
        '企业上下文 A',
        '/Users/test/project-a',
        { mode: 'auto', scope: 'session' },
      );
      view.result.current.actions.launchAgentProfileWithPrompt(
        '会议',
        'meeting',
        '整理纪要',
        'local',
        [],
        '企业上下文 B',
        '/Users/test/project-b',
        { mode: 'manual', scope: 'session' },
      );
    });

    const creates = sendSpy.mock.calls
      .map(([frame]) => frame as { type: string; payload: { clientRequestId?: string } })
      .filter((frame) => frame.type === 'create_session');
    expect(creates).toHaveLength(2);
    const firstId = creates[0].payload.clientRequestId!;
    const secondId = creates[1].payload.clientRequestId!;

    push({
      type: 'session_created',
      payload: { session: makeSession({ sessionId: 'second', agentProfileId: 'meeting' }), clientRequestId: secondId },
    });
    push({
      type: 'session_created',
      payload: { session: makeSession({ sessionId: 'first', agentProfileId: 'ppt' }), clientRequestId: firstId },
    });

    const relevant = sendSpy.mock.calls
      .map(([frame]) => frame as { type: string; payload: Record<string, unknown> })
      .filter((frame) => ['set_session_workspace', 'set_authorization_mode', 'send_user_message'].includes(frame.type));
    expect(relevant).toEqual([
      { type: 'set_session_workspace', payload: { sessionId: 'second', workspacePath: '/Users/test/project-b' } },
      { type: 'set_authorization_mode', payload: { sessionId: 'second', mode: 'manual', scope: 'session' } },
      { type: 'send_user_message', payload: expect.objectContaining({ sessionId: 'second', authorizedContext: '企业上下文 B', content: [{ type: 'text', value: '整理纪要' }] }) },
      { type: 'set_session_workspace', payload: { sessionId: 'first', workspacePath: '/Users/test/project-a' } },
      { type: 'set_authorization_mode', payload: { sessionId: 'first', mode: 'auto', scope: 'session' } },
      { type: 'send_user_message', payload: expect.objectContaining({
        sessionId: 'first',
        authorizedContext: '企业上下文 A',
        content: [
          { type: 'text', value: '制作发布会' },
          { type: 'file_reference', value: { fileName: 'brief.pdf', filePath: '/tmp/brief.pdf' } },
        ],
      }) },
    ]);
  });

  it('断线会清除尚未确认的 Agent 启动，迟到回包不会误发任务', () => {
    const { view, push } = setup();
    act(() => {
      view.result.current.actions.launchAgentProfileWithPrompt('PPT', 'ppt', '不要串到后续会话');
    });
    const create = sendSpy.mock.calls
      .map(([frame]) => frame as { type: string; payload: { clientRequestId?: string } })
      .find((frame) => frame.type === 'create_session')!;
    act(() => _capturedConnHandler?.(false));
    push({
      type: 'session_created',
      payload: { session: makeSession({ sessionId: 'late' }), clientRequestId: create.payload.clientRequestId! },
    });
    expect(sendSpy.mock.calls.some(([frame]) => (
      (frame as { type?: string; payload?: { sessionId?: string } }).type === 'send_user_message'
      && (frame as { payload?: { sessionId?: string } }).payload?.sessionId === 'late'
    ))).toBe(false);
    expect(view.result.current.state.lastError).toContain('Agent 任务未发送');
  });

  it('服务端拒绝一个 Agent 会话时只清除最早的待启动事务', () => {
    const { view, push } = setup();
    act(() => {
      view.result.current.actions.launchAgentProfileWithPrompt('PPT', 'ppt', '不应发送的 PPT 任务');
      view.result.current.actions.launchAgentProfileWithPrompt('会议', 'meeting', '应继续发送的会议任务');
    });
    const creates = sendSpy.mock.calls
      .map(([frame]) => frame as { type: string; payload: { clientRequestId?: string } })
      .filter((frame) => frame.type === 'create_session');

    push({
      type: 'error',
      payload: { code: 'forbidden_agent_profile', message: '当前账号无权启动该 Agent' },
    });
    push({
      type: 'session_created',
      payload: {
        session: makeSession({ sessionId: 'late-rejected' }),
        clientRequestId: creates[0].payload.clientRequestId!,
      },
    });
    push({
      type: 'session_created',
      payload: {
        session: makeSession({ sessionId: 'accepted-meeting' }),
        clientRequestId: creates[1].payload.clientRequestId!,
      },
    });

    const sentMessages = sendSpy.mock.calls
      .map(([frame]) => frame as { type?: string; payload?: { sessionId?: string; content?: unknown } })
      .filter((frame) => frame.type === 'send_user_message');
    expect(sentMessages).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          sessionId: 'accepted-meeting',
          content: [{ type: 'text', value: '应继续发送的会议任务' }],
        }),
      }),
    ]);
    expect(view.result.current.state.lastError).toContain('当前账号无权启动该 Agent');
  });

  it('已有会话的 Agent 权限错误不会取消无关的新 Agent 启动', () => {
    const { view, push } = setup();
    act(() => {
      view.result.current.actions.launchAgentProfileWithPrompt('PPT', 'ppt', '继续创建');
    });
    const create = sendSpy.mock.calls
      .map(([frame]) => frame as { type: string; payload: { clientRequestId?: string } })
      .find((frame) => frame.type === 'create_session')!;

    push({
      type: 'error',
      payload: {
        sessionId: 'existing-session',
        code: 'forbidden_agent_profile',
        message: '现有会话权限已变化',
      },
    });
    push({
      type: 'session_created',
      payload: {
        session: makeSession({ sessionId: 'new-ppt' }),
        clientRequestId: create.payload.clientRequestId!,
      },
    });

    expect(sendSpy.mock.calls.some(([frame]) => (
      (frame as { type?: string; payload?: { sessionId?: string } }).type === 'send_user_message'
      && (frame as { payload?: { sessionId?: string } }).payload?.sessionId === 'new-ppt'
    ))).toBe(true);
  });
});
