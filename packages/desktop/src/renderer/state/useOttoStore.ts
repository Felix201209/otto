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
  ToolCallStatus,
  OttoMessage,
  SessionSummary,
  ServerToClient,
  ModelInfo,
  MessageSource,
  SlashCommandInfo,
  ToolConfirmationResponsePayload,
} from 'otto-server';

// ── 状态形状 ──────────────────────────────────────────────────────────────

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/** 图片附件（image_reference part 的 value）——Composer 选图后组进 content 发送。 */
export type ImageAttachment = Extract<
  OttoMessage['content'][number],
  { type: 'image_reference' }
>['value'];

/** 普通文件附件（file_reference part 的 value）。 */
export type FileAttachment = Extract<
  OttoMessage['content'][number],
  { type: 'file_reference' }
>['value'];

/** 附件统一类型（图片或文件）。 */
export type Attachment = ImageAttachment | FileAttachment;

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
  /**
   * server 侧可执行的斜杠命令清单（slash_commands_list 帧）。
   * 面板展示时经 mergeServerCommands 与本地命令合并——server 是 server 命令
   * 的单一事实源，renderer 不预声明纯 server 命令，防两处清单漂移。
   * 可选：老的完整 state 字面量（如单测）未提供时按空清单处理。
   */
  slashCommands?: SlashCommandInfo[];
  /** 末次错误（toast 用）。 */
  lastError: string | null;
  /** 各会话当前排队消息数（message_queued/queue_drained 帧更新）。 */
  queuedCounts: Record<string, number>;
  /** 待关联的 clientRequestId（create_session 后等 session_created 回包用）。 */
  pendingCreateRequestId: string | null;
  /** 未读会话 ID 列表（桌面通知未读闪烁点数据源）。 */
  unreadSessions: string[];
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
  slashCommands: [],
  lastError: null,
  queuedCounts: {},
  pendingCreateRequestId: null,
  unreadSessions: [],
};

// ── reducer action ────────────────────────────────────────────────────────

type Action =
  | { kind: 'connection'; value: ConnectionState }
  | { kind: 'frame'; frame: ServerToClient }
  | { kind: 'select'; sessionId: string }
  | { kind: 'optimistic_user'; message: OttoMessage }
  | { kind: 'system_note'; markdown: string }
  | { kind: 'local_error'; message: string }
  | { kind: 'clear_error' }
  | { kind: 'pending_create'; clientRequestId: string }
  | { kind: 'set_optimistic_model'; model: string; sessionId: string }
  | { kind: 'set_unread'; sessions: string[] };

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

/**
 * 以 sessions_list 权威快照对账整份会话表：
 *   - 服务器返回的会话为准：新增/更新入表，快照里没有的会话（被删）从表与消息缓存里剔除。
 *   - activeSessionId 善后：若当前选中的会话已不在快照里（被删），落到快照第一个；
 *     快照为空则置 null。若原本无选中且快照非空，默认选第一个（沿用旧行为）。
 *   - 首帧到达即置 sessionsLoaded=true（供 App 自动引导 effect 判空）。
 * 快照顺序即服务器 listSessions 顺序（已按 updatedAt 倒序），直接沿用。
 */
