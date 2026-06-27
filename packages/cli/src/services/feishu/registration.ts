/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 档 1 — 扫码自动建应用（飞书私有 device-code 注册流）
 *
 * 调飞书 accounts.feishu.cn 的 /oauth/v1/app/registration 端点，
 * 三步走：init → begin（返回二维码 URL）→ poll（等用户扫码）。
 * 用户扫码后飞书自动创建一个 PersonalAgent 类型的应用，
 * 返回 app_id + app_secret。
 *
 * ⚠ 此协议未在公开文档中说明，飞书可能任意更改/下线。
 * 如失败请改用档 3（手动输入 app_id/app_secret）。
 *
 * 移植自 easyagent feishu_setup.py 档 1。
 */

const ACCOUNTS_URLS: Record<string, string> = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
};

const REGISTRATION_PATH = '/oauth/v1/app/registration';
const TP_TAG = 'otto';

type RegistrationResponse = Record<string, unknown>;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asOptionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export interface BeginResult {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expireIn: number;
}

export interface PollResult {
  appId: string;
  appSecret: string;
  domain: string;
  openId?: string;
}

async function postRegistration(
  baseUrl: string,
  body: Record<string, string>,
): Promise<RegistrationResponse> {
  const url = `${baseUrl}${REGISTRATION_PATH}`;
  const formData = new URLSearchParams(body).toString();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData,
  });

  // 即使 4xx 也尝试解析 JSON（poll 阶段 authorization_pending 走 400）
  const text = await response.text();
  try {
    return asObject(JSON.parse(text));
  } catch {
    throw new Error(`Registration endpoint returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
}

/**
 * 检测注册环境是否支持 client_secret 认证
 */
export async function initRegistration(domain: string = 'feishu'): Promise<void> {
  const baseUrl = ACCOUNTS_URLS[domain] || ACCOUNTS_URLS.feishu;
  const res = await postRegistration(baseUrl, { action: 'init' });
  const methods = asStringArray(res['supported_auth_methods']);
  if (!methods.includes('client_secret')) {
    throw new Error(
      `Feishu registration env does not support client_secret auth. Supported: ${methods.join(', ')}`,
    );
  }
}

/**
 * 开始 device-code 流程，返回二维码 URL
 */
export async function beginRegistration(
  domain: string = 'feishu',
): Promise<BeginResult> {
  const baseUrl = ACCOUNTS_URLS[domain] || ACCOUNTS_URLS.feishu;
  const res = await postRegistration(baseUrl, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id tenant_brand',
  });

  const deviceCode = asString(res['device_code']);
  if (!deviceCode) {
    throw new Error('Feishu registration did not return device_code');
  }

  let qrUrl = asString(res['verification_uri_complete']) || '';
  if (qrUrl) {
    const sep = qrUrl.includes('?') ? '&' : '?';
    qrUrl = `${qrUrl}${sep}from=${TP_TAG}&tp=${TP_TAG}`;
  } else {
    // 兜底
    const openBase = domain === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
    qrUrl = `${openBase}/page/launcher?user_code=${asString(res['user_code']) || ''}&from=${TP_TAG}&tp=${TP_TAG}`;
  }

  return {
    deviceCode,
    qrUrl,
    userCode: asString(res['user_code']) || '',
    interval: typeof res['interval'] === 'number' ? res['interval'] : 5,
    expireIn:
      typeof res['expires_in'] === 'number'
        ? res['expires_in']
        : typeof res['expire_in'] === 'number'
          ? res['expire_in']
          : 600,
  };
}

/**
 * 轮询等待用户扫码
 */
export async function pollRegistration(
  deviceCode: string,
  interval: number,
  expireIn: number,
  domain: string = 'feishu',
  onProgress?: (dots: string) => void,
): Promise<PollResult | null> {
  const deadline = Date.now() + expireIn * 1000;
  let currentDomain = domain;
  let domainSwitched = false;
  let pollCount = 0;

  while (Date.now() < deadline) {
    const baseUrl = ACCOUNTS_URLS[currentDomain] || ACCOUNTS_URLS.feishu;
    let res: RegistrationResponse;
    try {
      res = await postRegistration(baseUrl, {
        action: 'poll',
        device_code: deviceCode,
      });
    } catch {
      // 网络错误继续轮询
      await sleep(interval * 1000);
      continue;
    }

    pollCount++;
    if (onProgress) {
      onProgress('.'.repeat(pollCount));
    }

    // 自动检测 domain（lark vs feishu）
    const userInfo = asObject(res['user_info']);
    const tenantBrand = asString(userInfo['tenant_brand']);
    if (tenantBrand === 'lark' && !domainSwitched) {
      currentDomain = 'lark';
      domainSwitched = true;
    }

    // 成功
    const clientId = asString(res['client_id']);
    const clientSecret = asString(res['client_secret']);
    if (clientId && clientSecret) {
      return {
        appId: clientId,
        appSecret: clientSecret,
        domain: currentDomain,
        openId: asString(userInfo['open_id']),
      };
    }

    // 用户拒绝 / 过期
    const error = asString(res['error']) || '';
    if (error === 'access_denied' || error === 'expired_token') {
      return null;
    }

    // authorization_pending — 继续轮询
    await sleep(interval * 1000);
  }

  return null; // 超时
}

/**
 * 校验凭证：
 *  1. 用 app_id / app_secret 拿 tenant_access_token
 *  2. 调 /bot/v3/info 拿 bot 名字 + open_id
 *  3. （如果应用已开通 application:application:self_manage）
 *     调 /application/v6/applications/me 拿应用已开通的 scope 列表
 *
 * 第 3 步失败不会让 probe 整体失败——它只是无法报告 grantedScopes。
 *
 * @returns null = 凭证无效；否则返回 botName/botOpenId（+ 可选 grantedScopes）
 */
export async function probeCredentials(
  appId: string,
  appSecret: string,
  domain: string = 'feishu',
): Promise<{
  botName?: string;
  botOpenId?: string;
  grantedScopes?: string[];
} | null> {
  const openBase = domain === 'lark'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';

  try {
    // 1. 拿 tenant_access_token
    const tokenRes = await fetch(`${openBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenData = asObject(await tokenRes.json());
    const accessToken = asString(tokenData['tenant_access_token']);
    if (!accessToken) return null;

    // 2. 查 bot 信息
    const botRes = await fetch(`${openBase}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const botData = asObject(await botRes.json());
    if (botData['code'] !== 0) return null;

    const bot =
      asOptionalObject(botData['bot']) ??
      asOptionalObject(asObject(botData['data'])['bot']) ??
      {};

    // 3. (best-effort) 查应用已开通的 scope 列表（需要 application:application:self_manage 权限，
    //    用户首次扫码建应用后通常没有，会 400/403——属正常情况，吞掉错误返回 undefined 即可）
    let grantedScopes: string[] | undefined;
    try {
      const scopesRes = await fetch(
        `${openBase}/open-apis/application/v6/applications/me?lang=zh_cn`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const scopesData = asObject(await scopesRes.json());
      if (scopesData['code'] === 0) {
        const data = asObject(scopesData['data']);
        const app =
          asOptionalObject(data['app']) ??
          asOptionalObject(scopesData['app']) ??
          data;
        const rawScopes: Array<{ scope?: string }> =
          (Array.isArray(app['scopes'])
            ? app['scopes']
            : Array.isArray(asObject(app['online_version'])['scopes'])
              ? asObject(app['online_version'])['scopes']
              : []) as Array<{ scope?: string }>;
        grantedScopes = rawScopes
          .map((s) => s.scope)
          .filter((s): s is string => typeof s === 'string' && s.length > 0);
      }
    } catch {
      /* 忽略——大多数情况下应用尚未开通 self_manage，是预期内的 */
    }

    return {
      botName: asString(bot['app_name']) || asString(bot['bot_name']),
      botOpenId: asString(bot['open_id']),
      grantedScopes,
    };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
