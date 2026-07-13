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
  phone: string;
  role: string;
  department: string;
  tags: string;
  isAdmin: boolean;
  status: 'active' | 'disabled';
}

const EMPTY_DRAFT: AccountDraft = {
  username: '', password: '', name: '', phone: '', role: '', department: '', tags: '',
  isAdmin: false, status: 'active',
};

function tagsFromText(value: string): string[] {
  return [...new Set(value.split(/[,，\n]+/).map((tag) => tag.trim()).filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maskedPhone(phone: string | null): string {
  if (!phone) return '未绑定手机';
  const local = phone.replace(/^\+86/, '');
  return `+86 ${local.slice(0, 3)} **** ${local.slice(-4)}`;
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.otto.enterpriseAccounts()
      .then((result) => {
        if (!cancelled) setAccounts(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return accounts;
    return accounts.filter((account) => [
      account.name, account.username, account.phone, account.role, account.department, ...account.tags,
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
      phone: account.phone?.replace(/^\+86/, '') ?? '',
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
        phone: draft.phone.trim() || null,
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

  const activeCount = accounts.filter((item) => item.status === 'active').length;
  const smsCount = accounts.filter((item) => item.phone).length;
  const adminCount = accounts.filter((item) => item.isAdmin).length;

  return (
    <main className="otto-account-page">
      <header className="otto-account-hero">
        <div>
          <button type="button" className="otto-account-page__back" onClick={onBack}>← 返回工作台</button>
          <div className="otto-account-page__eyebrow">IDENTITY &amp; ACCESS</div>
          <h1>企业身份控制台</h1>
          <p>集中管理登录方式、组织角色与职责标签。手机号绑定后即可使用验证码登录。</p>
        </div>
        <button type="button" className="otto-account-page__create" onClick={openCreate} aria-label="新增账号"><span>＋</span> 新增成员</button>
      </header>

      <section className="otto-account-metrics" aria-label="账号概览">
        <article><span>成员总数</span><strong>{accounts.length}</strong><small>组织身份目录</small></article>
        <article><span>可登录</span><strong>{activeCount}</strong><small>{accounts.length - activeCount} 个已停用</small></article>
        <article><span>短信登录覆盖</span><strong>{smsCount}<i>/{accounts.length || 0}</i></strong><small>{smsCount === accounts.length && accounts.length > 0 ? '已全部绑定' : '仍有账号未绑定手机'}</small></article>
        <article><span>管理员</span><strong>{adminCount}</strong><small>拥有身份管理权限</small></article>
      </section>

      <section className="otto-account-directory">
        <header>
          <div><h2>成员目录</h2><p>账号状态与权限变更实时同步到登录网关。</p></div>
          <label className="otto-account-search"><span aria-hidden>⌕</span><input aria-label="搜索账号" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名、手机、部门或标签" /></label>
        </header>

        {error && !editing ? <div className="otto-account-page__error" role="alert">{error}</div> : null}
        <div className="otto-account-table" role="table" aria-label="账号列表">
          <div className="otto-account-table__row otto-account-table__header" role="row">
            <span>成员</span><span>组织信息</span><span>职责标签</span><span>访问状态</span><span />
          </div>
          {loading ? <div className="otto-account-table__empty">正在同步企业身份目录…</div> : null}
          {!loading && filtered.length === 0 ? <div className="otto-account-table__empty">没有匹配的成员</div> : null}
          {filtered.map((account) => (
            <div className="otto-account-table__row" role="row" key={account.id}>
              <div className="otto-account-table__identity"><span className="otto-account-table__avatar">{account.name.slice(0, 1).toUpperCase()}</span><div><strong>{account.name}</strong><small>@{account.username} · {maskedPhone(account.phone)}</small></div></div>
              <div><strong>{account.role || '未设置岗位'}</strong><small>{account.department || '未分配部门'}</small></div>
              <div className="otto-account-table__tags">{account.tags.length ? account.tags.map((tag) => <span key={tag}>{tag}</span>) : <small>暂无标签</small>}</div>
              <div className="otto-account-table__state">{account.isAdmin ? <span className="is-admin">管理员</span> : <span>成员</span>}<span className={account.status === 'active' ? 'is-active' : 'is-disabled'}>{account.status === 'active' ? '可登录' : '已停用'}</span>{account.phone ? <span className="is-sms">短信</span> : null}</div>
              <button type="button" onClick={() => openEdit(account)} aria-label={`编辑 ${account.name}`}>编辑</button>
            </div>
          ))}
        </div>
      </section>

      {editing ? (
        <div className="otto-account-editor__overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEditing(null); }}>
          <section className="otto-account-editor" role="dialog" aria-modal="true" aria-label={editing === 'new' ? '新增账号' : '编辑账号'}>
            <header><div><span>{editing === 'new' ? 'NEW IDENTITY' : 'IDENTITY DETAIL'}</span><h2>{editing === 'new' ? '添加企业成员' : '编辑成员身份'}</h2><p>账号、手机和角色决定成员如何进入 Otto 及能访问的空间。</p></div><button type="button" onClick={() => setEditing(null)} aria-label="关闭">×</button></header>
            <div className="otto-account-editor__grid">
              <label><span>登录账号</span><input aria-label="登录账号" value={draft.username} onChange={(e) => setDraft((v) => ({ ...v, username: e.target.value }))} required /></label>
              <label><span>显示名称</span><input aria-label="显示名称" value={draft.name} onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))} required /></label>
              <label><span>手机号码</span><input aria-label="手机号码" inputMode="tel" value={draft.phone} onChange={(e) => setDraft((v) => ({ ...v, phone: e.target.value }))} placeholder="用于短信验证码登录" /></label>
              <label><span>{editing === 'new' ? '初始密码' : '重设密码（留空不变）'}</span><input aria-label={editing === 'new' ? '初始密码' : '重设密码（留空不变）'} type="password" value={draft.password} onChange={(e) => setDraft((v) => ({ ...v, password: e.target.value }))} required={editing === 'new'} /></label>
              <label><span>角色</span><input aria-label="角色" value={draft.role} onChange={(e) => setDraft((v) => ({ ...v, role: e.target.value }))} placeholder="例如：桌面支持" /></label>
              <label><span>部门</span><input aria-label="部门" value={draft.department} onChange={(e) => setDraft((v) => ({ ...v, department: e.target.value }))} placeholder="例如：IT" /></label>
              <label className="is-wide"><span>职责标签</span><input aria-label="账号标签" value={draft.tags} onChange={(e) => setDraft((v) => ({ ...v, tags: e.target.value }))} placeholder="用逗号分隔，例如：普通员工，IT，报修" /><small>标签参与专家权限、工单和任务路由。</small></label>
              {editing !== 'new' ? <label><span>账号状态</span><select aria-label="账号状态" value={draft.status} onChange={(e) => setDraft((v) => ({ ...v, status: e.target.value as AccountDraft['status'] }))}><option value="active">可登录</option><option value="disabled">停用</option></select></label> : null}
              <label className="otto-account-editor__check"><input type="checkbox" checked={draft.isAdmin} onChange={(e) => setDraft((v) => ({ ...v, isAdmin: e.target.checked }))} /><span>授予身份管理权限</span></label>
            </div>
            {error ? <div className="otto-account-page__error" role="alert">{error}</div> : null}
            <footer><button type="button" onClick={() => setEditing(null)} disabled={saving}>取消</button><button type="button" className="is-primary" onClick={() => void save()} disabled={saving || !draft.username.trim() || !draft.name.trim() || (editing === 'new' && draft.password.length < 8)}>{saving ? '正在保存…' : '保存身份'}</button></footer>
            {editing !== 'new' && editing.id === currentAccount.id ? <p className="otto-account-editor__self">这是你当前登录的账号；停用或降权将在会话重新校验后生效。</p> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
