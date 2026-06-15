/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { logIfNotSilent } from '../utils/logging.js';
import { getUserAgent } from '../utils/userAgent.js';

/**
 * 认证HTTP客户端
 * 自动处理JWT令牌的添加、刷新和错误处理
 */
export class AuthenticatedHttpClient {
  private tokenManager: any;
  private baseURL: string;
  private requestQueue: Array<{
    resolve: Function;
    reject: Function;
    request: () => Promise<Response>;
  }> = [];
  private isRefreshing = false;
  private onAuthenticationRequired?: () => void;

  constructor(baseURL: string, tokenManager: any, onAuthenticationRequired?: () => void) {
    this.baseURL = baseURL.replace(/\/$/, ''); // 移除尾部斜杠
    this.tokenManager = tokenManager;
    this.onAuthenticationRequired = onAuthenticationRequired;
  }

  /**
   * 设置认证失败回调
   */
  setAuthenticationRequiredCallback(callback: () => void): void {
    this.onAuthenticationRequired = callback;
  }

  /**
   * 发送HTTP请求（自动添加认证头）
   */
  async request(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const url = `${this.baseURL}${endpoint}`;

    // 准备请求选项
    const requestOptions = await this.prepareRequestOptions(options);

    // 发送请求
    let response = await fetch(url, requestOptions);

    // 处理401响应（令牌过期）
    if (response.status === 401 && this.tokenManager) {
      response = await this.handleUnauthorized(url, requestOptions);
    }

    return response;
  }

  /**
   * GET请求
   */
  async get(endpoint: string, options: RequestInit = {}): Promise<Response> {
    return this.request(endpoint, { ...options, method: 'GET' });
  }

  /**
   * POST请求
   */
  async post(
    endpoint: string,
    body?: any,
    options: RequestInit = {}
  ): Promise<Response> {
    const requestOptions: RequestInit = {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined
    };

    if (body && !(options.headers as Record<string, string>)?.['Content-Type']) {
      requestOptions.headers = {
        'Content-Type': 'application/json',
        ...options.headers
      };
    }

    return this.request(endpoint, requestOptions);
  }

  /**
   * PUT请求
   */
  async put(
    endpoint: string,
    body?: any,
    options: RequestInit = {}
  ): Promise<Response> {
    const requestOptions: RequestInit = {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined
    };

    if (body && !(options.headers as Record<string, string>)?.['Content-Type']) {
      requestOptions.headers = {
        'Content-Type': 'application/json',
        ...options.headers
      };
    }

    return this.request(endpoint, requestOptions);
  }

  /**
   * DELETE请求
   */
  async delete(endpoint: string, options: RequestInit = {}): Promise<Response> {
    return this.request(endpoint, { ...options, method: 'DELETE' });
  }

