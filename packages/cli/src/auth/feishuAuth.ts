/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import * as crypto from 'crypto';
import * as http from 'http';
import { URL } from 'url';
import { execFile } from 'child_process';
import { appEvents, AppEvent } from '../utils/events.js';


// 功能实现: 飞书OAuth2认证集成
// 实现方案: 基于飞书开放平台OAuth2授权码模式
// 影响范围: 新增认证模块，集成到现有认证流程
// 实现日期: 2025-01-08

export interface FeishuAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  nextStepUrl: string;
}

export interface FeishuAuthResult {
  success: boolean;
  accessToken?: string;
  error?: string;
  nextStepUrl?: string;
}

/**
 * 飞书OAuth2认证处理器
 */
export class FeishuAuthHandler {
  private config: FeishuAuthConfig;
  private server?: http.Server;
  private state: string;

  constructor(config: FeishuAuthConfig) {
    this.config = config;
    this.state = this.generateState();
  }

  /**
   * 生成state参数用于防止CSRF攻击
   */
  private generateState(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * 构建飞书授权URL
   * 修复: 使用正确的飞书OAuth2授权URL和参数格式
   * 参考: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/authorize/get
   */
  buildAuthUrl(): string {
    const params = new URLSearchParams({
      app_id: this.config.appId,  // 飞书使用app_id参数
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: 'contact:user.employee_id:readonly',  // 使用正确的scope
      state: this.state,
    });

    // BUG修复: 恢复授权端点为v1版本（v2版本没有authorize端点）
    // 修复策略: 授权使用v1，token交换使用v2（飞书官方规范）
    // 影响范围: packages/cli/src/auth/feishuAuth.ts:69
    // 修复日期: 2025-01-26
    const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`;

    return authUrl;
  }

  /**
   * 启动飞书OAuth2认证流程
   * 1. 启动本地服务器接收回调
   * 2. 自动打开浏览器到飞书授权页面
   */
  async startAuthFlow(): Promise<FeishuAuthResult> {
    return new Promise((resolve) => {
      const url = new URL(this.config.redirectUri);
      const port = parseInt(url.port, 10) || 6699;

      this.server = http.createServer(async (req, res) => {
        if (!req.url) {
          this.sendErrorResponse(res, 'Invalid request');
          resolve({ success: false, error: 'Invalid request' });
          return;
        }

        const reqUrl = new URL(req.url, `http://localhost:${port}`);

        if (reqUrl.pathname === url.pathname) {
          await this.handleCallbackWithPlatCheck(reqUrl, res, resolve);
        } else {
          this.sendErrorResponse(res, 'Not found');
        }
      });

