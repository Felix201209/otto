/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AutoSkillCandidateInfo } from 'otto-server';
import type { CentralEnterpriseRole } from '../state/centralEnterpriseIdentity.js';
import type { CustomAgentDefinition, CustomAgentDraft } from '../customAgents.js';

function DialogFrame({ title, onClose, children }: {
  title: string; onClose(): void; children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab' || !ref.current) return;
      const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus.current && document.contains(previousFocus.current)) previousFocus.current.focus();
    };
  }, []);
  return createPortal(
    <div className="otto-workspace-dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={ref} className="otto-workspace-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button type="button" aria-label={`关闭${title}`} onClick={onClose}>×</button></header>
        <div className="otto-workspace-dialog__body">{children}</div>
      </section>
    </div>, document.body,
  );
}

interface KnowledgeItem {
  id: string; title?: string; department?: string | null; category: string; content: string;
  status?: 'pending_review' | 'active' | 'archived'; confidence: number;
  version?: number; contributor?: string | null; createdAt: string; updatedAt?: string;
  sourceId?: string | null; sourceType?: string; sourceLabel?: string | null;
  evidenceCount?: number; distinctSessionCount?: number; distinctContributorCount?: number;
  lastObservedAt?: string | null;
}

interface KnowledgeRevision {
  id: string; version: number; title?: string; category?: string; content: string;
  changedBy?: string | null; changeNote?: string | null; status?: string; createdAt?: string;
}

interface KnowledgeCandidate {
  date: string;
  entry: {
    time: string; category: string; action: string; success: boolean; details?: string;
    entryType: 'tool' | 'work_result'; taskTitle?: string;
  };
}

function formatKnowledgeDate(value: string | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString('zh-CN');
}

