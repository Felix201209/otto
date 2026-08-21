/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { friendlyAuthError } from '../state/useEnterpriseAuth.js';
import { sanitizeOrganizationInviteCode } from './EnterpriseLoginPage.js';
import { IconCheck } from './icons.js';

type DialogTab = 'invite' | 'creation';

export interface EnterpriseVerificationApplication {
  id: string;
  status: string;
  legalName?: string;
  reviewNote?: string | null;
}

export interface EnterpriseVerificationSubmitInput {
  legalName: string;
}

type ApplicationResult = EnterpriseVerificationApplication
  | { application: EnterpriseVerificationApplication | null }
  | null;

export interface EnterpriseVerificationHandlers {
  onSubmitEnterpriseVerification?: (
    input: EnterpriseVerificationSubmitInput,
  ) => Promise<ApplicationResult>;
  onGetEnterpriseVerification?: () => Promise<ApplicationResult>;
  onCancelEnterpriseVerification?: () => Promise<ApplicationResult>;
  onReloadEnterpriseIdentity?: () => void | Promise<void>;
}

function normalizeApplication(result: ApplicationResult | void): EnterpriseVerificationApplication | null {
  if (!result) return null;
  return 'application' in result ? result.application : result;
}

function normalizeStatus(status: string): 'pending' | 'approved' | 'rejected' | 'cancelled' {
  const normalized = status.trim().toLowerCase();
  if (['approved', 'verified', 'provisioned'].includes(normalized)) return 'approved';
  if (['rejected', 'declined'].includes(normalized)) return 'rejected';
  if (['cancelled', 'canceled', 'withdrawn'].includes(normalized)) return 'cancelled';
  return 'pending';
}

function statusCopy(application: EnterpriseVerificationApplication): {
  tone: 'pending' | 'success' | 'danger' | 'muted';
  title: string;
  detail: string;
} {
  switch (normalizeStatus(application.status)) {
    case 'approved':
      return {
        tone: 'success',
        title: '创建成功',
        detail: '企业已经创建',
      };
    case 'rejected':
      return {
        tone: 'danger',
        title: '创建失败',
        detail: application.reviewNote?.trim() || '旧申请未完成，请重新创建企业。',
      };
    case 'cancelled':
      return {
        tone: 'muted',
        title: '已取消',
        detail: application.reviewNote?.trim() || '这份申请已经取消，可以重新创建企业。',
      };
    default:
      return {
        tone: 'pending',
        title: '正在处理',
        detail: application.reviewNote?.trim() || '这是旧版本提交的申请，处理完成后会自动更新。',
      };
  }
}

