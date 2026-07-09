/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 设置与诊断中心 ·「工作区」组面板：任务清单 / 记忆 / 技能库 / 工具清单。
 * 数据与动作全部来自 useSettingsData，本文件只负责排版。
 */

import React, { useState } from 'react';
import type { SessionSummary } from 'otto-server';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { Panel, Card, Caption, Dot, Badge, Empty } from './HubUI.js';

// ── 任务清单 ──────────────────────────────────────────────────────────────

const TODO_STATUS_LABEL: Record<string, string> = {
  completed: '已完成',
  in_progress: '进行中',
  pending: '待办',
};

export function TodosPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;

  return (
    <Panel
      title="任务清单"
      desc="Otto 正在跟进的任务及其进度。"
      actions={
        <button type="button" className="otto-hub__btn" onClick={actions.refreshTodos}>
          刷新
        </button>
      }
    >
      {state.todos.length === 0 ? (
        <Empty>当前没有活跃的任务清单。</Empty>
      ) : (
        <Card>
          {state.todos.map((t) => (
            <div key={t.id} className={'otto-hub__item otto-hub__todo--' + t.status}>
              <span className="otto-hub__todo-status">{TODO_STATUS_LABEL[t.status]}</span>
              <span className="otto-hub__todo-content">{t.content}</span>
              <span className={'otto-hub__todo-priority otto-hub__todo-priority--' + t.priority}>
                {t.priority}
              </span>
            </div>
          ))}
        </Card>
      )}
    </Panel>
  );
}

// ── 记忆 ──────────────────────────────────────────────────────────────────

export function MemoryPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const [draft, setDraft] = useState('');

  const submit = (): void => {
    const clean = draft.trim();
    if (!clean) return;
    actions.addMemory(clean);
    setDraft('');
  };

  return (
    <Panel
      title="记忆"
      desc="Otto 长期记住的事实，写入项目级 OTTO.md，之后的对话都会生效。"
      actions={
        <button type="button" className="otto-hub__btn" onClick={actions.refreshMemory}>
          刷新
        </button>
      }
    >
      <div className="otto-hub__inputrow">
        <input
          className="otto-hub__input"
          type="text"
          value={draft}
          placeholder="新增一条记忆，例如：用户偏好使用中文回复"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <button type="button" className="otto-hub__btn otto-hub__btn--primary" onClick={submit}>
          保存
        </button>
      </div>

      {state.memoryFiles.length === 0 ? (
        <Empty>正在加载记忆文件…</Empty>
      ) : (
        state.memoryFiles.map((f) => (
          <React.Fragment key={f.path}>
            <Caption>
              {f.scope === 'project' ? '项目记忆' : '全局记忆'}
              <span className="otto-hub__caption-detail">{f.path}</span>
            </Caption>
            {f.exists && f.content.trim() ? (
              <pre className="otto-hub__memory-content">{f.content}</pre>
            ) : (
              <Empty>暂无内容。</Empty>
            )}
          </React.Fragment>
        ))
      )}
    </Panel>
  );
}

// ── 技能库 ────────────────────────────────────────────────────────────────

export function SkillsPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;

  return (
    <Panel
      title="技能库"
      desc="已安装的技能，Otto 会按任务需要自动调用。"
      actions={
        <button type="button" className="otto-hub__btn" onClick={actions.refreshSkills}>
          刷新
        </button>
      }
    >
      {state.skills.length === 0 ? (
        <Empty>尚未安装任何技能。</Empty>
      ) : (
        <Card>
          {state.skills.map((sk) => (
            <div key={sk.id} className="otto-hub__item">
              <Dot tone={sk.enabled ? 'on' : 'off'} />
              <span className="otto-hub__row-name">{sk.name}</span>
              <span className="otto-hub__item-desc">{sk.description}</span>
            </div>
          ))}
        </Card>
      )}
    </Panel>
  );
}

// ── 工具清单 ──────────────────────────────────────────────────────────────

export function ToolsPanel({
  data,
  activeSession,
}: {
  data: UseSettingsData;
  activeSession: SessionSummary | null;
}): React.JSX.Element {
  const { state, actions } = data;

  return (
    <Panel
      title="工具清单"
      desc="当前会话可用的全部工具（内置 + MCP）。"
      actions={
        activeSession ? (
          <button
            type="button"
            className="otto-hub__btn"
            onClick={() => actions.refreshTools(activeSession.sessionId)}
          >
            刷新
          </button>
        ) : undefined
      }
    >
      {!activeSession ? (
        <Empty>请先选择一个会话。</Empty>
      ) : state.tools.length === 0 ? (
        <Empty>正在加载工具清单…</Empty>
      ) : (
        <Card>
          {state.tools.map((t) => (
            <div key={t.name} className="otto-hub__item">
              <span className="otto-hub__row-name">{t.displayName}</span>
              <span className="otto-hub__item-desc">{t.description}</span>
              {t.serverName ? <Badge tone="accent">MCP · {t.serverName}</Badge> : null}
            </div>
          ))}
        </Card>
      )}
    </Panel>
  );
}