export function EnterpriseMemoryDialog({ open, role, onClose }: {
  open: boolean; role?: CentralEnterpriseRole; onClose(): void;
}): React.JSX.Element | null {
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<'knowledge' | 'timeline'>('knowledge');
  const [candidates, setCandidates] = useState<KnowledgeCandidate[]>([]);
  const [busyId, setBusyId] = useState('');
  const [editor, setEditor] = useState<{ id?: string; title: string; category: string; content: string } | null>(null);
  const [revisions, setRevisions] = useState<Record<string, KnowledgeRevision[]>>({});
  const epochRef = useRef(0);
  const queryRef = useRef('');
  queryRef.current = query;
  const refresh = useCallback(async (): Promise<void> => {
    const epoch = ++epochRef.current;
    setLoading(true); setError('');
    try {
      const [next, recentWork] = await Promise.all([
        window.otto.enterpriseKnowledgeList({ query: queryRef.current.trim() || undefined, includeReview: true }),
        window.otto.workLogRecent(7).catch(() => []),
      ]);
      if (epoch === epochRef.current) {
        setItems(next);
        setCandidates(recentWork
          .flatMap((day) => day.entries.map((entry) => ({ date: day.date, entry })))
          .filter(({ entry }) => entry.entryType === 'work_result' && entry.success)
          .slice(0, 3));
      }
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (epoch === epochRef.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (open) void refresh();
    else {
      epochRef.current += 1;
      queryRef.current = '';
      setQuery(''); setItems([]); setLoading(false);
      setEditor(null); setRevisions({}); setError(''); setNotice('');
      setView('knowledge'); setCandidates([]); setBusyId('');
    }
  }, [open, refresh]);
  const requestClose = (): void => {
    if (editor && (editor.title.trim() || editor.content.trim())
      && !window.confirm('当前企业知识草稿尚未保存，确定关闭吗？')) return;
    onClose();
  };
  const save = async (): Promise<void> => {
    if (!editor || !editor.title.trim() || !editor.category.trim() || !editor.content.trim()) { setError('请完整填写标题、分类和知识内容。'); return; }
    const epoch = epochRef.current;
    const operationId = editor.id || 'new-knowledge';
    setBusyId(operationId);
    try {
      if (editor.id) await window.otto.enterpriseKnowledgeRevise(editor.id, { title: editor.title.trim(), category: editor.category.trim(), content: editor.content.trim(), confidence: 0.95, changeNote: '管理员在企业记忆弹窗中修订' });
      else await window.otto.enterpriseKnowledgeRecord({ sourceId: `manual:${crypto.randomUUID()}`, title: editor.title.trim(), category: editor.category.trim(), content: editor.content.trim(), confidence: 0.95, sourceType: 'manual', sourceLabel: '企业管理员手动录入' });
      if (epoch !== epochRef.current) return;
      setEditor(null); setNotice(editor.id ? '知识已修订。' : '企业知识已发布。'); setBusyId(''); await refresh();
    } catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const review = async (id: string, action: 'approve' | 'archive'): Promise<void> => {
    const epoch = epochRef.current;
    setBusyId(id);
    try { await window.otto.enterpriseKnowledgeReview(id, action); if (epoch !== epochRef.current) return; setNotice(action === 'approve' ? '知识已发布。' : '知识已归档。'); setRevisions((current) => { const next = { ...current }; delete next[id]; return next; }); setBusyId(''); await refresh(); }
    catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const toggleRevisions = async (id: string): Promise<void> => {
    if (revisions[id] !== undefined) { setRevisions((current) => { const next = { ...current }; delete next[id]; return next; }); return; }
    const epoch = epochRef.current;
    setBusyId(id);
    try {
      const loaded = await window.otto.enterpriseKnowledgeRevisions(id);
      if (epoch === epochRef.current) setRevisions((current) => ({ ...current, [id]: loaded }));
    } catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  useEffect(() => {
    if (!open || view !== 'timeline' || role !== 'company_admin') return;
    const missing = items.filter((item) => item.status !== 'archived' && revisions[item.id] === undefined);
    if (!missing.length) return;
    const epoch = epochRef.current;
    void Promise.all(missing.map(async (item) => ({
      id: item.id,
      loaded: await window.otto.enterpriseKnowledgeRevisions(item.id),
    }))).then((loaded) => {
      if (epoch !== epochRef.current) return;
      setRevisions((current) => ({
        ...current,
        ...Object.fromEntries(loaded.map((entry) => [entry.id, entry.loaded])),
      }));
    }).catch((cause) => {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [items, open, revisions, role, view]);
  const submitCandidate = async ({ date, entry }: KnowledgeCandidate): Promise<void> => {
    const title = (entry.taskTitle || entry.action || '工作成果').trim();
    const sourceId = `work-result:${date}:${entry.time}:${title}`.slice(0, 150);
    const epoch = epochRef.current;
    setBusyId(sourceId); setError(''); setNotice('');
    try {
      const result = await window.otto.enterpriseKnowledgeRecord({
        sourceId, title, category: entry.category || 'work_result',
        content: [title, entry.details].filter(Boolean).join('\n'), confidence: 0.82,
        sourceType: 'work_result', sourceLabel: `${date} ${entry.time} Otto 工作成果`,
      });
      if (epoch !== epochRef.current) return;
      setNotice(result.reviewStatus === 'active' ? '已沉淀为企业知识。'
        : result.status === 'exists' ? '这项成果已经在审核队列中。'
          : '已提交为知识候选，管理员确认后会进入企业知识库。');
      setBusyId('');
      await refresh();
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const timeline = items.filter((item) => !item.status || item.status === 'active')
    .flatMap((item) => (revisions[item.id]?.length ? revisions[item.id] : [{
      id: `current-${item.id}`, version: item.version ?? 1, title: item.title,
      category: item.category, content: item.content, changedBy: item.contributor,
      changeNote: '当前版本', createdAt: item.updatedAt || item.createdAt,
    }]).map((revision) => ({ item, revision })))
    .sort((left, right) => (right.revision.createdAt || '').localeCompare(left.revision.createdAt || ''));
  if (!open) return null;
  return <DialogFrame title="企业记忆" onClose={requestClose}>
    <div role="tablist" aria-label="企业知识与记忆" className="otto-enterprise-memory-switch">
      <button type="button" role="tab" aria-selected={view === 'knowledge'} onClick={() => setView('knowledge')}>企业知识</button>
      <button type="button" role="tab" aria-selected={view === 'timeline'} onClick={() => setView('timeline')}>记忆沿革</button>
    </div>
    <div className="otto-workspace-dialog__toolbar">
      <form onSubmit={(event) => { event.preventDefault(); void refresh(); }}><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索企业知识" placeholder="搜索制度、流程、项目结论"/><button type="submit">搜索</button></form>
      {role === 'company_admin' ? <button type="button" onClick={() => setEditor({ title: '', category: '制度流程', content: '' })}>新增知识</button> : null}
      <button type="button" disabled={loading} onClick={() => void refresh()}>{loading ? '加载中…' : '刷新'}</button>
    </div>
    {view === 'knowledge' && editor ? <form className="otto-workspace-dialog__editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <input aria-label="知识标题" value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })}/>
      <input aria-label="知识分类" value={editor.category} onChange={(event) => setEditor({ ...editor, category: event.target.value })}/>
      <textarea aria-label="知识内容" rows={6} value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })}/>
      <div><button type="button" disabled={Boolean(busyId)} onClick={() => setEditor(null)}>取消</button><button type="submit" disabled={Boolean(busyId)}>{busyId ? '保存中…' : '保存'}</button></div>
    </form> : null}
    {error ? <p role="alert" className="otto-workspace-dialog__error">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {view === 'knowledge' && candidates.length ? <section className="otto-enterprise-memory-candidates" aria-label="可沉淀的工作成果">
      <strong>最近成果候选</strong><span>提交后先审核，不会静默发布给全公司</span>
      {candidates.map((candidate) => {
        const title = candidate.entry.taskTitle || candidate.entry.action;
        const sourceId = `work-result:${candidate.date}:${candidate.entry.time}:${title}`.slice(0, 150);
        const submitted = items.some((item) => item.sourceId?.endsWith(sourceId));
        return <div key={sourceId}><span><strong>{title}</strong><small>{candidate.date} {candidate.entry.time}</small></span><button type="button" disabled={submitted || busyId === sourceId} onClick={() => void submitCandidate(candidate)}>{submitted ? '已提交' : busyId === sourceId ? '提交中…' : '沉淀'}</button></div>;
      })}
    </section> : null}
    {view === 'timeline' ? <div className="otto-enterprise-memory-timeline" aria-label="企业记忆沿革">{timeline.map(({ item, revision }) => <article key={`${item.id}-${revision.id}`}>
      <time>{formatKnowledgeDate(revision.createdAt)}</time><div><span>{item.department || '全组织'} · {revision.category || item.category} · v{revision.version}</span><strong>{revision.title || item.title || item.category}</strong><p>{revision.content}</p><small>{revision.changedBy || item.contributor || '系统沉淀'} · {revision.changeNote || revision.status || '形成知识'}</small></div>
    </article>)}</div> : <div className="otto-workspace-dialog__list">{items.filter((item) => item.status !== 'archived').map((item) => <article key={item.id}>
      <div><span>{item.department || '全组织'}</span><span>{item.category}</span><span>{item.status === 'pending_review' ? '待审核' : '已发布'}</span><span>v{item.version ?? 1}</span><span>{Math.round(item.confidence * 100)}%</span></div>
      {item.evidenceCount ? <div><strong>{item.evidenceCount} 条证据</strong><span>{item.distinctSessionCount || 0} 个会话</span><span>{item.distinctContributorCount || 0} 名贡献者</span>{item.lastObservedAt ? <span>最近验证 {formatKnowledgeDate(item.lastObservedAt)}</span> : null}</div> : item.sourceType === 'manual' ? <div><strong>管理员确认发布</strong></div> : null}
      <h3>{item.title || item.category}</h3><p>{item.content}</p>{item.sourceLabel || item.sourceId ? <div>来源：{item.sourceLabel || item.sourceId}</div> : null}<small>{item.contributor || '系统沉淀'} · {formatKnowledgeDate(item.updatedAt || item.createdAt)}</small>
      {role === 'company_admin' ? <footer>{item.status === 'pending_review' ? <button type="button" disabled={busyId === item.id} onClick={() => void review(item.id, 'approve')}>发布</button> : null}<button type="button" disabled={busyId === item.id} onClick={() => setEditor({ id: item.id, title: item.title || item.category, category: item.category, content: item.content })}>修订</button><button type="button" disabled={busyId === item.id} onClick={() => void toggleRevisions(item.id)}>{revisions[item.id] !== undefined ? '收起版本' : '版本'}</button><button type="button" disabled={busyId === item.id} onClick={() => void review(item.id, 'archive')}>归档</button></footer> : null}
      {revisions[item.id]?.map((revision) => <blockquote key={revision.id}>v{revision.version} · {revision.changedBy || '系统'} · {revision.changeNote || revision.status}<p>{revision.content}</p></blockquote>)}
    </article>)}{!loading && !items.length ? <p>暂无企业知识。</p> : null}</div>}
  </DialogFrame>;
}

export function AutoSkillDialog({ open, candidates, lastAction, onRefresh, onConfirm, onReject, onClose }: {
  open: boolean; candidates: AutoSkillCandidateInfo[];
  lastAction: { kind: 'confirmed' | 'rejected'; candidateId: string; savedPath?: string } | null;
  onRefresh(): void; onConfirm(id: string): void; onReject(id: string): void; onClose(): void;
}): React.JSX.Element | null {
  if (!open) return null;
  return <DialogFrame title="自动 Skill 候选" onClose={onClose}><div className="otto-workspace-dialog__toolbar"><p>从重复工作成果中沉淀可复用流程。</p><button type="button" onClick={onRefresh}>立即分析</button></div>{lastAction?.kind === 'confirmed' ? <p role="status">Skill 已生成{lastAction.savedPath ? `：${lastAction.savedPath}` : ''}</p> : null}<div className="otto-workspace-dialog__list">{candidates.length ? candidates.map((candidate) => <article key={candidate.id}><h3>{candidate.name}</h3><p>{candidate.description}</p><small>{candidate.detectedPattern} · {candidate.occurrenceCount} 次重复</small><footer><button type="button" onClick={() => onConfirm(candidate.id)}>{candidate.recommendation === 'enhance' ? '确认增强' : '确认生成'}</button><button type="button" onClick={() => onReject(candidate.id)}>不再建议</button></footer></article>) : <p>暂无候选。点击“立即分析”扫描最近成果。</p>}</div></DialogFrame>;
}

export function CustomAgentManagerDialog({ open, agents, onCreate, onDelete, onClose }: {
  open: boolean; agents: readonly CustomAgentDefinition[]; onCreate(draft: CustomAgentDraft): void | Promise<void>; onDelete(id: string): void; onClose(): void;
}): React.JSX.Element | null {
  const [name, setName] = useState(''); const [instructions, setInstructions] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    if (!open) { setName(''); setInstructions(''); setError(''); }
  }, [open]);
  if (!open) return null;
  return <DialogFrame title="我的专家" onClose={onClose}><form className="otto-workspace-dialog__editor" onSubmit={(event) => { event.preventDefault(); setError(''); void Promise.resolve(onCreate({ name, instructions })).then(() => { setName(''); setInstructions(''); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }}><input aria-label="专家名称" maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：招投标助手"/><textarea aria-label="职责说明" maxLength={2000} rows={4} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="说明职责、交付格式和边界"/>{error ? <p role="alert" className="otto-workspace-dialog__error">{error}</p> : null}<button type="submit">创建专家</button></form><div className="otto-workspace-dialog__list">{agents.map((agent) => <article key={agent.id}><h3>{agent.name}</h3><p>{agent.instructions}</p><footer><button type="button" onClick={() => { if (window.confirm(`删除专家“${agent.name}”？`)) onDelete(agent.id); }}>删除</button></footer></article>)}{!agents.length ? <p>还没有自定义专家。</p> : null}</div></DialogFrame>;
}
