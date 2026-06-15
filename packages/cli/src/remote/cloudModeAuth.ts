/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { AuthType, Config, ProxyAuthManager } from 'otto-core';
import { handleDeepvlabAuth } from '../config/auth.js';
import { LoadedSettings, SettingScope } from '../config/settings.js';
import { t, tp } from '../ui/utils/i18n.js';

/**
 * 云端模式专用认证函数
 * 复用 /auth 命令的认证流程
 */
export class CloudModeAuth {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * 检查当前认证状态
   */
  async checkAuthStatus(): Promise<boolean> {
    try {
      const proxyAuthManager = ProxyAuthManager.getInstance();

      // 检查用户信息
      const userInfo = proxyAuthManager.getUserInfo();
      if (!userInfo) {
        console.log(t('cloud.auth.not.found'));
        return false;
      }

      // 检查JWT token
      const jwtToken = await proxyAuthManager.getAccessToken();
      if (!jwtToken) {
        console.log(t('cloud.auth.token.invalid'));
        return false;
      }

      // 验证token是否有效（简单检查格式和过期时间）
      if (!this.isValidJwtToken(jwtToken)) {
        console.log('❌ JWT token格式无效或已过期');
        return false;
      }

      const { maskEmail } = await import('../utils/urlMask.js');
      const displayInfo = userInfo.email ? maskEmail(userInfo.email) : (userInfo.openId || 'N/A');
      console.log(tp('cloud.auth.user.authenticated', { name: userInfo.name, info: displayInfo }));
      return true;
    } catch (error) {
      console.error('❌ 认证状态检查失败:', error);
      return false;
    }
  }

  /**
   * 简单验证JWT token格式和过期时间
   */
  private isValidJwtToken(token: string): boolean {
    try {
      // 检查JWT格式
      const parts = token.split('.');
      if (parts.length !== 3) {
        return false;
      }

      // 解析payload
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

      // 检查过期时间
      if (payload.exp) {
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp <= now) {
          console.log('❌ JWT token已过期');
          return false;
        }
      }

      return true;
    } catch (error) {
      console.error('❌ JWT token验证失败:', error);
      return false;
    }
  }

  /**
   * 清理过期的认证信息
   */
  async clearExpiredAuth(): Promise<void> {
    try {
      const proxyAuthManager = ProxyAuthManager.getInstance();
      const jwtToken = await proxyAuthManager.getAccessToken();

      if (jwtToken && !this.isValidJwtToken(jwtToken)) {
        console.log('🧹 清理过期的认证信息...');
        // 这里可以添加清理逻辑，比如清除本地存储的token
        // proxyAuthManager.clearAuthInfo(); // 如果有这样的方法
      }
    } catch (error) {
      console.error('❌ 清理过期认证信息失败:', error);
    }
  }

  /**
   * 启动认证流程
   * 复用 /auth 命令的完整认证逻辑
   */
  async startAuthFlow(): Promise<boolean> {
    try {
      console.log(t('cloud.auth.starting'));
      console.log(t('cloud.auth.instruction'));

      // 复用 handleDeepvlabAuth 的认证逻辑
      // 注意：handleDeepvlabAuth 现在会等待用户完成认证再返回结果
      const authResult = await handleDeepvlabAuth('http://localhost:9000');

      if (authResult.success) {
        console.log(t('cloud.auth.success'));
        return true;
      } else {
        console.error('❌ 认证流程失败');
        return false;
      }
    } catch (error) {
      console.error('❌ 认证过程中发生错误:', error);
      return false;
    }
  }



  /**
   * 启动认证流程并带重试机制
   */
  async startAuthFlowWithRetry(maxRetries: number = 2): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🚀 启动认证流程 (尝试 ${attempt}/${maxRetries})...`);
        const success = await this.startAuthFlow();
        if (success) {
          return true;
        }

        if (attempt < maxRetries) {
          console.log(`⏳ 等待5秒后重试认证流程...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      } catch (error) {
        console.error(`❌ 认证流程尝试 ${attempt} 失败:`, error);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    console.error(`❌ 认证流程失败，已达到最大重试次数 ${maxRetries}`);
    return false;
  }

  /**
   * 显示认证成功后的云端访问信息
   */
  displayCloudModeSuccess(remoteUrl: string): void {
    console.log('\n' + '='.repeat(60));
    console.log(t('cloud.auth.complete.title'));
    console.log('='.repeat(60));
    console.log(t('cloud.auth.complete.ready'));
    console.log('');
    console.log(tp('cloud.auth.complete.url', { url: remoteUrl }));
    console.log('');
    console.log(t('cloud.auth.complete.share'));
    console.log('='.repeat(60) + '\n');
  }
}

/**
 * 为云端模式进行认证的便捷函数
 * @param config Config 实例
 * @returns 认证是否成功
 */
export async function authenticateForCloudMode(config: Config): Promise<boolean> {
  const cloudAuth = new CloudModeAuth(config);

  // 首先清理可能过期的认证信息
  await cloudAuth.clearExpiredAuth();

  // 检查当前认证状态
  const isAuthenticated = await cloudAuth.checkAuthStatus();

  if (isAuthenticated) {
    // 已经认证，直接返回成功
    console.log(t('cloud.auth.success'));
    return true;
  } else {
    // 需要认证，启动认证流程（带重试机制）
    console.log(t('cloud.auth.required'));
    return await cloudAuth.startAuthFlowWithRetry();
  }
}

/**
 * 显示云端模式成功信息
 * @param remoteUrl 远程访问URL
 */
export function displayCloudModeSuccess(remoteUrl: string): void {
  const cloudAuth = new CloudModeAuth({} as Config);
  cloudAuth.displayCloudModeSuccess(remoteUrl);
}