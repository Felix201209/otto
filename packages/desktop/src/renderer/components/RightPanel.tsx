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
import type {
  CustomAgentDefinition,
  CustomAgentDraft,
} from '../customAgents.js';
import { SLASH_COMMANDS, insertComposerDraft } from './Composer.js';
import { FilePreview, type FileEntry } from './FilePreview.js';
import { GeneratedIcon } from './GeneratedIcon.js';
import { OttoPetStage } from './OttoPetStage.js';
import { openParkServices, useParkBrand } from './ParkServicesPlugin.js';
import type { CentralEnterpriseRole } from '../state/centralEnterpriseIdentity.js';
import { getEnterpriseOrganizationFeatures } from '../state/enterpriseOrganizationFeatures.js';
import {
  IconBuilding,
  IconChevron,
  IconChevronDown,
  IconTerminal,
} from './icons.js';

type TabType = 'agents' | 'tools' | 'documents' | 'memory' | 'worklog';
type KnowledgeView = 'knowledge' | 'timeline';

// server 构建产物更新前也保持 renderer 可独立 typecheck；字段由当前协议快照提供。
type AuthenticatedWorkspaceSnapshot = ProductWorkspaceSnapshot & {
  authenticatedOrganization?: { id: string; name: string };
};

interface EnterpriseKnowledgeItem {
  id: string;
  organizationId: string;
  sourceId: string | null;
  title?: string;
  department: string | null;
  category: string;
  content: string;
  contributor: string | null;
  confidence: number;
  sourceType?: 'manual' | 'auto_capture' | 'work_result' | 'task_log' | 'document' | 'offboarding';
  sourceLabel?: string | null;
  status?: 'pending_review' | 'active' | 'archived';
  version?: number;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
  evidenceCount?: number;
  distinctSessionCount?: number;
  distinctContributorCount?: number;
  firstObservedAt?: string | null;
  lastObservedAt?: string | null;
}

interface EnterpriseKnowledgeRevision {
  id: string;
  knowledgeId: string;
  version: number;
  title: string;
  category: string;
  content: string;
  status: 'pending_review' | 'active' | 'archived';
  changedBy: string | null;
  changeNote: string | null;
  createdAt: string;
}

