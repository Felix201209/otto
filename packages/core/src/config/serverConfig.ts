/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * 服务端配置获取模块
 * 从DeepX_Code_server获取客户端所需的配置信息
 */

import { getUserAgent } from '../utils/userAgent.js';

export interface FeishuTenantInfo {
  appId: string;
  label: string;
  tenantKey: string;
}

export interface ServerClientConfig {
  feishu: {
    appId: string;
    // appSecret 不再暴露给客户端
  };
  feishuTenants?: FeishuTenantInfo[];
  server: {
    version: string;
    environment: string;
  };
}

export interface ConfigResponse {
  success: boolean;
  data?: ServerClientConfig;
  error?: string;
  timestamp: string;
}

/**
 * 配置获取器类
 */
export class ServerConfigFetcher {
  private static instance: ServerConfigFetcher;
  private cachedConfig: ServerClientConfig | null = null;
  private cacheExpiry: Date | null = null;

  // 默认服务器地址，可以通过环境变量覆盖
  private getServerBaseUrl(): string {
    return process.env.DEEPX_SERVER_URL || 'https://api-code.deepvlab.ai';
  }

  private constructor() {
    // 构造函数中不需要设置serverBaseUrl，因为它是通过getServerBaseUrl()方法获取的
  }

  /**
   * 获取单例实例。
   */
  public static getInstance(): ServerConfigFetcher {
    if (!ServerConfigFetcher.instance) {
      ServerConfigFetcher.instance = new ServerConfigFetcher();
    }
    return ServerConfigFetcher.instance;
  }

  /**
   * 从服务端获取配置（带缓存）
   * 缓存时间：5分钟
   */
  public async getConfig(): Promise<ServerClientConfig> {
    const now = new Date();

    // 检查缓存是否仍然有效
    if (this.cachedConfig && this.cacheExpiry && this.cacheExpiry > now) {
      console.log('🔄 使用缓存的服务端配置');
      return this.cachedConfig;
    }

    try {

      const response = await fetch(`${this.getServerBaseUrl()}/api/config/client`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getUserAgent(),
        },
        // 超时设置
        signal: AbortSignal.timeout(10000), // 10秒超时
      });

      if (!response.ok) {
        throw new Error(`服务端配置获取失败: ${response.status} ${response.statusText}`);
      }

      const result: ConfigResponse = await response.json();

      if (!result.success || !result.data) {
        throw new Error(`服务端配置格式错误: ${result.error || 'Unknown error'}`);
      }

      // 缓存配置（5分钟）
      this.cachedConfig = result.data;
      this.cacheExpiry = new Date(now.getTime() + 5 * 60 * 1000);

      return result.data;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('❌ 获取服务端配置失败:', errorMessage);

      // 如果有缓存配置，使用过期的缓存配置作为备份
      if (this.cachedConfig) {
        console.warn('⚠️ 使用过期的缓存配置作为备份');
        return this.cachedConfig;
      }

      throw new Error(`无法获取服务端配置: ${errorMessage}`);
    }
  }

  /**
   * 获取飞书配置（默认租户）
   */
  public async getFeishuConfig(): Promise<{ appId: string }> {
    const config = await this.getConfig();
    return { appId: config.feishu.appId };
  }

  /**
   * 获取所有飞书租户列表
   */
  public async getFeishuTenants(): Promise<FeishuTenantInfo[]> {
    const config = await this.getConfig();
    return config.feishuTenants || [{ appId: config.feishu.appId, label: '飞书登录', tenantKey: 'main' }];
  }

  /**
   * 清除缓存配置
   */
  public clearCache(): void {
    this.cachedConfig = null;
    this.cacheExpiry = null;
    console.log('🔄 配置缓存已清除');
  }

  /**
   * 测试服务端连接
   */
  public async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getServerBaseUrl()}/api/config/feishu/health`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000), // 5秒超时
      });

      return response.ok;
    } catch (error) {
      console.error('❌ 服务端连接测试失败:', error);
      return false;
    }
  }
}

/**
 * 便捷函数：获取服务端配置
 */
export async function getServerConfig(): Promise<ServerClientConfig> {
  const fetcher = ServerConfigFetcher.getInstance();
  return fetcher.getConfig();
}

/**
 * 便捷函数：获取飞书配置
 */
export async function getFeishuConfigFromServer(): Promise<{ appId: string }> {
  const fetcher = ServerConfigFetcher.getInstance();
  return fetcher.getFeishuConfig();
}

/**
 * 便捷函数：获取飞书租户列表
 */
export async function getFeishuTenantsFromServer(): Promise<FeishuTenantInfo[]> {
  const fetcher = ServerConfigFetcher.getInstance();
  return fetcher.getFeishuTenants();
}

/**
 * 便捷函数：测试服务端连接
 */
export async function testServerConnection(): Promise<boolean> {
  const fetcher = ServerConfigFetcher.getInstance();
  return fetcher.testConnection();
}