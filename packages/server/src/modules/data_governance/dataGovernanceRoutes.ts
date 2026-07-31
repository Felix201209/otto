/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DataGovernanceAccount, PrivacyDeletionReceipt } from './dataGovernanceRepository.js';

export interface DataGovernanceRouteServices {
  getDataGovernanceProfile(account?: DataGovernanceAccount | null): unknown;
  recordCurrentLegalConsent(account: DataGovernanceAccount, source: 'settings'): void;
  exportAccountData(account: DataGovernanceAccount): unknown;
  deleteOwnAccountData(account: DataGovernanceAccount): PrivacyDeletionReceipt;
  authenticateAccount(identifier: string, password: string): DataGovernanceAccount | null;
  getPrivateDeploymentStatus(): {
    deploymentId: string;
    license: {
      status: string; plan: string; expiresAt: string; seatLimit: number;
      activeSeatCount: number; modules: string[]; offline: boolean; enforce: boolean;
    };
    telemetry: { enabled: boolean; contentMode: string };
    dataBoundary: Record<string, unknown>;
  };
}

function profileWithAuthorization(services: DataGovernanceRouteServices, account: DataGovernanceAccount) {
  const deployment = services.getPrivateDeploymentStatus();
  return {
    ...(services.getDataGovernanceProfile(account) as Record<string, unknown>),
    authorization: {
      deploymentId: deployment.deploymentId,
      license: deployment.license,
      telemetry: deployment.telemetry,
      dataBoundary: deployment.dataBoundary,
    },
  };
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function sendLegalPage(res: ServerResponse, profile: ReturnType<DataGovernanceRouteServices['getDataGovernanceProfile']>): void {
  const data = profile as {
    controller: { name: string; privacyContact: string };
    documents: Array<{ title: string; version: string; effectiveAt: string; summary: string[] }>;
  };
  const sections = data.documents.map((document) => `
    <section><h2>${escapeHtml(document.title)}</h2>
    <p class="meta">版本 ${escapeHtml(document.version)} · 生效日期 ${escapeHtml(document.effectiveAt)}</p>
    <ul>${document.summary.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>
  `).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>Otto 用户协议与隐私规则</title>
  <style>body{margin:0;background:#f3f6f4;color:#17211d;font:15px/1.75 system-ui,"Microsoft YaHei",sans-serif}.wrap{max-width:860px;margin:auto;padding:40px 22px 72px}h1{font-size:30px;margin:0 0 8px}header p,.meta{color:#66716c}section{margin-top:18px;padding:22px;background:#fff;border:1px solid #d8e0dc;border-radius:8px}h2{font-size:19px;margin:0}li+li{margin-top:7px}.contact{margin-top:22px;padding:15px;border-left:4px solid #176a4b;background:#e7f2ec}</style>
  </head><body><main class="wrap"><header><h1>Otto 用户协议与隐私规则</h1><p>注册前请完整阅读。部署方应结合实际业务和法务意见补充正式条款。</p></header>${sections}
  <div class="contact"><strong>个人信息处理者：</strong>${escapeHtml(data.controller.name)}<br><strong>隐私联系人：</strong>${escapeHtml(data.controller.privacyContact)}</div>
  </main></body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(html);
}

export async function handleDataGovernanceRoute(input: {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: DataGovernanceAccount | null;
  services: DataGovernanceRouteServices;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}): Promise<boolean> {
  const { path, method, req, res, memberAccount, services, readBody, sendJSON } = input;
  if (path === '/enterprise/legal' && method === 'GET') {
    const profile = services.getDataGovernanceProfile(null);
    if ((req.headers.accept || '').includes('text/html')) sendLegalPage(res, profile);
    else sendJSON(res, 200, profile);
    return true;
  }
  if (path === '/enterprise/privacy' && method === 'GET') {
    sendJSON(res, 200, profileWithAuthorization(services, memberAccount!));
    return true;
  }
  if (path === '/enterprise/privacy/accept' && method === 'POST') {
    const body = await readBody(req);
    if (body.accepted !== true) {
      sendJSON(res, 400, { error: '请明确同意当前用户协议和隐私规则' });
      return true;
    }
    services.recordCurrentLegalConsent(memberAccount!, 'settings');
    sendJSON(res, 200, profileWithAuthorization(services, memberAccount!));
    return true;
  }
  if (path === '/enterprise/privacy/export' && method === 'GET') {
    sendJSON(res, 200, services.exportAccountData(memberAccount!));
    return true;
  }
  if (path === '/enterprise/privacy/account' && method === 'DELETE') {
    const body = await readBody(req);
    const password = typeof body.password === 'string' ? body.password : '';
    if (body.confirmation !== '注销我的 Otto 账号' || !password) {
      sendJSON(res, 400, { error: '请输入登录密码，并完整填写注销确认文字' });
      return true;
    }
    const verified = services.authenticateAccount(memberAccount!.username, password);
    if (!verified || verified.id !== memberAccount!.id) {
      sendJSON(res, 403, { error: '登录密码不正确' });
      return true;
    }
    try {
      sendJSON(res, 200, services.deleteOwnAccountData(memberAccount!));
    } catch (error) {
      const message = error instanceof Error ? error.message : '账号注销失败';
      sendJSON(res, message === '企业至少需要保留一名可登录管理员' ? 409 : 400, { error: message });
    }
    return true;
  }
  return false;
}
