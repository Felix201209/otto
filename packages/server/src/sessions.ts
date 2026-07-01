/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话 + 事件存储（唯一会话源）。
 *
 * 一个 Session = 一份会话元数据 + 有序消息列表 + 一组订阅者（WS 客户端）。
 * 底层「跑一轮对话」的 core Config/OttoClient 由实装 agent（Issue #1）在
 * SessionRuntime 里接上；本文件只立「存储 + 订阅广播」的接口与内存实现骨架，
 * 让 server.ts / feishu / desktop 可以先按接口对接。
 *
 * 设计取向（对齐 CLAUDE.md 不可变 + 唯一源）：
 *   - 写操作返回快照，不让外部直接 mutate 内部数组（appendMessage / patchMessage
 *     内部复制）。
 *   - 广播经 publish()：把 ServerToClient 帧推给该会话的所有订阅者。
 */

import { randomUUID } from 'node:crypto';
import type {
  MessageContent,
  MessageSource,
  OttoMessage,
  ServerToClient,
  SessionStatus,
  SessionSummary,
} from './protocol.js';

/** 订阅者回调：收到一帧广播。 */
export type Subscriber = (frame: ServerToClient) => void;

/** 取消订阅句柄。 */
export type Unsubscribe = () => void;

/**
 * 会话运行时挂钩。Issue #1 实装时把 core Config/OttoClient 塞进来；
 * 骨架阶段是可选的 stub，store 不依赖它即可工作。
 */
export interface SessionRuntime {
  /** 跑一轮对话：消费用户消息，产出流式事件（实装时映射成 publish 广播）。 */
  run(input: MessageContent, source: MessageSource): Promise<void>;
  /** 中止当前轮。 */
  cancel(): void;
  /** 设置模型。 */
  setModel(model: string): void;
  /** 释放（关闭 core 资源）。 */
  dispose(): Promise<void>;
}

/** 单个会话的内部状态。 */
interface SessionState {
  summary: SessionSummary;
  messages: OttoMessage[];
  subscribers: Set<Subscriber>;
  runtime?: SessionRuntime;
}

/**
 * 会话存储抽象接口。内存实现见 InMemorySessionStore；落盘版（P1）实现同接口即可热替换。
 */
export interface SessionStore {
  createSession(init?: Partial<SessionSummary>): SessionSummary;
  /** 飞书会话按 chatId 取或建（保证 feishu chatId ↔ session 一一对应）。 */
  getOrCreateFeishuSession(chatId: string, title?: string): SessionSummary;
  getSession(sessionId: string): SessionSummary | undefined;
  listSessions(): SessionSummary[];
  getHistory(sessionId: string, limit?: number, before?: number): OttoMessage[];

  appendMessage(
    sessionId: string,
    msg: Omit<OttoMessage, 'id' | 'sessionId' | 'timestamp'> &
      Partial<Pick<OttoMessage, 'id' | 'timestamp'>>,
  ): OttoMessage;
  patchMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<OttoMessage>,
  ): OttoMessage | undefined;

  setStatus(sessionId: string, status: SessionStatus): void;
  /** 更新会话选定模型（懒构建 runtime 时按此取模型）。 */
  patchSessionModel(sessionId: string, model: string): void;
  attachRuntime(sessionId: string, runtime: SessionRuntime): void;
  getRuntime(sessionId: string): SessionRuntime | undefined;

  /** 订阅会话广播。 */
  subscribe(sessionId: string, fn: Subscriber): Unsubscribe;
  /** 向某会话的所有订阅者推一帧（同时是 desktop 实时更新的入口）。 */
  publish(sessionId: string, frame: ServerToClient): void;

  deleteSession(sessionId: string): Promise<void>;

  /**
   * 订阅「会话被淘汰」事件（容量上限触发的自动回收）。
   * FeishuAdapter 据此摘除它自己持有的回推桥订阅，避免桥订阅泄漏 / 对已淘汰会话仍回推。
   * 返回取消订阅句柄。
   */
  onEvict(cb: (sessionId: string) => void): Unsubscribe;
}

