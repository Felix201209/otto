/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import type { EnterpriseLegalDocumentReference } from '../../preload/index.js';
import { OttoPetStage } from './OttoPetStage.js';

type LoginMode = 'login' | 'register' | 'join';
type LoginMethod = 'password' | 'sms';

export interface TypewriterFrame {
  phraseIndex: number;
  charIndex: number;
  deleting: boolean;
}

const OTTO_CAPABILITIES = [
  '代码直接写好。',
  '会议变成行动。',
  '浏览器替你操作。',
  '项目安全改完。',
  '汇报一键做成。',
];

export function advanceTypewriterFrame(
  frame: TypewriterFrame,
  phrases: readonly string[],
): TypewriterFrame {
  if (phrases.length === 0) return { phraseIndex: 0, charIndex: 0, deleting: false };
  const phraseIndex = Math.min(Math.max(frame.phraseIndex, 0), phrases.length - 1);
  const phrase = phrases[phraseIndex];

  if (!frame.deleting && frame.charIndex < phrase.length) {
    return { phraseIndex, charIndex: frame.charIndex + 1, deleting: false };
  }
  if (!frame.deleting) {
    return { phraseIndex, charIndex: phrase.length, deleting: true };
  }
  if (frame.charIndex > 0) {
    return { phraseIndex, charIndex: frame.charIndex - 1, deleting: true };
  }
  return { phraseIndex: (phraseIndex + 1) % phrases.length, charIndex: 0, deleting: false };
}

export function sanitizeSmsCode(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
}

export function sanitizeOrganizationInviteCode(value: string): string {
  const compact = value.replace(/[^A-HJ-NP-Za-km-z2-9]/g, '').slice(0, 12);
  if (compact.length > 8) return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}`;
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

export function isAcceptableRegistrationPassword(password: string): boolean {
  if (password.length < 8 || password.length > 128) return false;
  if (/[^\x20-\x7E]/.test(password)) return false;
  const lower = password.toLocaleLowerCase('en-US');
  if (['password', 'password1', '12345678', '123456789', 'qwerty123'].includes(lower)) return false;
  if (/^\d+$/.test(password) || /^[a-z]+$/i.test(password)) return false;
  if (/^(.)\1{7,}$/.test(password)) return false;
  return true;
}

export function isRegistrationReady(input: {
  inviteCode: string;
  inviteRequired?: boolean;
  name: string;
  password: string;
  confirmPassword: string;
  challengeId: string;
  code: string;
  legalConsent: boolean;
  legalDocuments: EnterpriseLegalDocumentReference[];
}): boolean {
  return (!input.inviteRequired
    || input.inviteCode.replace(/[^A-HJ-NP-Za-km-z2-9]/g, '').length === 12)
    && Boolean(input.name.trim())
    && isAcceptableRegistrationPassword(input.password)
    && input.password === input.confirmPassword
    && Boolean(input.challengeId)
    && /^\d{6}$/.test(input.code)
    && input.legalConsent
    && input.legalDocuments.length === 2;
}

function enterpriseServerHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host || serverUrl.trim();
  } catch {
    return serverUrl.trim();
  }
}

function enterpriseLegalUrl(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl.trim());
    const isLocalDevelopment = url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '[::1]';
    if (
      (url.protocol !== 'https:' && !isLocalDevelopment) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) return null;
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/enterprise/legal`;
    return url.toString();
  } catch {
    return null;
  }
}

// Typewriter timing adapted from 21st.dev by designali-in (MIT), with reduced-motion handling.
function CapabilityTypewriter(): React.JSX.Element {
  const [frame, setFrame] = useState<TypewriterFrame>({ phraseIndex: 0, charIndex: 0, deleting: false });
  const [reducedMotion, setReducedMotion] = useState(false);
  const phrase = OTTO_CAPABILITIES[frame.phraseIndex];

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (reducedMotion) return undefined;
    const isHolding = !frame.deleting && frame.charIndex === phrase.length;
    const delay = isHolding ? 1700 : frame.deleting ? 34 : 66;
    const timer = window.setTimeout(
      () => setFrame((current) => advanceTypewriterFrame(current, OTTO_CAPABILITIES)),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [frame, phrase, reducedMotion]);

  const visiblePhrase = reducedMotion ? OTTO_CAPABILITIES[0] : phrase.slice(0, frame.charIndex);
  return (
    <span className="otto-auth-typewriter" aria-label={reducedMotion ? OTTO_CAPABILITIES[0] : phrase}>
      <span aria-hidden>{visiblePhrase}</span>
      <span className="otto-auth-typewriter__cursor" aria-hidden />
    </span>
  );
}