function reconcileSessions(
  state: OttoState,
  list: SessionSummary[],
): OttoState {
  const sessions: Record<string, SessionSummary> = {};
  const sessionIds: string[] = [];
  for (const s of list) {
    sessions[s.sessionId] = s;
    sessionIds.push(s.sessionId);
  }
  const liveIds = new Set(sessionIds);
  // 只保留仍存活会话的消息缓存，随删除会话一并回收，避免内存里留孤儿消息。
  const messages: Record<string, OttoMessage[]> = {};
  for (const id of sessionIds) {
    if (state.messages[id]) messages[id] = state.messages[id];
  }
  // activeSessionId 善后：被删（或原本就无选中）时落到第一个存活会话，空快照置 null。
  let activeSessionId = state.activeSessionId;
  if (!activeSessionId || !liveIds.has(activeSessionId)) {
    activeSessionId = sessionIds.length > 0 ? sessionIds[0] : null;
  }
  return {
    ...state,
    sessions,
    sessionIds,
    messages,
    activeSessionId,
    sessionsLoaded: true,
  };
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

/**
 * 结算「在途」消息：把仍标记 isStreaming/isReasoning/isProcessingTools 的消息一律收口成
 * false。用于流式中途收到 error 帧时——server 出错走 fail() 只广播 error 帧、**不发
 * chat_complete**（对比取消走 onCancelled 会补发 chat_complete），且它对存储消息的
 * isStreaming=false patch 不经 publish 广播。若客户端不在此自行收口，那条 assistant 占位
 * 会永远停在 isStreaming=true → 派生的 busy 卡死 → 发送键锁在「停止」态，用户再也发不出
 * 下一条（「有时无法继续对话」bug）。带 sessionId 只结算该会话，无则兜底结算全部。
 */
function settleInFlight(state: OttoState, sessionId?: string): OttoState {
  const ids =
    sessionId != null
      ? state.messages[sessionId]
        ? [sessionId]
        : []
      : Object.keys(state.messages);
  let changed = false;
  const messages = { ...state.messages };
  for (const id of ids) {
    const list = state.messages[id];
    let listChanged = false;
    const next = list.map((m) => {
      if (!m.isStreaming && !m.isReasoning && !m.isProcessingTools) return m;
      listChanged = true;
      return {
        ...m,
        isStreaming: false,
        isReasoning: false,
        isProcessingTools: false,
      };
    });
    if (listChanged) {
      messages[id] = next;
      changed = true;
    }
  }
  return changed ? { ...state, messages } : state;
}

function isToolCallInFlight(status: ToolCallStatus): boolean {
  return !['success', 'error', 'cancelled', 'background_running'].includes(
    status as string,
  );
}

/** 取消终态把仍在执行/等待的卡片一并收口，避免按钮恢复后卡片继续永久转圈。 */
function cancelInFlightToolCalls(
  toolCalls: OttoMessage['associatedToolCalls'],
): OttoMessage['associatedToolCalls'] {
  return toolCalls?.map((toolCall) => {
    if (!isToolCallInFlight(toolCall.status)) return toolCall;
    return {
      ...toolCall,
      status: 'cancelled' as ToolCallStatus,
      result: {
        success: false,
        error: '用户已停止生成',
        executionTime: toolCall.startTime
          ? Math.max(0, Date.now() - toolCall.startTime)
          : 0,
        toolName: toolCall.toolName,
      },
      endTime: Date.now(),
    };
  });
}

function reducer(state: OttoState, action: Action): OttoState {
  switch (action.kind) {
    case 'connection':
      return { ...state, connection: action.value };

    case 'select':
      return { ...state, activeSessionId: action.sessionId };

    case 'optimistic_user':
      return appendMessage(state, action.message);

    case 'system_note': {
      // 本地系统提示气泡（/help 等）：ephemeral，不发帧不落库，刷新后消失是设计行为。
      if (!state.activeSessionId) return state;
      return appendMessage(state, {
        id: `note-${Date.now()}-${clientMsgSeq++}`,
        sessionId: state.activeSessionId,
        role: 'system',
        content: [{ type: 'text', value: action.markdown }],
        timestamp: Date.now(),
        source: 'local',
      });
    }

    case 'local_error':
      return { ...state, lastError: action.message };

    case 'clear_error':
      return state.lastError === null ? state : { ...state, lastError: null };

    case 'pending_create':
      return { ...state, pendingCreateRequestId: action.clientRequestId };

    case 'set_optimistic_model': {
      // 乐观更新：不等服务器回 models_list，立即更新前端状态。
      const sessions = { ...state.sessions };
      if (sessions[action.sessionId]) {
        sessions[action.sessionId] = { ...sessions[action.sessionId], model: action.model };
      }
      return { ...state, sessions, currentModel: action.model };
    }

    case 'set_unread':
      return { ...state, unreadSessions: action.sessions };

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

    case 'sessions_list':
      // sessions_list 是**权威快照**：不再只累加 upsert，而是以这份列表为准——
      // 服务器上已被删除的会话，客户端要据此同步剔除（否则删掉的会话行永远赖着不走）。
      return reconcileSessions(state, frame.payload.sessions);

    case 'session_upsert':
      return upsertSession(state, frame.payload.session);

    case 'session_created': {
      if (frame.payload.session.agentProfileId === 'otto-enterprise-a2a') {
        // A2A 由独立 runner 通过 clientRequestId 接管。它是服务端原生临时会话，
        // 不能进入侧栏，也不能清掉用户同时发起的普通新建会话关联状态。
        return state;
      }
      // PR 1: 本端创建的新会话——比对 clientRequestId 精确选中
      const updated = upsertSession(state, frame.payload.session);
      if (state.pendingCreateRequestId === frame.payload.clientRequestId) {
        return { ...updated, activeSessionId: frame.payload.session.sessionId, pendingCreateRequestId: null };
      }
      return { ...updated, pendingCreateRequestId: null };
    }

    case 'message_queued': {
      const qc = { ...state.queuedCounts };
      qc[frame.payload.sessionId] = frame.payload.queuePosition;
      return { ...state, queuedCounts: qc };
    }

    case 'queue_drained': {
      const qc = { ...state.queuedCounts };
      delete qc[frame.payload.sessionId];
      return { ...state, queuedCounts: qc };
    }

    case 'history': {
      const { sessionId, messages } = frame.payload;
      const existing = state.messages[sessionId];
      // server 返回的历史不少于本地时，把它视为权威快照；这样删除、重载和
      // 首次订阅仍能正确替换。本地明显更长时则说明 server 回包被 limit 截断：
      // 保留本地顺序与尾部消息，同时用 server 的同 id 内容完成定稿对账。
      const nextMessages =
        existing && existing.length > messages.length
          ? (() => {
              const serverById = new Map(messages.map((message) => [message.id, message]));
              const existingIds = new Set(existing.map((message) => message.id));
              return [
                ...existing.map((message) => serverById.get(message.id) ?? message),
                ...messages.filter((message) => !existingIds.has(message.id)),
              ];
            })()
          : messages;
      return {
        ...state,
        messages: { ...state.messages, [sessionId]: nextMessages },
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
      const { sessionId, messageId, tokenUsage, text, finishReason } = frame.payload;
      return patchMessage(state, sessionId, messageId, (m) => ({
        ...m,
        // 帧带定稿全文时用它覆盖本地 content 对账：切走（退订）期间丢失的
        // chunk 由此自愈——否则缺头的回复永远缺头。旧 server 不带 text 时保持原样。
        content:
          text !== undefined
            ? [{ type: 'text' as const, value: text }]
            : m.content,
        isStreaming: false,
        isReasoning: false,
        // 工具阶段取消时，上一轮 chat_complete 已留下 isProcessingTools=true；
        // 取消终态必须一并清掉，否则 busy 会让停止按钮永久卡住。
        isProcessingTools:
          finishReason === 'cancelled' ? false : m.isProcessingTools,
        toolsCompleted:
          finishReason === 'cancelled' ? true : m.toolsCompleted,
        associatedToolCalls:
          finishReason === 'cancelled'
            ? cancelInFlightToolCalls(m.associatedToolCalls)
            : m.associatedToolCalls,
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
        isProcessingTools: toolCalls.some((toolCall) =>
          isToolCallInFlight(toolCall.status),
        ),
        toolsCompleted: !toolCalls.some((toolCall) =>
          isToolCallInFlight(toolCall.status),
        ),
      }));
    }

    case 'session_status': {
      const { sessionId, status } = frame.payload;
      // session_status 是全局运行态的权威源。idle/error 到达后即使 history 带着
      // 旧 transient 标记，也必须收口，否则无任务可取消时停止键仍会复活。
      const nextState =
        status === 'idle' || status === 'error'
          ? settleInFlight(state, sessionId)
          : state;
      const s = nextState.sessions[sessionId];
      if (!s) return nextState;
      return upsertSession(nextState, { ...s, status });
    }

    case 'models_list': {
      // 服务器确认的 current 始终优先（set_model/handleSetModel 发回的权威值）。
      // 仅在服务器未指定 current 时，才回退到前端保留的旧值（保留逻辑：旧值仍有效则保留，否则置 null）。
      const serverCurrent = frame.payload.current;
      const retainedCurrent =
        serverCurrent === undefined &&
        state.currentModel &&
        frame.payload.models.some(
          (model) => model.id === state.currentModel && model.enabled !== false,
        )
          ? state.currentModel
          : null;
      return {
        ...state,
        models: frame.payload.models,
        modelsLoaded: true,
        currentModel: serverCurrent ?? retainedCurrent,
      };
    }

    case 'error':
      // 收口在途消息再落错误：否则流式中途报错时那条 assistant 占位永远 isStreaming=true，
      // busy 卡死、发送键锁在「停止」，用户无法继续对话（见 settleInFlight 注释）。
      return {
        ...settleInFlight(state, frame.payload.sessionId),
        lastError: frame.payload.message,
      };

    case 'feishu_push_result':
      // 同步状态指示（Issue #6）：失败时浮一条错误。
      return frame.payload.ok
        ? state
        : {
            ...state,
            lastError: `飞书回推失败：${frame.payload.error ?? '未知错误'}`,
          };

    case 'slash_commands_list':
      // server 侧命令清单（面板经 mergeServerCommands 合并展示）。
      return { ...state, slashCommands: frame.payload.commands };

    case 'slash_command_result': {
      // 斜杠命令回执 → 追加一条 **ephemeral** 系统气泡（role:'system'）。
      // 有意不落库（见 server handleRunSlashCommand 注释）：它是即时查询回执，
      // 不属于会话内容。因此刷新 / 切走再切回（history 帧整表覆盖）后消失
      // 是设计行为，不是 bug。
      const { sessionId, name, args, ok, markdown } = frame.payload;
      const echo = `\`/${name}${args?.trim() ? ` ${args.trim()}` : ''}\``;
      return appendMessage(state, {
        id: `slash-${Date.now()}-${clientMsgSeq++}`,
        sessionId,
        role: 'system',
        content: [
          {
            type: 'text',
            value: `${echo}\n\n${ok ? '' : '**警告：** '}${markdown}`,
          },
        ],
        timestamp: Date.now(),
        source: 'local',
      });
    }

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
  /** 删除会话（不可逆）。发帧后由 server 广播的 sessions_list 快照落地移除。 */
  deleteSession(sessionId: string): void;
  /** 重命名会话。发帧后由 server 广播的 session_upsert 落地新标题。 */
  renameSession(sessionId: string, title: string): void;
  /**
   * 启动一个专家：起一段新会话（title）并在其选中就绪后注入开场消息（kickoff）。
   * 新会话由 server 回的 session_upsert 关联（首个「未见过的 id」即它），随后自动选中并发送。
   */
  launchExpert(title: string, kickoff: string): void;
  /** v1.7：只提交白名单 profile id，由 server 注入 system prompt；不自动发用户消息。 */
  launchAgentProfile(title: string, agentProfileId: string): void;
  /** 新建绑定 profile 的会话，并在服务端确认会话后发送一次真实用户任务。 */
  launchAgentProfileWithPrompt(
    title: string,
    agentProfileId: string,
    prompt: string,
    source?: MessageSource,
  ): void;
  sendMessage(
    text: string,
    source?: MessageSource,
    attachments?: Attachment[],
    queueAction?: 'merge' | 'next_turn' | 'new_session',
  ): void;
  setModel(model: string): void;
  cancel(): void;
  respondToolConfirmation(
    callId: string,
    outcome: 'approved' | 'rejected' | 'always_approve',
    payload?: ToolConfirmationResponsePayload,
  ): void;
  /**
   * 执行一条 server 侧斜杠命令（当前会话）。结果经 slash_command_result 帧
   * 回来，渲染成 ephemeral 系统气泡（不落库，见 applyFrame 对应分支注释）。
   */
  runSlashCommand(name: string, args: string): void;
  /**
   * 在当前会话本地插入一条系统提示气泡（如 /help 的命令总览）。
   * 纯前端、不发帧不落库——与 slash_command_result 同样的 ephemeral 语义。
   */
  postSystemNote(markdown: string): void;
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
  // 同理用 ref 兜底 connection：sendMessage 是稳定回调（deps 空），需读最新连接态做断连校验。
  const connectionRef = useRef<ConnectionState>(state.connection);
  connectionRef.current = state.connection;
  // 会话 id 列表镜像：onFrame 闭包判断「刚广播的 session_upsert 是不是新会话」需要最新的
  // 已知 id 集，而闭包读不到最新 state，用 ref 兜底。
  const sessionIdsRef = useRef<string[]>([]);
  sessionIdsRef.current = state.sessionIds;
  const sessionsRef = useRef<Record<string, SessionSummary>>({});
  sessionsRef.current = state.sessions;
  const currentModelRef = useRef<string | null>(null);
  currentModelRef.current = state.currentModel;
  // 专家启动关联：launchRef 记「正在等 create_session 回来的新会话 + 开场消息」；新会话到达后
  // 转存到 kickoffRef，等它被选中且连接就绪时再发开场消息（见下方 kickoff effect）。
  const launchRef = useRef<{ kickoff: string; source: MessageSource } | null>(
    null,
  );
  const kickoffRef = useRef<{
    sessionId: string;
    kickoff: string;
    source: MessageSource;
  } | null>(null);
  const profileLaunchRef = useRef<{
    agentProfileId: string;
    kickoff?: string;
    source: MessageSource;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const unsubFrame = transport.onFrame((frame) => {
      dispatch({ kind: 'frame', frame });
      // 🔔 通知：收到非本地来源的消息时弹 OS 原生通知
      if (
        frame.type === 'message_start' &&
        frame.payload.message.role === 'user' &&
        frame.payload.message.source &&
        frame.payload.message.source !== 'local' &&
        frame.payload.message.source !== 'tui'
      ) {
        const msg = frame.payload.message;
        const preview = msg.content
          ?.map((c: { type: string; value?: string; values?: string[] }) =>
            c.type === 'text' ? c.value : c.type === 'file_reference' ? '[文件]' : '')
          .join(' ')?.slice(0, 200) ?? '';
        void window.otto.notificationShow({
          sessionId: msg.sessionId,
          source: msg.source!,
          sender: undefined,
          preview: preview || '(非文本消息)',
        });
      }
      if (frame.type === 'chat_complete' && frame.payload.tokenUsage) {
        const { sessionId, messageId, tokenUsage } = frame.payload;
        try {
          // 用量上报是旁路遥测：会话令牌只在 main 进程持有，任何网络/鉴权失败
          // 都必须被吞掉，绝不能反向污染聊天收口或让用户无法继续对话。
          void window.otto.enterpriseUsageRecord({
            sessionId,
            messageId,
            model: tokenUsage.model
              ?? sessionsRef.current[sessionId]?.model
              ?? currentModelRef.current,
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens,
            totalTokens: tokenUsage.totalTokens,
          }).catch(() => undefined);
        } catch {
          // preload 桥在异常启动阶段不可用时同样保持聊天主链路可用。
        }
      }
      if (frame.type === 'knowledge_activity' && frame.payload.action === 'auto_capture') {
        for (const entry of frame.payload.captured ?? []) {
          try {
            // 组织知识同步同样是旁路：只上传 core 已脱敏、去重并确认写入的条目；
            // 未登录或企业服务暂不可用时不能阻断聊天和个人本地知识库。
            void window.otto.enterpriseKnowledgeRecord({
              sourceId: entry.id,
              category: entry.category,
              content: entry.content,
              confidence: entry.confidence ?? 0.8,
            }).catch(() => undefined);
          } catch {
            // preload 桥在异常启动阶段不可用时保持主链路可用。
          }
        }
      }
      // 专家启动：create_session 之后广播的首个「id 未见过」的 session_upsert 即新会话。
      // sessionIdsRef 此刻仍是「本帧应用前」的已知 id 集（dispatch 异步），故新 id 必不在其中。
      if (
        launchRef.current &&
        frame.type === 'session_upsert' &&
        !sessionIdsRef.current.includes(frame.payload.session.sessionId)
      ) {
        const sid = frame.payload.session.sessionId;
        const spec = launchRef.current;
        launchRef.current = null;
        kickoffRef.current = {
          sessionId: sid,
          kickoff: spec.kickoff,
          source: spec.source,
        };
        dispatch({ kind: 'select', sessionId: sid });
      } else if (
        profileLaunchRef.current &&
        frame.type === 'session_upsert' &&
        frame.payload.session.agentProfileId === profileLaunchRef.current.agentProfileId &&
        !sessionIdsRef.current.includes(frame.payload.session.sessionId)
      ) {
        const sid = frame.payload.session.sessionId;
        const spec = profileLaunchRef.current;
        profileLaunchRef.current = null;
        if (spec.kickoff?.trim()) {
          kickoffRef.current = {
            sessionId: sid,
            kickoff: spec.kickoff.trim(),
            source: spec.source,
          };
        }
        dispatch({ kind: 'select', sessionId: sid });
      }
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
        // 顺带拉 server 侧斜杠命令清单（命令面板合并展示的单一事实源）。
        transport.send({ type: 'list_slash_commands', payload: {} });
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

  // ── 桌面通知订阅：未读闪烁 + 点击跳转 ──
  useEffect(() => {
    const unsubUnread = window.otto.onNotificationUnreadChanged?.((unread) => {
      dispatch({ kind: 'set_unread', sessions: unread });
    }) ?? (() => {});

    const unsubClick = window.otto.onNotificationSessionOpen?.((sessionId) => {
      dispatch({ kind: 'select', sessionId });
      transport.send({ type: 'subscribe', payload: { sessionId } });
      transport.send({ type: 'get_history', payload: { sessionId } });
      // 点击通知后标记该会话已读
      void window.otto.notificationMarkRead(sessionId);
    }) ?? (() => {});

    return () => {
      unsubUnread();
      unsubClick();
    };
  }, []);

  // 专家开场消息发送：等新会话被选中（activeSessionId 命中 kickoffRef）且连接就绪。
  // 声明顺序刻意排在上面的「订阅 + 拉历史」effect 之后——同一次 commit 里 effect 按声明
  // 顺序执行，故发送 send_user_message 时本会话的 subscribe 帧已先行发出，流式回复不漏收。
  // 发完即清空 kickoffRef，保证每次启动只发一次。
  useEffect(() => {
    const pk = kickoffRef.current;
    if (!pk) return;
    if (state.activeSessionId !== pk.sessionId) return;
    if (state.connection !== 'connected') return;
    kickoffRef.current = null;
    const clientMessageId = `c-${Date.now()}-${clientMsgSeq++}`;
    const content: OttoMessage['content'] = [
      { type: 'text', value: pk.kickoff },
    ];
    // 乐观渲染开场消息（server 回的 message_start 会按 id 对账覆盖）。
    dispatch({
      kind: 'optimistic_user',
      message: {
        id: clientMessageId,
        sessionId: pk.sessionId,
        role: 'user',
        content,
        timestamp: Date.now(),
        source: pk.source,
      },
    });
    transport.send({
      type: 'send_user_message',
      payload: {
        sessionId: pk.sessionId,
        content,
        source: pk.source,
        clientMessageId,
      },
    });
  }, [state.activeSessionId, state.connection]);

  const selectSession = useCallback((sessionId: string) => {
    dispatch({ kind: 'select', sessionId });
  }, []);

  const createSession = useCallback((title?: string) => {
    const clientRequestId = crypto.randomUUID();
    dispatch({ kind: 'pending_create', clientRequestId });
    transport.send({ type: 'create_session', payload: { title, clientRequestId } });
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    if (!sessionId) return;
    // 只发帧；移除与 activeSessionId 善后统一由 server 回的 sessions_list 快照落地，
    // 保持「服务器为唯一真相源」，前端不抢先本地删（避免与广播不一致）。
    transport.send({ type: 'delete_session', payload: { sessionId } });
  }, []);

  const renameSession = useCallback((sessionId: string, title: string) => {
    const clean = title.trim();
    // 空白标题不发（server 也会拒），静默忽略即可（UI 侧当作取消）。
    if (!sessionId || !clean) return;
    transport.send({ type: 'rename_session', payload: { sessionId, title: clean } });
  }, []);

  const launchExpert = useCallback((title: string, kickoff: string) => {
    const clean = kickoff.trim();
    if (!clean) return;
    // 断连时不启动：否则会建一个永远收不到回复的空会话。走 toast 明确告知。
    if (connectionRef.current !== 'connected') {
      dispatch({ kind: 'local_error', message: '未连接，无法启动专家' });
      return;
    }
    // 记下待发的开场消息，随后由 onFrame 关联新会话、kickoff effect 择机发送。
    launchRef.current = { kickoff: clean, source: 'local' };
    const clientRequestId = crypto.randomUUID();
    dispatch({ kind: 'pending_create', clientRequestId });
    transport.send({ type: 'create_session', payload: { title, clientRequestId } });
  }, []);

  const launchAgentProfile = useCallback((title: string, agentProfileId: string) => {
    const cleanAgentProfileId = agentProfileId.trim();
    if (!cleanAgentProfileId) return;
    if (connectionRef.current !== 'connected') {
      dispatch({ kind: 'local_error', message: '未连接，无法启动 Agent' });
      return;
    }
    profileLaunchRef.current = {
      agentProfileId: cleanAgentProfileId,
      source: 'local',
    };
    transport.send({
      type: 'create_session',
      payload: { title, agentProfileId: cleanAgentProfileId },
    });
  }, []);

  const launchAgentProfileWithPrompt = useCallback((
    title: string,
    agentProfileId: string,
    prompt: string,
    source: MessageSource = 'local',
  ) => {
    const cleanAgentProfileId = agentProfileId.trim();
    const cleanPrompt = prompt.trim();
    if (!cleanAgentProfileId || !cleanPrompt) return;
    if (connectionRef.current !== 'connected') {
      dispatch({ kind: 'local_error', message: '未连接，无法调用 Otto' });
      return;
    }
    profileLaunchRef.current = {
      agentProfileId: cleanAgentProfileId,
      kickoff: cleanPrompt,
      source,
    };
    transport.send({
      type: 'create_session',
      payload: { title, agentProfileId: cleanAgentProfileId },
    });
  }, []);

  const sendMessage = useCallback(
    (
      text: string,
      source: MessageSource = 'local',
      attachments: Attachment[] = [],
      queueAction?: 'merge' | 'next_turn' | 'new_session',
    ) => {
      const sessionId = activeRef.current;
      const trimmed = text.trim();
      if (!sessionId || (!trimmed && attachments.length === 0)) return;
      if (connectionRef.current !== 'connected') {
        dispatch({ kind: 'local_error', message: '未连接，消息未送达' });
        return;
      }
      const clientMessageId = `c-${Date.now()}-${clientMsgSeq++}`;
      const content: OttoMessage['content'] = [];
      if (trimmed) content.push({ type: 'text', value: trimmed });
      for (const value of attachments) {
        if ('data' in value) {
          content.push({ type: 'image_reference', value: value as ImageAttachment });
        } else {
          content.push({ type: 'file_reference', value: value as FileAttachment });
        }
      }
      dispatch({
        kind: 'optimistic_user',
        message: {
          id: clientMessageId,
          sessionId,
          role: 'user',
          content,
          timestamp: Date.now(),
          source,
        },
      });
      transport.send({
        type: 'send_user_message',
        payload: { sessionId, content, source, clientMessageId, ...(queueAction ? { queueAction } : {}) },
      });
    },
    [],
  );

  const setModel = useCallback((model: string) => {
    const sessionId = activeRef.current;
    if (!sessionId) return;
    // 乐观更新：不等服务器确认，立即更新 UI
    dispatch({ kind: 'set_optimistic_model', model, sessionId });
    transport.send({ type: 'set_model', payload: { sessionId, model } });
  }, []);

  const cancel = useCallback(() => {
    const sessionId = activeRef.current;
    if (!sessionId) return;
    transport.send({ type: 'cancel', payload: { sessionId, clearQueue: true } });
  }, []);

  const respondToolConfirmation = useCallback(
    (
      callId: string,
      outcome: 'approved' | 'rejected' | 'always_approve',
      payload?: ToolConfirmationResponsePayload,
    ) => {
      const sessionId = activeRef.current;
      if (!sessionId) return;
      transport.send({
        type: 'tool_confirmation_response',
        payload: { sessionId, callId, outcome, payload },
      });
    },
    [],
  );

  const runSlashCommand = useCallback((name: string, args: string) => {
    const sessionId = activeRef.current;
    if (!sessionId || !name) return;
    // 断连时不发（帧会积压在 preload 队列里，但用户以为命令已执行）——走 toast 告知。
    if (connectionRef.current !== 'connected') {
      dispatch({ kind: 'local_error', message: '未连接，命令未执行' });
      return;
    }
    transport.send({
      type: 'run_slash_command',
      payload: { sessionId, name, ...(args ? { args } : {}) },
    });
  }, []);

  const postSystemNote = useCallback((markdown: string) => {
    if (!markdown.trim()) return;
    dispatch({ kind: 'system_note', markdown });
  }, []);

  const clearError = useCallback(() => {
    dispatch({ kind: 'clear_error' });
  }, []);

  return {
    state,
    actions: {
      selectSession,
      createSession,
      deleteSession,
      renameSession,
      launchExpert,
      launchAgentProfile,
      launchAgentProfileWithPrompt,
      sendMessage,
      setModel,
      cancel,
      respondToolConfirmation,
      runSlashCommand,
      postSystemNote,
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

/** 全量会话按 updatedAt 倒序（「查看全部对话」检索面板用）。 */
export function selectSortedSessions(state: OttoState): SessionSummary[] {
  return state.sessionIds
    .map((id) => state.sessions[id])
    .filter((s): s is SessionSummary => Boolean(s))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
