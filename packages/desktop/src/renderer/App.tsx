/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 顶层 App。单窗布局（docs/otto-desktop-ui-spec.md 为唯一基准）：
 *   左 Sidebar（会话列表 + 来源徽章） + 主 ChatView（顶栏/消息流/工具卡/输入区）。
 *
 * 飞书与本地会话共用同一聊天面（Issue #6 在 Sidebar/ChatView 内联实现：
 * 源徽章 + 顶栏「飞书·实时同步」指示），不再有独立 tab。
 * 状态/传输走 useOttoStore（preload WS ↔ otto-server，协议见 packages/server/src/protocol.ts）。
 *
 * 已接：会话分组列表（今天/昨天）、选择/新建会话、发消息（乐观渲染）、模型选择、
 *       流式回复、工具调用卡（含 diff）、错误 toast、setup/BYO-key 图形引导（Issue #7，
 *       SetupPanel 完整向导 + save_custom_model 落盘闭环）、断连/重连横幅、流式停止。
 * 待办：附件入站；slash 命令面板；「查看全部对话」检索视图（onViewAll 仍为空 TODO）。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import './styles/tokens.css';
import './styles/app.css';
import type { MessageSource } from 'otto-server';
import {
  useOttoStore,
  groupSessions,
  selectSortedSessions,
} from './state/useOttoStore.js';
import type { ImageAttachment } from './state/useOttoStore.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatView } from './components/ChatView.js';
import { AllConversations } from './components/AllConversations.js';
import { SetupPanel } from './setup/SetupPanel.js';
import type { SaveCustomModelPayload } from './setup/presets.js';
import * as transport from './transport.js';

