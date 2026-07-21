/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AutoSkillCandidateInfo, ProductWorkspaceSnapshot } from 'otto-server';
import {
  BASE_AGENT_PROFILES,
  getEnterpriseAgentProfiles,
  SELF_DEVELOPMENT_PROFILE,
  type AgentProfile,
} from '../agents/departmentAgents.js';
import { SLASH_COMMANDS, insertComposerDraft } from './Composer.js';
import { GeneratedIcon } from './GeneratedIcon.js';
import { OttoPetStage } from './OttoPetStage.js';
import { openParkServices, useParkBrand } from './ParkServicesPlugin.js';
import type { CentralEnterpriseRole } from '../state/centralEnterpriseIdentity.js';
import {
  IconBuilding,
  IconChevron,
  IconChevronDown,
  IconTerminal,
} from './icons.js';

type TabType = 'agents' | 'tools' | 'memory' | 'notes' | 'worklog';

// server 构建产物更新前也保持 renderer 可独立 typecheck；字段由当前协议快照提供。
type AuthenticatedWorkspaceSnapshot = ProductWorkspaceSnapshot & {
  authenticatedOrganization?: { id: string; name: string };
};

interface EnterpriseKnowledgeItem {
  id: string;
  organizationId: string;
  sourceId: string | null;
  department: string | null;
  category: string;
  content: string;
  contributor: string | null;
  confidence: number;
  createdAt: string;
}

const TAB_LABEL: Record<TabType, string> = {
  agents: '专家',
  tools: '工具',
  memory: '企业记忆',
  notes: '笔记',
  worklog: '工作日志',
};

const TOOL_COMMAND_IDS = new Set([
  'new', 'model', 'clear', 'settings', 'doctor', 'feishu-status',
  'multi-channel', 'memory', 'skills',
  'audio', 'browser', 'ide', 'export', 'workflow',
]);

function formatEnterpriseMemoryDate(value: string): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleDateString('zh-CN');
}

const TOOL_COMMANDS = SLASH_COMMANDS.filter((command) => TOOL_COMMAND_IDS.has(command.id));

export interface RightPanelProps {
  busy: boolean;
  mode?: 'personal' | 'enterprise';
  /** 已由中心服务认证的角色；不能从本机 workspace.role 推导。 */
  enterpriseRole?: CentralEnterpriseRole;
  workspace?: ProductWorkspaceSnapshot | null;
  profiles?: readonly AgentProfile[];
  onLaunchAgentProfile?: (profile: AgentProfile) => void;
  onOpenAgents?: () => void;
  onOpenSkillZone?: () => void;
  onSelectDate?: (date: string) => void;
  onOpenOrganization?: () => void;
  onAddFriend?: (name: string, note?: string) => void;
  autoSkillCandidates?: AutoSkillCandidateInfo[];
  autoSkillLastAction?: {
    kind: 'confirmed' | 'rejected';
    candidateId: string;
    savedPath?: string;
  } | null;
  onRefreshAutoSkills?: () => void;
  onConfirmAutoSkill?: (candidateId: string) => void;
  onRejectAutoSkill?: (candidateId: string) => void;
}

function visibleProfiles(
  mode: 'personal' | 'enterprise',
  enterpriseRole: CentralEnterpriseRole | undefined,
): readonly AgentProfile[] {
  if (mode === 'personal') return BASE_AGENT_PROFILES;
  return getEnterpriseAgentProfiles(enterpriseRole ?? 'member', null);
}

