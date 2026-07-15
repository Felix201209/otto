/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { OttoPetStage } from './OttoPetStage.js';

type LoginMode = 'login' | 'register';

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
  const compact = value.toLocaleUpperCase('en-US').replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

export function isRegistrationReady(input: {
  inviteCode: string;
  name: string;
  password: string;
  confirmPassword: string;
  challengeId: string;
  code: string;
}): boolean {
  return input.inviteCode.replace(/[^A-Z2-9]/g, '').length === 8
    && Boolean(input.name.trim())
    && input.password.length >= 8
    && input.password === input.confirmPassword
    && Boolean(input.challengeId)
    && /^\d{6}$/.test(input.code);
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
  onRequestRegistrationCode,
  onRegister,
  onClearError,
}: {
  initialServerUrl: string;
  initialInviteCode?: string;
  busy: boolean;
  error: string | null;
  onPasswordLogin: (input: { serverUrl: string; identifier: string; password: string }) => Promise<void>;
  onRequestRegistrationCode: (input: { serverUrl: string; phone: string; inviteCode: string }) => Promise<{
    challengeId: string;
    message: string;
    retryAfterSeconds: number;
    organization: { id: string; name: string };
  }>;
  onRegister: (input: { challengeId: string; code: string; name: string; password: string }) => Promise<void>;
  onClearError: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<LoginMode>(initialInviteCode ? 'register' : 'login');
  const [identifier, setIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
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
  const [organizationName, setOrganizationName] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (!initialInviteCode) return;
    setMode('register');
    setInviteCode(sanitizeOrganizationInviteCode(initialInviteCode));
    setChallengeId('');
    setCode('');
    setNotice('');
    setOrganizationName('');
    setCountdown(0);
    onClearError();
  }, [initialInviteCode, onClearError]);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  const requestCode = async (): Promise<void> => {
    if (requesting || countdown > 0) return;
    setRequesting(true);
    setNotice('');
    try {
      const result = await onRequestRegistrationCode({
        serverUrl: initialServerUrl.trim(),
        phone: phone.trim(),
        inviteCode,
      });
      setChallengeId(result.challengeId);
      setNotice(result.message);
      setOrganizationName(result.organization.name);
      setCountdown(result.retryAfterSeconds);
    } catch {
      // 具体错误由 useEnterpriseAuth 写入 error，表单只负责结束 loading。
    } finally {
      setRequesting(false);
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
          className={`otto-auth-card otto-auth-card--${mode}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === 'register') {
              void onRegister({
                challengeId,
                code: code.trim(),
                name: name.trim(),
                password: registrationPassword,
              });
              return;
            }
            void onPasswordLogin({
              serverUrl: initialServerUrl.trim(),
              identifier: identifier.trim(),
              password: loginPassword,
            });
          }}
        >
          <span className="otto-auth-card__pixel-corner" aria-hidden />
          <header className="otto-auth-card__masthead">
            <span className="otto-auth-card__pixel-mark" aria-hidden><i /><i /><i /><i /></span>
            <span><strong>OTTO SECURE ACCESS</strong><small>企业身份门禁</small></span>
            <b>{mode === 'register' ? 'NEW ACCOUNT' : 'AUTHORIZED'}</b>
          </header>
          <div className="otto-auth-card__topline">
            <span className="otto-auth-status-dot" />
            {mode === 'register' ? '首次注册身份核验' : '此设备将安全保持登录'}
          </div>

          {mode === 'register' ? (
            <>
              <h2>创建 Otto 账号</h2>
              <p className="otto-auth-card__intro">
                <span>输入管理员提供的企业邀请码。</span>{' '}
                <span>验证码只在首次注册时使用。以后直接用手机号和密码登录。</span>
              </p>
              <label className="otto-auth-field otto-auth-invite-field">
                <span>企业邀请码</span>
                <input
                  aria-label="企业邀请码"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={9}
                  value={inviteCode}
                  onChange={(event) => {
                    setInviteCode(sanitizeOrganizationInviteCode(event.target.value));
                    setChallengeId('');
                    setCode('');
                    setNotice('');
                    setOrganizationName('');
                    setCountdown(0);
                    onClearError();
                  }}
                  placeholder="XXXX-XXXX"
                  required
                />
                <small>邀请码由企业管理员生成，7 天内有效</small>
              </label>
              <div className="otto-auth-register-grid">
                <label className="otto-auth-field">
                  <span>姓名</span>
                  <input
                    aria-label="姓名"
                    autoComplete="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
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
                      onChange={(event) => {
                        setPhone(event.target.value);
                        setChallengeId('');
                        setCode('');
                        setNotice('');
                        setOrganizationName('');
                        setCountdown(0);
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
                    value={registrationPassword}
                    onChange={(event) => setRegistrationPassword(event.target.value)}
                    placeholder="至少 8 位"
                    required
                  />
                </label>
                <label className="otto-auth-field">
                  <span>确认登录密码</span>
                  <input
                    aria-label="确认登录密码"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
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
                    onChange={(event) => setCode(sanitizeSmsCode(event.target.value))}
                    placeholder="6 位验证码"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => void requestCode()}
                    disabled={requesting || countdown > 0
                      || phone.replace(/\D/g, '').length !== 11
                      || inviteCode.replace(/[^A-Z2-9]/g, '').length !== 8}
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
            </>
          ) : (
            <>
              <h2>欢迎回来</h2>
              <p className="otto-auth-card__intro">登录后会在此设备安全保持登录，重开 Otto 会自动进入工作区。</p>
              <label className="otto-auth-field">
                <span>账号或手机号</span>
                <input
                  aria-label="账号或手机号"
                  autoComplete="username"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  placeholder="企业账号或 11 位手机号"
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
                  onChange={(event) => setLoginPassword(event.target.value)}
                  placeholder="输入登录密码"
                  required
                />
              </label>
            </>
          )}

          {error ? <div className="otto-auth-error" role="alert">{error}</div> : null}
          <button
            className="otto-auth-submit"
            type="submit"
            disabled={busy || (mode === 'register' && !isRegistrationReady({
              inviteCode,
              name,
              password: registrationPassword,
              confirmPassword,
              challengeId,
              code,
            }))}
          >
            <span>{busy ? '正在验证身份…' : mode === 'register' ? '创建账号并进入' : '进入 Otto'}</span>
            <svg viewBox="0 0 24 24" aria-hidden><path d="M5 12h13m-5-5 5 5-5 5" /></svg>
          </button>

          <div className="otto-auth-mode-switch">
            <span>{mode === 'register' ? '已经有 Otto 账号？' : '第一次使用 Otto？'}</span>
            <button
              type="button"
              onClick={() => {
                setMode((current) => current === 'register' ? 'login' : 'register');
                setNotice('');
                onClearError();
              }}
            >
              {mode === 'register' ? '已有账号，返回登录' : '注册新账号'}
            </button>
          </div>

          <p className="otto-auth-legal"><span aria-hidden>●</span> TLS 加密连接 · 身份信息仅用于企业账号与权限管理</p>
        </form>
      </section>
    </main>
  );
}
