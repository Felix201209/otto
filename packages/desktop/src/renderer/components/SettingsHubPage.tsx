/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 设置与诊断中心（P0）。TUI /config、/context、/stats、/mcp、/doctor、/todo
 * 的 GUI 真实对应面板（不是发提示词代理，直连协议帧真实数据）。
 *
 * 结构：整页 + 顶部 tab 切换（与 AgentGallery 同一套「整页非弹窗」范式）：
 *   偏好设置 | MCP 服务器 | Context 用量 | 用量统计 | 依赖体检 | 任务清单
 *
 * 数据源：useSettingsData（独立于聊天 store 的 hook），每个 tab 首次打开时
 * 拉一次对应数据；用户主动点刷新按钮可重拉。
 */

import React, { useEffect, useState } from 'react';
import type { SessionSummary } from 'otto-server';
import type { UseSettingsData } from '../state/useSettingsData.js';
import { IconSettings, IconChevron, IconCheck, IconClose } from './icons.js';

export type TabId =
  | 'prefs'
  | 'mcp'
  | 'context'
  | 'stats'
  | 'doctor'
  | 'todos'
  | 'memory'
  | 'skills'
  | 'tools'
  | 'workflows'
  | 'extensions'
  | 'ide';

const TAB_LABEL: Record<TabId, string> = {
  prefs: '偏好设置',
  mcp: 'MCP 服务器',
  context: 'Context 用量',
  stats: '用量统计',
  doctor: '依赖体检',
  todos: '任务清单',
  memory: '记忆',
  skills: '技能库',
  tools: '工具清单',
  workflows: 'Workflow',
  extensions: '扩展',
  ide: 'IDE 伴生',
};

const TABS: TabId[] = [
  'prefs',
  'mcp',
  'context',
  'stats',
  'doctor',
  'todos',
  'memory',
  'skills',
  'tools',
  'workflows',
  'extensions',
  'ide',
];

interface SettingsHubPageProps {
  data: UseSettingsData;
  activeSession: SessionSummary | null;
  onBack: () => void;
  /** 打开面板时默认停在哪个 tab（如从斜杠命令 /doctor /memory /skills 直达）。缺省「偏好设置」。 */
  initialTab?: TabId;
}

export function SettingsHubPage({
  data,
  activeSession,
  onBack,
  initialTab,
}: SettingsHubPageProps): React.JSX.Element {
  const [tab, setTab] = useState<TabId>(initialTab ?? 'prefs');
  const { state, actions } = data;

  // 打开面板即拉一次偏好设置（最常用 tab）。
  useEffect(() => {
    actions.refreshSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切 tab 时按需拉取对应数据（首次进入该 tab 才拉，避免每次切换都打一遍所有请求）。
  useEffect(() => {
    if (tab === 'mcp') actions.refreshMcpServers();
    else if (tab === 'context' && activeSession) {
      actions.refreshContextBreakdown(activeSession.sessionId);
    } else if (tab === 'stats') actions.refreshStats();
    else if (tab === 'todos') actions.refreshTodos();
    else if (tab === 'memory') actions.refreshMemory();
    else if (tab === 'skills') actions.refreshSkills();
    else if (tab === 'tools' && activeSession) {
      actions.refreshTools(activeSession.sessionId);
    } else if (tab === 'workflows') actions.refreshWorkflows();
    else if (tab === 'extensions') actions.refreshExtensions();
    else if (tab === 'ide') actions.refreshIdeStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeSession?.sessionId]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onBack();
    }
  };

  return (
    <section className="otto-hub-page" aria-label="设置与诊断中心" onKeyDown={onKeyDown}>
      <header className="otto-hub__head">
        <IconSettings size={20} className="otto-hub__headicon" />
        <div className="otto-hub__headtext">
          <div className="otto-hub__title">设置与诊断中心</div>
          <div className="otto-hub__subtitle">
            风格 / 健康提醒 / 语言 · MCP 服务器 · Context 用量 · 用量统计 · 依赖体检 · 任务清单 · 记忆 · 技能库 · 工具清单 · Workflow · 扩展 · IDE 伴生
          </div>
        </div>
        <button
          type="button"
          className="otto-hub__back"
          onClick={onBack}
          title="返回对话"
          aria-label="返回对话"
        >
          <IconChevron size={14} className="otto-hub__back-chev" />
          返回对话
        </button>
      </header>

      <div className="otto-hub__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={'otto-hub__tab' + (tab === t ? ' is-active' : '')}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {state.lastError ? (
        <div className="otto-hub__errbar" role="alert">
          <span>{state.lastError}</span>
          <button type="button" onClick={actions.clearError} aria-label="关闭">
            <IconClose size={12} />
          </button>
        </div>
      ) : null}

      <div className="otto-hub__scroll">
        {tab === 'prefs' ? <PrefsPanel data={data} /> : null}
        {tab === 'mcp' ? <McpPanel data={data} /> : null}
        {tab === 'context' ? (
          <ContextPanel data={data} activeSession={activeSession} />
        ) : null}
        {tab === 'stats' ? <StatsPanel data={data} /> : null}
        {tab === 'doctor' ? <DoctorPanel data={data} /> : null}
        {tab === 'todos' ? <TodosPanel data={data} /> : null}
        {tab === 'memory' ? <MemoryPanel data={data} /> : null}
        {tab === 'skills' ? <SkillsPanel data={data} /> : null}
        {tab === 'tools' ? <ToolsPanel data={data} activeSession={activeSession} /> : null}
        {tab === 'workflows' ? <WorkflowsPanel data={data} /> : null}
        {tab === 'extensions' ? <ExtensionsPanel data={data} /> : null}
        {tab === 'ide' ? <IdePanel data={data} /> : null}
      </div>
    </section>
  );
}

