/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 设置与诊断中心（P0）。配置、上下文、MCP、doctor、todo
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
import type { ModelInfo, SessionSummary } from 'otto-server';
import type { UseSettingsData } from '../state/useSettingsData.js';
import type { UseSoftwareUpdate } from '../state/useSoftwareUpdate.js';
import { SoftwareUpdatePanel } from './SoftwareUpdatePanel.js';
import { Panel } from './hub/HubUI.js';
import { PrefsPanel, McpPanel, ExtensionsPanel, IdePanel } from './hub/SettingsPanels.js';
import { FeishuPanel } from './hub/FeishuPanel.js';
import { LocalAgentPanel } from './hub/LocalAgentPanel.js';
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
import type { UseProductWorkspace } from '../state/useProductWorkspace.js';
import { EnterpriseModelsPanel, OrganizationPanel } from './hub/ProductWorkspacePanels.js';
import { SearchPanel } from './hub/SearchPanel.js';
import { PrivacyDataPanel } from './hub/PrivacyDataPanel.js';
import { PersonalTokenUsagePanel } from './hub/PersonalTokenUsagePanel.js';
import type { EnterpriseAccount } from '../../preload/index.js';
import type { UiMode } from '../uiModePreference.js';

export type TabId =
  | 'prefs'
  | 'organization'
  | 'usage'
  | 'privacy'
  | 'models'
  | 'search'
  | 'feishu'
  | 'local-agent'
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

/**
 * 配对令牌验证已接通，但还没有持久化企业地址、建立企业会话或绑定当前账号，
 * 因此正式交付版继续隐藏入口。保留 tab 与组件代码，等完整配对闭环上线后
 * 只需单独打开此功能开关，不能再与“是否显示登录页”的开关耦合。
 */
const ENTERPRISE_LOCAL_AGENT_PAIRING_ENABLED = false;

export function isSettingsTabVisible(tab: TabId): boolean {
  return tab !== 'local-agent' || ENTERPRISE_LOCAL_AGENT_PAIRING_ENABLED;
}

/** 防止斜杠命令或旧的导航状态绕过隐藏入口。 */
export function resolveInitialSettingsTab(initialTab?: TabId): TabId {
  return initialTab && isSettingsTabVisible(initialTab) ? initialTab : 'prefs';
}

const TAB_LABEL: Record<TabId, string> = {
  prefs: '外观与回复',
  organization: '企业与身份',
  usage: '我的 Token',
  privacy: '隐私与数据',
  models: '企业模型',
  search: '联网搜索',
  feishu: '飞书接入',
  'local-agent': '接入企业',
  mcp: '外部工具（MCP）',
  context: '上下文详情',
  doctor: '运行检查',
  update: '软件更新',
  todos: '任务清单',
  memory: '记忆',
  skills: '技能库',
  tools: '工具清单',
  workflows: '自动流程',
  extensions: '扩展',
  ide: 'IDE 伴生',
};

/**
 * 左侧导航分组：设置（改配置的）/ 诊断（看健康与用量的）/ 工作区（看会话
 * 资产的）。分组是这次排版重构的核心——13 个入口平铺没有任何层次，分三组
 * 后每组不超过 5 项，一眼可扫完。
 */
const SIMPLE_NAV_GROUPS: Array<{ label: string; tabs: TabId[] }> = [
  { label: '常用', tabs: ['prefs', 'search', 'update'] },
  { label: '账号与连接', tabs: ['organization', 'usage', 'privacy', 'feishu', 'local-agent'] },
];

const ADVANCED_NAV_GROUPS: Array<{ label: string; tabs: TabId[] }> = [
  { label: '高级连接', tabs: ['models', 'mcp', 'extensions', 'ide'] },
  { label: '排查问题', tabs: ['doctor', 'context', 'workflows'] },
  { label: '数据与能力', tabs: ['todos', 'memory', 'skills', 'tools'] },
];

const ADVANCED_TABS = new Set(
  ADVANCED_NAV_GROUPS.flatMap((group) => group.tabs),
);

interface SettingsHubPageProps {
  data: UseSettingsData;
  /** 软件更新状态机（App 顶层持有，与 Sidebar 入口小圆点共享同一份）。 */
  update: UseSoftwareUpdate;
  activeSession: SessionSummary | null;
  onBack: () => void;
  /** 打开面板时默认停在哪个 tab（如从斜杠命令 /doctor /memory /skills 直达）。缺省「偏好设置」。 */
  initialTab?: TabId;
  product: UseProductWorkspace;
  models: ModelInfo[];
  enterpriseAccount: EnterpriseAccount;
  uiMode?: UiMode;
  onUiModeChange?: (mode: UiMode) => void;
  onManageAccounts?: () => void;
}

export function SettingsHubPage({
  data,
  update,
  activeSession,
  onBack,
  initialTab,
  product,
  models,
  enterpriseAccount,
  uiMode = 'conversational',
  onUiModeChange = () => undefined,
  onManageAccounts,
}: SettingsHubPageProps): React.JSX.Element {
  const [tab, setTab] = useState<TabId>(() => resolveInitialSettingsTab(initialTab));
  const [showAdvanced, setShowAdvanced] = useState(
    () => Boolean(initialTab && ADVANCED_TABS.has(initialTab)),
  );
  const { state, actions } = data;

  // 打开面板即拉一次偏好设置（最常用 tab）。
  useEffect(() => {
    actions.refreshSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切 tab 时按需拉取对应数据（首次进入该 tab 才拉，避免每次切换都打一遍所有请求）。
  useEffect(() => {
    if (tab === 'mcp') actions.refreshMcpServers();
    else if (tab === 'search') actions.refreshSearchConfig();
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
          <div className="otto-hub__title">Otto 设置</div>
          <div className="otto-hub__subtitle">常用能力已经准备好；通常不需要改任何专业参数。</div>
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
          {SIMPLE_NAV_GROUPS.map((group) => (
            <div key={group.label} className="otto-hub__nav-group">
              <div className="otto-hub__nav-grouplabel">{group.label}</div>
              {group.tabs.filter(isSettingsTabVisible).map((t) => (
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
          <button
            type="button"
            className={'otto-hub__nav-advanced' + (showAdvanced ? ' is-open' : '')}
            aria-expanded={showAdvanced}
            onClick={() => {
              if (showAdvanced && ADVANCED_TABS.has(tab)) setTab('prefs');
              setShowAdvanced((value) => !value);
            }}
          >
            <span>高级设置</span>
            <IconChevron size={12} />
          </button>
          {showAdvanced ? ADVANCED_NAV_GROUPS.map((group) => (
            <div key={group.label} className="otto-hub__nav-group otto-hub__nav-group--advanced">
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
          )) : null}
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
            {tab === 'prefs' ? (
              <PrefsPanel data={data} uiMode={uiMode} onUiModeChange={onUiModeChange} />
            ) : null}
            {tab === 'organization' ? (
              <OrganizationPanel
                product={product}
                enterpriseAccount={enterpriseAccount}
                onManageAccounts={onManageAccounts}
              />
            ) : null}
            {tab === 'usage' ? <PersonalTokenUsagePanel /> : null}
            {tab === 'privacy' ? <PrivacyDataPanel /> : null}
            {tab === 'models' ? <EnterpriseModelsPanel product={product} models={models} /> : null}
            {tab === 'search' ? <SearchPanel data={data} /> : null}
            {tab === 'feishu' ? <FeishuPanel /> : null}
            {tab === 'local-agent' && isSettingsTabVisible(tab) ? <LocalAgentPanel /> : null}
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
