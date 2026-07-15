/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type { ServerResponse } from 'node:http';

type PublicInvitePageState = 'active' | 'not-found' | 'unavailable';

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function renderPublicInvitePage(state: PublicInvitePageState, code?: string): string {
  const isActive = state === 'active' && Boolean(code);
  const title = isActive
    ? '加入企业，打开 Otto'
    : state === 'unavailable' ? '引入链接已失效' : '引入链接不存在';
  const description = isActive
    ? '点击下方按钮打开 Otto。企业邀请码已经随链接准备好，你仍需完成姓名、手机号与短信验证。'
    : state === 'unavailable'
      ? '企业引入链接仅在生成后的 5 小时内有效，换新后旧链接也会立即停止使用。'
      : '请检查地址是否完整，或联系企业管理员重新发送一条引入链接。';
  const safeCode = code ? escapeHTML(code) : '';
  const deepLink = code
    ? escapeHTML('otto://enterprise/join?invite=' + encodeURIComponent(code))
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHTML(title)} · Otto</title>
  <style>
    :root{color-scheme:light;font-family:Inter,"SF Pro Display","PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#f3f1e9;color:#162b27}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:#f3f1e9}
    .page{min-height:100vh;display:grid;place-items:center;padding:32px 18px}
    .shell{width:min(100%,520px)}
    .brand{display:flex;align-items:center;gap:11px;margin:0 0 18px 4px;font-size:14px;font-weight:800;letter-spacing:.12em;color:#23443d}
    .mark{display:grid;place-items:center;width:34px;height:34px;border:2px solid #173f37;border-radius:11px;background:#f1bd55;color:#173f37;font-size:18px;letter-spacing:0}
    .card{overflow:hidden;border:1px solid #d9d6ca;border-radius:28px;background:#fff;box-shadow:0 20px 55px rgba(24,48,42,.12)}
    .hero{padding:34px 34px 30px;background:#143f37;color:#fff}
    .eyebrow{display:inline-flex;align-items:center;gap:8px;margin-bottom:20px;padding:7px 11px;border:1px solid rgba(255,255,255,.24);border-radius:999px;color:#dce9e5;font-size:12px;font-weight:700;letter-spacing:.08em}
    .dot{width:7px;height:7px;border-radius:50%;background:#f1bd55;box-shadow:0 0 0 4px rgba(241,189,85,.13)}
    h1{max-width:390px;margin:0;font-size:clamp(30px,7vw,42px);line-height:1.08;letter-spacing:-.04em}
    .description{margin:17px 0 0;color:#c9d9d5;font-size:15px;line-height:1.75}
    .content{padding:28px 34px 34px}
    .code-label{margin-bottom:9px;color:#6b7975;font-size:12px;font-weight:700;letter-spacing:.08em}
    .code{display:flex;align-items:center;justify-content:center;min-height:72px;margin-bottom:16px;border:1px solid #d9d6ca;border-radius:17px;background:#f7f5ef;color:#173f37;font:800 clamp(23px,7vw,30px)/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.13em}
    .primary{display:flex;align-items:center;justify-content:center;min-height:54px;border-radius:16px;background:#f1bd55;color:#17352f;text-decoration:none;font-size:16px;font-weight:850;box-shadow:0 7px 0 #ca9131;transition:transform .14s ease,box-shadow .14s ease}
    .primary:hover{transform:translateY(-2px);box-shadow:0 9px 0 #ca9131}
    .primary:active{transform:translateY(4px);box-shadow:0 3px 0 #ca9131}
    .help{margin-top:25px;padding-top:22px;border-top:1px solid #ebe8df;color:#566762;font-size:13px;line-height:1.75}
    .help strong{display:block;margin-bottom:7px;color:#203d36;font-size:14px}
    .help ol{margin:0;padding-left:19px}
    .status{display:grid;place-items:center;width:58px;height:58px;margin-bottom:21px;border-radius:18px;background:#f0ece2;color:#765f35;font-size:26px;font-weight:800}
    .secondary{display:flex;align-items:center;justify-content:center;min-height:50px;margin-top:23px;border:1px solid #d9d6ca;border-radius:15px;color:#25483f;text-decoration:none;font-size:14px;font-weight:750}
    .fine{margin:18px 2px 0;text-align:center;color:#7c8985;font-size:12px;line-height:1.6}
    @media(max-width:520px){.page{padding:18px 12px}.hero{padding:29px 24px 26px}.content{padding:24px}.card{border-radius:23px}}
    @media(prefers-reduced-motion:reduce){.primary{transition:none}}
  </style>
</head>
<body>
  <main class="page">
    <div class="shell">
      <div class="brand"><span class="mark" aria-hidden="true">O</span> OTTO ENTERPRISE</div>
      <section class="card">
        <header class="hero">
          <div class="eyebrow"><span class="dot"></span>${isActive ? '企业成员引入 · 5 小时有效' : '企业成员引入'}</div>
          <h1>${escapeHTML(title)}</h1>
          <p class="description">${escapeHTML(description)}</p>
        </header>
        <div class="content">
          ${isActive ? `
          <div class="code-label">企业邀请码</div>
          <div class="code" aria-label="企业邀请码">${safeCode}</div>
          <a class="primary" href="${deepLink}">打开 Otto</a>
          <div class="help">
            <strong>如果按钮没有反应</strong>
            <ol>
              <li>确认这台设备已安装最新版 Otto。</li>
              <li>仍未安装时，请向企业管理员获取官方安装包。</li>
              <li>打开 Otto 的首次注册页，输入上方邀请码即可继续。</li>
            </ol>
          </div>` : `
          <div class="status" aria-hidden="true">!</div>
          <a class="secondary" href="/enterprise/health">检查 Otto 服务状态</a>`}
        </div>
      </section>
      <p class="fine">邀请码只用于加入企业，不会在此页面展示企业内部信息。</p>
    </div>
  </main>
</body>
</html>`;
}

export function sendPublicInvitePage(
  res: ServerResponse,
  status: 200 | 404 | 410,
  code?: string,
): void {
  const state: PublicInvitePageState = status === 200
    ? 'active'
    : status === 410 ? 'unavailable' : 'not-found';
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  res.end(renderPublicInvitePage(state, status === 200 ? code : undefined));
}
