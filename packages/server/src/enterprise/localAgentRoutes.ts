/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sendLocalAgentPage } from './localAgentPage.js';

interface PairingTokenRecord {
  instanceId: string;
  expiresAt: number;
  createdAt: number;
}

interface LocalAgentRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

/** 内存中的配对令牌存储（服务重启后自动失效）。 */
const pairingTokens = new Map<string, PairingTokenRecord>();

export async function handleLocalAgentRoute({
  path,
  method,
  req,
  res,
  readBody,
  sendJSON,
}: LocalAgentRouteDeps): Promise<boolean> {
  if (path === '/enterprise/sdk/otto-discovery.js' && method === 'GET') {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const sdkPath = pathJoin(__dirname, 'public', 'otto-discovery.js');
      const sdkContent = readFileSync(sdkPath, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(sdkContent);
    } catch {
      sendJSON(res, 404, { error: 'sdk not found' });
    }
    return true;
  }

  if (path === '/enterprise/local-agent' && method === 'GET') {
    sendLocalAgentPage(res);
    return true;
  }

  if (path === '/enterprise/local-agent/pair' && method === 'POST') {
    const body = await readBody(req);
    const instanceId = typeof body.instanceId === 'string' ? body.instanceId : '';
    if (!instanceId) {
      sendJSON(res, 400, { ok: false, error: 'missing instanceId' });
      return true;
    }

    const token = randomBytes(3).toString('hex').toUpperCase();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    pairingTokens.set(token, { instanceId, expiresAt, createdAt: Date.now() });
    sendJSON(res, 200, {
      ok: true,
      data: {
        token,
        expiresIn: 300,
        instructions: '请在 Otto 桌面端中输入此令牌完成接入',
      },
    });
    return true;
  }

  if (path === '/enterprise/local-agent/pair/verify' && method === 'POST') {
    const body = await readBody(req);
    const token = (typeof body.token === 'string' ? body.token : '').toUpperCase();
    if (!token || !pairingTokens.has(token)) {
      sendJSON(res, 400, { ok: false, error: '令牌无效或已过期' });
      return true;
    }

    const record = pairingTokens.get(token)!;
    if (Date.now() > record.expiresAt) {
      pairingTokens.delete(token);
      sendJSON(res, 400, { ok: false, error: '令牌已过期' });
      return true;
    }

    pairingTokens.delete(token);
    sendJSON(res, 200, {
      ok: true,
      data: {
        verified: true,
        instanceId: record.instanceId,
        message: '配对令牌验证成功',
      },
    });
    return true;
  }

  return false;
}
