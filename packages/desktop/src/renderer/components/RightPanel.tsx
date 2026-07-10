/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

/**
 * 右侧面板。6 个 tab：
 *   - agents：企业专家 + 自主开发入口
 *   - tools：常用 slash 命令
 *   - memory：组织/部门记忆
 *   - notes：本地笔记
 *   - leaderboard：Skill 排行榜 + 贡献明星榜
 *   - skillmarket：部门共享 + 公司市场
 *   - worklog：今日工作日志
 */

import React, { useState } from 'react';
import { EXPERTS, type Expert } from '../agents/experts.js';
import { SLASH_COMMANDS, insertComposerDraft } from './Composer.js';
import { openParkServices, useParkBrand } from './ParkServicesPlugin.js';
import { IconBuilding, IconChevron, IconChevronDown, IconTerminal } from './icons.js';

const DEV_EXPERT: Expert = {
  id: 'self-dev',
  name: '自主开发',
  tagline: '写代码 · 改项目 · 自动化任务',
  emoji: '⌨️',
  accent: '#38bdf8',
  skills: [],
  kickoff:
    '我要进行代码开发任务。请先查看当前项目的结构和技术栈，然后问我本次要实现或修复的目标，给出实现计划，经我确认后动手完成；过程中的关键改动请逐步说明并在完成后运行必要的验证。',
};

type TabType = 'agents' | 'tools' | 'memory' | 'notes' | 'leaderboard' | 'skillmarket' | 'worklog';

const TAB_LABEL: Record<TabType, string> = {
  agents: '智能体',
  tools: '工具',
  memory: '记忆',
  notes: '笔记',
  leaderboard: '排行榜',
  skillmarket: 'Skill',
  worklog: '工作日志',
};

const TABS: TabType[] = ['agents', 'tools', 'memory', 'notes', 'leaderboard', 'skillmarket', 'worklog'];

const TOOL_COMMAND_IDS = new Set([
  'new', 'model', 'clear', 'settings', 'doctor', 'feishu-status',
  'multi-channel', 'memory', 'skills', 'audio', 'browser', 'ide', 'export', 'workflow',
]);
const TOOL_COMMANDS = SLASH_COMMANDS.filter((c) => TOOL_COMMAND_IDS.has(c.id));

interface RightPanelProps {
  onLaunchExpert: (expert: Expert) => void;
  onOpenAgents: () => void;
}

