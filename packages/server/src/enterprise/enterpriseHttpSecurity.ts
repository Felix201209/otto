import type { IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import * as db from './db.js';

export interface PasswordLoginRateLimitOptions {
  maxFailures?: number;
  /** 单个客户端 IP 在窗口内跨账号失败的上限，防 identifier 轮换式密码喷洒。 */
  maxIpFailures?: number;
  windowMs?: number;
  blockMs?: number;
  maxEntries?: number;
  /**
   * 仅在明确知道前方有多少层可信反向代理时设置。1 表示 Caddy 直连本服务；
   * 服务会从 X-Forwarded-For 右侧按跳数取真实客户端，默认 0 完全忽略该 header。
   */
  trustedProxyHops?: number;
  /**
   * 允许提供 X-Forwarded-For 的直连代理 IP（仅支持精确 IP）。
   * loopback 代理始终可信；其他来源必须列在这里或 OTTO_ENTERPRISE_TRUSTED_PROXIES。
   */
  trustedProxyAddresses?: string[];
  now?: () => number;
}

export interface EnterpriseProxyOptions {
  trustedProxyHops?: number;
  trustedProxyAddresses?: readonly string[];
}

export interface LoginRateLimiter {
  keys(
    req: IncomingMessage,
    identifier: string,
  ): {
    identity: string;
    client: string;
  };
  retryAfterSeconds(keys: { identity: string; client: string }): number;
  recordFailure(keys: { identity: string; client: string }): number;
  clearIdentity(key: string): void;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || value == null || value <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

export function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || value == null || value < 0) return fallback;
  return Math.min(maximum, Math.floor(value));
}

function normalizedIp(value: string): string | null {
  const normalized = value.trim().replace(/^::ffff:/, '');
  return isIP(normalized) ? normalized : null;
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1';
}

/**
 * 解析用于登录限流的客户端 IP。默认完全忽略 XFF；即便配置了可信跳数，也只有
 * loopback 或明确列出的直连代理可以提供该 header，格式有歧义时一律回落直连地址。
 */
export function resolveEnterpriseClientAddress(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  options: EnterpriseProxyOptions = {},
): string {
  const direct = normalizedIp(remoteAddress || '') || 'unknown';
  const trustedProxyHops = nonNegativeInteger(options.trustedProxyHops, 0, 5);
  if (trustedProxyHops === 0) return direct;

  const trustedProxyAddresses = new Set(
    (options.trustedProxyAddresses ?? [])
      .map((address) => normalizedIp(address))
      .filter((address): address is string => address !== null),
  );
  if (!isLoopbackAddress(direct) && !trustedProxyAddresses.has(direct))
    return direct;
  if (typeof forwardedFor !== 'string' || forwardedFor.length > 2048)
    return direct;

  const forwardedChain = forwardedFor
    .split(',')
    .map((address) => normalizedIp(address));
  if (
    forwardedChain.length === 0 ||
    forwardedChain.some((address) => address === null)
  ) {
    return direct;
  }
  const chain = [...(forwardedChain as string[]), direct];
  const candidateIndex = chain.length - trustedProxyHops - 1;
  if (candidateIndex < 0) return direct;
  return chain[candidateIndex] || direct;
}

function rateLimitClientAddress(
  req: IncomingMessage,
  options: EnterpriseProxyOptions,
): string {
  return resolveEnterpriseClientAddress(
    req.socket.remoteAddress,
    req.headers['x-forwarded-for'],
    options,
  );
}

/**
 * 每个 EnterpriseServer 实例独立的有界登录限流器。键只保留 identifier + 客户端地址
 * 的 SHA-256，不在内存中保存明文账号；超过上限按 LRU 淘汰，避免攻击者撑爆进程。
 */
