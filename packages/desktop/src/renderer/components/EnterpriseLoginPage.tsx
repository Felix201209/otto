/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';

type LoginMode = 'sms' | 'password';

export interface TypewriterFrame {
  phraseIndex: number;
  charIndex: number;
  deleting: boolean;
}

const OTTO_CAPABILITIES = [
  '把需求变成能运行的代码',
  '把会议纪要变成行动清单',
  '替你操作浏览器与工作台',
  '读懂项目，再安全地修改它',
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

function OttoHedgehogAtWork(): React.JSX.Element {
  return (
    <svg className="otto-auth-mascot" viewBox="0 0 640 390" role="img" aria-labelledby="otto-mascot-title otto-mascot-desc">
      <title id="otto-mascot-title">Otto 刺猬正在打字</title>
      <desc id="otto-mascot-desc">Otto 的刺猬吉祥物坐在一台发光打字机前，正在替你完成工作。</desc>
      <defs>
        <linearGradient id="otto-spines" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb353" />
          <stop offset="0.48" stopColor="#d76a2d" />
          <stop offset="1" stopColor="#71301f" />
        </linearGradient>
        <linearGradient id="otto-typewriter" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b8ffd7" />
          <stop offset="1" stopColor="#57d995" />
        </linearGradient>
        <filter id="otto-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="9" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <ellipse className="otto-auth-mascot__shadow" cx="326" cy="342" rx="248" ry="25" />
      <g className="otto-auth-mascot__signals" aria-hidden>
        <path d="M455 56c43 5 75 27 94 62" />
        <path d="M472 35c58 8 99 38 122 84" />
        <circle cx="553" cy="126" r="5" />
      </g>

      <g className="otto-auth-mascot__hedgehog">
        <path
          className="otto-auth-mascot__spines"
          d="M235 304 188 337l-2-49-53 21 13-50-58 3 30-41-56-18 43-27-43-35 55-10-25-49 57 12-5-54 48 30 16-52 34 44 37-40 15 53 49-27-7 57 57-10-29 50 55 14-44 36 43 31-57 12 25 51-54-3 8 51-53-22-3 48Z"
        />
        <ellipse className="otto-auth-mascot__face" cx="235" cy="211" rx="105" ry="115" transform="rotate(-8 235 211)" />
        <path className="otto-auth-mascot__muzzle" d="M211 226c33-31 76-25 93 8-10 37-69 53-101 17Z" />
        <ellipse className="otto-auth-mascot__eye" cx="214" cy="180" rx="8" ry="10" />
        <ellipse className="otto-auth-mascot__eye-glint" cx="217" cy="176" rx="2.5" ry="3" />
        <path className="otto-auth-mascot__brow" d="M193 157c10-7 22-8 32-3" />
        <path className="otto-auth-mascot__smile" d="M251 238c12 10 29 9 40-3" />
        <path className="otto-auth-mascot__nose" d="M316 213c14-9 28-4 32 7-7 15-23 17-35 7Z" />
        <path className="otto-auth-mascot__ear" d="M168 130c-28-20-47 17-20 39 12 10 24 4 30-6" />
        <path className="otto-auth-mascot__headphones" d="M151 199c-8-62 26-108 78-120 51-11 98 16 118 61" />
        <rect className="otto-auth-mascot__headphone" x="137" y="177" width="29" height="55" rx="14" transform="rotate(-5 137 177)" />
        <rect className="otto-auth-mascot__headphone" x="329" y="136" width="28" height="55" rx="14" transform="rotate(-6 329 136)" />
      </g>

      <g className="otto-auth-mascot__machine">
        <path className="otto-auth-mascot__paper" d="M351 72h173l-9 150H360Z" />
        <path className="otto-auth-mascot__paper-line is-strong" d="M379 108h108" />
        <path className="otto-auth-mascot__paper-line" d="M379 131h82" />
        <path className="otto-auth-mascot__paper-line" d="M379 154h120" />
        <path className="otto-auth-mascot__paper-line is-live" d="M379 177h68" />
        <path className="otto-auth-mascot__roller" d="M336 207h199" />
        <path className="otto-auth-mascot__body" d="M329 207h212l38 112H294Z" />
        <path className="otto-auth-mascot__keyboard" d="M325 243h211l20 57H306Z" />
        <g className="otto-auth-mascot__keys">
          <path d="M346 259h18m13 0h18m13 0h18m13 0h18m13 0h18m13 0h18" />
          <path d="M336 277h18m13 0h18m13 0h18m13 0h18m13 0h18m13 0h18m13 0h18" />
        </g>
        <circle className="otto-auth-mascot__power" cx="528" cy="225" r="5" />
      </g>

      <g className="otto-auth-mascot__paws">
        <ellipse className="otto-auth-mascot__paw otto-auth-mascot__paw--left" cx="292" cy="259" rx="29" ry="18" transform="rotate(-12 292 259)" />
        <ellipse className="otto-auth-mascot__paw otto-auth-mascot__paw--right" cx="343" cy="273" rx="29" ry="18" transform="rotate(9 343 273)" />
      </g>
      <g className="otto-auth-mascot__spark" filter="url(#otto-glow)" aria-hidden>
        <circle cx="546" cy="75" r="4" />
        <circle cx="575" cy="158" r="3" />
        <path d="m116 80 5 11 11 5-11 5-5 11-5-11-11-5 11-5Z" />
      </g>
    </svg>
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
          <OttoHedgehogAtWork />
        </div>

        <div className="otto-auth-visual__copy">
          <span className="otto-auth-kicker">YOUR AI COLLEAGUE, ONLINE</span>
          <h1>你说目标，<br /><em>Otto 开始干活。</em></h1>
          <div className="otto-auth-capability">
            <span className="otto-auth-capability__prompt" aria-hidden>›</span>
            <CapabilityTypewriter />
          </div>
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
          <div className="otto-auth-card__eyebrow">OTTO WORKSPACE <span>V1.8</span></div>
          <div className="otto-auth-card__topline"><span className="otto-auth-status-dot" /> 企业安全身份入口已启用</div>
          <h2>登录你的工作空间</h2>
          <p className="otto-auth-card__intro">身份确认后，Otto 会带着你的会话与组织上下文继续工作。</p>

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
