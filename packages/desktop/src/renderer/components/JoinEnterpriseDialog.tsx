/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { friendlyAuthError } from '../state/useEnterpriseAuth.js';
import { sanitizeOrganizationInviteCode } from './EnterpriseLoginPage.js';
import { IconCheck, IconFile, IconWarning } from './icons.js';

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const ACCEPTED_EVIDENCE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const CREDIT_CODE_PATTERN = /^[0-9A-HJ-NPQRTUWXY]{18}$/;

type DialogTab = 'invite' | 'verification';
type ApplicantAuthority = 'legal_representative' | 'authorized_agent';
type EvidencePurpose = 'business_license' | 'authorization_letter';
type EvidencePhase = 'idle' | 'hashing' | 'ready' | 'uploading' | 'uploaded' | 'error';

export interface EnterpriseVerificationEvidence {
  reference: string;
  sha256: string;
}

export interface EnterpriseVerificationApplication {
  id: string;
  status: string;
  legalName?: string;
  reviewNote?: string | null;
}

export interface EnterpriseVerificationSubmitInput {
  legalName: string;
  unifiedSocialCreditCode: string;
  legalRepresentativeName: string;
  applicantAuthority: ApplicantAuthority;
  businessLicenseEvidence: EnterpriseVerificationEvidence;
  authorizationEvidence: EnterpriseVerificationEvidence | null;
}

export interface EnterpriseVerificationUploadInput {
  purpose: EvidencePurpose;
  fileName: string;
  contentType: string;
  contentBase64: string;
}

type ApplicationResult = EnterpriseVerificationApplication
  | { application: EnterpriseVerificationApplication | null }
  | null;
type UploadResult = EnterpriseVerificationEvidence
  | { evidence: EnterpriseVerificationEvidence };

export interface EnterpriseVerificationHandlers {
  onSubmitEnterpriseVerification?: (
    input: EnterpriseVerificationSubmitInput,
  ) => Promise<ApplicationResult>;
  onGetEnterpriseVerification?: () => Promise<ApplicationResult>;
  onCancelEnterpriseVerification?: () => Promise<ApplicationResult>;
  onUploadEnterpriseVerificationEvidence?: (
    input: EnterpriseVerificationUploadInput,
  ) => Promise<UploadResult>;
  onReloadEnterpriseIdentity?: () => void | Promise<void>;
}

interface EvidenceSelection {
  file: File | null;
  sha256: string | null;
  phase: EvidencePhase;
  evidence: EnterpriseVerificationEvidence | null;
  error: string | null;
}

const EMPTY_EVIDENCE: EvidenceSelection = {
  file: null,
  sha256: null,
  phase: 'idle',
  evidence: null,
  error: null,
};

function normalizeApplication(result: ApplicationResult | void): EnterpriseVerificationApplication | null {
  if (!result) return null;
  return 'application' in result ? result.application : result;
}

function normalizeEvidence(result: UploadResult): EnterpriseVerificationEvidence {
  return 'evidence' in result ? result.evidence : result;
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
      return { tone: 'success', title: '已通过', detail: '认证已经通过，请重新读取身份进入企业空间。' };
    case 'rejected':
      return {
        tone: 'danger',
        title: '被驳回',
        detail: application.reviewNote?.trim() || '申请未通过，请核对企业资料后重新提交。',
      };
    case 'cancelled':
      return { tone: 'muted', title: '已取消', detail: '这份申请已经取消，可以重新准备材料。' };
    default:
      return { tone: 'pending', title: '审核中', detail: '申请已安全提交，审核结果会同步显示在这里。' };
  }
}

function evidenceTypeValid(file: File): boolean {
  return ACCEPTED_EVIDENCE_TYPES.has(file.type.toLowerCase())
    || /\.(pdf|png|jpe?g)$/i.test(file.name);
}

async function hashFile(file: File): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(
    new Uint8Array(digest),
    (value) => value.toString(16).padStart(2, '0'),
  ).join('');
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  return `${(size / 1024 / 1024).toFixed(size >= 1024 * 1024 ? 1 : 2)} MB`;
}

