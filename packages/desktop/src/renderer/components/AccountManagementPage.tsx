/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import type {
  EnterpriseAccount,
  EnterpriseAccountCreateInput,
  EnterpriseAccountUpdateInput,
} from '../../preload/index.js';

interface AccountDraft {
  username: string;
  password: string;
  name: string;
  role: string;
  department: string;
  tags: string;
  isAdmin: boolean;
  status: 'active' | 'disabled';
}

const EMPTY_DRAFT: AccountDraft = {
  username: '', password: '', name: '', role: '', department: '', tags: '',
  isAdmin: false, status: 'active',
};

function tagsFromText(value: string): string[] {
  return [...new Set(value.split(/[,，\n]+/).map((tag) => tag.trim()).filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AccountManagementPage({
  currentAccount,
  onBack,
}: {
  currentAccount: EnterpriseAccount;
  onBack: () => void;
}): React.JSX.Element {
  const [accounts, setAccounts] = useState<EnterpriseAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<EnterpriseAccount | 'new' | null>(null);
  const [draft, setDraft] = useState<AccountDraft>(EMPTY_DRAFT);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setAccounts(await window.otto.enterpriseAccounts());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return accounts;
    return accounts.filter((account) => [
      account.name, account.username, account.role, account.department, ...account.tags,
    ].filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(needle)));
  }, [accounts, query]);

  const openCreate = (): void => {
    setEditing('new');
    setDraft(EMPTY_DRAFT);
    setError(null);
  };

  const openEdit = (account: EnterpriseAccount): void => {
    setEditing(account);
    setDraft({
      username: account.username,
      password: '',
      name: account.name,
      role: account.role ?? '',
      department: account.department ?? '',
      tags: account.tags.join('，'),
      isAdmin: account.isAdmin,
      status: account.status,
    });
    setError(null);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const common = {
        username: draft.username.trim(),
        name: draft.name.trim(),
        role: draft.role.trim() || null,
        department: draft.department.trim() || null,
        tags: tagsFromText(draft.tags),
        isAdmin: draft.isAdmin,
      };
      let saved: EnterpriseAccount;
      if (editing === 'new') {
        const input: EnterpriseAccountCreateInput = { ...common, password: draft.password };
        saved = await window.otto.enterpriseAccountCreate(input);
        setAccounts((list) => [...list, saved]);
      } else if (editing) {
        const input: EnterpriseAccountUpdateInput = {
          ...common,
          status: draft.status,
          ...(draft.password ? { password: draft.password } : {}),
        };
        saved = await window.otto.enterpriseAccountUpdate(editing.id, input);
        setAccounts((list) => list.map((item) => item.id === saved.id ? saved : item));
      } else {
        return;
      }
      setEditing(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="otto-account-page">
      <header className="otto-account-page__head">
        <button type="button" className="otto-account-page__back" onClick={onBack}>← 返回对话</button>
        <div>
          <div className="otto-account-page__eyebrow">ACCESS DIRECTORY</div>
          <h1>账号管理</h1>
          <p>查看和维护预设账号、权限与职责标签。标签将直接参与工单路由。</p>
        </div>
        <button type="button" className="otto-account-page__create" onClick={openCreate} aria-label="新增账号">＋ 新增账号</button>
      </header>

      <section className="otto-account-page__summary" aria-label="账号概览">
        <div><strong>{accounts.length}</strong><span>全部账号</span></div>
        <div><strong>{accounts.filter((item) => item.status === 'active').length}</strong><span>可登录</span></div>
        <div><strong>{accounts.filter((item) => item.tags.includes('IT') && item.tags.includes('报修')).length}</strong><span>IT 报修接收人</span></div>
        <label>
          <span>搜索账号</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="姓名、账号、部门或标签" />
        </label>
      </section>

      {error && !editing ? <div className="otto-account-page__error" role="alert">{error}</div> : null}
      <section className="otto-account-table" aria-label="账号列表">
        <div className="otto-account-table__row otto-account-table__header">
          <span>账号</span><span>岗位</span><span>标签</span><span>权限 / 状态</span><span />
        </div>
        {loading ? <div className="otto-account-table__empty">正在从服务器读取账号…</div> : null}
        {!loading && filtered.length === 0 ? <div className="otto-account-table__empty">没有匹配的账号</div> : null}
        {filtered.map((account) => (
          <div className="otto-account-table__row" key={account.id}>
            <div className="otto-account-table__identity">
              <span className="otto-account-table__avatar">{account.name.slice(0, 1).toUpperCase()}</span>
              <div><strong>{account.name}</strong><small>@{account.username}</small></div>
            </div>
            <div><strong>{account.role || '未设置岗位'}</strong><small>{account.department || '未分配部门'}</small></div>
            <div className="otto-account-table__tags">
              {account.tags.length ? account.tags.map((tag) => <span key={tag}>{tag}</span>) : <small>暂无标签</small>}
            </div>
            <div className="otto-account-table__state">
              {account.isAdmin ? <span className="is-admin">管理员</span> : <span>成员</span>}
              <span className={account.status === 'active' ? 'is-active' : 'is-disabled'}>
                {account.status === 'active' ? '可登录' : '已停用'}
              </span>
            </div>
            <button type="button" onClick={() => openEdit(account)}>编辑</button>
          </div>
        ))}
      </section>

      {editing ? (
        <div className="otto-account-editor__overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) setEditing(null);
        }}>
          <section className="otto-account-editor" role="dialog" aria-modal="true" aria-label={editing === 'new' ? '新增账号' : '编辑账号'}>
            <header>
              <div><span>{editing === 'new' ? 'PRESET ACCOUNT' : 'ACCOUNT DETAIL'}</span><h2>{editing === 'new' ? '新增预设账号' : '编辑账号'}</h2></div>
              <button type="button" onClick={() => setEditing(null)} aria-label="关闭">×</button>
            </header>
            <div className="otto-account-editor__grid">
              <label><span>登录账号</span><input aria-label="登录账号" value={draft.username} onChange={(e) => setDraft((v) => ({ ...v, username: e.target.value }))} required /></label>
              <label><span>显示名称</span><input aria-label="显示名称" value={draft.name} onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))} required /></label>
              <label><span>{editing === 'new' ? '新密码' : '重设密码（留空不变）'}</span><input aria-label={editing === 'new' ? '新密码' : '重设密码（留空不变）'} type="password" value={draft.password} onChange={(e) => setDraft((v) => ({ ...v, password: e.target.value }))} required={editing === 'new'} /></label>
              <label><span>角色</span><input aria-label="角色" value={draft.role} onChange={(e) => setDraft((v) => ({ ...v, role: e.target.value }))} placeholder="例如：桌面支持" /></label>
              <label><span>部门</span><input aria-label="部门" value={draft.department} onChange={(e) => setDraft((v) => ({ ...v, department: e.target.value }))} placeholder="例如：IT" /></label>
              <label className="is-wide"><span>账号标签</span><input aria-label="账号标签" value={draft.tags} onChange={(e) => setDraft((v) => ({ ...v, tags: e.target.value }))} placeholder="用逗号分隔，例如：普通员工，IT，报修" /><small>工单会投递给同时命中目标标签的可登录账号。</small></label>
              {editing !== 'new' ? <label><span>账号状态</span><select aria-label="账号状态" value={draft.status} onChange={(e) => setDraft((v) => ({ ...v, status: e.target.value as AccountDraft['status'] }))}><option value="active">可登录</option><option value="disabled">停用</option></select></label> : null}
              <label className="otto-account-editor__check"><input type="checkbox" checked={draft.isAdmin} onChange={(e) => setDraft((v) => ({ ...v, isAdmin: e.target.checked }))} /><span>允许进入账号管理</span></label>
            </div>
            {error ? <div className="otto-account-page__error" role="alert">{error}</div> : null}
            <footer>
              <button type="button" onClick={() => setEditing(null)} disabled={saving}>取消</button>
              <button type="button" className="is-primary" onClick={() => void save()} disabled={saving || !draft.username.trim() || !draft.name.trim() || (editing === 'new' && draft.password.length < 8)}>{saving ? '正在保存…' : '保存账号'}</button>
            </footer>
            {editing !== 'new' && editing.id === currentAccount.id ? <p className="otto-account-editor__self">这是你当前登录的账号，权限或状态修改会在下次登录时生效。</p> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
