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
  id: string; title?: string; category: string; content: string;
  status?: 'pending_review' | 'active' | 'archived'; confidence: number;
  version?: number; contributor?: string | null; createdAt: string; updatedAt?: string;
}

export function EnterpriseMemoryDialog({ open, role, onClose }: {
  open: boolean; role?: CentralEnterpriseRole; onClose(): void;
}): React.JSX.Element | null {
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<{ id?: string; title: string; category: string; content: string } | null>(null);
  const [revisions, setRevisions] = useState<Record<string, Array<{ id: string; version: number; content: string }>>>({});
  const epochRef = useRef(0);
  const queryRef = useRef('');
  queryRef.current = query;
  const refresh = useCallback(async (): Promise<void> => {
    const epoch = ++epochRef.current;
    setLoading(true); setError('');
    try {
      const next = await window.otto.enterpriseKnowledgeList({ query: queryRef.current.trim() || undefined, includeReview: true });
      if (epoch === epochRef.current) setItems(next);
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
    }
  }, [open, refresh]);
  if (!open) return null;
  const save = async (): Promise<void> => {
    if (!editor || !editor.title.trim() || !editor.category.trim() || !editor.content.trim()) { setError('请完整填写标题、分类和知识内容。'); return; }
    const epoch = epochRef.current;
    try {
      if (editor.id) await window.otto.enterpriseKnowledgeRevise(editor.id, { title: editor.title.trim(), category: editor.category.trim(), content: editor.content.trim(), confidence: 0.95, changeNote: '管理员在企业记忆弹窗中修订' });
      else await window.otto.enterpriseKnowledgeRecord({ sourceId: `manual:${crypto.randomUUID()}`, title: editor.title.trim(), category: editor.category.trim(), content: editor.content.trim(), confidence: 0.95, sourceType: 'manual', sourceLabel: '企业管理员手动录入' });
      if (epoch !== epochRef.current) return;
      setEditor(null); setNotice(editor.id ? '知识已修订。' : '企业知识已发布。'); await refresh();
    } catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const review = async (id: string, action: 'approve' | 'archive'): Promise<void> => {
    const epoch = epochRef.current;
    try { await window.otto.enterpriseKnowledgeReview(id, action); if (epoch !== epochRef.current) return; setNotice(action === 'approve' ? '知识已发布。' : '知识已归档。'); await refresh(); }
    catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const toggleRevisions = async (id: string): Promise<void> => {
    if (revisions[id]?.length) { setRevisions((current) => ({ ...current, [id]: [] })); return; }
    const epoch = epochRef.current;
    try {
      const loaded = await window.otto.enterpriseKnowledgeRevisions(id);
      if (epoch === epochRef.current) setRevisions((current) => ({ ...current, [id]: loaded }));
    } catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <DialogFrame title="企业记忆" onClose={onClose}>
    <div className="otto-workspace-dialog__toolbar">
      <form onSubmit={(event) => { event.preventDefault(); void refresh(); }}><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索企业知识" placeholder="搜索制度、流程、项目结论"/><button type="submit">搜索</button></form>
      {role === 'company_admin' ? <button type="button" onClick={() => setEditor({ title: '', category: '制度流程', content: '' })}>新增知识</button> : null}
      <button type="button" disabled={loading} onClick={() => void refresh()}>{loading ? '加载中…' : '刷新'}</button>
    </div>
    {editor ? <form className="otto-workspace-dialog__editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <input aria-label="知识标题" value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })}/>
      <input aria-label="知识分类" value={editor.category} onChange={(event) => setEditor({ ...editor, category: event.target.value })}/>
      <textarea aria-label="知识内容" rows={6} value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })}/>
      <div><button type="button" onClick={() => setEditor(null)}>取消</button><button type="submit">保存</button></div>
    </form> : null}
    {error ? <p role="alert" className="otto-workspace-dialog__error">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    <div className="otto-workspace-dialog__list">{items.filter((item) => item.status !== 'archived').map((item) => <article key={item.id}>
      <div><span>{item.category}</span><span>{item.status === 'pending_review' ? '待审核' : '已发布'}</span><span>v{item.version ?? 1}</span></div>
      <h3>{item.title || item.category}</h3><p>{item.content}</p><small>{item.contributor || '系统沉淀'} · {new Date(item.updatedAt || item.createdAt).toLocaleDateString('zh-CN')}</small>
      {role === 'company_admin' ? <footer>{item.status === 'pending_review' ? <button type="button" onClick={() => void review(item.id, 'approve')}>发布</button> : null}<button type="button" onClick={() => setEditor({ id: item.id, title: item.title || item.category, category: item.category, content: item.content })}>修订</button><button type="button" onClick={() => void toggleRevisions(item.id)}>{revisions[item.id]?.length ? '收起版本' : '版本'}</button><button type="button" onClick={() => void review(item.id, 'archive')}>归档</button></footer> : null}
      {revisions[item.id]?.map((revision) => <blockquote key={revision.id}>v{revision.version} · {revision.content}</blockquote>)}
    </article>)}{!loading && !items.length ? <p>暂无企业知识。</p> : null}</div>
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
