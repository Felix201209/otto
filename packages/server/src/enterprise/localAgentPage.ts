/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 本地 Agent 探测页面（/enterprise/local-agent）。
 * 经企业服务器托管，在用户浏览器中探测其本地 otto 是否运行。
 */

import type { ServerResponse } from 'node:http';

function renderLocalAgentPage(origin: string): string {
  const safeOrigin = origin.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;',
  })[c]!);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>接入本地 Otto · Otto Enterprise</title>
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
    .dot.green{background:#4ade80}
    .dot.red{background:#f87171}
    h1{max-width:390px;margin:0;font-size:clamp(30px,7vw,42px);line-height:1.08;letter-spacing:-.04em}
    .description{margin:17px 0 0;color:#c9d9d5;font-size:15px;line-height:1.75}
    .content{padding:28px 34px 34px}
    .status-row{display:flex;align-items:center;gap:14px;padding:18px 22px;border-radius:17px;background:#f7f5ef;margin-bottom:20px}
    .status-icon{width:42px;height:42px;border-radius:12px;background:#e8e4d8;display:grid;place-items:center;font-size:20px}
    .status-text{flex:1}
    .status-label{font-size:13px;font-weight:700;color:#6b7975;margin-bottom:4px}
    .status-value{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums}
    .primary{display:flex;align-items:center;justify-content:center;min-height:54px;border-radius:16px;background:#f1bd55;color:#17352f;text-decoration:none;font-size:16px;font-weight:850;box-shadow:0 7px 0 #ca9131;transition:transform .14s ease,box-shadow .14s ease;border:none;width:100%;cursor:pointer}
    .primary:not(:disabled):hover{transform:translateY(-2px);box-shadow:0 9px 0 #ca9131}
    .primary:not(:disabled):active{transform:translateY(4px);box-shadow:0 3px 0 #ca9131}
    .primary:disabled{opacity:.5;cursor:not-allowed;box-shadow:0 3px 0 #ca9131;transform:translateY(4px)}
    .fine{margin:18px 2px 0;text-align:center;color:#7c8985;font-size:12px;line-height:1.6}
    .code{display:flex;align-items:center;justify-content:center;min-height:60px;margin:18px 0;border:1px solid #d9d6ca;border-radius:14px;background:#f7f5ef;color:#173f37;font:800 22px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;user-select:all}
    .code-label{margin-top:12px;color:#6b7975;font-size:12px;font-weight:700;letter-spacing:.08em}
    .hidden{display:none!important}
    .pulse{animation:pulse 2s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
    @media(max-width:520px){.page{padding:18px 12px}.hero{padding:29px 24px 26px}.content{padding:24px}.card{border-radius:23px}}
  </style>
</head>
<body>
  <main class="page">
    <div class="shell">
      <div class="brand"><span class="mark" aria-hidden="true">O</span> OTTO ENTERPRISE</div>
      <section class="card">
        <header class="hero">
          <div class="eyebrow"><span class="dot" id="indicator-dot"></span>接入本地 Otto</div>
          <h1 id="main-title">正在检测…</h1>
          <p class="description" id="main-desc">确认你的本地 Otto 是否在运行，然后一键接入企业服务。</p>
        </header>
        <div class="content">
          <!-- 检测中 -->
          <div id="state-checking">
            <div class="status-row">
              <div class="status-icon pulse">🔍</div>
              <div class="status-text">
                <div class="status-label">状态</div>
                <div class="status-value">正在探测本地 Otto…</div>
              </div>
            </div>
          </div>

          <!-- 未检测到 -->
          <div id="state-not-found" class="hidden">
            <div class="status-row">
              <div class="status-icon">❌</div>
              <div class="status-text">
                <div class="status-label">未检测到本地 Otto</div>
                <div class="status-value">请确认 Otto 桌面端已启动</div>
              </div>
            </div>
            <button class="primary" onclick="retryDetection()">重新检测</button>
            <div class="fine">Otto 桌面端需在运行且监听 7637 端口</div>
          </div>

          <!-- 已检测到 -->
          <div id="state-found" class="hidden">
            <div class="status-row">
              <div class="status-icon">✅</div>
              <div class="status-text">
                <div class="status-label">已检测到本地 Otto</div>
                <div class="status-value">版本 <span id="otto-version">—</span> · 实例 <span id="otto-id">—</span></div>
              </div>
            </div>
            <div class="code-label">配对令牌（复制此令牌到 Otto 桌面端以完成接入）</div>
            <div class="code" id="pairing-token">—</div>
            <button class="primary" onclick="requestPairing()" id="pair-btn">生成配对令牌</button>
            <div class="fine">令牌有效期 5 分钟，请在 Otto 桌面端中输入此令牌完成接入</div>
          </div>

          <!-- 错误 -->
          <div id="state-error" class="hidden">
            <div class="status-row">
              <div class="status-icon">⚠️</div>
              <div class="status-text">
                <div class="status-label">检测失败</div>
                <div class="status-value" id="error-msg">—</div>
              </div>
            </div>
            <button class="primary" onclick="retryDetection()">重试</button>
          </div>
        </div>
      </section>
      <p class="fine">你的本地数据不会被自动上传。接入需要你主动确认。</p>
    </div>
  </main>

  <!-- Discovery SDK -->
  <script src="/enterprise/sdk/otto-discovery.js"></script>
  <script>
    var detectedInstance = null;
    var pairingToken = null;

    function showState(id) {
      ['state-checking','state-not-found','state-found','state-error'].forEach(function(s) {
        document.getElementById(s).classList.toggle('hidden', s !== id);
      });
    }

    function retryDetection() {
      showState('state-checking');
      document.getElementById('main-title').textContent = '正在检测…';
      document.getElementById('indicator-dot').className = 'dot';
      detectedInstance = null;
      pairingToken = null;
      OttoDiscovery.detect(handleResult, { force: true });
    }

    function handleResult(result) {
      if (result.found) {
        detectedInstance = result;
        showState('state-found');
        document.getElementById('main-title').textContent = '已找到本地 Otto';
        document.getElementById('main-desc').textContent = '你的本地 Otto 已就绪，生成配对令牌后即可接入企业服务。';
        document.getElementById('indicator-dot').className = 'dot green';
        document.getElementById('otto-version').textContent = result.version || '—';
        document.getElementById('otto-id').textContent = (result.instanceId || '').slice(0, 12) + '…';
      } else {
        showState('state-not-found');
        document.getElementById('main-title').textContent = '未检测到本地 Otto';
        document.getElementById('main-desc').textContent = '请确认 Otto 桌面端已在运行中。';
        document.getElementById('indicator-dot').className = 'dot red';
      }
    }

    function requestPairing() {
      var btn = document.getElementById('pair-btn');
      btn.disabled = true;
      btn.textContent = '正在生成…';

      fetch('/enterprise/local-agent/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId: detectedInstance.instanceId,
          version: detectedInstance.version,
        }),
      })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          btn.disabled = false;
          btn.textContent = '生成配对令牌';
          if (data.ok && data.data && data.data.token) {
            pairingToken = data.data.token;
            document.getElementById('pairing-token').textContent = data.data.token;
            document.getElementById('main-desc').textContent = '请在 Otto 桌面端中输入以下配对令牌完成接入。';
          } else {
            showState('state-error');
            document.getElementById('error-msg').textContent = data.error || '生成令牌失败';
          }
        })
        .catch(function(err) {
          btn.disabled = false;
          btn.textContent = '生成配对令牌';
          showState('state-error');
          document.getElementById('error-msg').textContent = err.message || String(err);
        });
    }

    // 启动探测
    OttoDiscovery.detect(handleResult);
  </script>
</body>
</html>`;
}

export function sendLocalAgentPage(res: ServerResponse): void {
  const origin = 'https://59.110.154.44:7777';
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src http://localhost:7637 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  res.end(renderLocalAgentPage(origin));
}
