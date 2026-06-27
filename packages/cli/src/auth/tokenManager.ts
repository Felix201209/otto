/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { appEvents, AppEvent } from '../utils/events.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
  tokenType?: string;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  roles?: string[];
}

export interface AuthResult {
  success: boolean;
  tokens?: TokenPair;
  user?: UserInfo;
  error?: string;
}

export interface TokenManagerConfig {
  serverEndpoint: string;
  tokenDir?: string;
  autoRefresh?: boolean;
  refreshBufferTime?: number; // seconds before expiry to refresh
}

/**
 * 客户端JWT令牌管理器
 * 负责令牌的存储、刷新、验证和安全管理
 */
export class TokenManager {
  private readonly TOKEN_FILE = 'access_token';
  private readonly REFRESH_TOKEN_FILE = 'refresh_token';
  private readonly TOKEN_EXPIRY_FILE = 'token_expiry';
  private readonly USER_INFO_FILE = 'user_info';
  private readonly ENCRYPTION_KEY_FILE = 'token_key';

  private config: TokenManagerConfig;
  private tokenDir: string;
  private refreshPromise: Promise<string> | null = null;
  private autoRefreshTimer?: NodeJS.Timeout;
  private encryptionKey?: Buffer;

  // 内存缓存
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiry: number | null = null;
  private userInfo: UserInfo | null = null;

  constructor(config: TokenManagerConfig) {
    this.config = {
      autoRefresh: true,
      refreshBufferTime: 259200, // 3天：提前3天开始renew，符合长期token设计
      ...config
    };

    this.tokenDir = config.tokenDir || path.join(os.homedir(), '.otto-user');
    this.initializeTokenManager();
  }

  /**
   * 初始化令牌管理器
   */
  private async initializeTokenManager(): Promise<void> {
    try {
      // 确保令牌目录存在
      await fs.mkdir(this.tokenDir, { recursive: true });

      // 设置目录权限（仅所有者可访问）
      await fs.chmod(this.tokenDir, 0o700);

      // 加载加密密钥
      await this.loadEncryptionKey();

      // 从存储加载令牌
      await this.loadTokensFromStorage();

      // 启动自动刷新
      if (this.config.autoRefresh) {
        this.startAutoRefresh();
      }

      console.log(`🔑 TokenManager initialized with directory: ${this.tokenDir}`);
    } catch (error) {
      console.error('❌ Failed to initialize TokenManager:', error);
    }
  }

  /**
   * 获取访问令牌（自动刷新）
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.accessToken) {
      await this.loadTokensFromStorage();
    }

    if (!this.accessToken) {
      return null;
    }

    // 检查令牌是否即将过期
    if (this.isTokenExpiringSoon()) {
      try {
        await this.refreshAccessToken();
      } catch (error) {
        console.error('❌ Token refresh failed:', error);
        await this.clearTokens();
        appEvents.emit(AppEvent.AuthenticationRequired);
        return null;
      }
    }

    return this.accessToken;
  }

  /**
   * 设置令牌对
   */
  async setTokens(tokens: TokenPair, user?: UserInfo): Promise<void> {
    try {
      this.accessToken = tokens.accessToken;
      this.refreshToken = tokens.refreshToken;
      this.tokenExpiry = Date.now() + (tokens.expiresIn * 1000);
      this.userInfo = user || null;

      // 安全存储到文件
      await Promise.all([
        this.secureStore(this.TOKEN_FILE, tokens.accessToken),
        this.secureStore(this.REFRESH_TOKEN_FILE, tokens.refreshToken),
        this.secureStore(this.TOKEN_EXPIRY_FILE, this.tokenExpiry.toString()),
        user ? this.secureStore(this.USER_INFO_FILE, JSON.stringify(user)) : Promise.resolve()
      ]);

      appEvents.emit(AppEvent.TokensUpdated, { tokens, user });
      console.log('✅ Tokens stored successfully');
    } catch (error) {
      console.error('❌ Failed to store tokens:', error);
      throw error;
    }
  }

  /**
   * 刷新访问令牌
   */
  async refreshAccessToken(): Promise<string> {
    // 防止并发刷新
    if (this.refreshPromise) {
      return await this.refreshPromise;
    }

    this.refreshPromise = this.performTokenRefresh();

    try {
      const newToken = await this.refreshPromise;
      this.refreshPromise = null;
      return newToken;
    } catch (error) {
      this.refreshPromise = null;
      throw error;
    }
  }