export function JoinEnterpriseDialog({
  open,
  onCancel,
  onConfirm,
  onSubmitEnterpriseVerification,
  onGetEnterpriseVerification,
  onCancelEnterpriseVerification,
  onUploadEnterpriseVerificationEvidence,
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
          if (current) setActiveTab('verification');
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
              使用已有企业的邀请码，或提交主体材料认证并创建自己的企业。
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
            aria-selected={activeTab === 'verification'}
            className={activeTab === 'verification' ? 'is-active' : ''}
            onClick={() => {
              setActiveTab('verification');
              setError(null);
            }}
          >
            认证并创建企业
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
            <EnterpriseVerificationPane
              application={application}
              loading={loadingApplication}
              initialError={error}
              handlers={{
                onSubmitEnterpriseVerification,
                onGetEnterpriseVerification,
                onCancelEnterpriseVerification,
                onUploadEnterpriseVerificationEvidence,
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

function EnterpriseVerificationPane({
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
  const [creditCode, setCreditCode] = useState('');
  const [legalRepresentativeName, setLegalRepresentativeName] = useState('');
  const [applicantAuthority, setApplicantAuthority] = useState<ApplicantAuthority>('legal_representative');
  const [businessLicense, setBusinessLicense] = useState<EvidenceSelection>(EMPTY_EVIDENCE);
  const [authorizationLetter, setAuthorizationLetter] = useState<EvidenceSelection>(EMPTY_EVIDENCE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const evidenceEpochRef = useRef({ business_license: 0, authorization_letter: 0 });
  const normalizedCreditCode = creditCode.trim().toUpperCase();
  const needsAuthorization = applicantAuthority === 'authorized_agent';
  const uploadAvailable = Boolean(handlers.onUploadEnterpriseVerificationEvidence);
  const verificationAvailable = Boolean(
    handlers.onSubmitEnterpriseVerification
      && handlers.onGetEnterpriseVerification
      && handlers.onCancelEnterpriseVerification
      && handlers.onUploadEnterpriseVerificationEvidence,
  );
  const formValid = Boolean(
    legalName.trim()
      && CREDIT_CODE_PATTERN.test(normalizedCreditCode)
      && legalRepresentativeName.trim()
      && businessLicense.file
      && businessLicense.sha256
      && businessLicense.phase !== 'hashing'
      && (!needsAuthorization || (
        authorizationLetter.file
        && authorizationLetter.sha256
        && authorizationLetter.phase !== 'hashing'
      )),
  );
  const showForm = !application || normalizeStatus(application.status) === 'cancelled';

  const updateEvidence = (
    purpose: EvidencePurpose,
    value: React.SetStateAction<EvidenceSelection>,
  ): void => {
    if (purpose === 'business_license') setBusinessLicense(value);
    else setAuthorizationLetter(value);
  };

  const selectEvidence = async (purpose: EvidencePurpose, file: File | null): Promise<void> => {
    const epoch = evidenceEpochRef.current[purpose] + 1;
    evidenceEpochRef.current[purpose] = epoch;
    setError(null);
    if (!file) {
      updateEvidence(purpose, EMPTY_EVIDENCE);
      return;
    }
    if (!evidenceTypeValid(file) || file.size > MAX_EVIDENCE_BYTES) {
      updateEvidence(purpose, {
        file,
        sha256: null,
        phase: 'error',
        evidence: null,
        error: !evidenceTypeValid(file)
          ? '仅支持 PDF、PNG、JPG 或 JPEG 文件'
          : '文件不能超过 8 MB',
      });
      return;
    }
    updateEvidence(purpose, {
      file,
      sha256: null,
      phase: 'hashing',
      evidence: null,
      error: null,
    });
    try {
      const sha256 = await hashFile(file);
      if (evidenceEpochRef.current[purpose] !== epoch) return;
      updateEvidence(purpose, { file, sha256, phase: 'ready', evidence: null, error: null });
    } catch (cause) {
      if (evidenceEpochRef.current[purpose] !== epoch) return;
      updateEvidence(purpose, {
        file,
        sha256: null,
        phase: 'error',
        evidence: null,
        error: `无法校验文件：${friendlyAuthError(cause)}`,
      });
    }
  };

  const uploadEvidence = async (
    purpose: EvidencePurpose,
    selected: EvidenceSelection,
  ): Promise<EnterpriseVerificationEvidence> => {
    if (selected.evidence) return selected.evidence;
    const upload = handlers.onUploadEnterpriseVerificationEvidence;
    if (!selected.file || !selected.sha256 || !upload) {
      throw new Error('安全材料上传服务暂不可用');
    }
    updateEvidence(purpose, (current) => ({ ...current, phase: 'uploading', error: null }));
    try {
      const result = await upload({
        purpose,
        fileName: selected.file.name,
        contentType: selected.file.type || 'application/octet-stream',
        contentBase64: await fileToBase64(selected.file),
      });
      const evidence = normalizeEvidence(result);
      if (!evidence.reference || evidence.sha256.toLowerCase() !== selected.sha256.toLowerCase()) {
        throw new Error('服务器返回的文件摘要与本机校验结果不一致');
      }
      updateEvidence(purpose, (current) => ({
        ...current,
        phase: 'uploaded',
        evidence,
        error: null,
      }));
      return evidence;
    } catch (cause) {
      updateEvidence(purpose, (current) => ({
        ...current,
        phase: 'error',
        evidence: null,
        error: friendlyAuthError(cause),
      }));
      throw cause;
    }
  };

  const submit = async (): Promise<void> => {
    const submitApplication = handlers.onSubmitEnterpriseVerification;
    if (!formValid || !verificationAvailable || !submitApplication || busy) return;
    setBusy(true);
    setError(null);
    try {
      const [businessLicenseEvidence, authorizationEvidence] = await Promise.all([
        uploadEvidence('business_license', businessLicense),
        needsAuthorization
          ? uploadEvidence('authorization_letter', authorizationLetter)
          : Promise.resolve(null),
      ]);
      let submitted = normalizeApplication(await submitApplication({
        legalName: legalName.trim(),
        unifiedSocialCreditCode: normalizedCreditCode,
        legalRepresentativeName: legalRepresentativeName.trim(),
        applicantAuthority,
        businessLicenseEvidence,
        authorizationEvidence,
      }));
      if (!submitted && handlers.onGetEnterpriseVerification) {
        submitted = normalizeApplication(await handlers.onGetEnterpriseVerification());
      }
      if (!submitted) throw new Error('服务器未返回可核验的申请状态，请稍后重试');
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
    return <div className="otto-join-enterprise__loading" role="status">正在读取认证申请…</div>;
  }

  return (
    <div className="otto-join-enterprise__pane" role="tabpanel">
      {application ? (
        <VerificationStatusCard
          application={application}
          busy={busy}
          canCancel={Boolean(handlers.onCancelEnterpriseVerification)}
          onCancel={() => void cancelApplication()}
          onReloadIdentity={handlers.onReloadEnterpriseIdentity}
        />
      ) : null}

      {showForm ? (
        <form
          className="otto-verification-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="otto-join-enterprise__intro">
            <strong>{application ? '重新发起企业认证' : '认证企业主体'}</strong>
            <span>资料仅用于主体审核。文件会先校验摘要，再通过安全材料通道上传。</span>
          </div>
          <div className="otto-verification-form__grid">
            <TextField label="企业全称" value={legalName} onChange={setLegalName} placeholder="与营业执照保持一致" disabled={busy} />
            <TextField
              label="统一社会信用代码"
              value={creditCode}
              onChange={(value) => setCreditCode(value.toUpperCase().replace(/[^0-9A-HJ-NPQRTUWXY]/g, ''))}
              placeholder="18 位统一社会信用代码"
              maxLength={18}
              disabled={busy}
              error={Boolean(creditCode && !CREDIT_CODE_PATTERN.test(normalizedCreditCode))}
            />
            <TextField label="法定代表人姓名" value={legalRepresentativeName} onChange={setLegalRepresentativeName} placeholder="与营业执照保持一致" disabled={busy} />
            <fieldset className="otto-verification-form__authority">
              <legend>申请人身份</legend>
              <div>
                <label>
                  <input type="radio" name="applicant-authority" checked={applicantAuthority === 'legal_representative'} disabled={busy} onChange={() => setApplicantAuthority('legal_representative')} />
                  法定代表人
                </label>
                <label>
                  <input type="radio" name="applicant-authority" checked={applicantAuthority === 'authorized_agent'} disabled={busy} onChange={() => setApplicantAuthority('authorized_agent')} />
                  受托经办人
                </label>
              </div>
            </fieldset>
          </div>

          <div className="otto-verification-form__files">
            <EvidencePicker label="营业执照" selection={businessLicense} disabled={busy} onSelect={(file) => void selectEvidence('business_license', file)} />
            {needsAuthorization ? (
              <EvidencePicker label="授权书" selection={authorizationLetter} disabled={busy} onSelect={(file) => void selectEvidence('authorization_letter', file)} />
            ) : null}
          </div>
          <p className="otto-verification-form__security-note">
            支持 PDF、PNG、JPG、JPEG，单个文件不超过 8 MB。提交前使用 Web Crypto 计算 SHA-256，上传摘要不一致时自动中止。
          </p>
          {!uploadAvailable ? (
            <div className="otto-join-enterprise__error" role="alert">
              安全材料上传服务暂不可用，当前不会提交认证申请。
            </div>
          ) : null}
          {error ? <div className="otto-join-enterprise__error" role="alert">{error}</div> : null}
          <div className="otto-confirm__actions">
            <button type="button" className="otto-confirm__cancel" disabled={busy} onClick={onClose}>取消</button>
            <button type="submit" className="otto-confirm__confirm" disabled={!formValid || !verificationAvailable || busy}>
              {busy ? '正在安全提交…' : '提交企业认证'}
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
  error = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  maxLength?: number;
  error?: boolean;
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
      {error ? <small className="otto-verification-form__hint is-error">请输入完整的 18 位代码</small> : null}
    </label>
  );
}

function EvidencePicker({
  label,
  selection,
  disabled,
  onSelect,
}: {
  label: string;
  selection: EvidenceSelection;
  disabled: boolean;
  onSelect: (file: File | null) => void;
}): React.JSX.Element {
  const inputId = `${useId()}-file`;
  const stateLabel = selection.phase === 'hashing'
    ? '正在校验'
    : selection.phase === 'uploading'
      ? '正在安全上传'
      : selection.phase === 'uploaded'
        ? '上传完成'
        : selection.phase === 'ready'
          ? '已校验，等待上传'
          : selection.phase === 'error'
            ? '需要处理'
            : '未选择';
  const StateIcon = selection.phase === 'uploaded'
    ? IconCheck
    : selection.phase === 'error'
      ? IconWarning
      : IconFile;

  return (
    <div className={`otto-evidence-picker is-${selection.phase}`}>
      <div className="otto-evidence-picker__icon" aria-hidden><StateIcon size={17} /></div>
      <div className="otto-evidence-picker__copy">
        <strong>{label}<span aria-hidden> *</span></strong>
        {selection.file ? (
          <span title={selection.file.name}>
            {selection.file.name} · {formatFileSize(selection.file.size)}
          </span>
        ) : (
          <span>PDF 或图片，最大 8 MB</span>
        )}
        {selection.error ? <small role="alert">{selection.error}</small> : null}
      </div>
      <span className="otto-evidence-picker__state" role="status">{stateLabel}</span>
      <label className="otto-evidence-picker__button" htmlFor={inputId}>
        {selection.file ? '更换文件' : '选择文件'}
      </label>
      <input
        id={inputId}
        className="otto-evidence-picker__input"
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
        disabled={disabled}
        onClick={(event) => {
          event.currentTarget.value = '';
        }}
        onChange={(event) => onSelect(event.currentTarget.files?.[0] ?? null)}
      />
    </div>
  );
}

function VerificationStatusCard({
  application,
  busy,
  canCancel,
  onCancel,
  onReloadIdentity,
}: {
  application: EnterpriseVerificationApplication;
  busy: boolean;
  canCancel: boolean;
  onCancel: () => void;
  onReloadIdentity?: () => void | Promise<void>;
}): React.JSX.Element {
  const status = normalizeStatus(application.status);
  const copy = statusCopy(application);
  return (
    <section className={`otto-verification-status is-${copy.tone}`} aria-label={`企业认证状态：${copy.title}`}>
      <div className="otto-verification-status__heading">
        <span aria-hidden><IconCheck size={16} /></span>
        <div><small>企业认证申请</small><strong>{copy.title}</strong></div>
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
            onClick={() => void onReloadIdentity?.()}
          >
            重新读取身份
          </button>
        ) : null}
      </div>
    </section>
  );
}
