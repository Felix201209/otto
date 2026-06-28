/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * applyFrame reducer + groupSessions selector 单测（renderer 状态心脏）。
 *
 * applyFrame / reducer / mergeTextDelta 是文件私有（不改源码 export），故通过
 * renderHook(useOttoStore) + mock transport 打帧的方式间接覆盖每个帧分支：
 *   mock 的 transport.onFrame 捕获 hook 注册的 frame handler，用 act() 调它推帧，
 *   再断言 result.current.state。groupSessions 已 export，直接测。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type {
  ServerToClient,
  SessionSummary,
  OttoMessage,
} from 'otto-server';

// ── mock transport：捕获 frame handler，connect 立即 resolve(true) ──
let capturedHandler: ((f: ServerToClient) => void) | null = null;
const sendSpy = vi.fn();

vi.mock('../transport.js', () => ({
  connect: vi.fn(async () => true),
  send: (...args: unknown[]) => sendSpy(...args),
  onFrame: (handler: (f: ServerToClient) => void) => {
    capturedHandler = handler;
    return () => {
      capturedHandler = null;
    };
  },
  isConnected: () => true,
}));

import { useOttoStore, groupSessions } from './useOttoStore.js';
import type { OttoState } from './useOttoStore.js';

/** 渲染 hook 并返回推帧函数 + result。 */
function setup() {
  const view = renderHook(() => useOttoStore());
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

  it('sessions_list：已有选中则不覆盖', () => {
    const { view, push } = setup();
    push({ type: 'sessions_list', payload: { sessions: [makeSession({ sessionId: 'a' })] } });
    expect(view.result.current.state.activeSessionId).toBe('a');
    push({ type: 'sessions_list', payload: { sessions: [makeSession({ sessionId: 'b' })] } });
    // 仍是 a（已有选中不被第二批覆盖）
    expect(view.result.current.state.activeSessionId).toBe('a');
  });

  it('session_upsert：新增不重复 / 更新已存在', () => {
    const { view, push } = setup();
    push({ type: 'session_upsert', payload: { session: makeSession({ sessionId: 'a', title: 'T1' }) } });
    push({ type: 'session_upsert', payload: { session: makeSession({ sessionId: 'a', title: 'T2' }) } });
    expect(view.result.current.state.sessionIds).toEqual(['a']); // 不重复
    expect(view.result.current.state.sessions['a'].title).toBe('T2'); // 更新
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

  it('error：写 lastError', () => {
    const { view, push } = setup();
    push({ type: 'error', payload: { code: 'x', message: '出错了' } });
    expect(view.result.current.state.lastError).toBe('出错了');
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

describe('groupSessions selector', () => {
  const DAY = 86_400_000;

  function stateWith(sessions: SessionSummary[]): OttoState {
    const map: Record<string, SessionSummary> = {};
    const ids: string[] = [];
    for (const s of sessions) {
      map[s.sessionId] = s;
      ids.push(s.sessionId);
    }
    return {
      connection: 'connected',
      sessions: map,
      sessionIds: ids,
      activeSessionId: null,
      messages: {},
      models: [],
      currentModel: null,
      lastError: null,
    };
  }

  beforeEach(() => {
    // 固定系统时间，避免时区/边界 flaky。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-27T12:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('按 updatedAt 倒序 + 今天/昨天/更早分组', () => {
    const now = Date.now();
    const startOfToday = new Date(2026, 5, 27).getTime();
    const groups = groupSessions(
      stateWith([
        makeSession({ sessionId: 'today1', updatedAt: startOfToday + 3600_000 }),
        makeSession({ sessionId: 'today2', updatedAt: now }),
        makeSession({ sessionId: 'yest', updatedAt: startOfToday - 3600_000 }),
        makeSession({ sessionId: 'old', updatedAt: startOfToday - 3 * DAY }),
      ]),
    );
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(['今天', '昨天', '更早']);

    const today = groups.find((g) => g.label === '今天')!;
    // 倒序：today2(now) 在 today1 之前
    expect(today.sessions.map((s) => s.sessionId)).toEqual(['today2', 'today1']);

    expect(groups.find((g) => g.label === '昨天')!.sessions[0].sessionId).toBe('yest');
    expect(groups.find((g) => g.label === '更早')!.sessions[0].sessionId).toBe('old');
  });

  it('空分组不出现在结果里', () => {
    const startOfToday = new Date(2026, 5, 27).getTime();
    const groups = groupSessions(
      stateWith([makeSession({ sessionId: 'only', updatedAt: startOfToday + 1000 })]),
    );
    expect(groups.map((g) => g.label)).toEqual(['今天']);
  });
});