  /**
   * 执行令牌刷新
   */
  private async performTokenRefresh(): Promise<string> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    try {
      console.log('🔄 Refreshing access token...');

      const response = await fetch(`${this.config.serverEndpoint}/auth/jwt/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Otto CLI TokenManager'
        },
        body: JSON.stringify({
          refreshToken: this.refreshToken
        })
      });

      if (!response.ok) {
        if (response.status === 401) {
          // 刷新令牌无效，清除所有令牌
          await this.clearTokens();
          throw new Error('Refresh token expired or invalid');
        }

        const errorText = await response.text();
        throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
      }

      const tokenData = await response.json();

      // 更新令牌
      await this.setTokens({
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken || this.refreshToken,
        expiresIn: tokenData.expiresIn
      }, this.userInfo || undefined);

      console.log('✅ Access token refreshed successfully');
      return tokenData.accessToken;
    } catch (error) {
      console.error('❌ Token refresh error:', error);
      throw error;
    }
  }

  /**
   * 从飞书认证结果获取JWT令牌
   */
  async authenticateWithFeishu(feishuAccessToken: string): Promise<AuthResult> {
    try {
      console.log('🔄 Exchanging Feishu token for JWT...');

      const response = await fetch(`${this.config.serverEndpoint}/auth/jwt/feishu-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Otto CLI TokenManager'
        },
        body: JSON.stringify({
          feishuAccessToken,
          clientInfo: {
            platform: process.platform,
            version: process.version,
            timestamp: Date.now()
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Feishu authentication failed:', errorText);
        return {
          success: false,
          error: `Authentication failed (${response.status}): ${errorText}`
        };
      }

      const authData = await response.json();

      // 存储JWT令牌和用户信息
      await this.setTokens({
        accessToken: authData.accessToken,
        refreshToken: authData.refreshToken,
        expiresIn: authData.expiresIn
      }, authData.user);

      console.log('✅ JWT authentication successful');
      return {
        success: true,
        tokens: {
          accessToken: authData.accessToken,
          refreshToken: authData.refreshToken,
          expiresIn: authData.expiresIn
        },
        user: authData.user
      };
    } catch (error) {
      console.error('❌ Feishu authentication error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 获取用户信息
   */
  async getUserInfo(): Promise<UserInfo | null> {
    if (!this.userInfo) {
      await this.loadTokensFromStorage();
    }
    return this.userInfo;
  }

  /**
   * 清除所有令牌和用户信息
   */
  async clearTokens(): Promise<void> {
    try {
      // 清除内存缓存
      this.accessToken = null;
      this.refreshToken = null;
      this.tokenExpiry = null;
      this.userInfo = null;

      // 停止自动刷新
      this.stopAutoRefresh();

      // 删除文件
      await Promise.all([
        this.secureRemove(this.TOKEN_FILE),
        this.secureRemove(this.REFRESH_TOKEN_FILE),
        this.secureRemove(this.TOKEN_EXPIRY_FILE),
        this.secureRemove(this.USER_INFO_FILE)
      ]);

      appEvents.emit(AppEvent.TokensCleared);
      console.log('🗑️ All tokens cleared');
    } catch (error) {
      console.error('❌ Failed to clear tokens:', error);
    }
  }

  /**
   * 检查令牌是否有效
   */
  isTokenValid(): boolean {
    return !!(this.accessToken &&
             this.tokenExpiry &&
             Date.now() < this.tokenExpiry);
  }

  /**
   * 检查是否已认证
   */
  async isAuthenticated(): Promise<boolean> {
    const token = await this.getAccessToken();
    return !!token;
  }

  /**
   * 检查令牌是否即将过期
   */
  private isTokenExpiringSoon(bufferTimeMs?: number): boolean {
    if (!this.tokenExpiry) return true;

    const buffer = bufferTimeMs || (this.config.refreshBufferTime! * 1000);
    return Date.now() > (this.tokenExpiry - buffer);
  }

  /**
   * 从存储加载令牌
   */
  private async loadTokensFromStorage(): Promise<void> {
    try {
      const [accessToken, refreshToken, expiry, userInfo] = await Promise.all([
        this.secureGet(this.TOKEN_FILE),
        this.secureGet(this.REFRESH_TOKEN_FILE),
        this.secureGet(this.TOKEN_EXPIRY_FILE),
        this.secureGet(this.USER_INFO_FILE)
      ]);

      this.accessToken = accessToken;
      this.refreshToken = refreshToken;
      this.tokenExpiry = expiry ? parseInt(expiry, 10) : null;

      if (userInfo) {
        try {
          this.userInfo = JSON.parse(userInfo);
        } catch {
          this.userInfo = null;
        }
      }

      // 检查令牌是否已过期
      if (this.tokenExpiry && Date.now() > this.tokenExpiry) {
        console.log('⚠️ Stored tokens have expired, clearing...');
        await this.clearTokens();
      }
    } catch (error) {
      console.error('❌ Failed to load tokens from storage:', error);
    }
  }

  /**
   * 启动自动刷新定时器
   */
  private startAutoRefresh(): void {
    this.stopAutoRefresh(); // 清除现有定时器

    this.autoRefreshTimer = setInterval(async () => {
      if (this.isTokenValid() && this.isTokenExpiringSoon()) {
        try {
          await this.refreshAccessToken();
        } catch (error) {
          console.error('❌ Auto refresh failed:', error);
          // 关键修复：异常时停止自动刷新防止定时器泄漏
          this.stopAutoRefresh();
        }
      }
    }, 30000); // 每30秒检查一次
  }

  /**
   * 停止自动刷新定时器
   */
  private stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
  }

  /**
   * 加载或生成加密密钥
   */
  private async loadEncryptionKey(): Promise<void> {
    try {
      const keyPath = path.join(this.tokenDir, this.ENCRYPTION_KEY_FILE);

      try {
        const keyData = await fs.readFile(keyPath);
        this.encryptionKey = keyData;
      } catch {
        // 生成新的加密密钥
        this.encryptionKey = crypto.randomBytes(32);
        await fs.writeFile(keyPath, this.encryptionKey);
        await fs.chmod(keyPath, 0o600);
      }
    } catch (error) {
      console.error('❌ Failed to load encryption key:', error);
      // 使用临时密钥
      this.encryptionKey = crypto.randomBytes(32);
    }
  }

  /**
   * 安全存储数据到文件
   */
  private async secureStore(filename: string, data: string): Promise<void> {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized');
    }

    const filePath = path.join(this.tokenDir, filename);
    const encryptedData = this.encrypt(data);

    await fs.writeFile(filePath, encryptedData);
    await fs.chmod(filePath, 0o600);
  }

  /**
   * 安全读取文件数据
   */
  private async secureGet(filename: string): Promise<string | null> {
    try {
      const filePath = path.join(this.tokenDir, filename);
      const encryptedData = await fs.readFile(filePath);
      return this.decrypt(encryptedData);
    } catch {
      return null;
    }
  }

  /**
   * 安全删除文件
   */
  private async secureRemove(filename: string): Promise<void> {
    try {
      const filePath = path.join(this.tokenDir, filename);
      await fs.unlink(filePath);
    } catch {
      // 忽略删除错误
    }
  }

  /**
   * 加密数据
   */
  private encrypt(data: string): Buffer {
    const key32 = this.getCipherKey();

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key32, iv);
    const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);

    return Buffer.concat([iv, encrypted]);
  }