export function RightPanel({
  onLaunchExpert,
  onOpenAgents,
}: RightPanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabType>('agents');
  const [noteText, setNoteText] = useState<string>('');
  const [expertsOpen, setExpertsOpen] = useState<boolean>(true);
  const [parkOpen, setParkOpen] = useState<boolean>(true);
  const [devOpen, setDevOpen] = useState<boolean>(true);
  // 企业品牌名（于总：入口要带园区名，随配置变化；默认「宏创AI园区服务」）。
  const parkBrand = useParkBrand();

  // 企业面板状态
  const [leaderboardTab, setLeaderboardTab] = useState<string>('leaderboard');
  const [leaderboardData, setLeaderboardData] = useState<{ leaderboard: string; starBoard: string } | null>(null);
  const [skillMarketData, setSkillMarketData] = useState<string>('');
  const [worklogData, setWorklogData] = useState<string>('');

  const panelStyle: React.CSSProperties = {
    flex: 1, overflowY: 'auto', padding: '12px',
    fontFamily: 'var(--otto-font-mono)', fontSize: '10px', lineHeight: '1.6',
    whiteSpace: 'pre-wrap', color: 'var(--otto-text)',
    background: 'var(--otto-surface)', border: '1px solid var(--otto-border)',
    borderRadius: 'var(--otto-radius-sm)',
  };

  const btnStyle: React.CSSProperties = {
    fontSize: '10px', padding: '4px 8px', background: 'var(--otto-surface)',
    color: 'var(--otto-text-secondary)', border: '1px solid var(--otto-border)',
    borderRadius: '4px', cursor: 'pointer', marginBottom: '6px',
  };

  return (
    <aside className="otto-right-panel">
      <div className="otto-right-panel__tabs" role="tablist" aria-label="右侧面板">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={`otto-right-panel__tab${activeTab === tab ? ' is-active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {TAB_LABEL[tab]}
          </button>
        ))}
      </div>

      <div className="otto-right-panel__body">
        {activeTab === 'agents' && (
          <div>
            <button type="button" className="otto-right-panel__grouphead" onClick={() => setExpertsOpen((v) => !v)} aria-expanded={expertsOpen}>
              <span>企业专家</span>
              <IconChevronDown size={14} className={'otto-right-panel__grouphead-chev' + (expertsOpen ? '' : ' is-collapsed')} />
            </button>
            {expertsOpen ? (
              <>
                <div className="otto-expert-list">
                  {EXPERTS.map((expert) => (
                    <button key={expert.id} type="button" className="otto-expert-card" onClick={() => onLaunchExpert(expert)} title={expert.tagline}>
                      <span className="otto-expert-card__icon" style={{ color: expert.accent }} aria-hidden>{expert.emoji}</span>
                      <span className="otto-expert-card__body">
                        <span className="otto-expert-card__name">{expert.name}</span>
                        <span className="otto-expert-card__desc">{expert.tagline}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <button type="button" className="otto-right-panel__moreagents" onClick={onOpenAgents} title="查看完整智能体画廊">
                  全部智能体
                  <IconChevron size={14} className="otto-right-panel__moreagents-chev" />
                </button>
              </>
            ) : null}
            {/* 园区 AI 服务：Jeremy 要求提到显眼位（自主开发横栏上方）。
                点击卡片经事件通路打开 ChatView 里挂载的园区服务弹窗。 */}
            <div className="otto-right-panel__waist" role="separator" />
            <button type="button" className="otto-right-panel__grouphead" onClick={() => setParkOpen((v) => !v)} aria-expanded={parkOpen}>
              <span>园区 AI 服务</span>
              <IconChevronDown size={14} className={'otto-right-panel__grouphead-chev' + (parkOpen ? '' : ' is-collapsed')} />
            </button>
            {parkOpen ? (
              <div className="otto-expert-list">
                <button type="button" className="otto-expert-card" onClick={openParkServices} title="访客邀约 · 会议室 · IT 报修 · 班车 · 餐饮">
                  <span className="otto-expert-card__icon otto-expert-card__icon--dev" aria-hidden><IconBuilding size={17} /></span>
                  <span className="otto-expert-card__body">
                    <span className="otto-expert-card__name">{parkBrand}</span>
                    <span className="otto-expert-card__desc">访客 · 会议室 · 报修 · 班车 · 餐饮</span>
                  </span>
                </button>
              </div>
            ) : null}
            <div className="otto-right-panel__waist" role="separator" />
            <button type="button" className="otto-right-panel__grouphead" onClick={() => setDevOpen((v) => !v)} aria-expanded={devOpen}>
              <span>自主开发</span>
              <IconChevronDown size={14} className={'otto-right-panel__grouphead-chev' + (devOpen ? '' : ' is-collapsed')} />
            </button>
            {devOpen ? (
              <div className="otto-expert-list">
                <button type="button" className="otto-expert-card" onClick={() => onLaunchExpert(DEV_EXPERT)} title={DEV_EXPERT.tagline}>
                  <span className="otto-expert-card__icon otto-expert-card__icon--dev" aria-hidden><IconTerminal size={17} /></span>
                  <span className="otto-expert-card__body">
                    <span className="otto-expert-card__name">{DEV_EXPERT.name}</span>
                    <span className="otto-expert-card__desc">{DEV_EXPERT.tagline}</span>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        )}

        {activeTab === 'tools' && (
          <div>
            <div className="otto-right-panel__head">常用命令</div>
            <div className="otto-right-panel__hint">点击把命令填入输入框，回车执行</div>
            <div className="otto-tool-list">
              {TOOL_COMMANDS.map((cmd) => (
                <button key={cmd.id} type="button" className="otto-tool-item" onClick={() => insertComposerDraft(`/${cmd.id}`)} title={cmd.description}>
                  <span className="otto-tool-item__cmd">/{cmd.id}</span>
                  <span className="otto-tool-item__desc">{cmd.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'memory' && (
          <div>
            <div className="otto-right-panel__head">组织/部门记忆文件</div>
            <div className="otto-right-panel__empty">
              接入记忆后端后，这里会显示组织 / 部门 / 角色的真实记忆文件。
              <br />当前尚未接入，暂无内容。
            </div>
          </div>
        )}

        {activeTab === 'notes' && (
          <div className="otto-right-panel__notes">
            <div className="otto-right-panel__head">本地笔记</div>
            <div className="otto-right-panel__hint">临时草稿：仅当前会话有效，暂不保存到本地。</div>
            <textarea className="otto-right-panel__textarea" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="随手记点什么…（暂不保存）" aria-label="本地笔记" />
          </div>
        )}

        {activeTab === 'leaderboard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', height: '100%' }}>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button style={{ ...btnStyle, flex: 1, fontWeight: leaderboardTab === 'leaderboard' ? 'bold' : 'normal', background: leaderboardTab === 'leaderboard' ? 'var(--otto-accent-soft)' : 'var(--otto-surface)', color: leaderboardTab === 'leaderboard' ? 'var(--otto-accent)' : 'var(--otto-text-secondary)' }} onClick={() => setLeaderboardTab('leaderboard')}>排行榜</button>
              <button style={{ ...btnStyle, flex: 1, fontWeight: leaderboardTab === 'stars' ? 'bold' : 'normal', background: leaderboardTab === 'stars' ? 'var(--otto-accent-soft)' : 'var(--otto-surface)', color: leaderboardTab === 'stars' ? 'var(--otto-accent)' : 'var(--otto-text-secondary)' }} onClick={() => setLeaderboardTab('stars')}>明星榜</button>
            </div>
            <button style={btnStyle} onClick={async () => { try { const d = await window.otto?.skillLeaderboard(); setLeaderboardData(d); } catch { /* server 未就绪，保留上次内容 */ } }}>刷新</button>
            <div style={panelStyle}>
              {leaderboardData ? (leaderboardTab === 'leaderboard' ? leaderboardData.leaderboard : leaderboardData.starBoard) : '点击「刷新」加载排行榜数据。'}
            </div>
          </div>
        )}

        {activeTab === 'skillmarket' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', height: '100%' }}>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button style={{ ...btnStyle, flex: 1 }} onClick={async () => { try { const d = await window.otto?.skillShareList(); setSkillMarketData(d.text); } catch { /* server 未就绪，保留上次内容 */ } }}>部门共享</button>
              <button style={{ ...btnStyle, flex: 1 }} onClick={async () => { try { const d = await window.otto?.skillMarketplace(); setSkillMarketData(d.text); } catch { /* server 未就绪，保留上次内容 */ } }}>公司市场</button>
            </div>
            <div style={panelStyle}>{skillMarketData || '点击上方按钮加载 Skill 列表。'}</div>
          </div>
        )}

        {activeTab === 'worklog' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', height: '100%' }}>
            <button style={btnStyle} onClick={async () => { try { const d = await window.otto?.workLogToday(); setWorklogData(d.summary); } catch { /* server 未就绪，保留上次内容 */ } }}>刷新今日日志</button>
            <div style={panelStyle}>{worklogData || '点击「刷新今日日志」加载。'}</div>
          </div>
        )}
      </div>
    </aside>
  );
}
