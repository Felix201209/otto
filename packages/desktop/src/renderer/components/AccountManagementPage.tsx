/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EnterpriseAccount,
  EnterpriseAccountCreateInput,
  EnterpriseAccountUpdateInput,
  EnterpriseOrganizationInviteContext,
  EnterpriseParkSurveyResult,
} from '../../preload/index.js';

export interface AccountDraft {
  username: string;
  password: string;
  name: string;
  phone: string;
  feishuOpenId: string;
  role: string;
  department: string;
  tags: string;
  isAdmin: boolean;
  status: 'active' | 'disabled';
}

const EMPTY_DRAFT: AccountDraft = {
  username: '', password: '', name: '', phone: '', feishuOpenId: '', role: '', department: '', tags: '',
  isAdmin: false, status: 'active',
};

export const ACCOUNT_TAG_PRESETS = [
  '普通成员', '部门负责人', '行政', '人事', '财务', '审批', '法务', '销售',
  '市场', '产品', '研发', '设计', 'IT', '报修', '维修工作人员', '客服人员', '技术支持', '客户支持', '采购', '数据',
] as const;

export const ACCOUNT_DEPARTMENT_PRESETS = [
  '总经办', '人力资源部', '财务部', '法务部', '销售部', '市场部',
  '产品部', '研发部', '设计部', 'IT部', '客户成功部',
] as const;

const ACCOUNT_TEMPLATES = [
  { id: 'member', label: '普通成员', role: '成员', department: '', tags: ['普通成员'], isAdmin: false },
  { id: 'department-lead', label: '部门负责人', role: '部门负责人', department: '', tags: ['部门负责人', '审批'], isAdmin: false },
  { id: 'it-support', label: '维修工作人员', role: 'IT 支持', department: 'IT部', tags: ['IT', '报修', '维修工作人员', '技术支持'], isAdmin: false },
  { id: 'park-service', label: '园区客服人员', role: '园区客服', department: '客户成功部', tags: ['客服人员', '客户支持'], isAdmin: false },
  { id: 'administrator', label: '系统管理员', role: '系统管理员', department: 'IT部', tags: ['IT', '系统管理员'], isAdmin: true },
] as const;

export type AccountTemplateId = typeof ACCOUNT_TEMPLATES[number]['id'];

const PARK_SERVICE_OPTIONS = [
  { id: 'announcement', label: '园区公告' },
  { id: 'satisfaction', label: '满意度调查' },
] as const;

function tagsFromText(value: string): string[] {
  return [...new Set(value.split(/[,，\n]+/).map((tag) => tag.trim()).filter(Boolean))];
}

export function toggleAccountTag(value: string, tag: string): string {
  const tags = tagsFromText(value);
  const next = tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag];
  return next.join('，');
}

export function applyAccountTemplate(draft: AccountDraft, templateId: AccountTemplateId): AccountDraft {
  const template = ACCOUNT_TEMPLATES.find((item) => item.id === templateId);
  if (!template) return draft;
  return {
    ...draft,
    role: template.role,
    department: template.department || draft.department,
    tags: template.tags.join('，'),
    isAdmin: template.isAdmin,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutIpcPrefix = message.replace(/^Error invoking remote method '[^']+':\s*/, '');
  return withoutIpcPrefix.replace(/^Error:\s*/, '') || '操作失败，请稍后重试';
}

function maskedPhone(phone: string | null): string {
  if (!phone) return '未绑定手机';
  const local = phone.replace(/^\+86/, '');
  return `+86 ${local.slice(0, 3)} **** ${local.slice(-4)}`;
}

function formatLastUsedAt(value: string | null): string {
  if (!value) return '尚无使用记录';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '最后使用时间不可用';
  return `最后使用 ${new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })}`;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), '
    + 'a[href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getAttribute('aria-hidden') !== 'true' && element.tabIndex >= 0);
}

