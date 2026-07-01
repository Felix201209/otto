/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 渲染层会话状态机（接缝：替代 webview `useMultiSessionState` 的传输底）。
 *
 * 职责：
 *   - connect() 接入 preload WS 桥（transport.ts），订阅 ServerToClient 帧。
 *   - 维护会话列表 + 当前会话 + 每会话消息（含流式增量、工具调用）。
 *   - 暴露动作：选会话、新建、发消息（带 source）、设模型、取消、工具确认。
 *
 * 所有状态更新走不可变模式（rules/common/coding-style：不 mutate）。
 * 协议帧形态以 packages/server/src/protocol.ts 为唯一基准。
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import * as transport from '../transport.js';
import type {
  OttoMessage,
  SessionSummary,
  ServerToClient,
  ModelInfo,
  MessageSource,
} from 'otto-server';

// ── 状态形状 ──────────────────────────────────────────────────────────────

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface OttoState {
  connection: ConnectionState;
  sessions: Record<string, SessionSummary>;
  /** 列表顺序（按 updatedAt 倒序由 selector 计算）。 */
  sessionIds: string[];
  activeSessionId: string | null;
  /** 每会话消息表。 */
  messages: Record<string, OttoMessage[]>;
  models: ModelInfo[];
  /**
   * 是否已收到过至少一帧 models_list。首帧到达前 models 恒为空数组，那是"尚未知晓"
   * 而非"确无模型"——用它把两者区分开，避免连上瞬间就误判无模型而弹出 setup 面板。
   */
  modelsLoaded: boolean;
  /**
   * 是否已收到过至少一帧 sessions_list。首帧到达前 sessionIds 恒为空数组，那是"尚未知晓"
   * 而非"确无会话"——仿照 modelsLoaded，让 App 的自动引导 effect 只在真正拿到列表后才
   * 决定是否新建/选中，避免连上瞬间凭空判空乱建会话。可选：老的完整 state 字面量（如单测）
   * 未提供时按未加载（undefined→falsy）处理。
   */
  sessionsLoaded?: boolean;
  currentModel: string | null;
  /** 末次错误（toast 用）。 */
  lastError: string | null;
}

const initialState: OttoState = {
  connection: 'connecting',
  sessions: {},
  sessionIds: [],
  activeSessionId: null,
  messages: {},
  models: [],
  modelsLoaded: false,
  sessionsLoaded: false,
  currentModel: null,
  lastError: null,
};

// ── reducer action ────────────────────────────────────────────────────────

type Action =
  | { kind: 'connection'; value: ConnectionState }
  | { kind: 'frame'; frame: ServerToClient }
  | { kind: 'select'; sessionId: string }
  | { kind: 'optimistic_user'; message: OttoMessage }
  | { kind: 'clear_error' };

function upsertSession(
  state: OttoState,
  session: SessionSummary,
): OttoState {
  const sessions = { ...state.sessions, [session.sessionId]: session };
  const sessionIds = state.sessionIds.includes(session.sessionId)
    ? state.sessionIds
    : [...state.sessionIds, session.sessionId];
  return { ...state, sessions, sessionIds };
}

function appendMessage(
  state: OttoState,
  message: OttoMessage,
): OttoState {
  const list = state.messages[message.sessionId] ?? [];
  // 去重：相同 id 覆盖（流式占位 → 定稿）。
  const idx = list.findIndex((m) => m.id === message.id);
  const next =
    idx >= 0
      ? list.map((m) => (m.id === message.id ? message : m))
      : [...list, message];
  return {
    ...state,
    messages: { ...state.messages, [message.sessionId]: next },
  };
}

function patchMessage(
  state: OttoState,
  sessionId: string,
  messageId: string,
  patch: (m: OttoMessage) => OttoMessage,
): OttoState {
  const list = state.messages[sessionId];
  if (!list) return state;
  const next = list.map((m) => (m.id === messageId ? patch(m) : m));
  return { ...state, messages: { ...state.messages, [sessionId]: next } };
}

function reducer(state: OttoState, action: Action): OttoState {
  switch (action.kind) {
    case 'connection':
      return { ...state, connection: action.value };

    case 'select':
      return { ...state, activeSessionId: action.sessionId };

    case 'optimistic_user':
      return appendMessage(state, action.message);

    case 'clear_error':
      return state.lastError === null ? state : { ...state, lastError: null };

    case 'frame':
      return applyFrame(state, action.frame);

    default:
      return state;
  }
}

