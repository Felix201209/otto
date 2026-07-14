/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { OttoPetStage } from './OttoPetStage.js';

type LoginMode = 'sms' | 'password';

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

export function isSmsLoginReady(challengeId: string, code: string): boolean {
  return Boolean(challengeId) && /^\d{6}$/.test(code);
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
  busy,
  error,
  onPasswordLogin,
  onRequestSms,
  onSmsLogin,
}: {
  initialServerUrl: string;
  busy: boolean;
  error: string | null;
  onPasswordLogin: (input: { serverUrl: string; username: string; password: string }) => Promise<void>;
  onRequestSms: (input: { serverUrl: string; phone: string }) => Promise<{
    challengeId: string;
    message: string;
    retryAfterSeconds: number;
  }>;
  onSmsLogin: (input: { challengeId: string; code: string }) => Promise<void>;
}): React.JSX.Element {
  const [mode, setMode] = useState<LoginMode>('sms');
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [notice, setNotice] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (initialServerUrl) setServerUrl(initialServerUrl);
  }, [initialServerUrl]);

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
      const result = await onRequestSms({ serverUrl: serverUrl.trim(), phone: phone.trim() });
      setChallengeId(result.challengeId);
      setNotice(result.message);
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
          className="otto-auth-card"
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === 'sms') void onSmsLogin({ challengeId, code: code.trim() });
            else void onPasswordLogin({ serverUrl: serverUrl.trim(), username: username.trim(), password });
          }}
        >
          <span className="otto-auth-card__pixel-corner" aria-hidden />
          <header className="otto-auth-card__masthead">
            <span className="otto-auth-card__pixel-mark" aria-hidden><i /><i /><i /><i /></span>
            <span><strong>OTTO SECURE ACCESS</strong><small>企业身份门禁</small></span>
            <b>V1.8</b>
          </header>
          <div className="otto-auth-card__topline"><span className="otto-auth-status-dot" /> 企业安全身份入口已启用</div>
          <h2>进入 Otto</h2>
          <p className="otto-auth-card__intro">确认企业身份，带着会话与组织上下文继续工作。</p>

          <div className="otto-auth-tabs" role="tablist" aria-label="登录方式">
            <button type="button" role="tab" aria-selected={mode === 'sms'} className={mode === 'sms' ? 'is-active' : ''} onClick={() => setMode('sms')}>短信验证码</button>
            <button type="button" role="tab" aria-selected={mode === 'password'} className={mode === 'password' ? 'is-active' : ''} onClick={() => setMode('password')}>账号密码</button>
          </div>

          {mode === 'sms' ? (
            <>
              <label className="otto-auth-field">
                <span>手机号</span>
                <div className="otto-auth-phone"><b>+86</b><input aria-label="手机号" inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="请输入手机号" required /></div>
              </label>
              <label className="otto-auth-field">
                <span>短信验证码</span>
                <div className="otto-auth-code"><input aria-label="短信验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(sanitizeSmsCode(event.target.value))} placeholder="6 位验证码" required /><button type="button" onClick={() => void requestCode()} disabled={requesting || countdown > 0 || phone.replace(/\D/g, '').length !== 11}>{requesting ? '发送中…' : countdown > 0 ? `${countdown}s 后重试` : '获取验证码'}</button></div>
              </label>
              {notice ? <div className="otto-auth-notice" role="status">{notice}</div> : null}
            </>
          ) : (
            <>
              <label className="otto-auth-field"><span>账号</span><input aria-label="账号" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="企业账号" required /></label>
              <label className="otto-auth-field"><span>密码</span><input aria-label="密码" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" required /></label>
            </>
          )}

          {error ? <div className="otto-auth-error" role="alert">{error}</div> : null}
          <button className="otto-auth-submit" type="submit" disabled={busy || (mode === 'sms' && !isSmsLoginReady(challengeId, code))}>
            <span>{busy ? '正在验证身份…' : '进入 Otto'}</span>
            <svg viewBox="0 0 24 24" aria-hidden><path d="M5 12h13m-5-5 5 5-5 5" /></svg>
          </button>

          <details className="otto-auth-server">
            <summary>连接设置</summary>
            <label className="otto-auth-field"><span>企业服务器</span><input aria-label="企业服务器" inputMode="url" autoComplete="url" value={serverUrl} onChange={(event) => { setServerUrl(event.target.value); setChallengeId(''); setNotice(''); }} required /></label>
          </details>
          <p className="otto-auth-legal"><span aria-hidden>●</span> TLS 加密连接 · 登录即代表你同意遵守公司的数据与安全规范</p>
        </form>
      </section>
    </main>
  );
}
