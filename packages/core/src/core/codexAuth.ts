/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CodexAuthManager — 复用本机 Codex CLI 的凭证(~/.codex/auth.json),
 * 让自定义模型可以用 Codex 的 ChatGPT 订阅 OAuth 或 API Key 调用模型。
 *
 * 实测验证(2026-06-14,见 scripts 探针):
 *   - OAuth 调用端点:POST https://chatgpt.com/backend-api/codex/responses
 *   - 鉴权头:Authorization: Bearer <access_token> + chatgpt-account-id: <account_id>
 *   - 刷新端点:POST https://auth.openai.com/oauth/token
 *     client_id=app_EMoamEEZ73f0CkXaXp7hrann (来自 access_token 的 client_id claim)
 *   - 请求体强制:instructions / input(list) / store:false / stream:true
 *
 * 设计借鉴 proxyAuth.ts 的 ProxyAuthManager:单例 + 单飞刷新(refreshPromise)
 * 防并发刷新风暴 + 近过期阈值检测。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** access_token 距过期小于该阈值(毫秒)则尝试刷新。Codex token 默认有效约 9 天。 */
const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 1 天

interface CodexTokens {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  account_id?: string;
}

interface CodexAuthFile {
  auth_mode?: string;
  // codex login --api-key 时存裸字符串;某些版本存对象;未设置为 null。
  OPENAI_API_KEY?: string | { api_key?: string; key?: string; value?: string } | null;
  tokens?: CodexTokens;
  last_refresh?: string;
}

export interface CodexAuthHeaders {
  Authorization: string;
  'chatgpt-account-id'?: string;
}

/** 解码 JWT payload(不校验签名),取 exp(秒)。失败返回 undefined。 */
function jwtExpMs(token: string): number | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString('utf8'),
    ) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function extractApiKey(
  raw: CodexAuthFile['OPENAI_API_KEY'],
): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') return raw.trim() || undefined;
  return raw.api_key || raw.key || raw.value || undefined;
}

export class CodexAuthManager {
  private static instance: CodexAuthManager | null = null;
  private refreshPromise: Promise<string> | null = null;

  static getInstance(): CodexAuthManager {
    if (!CodexAuthManager.instance) {
      CodexAuthManager.instance = new CodexAuthManager();
    }
    return CodexAuthManager.instance;
  }

  /** Codex 凭证文件是否存在(供调用方做能力判断)。 */
  static isAvailable(): boolean {
    return fs.existsSync(CODEX_AUTH_PATH);
  }

  private read(): CodexAuthFile {
    try {
      return JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, 'utf8')) as CodexAuthFile;
    } catch (error) {
      throw new Error(
        `[CodexAuth] 无法读取 ${CODEX_AUTH_PATH}:${
          error instanceof Error ? error.message : String(error)
        }。请先用 codex login 登录。`,
      );
    }
  }

  /**
   * 产出调用模型用的鉴权头。
   * - API Key 模式(auth_mode==='apikey' 且有 OPENAI_API_KEY):Bearer <key>,最简、无刷新。
   * - OAuth 模式:Bearer <access_token>(近过期自动刷新)+ chatgpt-account-id。
   */
  async getAuthHeaders(): Promise<CodexAuthHeaders> {
    const data = this.read();
    const apiKey = extractApiKey(data.OPENAI_API_KEY);

    if (data.auth_mode === 'apikey' || (apiKey && !data.tokens)) {
      if (!apiKey) {
        throw new Error('[CodexAuth] auth_mode=apikey 但未找到 OPENAI_API_KEY。');
      }
      return { Authorization: `Bearer ${apiKey}` };
    }

    if (!data.tokens?.access_token) {
      throw new Error('[CodexAuth] 未找到 OAuth tokens.access_token,请用 codex login 登录。');
    }

    const token = await this.getValidAccessToken(data);
    const headers: CodexAuthHeaders = { Authorization: `Bearer ${token}` };
    if (data.tokens.account_id) {
      headers['chatgpt-account-id'] = data.tokens.account_id;
    }
    return headers;
  }

  /** 近过期则刷新,否则直接返回当前 access_token。 */
  private async getValidAccessToken(data: CodexAuthFile): Promise<string> {
    const token = data.tokens!.access_token;
    const expMs = jwtExpMs(token);
    const nearExpiry = expMs !== undefined && expMs - Date.now() < REFRESH_THRESHOLD_MS;

    if (!nearExpiry || !data.tokens?.refresh_token) {
      return token;
    }
    return this.refresh(data.tokens.refresh_token);
  }

  /** 单飞刷新:并发调用复用同一个 Promise,避免刷新风暴(借 proxyAuth 模式)。 */
  private refresh(refreshToken: string): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh(refreshToken).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(refreshToken: string): Promise<string> {
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CODEX_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`[CodexAuth] token 刷新失败 ${resp.status}: ${text.slice(0, 200)}`);
    }

    const json = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
    };
    if (!json.access_token) {
      throw new Error('[CodexAuth] 刷新响应缺少 access_token。');
    }

    // 写回 ~/.codex/auth.json(保留 Codex 官方文件格式,与 Codex CLI 共用凭证)。
    try {
      const current = this.read();
      current.tokens = {
        ...current.tokens,
        access_token: json.access_token,
        refresh_token: json.refresh_token || current.tokens?.refresh_token,
        id_token: json.id_token || current.tokens?.id_token,
      } as CodexTokens;
      current.last_refresh = new Date().toISOString();
      await fsp.writeFile(CODEX_AUTH_PATH, JSON.stringify(current, null, 2), {
        mode: 0o600,
      });
    } catch {
      // 写回失败不阻断本次调用:本次用新 token,下次再尝试刷新。
    }

    return json.access_token;
  }
}
