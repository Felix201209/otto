/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * 代理服务器配置模块
 * 硬编码代理服务器地址，用户无需配置任何环境变量
 */

export interface ProxyServerConfig {
  url: string;
  name: string;
  region: string;
  status: 'active' | 'maintenance' | 'deprecated';
}

export const MANAGED_MODEL_SERVICE_UNAVAILABLE =
  '企业模型服务尚未配置，请联系企业管理员。';
export const MANAGED_MODEL_SERVICE_INVALID =
  '企业模型服务地址无效，请联系企业管理员。';

/** 只有完整的 http(s) 地址才算已配置，空串和相对路径都不可交给 Node fetch。 */
export function isProxyServerConfigured(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * 构造 Otto 托管服务的绝对请求地址，并在 fetch 前把配置错误转成用户可读信息。
 * 所有托管聊天/图片/计数请求共用这一道闸门，避免再次出现 `/v1/...` 相对 URL。
 */
export function buildProxyRequestUrl(
  baseUrl: string | undefined,
  endpoint: string,
): string {
  const base = baseUrl?.trim();
  if (!base) throw new Error(MANAGED_MODEL_SERVICE_UNAVAILABLE);
  if (!isProxyServerConfigured(base)) {
    throw new Error(MANAGED_MODEL_SERVICE_INVALID);
  }
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * 获取代理服务器列表（按优先级排序）
 * 用户无需配置，系统自动选择可用的服务器
 * 动态获取以确保环境变量正确加载
 */
export function getProxyServers(): ProxyServerConfig[] {
  return [
    {
      // BYO-key: 未配置 OTTO_SERVER_URL 时为空字符串，调用方需自行跳过网络请求。
      url: process.env.OTTO_SERVER_URL || '',
      name: 'Primary Development Server',
      region: 'default',
      status: 'active',
    },
    // 可以在这里添加更多备用服务器
    // {
    //   url: 'https://proxy.your-domain.com',
    //   name: 'Production Server',
    //   region: 'production',
    //   status: 'active',
    // },
  ];
}

/**
 * 获取可用的代理服务器URL
 * 按优先级返回第一个活跃的服务器
 */
export function getActiveProxyServerUrl(): string {
  const proxyServers = getProxyServers();
  const activeServer = proxyServers.find(server => server.status === 'active');

  if (!activeServer) {
    throw new Error(
      'No active proxy server available. Please contact support.'
    );
  }

  return activeServer.url;
}

/**
 * 获取所有可用的代理服务器
 */
export function getAvailableProxyServers(): ProxyServerConfig[] {
  const proxyServers = getProxyServers();
  return proxyServers.filter(server => server.status === 'active');
}

/**
 * 检查是否有可用的代理服务器
 */
export function hasAvailableProxyServer(): boolean {
  const proxyServers = getProxyServers();
  return proxyServers.some(server => server.status === 'active');
}

/**
 * 获取代理服务器配置信息
 */
export function getProxyServerInfo(url: string): ProxyServerConfig | undefined {
  const proxyServers = getProxyServers();
  return proxyServers.find(server => server.url === url);
}

/**
 * 默认的代理服务器配置
 * 这个配置会在运行时自动使用，用户无需手动配置
 */
export const DEFAULT_PROXY_CONFIG = {
  serverUrl: getActiveProxyServerUrl(),
  timeout: 200000, // 200秒超时
  retryAttempts: 3,
  retryDelay: 1000, // 1秒重试延迟
};
