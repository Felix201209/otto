/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 设置与诊断中心（P0）。TUI /config、/context、/mcp、/doctor、/todo
 * 的 GUI 真实对应面板（不是发提示词代理，直连协议帧真实数据）。
 *
 * 结构：整页 + 左侧分组导航（设置 / 诊断 / 工作区三组，替代早期 13 个横排
 * tab 挤一行的布局），右侧为统一「标题 + 描述 + 动作区 + 卡片」骨架的面板。
 * 面板实现按组拆在 components/hub/ 下，本文件只管壳与导航。
 *
 * 数据源：useSettingsData（独立于聊天 store 的 hook），每个 tab 首次打开时
 * 拉一次对应数据；用户主动点刷新按钮可重拉。
 */

import React, { useEffect, useState } from 'react';
import type { SessionSummary } from 'otto-server';
import type { UseSettingsData } from '../state/useSettingsData.js';
import type { UseSoftwareUpdate } from '../state/useSoftwareUpdate.js';
import { SoftwareUpdatePanel } from './SoftwareUpdatePanel.js';
import { Panel } from './hub/HubUI.js';
import { PrefsPanel, McpPanel, ExtensionsPanel, IdePanel } from './hub/SettingsPanels.js';
import { FeishuPanel } from './hub/FeishuPanel.js';
import {
  DoctorPanel,
  ContextPanel,
  WorkflowsPanel,
} from './hub/DiagnosticsPanels.js';
import {
  TodosPanel,
  MemoryPanel,
  SkillsPanel,
  ToolsPanel,
} from './hub/WorkspacePanels.js';
import { IconSettings, IconChevron, IconClose } from './icons.js';

export type TabId =
  | 'prefs'
  | 'feishu'
  | 'mcp'
  | 'context'
  | 'doctor'
  | 'update'
  | 'todos'
  | 'memory'
  | 'skills'
  | 'tools'
  | 'workflows'
  | 'extensions'
  | 'ide';

const TAB_LABEL: Record<TabId, string> = {
  prefs: '偏好设置',
  feishu: '飞书接入',
  mcp: 'MCP 服务器',
  context: 'Context 用量',
  doctor: '依赖体检',
  update: '软件更新',
  todos: '任务清单',
  memory: '记忆',
  skills: '技能库',
  tools: '工具清单',
  workflows: 'Workflow',
  extensions: '扩展',
  ide: 'IDE 伴生',
};

/**
 * 左侧导航分组：设置（改配置的）/ 诊断（看健康与用量的）/ 工作区（看会话
 * 资产的）。分组是这次排版重构的核心——13 个入口平铺没有任何层次，分三组
 * 后每组不超过 5 项，一眼可扫完。
 */
const NAV_GROUPS: Array<{ label: string; tabs: TabId[] }> = [
  { label: '设置', tabs: ['prefs', 'feishu', 'mcp', 'extensions', 'ide', 'update'] },
  { label: '诊断', tabs: ['doctor', 'context', 'workflows'] },
  { label: '工作区', tabs: ['todos', 'memory', 'skills', 'tools'] },
];

interface SettingsHubPageProps {
  data: UseSettingsData;
  /** 软件更新状态机（App 顶层持有，与 Sidebar 入口小圆点共享同一份）。 */
  update: UseSoftwareUpdate;
  activeSession: SessionSummary | null;
  onBack: () => void;
  /** 打开面板时默认停在哪个 tab（如从斜杠命令 /doctor /memory /skills 直达）。缺省「偏好设置」。 */
  initialTab?: TabId;
}

export function SettingsHubPage({
  data,
  update,
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
    } else if (tab === 'todos') actions.refreshTodos();
    else if (tab === 'memory') actions.refreshMemory();
    else if (tab === 'skills') actions.refreshSkills();
    else if (tab === 'tools' && activeSession) {
      actions.refreshTools(activeSession.sessionId);
    } else if (tab === 'workflows') actions.refreshWorkflows();
    else if (tab === 'extensions') actions.refreshExtensions();
    else if (tab === 'ide') actions.refreshIdeStatus();
    // 软件更新 tab 不自动发起检查（手动检查才展示完整结果），只把入口小圆点熄灭。
    else if (tab === 'update') update.actions.markBadgeSeen();
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
          <div className="otto-hub__subtitle">配置 Otto 的偏好与集成，查看运行诊断。</div>
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

      <div className="otto-hub__body">
        <nav className="otto-hub__nav" aria-label="设置分区">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="otto-hub__nav-group">
              <div className="otto-hub__nav-grouplabel">{group.label}</div>
              {group.tabs.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={'otto-hub__nav-item' + (tab === t ? ' is-active' : '')}
                  aria-current={tab === t ? 'page' : undefined}
                  onClick={() => setTab(t)}
                >
                  {TAB_LABEL[t]}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="otto-hub__content">
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
            {tab === 'feishu' ? <FeishuPanel /> : null}
            {tab === 'mcp' ? <McpPanel data={data} /> : null}
            {tab === 'context' ? (
              <ContextPanel data={data} activeSession={activeSession} />
            ) : null}
            {tab === 'doctor' ? <DoctorPanel data={data} /> : null}
            {tab === 'update' ? (
              <Panel title="软件更新" desc="检查并下载 Otto 桌面版新版本。">
                <SoftwareUpdatePanel update={update} />
              </Panel>
            ) : null}
            {tab === 'todos' ? <TodosPanel data={data} /> : null}
            {tab === 'memory' ? <MemoryPanel data={data} /> : null}
            {tab === 'skills' ? <SkillsPanel data={data} /> : null}
            {tab === 'tools' ? <ToolsPanel data={data} activeSession={activeSession} /> : null}
            {tab === 'workflows' ? <WorkflowsPanel data={data} /> : null}
            {tab === 'extensions' ? <ExtensionsPanel data={data} /> : null}
            {tab === 'ide' ? <IdePanel data={data} /> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