export function formatInviteRemaining(expiresAt: string, now = Date.now()): string {
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining)) return '失效时间不可用';
  if (remaining <= 0) return '已失效，请生成新链接';
  const totalSeconds = Math.ceil(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours} 小时 ${minutes} 分 ${seconds} 秒后失效`;
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
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [draft, setDraft] = useState<AccountDraft>(EMPTY_DRAFT);
  const [inviteContext, setInviteContext] = useState<EnterpriseOrganizationInviteContext | null>(null);
  const [inviteLoading, setInviteLoading] = useState(currentAccount.isAdmin);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteDepartment, setInviteDepartment] = useState('');
  const [invitePosition, setInvitePosition] = useState('');
  const [inviteRole, setInviteRole] = useState('');
  const [inviteMaxUses, setInviteMaxUses] = useState('');
  const [parkPushRecipientId, setParkPushRecipientId] = useState('');
  const [parkPushServiceId, setParkPushServiceId] = useState<typeof PARK_SERVICE_OPTIONS[number]['id']>('announcement');
  const [parkPushNote, setParkPushNote] = useState('');
  const [parkPushBusy, setParkPushBusy] = useState(false);
  const [parkPushMessage, setParkPushMessage] = useState<string | null>(null);
  const [parkPushError, setParkPushError] = useState<string | null>(null);
  const [parkSurveyResults, setParkSurveyResults] = useState<EnterpriseParkSurveyResult[]>([]);
  const [parkSurveyError, setParkSurveyError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const invite = inviteContext?.invite;

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

  useEffect(() => {
    if (!currentAccount.isAdmin) return undefined;
    let cancelled = false;
    setInviteLoading(true);
    void window.otto.enterpriseOrganizationInviteGet()
      .then((result) => {
        if (!cancelled) setInviteContext(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setInviteError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setInviteLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentAccount.isAdmin]);

  useEffect(() => {
    if (!invite) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [invite]);

  useEffect(() => {
    if (invite) {
      setInviteDepartment(invite.defaultDepartment ?? '');
      setInvitePosition(invite.positionTitle ?? '');
      setInviteRole(invite.defaultRole ?? '');
      setInviteMaxUses(invite.maxUses == null ? '' : String(invite.maxUses));
    }
  }, [invite]);

  useEffect(() => {
    if (!editing) return undefined;
    const content = contentRef.current;
    initialFocusRef.current?.focus();
    return () => {
      content?.removeAttribute('inert');
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [editing]);

  useEffect(() => {
    if (editing) contentRef.current?.setAttribute('inert', '');
    else contentRef.current?.removeAttribute('inert');
  }, [editing]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return accounts;
    return accounts.filter((account) => [
      account.name, account.username, account.phone, account.role, account.department, ...account.tags,
    ].filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(needle)));
  }, [accounts, query]);
  const departmentOptions = useMemo(() => {
    const result = new Set<string>(ACCOUNT_DEPARTMENT_PRESETS);
    for (const account of accounts) {
      if (account.department?.trim()) result.add(account.department.trim());
    }
    return [...result];
  }, [accounts]);
  const parkPushRecipients = useMemo(
    () => accounts.filter((account) => account.status === 'active'),
    [accounts],
  );
  const refreshParkSurveyResults = useCallback(async (): Promise<void> => {
    if (!currentAccount.isAdmin) return;
    try {
      setParkSurveyResults(await window.otto.enterpriseParkSurveyResults());
      setParkSurveyError(null);
    } catch (cause) {
      setParkSurveyError(errorMessage(cause));
    }
  }, [currentAccount.isAdmin]);

  useEffect(() => {
    void refreshParkSurveyResults();
  }, [refreshParkSurveyResults]);

  const openCreate = (): void => {
    if (loading) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setEditing('new');
    setDeleteArmed(false);
    setDraft(EMPTY_DRAFT);
    setError(null);
  };

  const openEdit = (account: EnterpriseAccount): void => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setEditing(account);
    setDeleteArmed(false);
    setDraft({
      username: account.username,
      password: '',
      name: account.name,
      phone: account.phone?.replace(/^\+86/, '') ?? '',
      feishuOpenId: account.feishuOpenId ?? '',
      role: account.role ?? '',
      department: account.department ?? '',
      tags: account.tags.join('，'),
      isAdmin: account.isAdmin,
      status: account.status,
    });
    setError(null);
  };

  const closeEditor = (): void => {
    if (!saving) {
      setEditing(null);
      setDeleteArmed(false);
    }
  };

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEditor();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const common = {
        username: draft.username.trim(),
        name: draft.name.trim(),
        phone: draft.phone.trim() || null,
        feishuOpenId: draft.feishuOpenId.trim() || null,
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
      setDeleteArmed(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const deleteEditingAccount = async (): Promise<void> => {
    if (!editing || editing === 'new' || editing.id === currentAccount.id) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.otto.enterpriseAccountDelete(editing.id);
      setAccounts((list) => list.filter((account) => account.id !== editing.id));
      setEditing(null);
      setDeleteArmed(false);
    } catch (cause) {
      setDeleteArmed(false);
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const issueInvite = async (): Promise<void> => {
    setInviteBusy(true);
    setInviteError(null);
    setCopied(null);
    try {
      const result = await window.otto.enterpriseOrganizationInviteIssue({
        defaultDepartment: inviteDepartment.trim() || null,
        positionTitle: invitePosition.trim() || null,
        defaultRole: inviteRole.trim() || null,
        maxUses: inviteMaxUses.trim() ? Number(inviteMaxUses.trim()) : null,
      });
      setInviteContext(result);
      setNow(Date.now());
    } catch (cause) {
      setInviteError(errorMessage(cause));
    } finally {
      setInviteBusy(false);
    }
  };

  const copyInviteValue = async (kind: 'link' | 'code', value: string): Promise<void> => {
    try {
      // 优先走 IPC clipboard（Electron 桌面端），可靠且不受 CSP/navigator API 限制
      if (window.otto?.writeClipboard) {
        await window.otto.writeClipboard(value);
      } else {
        await navigator.clipboard.writeText(value);
      }
      setCopied(kind);
      setInviteError(null);
    } catch (cause) {
      setInviteError(`复制失败：${errorMessage(cause)}`);
    }
  };

  const pushParkService = async (): Promise<void> => {
    setParkPushBusy(true);
    setParkPushError(null);
    setParkPushMessage(null);
    try {
      const recipient = parkPushRecipients.find((account) => account.id === parkPushRecipientId);
      const service = PARK_SERVICE_OPTIONS.find((item) => item.id === parkPushServiceId);
      await window.otto.enterpriseParkServicePush({
        recipientAccountId: parkPushRecipientId || 'all',
        serviceId: parkPushServiceId,
        note: parkPushNote.trim() || null,
      });
      setParkPushMessage(
        `已发布「${service?.label ?? '园区内容'}」${recipient ? `给 ${recipient.name}` : '给全部成员'}`,
      );
      setParkPushNote('');
      await refreshParkSurveyResults();
    } catch (cause) {
      setParkPushError(errorMessage(cause));
    } finally {
      setParkPushBusy(false);
    }
  };

  const activeCount = accounts.filter((item) => item.status === 'active').length;
  const smsCount = accounts.filter((item) => item.phone).length;
  const repairWorkerCount = accounts.filter((item) => item.tags.includes('维修工作人员')).length;
  const serviceWorkerCount = accounts.filter((item) => item.tags.includes('客服人员')).length;
  const inviteIsActive = inviteContext?.invite?.status === 'active'
    && Date.parse(inviteContext.invite.expiresAt) > now;

  return (
    <main className="otto-account-page">
      <div
        ref={contentRef}
        className="otto-account-page__content"
        aria-hidden={editing ? true : undefined}
      >
      <header className="otto-account-hero">
        <div>
          <button type="button" className="otto-account-page__back" onClick={onBack}>← 返回工作台</button>
          <div className="otto-account-page__eyebrow">CEO ORGANIZATION CONTROL</div>
          <h1>CEO 企业管理中心</h1>
          <p>集中管理成员、企业邀请、组织角色与职责标签。成员可用账号密码或手机号验证码登录；邀请码只用于加入本企业。Token 用量由客户端回传，仅用于内部观察，不等同于模型供应商账单。</p>
        </div>
        <button type="button" className="otto-account-page__create" onClick={openCreate} disabled={loading} aria-label="新增账号"><span>＋</span> 新增成员</button>
      </header>

      {currentAccount.isAdmin ? (
        <section className="otto-account-invite" aria-label="7 天企业引入链接">
          <header>
            <div>
              <span>SECURE ONBOARDING</span>
              <h2>邀请成员加入 {inviteContext?.organization.name || currentAccount.organizationName}</h2>
              <p>链接固定 7 天有效。只有你手动生成时才会换新，生成新链接会立即撤销旧链接。</p>
            </div>
            <button
              type="button"
              onClick={() => void issueInvite()}
              disabled={inviteBusy || inviteLoading}
              aria-label={inviteContext?.invite ? '生成新引入链接' : '生成 7 天引入链接'}
            >
              {inviteBusy ? '正在生成…' : inviteContext?.invite ? '换新链接' : '生成链接'}
            </button>
          </header>
          <label className="otto-account-invite__department">
            <span>新成员默认加入部门</span>
            <input
              aria-label="新成员默认加入部门"
              list="otto-invite-departments"
              value={inviteDepartment}
              disabled={inviteBusy || inviteLoading}
              onChange={(event) => setInviteDepartment(event.target.value)}
              placeholder="不指定则加入未分配部门"
            />
            <datalist id="otto-invite-departments">
              {departmentOptions.map((department) => (
                <option key={department} value={department} />
              ))}
            </datalist>
          </label>
          <div className="otto-account-invite__position-grid">
            <label>
              <span>职位 / 岗位</span>
              <input
                aria-label="岗位邀请码职位"
                value={invitePosition}
                disabled={inviteBusy || inviteLoading}
                onChange={(event) => setInvitePosition(event.target.value)}
                placeholder="例如：品牌运营"
              />
            </label>
            <label>
              <span>角色权限</span>
              <input
                aria-label="岗位邀请码角色权限"
                value={inviteRole}
                disabled={inviteBusy || inviteLoading}
                onChange={(event) => setInviteRole(event.target.value)}
                placeholder="默认：成员"
              />
            </label>
            <label>
              <span>可注册人数</span>
              <input
                aria-label="岗位邀请码可注册人数"
                type="number"
                min={1}
                max={10000}
                value={inviteMaxUses}
                disabled={inviteBusy || inviteLoading}
                onChange={(event) => setInviteMaxUses(event.target.value)}
                placeholder="不填则不限"
              />
            </label>
          </div>
          {inviteLoading ? <div className="otto-account-invite__loading">正在读取当前企业引入链接…</div> : null}
          {!inviteLoading && inviteContext?.invite ? (
            <div className="otto-account-invite__body">
              <div className="otto-account-invite__code">
                <span>企业邀请码</span>
                <strong>{inviteContext.invite.code}</strong>
                <small className={inviteIsActive ? 'is-active' : 'is-expired'}>
                  {inviteIsActive
                    ? formatInviteRemaining(inviteContext.invite.expiresAt, now)
                    : '已失效，请生成新链接'}
                </small>
                <small>
                  {[
                    inviteContext.invite.defaultDepartment || '未分配部门',
                    inviteContext.invite.positionTitle || '未指定职位',
                    inviteContext.invite.defaultRole || '成员',
                  ].join(' / ')}
                  {inviteContext.invite.maxUses
                    ? ` · ${inviteContext.invite.usedCount}/${inviteContext.invite.maxUses}`
                    : ''}
                </small>
              </div>
              <div className="otto-account-invite__link">
                <span>公网引入链接</span>
                <code>{inviteContext.invite.link}</code>
                <small>员工在浏览器打开后可一键唤起 Otto，首次注册时自动填入该企业邀请码。</small>
              </div>
              <div className="otto-account-invite__actions">
                <button type="button" aria-label="复制完整引入链接" onClick={() => void copyInviteValue('link', inviteContext.invite!.link)}>{copied === 'link' ? '链接已复制' : '复制链接'}</button>
                <button type="button" aria-label="复制企业邀请码" onClick={() => void copyInviteValue('code', inviteContext.invite!.code)}>{copied === 'code' ? '邀请码已复制' : '复制邀请码'}</button>
              </div>
            </div>
          ) : null}
          {!inviteLoading && !inviteContext?.invite ? <div className="otto-account-invite__loading">尚未生成引入链接</div> : null}
          {inviteError ? <div className="otto-account-invite__error" role="alert">{inviteError}</div> : null}
        </section>
      ) : null}

      {currentAccount.isAdmin ? (
        <section className="otto-account-invite otto-account-park-push" aria-label="园区公告与调查发布">
          <header>
            <div>
              <span>PARK SERVICE PUSH</span>
              <h2>园区公告与调查发布</h2>
              <p>可发布给全部成员，也可选择一名成员。其他七项服务由用户主动提交申请。</p>
            </div>
            <button
              type="button"
              onClick={() => void pushParkService()}
              disabled={parkPushBusy || parkPushRecipients.length === 0}
            >
              {parkPushBusy ? '正在发布…' : '发布内容'}
            </button>
          </header>
          <div className="otto-account-invite__position-grid">
            <label>
              <span>发布类型</span>
              <select
                aria-label="选择宏创园区服务"
                value={parkPushServiceId}
                disabled={parkPushBusy}
                onChange={(event) => setParkPushServiceId(event.target.value as typeof PARK_SERVICE_OPTIONS[number]['id'])}
              >
                {PARK_SERVICE_OPTIONS.map((service) => (
                  <option key={service.id} value={service.id}>{service.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>接收范围</span>
              <select
                aria-label="选择接收服务的 Otto 用户"
                value={parkPushRecipientId}
                disabled={parkPushBusy}
                onChange={(event) => setParkPushRecipientId(event.target.value)}
              >
                <option value="">全部成员</option>
                {parkPushRecipients.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} / {account.department || '未分配部门'} / @{account.username}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{parkPushServiceId === 'announcement' ? '公告正文' : '调查说明'}</span>
              <input
                aria-label="宏创园区服务推送备注"
                value={parkPushNote}
                disabled={parkPushBusy}
                onChange={(event) => setParkPushNote(event.target.value)}
                placeholder={parkPushServiceId === 'announcement'
                  ? '填写公告正文，例如：今天下午 14:00–16:00 停水'
                  : parkPushServiceId === 'satisfaction'
                    ? '填写本次调查说明'
                    : '例如：请今天下班前处理'}
              />
            </label>
          </div>
          {parkPushMessage ? <div className="otto-account-invite__loading" role="status">{parkPushMessage}</div> : null}
          {parkPushError ? <div className="otto-account-invite__error" role="alert">{parkPushError}</div> : null}
          <div className="otto-account-survey-results" aria-label="满意度问卷回收结果">
            <div className="otto-account-survey-results__head"><strong>问卷回收</strong><span>实名提交，提交后不可修改</span></div>
            {parkSurveyError ? <div className="otto-account-invite__error" role="alert">{parkSurveyError}</div> : null}
            {!parkSurveyError && parkSurveyResults.length === 0 ? <div className="otto-account-invite__loading">尚未发布满意度调查</div> : null}
            {parkSurveyResults.map((survey) => <article key={survey.id} className="otto-account-survey-result">
              <header><div><strong>{survey.title}</strong><span>{survey.body}</span></div><b>{survey.submittedCount} / {survey.recipientCount} 已提交</b></header>
              {survey.responses.length ? <div className="otto-account-survey-result__responses">{survey.responses.map((response) => <div key={response.accountId}><strong>{response.accountName} · {response.responseData.score || '-'} 分</strong><span>{response.responseData.focus || '未填写关注项'}</span><p>{response.responseData.feedback || '未填写建议'}</p><time>{new Date(response.submittedAt).toLocaleString('zh-CN')}</time></div>)}</div> : <p className="otto-account-survey-result__empty">等待成员提交</p>}
            </article>)}
          </div>
        </section>
      ) : null}

      <section className="otto-account-metrics" aria-label="账号概览">
        <article><span>成员总数</span><strong>{accounts.length}</strong><small>组织身份目录</small></article>
        <article><span>可登录</span><strong>{activeCount}</strong><small>{accounts.length - activeCount} 个已停用</small></article>
        <article><span>手机已登记</span><strong>{smsCount}<i>/{accounts.length || 0}</i></strong><small>{smsCount === accounts.length && accounts.length > 0 ? '已全部登记' : '仍有账号未登记手机'}</small></article>
        <article><span>维修工作人员</span><strong>{repairWorkerCount}</strong><small>报修将自动投递</small></article>
        <article><span>园区客服人员</span><strong>{serviceWorkerCount}</strong><small>六类申请自动投递</small></article>
      </section>

      <section className="otto-account-directory">
        <header>
          <div><h2>成员目录</h2><p>账号状态与权限变更实时同步到登录网关。</p></div>
          <label className="otto-account-search"><span aria-hidden>⌕</span><input aria-label="搜索账号" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名、手机、部门或标签" /></label>
        </header>

        {error && !editing ? <div className="otto-account-page__error" role="alert">{error}</div> : null}
        <div className="otto-account-table">
          <table aria-label="账号列表">
            <thead>
              <tr className="otto-account-table__row otto-account-table__header">
                <th scope="col">成员</th>
                <th scope="col">组织信息</th>
                <th scope="col">职责标签</th>
                <th scope="col">使用量</th>
                <th scope="col">访问状态</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td className="otto-account-table__empty" colSpan={6}>正在同步企业身份目录…</td></tr> : null}
              {!loading && filtered.length === 0 ? <tr><td className="otto-account-table__empty" colSpan={6}>没有匹配的成员</td></tr> : null}
              {filtered.map((account) => (
                <tr className="otto-account-table__row" key={account.id}>
                  <td><div className="otto-account-table__identity"><span className="otto-account-table__avatar">{account.name.slice(0, 1).toUpperCase()}</span><div><strong>{account.name}</strong><small>@{account.username} · {maskedPhone(account.phone)}</small></div></div></td>
                  <td><strong>{account.role || '未设置岗位'}</strong><small>{account.department || '未分配部门'}</small></td>
                  <td><div className="otto-account-table__tags">{account.tags.length ? account.tags.map((tag) => <span key={tag}>{tag}</span>) : <small>暂无标签</small>}</div></td>
                  <td>
                    <div className="otto-account-table__usage">
                      <strong>{account.usage ? `${account.usage.totalTokens.toLocaleString('en-US')} tokens` : '暂无用量'}</strong>
                      <small>{account.usage ? `${account.usage.requestCount.toLocaleString('en-US')} 次请求` : '尚无调用数据'}</small>
                      {account.usage ? <small title={account.usage.lastUsedAt ?? undefined}>{formatLastUsedAt(account.usage.lastUsedAt)}</small> : null}
                    </div>
                  </td>
                  <td><div className="otto-account-table__state">{account.isAdmin ? <span className="is-admin">管理员</span> : <span>成员</span>}<span className={account.status === 'active' ? 'is-active' : 'is-disabled'}>{account.status === 'active' ? '可登录' : '已停用'}</span>{account.tags.includes('维修工作人员') ? <span className="is-admin">维修人员</span> : null}{account.phone ? <span className="is-sms">短信</span> : null}{account.feishuOpenId ? <span className="is-sms">飞书</span> : null}</div></td>
                  <td><button type="button" onClick={() => openEdit(account)} aria-label={`编辑 ${account.name}`}>编辑</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      </div>

      {editing ? (
        <div className="otto-account-editor__overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
          <section
            ref={dialogRef}
            className="otto-account-editor"
            role="dialog"
            aria-modal="true"
            aria-label={editing === 'new' ? '新增账号' : '编辑账号'}
            tabIndex={-1}
            onKeyDown={handleEditorKeyDown}
          >
            <header><div><span>{editing === 'new' ? 'NEW IDENTITY' : 'IDENTITY DETAIL'}</span><h2>{editing === 'new' ? '添加企业成员' : '编辑成员身份'}</h2><p>账号、手机和角色决定成员如何进入 Otto 及能访问的空间。</p></div><button type="button" onClick={closeEditor} disabled={saving} aria-label="关闭">×</button></header>
            <section className="otto-account-templates" aria-label="账户模板">
              <div><strong>账户模板</strong><small>先选一个最接近的岗位，再按需调整</small></div>
              <div>
                {ACCOUNT_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => setDraft((value) => applyAccountTemplate(value, template.id))}
                  >
                    {template.label}
                  </button>
                ))}
              </div>
            </section>
            <div className="otto-account-editor__grid">
              <label><span>登录账号</span><input ref={initialFocusRef} aria-label="登录账号" value={draft.username} onChange={(e) => setDraft((v) => ({ ...v, username: e.target.value }))} required /></label>
              <label><span>显示名称</span><input aria-label="显示名称" value={draft.name} onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))} required /></label>
              <label><span>手机号码</span><input aria-label="手机号码" inputMode="tel" value={draft.phone} onChange={(e) => setDraft((v) => ({ ...v, phone: e.target.value }))} placeholder="用于短信验证码登录" /></label>
              <label><span>飞书 open_id</span><input aria-label="飞书 open_id" value={draft.feishuOpenId} onChange={(e) => setDraft((v) => ({ ...v, feishuOpenId: e.target.value }))} placeholder="例如：ou_xxx，用于报修通知" /></label>
              <label><span>{editing === 'new' ? '初始密码' : '重设密码（留空不变）'}</span><input aria-label={editing === 'new' ? '初始密码' : '重设密码（留空不变）'} type="password" value={draft.password} onChange={(e) => setDraft((v) => ({ ...v, password: e.target.value }))} required={editing === 'new'} /></label>
              <label><span>角色</span><input aria-label="角色" value={draft.role} onChange={(e) => setDraft((v) => ({ ...v, role: e.target.value }))} placeholder="例如：桌面支持" /></label>
              <label><span>部门</span><input aria-label="部门" list="otto-account-departments" value={draft.department} onChange={(e) => setDraft((v) => ({ ...v, department: e.target.value }))} placeholder="选择或输入部门" /><datalist id="otto-account-departments">{ACCOUNT_DEPARTMENT_PRESETS.map((department) => <option key={department} value={department} />)}</datalist></label>
              <div className="otto-account-editor__field is-wide"><span>职责标签</span><div className="otto-account-tag-presets" aria-label="预设标签">{ACCOUNT_TAG_PRESETS.map((tag) => { const selected = tagsFromText(draft.tags).includes(tag); return <button key={tag} type="button" className={selected ? 'is-selected' : ''} aria-pressed={selected} onClick={() => setDraft((v) => ({ ...v, tags: toggleAccountTag(v.tags, tag) }))}>{tag}</button>; })}</div><input aria-label="账号标签" value={draft.tags} onChange={(e) => setDraft((v) => ({ ...v, tags: e.target.value }))} placeholder="也可输入自定义标签，用逗号分隔" /><small>标签参与专家权限、工单和任务路由。</small></div>
              {editing !== 'new' ? <label><span>账号状态</span><select aria-label="账号状态" value={draft.status} onChange={(e) => setDraft((v) => ({ ...v, status: e.target.value as AccountDraft['status'] }))}><option value="active">可登录</option><option value="disabled">停用</option></select></label> : null}
              <label className="otto-account-editor__check"><input type="checkbox" checked={tagsFromText(draft.tags).includes('维修工作人员')} onChange={() => setDraft((v) => ({ ...v, tags: toggleAccountTag(v.tags, '维修工作人员') }))} /><span>设为维修工作人员（新报修自动投递）</span></label>
              <label className="otto-account-editor__check"><input type="checkbox" checked={tagsFromText(draft.tags).includes('客服人员')} onChange={() => setDraft((v) => ({ ...v, tags: toggleAccountTag(v.tags, '客服人员') }))} /><span>设为园区客服人员（六类服务申请自动投递）</span></label>
              <label className="otto-account-editor__check"><input type="checkbox" checked={draft.isAdmin} onChange={(e) => setDraft((v) => ({ ...v, isAdmin: e.target.checked }))} /><span>授予身份管理权限</span></label>
            </div>
            {error ? <div className="otto-account-page__error" role="alert">{error}</div> : null}
            <footer>
              {editing !== 'new' && editing.id !== currentAccount.id ? (
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => void deleteEditingAccount()}
                  disabled={saving}
                >
                  {deleteArmed ? '确认删除账号' : '删除账号'}
                </button>
              ) : null}
              <button type="button" onClick={closeEditor} disabled={saving}>取消</button>
              <button type="button" className="is-primary" onClick={() => void save()} disabled={saving || !draft.username.trim() || !draft.name.trim() || (editing === 'new' && draft.password.length < 8)}>{saving ? '正在保存…' : '保存身份'}</button>
            </footer>
            {editing !== 'new' && editing.id === currentAccount.id ? <p className="otto-account-editor__self">这是你当前登录的账号；停用或降权将在会话重新校验后生效。</p> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