// ── 偏好设置 ──────────────────────────────────────────────────────────────

const AGENT_STYLES: Array<{ id: string; label: string; icon: string }> = [
  { id: 'default', label: 'Default (Claude 风格)', icon: '𝓥' },
  { id: 'codex', label: 'Codex（快速静默执行）', icon: '⚡' },
  { id: 'cursor', label: 'Cursor（语义搜索优先）', icon: '↗️' },
  { id: 'augment', label: 'Augment（任务列表驱动）', icon: '🚀' },
  { id: 'claude-code', label: 'Claude Code（极简）', icon: '✳️' },
  { id: 'antigravity', label: 'Antigravity（知识库优先）', icon: '🌈' },
  { id: 'windsurf', label: 'Windsurf（AI Flow）', icon: '🌊' },
];

function PrefsPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const s = state.settings;
  const [langDraft, setLangDraft] = useState('');

  useEffect(() => {
    setLangDraft(s?.preferredLanguage ?? '');
  }, [s?.preferredLanguage]);

  if (!s) {
    return <div className="otto-hub__empty">正在加载偏好设置…</div>;
  }

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__field">
        <div className="otto-hub__field-label">Agent 风格</div>
        <div className="otto-hub__field-hint">
          决定 Otto 的工作方式：计划详略、确认频率、输出风格。
        </div>
        <div className="otto-hub__chiprow">
          {AGENT_STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              className={
                'otto-hub__chip' + (s.agentStyle === style.id ? ' is-active' : '')
              }
              onClick={() => actions.setSetting('agentStyle', style.id)}
            >
              <span aria-hidden>{style.icon}</span> {style.label}
            </button>
          ))}
        </div>
      </div>

      <div className="otto-hub__field">
        <div className="otto-hub__field-label">健康使用提醒</div>
        <div className="otto-hub__field-hint">深夜/长时间使用时收到善意提醒。</div>
        <button
          type="button"
          className={'otto-hub__toggle' + (s.healthyUse ? ' is-on' : '')}
          onClick={() => actions.setSetting('healthyUse', !s.healthyUse)}
          aria-pressed={s.healthyUse}
        >
          <span className="otto-hub__toggle-knob" />
          {s.healthyUse ? '已开启' : '已关闭'}
        </button>
      </div>

      <div className="otto-hub__field">
        <div className="otto-hub__field-label">偏好语言</div>
        <div className="otto-hub__field-hint">
          影响 Otto 回复所用的语言（留空 = 跟随对话自动判断）。
        </div>
        <div className="otto-hub__inputrow">
          <input
            className="otto-hub__input"
            type="text"
            value={langDraft}
            placeholder="例如：中文 / English / 日本語"
            onChange={(e) => setLangDraft(e.target.value)}
          />
          <button
            type="button"
            className="otto-hub__btn"
            onClick={() => actions.setSetting('preferredLanguage', langDraft.trim())}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ── MCP 服务器 ────────────────────────────────────────────────────────────

