/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DataGovernanceAccount, PrivacyDeletionReceipt } from './dataGovernanceRepository.js';
import {
  requireCurrentLegalDocumentReferences,
  type LegalDocumentReference,
  type LegalDocumentSection,
} from './legalDocuments.js';

export interface DataGovernanceRouteServices {
  getDataGovernanceProfile(account?: DataGovernanceAccount | null): unknown;
  recordCurrentLegalConsent(
    account: DataGovernanceAccount,
    source: 'settings',
    documents: readonly LegalDocumentReference[],
  ): void;
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

export function escapeLegalHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function renderLegalSection(section: LegalDocumentSection): string {
  const paragraphs = section.paragraphs
    .map((paragraph) => `<p>${escapeLegalHtml(paragraph)}</p>`)
    .join('');
  const items = section.items?.length
    ? `<ul>${section.items.map((item) => `<li>${escapeLegalHtml(item)}</li>`).join('')}</ul>`
    : '';
  return `<section id="${escapeLegalHtml(section.id)}"${section.important ? ' class="important"' : ''}>
    <h3>${escapeLegalHtml(section.title)}</h3>${paragraphs}${items}</section>`;
}

export function renderLegalPageHtml(
  profile: ReturnType<DataGovernanceRouteServices['getDataGovernanceProfile']>,
): string {
  const data = profile as {
    controller: { name: string; privacyContact: string; configured: boolean };
    readiness: { configured: boolean; warnings: string[] };
    documents: Array<{
      id: 'terms' | 'privacy';
      title: string;
      version: string;
      effectiveAt: string;
      hash: string;
      sections: LegalDocumentSection[];
    }>;
  };
  const navigation = data.documents
    .map((document) => `<a href="#document-${escapeLegalHtml(document.id)}">${escapeLegalHtml(document.title)}</a>`)
    .join('');
  const documents = data.documents.map((document) => `
    <article id="document-${escapeLegalHtml(document.id)}">
      <header><h2>${escapeLegalHtml(document.title)}</h2>
      <p class="meta">版本 ${escapeLegalHtml(document.version)} · 生效日期 ${escapeLegalHtml(document.effectiveAt)} · 正文 SHA-256 <code>${escapeLegalHtml(document.hash)}</code></p></header>
      ${document.sections.map(renderLegalSection).join('')}
    </article>`).join('');
  const readiness = data.readiness.configured
    ? '<p class="ready">部署主体与安全配置已声明；正式使用前仍应由实际部署方完成法务确认。</p>'
    : `<div class="warning"><strong>法律交付尚未就绪</strong><ul>${data.readiness.warnings.map((warning) => `<li>${escapeLegalHtml(warning)}</li>`).join('')}</ul></div>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>Otto 用户协议与隐私规则</title>
  <style>:root{color-scheme:light}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f3f6f4;color:#17211d;font:15px/1.8 system-ui,"Microsoft YaHei",sans-serif}.wrap{max-width:960px;margin:auto;padding:36px 22px 80px}.hero{padding:26px;background:#173e32;color:#fff;border-radius:14px}.hero h1{font-size:30px;margin:0 0 8px}.hero p{margin:4px 0;color:#dbe9e4}.contact{margin-top:16px;padding:14px 16px;background:#fff;color:#17211d;border-radius:9px}.ready{padding:12px 15px;background:#e7f2ec;border-left:4px solid #176a4b}.warning{padding:14px 16px;background:#fff1e8;border:1px solid #e59662;border-radius:9px;color:#6e2c08}.warning ul{margin-bottom:0}nav{position:sticky;top:0;display:flex;gap:12px;padding:14px 0;background:#f3f6f4;z-index:2}nav a{color:#176a4b;font-weight:700}article{margin-top:18px;padding:26px;background:#fff;border:1px solid #d8e0dc;border-radius:12px}article>header{padding-bottom:16px;border-bottom:1px solid #e1e7e4}h2{font-size:23px;margin:0}h3{font-size:17px;margin:0 0 8px}section{margin-top:22px;scroll-margin-top:70px}section p{margin:8px 0}section.important{padding:16px;border-left:4px solid #b64b32;background:#fff7f4}.meta{color:#66716c;font-size:13px;overflow-wrap:anywhere}code{font-size:12px}li+li{margin-top:6px}.save{margin-top:20px;color:#66716c;font-size:13px}@media print{body{background:#fff}.wrap{max-width:none;padding:0}.hero{color:#000;background:#fff;border:1px solid #aaa}nav,.save{display:none}article{break-before:page;border:0;padding:0}.important{border:1px solid #777!important}}</style>
  </head><body><main class="wrap"><header class="hero"><h1>Otto 用户协议与隐私规则</h1><p>注册或确认前请完整阅读。与您有重大利害关系的条款以醒目区块显示。</p>
  <div class="contact"><strong>个人信息处理者：</strong>${escapeLegalHtml(data.controller.name)}<br><strong>隐私联系人：</strong>${escapeLegalHtml(data.controller.privacyContact)}</div></header>
  ${readiness}<nav aria-label="法律文档目录">${navigation}</nav>${documents}
  <p class="save">本页为静态完整正文，可使用浏览器的“打印”功能保存为 PDF。系统记录的同意凭据包含上方显示的版本与正文 SHA-256。</p>
  </main></body></html>`;
}

export function sendLegalPage(res: ServerResponse, profile: ReturnType<DataGovernanceRouteServices['getDataGovernanceProfile']>): void {
  const html = renderLegalPageHtml(profile);
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
    try {
      const documents = requireCurrentLegalDocumentReferences(body.documents);
      services.recordCurrentLegalConsent(memberAccount!, 'settings', documents);
    } catch (error) {
      sendJSON(res, 409, {
        error: error instanceof Error ? error.message : '协议版本校验失败',
      });
      return true;
    }
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
