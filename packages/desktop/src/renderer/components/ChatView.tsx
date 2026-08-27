/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 主聊天区。spec §主聊天区 + §底部输入区。
 * 顶栏（标题 + 身份/同步状态）/ 消息列表 / 输入区。
 *
 * 飞书会话与本地会话共用这同一条聊天面（Issue #6 双向）：
 * 顶栏显示来源同步状态；输入区发言时按会话来源决定 source，
 * 飞书会话内发言 source='local' → server 回推飞书。
 */

import React, { useEffect, useRef, useState } from 'react';
import type {
  OttoMessage,
  SessionSummary,
  ModelInfo,
  MessageSource,
} from 'otto-server';
import type { Attachment } from '../state/useOttoStore.js';
import { Message } from './Message.js';
import type { RespondQuestionFn } from './ToolCalls.js';
import {
  Composer,
  type ComposerAuthorizationContext,
  type PendingAgentSelection,
} from './Composer.js';
import type { SlashCommand } from './SlashCommands.js';
import { IconArrowDown, IconPanelRight, OttoAvatar } from './icons.js';

import { OttoPetStage } from './OttoPetStage.js';
import {
  PET_WIDGET_PREFERENCE_EVENT,
  readPetWidgetEnabled,
} from '../petWidgetPreference.js';

/** 视口距底多近算「贴底」（px），贴底才自动跟随流式增量。 */
const NEAR_BOTTOM = 80;

const EXAMPLE_PROMPTS = [
  '帮我优化这段登录流程的代码',
  '解释一下这个报错是什么意思',
  '给这个函数补一组单元测试',
];

interface ChatViewProps {
  session: SessionSummary | null;
  messages: OttoMessage[];
  models: ModelInfo[];
  currentModel: string | null;
  busy: boolean;
  onSend: (
    text: string,
    source: MessageSource,
    attachments?: Attachment[],
    authorization?: ComposerAuthorizationContext,
  ) => void | boolean | Promise<void | boolean>;
  /** 中止当前流式生成（busy 时停止按钮）。 */
  onCancel: () => void;
  onSetModel: (model: string) => void;
  onSetWorkspace?: (workspacePath: string) => void;
  /**
   * 重新生成某条 bot 回复：携带被点消息 id，App 据此定位「该条之前最近的
   * 一条用户消息」重发，而非永远重发全会话最后一轮。
   */
  onRegenerate: (messageId: string) => void;
  /** AskUserQuestion 作答回传（透传到消息里的工具问答卡）。 */
  onRespondQuestion?: RespondQuestionFn;
  /** 打开「模型与 BYO-key 设置」面板（接到 Composer 模型菜单的「管理模型」入口）。 */
  onOpenSetup: () => void;
  /** 斜杠命令 `/new`：新建会话（App handleNewChat）。 */
  onNewChat: () => void;
  /** 斜杠命令 `/clear`：清空当前会话上下文。 */
  onClearContext: () => void;
  /** 导出当前会话为 Markdown 文件（真实落盘，对齐 CLI /export）。无会话时隐藏。 */
  onExport?: () => void;
  /** 斜杠命令 `/doctor`：打开设置与诊断中心的「依赖体检」tab。 */
  onOpenDoctor?: () => void;
  /** 斜杠命令 `/feishu` 系列：打开设置与诊断中心的「飞书接入」tab。 */
  onOpenFeishu?: () => void;
  /** 斜杠命令 `/memory`：打开设置与诊断中心的「记忆」tab。 */
  onOpenMemory?: () => void;
  /** 斜杠命令 `/skills`：打开设置与诊断中心的「技能库」tab。 */
  onOpenSkills?: () => void;
  /** 命令表（本地 + server 合并后的完整清单），透传给 Composer 的命令面板。 */
  commands?: readonly SlashCommand[];
  /** server 侧斜杠命令：经 run_slash_command 帧执行。 */
  onRunServerCommand?: (name: string, args: string) => void;
  /** 斜杠命令 `/theme` `/config`：打开设置与诊断中心的「偏好」tab。 */
  onOpenPrefs?: () => void;
  /** 斜杠命令 `/session`：打开「查看全部对话」检索面板。 */
  onOpenSessions?: () => void;
  /** 斜杠命令 `/help`：在聊天区展示命令总览（系统气泡）。 */
  onShowHelp?: () => void;
  /** 斜杠专家入口：创建绑定服务端 profile 的新会话。 */
  onLaunchAgentProfile?: (profileId: string, title: string) => void;
  /** 工作式 UI 的右侧栏状态；仅传入切换动作时显示顶栏入口。 */
  rightPanelCollapsed?: boolean;
  onToggleRightPanel?: () => void;
  pendingAgent?: PendingAgentSelection | null;
  onClearPendingAgent?: () => void;
}