function statusDot(status: 'connected' | 'connecting' | 'disconnected'): string {
  return status === 'connected' ? '🟢' : status === 'connecting' ? '🟡' : '⚪';
}

function McpPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [urlField, setUrlField] = useState('');

  const submit = (): void => {
    const cleanName = name.trim();
    if (!cleanName) return;
    const cleanCommand = command.trim();
    const cleanUrl = urlField.trim();
    if (!cleanCommand && !cleanUrl) return;
    actions.addMcpServer({
      name: cleanName,
      ...(cleanCommand ? { command: cleanCommand, args: [] } : {}),
      ...(cleanUrl ? { httpUrl: cleanUrl } : {}),
    });
    setName('');
    setCommand('');
    setUrlField('');
    setOpen(false);
  };

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__toolbar">
        <button type="button" className="otto-hub__btn" onClick={actions.refreshMcpServers}>
          刷新
        </button>
        <button
          type="button"
          className="otto-hub__btn otto-hub__btn--primary"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '取消' : '+ 添加服务器'}
        </button>
      </div>

      {open ? (
        <div className="otto-hub__addform">
          <input
            className="otto-hub__input"
            placeholder="服务器名（唯一标识）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="otto-hub__input"
            placeholder="启动命令（stdio，如 npx @my/server）"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <input
            className="otto-hub__input"
            placeholder="或 HTTP URL（与命令二选一）"
            value={urlField}
            onChange={(e) => setUrlField(e.target.value)}
          />
          <button type="button" className="otto-hub__btn otto-hub__btn--primary" onClick={submit}>
            确认添加
          </button>
        </div>
      ) : null}

      {state.mcpServers.length === 0 ? (
        <div className="otto-hub__empty">尚未配置任何 MCP 服务器。</div>
      ) : (
        <div className="otto-hub__list">
          {state.mcpServers.map((s) => (
            <div key={s.name} className="otto-hub__row">
              <span aria-hidden>{statusDot(s.status)}</span>
              <span className="otto-hub__row-name">{s.name}</span>
              <span className="otto-hub__row-detail">
                {s.command ?? s.httpUrl ?? s.url ?? ''}
              </span>
              <span className="otto-hub__row-status">{s.status}</span>
              <button
                type="button"
                className="otto-hub__row-remove"
                onClick={() => actions.removeMcpServer(s.name)}
                aria-label={'移除 ' + s.name}
              >
                <IconClose size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Context 用量 ──────────────────────────────────────────────────────────

function ContextPanel({
  data,
  activeSession,
}: {
  data: UseSettingsData;
  activeSession: SessionSummary | null;
}): React.JSX.Element {
  const { state, actions } = data;
  const b = state.contextBreakdown;

  if (!activeSession) {
    return <div className="otto-hub__empty">请先选择一个会话。</div>;
  }
  if (!b || b.sessionId !== activeSession.sessionId) {
    return (
      <div className="otto-hub__empty">
        正在加载 context 用量…
        <button
          type="button"
          className="otto-hub__btn"
          onClick={() => actions.refreshContextBreakdown(activeSession.sessionId)}
        >
          刷新
        </button>
      </div>
    );
  }

  const segments: Array<{ label: string; value: number; cls: string }> = [
    { label: 'System Prompt', value: b.systemPromptTokens, cls: 'sys' },
    { label: '工具定义', value: b.systemToolsTokens, cls: 'tools' },
    { label: '记忆文件', value: b.memoryFilesTokens, cls: 'memory' },
    { label: '消息历史', value: b.messagesTokens, cls: 'msgs' },
  ];
  const used = b.totalInputTokens;
  const pct = b.maxTokens > 0 ? Math.min(100, (used / b.maxTokens) * 100) : 0;

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__ctx-head">
        <span>{b.modelDisplayName}</span>
        <span>
          {used.toLocaleString()} / {b.maxTokens.toLocaleString()} tokens（剩余{' '}
          {b.freeSpaceTokens.toLocaleString()}）
        </span>
      </div>
      <div className="otto-hub__ctx-bar">
        <div className="otto-hub__ctx-bar-fill" style={{ width: pct + '%' }} />
      </div>
      <div className="otto-hub__ctx-legend">
        {segments.map((seg) => (
          <div key={seg.label} className="otto-hub__ctx-legend-item">
            <span className={'otto-hub__ctx-dot otto-hub__ctx-dot--' + seg.cls} />
            {seg.label}: {seg.value.toLocaleString()}
          </div>
        ))}
      </div>
      <div className="otto-hub__toolbar">
        <button
          type="button"
          className="otto-hub__btn"
          onClick={() => actions.refreshContextBreakdown(activeSession.sessionId)}
        >
          刷新
        </button>
        <button
          type="button"
          className="otto-hub__btn otto-hub__btn--primary"
          onClick={() => actions.compressContext(activeSession.sessionId)}
          disabled={state.compressRunning}
        >
          {state.compressRunning ? '压缩中…' : '压缩上下文'}
        </button>
      </div>
      {state.compressMessage ? (
        <div className="otto-hub__subtitle2">{state.compressMessage}</div>
      ) : null}
    </div>
  );
}

// ── 用量统计 ──────────────────────────────────────────────────────────────

function StatsPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const stats = state.stats;

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__toolbar">
        <button type="button" className="otto-hub__btn" onClick={actions.refreshStats}>
          刷新
        </button>
      </div>
      {!stats || Object.keys(stats.models).length === 0 ? (
        <div className="otto-hub__empty">本次运行暂无用量数据。</div>
      ) : (
        <>
          <div className="otto-hub__subtitle2">按模型</div>
          <div className="otto-hub__list">
            {Object.entries(stats.models).map(([name, m]) => (
              <div key={name} className="otto-hub__row">
                <span className="otto-hub__row-name">{name}</span>
                <span className="otto-hub__row-detail">
                  请求 {m.requests} · 输入 {m.inputTokens.toLocaleString()} · 输出{' '}
                  {m.outputTokens.toLocaleString()} · 合计 {m.totalTokens.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
          <div className="otto-hub__subtitle2">按工具</div>
          <div className="otto-hub__list">
            {Object.entries(stats.tools.byName).map(([name, t]) => (
              <div key={name} className="otto-hub__row">
                <span className="otto-hub__row-name">{name}</span>
                <span className="otto-hub__row-detail">
                  调用 {t.count} · 成功 {t.success} · 失败 {t.fail}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── 依赖体检 ──────────────────────────────────────────────────────────────

function DoctorPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const report = state.doctorReport;

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__toolbar">
        <button
          type="button"
          className="otto-hub__btn otto-hub__btn--primary"
          onClick={actions.runDoctor}
          disabled={state.doctorRunning}
        >
          {state.doctorRunning ? '体检中…' : '开始体检'}
        </button>
      </div>
      {!report ? (
        <div className="otto-hub__empty">
          点击"开始体检"检查 pandoc / libreoffice / ffmpeg / playwright 等外部依赖。
        </div>
      ) : (
        <>
          <div className="otto-hub__subtitle2">
            就绪 {report.presentCount} / 缺失 {report.missingCount}（平台：{report.platform}）
          </div>
          <div className="otto-hub__list">
            {report.checks.map((c) => (
              <div key={c.name} className="otto-hub__row">
                <span aria-hidden>
                  {c.present ? (
                    <IconCheck size={13} />
                  ) : (
                    <span className="otto-hub__doctor-missing">✕</span>
                  )}
                </span>
                <span className="otto-hub__row-name">{c.name}</span>
                <span className="otto-hub__row-detail">
                  {c.present
                    ? c.version
                      ? 'v' + c.version + ' · ' + c.category
                      : c.category
                    : c.installHint ?? c.category}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── 任务清单 ──────────────────────────────────────────────────────────────

const TODO_STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  in_progress: '进行中',
  pending: '待办',
};

function TodosPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__toolbar">
        <button type="button" className="otto-hub__btn" onClick={actions.refreshTodos}>
          刷新
        </button>
      </div>
      {state.todos.length === 0 ? (
        <div className="otto-hub__empty">当前没有活跃的任务清单。</div>
      ) : (
        <div className="otto-hub__list">
          {state.todos.map((t) => (
            <div key={t.id} className={'otto-hub__todo otto-hub__todo--' + t.status}>
              <span className="otto-hub__todo-status">{TODO_STATUS_LABEL[t.status]}</span>
              <span className="otto-hub__todo-content">{t.content}</span>
              <span className={'otto-hub__todo-priority otto-hub__todo-priority--' + t.priority}>
                {t.priority}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ── 记忆 ──────────────────────────────────────────────────────────────────

function MemoryPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const [draft, setDraft] = useState('');

  const submit = (): void => {
    const clean = draft.trim();
    if (!clean) return;
    actions.addMemory(clean);
    setDraft('');
  };

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__field">
        <div className="otto-hub__field-label">新增一条记忆</div>
        <div className="otto-hub__field-hint">
          追加到项目级 OTTO.md（与 save_memory 工具落点一致），Otto 之后的对话都会记住。
        </div>
        <div className="otto-hub__inputrow">
          <input
            className="otto-hub__input"
            type="text"
            value={draft}
            placeholder="例如：用户偏好使用中文回复"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <button type="button" className="otto-hub__btn otto-hub__btn--primary" onClick={submit}>
            保存
          </button>
        </div>
      </div>

      <div className="otto-hub__toolbar">
        <button type="button" className="otto-hub__btn" onClick={actions.refreshMemory}>
          刷新
        </button>
      </div>

      {state.memoryFiles.length === 0 ? (
        <div className="otto-hub__empty">正在加载记忆文件…</div>
      ) : (
        state.memoryFiles.map((f) => (
          <div key={f.path} className="otto-hub__field">
            <div className="otto-hub__field-label">
              {f.scope === 'project' ? '项目记忆' : '全局记忆'}
              <span className="otto-hub__row-detail"> {f.path}</span>
            </div>
            {f.exists && f.content.trim() ? (
              <pre className="otto-hub__memory-content">{f.content}</pre>
            ) : (
              <div className="otto-hub__empty">暂无内容。</div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ── 技能库 ────────────────────────────────────────────────────────────────

function SkillsPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__toolbar">
        <button type="button" className="otto-hub__btn" onClick={actions.refreshSkills}>
          刷新
        </button>
      </div>
      {state.skills.length === 0 ? (
        <div className="otto-hub__empty">尚未安装任何技能。</div>
      ) : (
        <div className="otto-hub__list">
          {state.skills.map((sk) => (
            <div key={sk.id} className="otto-hub__row">
              <span aria-hidden>{sk.enabled ? '🟢' : '⚪'}</span>
              <span className="otto-hub__row-name">{sk.name}</span>
              <span className="otto-hub__row-detail">{sk.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 工具清单 ──────────────────────────────────────────────────────────────

function ToolsPanel({
  data,
  activeSession,
}: {
  data: UseSettingsData;
  activeSession: SessionSummary | null;
}): React.JSX.Element {
  const { state, actions } = data;

  if (!activeSession) {
    return <div className="otto-hub__empty">请先选择一个会话。</div>;
  }

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__toolbar">
        <button
          type="button"
          className="otto-hub__btn"
          onClick={() => actions.refreshTools(activeSession.sessionId)}
        >
          刷新
        </button>
      </div>
      {state.tools.length === 0 ? (
        <div className="otto-hub__empty">正在加载工具清单…</div>
      ) : (
        <div className="otto-hub__list">
          {state.tools.map((t) => (
            <div key={t.name} className="otto-hub__row">
              <span className="otto-hub__row-name">{t.displayName}</span>
              <span className="otto-hub__row-detail">{t.description}</span>
              {t.serverName ? (
                <span className="otto-hub__row-status">MCP · {t.serverName}</span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Workflow 面板 ─────────────────────────────────────────────────────────

function formatWorkflowDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function workflowStatusLabel(status: string): string {
  return status === 'completed' ? '✔ 已完成' : status === 'failed' ? '✘ 失败' : '… 运行中';
}

function WorkflowsPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__toolbar">
        <button type="button" className="otto-hub__btn" onClick={actions.refreshWorkflows}>
          刷新
        </button>
      </div>
      {state.workflows.length === 0 ? (
        <div className="otto-hub__empty">当前没有运行中或已完成的 workflow。</div>
      ) : (
        <div className="otto-hub__list">
          {state.workflows.map((wf) => {
            const agents = wf.phases.length
              ? wf.phases.flatMap((p) => p.agents)
              : wf.agents;
            const duration = formatWorkflowDuration(
              (wf.endTime ?? Date.now()) - wf.startTime,
            );
            return (
              <div key={wf.id} className="otto-hub__workflow">
                <div className="otto-hub__workflow-head">
                  <span>{workflowStatusLabel(wf.status)}</span>
                  <span className="otto-hub__row-name">{wf.description}</span>
                  <span className="otto-hub__row-detail">
                    {duration} · {wf.totalTokenUsage.totalTokens.toLocaleString()} tokens
                  </span>
                </div>
                {agents.length > 0 ? (
                  <div className="otto-hub__workflow-agents">
                    {agents.map((a) => (
                      <div key={a.agentId} className="otto-hub__row">
                        <span aria-hidden>{workflowStatusLabel(a.status).slice(0, 1)}</span>
                        <span className="otto-hub__row-name">{a.label}</span>
                        <span className="otto-hub__row-detail">
                          工具调用 {a.toolCallCount}
                          {a.tokenUsage
                            ? ` · ${a.tokenUsage.totalTokens.toLocaleString()} tokens`
                            : ''}
                          {a.currentPhase === 'executing_tools' ? ' · 执行工具中' : ''}
                          {a.currentPhase === 'thinking' ? ' · 思考中' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── 扩展 ──────────────────────────────────────────────────────────────────

function ExtensionsPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__toolbar">
        <button type="button" className="otto-hub__btn" onClick={actions.refreshExtensions}>
          刷新
        </button>
      </div>
      {state.extensions.length === 0 ? (
        <div className="otto-hub__empty">尚未安装任何扩展。</div>
      ) : (
        <div className="otto-hub__list">
          {state.extensions.map((ext) => (
            <div key={ext.name} className="otto-hub__row">
              <span className="otto-hub__row-name">{ext.name}</span>
              <span className="otto-hub__row-detail">v{ext.version} · {ext.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── IDE 伴生 ──────────────────────────────────────────────────────────────

function ideStatusDot(status: string): string {
  return status === 'connected' ? '🟢' : status === 'connecting' ? '🟡' : status === 'disconnected' ? '🔴' : '⚪';
}

function IdePanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const s = state.ideStatus;

  return (
    <div className="otto-hub__section">
      <div className="otto-hub__toolbar">
        <button type="button" className="otto-hub__btn" onClick={actions.refreshIdeStatus}>
          刷新
        </button>
      </div>
      {!s ? (
        <div className="otto-hub__empty">正在查询 IDE 伴生状态…</div>
      ) : (
        <div className="otto-hub__row">
          <span aria-hidden>{ideStatusDot(s.status)}</span>
          <span className="otto-hub__row-name">
            {s.status === 'not_applicable' ? '不适用' : s.status}
          </span>
          {s.details ? <span className="otto-hub__row-detail">{s.details}</span> : null}
        </div>
      )}
    </div>
  );
}

