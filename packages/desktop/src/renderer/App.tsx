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
 *       流式回复、工具调用卡（含 diff）、错误 toast。
 * 待办：setup/BYO-key 图形引导（Issue #7，SetupPanel 仍为占位）；附件入站；slash 命令面板；
 *       「查看全部对话」检索视图。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import './styles/tokens.css';
import './styles/app.css';
import type { MessageSource } from 'otto-server';
import { useOttoStore, groupSessions } from './state/useOttoStore.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatView } from './components/ChatView.js';
import { SetupPanel } from './setup/SetupPanel.js';
import type { SaveCustomModelPayload } from './setup/presets.js';
import * as transport from './transport.js';

export function App(): React.JSX.Element {
  const { state, actions } = useOttoStore();

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
      state.models.length === 0
    ) {
      autoFloated.current = true;
      setSetupOpen(true);
    }
  }, [state.connection, state.models.length]);

  // setup 落盘闭环：面板打开且处于「保存中」时，监听原始帧裁决成功/失败。
  //   models_list  → 落盘成功（server 写盘后广播最新列表）→ 关面板。
  //   error(save_failed) → 落盘失败 → 面板内提示，不关。
  useEffect(() => {
    if (!setupOpen) return;
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
  }, [setupOpen]);

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

  const handleSend = (text: string, source: MessageSource): void => {
    actions.sendMessage(text, source);
  };

  return (
    <div className="otto-app" data-connection={state.connection}>
      <Sidebar
        groups={groups}
        activeSessionId={state.activeSessionId}
        onSelect={actions.selectSession}
        onNewChat={() => actions.createSession()}
        onViewAll={() => {
          /* TODO(Issue#7 之后): 全部对话检索视图 */
        }}
      />
      <ChatView
        session={activeSession}
        messages={activeMessages}
        models={state.models}
        currentModel={state.currentModel}
        userInitial="F"
        busy={busy}
        onSend={handleSend}
        onSetModel={actions.setModel}
        onRegenerate={handleRegenerate}
        onOpenSetup={() => setSetupOpen(true)}
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