export function RightPanel({
  busy,
  mode = 'personal',
  enterpriseRole,
  workspace = null,
  profiles: providedProfiles,
  onLaunchAgentProfile = () => undefined,
  onOpenAgents = () => undefined,
  onOpenSkillZone = () => undefined,
  onSelectDate = () => undefined,
  onOpenOrganization = () => undefined,
  onAddFriend = () => undefined,
  autoSkillCandidates = [],
  autoSkillLastAction = null,
  onRefreshAutoSkills = () => undefined,
  onConfirmAutoSkill = () => undefined,
  onRejectAutoSkill = () => undefined,
}: RightPanelProps): React.JSX.Element {
  const tabs = useMemo<TabType[]>(
    () => mode === 'enterprise'
      ? ['agents', 'tools', 'memory', 'notes', 'worklog']
      : ['agents', 'tools', 'notes', 'worklog'],
    [mode],
  );
  const [activeTab, setActiveTab] = useState<TabType>('agents');
  const [collapsed, setCollapsed] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [parkOpen, setParkOpen] = useState(true);
  const [developmentOpen, setDevelopmentOpen] = useState(true);
  const [collabOpen, setCollabOpen] = useState(false);
  const [collabTab, setCollabTab] = useState<'company' | 'friends'>('company');
  const [friendName, setFriendName] = useState('');
  const [friendNote, setFriendNote] = useState('');
  const [workSummary, setWorkSummary] = useState<{
    summary: string;
    date: string;
    totalActions: number;
    workResults: number;
  } | null>(null);
  const [worklogDays, setWorklogDays] = useState<WorkLogDay[]>([]);
  const [worklogLoading, setWorklogLoading] = useState(false);
  const [workReportPreview, setWorkReportPreview] = useState('');
  const [workReportPath, setWorkReportPath] = useState('');
  const [knowledgeItems, setKnowledgeItems] = useState<EnterpriseKnowledgeItem[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState('');
  const profiles = useMemo(
    () => providedProfiles ?? visibleProfiles(mode, enterpriseRole),
    [enterpriseRole, mode, providedProfiles],
  );
  const authenticatedOrganization = (workspace as AuthenticatedWorkspaceSnapshot | null)
    ?.authenticatedOrganization;
  const parkBrand = useParkBrand();

  useEffect(() => {
    if (!tabs.includes(activeTab)) setActiveTab('agents');
  }, [activeTab, tabs]);

  const refreshWorkLog = useCallback(async (): Promise<void> => {
    setWorklogLoading(true);
    try {
      const [today, days] = await Promise.all([
        window.otto.workLogToday(),
        window.otto.workLogRecent(92),
      ]);
      setWorkSummary(today);
      setWorklogDays(days);
    } catch {
      // 工作日志不可用不影响其它右栏功能；保留上一次成功数据。
    } finally {
      setWorklogLoading(false);
    }
  }, []);

  const refreshEnterpriseKnowledge = useCallback(async (): Promise<void> => {
    if (mode !== 'enterprise') return;
    setKnowledgeLoading(true);
    setKnowledgeError('');
    try {
      const entries = await window.otto.enterpriseKnowledgeList();
      setKnowledgeItems(entries);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setKnowledgeError(message || '企业记忆加载失败');
      setKnowledgeItems([]);
    } finally {
      setKnowledgeLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    if (activeTab === 'worklog') void refreshWorkLog();
  }, [activeTab, refreshWorkLog]);

  useEffect(() => {
    if (activeTab === 'memory' && mode === 'enterprise') void refreshEnterpriseKnowledge();
  }, [activeTab, mode, refreshEnterpriseKnowledge]);

  const worklogByDate = useMemo(
    () => Object.fromEntries(worklogDays.map((day) => [day.date, day.entries])),
    [worklogDays],
  );
  const todayEntries = workSummary ? worklogByDate[workSummary.date] ?? [] : [];
  const todayResults = todayEntries.filter((entry) => entry.entryType === 'work_result');

  if (collapsed) {
    return (
      <aside className="otto-right-panel otto-right-panel--collapsed" aria-label="右侧功能栏（已折叠）">
        <button type="button" className="otto-right-panel__edge" onClick={() => setCollapsed(false)} aria-label="展开右侧功能栏">
          ‹
        </button>
        {tabs.map((tab) => (
          <button key={tab} type="button" className="otto-right-panel__railitem" onClick={() => { setActiveTab(tab); setCollapsed(false); }} title={TAB_LABEL[tab]}>
            {TAB_LABEL[tab].slice(0, 1)}
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside className="otto-right-panel">
      <button type="button" className="otto-right-panel__edge" onClick={() => setCollapsed(true)} aria-label="折叠右侧功能栏">›</button>
      <div className="otto-right-panel__tabs" role="tablist" aria-label="右侧面板">
        {tabs.map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} className={`otto-right-panel__tab${activeTab === tab ? ' is-active' : ''}`} onClick={() => setActiveTab(tab)}>
            {TAB_LABEL[tab]}
          </button>
        ))}
      </div>

      <div className="otto-right-panel__body">
        {activeTab === 'agents' ? (
          <div>
            <div className="otto-right-panel__head">
              常用入口
            </div>
            <button
              type="button"
              className="otto-right-panel__grouphead"
              onClick={() => setParkOpen((value) => !value)}
              aria-expanded={parkOpen}
            >
              <span>园区 AI 服务</span>
              <IconChevronDown
                size={14}
                className={`otto-right-panel__grouphead-chev${parkOpen ? '' : ' is-collapsed'}`}
              />
            </button>
            {parkOpen ? (
              <div className="otto-expert-list">
                <button
                  type="button"
                  className="otto-expert-card"
                  onClick={openParkServices}
                  title="装修管理 · 满意度调查 · 园区公告 · 停车位办理 · 网络与电话 · 会议室预约 · 电卡充电 · 客户报修 · 来访车辆"
                >
                  <span className="otto-expert-card__icon otto-expert-card__icon--dev" aria-hidden>
                    <IconBuilding size={17} />
                  </span>
                  <span className="otto-expert-card__body">
                    <span className="otto-expert-card__name">{parkBrand}</span>
                    <span className="otto-expert-card__desc">装修 · 公告 · 停车 · 网络 · 会议 · 报修</span>
                  </span>
                </button>
              </div>
            ) : null}

            {mode === 'enterprise' ? (
              <>
                <div className="otto-right-panel__waist" role="separator" />
                <button
                  type="button"
                  className="otto-right-panel__grouphead"
                  onClick={() => setDevelopmentOpen((value) => !value)}
                  aria-expanded={developmentOpen}
                >
                  <span>开发 AI 智能体</span>
                  <IconChevronDown
                    size={14}
                    className={`otto-right-panel__grouphead-chev${developmentOpen ? '' : ' is-collapsed'}`}
                  />
                </button>
                {developmentOpen ? (
                  <div className="otto-expert-list">
                    <button
                      type="button"
                      className="otto-expert-card"
                      onClick={() => onLaunchAgentProfile(SELF_DEVELOPMENT_PROFILE)}
                      title={SELF_DEVELOPMENT_PROFILE.tagline}
                    >
                      <span className="otto-expert-card__icon otto-expert-card__icon--dev" aria-hidden>
                        <IconTerminal size={17} />
                      </span>
                      <span className="otto-expert-card__body">
                        <span className="otto-expert-card__name">{SELF_DEVELOPMENT_PROFILE.name}</span>
                        <span className="otto-expert-card__desc">{SELF_DEVELOPMENT_PROFILE.tagline}</span>
                      </span>
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}

            <div className="otto-right-panel__waist" role="separator" />
            <div className="otto-right-panel__head">
              {mode === 'personal' ? '个人 Otto' : '9 位企业工作 Agent'}
            </div>
            <div className="otto-profile-list">
              {profiles.slice(0, 12).map((profile) => (
                <button key={profile.id} type="button" className="otto-profile-card" onClick={() => onLaunchAgentProfile(profile)}>
                  <span
                    className="otto-profile-card__mark"
                    style={profile.accent ? { backgroundColor: `${profile.accent}24` } : undefined}
                  >
                    {profile.icon ? <GeneratedIcon name={profile.icon} size={20} /> : profile.name.slice(0, 1)}
                  </span>
                  <span><strong>{profile.name}</strong><small>{profile.tagline}</small></span>
                </button>
              ))}
            </div>
            {profiles.length > 12 ? (
              <button type="button" className="otto-right-panel__moreagents" onClick={onOpenAgents}>
                全部 {profiles.length} 位专家 <IconChevron size={13} />
              </button>
            ) : null}

            <div className="otto-auto-skill">
              <div className="otto-auto-skill__head">
                <div><strong>自动 Skill 候选</strong><span>从常做成果和重复流程里沉淀</span></div>
                <button type="button" onClick={onRefreshAutoSkills}>立即分析</button>
              </div>
              {autoSkillLastAction?.kind === 'confirmed' ? (
                <div className="otto-auto-skill__success">
                  Skill 已生成{autoSkillLastAction.savedPath ? `：${autoSkillLastAction.savedPath}` : ''}
                </div>
              ) : null}
              {autoSkillCandidates.length === 0 ? (
                <div className="otto-auto-skill__empty">暂无候选。点击“立即分析”会扫描最近工作成果和操作日志；同类成果多次出现后会进入这里。</div>
              ) : autoSkillCandidates.map((candidate) => (
                <article key={candidate.id} className="otto-auto-skill__candidate">
                  <strong>{candidate.name}</strong>
                  <span>{candidate.description}</span>
                  <small>{candidate.detectedPattern} · {candidate.occurrenceCount} 天重复</small>
                  <div>
                    <button type="button" onClick={() => onConfirmAutoSkill(candidate.id)}>确认生成</button>
                    <button type="button" onClick={() => onRejectAutoSkill(candidate.id)}>不再建议</button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : null}

        {activeTab === 'tools' ? (
          <div>
            <div className="otto-right-panel__head">常用命令</div>
            <div className="otto-right-panel__hint">点击把命令填入输入框，回车执行</div>
            <div className="otto-tool-list">
              {TOOL_COMMANDS.map((command) => (
                <button key={command.id} type="button" className="otto-tool-item" onClick={() => insertComposerDraft(`/${command.id}`)}>
                  <span className="otto-tool-item__cmd">/{command.id}</span>
                  <span className="otto-tool-item__desc">{command.description}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {activeTab === 'memory' ? (
          <div>
            <div className="otto-worklog-panel__head">
              <div>
                <strong>企业记忆</strong>
                <span>组织与部门沉淀的真实知识</span>
              </div>
              <button type="button" disabled={knowledgeLoading} onClick={() => void refreshEnterpriseKnowledge()}>
                {knowledgeLoading ? '加载中' : '刷新'}
              </button>
            </div>
            {knowledgeError ? (
              <div className="otto-right-panel__empty">
                企业记忆加载失败：{knowledgeError}
              </div>
            ) : knowledgeLoading && knowledgeItems.length === 0 ? (
              <div className="otto-right-panel__empty">正在加载企业记忆…</div>
            ) : knowledgeItems.length === 0 ? (
              <div className="otto-right-panel__empty">
                暂无企业记忆。Otto 会在企业会话中把已确认、已去重的工作知识同步到这里。
              </div>
            ) : (
              <div className="otto-enterprise-memory-list">
                {knowledgeItems.map((item) => (
                  <article key={item.id} className="otto-enterprise-memory-card">
                    <div className="otto-enterprise-memory-card__meta">
                      <span>{item.department || '全组织'}</span>
                      <span>{item.category}</span>
                      <span>{Math.round(item.confidence * 100)}%</span>
                    </div>
                    <p>{item.content}</p>
                    <div className="otto-enterprise-memory-card__foot">
                      {item.contributor ? <span>{item.contributor}</span> : <span>系统沉淀</span>}
                      <span>{formatEnterpriseMemoryDate(item.createdAt)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {activeTab === 'notes' ? (
          <div className="otto-right-panel__notes">
            <div className="otto-right-panel__head">本地笔记</div>
            <div className="otto-right-panel__hint">临时草稿：仅当前应用运行期间保留。</div>
            <textarea className="otto-right-panel__textarea" value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="随手记点什么…（临时草稿）" aria-label="本地笔记" />
          </div>
        ) : null}

        {activeTab === 'worklog' ? (
          <div className="otto-worklog-panel">
            <div className="otto-worklog-panel__head">
              <div><strong>我的工作成果</strong><span>完成一轮工作后自动归纳</span></div>
              <button type="button" disabled={worklogLoading} onClick={() => void refreshWorkLog()}>
                {worklogLoading ? '更新中…' : '刷新'}
              </button>
            </div>

            <div className="otto-worklog-panel__hero">
              <div><strong>{workSummary?.workResults ?? 0}</strong><span>项成果</span></div>
              <p>{todayResults.length > 0 ? `今天已完成 ${todayResults.map((item) => item.taskTitle || item.action).slice(0, 2).join('、')}` : '今天完成的报告、方案和任务会自动出现在这里。'}</p>
            </div>

            {todayResults.length > 0 ? (
              <div className="otto-worklog-panel__results">
                {todayResults.slice(0, 4).map((entry, index) => (
                  <article key={`${entry.time}-${index}`}>
                    <span className="otto-worklog-panel__result-dot" aria-hidden />
                    <div><strong>完成 · {entry.taskTitle || entry.action}</strong><small>{entry.time}{entry.details ? ` · ${entry.details.replace(/\s+/g, ' ').slice(0, 76)}` : ''}</small></div>
                  </article>
                ))}
              </div>
            ) : null}

            <div className="otto-worklog-panel__actions">
              <button type="button" className="is-primary" onClick={async () => {
                try {
                  const report = await window.otto.workLogReport();
                  setWorkReportPath(report.ok ? report.path : '');
                  setWorkReportPreview(report.ok ? `${report.message}\n\n${report.markdown}` : report.message);
                } catch { /* 保留 */ }
              }}>生成今日总结</button>
              {workReportPath ? <button type="button" onClick={() => void window.otto.openPath(workReportPath)}>打开总结</button> : null}
            </div>
            <WorkLogCalendar onSelectDate={onSelectDate} byDate={worklogByDate} />
            <div className="otto-worklog-panel__tip">悬浮日期看当天成果；点击日期进入日程与工作详情。</div>
            {workReportPreview ? <pre className="otto-worklog-panel__summary">{workReportPreview}</pre> : null}
            {workSummary ? (
              <details className="otto-worklog-panel__details">
                <summary>查看执行明细</summary>
                <pre>{workSummary.summary}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>

      {mode === 'enterprise' ? (
        <div className="otto-right-panel__bottom-actions">
          <button type="button" className="otto-right-panel__skillzone" onClick={onOpenSkillZone}>Skill 专区</button>
          <button type="button" className="otto-right-panel__collab-toggle" onClick={() => setCollabOpen((value) => !value)} aria-expanded={collabOpen}>
            企业与好友 <IconChevronDown size={13} className={collabOpen ? '' : 'is-collapsed'} />
          </button>
          {collabOpen ? (
            <div className="otto-collab-drawer">
              <div className="otto-collab-drawer__tabs">
                <button type="button" className={collabTab === 'company' ? 'is-active' : ''} onClick={() => setCollabTab('company')}>企业</button>
                <button type="button" className={collabTab === 'friends' ? 'is-active' : ''} onClick={() => setCollabTab('friends')}>好友</button>
              </div>
              {collabTab === 'company' ? (
                <div className="otto-collab-drawer__content">
                  <strong>{authenticatedOrganization?.name ?? workspace?.managerWorkspace?.profile.companyName ?? '已加入企业'}</strong>
                  <span>
                    {authenticatedOrganization
                      ? '成员与部门由中心组织树实时加载'
                      : `${workspace?.members.length ?? 0} 位成员 · ${workspace?.managerWorkspace?.organization.departments.length ?? 0} 个部门`}
                  </span>
                  <button type="button" onClick={onOpenOrganization}>打开企业组织树</button>
                </div>
              ) : (
                <div className="otto-collab-drawer__content">
                  {workspace?.friends.map((friend) => <div key={friend.id}>{friend.displayName}<small>{friend.note}</small></div>)}
                  <input value={friendName} onChange={(event) => setFriendName(event.target.value)} placeholder="好友姓名" />
                  <input value={friendNote} onChange={(event) => setFriendNote(event.target.value)} placeholder="备注（可选）" />
                  <button type="button" disabled={!friendName.trim()} onClick={() => {
                    onAddFriend(friendName.trim(), friendNote.trim());
                    setFriendName(''); setFriendNote('');
                  }}>添加好友</button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      <OttoPetStage running={busy} />
    </aside>
  );
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

interface WorkLogEntry {
  time: string;
  category: string;
  action: string;
  success: boolean;
  details?: string;
  entryType: 'tool' | 'work_result';
  taskTitle?: string;
}

interface WorkLogDay {
  date: string;
  entries: WorkLogEntry[];
}

function WorkLogCalendar({
  onSelectDate,
  byDate,
}: {
  onSelectDate: (date: string) => void;
  byDate: Record<string, WorkLogEntry[]>;
}): React.JSX.Element {
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const todayKey = dateKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  return (
    <div className="otto-wcal">
      <div className="otto-wcal__title">
        <button type="button" onClick={() => setVisibleMonth(new Date(year, month - 1, 1))} aria-label="上个月">‹</button>
        <span>{year} 年 {month + 1} 月</span>
        <button type="button" onClick={() => setVisibleMonth(new Date(year, month + 1, 1))} aria-label="下个月">›</button>
      </div>
      <div className="otto-wcal__grid">
        {['一', '二', '三', '四', '五', '六', '日'].map((weekday) => <div key={weekday} className="otto-wcal__weekday">{weekday}</div>)}
        {Array.from({ length: firstWeekday }, (_, index) => <div key={`pad-${index}`} />)}
        {Array.from({ length: days }, (_, index) => {
          const day = index + 1;
          const key = dateKey(year, month, day);
          const entries = byDate[key] ?? [];
          const weekdayColumn = (firstWeekday + index) % 7;
          const orderedEntries = [...entries].sort((left, right) =>
            left.entryType === right.entryType ? 0 : left.entryType === 'work_result' ? -1 : 1,
          );
          return (
            <button
              key={key}
              type="button"
              className={
                'otto-wcal__day'
                + (entries.length ? ' has-log' : '')
                + (key === todayKey ? ' is-today' : '')
                + ` is-pop-col-${weekdayColumn}`
                + (weekdayColumn <= 2 ? ' is-pop-left' : '')
                + (weekdayColumn >= 4 ? ' is-pop-right' : '')
              }
              onClick={() => onSelectDate(key)}
              title={entries.length
                ? entries.map((entry) => `• ${entry.time} ${entry.action}`).join('\n')
                : '点击查看/新增当日日程'}
            >
              {day}{entries.length ? <span className="otto-wcal__dot" /> : null}
              {entries.length ? (
                <span className="otto-wcal__pop" role="tooltip">
                  <span className="otto-wcal__pop-title">
                    {month + 1} 月 {day} 日 · {entries.length} 条
                  </span>
                  {orderedEntries.slice(0, 12).map((entry, entryIndex) => (
                    <span className="otto-wcal__pop-item" key={`${entry.time}-${entryIndex}`}>
                      <span className="otto-wcal__pop-time">{entry.time}</span>
                      <span className="otto-wcal__pop-copy">
                        <span className="otto-wcal__pop-action">
                          • {entry.entryType === 'work_result' ? '完成' : entry.category} · {entry.action}
                          {entry.success ? '' : '（失败）'}
                        </span>
                        {entry.details ? (
                          <span className="otto-wcal__pop-detail">
                            {entry.details.replace(/\s+/g, ' ').slice(0, 140)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  ))}
                  {entries.length > 12 ? (
                    <span className="otto-wcal__pop-more">…还有 {entries.length - 12} 条</span>
                  ) : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
