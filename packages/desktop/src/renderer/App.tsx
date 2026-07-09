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
import { SLASH_COMMANDS } from './components/Composer.js';
import {
  mergeServerCommands,
  buildHelpMarkdown,
} from './components/SlashCommands.js';
import { RightPanel } from './components/RightPanel.js';
import { AllConversations } from './components/AllConversations.js';
import { AgentGallery } from './components/AgentGallery.js';
import type { Expert } from './agents/experts.js';
import { SetupPanel } from './setup/SetupPanel.js';
import type { SaveCustomModelPayload } from './setup/presets.js';
import * as transport from './transport.js';
import { useSettingsData } from './state/useSettingsData.js';
import { useSoftwareUpdate } from './state/useSoftwareUpdate.js';
import { SettingsHubPage, type TabId as HubTabId } from './components/SettingsHubPage.js';

/** 启动后静默检查更新的延迟：让 server 连接 / 首屏渲染先跑完，不抢启动窗口。 */
const SILENT_UPDATE_CHECK_DELAY_MS = 15_000;

/** 主内容区当前视图：对话 / 智能体 / 设置 / 设置与诊断中心——均为整页，不再是弹窗浮层。 */
type MainView = 'chat' | 'agents' | 'settings' | 'hub';

export function App(): React.JSX.Element {
  const { state, actions } = useOttoStore();
  // 设置与诊断中心（P0）的独立数据源：settings/mcp/context/stats/doctor/todos。
  const settingsData = useSettingsData();
  // 软件更新状态机：SettingsHub「软件更新」tab 与 Sidebar 入口小圆点共享一份。
  const softwareUpdate = useSoftwareUpdate();

  // 启动后延迟静默检查一次：发现新版只点亮设置入口小圆点（无弹窗），
  // 检查失败保持沉默（silentCheck 内部即如此），绝不打扰用户。
  useEffect(() => {
    const timer = window.setTimeout(
      () => softwareUpdate.actions.silentCheck(),
      SILENT_UPDATE_CHECK_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
    // actions 引用稳定（hook 内 useMemo），只在挂载时安排一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 「查看全部对话」检索面板（仍是浮层） ——
  const [allConvOpen, setAllConvOpen] = useState(false);

  // —— 主内容区视图：对话 / 智能体 / 设置，整页切换（右侧栏常驻）——
  const [mainView, setMainView] = useState<MainView>('chat');
  // 打开「设置与诊断中心」时默认停在哪个 tab（斜杠命令 /doctor /memory /skills 直达用）。
  const [hubInitialTab, setHubInitialTab] = useState<HubTabId>('prefs');
  const openHub = (tab: HubTabId = 'prefs'): void => {
    setHubInitialTab(tab);
    setMainView('hub');
  };
  // setup 页是否打开（由 mainView 派生），供 BYO-key 落盘裁决闭环判定。
  const setupOpen = mainView === 'settings';
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
      setMainView('settings');
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
        setMainView('chat');
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
    setMainView('chat');
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
      if (action === 'new-chat') {
        setMainView('chat');
        actions.createSession();
      } else if (action === 'open-settings') setMainView('settings');
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

  // 重新生成：重发**被点 bot 消息所对应的那一轮用户提问**（保持其来源），而非
  // 永远重发全会话最后一轮。据 messageId 在列表里定位该 bot 消息，往前找最近的
  // 一条用户消息即是它的提问轮次。messageId 缺失/未命中时兜底回退到最后一条用户消息。
  const handleRegenerate = (messageId?: string): void => {
    let target: (typeof activeMessages)[number] | undefined;
    const idx = messageId
      ? activeMessages.findIndex((m) => m.id === messageId)
      : -1;
    if (idx >= 0) {
      // 从被点的 bot 消息往前回溯，命中的第一条用户消息就是这轮的提问。
      for (let i = idx; i >= 0; i--) {
        if (activeMessages[i].role === 'user') {
          target = activeMessages[i];
          break;
        }
      }
    }
    // 兜底：无 id 或未定位到（异常数据）→ 退回最后一条用户消息。
    if (!target) {
      target = [...activeMessages].reverse().find((m) => m.role === 'user');
    }
    if (!target) return;
    const text = target.content
      .map((p) => (p.type === 'text' ? p.value : ''))
      .join('')
      .trim();
    if (text) actions.sendMessage(text, target.source);
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
    setMainView('chat');
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
    setMainView('chat');
    actions.createSession();
  };

  // 启动一个专家：回到对话页 → 起新会话并注入专家开场消息（由 store 关联新会话后自动发送）。
  const handleLaunchExpert = (expert: Expert): void => {
    setMainView('chat');
    actions.launchExpert(expert.name, expert.kickoff);
  };

  // —— 斜杠命令：本地 + server 合并清单 ——
  // server 侧命令由 slash_commands_list 帧下发（单一事实源），与本地面板类命令
  // 合并后传给命令面板；server 新增命令时面板自动出现，两处清单不漂移。
  const slashCommands = useMemo(
    () => mergeServerCommands(SLASH_COMMANDS, state.slashCommands ?? []),
    [state.slashCommands],
  );

  // `/help`：由合并后的完整清单生成命令总览，插一条本地系统气泡（ephemeral）。
  const handleShowHelp = (): void => {
    actions.postSystemNote(buildHelpMarkdown(slashCommands));
  };

  return (
    <div className="otto-app" data-connection={state.connection}>
      <Sidebar
        groups={groups}
        activeSessionId={state.activeSessionId}
        hubActive={mainView === 'hub'}
        updateBadge={softwareUpdate.state.badgeVisible}
        onSelect={(id) => {
          setMainView('chat');
          actions.selectSession(id);
        }}
        onNewChat={handleNewChat}
        onOpenHub={() => openHub('prefs')}
        onViewAll={() => setAllConvOpen(true)}
        onRename={actions.renameSession}
        onDelete={actions.deleteSession}
      />

      {/* 主内容区：设置 / 智能体 / 设置诊断中心 / 对话，整页切换（不再是弹窗）。 */}
      {mainView === 'settings' ? (
        <SetupPanel
          models={state.models}
          saving={saving}
          saveError={saveError}
          onClose={closeSetup}
          onSave={handleSaveModel}
        />
      ) : mainView === 'agents' ? (
        <AgentGallery
          onLaunch={handleLaunchExpert}
          onBack={() => setMainView('chat')}
        />
      ) : mainView === 'hub' ? (
        <SettingsHubPage
          data={settingsData}
          update={softwareUpdate}
          activeSession={activeSession}
          onBack={() => setMainView('chat')}
          initialTab={hubInitialTab}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'row', flex: 1, minWidth: 0, height: '100%' }}>
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
            onRespondQuestion={actions.respondToolConfirmation}
            onOpenSetup={() => setMainView('settings')}
            onNewChat={handleNewChat}
            onClearContext={handleClearContext}
            onExport={
              activeSession
                ? () => settingsData.actions.exportConversation(activeSession.sessionId)
                : undefined
            }
            onOpenDoctor={() => openHub('doctor')}
            onOpenMemory={() => openHub('memory')}
            onOpenSkills={() => openHub('skills')}
            commands={slashCommands}
            onRunServerCommand={actions.runSlashCommand}
            onOpenPrefs={() => openHub('prefs')}
            onOpenSessions={() => setAllConvOpen(true)}
            onShowHelp={handleShowHelp}
          />
          <RightPanel
            onLaunchExpert={handleLaunchExpert}
            onOpenAgents={() => setMainView('agents')}
          />
        </div>
      )}

      {/* 断连 / 重连横幅：WS 非 connected 时浮出，给用户可见反馈。 */}
      {state.connection !== 'connected' ? (
        <div className="otto-conn-banner" role="status" aria-live="polite">
          <span className="otto-conn-banner__dot" aria-hidden />
          {state.connection === 'connecting'
            ? '连接中…'
            : '已断开，正在重连…'}
        </div>
      ) : null}

      {allConvOpen ? (
        <AllConversations
          sessions={selectSortedSessions(state)}
          activeSessionId={state.activeSessionId}
          onSelect={(id) => {
            setMainView('chat');
            actions.selectSession(id);
          }}
          onClose={() => setAllConvOpen(false)}
          onDelete={actions.deleteSession}
        />
      ) : null}

      {state.lastError ? (
        <ErrorToast message={state.lastError} onClose={actions.clearError} />
      ) : null}

      {settingsData.state.exportMessage ? (
        <ErrorToast
          message={settingsData.state.exportMessage}
          onClose={settingsData.actions.clearExportMessage}
        />
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