  /**
   * 准备请求选项（添加认证头）
   */
  private async prepareRequestOptions(options: RequestInit): Promise<RequestInit> {
    const headers: HeadersInit = {
      'User-Agent': getUserAgent(),
      ...options.headers
    };

    // 获取访问令牌
    if (this.tokenManager) {
      try {
        const token = await this.tokenManager.getAccessToken();
        if (token) {
          (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
        } else {
          logIfNotSilent('warn', '⚠️ No access token available');
        }
      } catch (error) {
        logIfNotSilent('warn', '⚠️ Failed to get access token:', error);
        // 如果获取token失败，可能需要重新认证
        if (this.onAuthenticationRequired && error instanceof Error && error.message?.includes('authentication required')) {
          logIfNotSilent('log', '🔄 Triggering authentication flow...');
          this.onAuthenticationRequired();
        }
      }
    }

    return {
      ...options,
      headers
    };
  }

  /**
   * 处理401未授权响应
   */
  private async handleUnauthorized(
    url: string,
    originalOptions: RequestInit
  ): Promise<Response> {
    if (this.isRefreshing) {
      // 如果正在刷新令牌，将请求加入队列
      return new Promise((resolve, reject) => {
        this.requestQueue.push({
          resolve,
          reject,
          request: () => fetch(url, originalOptions)
        });
      });
    }

    this.isRefreshing = true;

    try {
      logIfNotSilent('log', '🔄 Access token expired, attempting refresh...');

      // 尝试刷新令牌
      const newToken = await this.tokenManager.refreshAccessToken();

      if (newToken) {
        logIfNotSilent('log', '✅ Token refreshed successfully');

        // 更新请求头中的令牌
        const updatedOptions = {
          ...originalOptions,
          headers: {
            ...originalOptions.headers,
            'Authorization': `Bearer ${newToken}`
          }
        };

        // 重新发送原始请求
        const response = fetch(url, updatedOptions);

        // 处理队列中的请求
        this.processRequestQueue(newToken);

        return await response;
      } else {
        throw new Error('Failed to refresh token');
      }
    } catch (error) {
      console.error('❌ Token refresh failed:', error);

      // 清除令牌
      if (this.tokenManager.clearTokens) {
        await this.tokenManager.clearTokens();
      } else if (this.tokenManager.clear) {
        this.tokenManager.clear();
      }

      // 拒绝队列中的所有请求
      this.rejectRequestQueue(new Error('Authentication required'));

      // 触发重新认证流程
      if (this.onAuthenticationRequired) {
        logIfNotSilent('log', '🔄 Authentication required, triggering auth flow...');
        this.onAuthenticationRequired();
      }

      // 抛出认证错误
      throw new AuthenticationError('Authentication required - please re-authenticate');
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * 处理请求队列
   */
  private processRequestQueue(newToken: string): void {
    const queue = this.requestQueue.splice(0);

    queue.forEach(({ resolve, reject, request }) => {
      request()
        .then((response) => resolve(response))
        .catch((error) => reject(error));
    });
  }

  /**
   * 拒绝请求队列中的所有请求
   */
  private rejectRequestQueue(error: Error): void {
    const queue = this.requestQueue.splice(0);

    queue.forEach(({ reject }) => {
      reject(error);
    });
  }

  /**
   * 检查响应是否成功
   */
  static async checkResponse(response: Response): Promise<any> {
    if (!response.ok) {
      const errorText = await response.text();
      throw new HttpError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        errorText
      );
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    } else {
      return await response.text();
    }
  }

  /**
   * 便捷方法：发送JSON请求并解析响应
   */
  async requestJson(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<any> {
    const response = await this.request(endpoint, options);
    return AuthenticatedHttpClient.checkResponse(response);
  }

  /**
   * 便捷方法：发送POST JSON请求
   */
  async postJson(endpoint: string, body?: any): Promise<any> {
    const response = await this.post(endpoint, body);
    return AuthenticatedHttpClient.checkResponse(response);
  }

  /**
   * 便捷方法：发送PUT JSON请求
   */
  async putJson(endpoint: string, body?: any): Promise<any> {
    const response = await this.put(endpoint, body);
    return AuthenticatedHttpClient.checkResponse(response);
  }

  /**
   * 便捷方法：发送GET JSON请求
   */
  async getJson(endpoint: string): Promise<any> {
    const response = await this.get(endpoint);
    return AuthenticatedHttpClient.checkResponse(response);
  }

  /**
   * 便捷方法：发送DELETE JSON请求
   */
  async deleteJson(endpoint: string): Promise<any> {
    const response = await this.delete(endpoint);
    return AuthenticatedHttpClient.checkResponse(response);
  }
}

/**
 * 认证错误类
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/**
 * HTTP错误类
 */
export class HttpError extends Error {
  status: number;
  response: string;

  constructor(message: string, status: number, response: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.response = response;
  }
}

/**
 * 创建认证HTTP客户端的工厂函数
 */
export function createAuthenticatedHttpClient(
  baseURL: string,
  tokenManager?: any,
  onAuthenticationRequired?: () => void
): AuthenticatedHttpClient {
  return new AuthenticatedHttpClient(baseURL, tokenManager, onAuthenticationRequired);
}