export function JoinEnterpriseDialog({
  open,
  onCancel,
  onConfirm,
  onSubmitEnterpriseVerification,
  onGetEnterpriseVerification,
  onCancelEnterpriseVerification,
  onReloadEnterpriseIdentity,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: (input: { inviteCode: string }) => Promise<void>;
} & EnterpriseVerificationHandlers): React.JSX.Element | null {
  const [activeTab, setActiveTab] = useState<DialogTab>('invite');
  const [inviteCode, setInviteCode] = useState('');
  const [application, setApplication] = useState<EnterpriseVerificationApplication | null>(null);
  const [loadingApplication, setLoadingApplication] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const titleId = `${useId()}-title`;
  const descriptionId = `${useId()}-description`;
  const validInvite = inviteCode.replace(/[^A-HJ-NP-Za-km-z2-9]/g, '').length === 12;

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    setActiveTab('invite');
    setInviteCode('');
    setApplication(null);
    setBusy(false);
    setError(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    let cancelled = false;
    if (onGetEnterpriseVerification) {
      setLoadingApplication(true);
      void onGetEnterpriseVerification()
        .then((result) => {
          if (cancelled) return;
          const current = normalizeApplication(result);
          setApplication(current);
          if (current) setActiveTab('creation');
        })
        .catch((cause) => {
          if (!cancelled) setError(friendlyAuthError(cause));
        })
        .finally(() => {
          if (!cancelled) setLoadingApplication(false);
        });
    } else {
      setLoadingApplication(false);
    }
    return () => {
      cancelled = true;
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement && document.contains(trigger)) trigger.focus();
    };
  }, [open, onGetEnterpriseVerification]);

  if (!open) return null;

  const submitInvite = async (): Promise<void> => {
    if (!validInvite || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ inviteCode });
    } catch (cause) {
      setError(friendlyAuthError(cause));
      setBusy(false);
    }
  };

  return (
    <div
      className="otto-confirm-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="otto-confirm otto-join-enterprise"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="otto-join-enterprise__header">
          <div>
            <h2 className="otto-confirm__title" id={titleId}>加入或创建企业</h2>
            <p className="otto-confirm__message" id={descriptionId}>
              使用已有企业的邀请码，或直接创建自己的企业。
            </p>
          </div>
          <button
            type="button"
            className="otto-join-enterprise__close"
            aria-label="关闭"
            disabled={busy}
            onClick={onCancel}
          >
            ×
          </button>
        </header>

        <div className="otto-join-enterprise__tabs" role="tablist" aria-label="加入企业方式">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'invite'}
            className={activeTab === 'invite' ? 'is-active' : ''}
            onClick={() => {
              setActiveTab('invite');
              setError(null);
            }}
          >
            使用企业邀请码
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'creation'}
            className={activeTab === 'creation' ? 'is-active' : ''}
            onClick={() => {
              setActiveTab('creation');
              setError(null);
            }}
          >
            创建企业
          </button>
        </div>

        <div className="otto-join-enterprise__body">
          {activeTab === 'invite' ? (
            <form
              className="otto-join-enterprise__pane"
              onSubmit={(event) => {
                event.preventDefault();
                void submitInvite();
              }}
            >
              <div className="otto-join-enterprise__intro">
                <strong>加入已有企业</strong>
                <span>成功后将切换到对应企业；原个人空间对话不会自动带入企业。</span>
              </div>
              <label className="otto-join-enterprise__field">
                <span>企业邀请码</span>
                <input
                  ref={inputRef}
                  aria-label="企业邀请码"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={14}
                  value={inviteCode}
                  disabled={busy}
                  onChange={(event) => {
                    setInviteCode(sanitizeOrganizationInviteCode(event.target.value));
                    setError(null);
                  }}
                  placeholder="Aa3B-k9Pq-Z7xY"
                />
              </label>
              {error ? <div className="otto-join-enterprise__error" role="alert">{error}</div> : null}
              <div className="otto-confirm__actions">
                <button type="button" className="otto-confirm__cancel" disabled={busy} onClick={onCancel}>
                  取消
                </button>
                <button type="submit" className="otto-confirm__confirm" disabled={!validInvite || busy}>
                  {busy ? '正在加入…' : '加入企业'}
                </button>
              </div>
            </form>
          ) : (
            <EnterpriseCreationPane
              application={application}
              loading={loadingApplication}
              initialError={error}
              handlers={{
                onSubmitEnterpriseVerification,
                onGetEnterpriseVerification,
                onCancelEnterpriseVerification,
                onReloadEnterpriseIdentity,
              }}
              onApplicationChange={setApplication}
              onClose={onCancel}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function EnterpriseCreationPane({
  application,
  loading,
  initialError,
  handlers,
  onApplicationChange,
  onClose,
}: {
  application: EnterpriseVerificationApplication | null;
  loading: boolean;
  initialError: string | null;
  handlers: EnterpriseVerificationHandlers;
  onApplicationChange: (application: EnterpriseVerificationApplication) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [legalName, setLegalName] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshingIdentity, setRefreshingIdentity] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const formValid = Boolean(legalName.trim());
  const showForm = !application || normalizeStatus(application.status) === 'cancelled';

  const reloadIdentityAndClose = async (): Promise<void> => {
    const reloadIdentity = handlers.onReloadEnterpriseIdentity;
    if (!reloadIdentity) {
      setError('企业已创建，但身份刷新服务暂不可用。请稍后重新读取身份。');
      return;
    }

    setRefreshingIdentity(true);
    setError(null);
    try {
      await reloadIdentity();
      onClose();
    } catch (cause) {
      setError(`企业已创建，但身份刷新失败：${friendlyAuthError(cause)}`);
    } finally {
      setRefreshingIdentity(false);
    }
  };

  const submit = async (): Promise<void> => {
    const submitApplication = handlers.onSubmitEnterpriseVerification;
    if (!formValid || !submitApplication || busy) return;
    setBusy(true);
    setError(null);
    try {
      let submitted = normalizeApplication(await submitApplication({ legalName: legalName.trim() }));
      if (!submitted && handlers.onGetEnterpriseVerification) {
        submitted = normalizeApplication(await handlers.onGetEnterpriseVerification());
      }
      if (!submitted) throw new Error('服务器未返回企业创建结果，请稍后重试');

      const status = normalizeStatus(submitted.status);
      if (status === 'approved') {
        onApplicationChange(submitted);
        await reloadIdentityAndClose();
        return;
      }

      // Older servers can still return the previous application states.
      onApplicationChange(submitted);
    } catch (cause) {
      setError(friendlyAuthError(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancelApplication = async (): Promise<void> => {
    const cancel = handlers.onCancelEnterpriseVerification;
    if (!cancel || busy) return;
    setBusy(true);
    setError(null);
    try {
      let cancelled = normalizeApplication(await cancel());
      if (!cancelled && handlers.onGetEnterpriseVerification) {
        cancelled = normalizeApplication(await handlers.onGetEnterpriseVerification());
      }
      if (!cancelled) throw new Error('服务器未确认申请已取消');
      onApplicationChange(cancelled);
    } catch (cause) {
      setError(friendlyAuthError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="otto-join-enterprise__loading" role="status">正在读取企业创建状态…</div>;
  }

  return (
    <div className="otto-join-enterprise__pane" role="tabpanel">
      {application ? (
        <EnterpriseCreationStatusCard
          application={application}
          busy={busy || refreshingIdentity}
          canCancel={Boolean(handlers.onCancelEnterpriseVerification)}
          onCancel={() => void cancelApplication()}
          onReloadIdentity={() => void reloadIdentityAndClose()}
          refreshingIdentity={refreshingIdentity}
        />
      ) : null}

      {showForm ? (
        <form
          className="otto-enterprise-creation-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="otto-join-enterprise__intro">
            <strong>{application ? '重新创建企业' : '创建企业'}</strong>
            <span>当前登录账号和已验证手机号会自动带入，无需重复填写。</span>
          </div>
          <div className="otto-enterprise-creation-form__grid">
            <TextField
              label="企业名称"
              value={legalName}
              onChange={setLegalName}
              placeholder="请输入企业名称"
              disabled={busy}
            />
          </div>
          {error ? <div className="otto-join-enterprise__error" role="alert">{error}</div> : null}
          <div className="otto-confirm__actions">
            <button type="button" className="otto-confirm__cancel" disabled={busy} onClick={onClose}>取消</button>
            <button type="submit" className="otto-confirm__confirm" disabled={!formValid || busy}>
              {busy ? '正在创建…' : '创建企业'}
            </button>
          </div>
        </form>
      ) : null}
      {error && !showForm ? <div className="otto-join-enterprise__error" role="alert">{error}</div> : null}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  maxLength = 120,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  maxLength?: number;
}): React.JSX.Element {
  return (
    <label className="otto-join-enterprise__field">
      <span>{label}</span>
      <input
        aria-label={label}
        maxLength={maxLength}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function EnterpriseCreationStatusCard({
  application,
  busy,
  canCancel,
  onCancel,
  onReloadIdentity,
  refreshingIdentity,
}: {
  application: EnterpriseVerificationApplication;
  busy: boolean;
  canCancel: boolean;
  onCancel: () => void;
  onReloadIdentity: () => void;
  refreshingIdentity: boolean;
}): React.JSX.Element {
  const status = normalizeStatus(application.status);
  const copy = statusCopy(application);
  return (
    <section className={`otto-enterprise-creation-status is-${copy.tone}`} aria-label={`企业创建状态：${copy.title}`}>
      <div className="otto-verification-status__heading">
        <span aria-hidden><IconCheck size={16} /></span>
        <div><small>企业创建申请</small><strong>{copy.title}</strong></div>
      </div>
      {application.legalName ? <h3>{application.legalName}</h3> : null}
      <p>{copy.detail}</p>
      <div className="otto-verification-status__actions">
        {status === 'pending' && canCancel ? (
          <button type="button" className="otto-confirm__cancel" disabled={busy} onClick={onCancel}>
            {busy ? '正在取消…' : '取消申请'}
          </button>
        ) : null}
        {status === 'approved' ? (
          <button
            type="button"
            className="otto-confirm__confirm"
            disabled={busy}
            onClick={onReloadIdentity}
          >
            {refreshingIdentity ? '正在读取身份…' : '重新读取身份'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
