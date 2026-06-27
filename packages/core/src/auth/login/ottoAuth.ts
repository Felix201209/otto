/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * Otto统一认证处理器
 * 处理Otto统一认证系统的认证流程
 */

export interface OttoAuthConfig {
  authUrl: string;
  redirectUri: string;
}

export interface OttoAuthResult {
  success: boolean;
  token?: string;
  user_id?: string;
  error?: string;
}

/**
 * Otto统一认证处理器
 */
export class OttoAuthHandler {
  private config: OttoAuthConfig;

  constructor(config: OttoAuthConfig) {
    this.config = config;
  }

  /**
   * 构建Otto认证URL
   */
  public buildAuthUrl(): string {
    // BYO-key: 未配置认证服务地址时该登录流不可用，抛错由调用方 catch 优雅处理，
    // 避免生成以 '?redirect_to=' 开头的无效 URL。
    if (!this.config.authUrl) {
      throw new Error('未配置认证服务地址（OTTO_AUTH_URL），账号登录不可用');
    }
    // 直接构建完整的认证URL，避免重定向问题
    const authUrl = `${this.config.authUrl}?redirect_to=${encodeURIComponent(this.config.redirectUri)}&redirect_mode=same_window`;
    console.log('🔗 Otto认证URL:', authUrl);

    return authUrl;
  }

  /**
   * 处理Otto认证回调
   */
  public handleCallback(url: URL): OttoAuthResult {
    console.log('🔄 [Otto Auth] 处理Otto认证回调');
    console.log('🔄 [Otto Auth] 回调URL:', url.toString());

    const allParams = Object.fromEntries(url.searchParams.entries());
    console.log('🔄 [Otto Auth] 回调参数:', allParams);

    // 提取token和user_id参数
    const token = url.searchParams.get('token');
    const user_id = url.searchParams.get('user_id');
    const error = url.searchParams.get('error');

    if (error) {
      console.error('❌ [Otto Auth] 认证错误:', error);
      return {
        success: false,
        error: `Otto认证失败: ${error}`
      };
    }

    if (!token) {
      console.error('❌ [Otto Auth] 缺少token参数');
      return {
        success: false,
        error: 'Otto认证回调中缺少token参数'
      };
    }

    if (!user_id) {
      console.error('❌ [Otto Auth] 缺少user_id参数');
      return {
        success: false,
        error: 'Otto认证回调中缺少user_id参数'
      };
    }

    // 打印token和user_id（按要求）
    console.log('🎉 [Otto Auth] 获取到JWT Token:', token);
    console.log('🎉 [Otto Auth] 获取到User ID:', user_id);

    console.log('✅ [Otto Auth] Otto认证成功');
    return {
      success: true,
      token: token,
      user_id: user_id
    };
  }
}

/**
 * 创建Otto认证处理器的便捷函数
 */
export function createOttoAuthHandler(callbackPort?: number): OttoAuthHandler {
  const actualPort = callbackPort || 7863;
  const config: OttoAuthConfig = {
    // BYO-key: 不再硬编码 otto 登录地址；可由 OTTO_AUTH_URL 配置，未配置则该登录流不可用。
    authUrl: process.env.OTTO_AUTH_URL || '',
    redirectUri: `http://localhost:${actualPort}/callback?plat=otto`,
  };

  return new OttoAuthHandler(config);
}