      // 尝试启动服务器，如果端口被占用则尝试下一个端口
      const tryListen = (currentPort: number) => {
        this.server!.listen(currentPort, () => {
          console.log(`🌐 本地回调服务器启动在端口 ${currentPort}`);

          // 发出服务器启动事件
          appEvents.emit(AppEvent.FeishuServerStarted, currentPort);

          // 如果端口改变了，需要更新配置
          if (currentPort !== port) {
            const newRedirectUri = this.config.redirectUri.replace(`:${port}`, `:${currentPort}`);
            this.config.redirectUri = newRedirectUri;
            console.log(`📝 重定向URI已更新为: ${newRedirectUri}`);
          }

          // 构建授权URL并自动打开浏览器
          const authUrl = this.buildAuthUrl();
          console.log(`🔗 飞书授权URL: ${authUrl}`);
          console.log(`🚀 正在打开浏览器进行飞书授权...`);

          // 自动打开浏览器
          this.openBrowser(authUrl);
        });

        this.server!.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            console.log(`⚠️ 端口 ${currentPort} 被占用，尝试端口 ${currentPort + 1}`);
            if (currentPort < 6709) { // 最多尝试10个端口 (6699-6709)
              tryListen(currentPort + 1);
            } else {
              this.cleanup();
              resolve({ success: false, error: '无法找到可用端口 (6699-6709)' });
            }
          } else {
            this.cleanup();
            resolve({ success: false, error: `服务器启动失败: ${err.message}` });
          }
        });
      };

      tryListen(port);

      // 设置超时
      setTimeout(() => {
        this.cleanup();
        resolve({ success: false, error: '认证超时' });
      }, 300000); // 5分钟超时
    });
  }

  /**
   * 自动打开浏览器到指定URL
   */
  private openBrowser(url: string): void {
    const platform = process.platform;

    // 安全修复: 使用 execFile 并将 URL 作为独立参数传入(不经 shell),
    // 避免 URL 中的引号等字符被注入为任意 shell 命令(命令注入)。
    let file: string;
    let args: string[];
    if (platform === 'win32') {
      // Windows: 通过 cmd 的 start 命令打开,空标题占位 + URL 作为独立参数,
      // execFile 不经 shell 解释,参数按数组安全传递。
      file = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (platform === 'darwin') {
      file = 'open';
      args = [url];
    } else {
      file = 'xdg-open';
      args = [url];
    }

    execFile(file, args, (error: Error | null) => {
      if (error) {
        console.error(`❌ 无法自动打开浏览器: ${error.message}`);
        console.log(`📋 请手动复制以下URL到浏览器中打开:`);
        console.log(`🔗 ${url}`);
      } else {
        console.log(`✅ 浏览器已打开，请在飞书页面完成授权`);
      }
    });
  }

  /**
   * 处理授权回调（带平台检查）
   * 注意：这个方法现在只用于旧的飞书认证流程，新的认证流程使用authServer.ts
   */
  private async handleCallbackWithPlatCheck(
    reqUrl: URL,
    res: http.ServerResponse,
    resolve: (result: FeishuAuthResult) => void
  ): Promise<void> {
    // 直接处理飞书认证回调，不再处理Otto
    console.log('🔄 [FeishuAuth] 处理飞书认证回调（旧流程）');
    await this.handleCallback(reqUrl, res, resolve);
  }

  /**
   * 处理授权回调
   */
  private async handleCallback(
    reqUrl: URL,
    res: http.ServerResponse,
    resolve: (result: FeishuAuthResult) => void
  ): Promise<void> {
    const code = reqUrl.searchParams.get('code');
    const state = reqUrl.searchParams.get('state');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      this.sendErrorResponse(res, `认证失败: ${error}`);
      this.cleanup();
      resolve({ success: false, error: `认证失败: ${error}` });
      return;
    }

    if (!code) {
      this.sendErrorResponse(res, '未收到授权码');
      this.cleanup();
      resolve({ success: false, error: '未收到授权码' });
      return;
    }

    if (state !== this.state) {
      this.sendErrorResponse(res, 'State参数不匹配，可能存在安全风险');
      this.cleanup();
      resolve({ success: false, error: 'State参数不匹配' });
      return;
    }

    try {
      const accessToken = await this.exchangeCodeForToken(code);
      this.sendSuccessResponse(res);
      this.cleanup();
      resolve({ 
        success: true, 
        accessToken,
        nextStepUrl: this.config.nextStepUrl
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '未知错误';
      this.sendErrorResponse(res, `获取访问令牌失败: ${errorMsg}`);
      this.cleanup();
      resolve({ success: false, error: `获取访问令牌失败: ${errorMsg}` });
    }
  }

  /**
   * 使用授权码换取访问令牌
   * BUG修复: 修正飞书OAuth2参数名称规范
   * 修复策略: 使用飞书规范的app_id和app_secret参数名
   * 影响范围: packages/cli/src/auth/feishuAuth.ts:228-234
   * 修复日期: 2025-01-26
   * 参考: https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token
   */
  private async exchangeCodeForToken(code: string): Promise<string> {
    const tokenUrl = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';

    // BUG修复: 使用标准OAuth2参数名称（client_id, client_secret）
    // 修复策略: 回到标准OAuth2规范，移除重复的body构建逻辑
    // 影响范围: packages/cli/src/auth/feishuAuth.ts:231-262
    // 修复日期: 2025-01-26
    
    const formData = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.appId,        // 使用标准OAuth2参数名
      client_secret: this.config.appSecret, // 使用标准OAuth2参数名
      code,
      redirect_uri: this.config.redirectUri,
    });


    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    console.log('📊 exchangeCodeForToken: HTTP状态:', response.status);
    // 安全修复: 移除敏感的响应头信息打印，避免泄露隐私数据
    // console.log('📊 exchangeCodeForToken: Response Headers:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorText = await response.text();
      // 脱敏:原始响应体可能含 token/敏感数据,仅入 debug 日志(截断),
      // 抛给上层(可能进飞书回复/用户可见文本)的错误只带状态码。
      console.debug('[feishuAuth] token exchange error body:', errorText.slice(0, 500));
      throw new Error(`飞书令牌交换失败:HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    // 安全修复: 移除完整响应数据打印，避免泄露访问令牌等敏感信息
    console.log('📋 exchangeCodeForToken: 令牌交换成功，已获取访问令牌');

    // BUG修复: 修正飞书OAuth2 API响应格式判断
    // 修复策略: OAuth2标准响应通常直接包含access_token，而不是通过code字段判断
    // 影响范围: packages/cli/src/auth/feishuAuth.ts:276-280
    // 修复日期: 2025-01-26
    
    // 检查OAuth2标准错误格式
    if (data.error) {
      throw new Error(`飞书OAuth2错误: ${data.error} - ${data.error_description || ''}`);
    }
    
    // 检查飞书特有的code字段（如果存在）
    if (data.code !== undefined && data.code !== 0) {
      throw new Error(`飞书API错误: ${data.msg || data.error || '未知错误'}`);
    }
    
    // 检查是否有access_token
    if (!data.access_token) {
      throw new Error('响应中缺少access_token字段');
    }

    return data.access_token;
  }

  /**
   * HTML 转义,防止外部可控文本嵌入页面导致 XSS
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 发送成功响应
   * 功能实现: 飞书认证成功后自动关闭浏览器窗口
   * 实现方案: 显示成功信息2秒后自动关闭窗口，提升用户体验
   * 影响范围: 飞书认证成功页面的行为
   * 实现日期: 2025-01-26
   */
  private sendSuccessResponse(res: http.ServerResponse): void {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>飞书认证成功</title>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .success { color: #28a745; }
          .countdown { color: #666; font-size: 14px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <h1 class="success">✅ 飞书认证成功！</h1>
        <p>认证已完成，页面将在 <span id="countdown">2</span> 秒后自动关闭</p>
        <div class="countdown">如需继续操作，请返回终端窗口</div>
        <script>
          let seconds = 2;
          const countdownElement = document.getElementById('countdown');
          
          const timer = setInterval(() => {
            seconds--;
            if (countdownElement) {
              countdownElement.textContent = seconds.toString();
            }
            
            if (seconds <= 0) {
              clearInterval(timer);
              
              // 尝试多种方式关闭页面
              try {
                // 方法1: 直接关闭窗口
                window.close();
              } catch (e) {
                console.log('方法1失败:', e);
              }
              
              // 方法2: 尝试关闭标签页
              setTimeout(() => {
                try {
                  window.open('', '_self', '');
                  window.close();
                } catch (e) {
                  console.log('方法2失败:', e);
                }
              }, 100);
              
              // 方法3: 尝试通过 opener 关闭
              setTimeout(() => {
                try {
                  if (window.opener) {
                    window.opener = null;
                    window.close();
                  }
                } catch (e) {
                  console.log('方法3失败:', e);
                }
              }, 200);
              
              // 方法4: 重定向到 about:blank 并关闭
              setTimeout(() => {
                try {
                  window.location.href = 'about:blank';
                  window.close();
                } catch (e) {
                  console.log('方法4失败:', e);
                }
              }, 300);
              
              // 如果无法关闭窗口（某些浏览器限制），显示提示信息
              setTimeout(() => {
                document.body.innerHTML = '<h2>✅ 认证成功</h2><p>请手动关闭此页面并返回终端窗口</p><p style="color: #666; font-size: 12px;">由于浏览器安全限制，页面无法自动关闭</p>';
              }, 500);
            }
          }, 1000);
        </script>
      </body>
      </html>
    `;
    
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }



  /**
   * 发送错误响应
   * 功能实现: 飞书认证失败后显示友好的错误页面并自动关闭
   * 实现方案: 美化错误页面并在5秒后自动关闭，与成功页面保持一致的体验
   * 影响范围: 飞书认证错误页面的行为
   * 实现日期: 2025-01-26
   */
  private sendErrorResponse(res: http.ServerResponse, error: string): void {
    // 安全修复: error 可能来自回调 URL 的查询参数(外部可控),
    // 直接嵌入 HTML 会导致 XSS,先做 HTML 转义再插入页面。
    const safeError = this.escapeHtml(error);
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>飞书认证失败</title>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .error { color: #dc3545; }
          .countdown { color: #666; font-size: 14px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <h1 class="error">❌ 飞书认证失败</h1>
        <p>${safeError}</p>
        <p>页面将在 <span id="countdown">5</span> 秒后自动关闭</p>
        <div class="countdown">请返回终端窗口重试认证</div>
        <script>
          let seconds = 5;
          const countdownElement = document.getElementById('countdown');
          
          const timer = setInterval(() => {
            seconds--;
            if (countdownElement) {
              countdownElement.textContent = seconds.toString();
            }
            
            if (seconds <= 0) {
              clearInterval(timer);
              
              // 尝试多种方式关闭页面
              try {
                window.close();
              } catch (e) {
                console.log('无法自动关闭窗口:', e);
              }
              
              setTimeout(() => {
                try {
                  window.open('', '_self', '');
                  window.close();
                } catch (e) {}
              }, 100);
              
              setTimeout(() => {
                try {
                  if (window.opener) {
                    window.opener = null;
                    window.close();
                  }
                } catch (e) {}
              }, 200);
              
              // 如果无法关闭窗口（某些浏览器限制），显示提示信息
              setTimeout(() => {
                document.body.innerHTML = '<h2>❌ 认证失败</h2><p>请手动关闭此页面并返回终端窗口重试</p><p style="color: #666; font-size: 12px;">由于浏览器安全限制，页面无法自动关闭</p>';
              }, 400);
            }
          }, 1000);
        </script>
      </body>
      </html>
    `;
    
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
      // 发出服务器停止事件
      appEvents.emit(AppEvent.FeishuServerStopped);
    }
  }
}

/**
 * 创建飞书认证处理器的便捷函数
 */
export function createFeishuAuthHandler(
  appId: string,
  appSecret: string,
  nextStepUrl?: string
): FeishuAuthHandler {
  const config: FeishuAuthConfig = {
    appId,
    appSecret,
    redirectUri: 'http://localhost:7863/callback',  // 使用与飞书应用配置匹配的回调地址
    // BYO-key: 仅展示用途的下一步地址；未配置时为空字符串。
    nextStepUrl: nextStepUrl || process.env.OTTO_SERVER_URL || '',
  };

  return new FeishuAuthHandler(config);
}
