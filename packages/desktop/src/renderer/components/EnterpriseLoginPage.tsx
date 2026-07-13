/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';

export function EnterpriseLoginPage({
  initialServerUrl,
  busy,
  error,
  onLogin,
}: {
  initialServerUrl: string;
  busy: boolean;
  error: string | null;
  onLogin: (input: { serverUrl: string; username: string; password: string }) => Promise<void>;
}): React.JSX.Element {
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (initialServerUrl) setServerUrl(initialServerUrl);
  }, [initialServerUrl]);

  return (
    <main className="otto-enterprise-login">
      <section className="otto-enterprise-login__story" aria-label="Otto 企业账号说明">
        <div className="otto-enterprise-login__wordmark">otto<span>✦</span></div>
        <div className="otto-enterprise-login__signal" aria-hidden>
          <span /><span /><span />
        </div>
        <div className="otto-enterprise-login__storycopy">
          <div className="otto-enterprise-login__eyebrow">ENTERPRISE ACCESS</div>
          <h1>让每个请求，<br />找到正确的人。</h1>
          <p>预设账号、职责标签和工单路由由公司服务器统一管理。</p>
        </div>
        <div className="otto-enterprise-login__route">
          <span>员工提交</span><i />
          <span>标签匹配</span><i />
          <span>责任人收到</span>
        </div>
      </section>

      <section className="otto-enterprise-login__formside">
        <form
          className="otto-enterprise-login__form"
          onSubmit={(event) => {
            event.preventDefault();
            void onLogin({ serverUrl: serverUrl.trim(), username: username.trim(), password });
          }}
        >
          <div className="otto-enterprise-login__badge"><span /> Ubuntu-wysn</div>
          <h2>登录 Otto</h2>
          <p className="otto-enterprise-login__intro">使用管理员预先创建的内部账号。这里没有注册、邮箱验证或找回密码流程。</p>

          <label className="otto-enterprise-field">
            <span>企业服务器</span>
            <input
              aria-label="企业服务器"
              inputMode="url"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="http://服务器地址:7777"
              autoComplete="url"
              required
            />
          </label>
          <label className="otto-enterprise-field">
            <span>账号</span>
            <input
              aria-label="账号"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </label>
          <label className="otto-enterprise-field">
            <span>密码</span>
            <input
              aria-label="密码"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          {error ? <div className="otto-enterprise-login__error" role="alert">{error}</div> : null}
          <button className="otto-enterprise-login__submit" type="submit" disabled={busy}>
            {busy ? '正在验证…' : '登录 Otto'}
            <span aria-hidden>→</span>
          </button>
          <p className="otto-enterprise-login__footnote">账号不存在或已停用时，服务器会拒绝登录。</p>
        </form>
      </section>
    </main>
  );
}