export function App(): React.JSX.Element {
  const { state, actions } = useOttoStore();

  // —— 「查看全部对话」检索面板 ——
  const [allConvOpen, setAllConvOpen] = useState(false);

  // —— setup / BYO-key 引导（Issue #7）——
  const [setupOpen, setSetupOpen] = useState(false);
  // setup 落盘的实时态：'idle' | 'saving' | 失败时存错误文案。
  // 由 App 在 setupOpen 期间临时监听原始帧驱动（models_list=成功 / error(save_failed)=失败），
  // 不污染全局 lastError，也不动 store 的 error 落地逻辑。
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 首启无模型时自动浮出一次（用 ref 防止反复弹）。
  const autoFloated = useRef(false);
  useEffect(() => {
    if (
      !autoFloated.current &&
      state.connection === 'connected' &&
      state.modelsLoaded &&
      state.models.length === 0
    ) {
      autoFloated.current = true;
      setSetupOpen(true);
    }
  }, [state.connection, state.modelsLoaded, state.models.length]);

  // setup 落盘闭环：仅当面板打开且**本次保存进行中（saving）**时，才让裁决帧驱动面板开合。
  //   models_list  → 本次落盘成功（server 写盘后广播最新列表）→ 关面板。
  //   error(save_failed) → 落盘失败 → 面板内提示，不关。
  // 加 saving 闸门的原因：models_list 还会因 get_models 回包、或其它客户端（如 TUI）
  // save_custom_model 成功后的 broadcastAll 而到来；若不区分「是不是本次保存」，这些与本次
  // 无关的广播会把用户正在填 key 的面板意外关掉、丢掉输入。只认 saving=true 之后的裁决帧。
  useEffect(() => {
    if (!setupOpen || !saving) return;
    const off = transport.onFrame((frame) => {
      if (frame.type === 'models_list') {
        setSaving(false);
        setSaveError(null);
        setSetupOpen(false);
      } else if (
        frame.type === 'error' &&
        frame.payload.code === 'save_failed'
      ) {
        setSaving(false);
        setSaveError(frame.payload.message || '保存失败，请重试');
      }
    });
    return off;
  }, [setupOpen, saving]);

  // 关面板时复位落盘态，避免下次打开残留旧错误/转圈。
  const closeSetup = (): void => {
    setSetupOpen(false);
    setSaving(false);
    setSaveError(null);
  };

  // 提交一个自定义模型：发结构化帧，进入「保存中」，由上面的帧监听裁决结果。
  const handleSaveModel = (payload: SaveCustomModelPayload): void => {
    setSaveError(null);
    setSaving(true);
    transport.send({ type: 'save_custom_model', payload });
  };

  // —— 首启/新建自动引导 ——
  // 连上且会话列表已知晓（sessionsLoaded）后：
  //   · 若一个会话都没有且本次尚未引导过 → 建一个现成会话（首启即可直接打字，消除死路）；
  //   · 否则若无选中但有会话 → 选中第一个。
  // 用 ref 记「本次会话内是否已引导过」，避免 sessions_list 反复到达时重复建会话。
  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (state.connection !== 'connected' || !state.sessionsLoaded) return;
    if (state.sessionIds.length === 0) {
      if (!bootstrappedRef.current) {
        bootstrappedRef.current = true;
        actions.createSession();
      }
      return;
    }
    // 有会话：标记已引导（防止之后清空又误建），无选中则补选第一个。
    bootstrappedRef.current = true;
    if (!state.activeSessionId) {
      actions.selectSession(state.sessionIds[0]);
    }
  }, [
    state.connection,
    state.sessionsLoaded,
    state.sessionIds,
    state.activeSessionId,
    actions,
  ]);

  // —— 应用菜单 IPC ——
  // 主进程菜单（File→New Chat / Settings…，含 Cmd+N、Cmd+,）经 transport.onMenu 广播 action。
  // 订阅并路由：'new-chat'→新建会话；'open-settings'→打开 setup。卸载时取消订阅。
  useEffect(() => {
    const off = transport.onMenu((action) => {
      if (action === 'new-chat') actions.createSession();
      else if (action === 'open-settings') setSetupOpen(true);
    });
    return off;
  }, [actions]);

  const groups = useMemo(() => groupSessions(state), [state]);

  const activeSession = state.activeSessionId
    ? state.sessions[state.activeSessionId] ?? null
    : null;
  const activeMessages = state.activeSessionId
    ? state.messages[state.activeSessionId] ?? []
    : [];

  // 忙碌态：有消息在流式输出或正在跑工具时禁用输入。
  const busy = activeMessages.some((m) => m.isStreaming || m.isProcessingTools);

  // 重新生成：重发当前会话最后一条用户消息（保持其来源）。
  const handleRegenerate = (): void => {
    const lastUser = [...activeMessages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    const text = lastUser.content
      .map((p) => (p.type === 'text' ? p.value : ''))
      .join('')
      .trim();
    if (text) actions.sendMessage(text, lastUser.source);
  };

  const handleSend = (
    text: string,
    source: MessageSource,
    attachments?: ImageAttachment[],
  ): void => {
    actions.sendMessage(text, source, attachments);
  };

  // 新建对话：若已存在一个「无消息的空会话」，直接复用（选中它）而非再建一个，
  // 避免连点堆出一串空壳。找不到才真正新建。
  const handleNewChat = (): void => {
    const empty = state.sessionIds
      .map((id) => state.sessions[id])
      .find(
        (s) =>
          Boolean(s) &&
          s.messageCount === 0 &&
          (state.messages[s.sessionId]?.length ?? 0) === 0,
      );
    if (empty) {
      actions.selectSession(empty.sessionId);
      return;
    }
    actions.createSession();
  };

  // 斜杠命令 /clear：清空当前会话上下文。store/协议目前没有「清空历史」能力
  // （reducer 无 clear 帧、server 协议也未定义），为不改协议/后端，退化为「新建会话」——
  // 语义上等价于「开一段全新的、没有上文的对话」，是最小可行方案。
  const handleClearContext = (): void => {
    actions.createSession();
  };

  return (
    <div className="otto-app" data-connection={state.connection}>
      <Sidebar
        groups={groups}
        activeSessionId={state.activeSessionId}
        onSelect={actions.selectSession}
        onNewChat={handleNewChat}
        onViewAll={() => setAllConvOpen(true)}
      />
      <ChatView
        session={activeSession}
        messages={activeMessages}
        models={state.models}
        currentModel={state.currentModel}
        userInitial="F"
        busy={busy}
        onSend={handleSend}
        onCancel={actions.cancel}
        onSetModel={actions.setModel}
        onRegenerate={handleRegenerate}
        onOpenSetup={() => setSetupOpen(true)}
        onNewChat={handleNewChat}
        onClearContext={handleClearContext}
      />

      {/* 断连 / 重连横幅：WS 非 connected 时浮出，给用户可见反馈。 */}
      {state.connection !== 'connected' ? (
        <div className="otto-conn-banner" role="status" aria-live="polite">
          <span className="otto-conn-banner__dot" aria-hidden />
          {state.connection === 'connecting'
            ? '连接中…'
            : '已断开，正在重连…'}
        </div>
      ) : null}

      {/* 不显眼的设置入口：右上角齿轮，常驻打开 BYO-key 引导。 */}
      <button
        type="button"
        className="otto-setup-launch"
        onClick={() => setSetupOpen(true)}
        title="模型与 BYO-key 设置"
        aria-label="模型与 BYO-key 设置"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path
            d="M19.4 13a7.6 7.6 0 0 0 .05-2l1.7-1.32-1.9-3.3-2.05.82a7.6 7.6 0 0 0-1.73-1l-.31-2.17H10.8l-.31 2.17a7.6 7.6 0 0 0-1.73 1l-2.05-.82-1.9 3.3L6.5 11a7.6 7.6 0 0 0 0 2l-1.7 1.32 1.9 3.3 2.06-.82c.53.4 1.11.74 1.73 1l.31 2.17h2.38l.31-2.17c.62-.26 1.2-.6 1.73-1l2.06.82 1.9-3.3L19.4 13Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {allConvOpen ? (
        <AllConversations
          sessions={selectSortedSessions(state)}
          activeSessionId={state.activeSessionId}
          onSelect={actions.selectSession}
          onClose={() => setAllConvOpen(false)}
        />
      ) : null}

      {setupOpen ? (
        <SetupPanel
          models={state.models}
          saving={saving}
          saveError={saveError}
          onClose={closeSetup}
          onSave={handleSaveModel}
        />
      ) : null}

      {state.lastError ? (
        <ErrorToast message={state.lastError} onClose={actions.clearError} />
      ) : null}
    </div>
  );
}

/** 错误 toast：带关闭按钮，且 6s 后自动消失。 */
function ErrorToast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}): React.JSX.Element {
  // message 变化即重置计时（新错误重新计 6s）。
  useEffect(() => {
    const t = window.setTimeout(onClose, 6000);
    return () => window.clearTimeout(t);
  }, [message, onClose]);

  return (
    <div className="otto-toast" role="alert">
      <span className="otto-toast__msg">{message}</span>
      <button
        type="button"
        className="otto-toast__close"
        onClick={onClose}
        aria-label="关闭提示"
        title="关闭"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M6 6l12 12M18 6L6 18"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
