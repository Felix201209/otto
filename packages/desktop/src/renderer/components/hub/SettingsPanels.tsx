/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 设置与诊断中心 ·「设置」组面板：偏好设置 / MCP 服务器 / 扩展 / IDE 伴生。
 * 数据与动作全部来自 useSettingsData，本文件只负责排版。
 */

import React, { useEffect, useState } from 'react';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { GeneratedIcon, type GeneratedIconName } from '../GeneratedIcon.js';
import { IconClose } from '../icons.js';
import { Panel, Card, Dot, Badge, Empty, type DotTone } from './HubUI.js';

// ── 偏好设置 ──────────────────────────────────────────────────────────────

const AGENT_STYLES: Array<{ id: string; label: string; icon: GeneratedIconName }> = [
  { id: 'default', label: '日常对话（自然清晰）', icon: 'style-default' },
  { id: 'codex', label: '快速执行（少说多做）', icon: 'style-codex' },
  { id: 'cursor', label: '工作代码（协作开发）', icon: 'style-cursor' },
  { id: 'augment', label: '工程交付（任务与验证）', icon: 'style-augment' },
  { id: 'claude-code', label: '简洁开发（直接精炼）', icon: 'style-claude-code' },
  { id: 'antigravity', label: '企业办公（资料与会议）', icon: 'style-antigravity' },
  { id: 'windsurf', label: '协作推进（边讲边做）', icon: 'style-windsurf' },
];

/** 外观主题选项（nativeTheme.themeSource 三态）。 */
const THEME_OPTIONS: Array<{ id: 'system' | 'light' | 'dark'; label: string }> = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

export function PrefsPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const s = state.settings;
  const [langDraft, setLangDraft] = useState('');
  // 外观主题：独立于 server settings（走 main 的 nativeTheme IPC，本机持久化）。
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');

  useEffect(() => {
    setLangDraft(s?.preferredLanguage ?? '');
  }, [s?.preferredLanguage]);

  useEffect(() => {
    let cancelled = false;
    void window.otto?.themeGet?.().then((v) => {
      if (!cancelled && v) setTheme(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const pickTheme = (v: 'system' | 'light' | 'dark'): void => {
    setTheme(v);
    void window.otto?.themeSet?.(v);
  };

  return (
    <Panel title="偏好设置" desc="Otto 的工作风格与全局偏好。">
      {!s ? (
        <Empty>正在加载偏好设置…</Empty>
      ) : (
        <Card>
          <div className="otto-hub__setting otto-hub__setting--stack">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">外观</div>
              <div className="otto-hub__field-hint">
                深浅色主题：跟随系统或手动固定，立即生效并记住选择。
              </div>
            </div>
            <div className="otto-hub__chiprow">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={'otto-hub__chip' + (theme === opt.id ? ' is-active' : '')}
                  onClick={() => pickTheme(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="otto-hub__setting otto-hub__setting--stack">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">Otto 工作方式</div>
              <div className="otto-hub__field-hint">
                选择适合日常对话、企业办公、代码处理或工程交付的方式。
              </div>
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
                  <GeneratedIcon name={style.icon} size={18} />
                  <span>{style.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="otto-hub__setting">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">健康使用提醒</div>
              <div className="otto-hub__field-hint">深夜/长时间使用时收到善意提醒。</div>
            </div>
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

          <div className="otto-hub__setting">
            <div className="otto-hub__setting-text">
              <div className="otto-hub__field-label">偏好语言</div>
              <div className="otto-hub__field-hint">
                影响 Otto 回复所用的语言（留空 = 跟随对话自动判断）。
              </div>
            </div>
            <div className="otto-hub__inputrow otto-hub__inputrow--compact">
              <input
                className="otto-hub__input"
                type="text"
                value={langDraft}
                placeholder="例如：中文 / English"
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
        </Card>
      )}
    </Panel>
  );
}

// ── MCP 服务器 ────────────────────────────────────────────────────────────

function mcpTone(status: 'connected' | 'connecting' | 'disconnected'): DotTone {
  return status === 'connected' ? 'on' : status === 'connecting' ? 'busy' : 'off';
}

const MCP_STATUS_LABEL: Record<'connected' | 'connecting' | 'disconnected', string> = {
  connected: '已连接',
  connecting: '连接中',
  disconnected: '未连接',
};

export function McpPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
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
    <Panel
      title="MCP 服务器"
      desc="管理 Model Context Protocol 服务器，为 Otto 接入外部工具。"
      actions={
        <>
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
        </>
      }
    >
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
        <Empty>尚未配置任何 MCP 服务器。点击右上角「添加服务器」接入第一个。</Empty>
      ) : (
        <Card>
          {state.mcpServers.map((s) => (
            <div key={s.name} className="otto-hub__item">
              <Dot tone={mcpTone(s.status)} />
              <span className="otto-hub__row-name">{s.name}</span>
              <span className="otto-hub__row-detail">
                {s.command ?? s.httpUrl ?? s.url ?? ''}
              </span>
              <span className="otto-hub__row-status">{MCP_STATUS_LABEL[s.status]}</span>
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
        </Card>
      )}
    </Panel>
  );
}

// ── 扩展 ──────────────────────────────────────────────────────────────────

export function ExtensionsPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;

  return (
    <Panel
      title="扩展"
      desc="已安装的扩展包及其版本。"
      actions={
        <button type="button" className="otto-hub__btn" onClick={actions.refreshExtensions}>
          刷新
        </button>
      }
    >
      {state.extensions.length === 0 ? (
        <Empty>尚未安装任何扩展。</Empty>
      ) : (
        <Card>
          {state.extensions.map((ext) => (
            <div key={ext.name} className="otto-hub__item">
              <span className="otto-hub__row-name">{ext.name}</span>
              <span className="otto-hub__row-detail">{ext.path}</span>
              <Badge>v{ext.version}</Badge>
            </div>
          ))}
        </Card>
      )}
    </Panel>
  );
}

// ── IDE 伴生 ──────────────────────────────────────────────────────────────

function ideTone(status: string): DotTone {
  return status === 'connected'
    ? 'on'
    : status === 'connecting'
      ? 'busy'
      : status === 'disconnected'
        ? 'err'
        : 'off';
}

const IDE_STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  disconnected: '未连接',
  not_applicable: '不适用',
};

export function IdePanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const s = state.ideStatus;

  return (
    <Panel
      title="IDE 伴生"
      desc="VS Code 伴生插件的连接状态。"
      actions={
        <button type="button" className="otto-hub__btn" onClick={actions.refreshIdeStatus}>
          刷新
        </button>
      }
    >
      {!s ? (
        <Empty>正在查询 IDE 伴生状态…</Empty>
      ) : (
        <Card>
          <div className="otto-hub__item">
            <Dot tone={ideTone(s.status)} />
            <span className="otto-hub__row-name">
              {IDE_STATUS_LABEL[s.status] ?? s.status}
            </span>
            {s.details ? <span className="otto-hub__row-detail">{s.details}</span> : null}
          </div>
        </Card>
      )}
    </Panel>
  );
}