/** 把一条 ServerToClient 帧 reduce 进状态。 */
function applyFrame(state: OttoState, frame: ServerToClient): OttoState {
  switch (frame.type) {
    case 'welcome':
      return state;

    case 'sessions_list': {
      let next = state;
      for (const s of frame.payload.sessions) next = upsertSession(next, s);
      // 默认选中第一个（若尚无选中）。
      if (!next.activeSessionId && frame.payload.sessions.length > 0) {
        next = { ...next, activeSessionId: frame.payload.sessions[0].sessionId };
      }
      // 标记列表已知晓（首帧到达）。仿照 modelsLoaded，供 App 的自动引导 effect 判空用。
      return next.sessionsLoaded ? next : { ...next, sessionsLoaded: true };
    }

    case 'session_upsert':
      return upsertSession(state, frame.payload.session);

    case 'history': {
      const { sessionId, messages } = frame.payload;
      return {
        ...state,
        messages: { ...state.messages, [sessionId]: messages },
      };
    }

    case 'message_start':
      return appendMessage(state, frame.payload.message);

    case 'chat_chunk': {
      const { sessionId, messageId, delta } = frame.payload;
      return patchMessage(state, sessionId, messageId, (m) => ({
        ...m,
        isStreaming: true,
        content: mergeTextDelta(m.content, delta),
      }));
    }

    case 'chat_reasoning': {
      const { sessionId, messageId, delta } = frame.payload;
      return patchMessage(state, sessionId, messageId, (m) => ({
        ...m,
        isReasoning: true,
        reasoning: (m.reasoning ?? '') + delta,
      }));
    }

    case 'chat_complete': {
      const { sessionId, messageId, tokenUsage } = frame.payload;
      return patchMessage(state, sessionId, messageId, (m) => ({
        ...m,
        isStreaming: false,
        isReasoning: false,
        tokenUsage: tokenUsage ?? m.tokenUsage,
      }));
    }

    case 'tool_calls_update': {
      const { sessionId, messageId, toolCalls } = frame.payload;
      const list = state.messages[sessionId];
      if (!list) return state;
      // 优先挂到指定 messageId；否则挂到最后一条 assistant 消息。
      const targetId =
        messageId ??
        [...list].reverse().find((m) => m.role === 'assistant')?.id;
      if (!targetId) return state;
      return patchMessage(state, sessionId, targetId, (m) => ({
        ...m,
        associatedToolCalls: toolCalls,
        isProcessingTools: toolCalls.some(
          (t) => t.status === 'executing' || t.status === 'scheduled',
        ),
      }));
    }

    case 'session_status': {
      const { sessionId, status } = frame.payload;
      const s = state.sessions[sessionId];
      if (!s) return state;
      return upsertSession(state, { ...s, status });
    }

    case 'models_list':
      return {
        ...state,
        models: frame.payload.models,
        modelsLoaded: true,
        currentModel: frame.payload.current ?? state.currentModel,
      };

    case 'error':
      return { ...state, lastError: frame.payload.message };

    case 'feishu_push_result':
      // 同步状态指示（Issue #6）：失败时浮一条错误。
      return frame.payload.ok
        ? state
        : {
            ...state,
            lastError: `飞书回推失败：${frame.payload.error ?? '未知错误'}`,
          };

    default:
      return state;
  }
}

/** 把流式文本增量并进 content 的末尾 text 片段。 */
function mergeTextDelta(
  content: OttoMessage['content'],
  delta: string,
): OttoMessage['content'] {
  if (content.length === 0) return [{ type: 'text', value: delta }];
  const last = content[content.length - 1];
  if (last.type === 'text') {
    return [
      ...content.slice(0, -1),
      { type: 'text', value: last.value + delta },
    ];
  }
  return [...content, { type: 'text', value: delta }];
}

// ── Hook ────────────────────────────────────────────────────────────────

export interface OttoActions {
  selectSession(sessionId: string): void;
  createSession(title?: string): void;
  sendMessage(text: string, source?: MessageSource): void;
  setModel(model: string): void;
  cancel(): void;
  respondToolConfirmation(
    callId: string,
    outcome: 'approved' | 'rejected' | 'always_approve',
  ): void;
  /** 清掉末次错误（toast 关闭 / 自动消失用）。 */
  clearError(): void;
}

export interface UseOttoStore {
  state: OttoState;
  actions: OttoActions;
}

let clientMsgSeq = 0;