  /**
   * 解密数据
   */
  private decrypt(encryptedData: Buffer): string {
    const key32 = this.getCipherKey();

    const iv = encryptedData.subarray(0, 16);
    const ciphertext = encryptedData.subarray(16);

    const decipher = crypto.createDecipheriv('aes-256-cbc', key32, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }

  /**
   * 从加密密钥材料稳定派生 32 字节 AES-256 密钥
   * （SHA-256 对同一份密钥材料每次派生结果一致，且无论原始密钥长度都得到 32 字节）
   */
  private getCipherKey(): Buffer {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized');
    }
    return crypto.createHash('sha256').update(this.encryptionKey).digest();
  }

  /**
   * 销毁TokenManager实例
   */
  destroy(): void {
    // 强制清理自动刷新定时器
    this.stopAutoRefresh();

    // 验证定时器是否确实被清理
    if (this.autoRefreshTimer) {
      console.warn('⚠️ Timer still exists during destroy, forcing cleanup');
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }

    // 清理刷新Promise防止内存泄漏
    if (this.refreshPromise) {
      this.refreshPromise = null;
    }

    // 清理所有缓存数据
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    this.userInfo = null;
    this.encryptionKey = undefined;

    console.log('🗑️ TokenManager destroyed and cleaned up');
  }
}

// 单例实例
let globalTokenManager: TokenManager | null = null;

/**
 * 获取全局TokenManager实例
 */
export function getTokenManager(config?: TokenManagerConfig): TokenManager {
  // 如果已存在实例但传入新配置，先销毁旧实例防止重复初始化
  if (globalTokenManager && config) {
    console.log('🔄 Reinitializing TokenManager with new config');
    globalTokenManager.destroy();
    globalTokenManager = null;
  }

  if (!globalTokenManager && config) {
    globalTokenManager = new TokenManager(config);
  }

  if (!globalTokenManager) {
    throw new Error('TokenManager not initialized. Call getTokenManager with config first.');
  }

  return globalTokenManager;
}

/**
 * 销毁全局TokenManager实例
 */
export function destroyTokenManager(): void {
  if (globalTokenManager) {
    globalTokenManager.destroy();
    globalTokenManager = null;
  }
}