/** InMemorySessionStore 容量上限（防长跑常驻进程内存单调上涨）。 */
export interface InMemorySessionStoreLimits {
  /** 最多保留的会话数（LRU 淘汰最久未更新的）。<=0 表示不限。 */
  maxSessions?: number;
  /** 每个会话最多保留的消息条数（超限丢最旧）。<=0 表示不限。 */
  maxMessagesPerSession?: number;
}

/** 默认容量上限：对内嵌常驻桌面进程足够宽松，又能兜住无界增长。 */
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_MESSAGES_PER_SESSION = 1000;

/**
 * 内存实现（in-memory 起步；落盘走 P1）。
 * 线程模型：Node 单线程，无需锁；异步 run 期间的并发由 runtime 自身守卫。
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  /** feishu chatId → sessionId 索引，保证一一对应。 */
  private readonly feishuIndex = new Map<string, string>();
  /** 会话淘汰监听者（FeishuAdapter 订阅以摘除回推桥）。 */
  private readonly evictListeners = new Set<(sessionId: string) => void>();
  private readonly maxSessions: number;
  private readonly maxMessagesPerSession: number;

  constructor(limits: InMemorySessionStoreLimits = {}) {
    this.maxSessions = limits.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxMessagesPerSession =
      limits.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES_PER_SESSION;
  }

  onEvict(cb: (sessionId: string) => void): Unsubscribe {
    this.evictListeners.add(cb);
    return () => {
      this.evictListeners.delete(cb);
    };
  }

  /**
   * 容量上限超出时按 LRU（最久未更新）淘汰会话，但绝不淘汰刚被写入的 keepId。
   * 复用 deleteSession 的回收语义（dispose runtime + 清 feishuIndex），
   * 并通知 evictListeners 让 FeishuAdapter 摘除回推桥，避免订阅泄漏。
   */
  private enforceSessionCap(keepId: string): void {
    if (this.maxSessions <= 0) return;
    while (this.sessions.size > this.maxSessions) {
      // 选最久未更新（updatedAt 最小）的、且不是刚写入的那个会话淘汰。
      let victimId: string | undefined;
      let oldest = Infinity;
      for (const [id, state] of this.sessions) {
        if (id === keepId) continue;
        if (state.summary.updatedAt < oldest) {
          oldest = state.summary.updatedAt;
          victimId = id;
        }
      }
      if (!victimId) break;
      this.evictSession(victimId);
    }
  }

  /**
   * 同步淘汰单个会话：清 feishuIndex、从 sessions 移除、通知 evictListeners、
   * 并 fire-and-forget dispose runtime（不阻塞同步写路径）。
   */
  private evictSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.summary.feishuChatId) {
      this.feishuIndex.delete(s.summary.feishuChatId);
    }
    this.sessions.delete(sessionId);
    void s.runtime?.dispose().catch(() => undefined);
    for (const cb of this.evictListeners) {
      try {
        cb(sessionId);
      } catch {
        // 单个监听者抛错不影响其余淘汰通知。
      }
    }
  }

  createSession(init: Partial<SessionSummary> = {}): SessionSummary {
    const now = Date.now();
    const sessionId = init.sessionId ?? randomUUID();
    const summary: SessionSummary = {
      sessionId,
      source: init.source ?? 'local',
      title: init.title ?? '新会话',
      feishuChatId: init.feishuChatId,
      status: 'idle',
      model: init.model,
      createdAt: now,
      updatedAt: now,
      lastMessagePreview: undefined,
      messageCount: 0,
    };
    this.sessions.set(sessionId, {
      summary,
      messages: [],
      subscribers: new Set(),
    });
    if (summary.feishuChatId) {
      this.feishuIndex.set(summary.feishuChatId, sessionId);
    }
    // 超出会话上限 → LRU 淘汰最久未更新的（绝不淘汰刚建的这个）。
    this.enforceSessionCap(sessionId);
    return summary;
  }

  getOrCreateFeishuSession(chatId: string, title?: string): SessionSummary {
    const existingId = this.feishuIndex.get(chatId);
    if (existingId) {
      const s = this.sessions.get(existingId);
      if (s) return s.summary;
    }
    return this.createSession({
      source: 'feishu',
      feishuChatId: chatId,
      title: title ?? `飞书会话 ${chatId.slice(0, 8)}`,
    });
  }

  getSession(sessionId: string): SessionSummary | undefined {
    return this.sessions.get(sessionId)?.summary;
  }

  listSessions(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .map((s) => s.summary)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getHistory(sessionId: string, limit?: number, before?: number): OttoMessage[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    let msgs = s.messages;
    if (typeof before === 'number') {
      msgs = msgs.filter((m) => m.timestamp < before);
    }
    if (typeof limit === 'number' && limit > 0) {
      msgs = msgs.slice(-limit);
    }
    // 返回浅拷贝，避免外部 mutate 内部数组。
    return msgs.map((m) => ({ ...m }));
  }

  appendMessage(
    sessionId: string,
    msg: Omit<OttoMessage, 'id' | 'sessionId' | 'timestamp'> &
      Partial<Pick<OttoMessage, 'id' | 'timestamp'>>,
  ): OttoMessage {
    const s = this.requireSession(sessionId);
    const full: OttoMessage = {
      ...msg,
      id: msg.id ?? randomUUID(),
      sessionId,
      timestamp: msg.timestamp ?? Date.now(),
    };
    let nextMessages = [...s.messages, full];
    // 超出每会话消息上限 → 丢最旧（FIFO），防超长会话内存单调上涨。
    if (
      this.maxMessagesPerSession > 0 &&
      nextMessages.length > this.maxMessagesPerSession
    ) {
      nextMessages = nextMessages.slice(
        nextMessages.length - this.maxMessagesPerSession,
      );
    }
    s.messages = nextMessages;
    s.summary = {
      ...s.summary,
      updatedAt: full.timestamp,
      messageCount: s.messages.length,
      lastMessagePreview: previewOf(full),
    };
    return { ...full };
  }

  patchMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<OttoMessage>,
  ): OttoMessage | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const idx = s.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return undefined;
    const updated: OttoMessage = { ...s.messages[idx], ...patch };
    const next = [...s.messages];
    next[idx] = updated;
    s.messages = next;
    s.summary = {
      ...s.summary,
      updatedAt: Date.now(),
      lastMessagePreview: previewOf(updated),
    };
    return { ...updated };
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.summary = { ...s.summary, status, updatedAt: Date.now() };
    this.publish(sessionId, {
      type: 'session_status',
      payload: { sessionId, status },
    });
  }

  patchSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.summary = { ...s.summary, model, updatedAt: Date.now() };
    this.publish(sessionId, {
      type: 'session_upsert',
      payload: { session: s.summary },
    });
  }

  attachRuntime(sessionId: string, runtime: SessionRuntime): void {
    const s = this.requireSession(sessionId);
    s.runtime = runtime;
  }

  getRuntime(sessionId: string): SessionRuntime | undefined {
    return this.sessions.get(sessionId)?.runtime;
  }

  subscribe(sessionId: string, fn: Subscriber): Unsubscribe {
    const s = this.requireSession(sessionId);
    s.subscribers.add(fn);
    return () => {
      s.subscribers.delete(fn);
    };
  }

  publish(sessionId: string, frame: ServerToClient): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const fn of s.subscribers) {
      try {
        fn(frame);
      } catch {
        // 单个订阅者抛错不影响其余广播。
      }
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    await s.runtime?.dispose().catch(() => undefined);
    if (s.summary.feishuChatId) {
      this.feishuIndex.delete(s.summary.feishuChatId);
    }
    this.sessions.delete(sessionId);
  }

  private requireSession(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) {
      throw new Error(`session not found: ${sessionId}`);
    }
    return s;
  }
}

/** 从消息内容里取一段预览文本（用于会话列表 lastMessagePreview）。 */
function previewOf(msg: OttoMessage): string {
  const text = msg.content
    .map((p) => (p.type === 'text' ? p.value : `[${p.type}]`))
    .join(' ')
    .trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