const TAB_LABEL: Record<TabType, string> = {
  agents: '专家',
  tools: '工具',
  documents: '文档',
  memory: '企业记忆',
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
  /** 中心会话签发的组织 id，用于按租户缓存功能开关。 */
  enterpriseOrganizationId?: string | null;
  workspace?: ProductWorkspaceSnapshot | null;
  profiles?: readonly AgentProfile[];
  customAgents?: readonly CustomAgentDefinition[];
  onLaunchAgentProfile?: (profile: AgentProfile) => void;
  onCreateCustomAgent?: (draft: CustomAgentDraft) => void | Promise<void>;
  onLaunchCustomAgent?: (agent: CustomAgentDefinition) => void;
  onDeleteCustomAgent?: (agentId: string) => void;
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
  enterpriseOrganizationId: authenticatedOrganizationId,
  workspace = null,
  profiles: providedProfiles,
  customAgents = [],
  onLaunchAgentProfile = () => undefined,
  onCreateCustomAgent = () => undefined,
  onLaunchCustomAgent = () => undefined,
  onDeleteCustomAgent = () => undefined,
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
  const authenticatedOrganization = (workspace as AuthenticatedWorkspaceSnapshot | null)
    ?.authenticatedOrganization;
  const enterpriseOrganizationId = mode === 'enterprise'
    ? authenticatedOrganizationId?.trim()
      || authenticatedOrganization?.id
      || workspace?.context.companyId
      || null
    : null;
  const [enterpriseKnowledgeEnabled, setEnterpriseKnowledgeEnabled] = useState(false);
  const [enterpriseSkillMarketEnabled, setEnterpriseSkillMarketEnabled] = useState(false);
  const tabs = useMemo<TabType[]>(
    () => mode === 'enterprise'
      ? enterpriseKnowledgeEnabled
        ? ['agents', 'tools', 'documents', 'memory', 'worklog']
        : ['agents', 'tools', 'documents', 'worklog']
      : ['agents', 'tools', 'documents', 'worklog'],
    [enterpriseKnowledgeEnabled, mode],
  );
  const [activeTab, setActiveTab] = useState<TabType>('agents');
  const [collapsed, setCollapsed] = useState(false);
  const [parkOpen, setParkOpen] = useState(true);
  const [developmentOpen, setDevelopmentOpen] = useState(true);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [customAgentName, setCustomAgentName] = useState('');
  const [customAgentInstructions, setCustomAgentInstructions] = useState('');
  const [customAgentError, setCustomAgentError] = useState('');
  const [customAgentBusy, setCustomAgentBusy] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [collabTab, setCollabTab] = useState<'company' | 'friends'>('company');
  const [friendName, setFriendName] = useState('');
  const [friendNote, setFriendNote] = useState('');
  const [documentFiles, setDocumentFiles] = useState<FileEntry[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsError, setDocumentsError] = useState('');
  const [workSummary, setWorkSummary] = useState<{
    summary: string;
    date: string;
    totalActions: number;
    workResults: number;
  } | null>(null);
  const [worklogDays, setWorklogDays] = useState<WorkLogDay[]>([]);
  const [worklogLoading, setWorklogLoading] = useState(false);
  const [workReportMessage, setWorkReportMessage] = useState('');
  const [workReportPath, setWorkReportPath] = useState('');
  const [knowledgeItems, setKnowledgeItems] = useState<EnterpriseKnowledgeItem[]>([]);
  const [knowledgeView, setKnowledgeView] = useState<KnowledgeView>('knowledge');
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState('');
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeAppliedQuery, setKnowledgeAppliedQuery] = useState('');
  const [knowledgeNotice, setKnowledgeNotice] = useState('');
  const [knowledgeBusyId, setKnowledgeBusyId] = useState('');
  const [knowledgeCandidates, setKnowledgeCandidates] = useState<Array<{
    date: string;
    entry: WorkLogEntry;
  }>>([]);
  const [knowledgeEditor, setKnowledgeEditor] = useState<{
    id?: string;
    title: string;
    category: string;
    content: string;
  } | null>(null);
  const [knowledgeRevisions, setKnowledgeRevisions] = useState<Record<
    string,
    EnterpriseKnowledgeRevision[]
  >>({});
  const profiles = useMemo(
    () => providedProfiles ?? visibleProfiles(mode, enterpriseRole),
    [enterpriseRole, mode, providedProfiles],
  );
  const parkBrand = useParkBrand();

  useEffect(() => {
    let cancelled = false;
    setEnterpriseKnowledgeEnabled(false);
    setEnterpriseSkillMarketEnabled(false);
    setKnowledgeItems([]);
    setKnowledgeError('');
    setKnowledgeEditor(null);
    setKnowledgeView('knowledge');
    setKnowledgeRevisions({});
    if (!enterpriseOrganizationId) return () => { cancelled = true; };
    void getEnterpriseOrganizationFeatures(enterpriseOrganizationId, { force: true })
      .then((features) => {
        if (!cancelled) {
          setEnterpriseKnowledgeEnabled(features.knowledge);
          setEnterpriseSkillMarketEnabled(features.skill_market);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEnterpriseKnowledgeEnabled(false);
          setEnterpriseSkillMarketEnabled(false);
        }
      });
    return () => { cancelled = true; };
  }, [enterpriseOrganizationId]);

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

  const decodeDocumentText = useCallback((data: string, mimeType: string): string => {
    if (!mimeType.startsWith('text/') && !/markdown|json|xml|csv|javascript|typescript/i.test(mimeType)) {
      return '';
    }
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }, []);

  const documentExportName = useCallback((file: FileEntry): string => {
    const dot = file.name.lastIndexOf('.');
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    const ext = file.exportFormat || (dot > 0 ? file.name.slice(dot + 1).toLowerCase() : 'md');
    return base + '.edited.' + ext;
  }, []);

  const selectDocumentFiles = useCallback(async (): Promise<void> => {
    setDocumentsLoading(true);
    setDocumentsError('');
    try {
      const paths = await window.otto.selectFiles();
      if (paths.length === 0) return;
      const loaded = await Promise.all(paths.map(async (filePath): Promise<FileEntry> => {
        const file = await window.otto.readFilePath(filePath);
        if (/\.(pdf|docx?|md|markdown|txt|json|csv|xml|html?|css|jsx?|tsx?|log|ya?ml)$/i.test(file.fileName)) {
          const extracted = await window.otto.extractEditableDocument(file.filePath);
          return {
            id: file.filePath,
            name: file.fileName,
            path: file.filePath,
            size: file.size,
            mimeType: file.mimeType,
            content: extracted.content,
            source: extracted.message,
            editableText: true,
            exportFormat: extracted.sourceFormat,
          };
        }
        return {
          id: file.filePath,
          name: file.fileName,
          path: file.filePath,
          size: file.size,
          mimeType: file.mimeType,
          content: decodeDocumentText(file.data, file.mimeType),
          source: '本机文档',
        };
      }));
      setDocumentFiles((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        for (const item of loaded) byId.set(item.id, item);
        return [...byId.values()];
      });
    } catch (error) {
      setDocumentsError(error instanceof Error ? error.message : String(error));
    } finally {
      setDocumentsLoading(false);
    }
  }, [decodeDocumentText]);

  const refreshEnterpriseKnowledge = useCallback(async (): Promise<void> => {
    if (mode !== 'enterprise' || !enterpriseOrganizationId) return;
    setKnowledgeLoading(true);
    setKnowledgeError('');
    try {
      const features = await getEnterpriseOrganizationFeatures(
        enterpriseOrganizationId,
        { force: true },
      );
      setEnterpriseKnowledgeEnabled(features.knowledge);
      if (!features.knowledge) {
        setKnowledgeItems([]);
        return;
      }
      const [entries, recentWork] = await Promise.all([
        window.otto.enterpriseKnowledgeList({
          query: knowledgeAppliedQuery || undefined,
          includeReview: true,
        }),
        window.otto.workLogRecent(7).catch(() => []),
      ]);
      setKnowledgeItems(entries);
      setKnowledgeCandidates(
        recentWork
          .flatMap((day) => day.entries.map((entry) => ({ date: day.date, entry })))
          .filter(({ entry }) => entry.entryType === 'work_result' && entry.success)
          .slice(0, 3),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEnterpriseKnowledgeEnabled(false);
      setKnowledgeError(message || '企业记忆加载失败');
      setKnowledgeItems([]);
    } finally {
      setKnowledgeLoading(false);
    }
  }, [enterpriseOrganizationId, knowledgeAppliedQuery, mode]);

  const submitKnowledgeCandidate = useCallback(async (
    date: string,
    entry: WorkLogEntry,
  ): Promise<void> => {
    const title = (entry.taskTitle || entry.action || '工作成果').trim();
    const sourceId = `work-result:${date}:${entry.time}:${title}`.slice(0, 150);
    setKnowledgeBusyId(sourceId);
    setKnowledgeNotice('');
    try {
      const result = await window.otto.enterpriseKnowledgeRecord({
        sourceId,
        title,
        category: entry.category || 'work_result',
        content: [title, entry.details].filter(Boolean).join('\n'),
        confidence: 0.82,
        sourceType: 'work_result',
        sourceLabel: `${date} ${entry.time} Otto 工作成果`,
      });
      setKnowledgeNotice(
        result.reviewStatus === 'active'
          ? '已沉淀为企业知识。'
          : result.status === 'exists'
            ? '这项成果已经在审核队列中。'
            : '已提交为知识候选，管理员确认后会进入企业知识库。',
      );
      await refreshEnterpriseKnowledge();
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : String(error));
    } finally {
      setKnowledgeBusyId('');
    }
  }, [refreshEnterpriseKnowledge]);

  const reviewKnowledge = useCallback(async (
    id: string,
    action: 'approve' | 'archive',
  ): Promise<void> => {
    setKnowledgeBusyId(id);
    setKnowledgeNotice('');
    try {
      await window.otto.enterpriseKnowledgeReview(id, action);
      setKnowledgeRevisions((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setKnowledgeNotice(action === 'approve' ? '知识已发布，可供 Otto 检索引用。' : '知识候选已归档。');
      await refreshEnterpriseKnowledge();
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : String(error));
    } finally {
      setKnowledgeBusyId('');
    }
  }, [refreshEnterpriseKnowledge]);

  const saveKnowledgeEditor = useCallback(async (): Promise<void> => {
    if (!knowledgeEditor) return;
    const title = knowledgeEditor.title.trim();
    const category = knowledgeEditor.category.trim();
    const content = knowledgeEditor.content.trim();
    if (!title || !category || !content) {
      setKnowledgeError('请完整填写标题、分类和知识内容。');
      return;
    }
    const busyId = knowledgeEditor.id || 'new-knowledge';
    setKnowledgeBusyId(busyId);
    setKnowledgeError('');
    setKnowledgeNotice('');
    try {
      if (knowledgeEditor.id) {
        await window.otto.enterpriseKnowledgeRevise(knowledgeEditor.id, {
          title,
          category,
          content,
          confidence: 0.95,
          changeNote: '管理员在企业知识面板中修订',
        });
        setKnowledgeRevisions((current) => {
          const next = { ...current };
          delete next[knowledgeEditor.id!];
          return next;
        });
        setKnowledgeNotice('知识已修订，新版本立即用于后续检索。');
      } else {
        const uniquePart = globalThis.crypto?.randomUUID?.() || `${Date.now()}`;
        await window.otto.enterpriseKnowledgeRecord({
          sourceId: `manual:${uniquePart}`,
          title,
          category,
          content,
          confidence: 0.95,
          sourceType: 'manual',
          sourceLabel: '企业管理员手动录入',
        });
        setKnowledgeNotice('企业知识已发布。');
      }
      setKnowledgeEditor(null);
      await refreshEnterpriseKnowledge();
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : String(error));
    } finally {
      setKnowledgeBusyId('');
    }
  }, [knowledgeEditor, refreshEnterpriseKnowledge]);

  const toggleKnowledgeRevisions = useCallback(async (id: string): Promise<void> => {
    if (knowledgeRevisions[id]) {
      setKnowledgeRevisions((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      return;
    }
    setKnowledgeBusyId(id);
    setKnowledgeError('');
    try {
      const revisions = await window.otto.enterpriseKnowledgeRevisions(id);
      setKnowledgeRevisions((current) => ({ ...current, [id]: revisions }));
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : String(error));
    } finally {
      setKnowledgeBusyId('');
    }
  }, [knowledgeRevisions]);

  useEffect(() => {
    if (activeTab === 'worklog') void refreshWorkLog();
  }, [activeTab, refreshWorkLog]);

  useEffect(() => {
    if (activeTab === 'memory' && enterpriseKnowledgeEnabled) void refreshEnterpriseKnowledge();
  }, [activeTab, enterpriseKnowledgeEnabled, refreshEnterpriseKnowledge]);

  useEffect(() => {
    if (knowledgeView !== 'timeline' || enterpriseRole !== 'company_admin') return;
    const missing = knowledgeItems
      .filter((item) => item.status !== 'archived' && knowledgeRevisions[item.id] === undefined)
      .slice(0, 30);
    if (missing.length === 0) return;
    void Promise.all(missing.map(async (item) => ({
      id: item.id,
      revisions: await window.otto.enterpriseKnowledgeRevisions(item.id),
    }))).then((loaded) => {
      setKnowledgeRevisions((current) => ({
        ...current,
        ...Object.fromEntries(loaded.map((item) => [item.id, item.revisions])),
      }));
    }).catch((error) => {
      setKnowledgeError(error instanceof Error ? error.message : String(error));
    });
  }, [enterpriseRole, knowledgeItems, knowledgeRevisions, knowledgeView]);

  const knowledgeTimeline = useMemo(() => knowledgeItems
    .filter((item) => !item.status || item.status === 'active')
    .flatMap((item) => {
      const revisions = knowledgeRevisions[item.id];
      if (revisions?.length) {
        return revisions.map((revision) => ({
          id: revision.id,
          knowledgeId: item.id,
          title: revision.title,
          category: revision.category,
          content: revision.content,
          version: revision.version,
          changedBy: revision.changedBy || item.contributor || '系统沉淀',
          changeNote: revision.changeNote || revision.status,
          createdAt: revision.createdAt,
          department: item.department,
        }));
      }
      return [{
        id: `current-${item.id}`,
        knowledgeId: item.id,
        title: item.title || item.category,
        category: item.category,
        content: item.content,
        version: item.version || 1,
        changedBy: item.contributor || '系统沉淀',
        changeNote: item.version && item.version > 1 ? '当前版本' : '形成知识',
        createdAt: item.updatedAt || item.createdAt,
        department: item.department,
      }];
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [
      knowledgeItems,
      knowledgeRevisions,
    ]);

  const worklogByDate = useMemo(
    () => Object.fromEntries(worklogDays.map((day) => [day.date, day.entries])),
    [worklogDays],
  );
  const todayEntries = workSummary ? worklogByDate[workSummary.date] ?? [] : [];
  const todayResults = todayEntries.filter((entry) => entry.entryType === 'work_result');
  const closeCreateAgent = (): void => {
    if (customAgentBusy) return;
    setCreateAgentOpen(false);
    setCustomAgentError('');
  };
  const submitCustomAgent = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    setCustomAgentBusy(true);
    setCustomAgentError('');
    try {
      await onCreateCustomAgent({
        name: customAgentName,
        instructions: customAgentInstructions,
      });
      setCustomAgentName('');
      setCustomAgentInstructions('');
      setCreateAgentOpen(false);
    } catch (error) {
      setCustomAgentError(
        error instanceof Error && error.message
          ? error.message
          : '创建智能体失败，请重试',
      );
    } finally {
      setCustomAgentBusy(false);
    }
  };

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
            {parkBrand ? <><button
              type="button"
              className="otto-right-panel__grouphead"
              onClick={() => setParkOpen((value) => !value)}
              aria-expanded={parkOpen}
            >
              <span>园区服务</span>
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
            ) : null}</> : null}

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
            <div className="otto-custom-agents__head">
              <div>
                <strong>我的智能体</strong>
                <span>按当前账号保存，不会扩展账号权限</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCustomAgentError('');
                  setCreateAgentOpen(true);
                }}
              >
                创建智能体
              </button>
            </div>
            {customAgents.length > 0 ? (
              <div className="otto-custom-agent-list">
                {customAgents.map((agent) => (
                  <article key={agent.id} className="otto-custom-agent-card">
                    <button
                      type="button"
                      className="otto-custom-agent-card__launch"
                      aria-label={`启动${agent.name}`}
                      onClick={() => onLaunchCustomAgent(agent)}
                    >
                      <span className="otto-custom-agent-card__mark" aria-hidden>
                        {agent.name.slice(0, 1)}
                      </span>
                      <span>
                        <strong>{agent.name}</strong>
                        <small>{agent.instructions}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="otto-custom-agent-card__delete"
                      aria-label={`删除${agent.name}`}
                      title={`删除${agent.name}`}
                      onClick={() => {
                        if (window.confirm(`确定删除自定义智能体“${agent.name}”吗？`)) {
                          onDeleteCustomAgent(agent.id);
                        }
                      }}
                    >
                      ×
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="otto-custom-agents__empty">
                创建专属职责的工作智能体，之后可从这里继续启动。
              </div>
            )}

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
                  <header>
                    <strong>{candidate.name}</strong>
                    {typeof candidate.qualityScore === 'number' ? (
                      <em>质量 {candidate.qualityScore}/100</em>
                    ) : null}
                  </header>
                  {candidate.recommendation === 'enhance' && candidate.targetSkillName ? (
                    <b className="otto-auto-skill__mode">
                      增强已有 Skill：{candidate.targetSkillName}
                    </b>
                  ) : null}
                  <span>{candidate.description}</span>
                  <small>
                    {candidate.detectedPattern} · {candidate.occurrenceCount} 次重复
                    {typeof candidate.confidence === 'number'
                      ? ` · 可信度 ${Math.round(candidate.confidence * 100)}%`
                      : ''}
                  </small>
                  {candidate.evidence?.length ? (
                    <ul>
                      {candidate.evidence.slice(0, 3).map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                  {candidate.failureLessons?.length ? (
                    <p>已吸收修正：{candidate.failureLessons.slice(0, 2).join('；')}</p>
                  ) : null}
                  {candidate.knowledgeEvidenceCount ? (
                    <p>已引用 {candidate.knowledgeEvidenceCount} 条稳定个人知识作为步骤或边界依据</p>
                  ) : null}
                  <div>
                    <button type="button" onClick={() => onConfirmAutoSkill(candidate.id)}>
                      {candidate.recommendation === 'enhance' ? '确认增强' : '确认生成'}
                    </button>
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

        {activeTab === 'documents' ? (
          <div className="otto-documents-panel">
            <div className="otto-worklog-panel__head">
              <div>
                <strong>右侧文档</strong>
                <span>Markdown、TXT 和代码文件可直接编辑保存</span>
              </div>
              <button type="button" disabled={documentsLoading} onClick={() => void selectDocumentFiles()}>
                {documentsLoading ? '读取中' : '选择文件'}
              </button>
            </div>
            {documentsError ? (
              <div className="otto-right-panel__empty">文档读取失败：{documentsError}</div>
            ) : null}
            <FilePreview
              files={documentFiles}
              editable
              onOpenExternal={(file) => void window.otto.openPath(file.path)}
              onSaveTextFile={(file, content) => {
                if (file.exportFormat === 'docx' || file.exportFormat === 'pdf') {
                  return window.otto.exportEditedDocument(file.path, documentExportName(file), content)
                    .then((result) => result?.path ?? null);
                }
                return window.otto.saveTextFile(file.name, content);
              }}
            />
          </div>
        ) : null}

        {activeTab === 'memory' && enterpriseKnowledgeEnabled ? (
          <div>
            <div className="otto-worklog-panel__head">
              <div>
                <strong>{knowledgeView === 'knowledge' ? '企业知识' : '企业记忆沿革'}</strong>
                <span>{knowledgeView === 'knowledge'
                  ? '长期复现或高影响结论，经审核后保留'
                  : '按时间查看组织结论如何形成、修订与生效'}</span>
              </div>
              <div className="otto-enterprise-memory-head-actions">
                {enterpriseRole === 'company_admin' ? (
                  <button
                    type="button"
                    onClick={() => setKnowledgeEditor({ title: '', category: '制度流程', content: '' })}
                  >新增</button>
                ) : null}
                <button type="button" disabled={knowledgeLoading} onClick={() => void refreshEnterpriseKnowledge()}>
                  {knowledgeLoading ? '加载中' : '刷新'}
                </button>
              </div>
            </div>
            <div className="otto-enterprise-memory-switch" role="tablist" aria-label="企业知识与记忆">
              <button
                type="button"
                role="tab"
                aria-selected={knowledgeView === 'knowledge'}
                onClick={() => setKnowledgeView('knowledge')}
              >企业知识</button>
              <button
                type="button"
                role="tab"
                aria-selected={knowledgeView === 'timeline'}
                onClick={() => setKnowledgeView('timeline')}
              >记忆沿革</button>
            </div>
            <form
              className="otto-enterprise-memory-search"
              onSubmit={(event) => {
                event.preventDefault();
                const nextQuery = knowledgeQuery.trim();
                if (nextQuery === knowledgeAppliedQuery) {
                  void refreshEnterpriseKnowledge();
                } else {
                  setKnowledgeAppliedQuery(nextQuery);
                }
              }}
            >
              <input
                value={knowledgeQuery}
                onChange={(event) => setKnowledgeQuery(event.target.value)}
                placeholder="搜索制度、流程、项目结论"
                aria-label="搜索企业知识"
              />
              <button type="submit" disabled={knowledgeLoading}>搜索</button>
            </form>
            {knowledgeView === 'knowledge' && knowledgeEditor ? (
              <form
                className="otto-enterprise-memory-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveKnowledgeEditor();
                }}
              >
                <input
                  aria-label="知识标题"
                  value={knowledgeEditor.title}
                  onChange={(event) => setKnowledgeEditor((current) => current
                    ? { ...current, title: event.target.value }
                    : current)}
                  placeholder="知识标题"
                />
                <input
                  aria-label="知识分类"
                  value={knowledgeEditor.category}
                  onChange={(event) => setKnowledgeEditor((current) => current
                    ? { ...current, category: event.target.value }
                    : current)}
                  placeholder="例如：制度、流程、客户项目"
                />
                <textarea
                  aria-label="知识内容"
                  value={knowledgeEditor.content}
                  onChange={(event) => setKnowledgeEditor((current) => current
                    ? { ...current, content: event.target.value }
                    : current)}
                  placeholder="写清适用范围、结论和执行步骤"
                  rows={5}
                />
                <div>
                  <button type="button" onClick={() => setKnowledgeEditor(null)}>取消</button>
                  <button type="submit" disabled={Boolean(knowledgeBusyId)}>
                    {knowledgeBusyId ? '保存中' : knowledgeEditor.id ? '保存修订' : '发布知识'}
                  </button>
                </div>
              </form>
            ) : null}
            {knowledgeNotice ? (
              <div className="otto-enterprise-memory-notice" role="status">{knowledgeNotice}</div>
            ) : null}
            {knowledgeView === 'knowledge' && knowledgeCandidates.length > 0 ? (
              <section className="otto-enterprise-memory-candidates" aria-label="可沉淀的工作成果">
                <div>
                  <strong>最近成果候选</strong>
                  <span>提交后先审核，不会把个人内容静默发布给全公司</span>
                </div>
                {knowledgeCandidates.map(({ date, entry }) => {
                  const title = entry.taskTitle || entry.action;
                  const sourceId = `work-result:${date}:${entry.time}:${title}`.slice(0, 150);
                  const submitted = knowledgeItems.some((item) =>
                    item.sourceId?.endsWith(sourceId),
                  );
                  return (
                    <div className="otto-enterprise-memory-candidate" key={sourceId}>
                      <span><strong>{title}</strong><small>{date} {entry.time}</small></span>
                      <button
                        type="button"
                        disabled={submitted || knowledgeBusyId === sourceId}
                        onClick={() => void submitKnowledgeCandidate(date, entry)}
                      >
                        {submitted ? '已提交' : knowledgeBusyId === sourceId ? '提交中' : '沉淀'}
                      </button>
                    </div>
                  );
                })}
              </section>
            ) : null}
            {knowledgeError ? (
              <div className="otto-right-panel__empty">
                企业记忆加载失败：{knowledgeError}
              </div>
            ) : knowledgeLoading && knowledgeItems.length === 0 ? (
              <div className="otto-right-panel__empty">正在加载企业记忆…</div>
            ) : knowledgeItems.length === 0 ? (
              <div className="otto-right-panel__empty">
                暂无达到保留标准的企业知识。普通对话不会直接进入企业知识库。
              </div>
            ) : knowledgeView === 'timeline' ? (
              <div className="otto-enterprise-memory-timeline" aria-label="企业记忆沿革">
                {knowledgeTimeline.map((event) => (
                  <article key={`${event.knowledgeId}-${event.id}`}>
                    <time>{formatEnterpriseMemoryDate(event.createdAt)}</time>
                    <div>
                      <span>{event.department || '全组织'} · {event.category} · v{event.version}</span>
                      <strong>{event.title}</strong>
                      <p>{event.content}</p>
                      <small>{event.changedBy} · {event.changeNote}</small>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="otto-enterprise-memory-list">
                {knowledgeItems.filter((item) => item.status !== 'archived').map((item) => (
                  <article key={item.id} className="otto-enterprise-memory-card">
                    <div className="otto-enterprise-memory-card__meta">
                      <span>{item.department || '全组织'}</span>
                      <span>{item.category}</span>
                      <span>{item.status === 'pending_review' ? '待审核' : '已发布'}</span>
                      <span>v{item.version || 1}</span>
                      <span>{Math.round(item.confidence * 100)}%</span>
                    </div>
                    {(item.evidenceCount ?? 0) > 0 ? (
                      <div className="otto-enterprise-memory-card__evidence">
                        <strong>{item.evidenceCount} 条证据</strong>
                        <span>{item.distinctSessionCount || 0} 个会话</span>
                        <span>{item.distinctContributorCount || 0} 名贡献者</span>
                        {item.lastObservedAt ? (
                          <span>最近验证 {formatEnterpriseMemoryDate(item.lastObservedAt)}</span>
                        ) : null}
                      </div>
                    ) : item.sourceType === 'manual' ? (
                      <div className="otto-enterprise-memory-card__evidence">
                        <strong>管理员确认发布</strong>
                      </div>
                    ) : null}
                    {item.title && item.title !== item.category ? (
                      <strong className="otto-enterprise-memory-card__title">
                        {item.title}
                      </strong>
                    ) : null}
                    <p>{item.content}</p>
                    {item.sourceLabel || item.sourceId ? (
                      <div className="otto-enterprise-memory-card__source">
                        来源：{item.sourceLabel || item.sourceId}
                      </div>
                    ) : null}
                    <div className="otto-enterprise-memory-card__foot">
                      {item.contributor ? <span>{item.contributor}</span> : <span>系统沉淀</span>}
                      <span>{formatEnterpriseMemoryDate(item.updatedAt || item.createdAt)}</span>
                    </div>
                    {enterpriseRole === 'company_admin' ? (
                      <div className="otto-enterprise-memory-card__actions">
                        {item.status === 'pending_review' ? (
                          <button
                            type="button"
                            disabled={knowledgeBusyId === item.id}
                            onClick={() => void reviewKnowledge(item.id, 'approve')}
                          >发布</button>
                        ) : null}
                        <button
                          type="button"
                          disabled={knowledgeBusyId === item.id}
                          onClick={() => setKnowledgeEditor({
                            id: item.id,
                            title: item.title || item.category,
                            category: item.category,
                            content: item.content,
                          })}
                        >修订</button>
                        <button
                          type="button"
                          disabled={knowledgeBusyId === item.id}
                          onClick={() => void toggleKnowledgeRevisions(item.id)}
                        >{knowledgeRevisions[item.id] ? '收起版本' : '版本'}</button>
                        <button
                          type="button"
                          disabled={knowledgeBusyId === item.id}
                          onClick={() => void reviewKnowledge(item.id, 'archive')}
                        >归档</button>
                      </div>
                    ) : null}
                    {knowledgeRevisions[item.id] ? (
                      <div className="otto-enterprise-memory-revisions">
                        {knowledgeRevisions[item.id].map((revision) => (
                          <div key={revision.id}>
                            <span>v{revision.version} · {revision.changedBy || '系统'} · {formatEnterpriseMemoryDate(revision.createdAt)}</span>
                            <strong>{revision.changeNote || revision.status}</strong>
                            <p>{revision.content}</p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
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
                  setWorkReportMessage(report.message);
                } catch { /* 保留 */ }
              }}>生成今日总结</button>
              {workReportPath ? <button type="button" onClick={() => void window.otto.openPath(workReportPath)}>打开总结</button> : null}
            </div>
            <WorkLogCalendar onSelectDate={onSelectDate} byDate={worklogByDate} />
            <div className="otto-worklog-panel__tip">悬浮日期看当天成果；点击日期进入日程与工作详情。</div>
            {workReportMessage ? (
              <div className="otto-worklog-panel__summary">{workReportMessage}</div>
            ) : null}
            {workSummary ? (
              <details className="otto-worklog-panel__details">
                <summary>查看执行明细</summary>
                <pre>{workSummary.summary}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>

      {createAgentOpen ? (
        <div className="otto-custom-agent-dialog__backdrop" role="presentation">
          <section
            className="otto-custom-agent-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="创建智能体"
          >
            <div className="otto-custom-agent-dialog__head">
              <div>
                <strong>创建智能体</strong>
                <span>定义工作职责，权限仍以当前登录账号为准</span>
              </div>
              <button
                type="button"
                aria-label="关闭创建智能体"
                disabled={customAgentBusy}
                onClick={closeCreateAgent}
              >
                ×
              </button>
            </div>
            <form onSubmit={(event) => void submitCustomAgent(event)}>
              <label>
                <span>智能体名称</span>
                <input
                  autoFocus
                  maxLength={40}
                  value={customAgentName}
                  onChange={(event) => setCustomAgentName(event.target.value)}
                  placeholder="例如：招投标助手"
                />
              </label>
              <label>
                <span>职责说明</span>
                <textarea
                  maxLength={2_000}
                  rows={5}
                  value={customAgentInstructions}
                  onChange={(event) => setCustomAgentInstructions(event.target.value)}
                  placeholder="说明它负责什么、交付格式和边界"
                />
              </label>
              {customAgentError ? (
                <div className="otto-custom-agent-dialog__error" role="alert">
                  {customAgentError}
                </div>
              ) : null}
              <div className="otto-custom-agent-dialog__actions">
                <button type="button" disabled={customAgentBusy} onClick={closeCreateAgent}>
                  取消
                </button>
                <button type="submit" disabled={customAgentBusy}>
                  {customAgentBusy ? '创建中…' : '创建并启动'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {mode === 'enterprise' ? (
        <div className="otto-right-panel__bottom-actions">
          {enterpriseSkillMarketEnabled ? (
            <button type="button" className="otto-right-panel__skillzone" onClick={onOpenSkillZone}>Skill 专区</button>
          ) : null}
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