export function ChatView({
  session,
  messages,
  models,
  currentModel,
  busy,
  onSend,
  onCancel,
  onSetModel,
  onSetWorkspace,
  onRegenerate,
  onRespondQuestion,
  onOpenSetup,
  onNewChat,
  onClearContext,
  onExport,
  onOpenDoctor,
  onOpenFeishu,
  onOpenMemory,
  onOpenSkills,
  commands,
  onRunServerCommand,
  onOpenPrefs,
  onOpenSessions,
  onShowHelp,
  onLaunchAgentProfile,
  rightPanelCollapsed = false,
  onToggleRightPanel,
  pendingAgent,
  onClearPendingAgent,
}: ChatViewProps): React.JSX.Element {
  const threadRef = useRef<HTMLDivElement>(null);
  // 用户是否贴在底部（决定流式增量是否自动跟随）。
  const stickRef = useRef(true);
  // 上次见到的消息条数：用来区分「用户主动上翻」与「真·新消息到达」。
  const lastCountRef = useRef(messages.length);
  // 未读：用户离底期间有新消息进来才置真，贴底时清零。浮标只在「离底 + 有未读」时出现。
  const [hasUnread, setHasUnread] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [petWidgetEnabled, setPetWidgetEnabled] = useState(readPetWidgetEnabled);
  // 空态示例胶囊注入 composer 的草稿（每次点击带新 token 触发再注入）。
  const [draft, setDraft] = useState<{ text: string; n: number }>({
    text: '',
    n: 0,
  });
  const isNearBottom = (el: HTMLDivElement): boolean =>
    el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;

  const onThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    stickRef.current = near;
    // 贴底即视为已读，收起浮标；离底时浮标可见性交给 hasUnread 决定（见下方 effect）。
    if (near) {
      setHasUnread(false);
      setShowJump(false);
    } else {
      setShowJump(hasUnread);
    }
    setScrolled(el.scrollTop > 4);
  };

  // 消息变化：贴底则自动跟随到底；离底时——
  //   · 条数增加（真·新消息）→ 标记未读、弹浮标；
  //   · 仅流式增量推高同一条 → 不打扰（条数没变，不弹）。
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const grew = messages.length > lastCountRef.current;
    lastCountRef.current = messages.length;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (grew) {
      setHasUnread(true);
      setShowJump(true);
    }
  }, [messages]);

  // 切换会话 → 重置到底部、收起浮标、清未读。
  useEffect(() => {
    const el = threadRef.current;
    stickRef.current = true;
    setHasUnread(false);
    setShowJump(false);
    setScrolled(false);
    lastCountRef.current = messages.length;
    if (el) el.scrollTop = el.scrollHeight;
    // 仅在会话切换时复位，messages 长度变化由上方 effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sessionId]);

  useEffect(() => {
    const syncPreference = (): void => setPetWidgetEnabled(readPetWidgetEnabled());
    window.addEventListener(PET_WIDGET_PREFERENCE_EVENT, syncPreference);
    return () => window.removeEventListener(PET_WIDGET_PREFERENCE_EVENT, syncPreference);
  }, []);

  const jumpToBottom = () => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stickRef.current = true;
    setHasUnread(false);
    setShowJump(false);
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };

  // 斜杠命令 `/copy`（对齐 CLI）：复制最近一条 Otto 回复的纯文本。
  // 无可复制内容时静默（面板描述已说明语义，空会话点它没有副作用）。
  const copyLastReply = () => {
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!last) return;
    const text = last.content
      .map((p) => (p.type === 'text' ? p.value : ''))
      .join('')
      .trim();
    if (text) copy(text);
  };

  const fillDraft = (text: string) => {
    setDraft((d) => ({ text, n: d.n + 1 }));
  };

  // 飞书会话内发言：source 仍是 'local'（app 内本地输入），
  // server 据会话归属（feishuChatId）决定回推飞书。
  const sendSource: MessageSource = 'local';
  return (
    <section className="otto-main">
      <header
        className={`otto-main__topbar${
          scrolled ? ' otto-main__topbar--scrolled' : ''
        }`}
      >
        <span className="otto-main__title">
          {session?.title ?? 'Otto'}
        </span>

        {session?.source === 'feishu' ? (
          <span className="otto-main__sync">飞书 · 实时同步</span>
        ) : null}

        {onToggleRightPanel ? (
          <button
            type="button"
            className="otto-main__panel-toggle"
            aria-label={rightPanelCollapsed ? '展开右侧栏' : '折叠右侧栏'}
            aria-pressed={!rightPanelCollapsed}
            title={rightPanelCollapsed ? '展开右侧栏' : '折叠右侧栏'}
            onClick={onToggleRightPanel}
          >
            <IconPanelRight size={18} />
          </button>
        ) : null}
      </header>

      <div className="otto-thread" ref={threadRef} onScroll={onThreadScroll}>
        <div className="otto-thread__inner">
          {!session ? (
            <EmptyState />
          ) : messages.length === 0 ? (
            <EmptyConversation onPick={fillDraft} />
          ) : (
            messages.map((m) => (
              <Message
                key={m.id}
                message={m}
                onCopy={copy}
                // 把当前消息 id 一并传出，让 App 定位对应用户轮次而非最新一轮。
                onRegenerate={() => onRegenerate(m.id)}
                onRespondQuestion={onRespondQuestion}
              />
            ))
          )}
        </div>
      </div>

      {showJump ? (
        <button
          type="button"
          className="otto-jump"
          onClick={jumpToBottom}
          aria-label="滚动到最新消息"
        >
          <IconArrowDown size={15} />
          新消息
        </button>
      ) : null}

      {/* 园区服务插件：常驻挂载（右侧面板「园区服务」入口经事件打开弹窗）。 */}


      {petWidgetEnabled ? (
        <OttoPetStage
          variant="widget"
          running={busy}
          workLabel={busy ? '正在处理当前对话' : session ? '等待你的下一项工作' : '准备开始新的对话'}
        />
      ) : null}

      <Composer
        models={models}
        currentModel={currentModel}
        // 切换/新建会话后据此自动聚焦输入框。
        sessionId={session?.sessionId ?? null}
        // 无会话才整体禁用；生成中（busy）由 Composer 把发送按钮换成停止，textarea 仍可输入。
        disabled={!session}
        busy={busy}
        draft={draft.text}
        draftNonce={draft.n}
        onSend={(text, attachments, authorization) => (
          onSend(text, sendSource, attachments, authorization)
        )}
        onCancel={onCancel}
        onSetModel={onSetModel}
        workspacePath={session?.workspacePath}
        onSetWorkspace={onSetWorkspace}
        onManageModels={onOpenSetup}
        // 斜杠命令接线：/new /clear 走 App 回调，/settings 复用打开设置。
        onNewChat={onNewChat}
        onClearContext={onClearContext}
        onOpenSettings={onOpenSetup}
        onOpenDoctor={onOpenDoctor}
        onOpenFeishu={onOpenFeishu}
        onOpenMemory={onOpenMemory}
        onOpenSkills={onOpenSkills}
        onExport={onExport}
        commands={commands}
        onRunServerCommand={onRunServerCommand}
        onOpenPrefs={onOpenPrefs}
        onOpenSessions={onOpenSessions}
        onCopyLast={copyLastReply}
        onShowHelp={onShowHelp}
        onLaunchAgentProfile={onLaunchAgentProfile}
        pendingAgent={pendingAgent}
        onClearPendingAgent={onClearPendingAgent}
      />
    </section>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="otto-empty">
      <OttoAvatar size={56} />
      <div className="otto-empty__title">选择左侧对话，或新建一个</div>
      <div>飞书与本地会话都会实时出现在这里</div>
    </div>
  );
}

function EmptyConversation({
  onPick,
}: {
  onPick: (text: string) => void;
}): React.JSX.Element {
  return (
    <div className="otto-empty">
      <OttoAvatar size={48} />
      <div className="otto-empty__title">给 Otto 发送第一条消息</div>
      <div>试试这些开头，或直接输入你的问题</div>
      <div className="otto-empty__prompts">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            className="otto-prompt-chip"
            onClick={() => onPick(p)}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