export function createLoginRateLimiter(
  options: PasswordLoginRateLimitOptions = {},
): LoginRateLimiter {
  const maxFailures = positiveInteger(options.maxFailures, 5, 100);
  const maxIpFailures = positiveInteger(options.maxIpFailures, 30, 1_000);
  const windowMs = positiveInteger(
    options.windowMs,
    15 * 60 * 1000,
    24 * 60 * 60 * 1000,
  );
  const blockMs = positiveInteger(
    options.blockMs,
    60 * 1000,
    24 * 60 * 60 * 1000,
  );
  const maxEntries = positiveInteger(options.maxEntries, 10_000, 100_000);
  const trustedProxyHops = nonNegativeInteger(options.trustedProxyHops, 0, 5);
  const trustedProxyAddresses = options.trustedProxyAddresses ?? [];
  const now = options.now ?? Date.now;
  type RateEntry = {
    failures: number;
    windowStartedAt: number;
    blockedUntil: number;
  };
  const identityEntries = new Map<string, RateEntry>();
  const clientEntries = new Map<string, RateEntry>();

  const touch = (
    entries: Map<string, RateEntry>,
    key: string,
    entry: RateEntry,
  ): void => {
    entries.delete(key);
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value as string | undefined;
      if (!oldest) break;
      entries.delete(oldest);
    }
    entries.set(key, entry);
  };

  const currentEntryIn = (
    entries: Map<string, RateEntry>,
    key: string,
    timestamp: number,
  ): RateEntry | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (
      entry.blockedUntil <= timestamp &&
      timestamp - entry.windowStartedAt >= windowMs
    ) {
      entries.delete(key);
      return null;
    }
    touch(entries, key, entry);
    return entry;
  };

  const retryAfterFor = (
    entries: Map<string, RateEntry>,
    key: string,
    timestamp: number,
  ): number => {
    const entry = currentEntryIn(entries, key, timestamp);
    return entry && entry.blockedUntil > timestamp
      ? Math.max(1, Math.ceil((entry.blockedUntil - timestamp) / 1000))
      : 0;
  };

  const recordFailureFor = (
    entries: Map<string, RateEntry>,
    key: string,
    threshold: number,
    timestamp: number,
  ): number => {
    const existing = currentEntryIn(entries, key, timestamp);
    const entry =
      existing && timestamp - existing.windowStartedAt < windowMs
        ? existing
        : { failures: 0, windowStartedAt: timestamp, blockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= threshold) entry.blockedUntil = timestamp + blockMs;
    touch(entries, key, entry);
    return entry.blockedUntil > timestamp
      ? Math.max(1, Math.ceil((entry.blockedUntil - timestamp) / 1000))
      : 0;
  };

  return {
    keys(req, identifier) {
      const clientAddress = rateLimitClientAddress(req, {
        trustedProxyHops,
        trustedProxyAddresses,
      });
      let normalizedIdentifier = identifier.trim().toLocaleLowerCase('en-US');
      try {
        // 登录接受带空格、连字符或 +86 的手机号，限流键必须采用相同归一化，
        // 否则攻击者可仅改变展示格式绕过失败计数。
        normalizedIdentifier = db.normalizePhone(identifier);
      } catch {
        // 非手机号继续按大小写无关的用户名计数。
      }
      const identity = createHash('sha256')
        .update(`${normalizedIdentifier}\0${clientAddress}`)
        .digest('base64url');
      const client = createHash('sha256')
        .update(`client\0${clientAddress}`)
        .digest('base64url');
      return { identity, client };
    },
    retryAfterSeconds(keys) {
      const timestamp = now();
      return Math.max(
        retryAfterFor(identityEntries, keys.identity, timestamp),
        retryAfterFor(clientEntries, keys.client, timestamp),
      );
    },
    recordFailure(keys) {
      const timestamp = now();
      return Math.max(
        recordFailureFor(
          identityEntries,
          keys.identity,
          maxFailures,
          timestamp,
        ),
        recordFailureFor(clientEntries, keys.client, maxIpFailures, timestamp),
      );
    },
    clearIdentity(key) {
      identityEntries.delete(key);
    },
  };
}

/** 管理令牌只允许放在 header；URL query 会进入代理日志与浏览器历史，禁止使用。 */
export function extractToken(req: IncomingMessage): string {
  const h = req.headers['x-otto-admin-token'];
  if (typeof h === 'string' && h) return h;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer '))
    return auth.slice(7);
  return '';
}

export function tokensMatch(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function licenseBlockedPayload() {
  const status = db.getPrivateDeploymentStatus();
  return {
    error: 'deployment license is not active',
    license: status.license,
    allowed: ['login', 'license update', 'data export', 'diagnostics'],
  };
}

export function isCrossOriginBrowserRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  const host = req.headers.host;
  if (typeof host !== 'string' || !host) return true;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export function isLoopbackRequestHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string' || !host.trim()) return false;
  try {
    const parsed = new URL(`http://${host}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return (
      hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
    );
  } catch {
    return false;
  }
}