export function EnterpriseLoginPage({
  initialServerUrl,
  initialInviteCode,
  busy,
  error,
  onPasswordLogin,
  onRequestLoginCode,
  onSmsLogin,
  onRequestRegistrationCode,
  onRegister,
  onClearError,
}: {
  initialServerUrl: string;
  initialInviteCode?: string;
  busy: boolean;
  error: string | null;
  onPasswordLogin: (input: { serverUrl: string; identifier: string; password: string }) => Promise<void>;
  onRequestLoginCode?: (input: { serverUrl: string; phone: string }) => Promise<{
    challengeId: string;
    message: string;
    retryAfterSeconds: number;
  }>;
  onSmsLogin?: (input: { challengeId: string; code: string }) => Promise<void>;
  onRequestRegistrationCode: (input: { serverUrl: string; phone: string; inviteCode?: string }) => Promise<{
    challengeId: string;
    message: string;
    retryAfterSeconds: number;
    registrationMode?: 'personal' | 'enterprise';
    organization: { id: string; name: string } | null;
    legalDocuments: EnterpriseLegalDocumentReference[];
  }>;
  onRegister: (input: {
    challengeId: string;
    code: string;
    name: string;
    password: string;
    legalConsent: true;
    legalDocuments: EnterpriseLegalDocumentReference[];
  }) => Promise<void>;
  onClearError: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<LoginMode>(initialInviteCode ? 'join' : 'login');
  const [loginMethod, setLoginMethod] = useState<LoginMethod>(
    onRequestLoginCode && onSmsLogin ? 'sms' : 'password',
  );
  const [identifier, setIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginPhone, setLoginPhone] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [loginChallengeId, setLoginChallengeId] = useState('');
  const [loginNotice, setLoginNotice] = useState('');
  const [loginCountdown, setLoginCountdown] = useState(0);
  const [loginRequesting, setLoginRequesting] = useState(false);
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [name, setName] = useState('');
  const [registrationPassword, setRegistrationPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState(
    () => sanitizeOrganizationInviteCode(initialInviteCode || ''),
  );
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [notice, setNotice] = useState('');
  const [legalConsent, setLegalConsent] = useState(false);
  const [legalDocuments, setLegalDocuments] = useState<EnterpriseLegalDocumentReference[]>([]);
  const [organizationName, setOrganizationName] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const requestEpochRef = useRef(0);
  const submitLockedRef = useRef(false);
  const formPending = busy || submitting;
  const serverHost = enterpriseServerHost(serverUrl);
  const legalUrl = enterpriseLegalUrl(serverUrl);

  useEffect(() => {
    if (!initialInviteCode) return;
    requestEpochRef.current += 1;
    setMode('join');
    setInviteCode(sanitizeOrganizationInviteCode(initialInviteCode));
    setChallengeId('');
    setCode('');
    setNotice('');
    setOrganizationName('');
    setLegalDocuments([]);
    setCountdown(0);
    setRequesting(false);
    onClearError();
  }, [initialInviteCode, onClearError]);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  useEffect(() => {
    if (loginCountdown <= 0) return undefined;
    const timer = window.setInterval(
      () => setLoginCountdown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [loginCountdown]);

  const requestCode = async (): Promise<void> => {
    if (formPending || requesting || countdown > 0) return;
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;
    setRequesting(true);
    setNotice('');
    try {
      const result = await onRequestRegistrationCode({
        serverUrl: serverUrl.trim(),
        phone: phone.trim(),
        ...(mode === 'join' ? { inviteCode } : {}),
      });
      if (requestEpoch !== requestEpochRef.current) return;
      setChallengeId(result.challengeId);
      setNotice(result.message);
      setOrganizationName(result.organization?.name ?? '');
      setLegalDocuments(result.legalDocuments);
      setCountdown(result.retryAfterSeconds);
    } catch {
      // 具体错误由 useEnterpriseAuth 写入 error，表单只负责结束 loading。
    } finally {
      if (requestEpoch === requestEpochRef.current) setRequesting(false);
    }
  };

  const invalidateLoginChallenge = (): void => {
    setLoginChallengeId('');
    setLoginCode('');
    setLoginNotice('');
    setLoginCountdown(0);
    setLoginRequesting(false);
  };

  const requestSmsLoginCode = async (): Promise<void> => {
    if (
      formPending
      || loginRequesting
      || loginCountdown > 0
      || !onRequestLoginCode
    ) return;
    setLoginRequesting(true);
    setLoginNotice('');
    try {
      const result = await onRequestLoginCode({
        serverUrl: serverUrl.trim(),
        phone: loginPhone.trim(),
      });
      setLoginChallengeId(result.challengeId);
      setLoginNotice(result.message);
      setLoginCountdown(result.retryAfterSeconds);
    } catch {
      // 具体错误由 useEnterpriseAuth 写入 error。
    } finally {
      setLoginRequesting(false);
    }
  };

  const invalidateRegistrationChallenge = (): void => {
    requestEpochRef.current += 1;
    setRequesting(false);
    setChallengeId('');
    setCode('');
    setNotice('');
    setOrganizationName('');
    setLegalDocuments([]);
    setCountdown(0);
  };

  useEffect(() => {
    setServerUrl(initialServerUrl);
    requestEpochRef.current += 1;
    setLoginChallengeId('');
    setLoginCode('');
    setLoginNotice('');
    setLoginCountdown(0);
    setLoginRequesting(false);
    setRequesting(false);
    setChallengeId('');
    setCode('');
    setNotice('');
    setOrganizationName('');
    setCountdown(0);
  }, [initialServerUrl]);

  const updateServerUrl = (value: string): void => {
    setServerUrl(value);
    invalidateLoginChallenge();
    invalidateRegistrationChallenge();
    onClearError();
  };

  const submitAuth = async (): Promise<void> => {
    if (formPending || requesting || loginRequesting || submitLockedRef.current) return;
    if (!serverUrl.trim()) return;
    if ((mode === 'register' || mode === 'join') && !isRegistrationReady({
      inviteCode,
      inviteRequired: mode === 'join',
      name,
      password: registrationPassword,
      confirmPassword,
      challengeId,
      code,
      legalConsent,
      legalDocuments,
    })) return;
    if (
      mode === 'login'
      && (
        loginMethod === 'password'
          ? (!identifier.trim() || !loginPassword)
          : (!loginChallengeId || !/^\d{6}$/.test(loginCode) || !onSmsLogin)
      )
    ) return;

    submitLockedRef.current = true;
    setSubmitting(true);
    try {
      if (mode === 'register' || mode === 'join') {
        await onRegister({
          challengeId,
          code: code.trim(),
          name: name.trim(),
          password: registrationPassword,
          legalConsent: true,
          legalDocuments,
        });
      } else if (loginMethod === 'password') {
        await onPasswordLogin({
          serverUrl: serverUrl.trim(),
          identifier: identifier.trim(),
          password: loginPassword,
        });
      } else if (onSmsLogin) {
        await onSmsLogin({
          challengeId: loginChallengeId,
          code: loginCode,
        });
      }
    } finally {
      submitLockedRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <main className="otto-auth-shell">
      <section className="otto-auth-visual" aria-label="Otto 企业安全空间">
        <div className="otto-auth-visual__aurora" aria-hidden />
        <header className="otto-auth-brand">
          <span className="otto-auth-brand__mark" aria-hidden>
            <svg viewBox="0 0 32 32"><path d="m16 2 4 6 7-1-1 7 5 4-6 4v7l-7-3-5 5-2-7-7-1 4-6-4-6 7-1Z" /><circle cx="16" cy="16" r="6" /></svg>
          </span>
          <span>OTTO</span>
          <small>DIGITAL COLLEAGUE</small>
        </header>

        <div className="otto-auth-mascot-stage">
          <span className="otto-auth-mascot-stage__label">READY TO WORK</span>
          <OttoPetStage running={false} variant="login" />
        </div>

        <div className="otto-auth-visual__copy">
          <span className="otto-auth-kicker">YOUR AI COLLEAGUE, ONLINE</span>
          <h1><span>有事交给 Otto。</span><CapabilityTypewriter /></h1>
          <p>能读懂项目、调用工具、操作浏览器，也懂得在企业权限边界内做事。</p>
        </div>

        <footer className="otto-auth-trust" aria-label="企业安全能力">
          <span><svg viewBox="0 0 20 20" aria-hidden><path d="m4 10 4 4 8-8" /></svg> 身份强制验证</span>
          <span><svg viewBox="0 0 20 20" aria-hidden><path d="M10 2 4 5v5c0 4 2.4 6.8 6 8 3.6-1.2 6-4 6-8V5Z" /></svg> 企业数据隔离</span>
          <span><svg viewBox="0 0 20 20" aria-hidden><circle cx="10" cy="10" r="7" /><path d="M10 6v5l3 2" /></svg> 操作全程可追踪</span>
        </footer>
      </section>

      <section className="otto-auth-panel">
        <form
          className={`otto-auth-card otto-auth-card--${mode === 'login' ? 'login' : 'register'}`}
          onSubmit={(event) => {
            event.preventDefault();
            void submitAuth();
          }}
        >
          <span className="otto-auth-card__pixel-corner" aria-hidden />
          <header className="otto-auth-card__masthead">
            <span className="otto-auth-card__pixel-mark" aria-hidden><i /><i /><i /><i /></span>
            <span><strong>OTTO SECURE ACCESS</strong><small>企业身份门禁</small></span>
            <b>{mode === 'login' ? 'AUTHORIZED' : mode === 'join' ? 'JOIN COMPANY' : 'NEW ACCOUNT'}</b>
          </header>
          <label
            className="otto-auth-server"
          >
            <span>企业服务器地址</span>
            <input
              aria-label="企业服务器地址"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoComplete="url"
              spellCheck={false}
              value={serverUrl}
              disabled={formPending}
              onChange={(event) => updateServerUrl(event.target.value)}
              placeholder="https://enterprise.example.com"
              required
            />
            <strong>{serverHost || '请输入管理员提供的 HTTPS 地址'}</strong>
          </label>
          <div className="otto-auth-card__topline">
            <span className="otto-auth-status-dot" />
            {mode === 'login'
              ? '此设备将安全保持登录'
              : mode === 'join' ? '企业成员加入' : '创建个人 Otto 账号'}
          </div>

          {mode === 'register' || mode === 'join' ? (
            <>
              <h2>{mode === 'join' ? '加入企业' : '创建 Otto 账号'}</h2>
              <p className="otto-auth-card__intro">
                {mode === 'join' ? (
                  <span>企业员工输入管理员提供的邀请码，验证后加入对应组织。</span>
                ) : (
                  <span>普通注册不需要企业邀请码，将创建互相隔离的个人空间。</span>
                )}{' '}
                <span>注册后可用账号密码或手机号验证码登录。</span>
              </p>
              {mode === 'join' ? (
                <label className="otto-auth-field otto-auth-invite-field">
                  <span>企业邀请码</span>
                  <input
                    aria-label="企业邀请码"
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={14}
                    value={inviteCode}
                    disabled={formPending}
                    onChange={(event) => {
                      setInviteCode(sanitizeOrganizationInviteCode(event.target.value));
                      invalidateRegistrationChallenge();
                      onClearError();
                    }}
                    placeholder="Aa3B-k9Pq-Z7xY"
                    required
                  />
                  <small>仅加入企业时需要，由企业管理员生成；大小写敏感</small>
                </label>
              ) : null}
              <div className="otto-auth-register-grid">
                <label className="otto-auth-field">
                  <span>姓名</span>
                  <input
                    aria-label="姓名"
                    autoComplete="name"
                    value={name}
                    disabled={formPending}
                    onChange={(event) => {
                      setName(event.target.value);
                      onClearError();
                    }}
                    placeholder="填写真实姓名"
                    required
                  />
                </label>
                <label className="otto-auth-field">
                  <span>手机号</span>
                  <div className="otto-auth-phone">
                    <b>+86</b>
                    <input
                      aria-label="手机号"
                      inputMode="tel"
                      autoComplete="tel"
                      value={phone}
                      disabled={formPending}
                      onChange={(event) => {
                        setPhone(event.target.value);
                        invalidateRegistrationChallenge();
                        onClearError();
                      }}
                      placeholder="11 位手机号"
                      required
                    />
                  </div>
                </label>
              </div>
              <div className="otto-auth-register-grid">
                <label className="otto-auth-field">
                  <span>设置登录密码</span>
                  <input
                    aria-label="设置登录密码"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={128}
                    value={registrationPassword}
                    disabled={formPending}
                    onChange={(event) => {
                      setRegistrationPassword(event.target.value);
                      onClearError();
                    }}
                    placeholder="至少 8 位，不能是纯数字或纯字母"
                    required
                  />
                </label>
                <div className="otto-auth-inline-hint">至少 8 位；不能使用常见密码、纯数字、纯字母或连续重复字符。</div>
                <label className="otto-auth-field">
                  <span>确认登录密码</span>
                  <input
                    aria-label="确认登录密码"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    value={confirmPassword}
                    disabled={formPending}
                    onChange={(event) => {
                      setConfirmPassword(event.target.value);
                      onClearError();
                    }}
                    placeholder="再次输入密码"
                    required
                  />
                </label>
              </div>
              <label className="otto-auth-field">
                <span>短信验证码</span>
                <div className="otto-auth-code">
                  <input
                    aria-label="短信验证码"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    disabled={formPending}
                    onChange={(event) => {
                      setCode(sanitizeSmsCode(event.target.value));
                      onClearError();
                    }}
                    placeholder="6 位验证码"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => void requestCode()}
                    disabled={formPending || requesting || countdown > 0
                      || phone.replace(/\D/g, '').length !== 11
                      || (mode === 'join'
                        && inviteCode.replace(/[^A-Z2-9]/g, '').length !== 8)}
                  >
                    {requesting ? '发送中…' : countdown > 0 ? `${countdown}s 后重试` : '获取验证码'}
                  </button>
                </div>
              </label>
              {confirmPassword && registrationPassword !== confirmPassword ? (
                <div className="otto-auth-inline-warning" role="status">两次输入的密码不一致</div>
              ) : null}
              {organizationName ? (
                <div className="otto-auth-organization" role="status">将加入「{organizationName}」</div>
              ) : null}
              {notice ? <div className="otto-auth-notice" role="status">{notice}</div> : null}
              <label className="otto-auth-consent">
                <input
                  type="checkbox"
                  checked={legalConsent}
                  disabled={formPending}
                  onChange={(event) => {
                    setLegalConsent(event.target.checked);
                    onClearError();
                  }}
                />
                <span>我已阅读并同意
                  <button
                    type="button"
                    disabled={!legalUrl}
                    onClick={() => {
                      if (legalUrl) void window.otto.openExternal(legalUrl);
                    }}
                  >《用户服务协议》与《隐私规则》</button>
                  <small>
                    {legalDocuments.length === 2
                      ? `当前版本 ${legalDocuments.map((document) => `${document.id}:${document.version}#${document.hash.slice(0, 8)}`).join(' · ')}`
                      : '获取验证码后将绑定当前协议版本与正文哈希'}
                  </small>
                </span>
              </label>
            </>
          ) : (
            <>
              <h2>欢迎回来</h2>
              <p className="otto-auth-card__intro">账号密码和手机号验证码是两种独立登录方式，均不需要企业邀请码。</p>
              <div className="otto-auth-login-methods" aria-label="登录方式">
                <button
                  type="button"
                  aria-pressed={loginMethod === 'password'}
                  onClick={() => {
                    setLoginMethod('password');
                    invalidateLoginChallenge();
                    onClearError();
                  }}
                >
                  密码登录
                </button>
                <button
                  type="button"
                  aria-pressed={loginMethod === 'sms'}
                  onClick={() => {
                    setLoginMethod('sms');
                    invalidateLoginChallenge();
                    onClearError();
                  }}
                >
                  验证码登录
                </button>
              </div>
              {loginMethod === 'password' ? (
                <>
                  <label className="otto-auth-field">
                    <span>账号或手机号</span>
                    <input
                      aria-label="账号或手机号"
                      autoComplete="username"
                      value={identifier}
                      disabled={formPending}
                      onChange={(event) => {
                        setIdentifier(event.target.value);
                        onClearError();
                      }}
                      placeholder="账号或 11 位手机号"
                      required
                    />
                  </label>
                  <label className="otto-auth-field">
                    <span>密码</span>
                    <input
                      aria-label="密码"
                      type="password"
                      autoComplete="current-password"
                      value={loginPassword}
                      disabled={formPending}
                      onChange={(event) => {
                        setLoginPassword(event.target.value);
                        onClearError();
                      }}
                      placeholder="输入登录密码"
                      required
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="otto-auth-field">
                    <span>手机号</span>
                    <div className="otto-auth-phone">
                      <b>+86</b>
                      <input
                        aria-label="登录手机号"
                        inputMode="tel"
                        autoComplete="tel"
                        value={loginPhone}
                        disabled={formPending}
                        onChange={(event) => {
                          setLoginPhone(event.target.value);
                          invalidateLoginChallenge();
                          onClearError();
                        }}
                        placeholder="11 位手机号"
                        required
                      />
                    </div>
                  </label>
                  <label className="otto-auth-field">
                    <span>短信验证码</span>
                    <div className="otto-auth-code">
                      <input
                        aria-label="登录验证码"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        value={loginCode}
                        disabled={formPending}
                        onChange={(event) => {
                          setLoginCode(sanitizeSmsCode(event.target.value));
                          onClearError();
                        }}
                        placeholder="6 位验证码"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => void requestSmsLoginCode()}
                        disabled={formPending || loginRequesting || loginCountdown > 0
                          || loginPhone.replace(/\D/g, '').length !== 11
                          || !onRequestLoginCode}
                      >
                        {loginRequesting
                          ? '发送中…'
                          : loginCountdown > 0 ? `${loginCountdown}s 后重试` : '获取验证码'}
                      </button>
                    </div>
                  </label>
                  {loginNotice ? <div className="otto-auth-notice" role="status">{loginNotice}</div> : null}
                </>
              )}
            </>
          )}

          {error ? <div className="otto-auth-error" role="alert">{error}</div> : null}
          <button
            className="otto-auth-submit"
            type="submit"
            disabled={formPending || requesting || loginRequesting
              || (mode === 'login' && (
                loginMethod === 'password'
                  ? (!identifier.trim() || !loginPassword)
                  : (!loginChallengeId || !/^\d{6}$/.test(loginCode) || !onSmsLogin)
              ))
              || ((mode === 'register' || mode === 'join') && !isRegistrationReady({
                inviteCode,
                inviteRequired: mode === 'join',
                name,
                password: registrationPassword,
                confirmPassword,
                challengeId,
                code,
                legalConsent,
                legalDocuments,
              }))}
          >
            <span>
              {formPending
                ? '正在验证身份…'
                : mode === 'login'
                  ? '进入 Otto'
                  : mode === 'join' ? '加入企业并进入' : '创建账号并进入'}
            </span>
            <svg viewBox="0 0 24 24" aria-hidden><path d="M5 12h13m-5-5 5 5-5 5" /></svg>
          </button>

          <div className="otto-auth-mode-switch">
            <span>{mode === 'login' ? '第一次使用 Otto？' : '已经有 Otto 账号？'}</span>
            {mode === 'login' ? (
              <>
                <button
                  type="button"
                  disabled={formPending || requesting || loginRequesting}
                  onClick={() => {
                    invalidateRegistrationChallenge();
                    invalidateLoginChallenge();
                    setMode('register');
                    onClearError();
                  }}
                >
                  普通注册
                </button>
                <button
                  type="button"
                  disabled={formPending || requesting || loginRequesting}
                  onClick={() => {
                    invalidateRegistrationChallenge();
                    invalidateLoginChallenge();
                    setMode('join');
                    onClearError();
                  }}
                >
                  使用邀请码加入企业
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={formPending || requesting}
                onClick={() => {
                  invalidateRegistrationChallenge();
                  setRegistrationPassword('');
                  setConfirmPassword('');
                  setLoginPassword('');
                  setMode('login');
                  onClearError();
                }}
              >
                已有账号，返回登录
              </button>
            )}
          </div>

          <p className="otto-auth-legal"><span aria-hidden>●</span> TLS 加密连接 · 企业邀请码只用于加入组织</p>
        </form>
      </section>
    </main>
  );
}
