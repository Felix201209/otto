/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 主聊天区。spec §主聊天区 + §底部输入区。
 * 顶栏（标题 + 同步状态 + 用户头像 F）/ 消息列表 / 输入区。
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
import type { ImageAttachment } from '../state/useOttoStore.js';
import { Message } from './Message.js';
import type { RespondQuestionFn } from './ToolCalls.js';
import { Composer } from './Composer.js';
import type { SlashCommand } from './SlashCommands.js';
import { IconArrowDown, IconMoon, IconSun } from './icons.js';
import { ParkServicesPlugin } from './ParkServicesPlugin.js';

/**
 * 顶栏黑/白底色一键切换（Jeremy）。点击在浅色/深色间切换（nativeTheme IPC，
 * 立即生效并持久化）；初始若是「跟随系统」，按系统当前实际深浅决定切换方向。
 * 图标显示「点击后会变成的模式」：浅色时显示月亮（点了变深色），反之太阳。
 */
function ThemeToggle(): React.JSX.Element {
  // matchMedia 防御可选：jsdom（单测环境）没有该 API。
  const [dark, setDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );

  // 跟随实际渲染态（含在偏好面板里改主题、或跟随系统时 OS 切换的情况）。
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent): void => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggle = (): void => {
    void window.otto?.themeSet?.(dark ? 'light' : 'dark');
  };

  return (
    <button
      type="button"
      className="otto-topbar-theme"
      onClick={toggle}
      title={dark ? '切换到浅色' : '切换到深色'}
      aria-label={dark ? '切换到浅色' : '切换到深色'}
    >
      {dark ? <IconSun size={15} /> : <IconMoon size={15} />}
    </button>
  );
}

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
  userInitial: string;
  busy: boolean;
  /** 服务端权威身份；个人版不伪造部门，企业版显示真实角色。 */
  identityLabel?: string;
  modelManagementLabel?: string;
  onSend: (
    text: string,
    source: MessageSource,
    attachments?: ImageAttachment[],
  ) => void;
  /** 中止当前流式生成（busy 时停止按钮）。 */
  onCancel: () => void;
  onSetModel: (model: string) => void;
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
}

export function ChatView({
  session,
  messages,
  models,
  currentModel,
  userInitial,
  busy,
  identityLabel = '个人版 · Otto',
  modelManagementLabel = '模型与个人 API 设置',
  onSend,
  onCancel,
  onSetModel,
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

        {/* 服务端权威身份：个人版不伪造部门，企业版来自签名加入/管理者建档。 */}
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '3px 10px',
            fontSize: '11px',
            fontWeight: 500,
            color: 'var(--otto-text-secondary)',
            background: 'var(--otto-surface)',
            border: '1px solid var(--otto-border)',
            borderRadius: 'var(--otto-radius-sm)',
            whiteSpace: 'nowrap',
            opacity: 0.8,
          }}
          title="当前产品身份"
        >
          {identityLabel}
        </span>

        {session?.source === 'feishu' ? (
          <span className="otto-main__sync">飞书 · 实时同步</span>
        ) : null}
        <div className="otto-topbar__actions">
          <ThemeToggle />
          {session && onExport ? (
            <button
              type="button"
              className="otto-topbar-export"
              onClick={onExport}
              title="导出会话为 Markdown"
              aria-label="导出会话为 Markdown"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 3v12m0 0-4-4m4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}
          <button
            type="button"
            className="otto-topbar-setup"
            onClick={onOpenSetup}
            title={modelManagementLabel}
            aria-label={modelManagementLabel}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="1.6" />
              <path d="M19.4 13a7.6 7.6 0 0 0 .05-2l1.7-1.32-1.9-3.3-2.05.82a7.6 7.6 0 0 0-1.73-1l-.31-2.17H10.8l-.31 2.17a7.6 7.6 0 0 0-1.73 1l-2.05-.82-1.9 3.3L6.5 11a7.6 7.6 0 0 0 0 2l-1.7 1.32 1.9 3.3 2.06-.82c.53.4 1.11.74 1.73 1l.31 2.17h2.38l.31-2.17c.62-.26 1.2-.6 1.73-1l2.06.82 1.9-3.3L19.4 13Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          </button>
          <span className="otto-user-avatar" title="当前用户">
            {userInitial}
          </span>
        </div>
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

      {/* 园区服务插件：常驻挂载（右侧面板「园区 AI 服务」入口经事件打开弹窗）。 */}
      <ParkServicesPlugin />

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
        onSend={(text, attachments) => onSend(text, sendSource, attachments)}
        onCancel={onCancel}
        onSetModel={onSetModel}
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
      />
    </section>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="otto-empty">
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