export function useOttoStore(): UseOttoStore {
  const [state, dispatch] = useReducer(reducer, initialState);
  // reducer 在闭包里读不到最新 activeSessionId，用 ref 兜底动作里取值。
  const activeRef = useRef<string | null>(null);
  activeRef.current = state.activeSessionId;

  useEffect(() => {
    let cancelled = false;

    const unsubFrame = transport.onFrame((frame) => {
      dispatch({ kind: 'frame', frame });
    });

    // 订阅连接状态：断线立即翻到 disconnected（浮出横幅），重连即翻回 connected。
    // 这样 state.connection 不再僵死，下方 subscribe/get_history effect 会随之
    // 在重连后重新订阅当前会话；初次连上则补拉会话列表与模型。
    let wasConnected = false;
    const unsubConn = transport.onConnectionChange((connected) => {
      if (cancelled) return;
      dispatch({
        kind: 'connection',
        value: connected ? 'connected' : 'disconnected',
      });
      // 每次「从未连到已连」的上升沿都补拉一次列表与模型（首连 + 重连后恢复）。
      if (connected && !wasConnected) {
        transport.send({ type: 'list_sessions', payload: {} });
        transport.send({ type: 'get_models', payload: {} });
      }
      wasConnected = connected;
    });

    // 触发 preload 建连（onConnectionChange 已负责后续状态广播，这里不再单独 dispatch）。
    void transport.connect();

    return () => {
      cancelled = true;
      unsubFrame();
      unsubConn();
    };
  }, []);

  // 选中会话变化 → 订阅 + 拉历史。
  useEffect(() => {
    const id = state.activeSessionId;
    if (!id || state.connection !== 'connected') return;
    transport.send({ type: 'subscribe', payload: { sessionId: id } });
    transport.send({ type: 'get_history', payload: { sessionId: id } });
    return () => {
      transport.send({ type: 'unsubscribe', payload: { sessionId: id } });
    };
  }, [state.activeSessionId, state.connection]);

  const selectSession = useCallback((sessionId: string) => {
    dispatch({ kind: 'select', sessionId });
  }, []);

  const createSession = useCallback((title?: string) => {
    transport.send({ type: 'create_session', payload: { title } });
  }, []);

  const sendMessage = useCallback(
    (text: string, source: MessageSource = 'local') => {
      const sessionId = activeRef.current;
      const trimmed = text.trim();
      if (!sessionId || !trimmed) return;
      const clientMessageId = `c-${Date.now()}-${clientMsgSeq++}`;
      // 乐观渲染：先把用户消息塞进列表，server 回的 message_start 会按 id 对账覆盖。
      dispatch({
        kind: 'optimistic_user',
        message: {
          id: clientMessageId,
          sessionId,
          role: 'user',
          content: [{ type: 'text', value: trimmed }],
          timestamp: Date.now(),
          source,
        },
      });
      transport.send({
        type: 'send_user_message',
        payload: {
          sessionId,
          content: [{ type: 'text', value: trimmed }],
          source,
          clientMessageId,
        },
      });
    },
    [],
  );

  const setModel = useCallback((model: string) => {
    const sessionId = activeRef.current;
    if (!sessionId) return;
    transport.send({ type: 'set_model', payload: { sessionId, model } });
  }, []);

  const cancel = useCallback(() => {
    const sessionId = activeRef.current;
    if (!sessionId) return;
    transport.send({ type: 'cancel', payload: { sessionId } });
  }, []);

  const respondToolConfirmation = useCallback(
    (callId: string, outcome: 'approved' | 'rejected' | 'always_approve') => {
      const sessionId = activeRef.current;
      if (!sessionId) return;
      transport.send({
        type: 'tool_confirmation_response',
        payload: { sessionId, callId, outcome },
      });
    },
    [],
  );

  const clearError = useCallback(() => {
    dispatch({ kind: 'clear_error' });
  }, []);

  return {
    state,
    actions: {
      selectSession,
      createSession,
      sendMessage,
      setModel,
      cancel,
      respondToolConfirmation,
      clearError,
    },
  };
}

// ── selectors ─────────────────────────────────────────────────────────────

/** 列表按 updatedAt 倒序，并按今天/昨天/更早分组。 */
export interface SessionGroup {
  label: string;
  sessions: SessionSummary[];
}

export function groupSessions(state: OttoState): SessionGroup[] {
  const all = state.sessionIds
    .map((id) => state.sessions[id])
    .filter((s): s is SessionSummary => Boolean(s))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 86_400_000;

  const today: SessionSummary[] = [];
  const yesterday: SessionSummary[] = [];
  const earlier: SessionSummary[] = [];

  for (const s of all) {
    if (s.updatedAt >= startOfToday) today.push(s);
    else if (s.updatedAt >= startOfYesterday) yesterday.push(s);
    else earlier.push(s);
  }

  const groups: SessionGroup[] = [];
  if (today.length) groups.push({ label: '今天', sessions: today });
  if (yesterday.length) groups.push({ label: '昨天', sessions: yesterday });
  if (earlier.length) groups.push({ label: '更早', sessions: earlier });
  return groups;
}
