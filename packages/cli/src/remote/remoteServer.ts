/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import WebSocket from 'ws';
import { createServer, Server } from 'http';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as fs from 'fs/promises';

import { Config, ToolRegistry, executeToolCall } from 'otto-core';
import { GenerateContentResponse, FunctionCall, Part } from '@google/genai';
import { Content } from 'otto-core';
import {
  RemoteMessage,
  MessageType,
  MessageFactory,
  MessageValidator,
  CommandMessage,
  SelectSessionMessage,
  CreateSessionMessage,
  RequestUIStateMessage,
  AuthSubmitMessage,
  ClearSessionMessage,
  FeishuImageMessage,
  GetModelsRequestMessage,
} from './remoteProtocol.js';
import { parseAndFormatApiError } from '../ui/utils/errorParsing.js';
import { t, tp } from '../ui/utils/i18n.js';
import { ToolCallRequestInfo } from 'otto-core';
import { SceneType, AuthType } from 'otto-core';
import { ProxyAuthManager } from 'otto-core';
import { RemoteSession } from './remoteSession.js';
import { remoteLogger } from './remoteLogger.js';
import { CloudClient } from './cloudClient.js';
import { getAvailableModels } from '../ui/commands/modelCommand.js';
import { detectImageExtension } from '../services/feishu/image-type.js';

/**
 * 从指定端口开始查找可用端口
 */
async function findAvailablePort(startPort: number = 4058): Promise<number> {
  const isPortAvailable = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, 'localhost', () => {
        server.once('close', () => resolve(true));
        server.close();
      });
      server.on('error', () => resolve(false));
    });
  };

  for (let port = startPort; port < startPort + 100; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`无法在 ${startPort}-${startPort + 99} 范围内找到可用端口`);
}

/**
 * Session管理接口
 */
interface SessionInfo {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  session: RemoteSession;
  firstUserInput?: string;  // 第一条用户输入
  lastUserInput?: string;   // 最后一条用户输入
  cloudRouteRef?: { current: Record<string, any> };  // 云端路由引用，供 virtualWs 回包时使用
}

/**
 * 本地WebSocket服务器
 * 设计思想：作为手机客户端和CLI进程的中介桥梁
 */
export class RemoteServer {
  private config: Config;
  private password: string;

  // Session管理 - 保持最新6个session
  private sessions: Map<string, SessionInfo> = new Map();
  private readonly MAX_SESSIONS = 6;

  // 🆕 云端模式支持
  private cloudClient?: CloudClient;
  private cloudMode: boolean = false;
  private cloudServerUrl?: string;

  constructor(config: Config) {
    this.config = config;
    this.password = this.generatePassword();
  }

  /**
   * 生成6位随机密码
   */
  private generatePassword(): string {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let password = '';
    for (let i = 0; i < 6; i++) {
      password += chars[Math.floor(Math.random() * chars.length)];
    }
    return password;
  }

  /**
   * 验证密码
   */
  public verifyPassword(inputPassword: string): boolean {
    return inputPassword === this.password;
  }

  /**
   * 获取密码（用于URL生成）
   */
  public getPassword(): string {
    return this.password;
  }

  /**
   * 初始化认证并验证状态
   * 如果认证失败，会自动调用认证流程
   */
  private async initializeAuth(): Promise<boolean> {
    try {
      // 导入云端模式认证模块
      const { authenticateForCloudMode } = await import('./cloudModeAuth.js');

      // 使用云端模式认证函数，它会自动检查状态并在需要时启动认证流程
      const authResult = await authenticateForCloudMode(this.config);

      if (authResult) {
        // 验证认证成功
        const proxyAuthManager = ProxyAuthManager.getInstance();
        const userInfo = proxyAuthManager.getUserInfo();
        if (userInfo) {
          const { maskEmail } = await import('../utils/urlMask.js');
          const displayInfo = userInfo.email ? maskEmail(userInfo.email) : (userInfo.openId || 'N/A');
          console.log(tp('cloud.auth.user.authenticated', { name: userInfo.name, info: displayInfo }));
        }
        return true;
      } else {
        console.error('❌ 云端模式认证失败');
        return false;
      }
    } catch (error) {
      console.error('❌ 认证初始化失败:', error);
      return false;
    }
  }

  /**
   * 带重试机制的认证初始化
   */
  private async initializeAuthWithRetry(maxRetries: number = 3): Promise<boolean> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(tp('cloud.auth.retry', { attempt, maxRetries }));
        const success = await this.initializeAuth();
        if (success) {
          return true;
        }
        lastError = new Error(`认证失败 (尝试 ${attempt})`);
      } catch (error) {
        lastError = error as Error;
        console.error(`❌ 认证尝试 ${attempt} 失败:`, error);
      }

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 指数退避，最大5秒
        console.log(tp('cloud.connection.retry.delay', { delay: delay/1000 }));
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    console.error(tp('cloud.auth.failed.max.retries', { maxRetries }));
    if (lastError) {
      throw lastError;
    }
    return false;
  }

  /**
   * 带重试机制的云端连接
   */
  private async connectWithRetry(maxRetries: number = 3): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(tp('cloud.connection.retry', { attempt, maxRetries }));
        if (!this.cloudClient) {
          throw new Error('CloudClient未初始化');
        }
        await this.cloudClient.connect();
        console.log(t('cloud.mode.connection.successful'));
        return;
      } catch (error) {
        lastError = error as Error;
        console.error(tp('cloud.mode.connection.attempt.failed', { attempt, error: error instanceof Error ? error.message : String(error) }));

        if (attempt < maxRetries) {
          const delay = Math.min(2000 * Math.pow(2, attempt - 1), 10000); // 指数退避，最大10秒
          console.log(tp('cloud.connection.retry.delay', { delay: delay/1000 }));
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error(tp('cloud.connection.failed.max.retries', { maxRetries }));
    if (lastError) {
      throw lastError;
    }
  }

  /**
   * 健康检查定时器
   */
  private healthCheckInterval?: NodeJS.Timeout;

  /**
   * 启动连接健康检查
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // 每30秒检查一次连接状态
    this.healthCheckInterval = setInterval(async () => {
      if (this.cloudMode && this.cloudClient) {
        try {
          const connectionInfo = this.cloudClient.getConnectionInfo();
          if (!connectionInfo.isConnected) {
            console.log(t('cloud.health.check.disconnected'));
            await this.reconnectToCloud();
          }
        } catch (error) {
          console.error(t('cloud.health.check.failed'), error);
        }
      }
    }, 30000);

    console.log(t('cloud.health.check.started'));
  }

  /**
   * 重新连接到云端
   */
  private async reconnectToCloud(): Promise<void> {
    try {
      if (this.cloudClient) {
        console.log(t('cloud.reconnecting'));
        await this.cloudClient.connect();
        console.log(t('cloud.reconnect.success'));
      }
    } catch (error) {
      console.error(t('cloud.reconnect.failed'), error);

      // 如果重连失败，可以选择完全重新初始化
      console.log(t('cloud.reconnect.full.retry'));
      try {
        if (this.cloudClient) {
          await this.cloudClient.disconnect();
        }

        // 使用保存的cloudServerUrl重新创建连接
        if (this.cloudServerUrl) {
          this.cloudClient = new CloudClient(this.cloudServerUrl, this, this.config);
          await this.connectWithRetry();
          console.log(t('cloud.reinit.success'));
        } else {
          console.error(t('cloud.reinit.no.url'));
        }
      } catch (reinitError) {
        console.error(tp('cloud.reinit.failed', { error: reinitError instanceof Error ? reinitError.message : String(reinitError) }));
      }
    }
  }

  /**
   * 检查电源管理设置和系统休眠状态
   */
  private async checkPowerManagement(): Promise<boolean> {
    const platform = process.platform;

    console.log('\n' + t('power.management.check.title'));

    try {
      if (platform === 'darwin') {
        // macOS - 检查系统电源设置
        const { execSync } = require('child_process');
        const result = execSync('pmset -g assertions', { encoding: 'utf8' });

        // 检查是否有活跃的防止睡眠断言
        const preventSleepActive = result.includes('PreventUserIdleSystemSleep') ||
                                   result.includes('PreventSystemSleep');

        if (!preventSleepActive) {
          console.log(t('power.management.macos.detected'));
          console.log(t('power.management.macos.warning'));
          console.log(t('power.management.macos.error'));
          console.log(t('power.management.macos.solution.title'));
          console.log(t('power.management.macos.solution.step1'));
          console.log(t('power.management.macos.solution.step2'));
          console.log(t('power.management.macos.solution.step3'));
          return false;
        }

        console.log(t('power.management.macos.ok'));
      } else if (platform === 'win32') {
        // Windows - 基础提醒，不强制退出
        console.log(t('power.management.windows.detected'));
        console.log(t('power.management.windows.warning'));
        console.log(t('power.management.windows.solution.step1'));
        console.log(t('power.management.windows.solution.step2'));
        console.log(t('power.management.windows.solution.step3'));
      } else if (platform === 'linux') {
        // Linux - 基础提醒，不强制退出
        console.log(t('power.management.linux.detected'));
        console.log(t('power.management.linux.warning'));
        console.log(t('power.management.linux.solution.step1'));
        console.log(t('power.management.linux.solution.step2'));
      }
    } catch (error) {
      console.log(t('power.management.check.failed'));
    }

    console.log(t('power.management.dev.hint') + '\n');
    return true;
  }

  /**
   * 启动服务器（仅用于云端模式）
   */
  async start(): Promise<void> {
    // 云端模式不需要启动本地服务器
    throw new Error('RemoteServer.start() 已废弃，请使用 startCloudMode() 启动云端模式');
  }



  /**
   * 🆕 启动云端模式 - 连接到云端server而不是启动本地server
   */
  async startCloudMode(cloudServerUrl: string): Promise<void> {
    try {
      const { maskServerUrl } = await import('../utils/urlMask.js');
      console.log(t('cloud.mode.starting'));
      console.log(tp('cloud.mode.server.url', { url: maskServerUrl(cloudServerUrl) }));

      this.cloudMode = true;
      this.cloudServerUrl = cloudServerUrl;

      // 🔧 先清理已存在的CloudClient，避免重复创建
      if (this.cloudClient) {
        console.log(t('cloud.cleanup.existing'));
        await this.cloudClient.disconnect();
        this.cloudClient = undefined;
      }

      // 检查电源管理设置，确保系统不会休眠导致云端连接中断
      const powerManagementOk = await this.checkPowerManagement();
      if (!powerManagementOk) {
        throw new Error('电源管理设置不当，系统可能会休眠导致云端连接中断');
      }

      // 初始化认证并验证状态 - 增加重试机制
      const authValid = await this.initializeAuthWithRetry();
      if (!authValid) {
        throw new Error('认证失败，无法启动云端模式');
      }

      // 创建CloudClient
      this.cloudClient = new CloudClient(cloudServerUrl, this, this.config);

      // 连接到云端server - 增加连接重试机制
      await this.connectWithRetry();

      console.log(t('cloud.mode.started.success'));
      console.log(t('cloud.mode.waiting.web.client'));

      // 启动连接健康检查
      this.startHealthCheck();

    } catch (error) {
      console.error('❌ 启动云端模式失败:', error);
      throw error;
    }
  }

  /**
   * 停止服务器 - 云端模式清理
   */
  async stop(): Promise<void> {
    // 清理健康检查定时器
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
      console.log(t('cloud.health.check.cleared'));
    }

    // 云端模式清理
    if (this.cloudMode && this.cloudClient) {
      await this.cloudClient.disconnect();
      console.log(t('cloud.disconnected'));
    }

    // 清理云端模式状态
    this.cloudMode = false;
    this.cloudServerUrl = undefined;

    // 清理所有sessions
    for (const sessionInfo of this.sessions.values()) {
      sessionInfo.session.cleanup();
    }
    this.sessions.clear();

    console.log(t('cloud.mode.closed'));
  }

  /**
   * 创建新session
   */
  createSession(ws: WebSocket): string {
    const sessionId = `session_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    remoteLogger.info('RemoteServer', `创建新session: ${sessionId}`);

    // 先清理过期session
    if (this.sessions.size >= this.MAX_SESSIONS) {
      const sortedSessions = Array.from(this.sessions.entries())
        .sort(([, a], [, b]) => a.lastActiveAt - b.lastActiveAt);

      const [oldestSessionId, oldestSessionInfo] = sortedSessions[0];
      remoteLogger.info('RemoteServer', `清理最旧session: ${oldestSessionId}`);
      oldestSessionInfo.session.cleanup();
      this.sessions.delete(oldestSessionId);
      console.log(tp('session.cleaned.oldest', { sessionId: oldestSessionId }));
    }

    const session = new RemoteSession(ws, this.config, sessionId);

    const sessionInfo: SessionInfo = {
      id: sessionId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      session
    };

    this.sessions.set(sessionId, sessionInfo);

    console.log(tp('session.created.new', { sessionId }));
    remoteLogger.info('RemoteServer', `session创建完成: ${sessionId}`, {
      totalSessions: this.sessions.size
    });

    return sessionId;
  }

  /**
   * 获取session
   */
  getSession(sessionId: string): RemoteSession | null {
    const sessionInfo = this.sessions.get(sessionId);
    if (sessionInfo) {
      sessionInfo.lastActiveAt = Date.now();
      return sessionInfo.session;
    }
    return null;
  }



  /**
   * 获取所有可用的session列表
   */
  getAvailableSessions(): Array<{
    id: string,
    createdAt: number,
    lastActiveAt: number,
    firstUserInput?: string,
    lastUserInput?: string
  }> {
    return Array.from(this.sessions.entries())
      .map(([id, info]) => {
        // 更新session的用户输入摘要信息
        this.updateSessionSummary(info);

        return {
          id,
          createdAt: info.createdAt,
          lastActiveAt: info.lastActiveAt,
          firstUserInput: info.firstUserInput,
          lastUserInput: info.lastUserInput
        };
      })
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt); // 按最近活跃时间排序
  }

  /**
   * 更新session的摘要信息
   */
  private updateSessionSummary(sessionInfo: SessionInfo): void {
    const uiRecords = sessionInfo.session.getAllUIDisplayRecords();
    const userInputs = uiRecords
      .filter(record => record.type === 'user_input')
      .sort((a, b) => a.timestamp - b.timestamp);

    if (userInputs.length > 0) {
      sessionInfo.firstUserInput = userInputs[0].content;
      sessionInfo.lastUserInput = userInputs[userInputs.length - 1].content;
    }
  }

  private async downloadFeishuImageToClipboard(message: FeishuImageMessage): Promise<string> {
    const clipboardDir = path.resolve(process.cwd(), '.otto', 'clipboard');
    await fs.mkdir(clipboardDir, { recursive: true });

    const response = await fetch(message.payload.imageUrl);
    if (!response.ok) {
      throw new Error(`下载飞书图片失败: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // 🎯 按真实类型确定扩展名（字节头优先，Content-Type/原文件名兜底），
    // 避免落盘扩展名与实际格式不符导致下游 media_type 推断错误、触发供应商 400。
    const ext = detectImageExtension(
      bytes,
      response.headers.get('content-type') || message.payload.mimeType,
    );

    // 取原文件名的基名（去掉原扩展名），无名时回退 feishu-image，再拼上探测出的真实扩展名。
    const rawBase = (message.payload.fileName || 'feishu-image').replace(
      /\.[a-zA-Z0-9]+$/,
      '',
    );
    const safeBase = (rawBase || 'feishu-image').replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.resolve(clipboardDir, `${safeBase}${ext}`);

    await fs.writeFile(filePath, Buffer.from(arrayBuffer));
    return filePath;
  }

  private buildCommandFromFeishuImageMessage(message: FeishuImageMessage, absolutePath: string): string {
    const text = message.payload.text?.trim();
    return text ? `${text}\n@${absolutePath}` : `@${absolutePath}`;
  }

  /**
   * 处理来自CloudClient的消息（云端模式专用）
   */
  public async handleCloudMessage(message: any): Promise<void> {
    console.log(tp('cloud.mode.handle.message', { type: message.type }));

    // 构建回包路由信息：透传原始 _cloudRoute，并补充 targetWeb（如有 webId）
    // 这保证不论消息来自 Web 还是飞书，回包都携带正确的路由信息
    const incomingRoute = (message as any)._cloudRoute;
    const incomingWebId = (message as any).webId;
    const buildReplyRoute = (): Record<string, any> => {
      const route: Record<string, any> = { ...(incomingRoute || {}) };
      if (incomingWebId) {
        route.targetWeb = incomingWebId;
      }
      return route;
    };

    try {
      switch (message.type) {
        case 'CREATE_SESSION':
        case 'create_session':
          console.log(t('cloud.mode.create.session'));

          // 在云端模式下，我们创建一个虚拟的WebSocket对象
          // 从原始消息中提取webId用于路由
          const originWebId = (message as any).webId;

          // 捕获当前消息的路由信息，供 virtualWs 回包时使用
          // 使用对象引用，以便后续 COMMAND 消息可以更新路由
          const sessionRouteRef = { current: buildReplyRoute() };

          const virtualWs = {
            readyState: 1, // WebSocket.OPEN
            send: (data: string) => {
              if (this.cloudClient) {
                const parsed = JSON.parse(data);
                // 自动注入路由信息：让 session 的所有回包都能正确路由
                if (!parsed._cloudRoute) {
                  parsed._cloudRoute = { ...sessionRouteRef.current };
                }
                this.cloudClient.sendToCloud(parsed);
              }
            },
            close: () => {
              console.log(`🌐 [VirtualWS] 关闭连接`);
            }
          } as WebSocket;

          // 使用现有的createSession方法
          const sessionId = this.createSession(virtualWs);
          console.log(tp('cloud.mode.session.created', { sessionId }));

          // 将路由引用绑到 SessionInfo 上，以便后续 COMMAND 更新路由
          {
            const si = this.sessions.get(sessionId);
            if (si) si.cloudRouteRef = sessionRouteRef;
          }

          // 重要: 初始化session，确保geminiChat和toolRegistry正确设置
          let initSuccess = false;
          try {
            const sessionInfo = this.sessions.get(sessionId);
            if (sessionInfo) {
              await sessionInfo.session.initialize();
              console.log(tp('cloud.mode.session.initialized', { sessionId }));
              initSuccess = true;
            } else {
              console.error(tp('cloud.mode.session.not.exist', { sessionId }));
            }
          } catch (error) {
            console.error(tp('cloud.mode.session.init.failed', { sessionId, error: error instanceof Error ? error.message : String(error) }));
          }

          // 🎯 发送CREATE_SESSION响应给Web端
          if (this.cloudClient) {
            const createSessionResponse = {
              id: `session_${Date.now()}`,
              type: 'create_session_response',
              payload: {
                success: initSuccess,
                sessionId: initSuccess ? sessionId : undefined,
                error: initSuccess ? undefined : 'Session创建或初始化失败'
              },
              timestamp: Date.now(),
              _cloudRoute: buildReplyRoute()
            };

            this.cloudClient.sendToCloud(createSessionResponse);
            console.log(tp('cloud.mode.create.session.response', { webId: incomingWebId || 'N/A', status: initSuccess ? 'SUCCESS' : 'FAILED' }));

            // 触发session列表同步
            // 立即同步新创建的session到云端
            if (this.cloudClient) {
              this.cloudClient.triggerSessionSync();
            }
          }
          break;

        case 'COMMAND':
          console.log(t('cloud.mode.handle.command'));

          // 从消息中提取sessionId
          const targetSessionId = (message as any).sessionId;
          if (!targetSessionId) {
            console.error(t('cloud.mode.command.no.session'));
            break;
          }

          // 查找对应的session
          const sessionInfo = this.sessions.get(targetSessionId);
          if (!sessionInfo) {
            console.error(tp('cloud.mode.session.not.exist', { sessionId: targetSessionId }));
            break;
          }

          // 更新 session 的路由信息，确保 COMMAND 回包路由到正确的来源
          if (sessionInfo.cloudRouteRef) {
            sessionInfo.cloudRouteRef.current = buildReplyRoute();
          }

          console.log(tp('cloud.mode.command.forward', { sessionId: targetSessionId }));

          try {
            // 调用session的handleCommand方法
            await sessionInfo.session.handleCommand(message as any);
            console.log(t('cloud.mode.command.success'));
          } catch (error) {
            console.error(tp('cloud.mode.command.failed', { error: error instanceof Error ? error.message : String(error) }));
          }
          if (this.cloudClient) {
            this.cloudClient.triggerSessionSync();
          }
          break;

        case 'FEISHU_IMAGE_MESSAGE':
        case 'feishu_image_message': {
          const feishuImageMessage = message as FeishuImageMessage;
          const targetSessionId = feishuImageMessage.sessionId;
          if (!targetSessionId) {
            console.error('飞书图片消息缺少 sessionId');
            break;
          }

          const sessionInfo = this.sessions.get(targetSessionId);
          if (!sessionInfo) {
            console.error(tp('cloud.mode.session.not.exist', { sessionId: targetSessionId }));
            break;
          }

          // 更新路由信息
          if (sessionInfo.cloudRouteRef) {
            sessionInfo.cloudRouteRef.current = buildReplyRoute();
          }

          try {
            const absolutePath = await this.downloadFeishuImageToClipboard(feishuImageMessage);
            const command = this.buildCommandFromFeishuImageMessage(feishuImageMessage, absolutePath);
            await sessionInfo.session.handleCommand(MessageFactory.createCommand(command));
            console.log(`飞书图片已转为本地命令输入: ${absolutePath}`);
          } catch (error) {
            console.error(`处理飞书图片消息失败: ${error instanceof Error ? error.message : String(error)}`);
          }

          if (this.cloudClient) {
            this.cloudClient.triggerSessionSync();
          }
          break;
        }

        case 'GET_MODELS_REQUEST':
        case 'get_models_request': {
          try {
            const { modelInfos } = await getAvailableModels(undefined, this.config);
            const currentModel = this.config.getModel();

            const models = modelInfos.map(m => ({
              id: m.name,
              name: m.displayName,
              current: m.name === currentModel
            }));

            // 如果没有 current (比如 current 是 auto)，手动加一个 auto
            if (!models.some(m => m.current)) {
              models.unshift({
                id: 'auto',
                name: 'Auto (Recommended)',
                current: currentModel === 'auto' || !currentModel
              });
            } else {
              // 也要确保 auto 在列表中
              if (!models.some(m => m.id === 'auto')) {
                models.unshift({
                  id: 'auto',
                  name: 'Auto (Recommended)',
                  current: currentModel === 'auto'
                });
              }
            }

            const response = MessageFactory.createGetModelsResponse(models);
            if (this.cloudClient) {
              (response as any)._cloudRoute = buildReplyRoute();
              this.cloudClient.sendToCloud(response);
            }
          } catch (error) {
            console.error(`获取模型列表失败: ${error instanceof Error ? error.message : String(error)}`);
          }
          break;
        }

        case 'GET_STATUS_REQUEST':
        case 'get_status_request': {
          try {
            const { getCliVersion } = await import('../utils/version.js');
            const { tokenLimit } = await import('otto-core');
            const version = await getCliVersion();
            const currentModel = this.config.getModel();

            // 找到与此请求相关的 session（取最近活跃的）
            let sessionId = (message as any).sessionId || '';
            let contextTokens = 0;

            if (!sessionId && this.sessions.size > 0) {
              const sorted = Array.from(this.sessions.entries())
                .sort(([, a], [, b]) => b.lastActiveAt - a.lastActiveAt);
              sessionId = sorted[0][0];
            }

            // 从 session 获取 lastPromptTokenCount
            if (sessionId) {
              const sessionInfo = this.sessions.get(sessionId);
              if (sessionInfo) {
                contextTokens = sessionInfo.session.getLastPromptTokenCount();
              }
            }

            // 获取 context window 上限（复用 tokenLimit 方法，与 Footer 一致）
            const contextMaxTokens = tokenLimit(currentModel || 'auto', this.config);

            // 获取 git branch
            let gitBranch = '';
            try {
              const { execSync } = await import('child_process');
              gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: process.cwd(),
                encoding: 'utf-8',
                timeout: 3000,
              }).trim();
            } catch {
              gitBranch = '';
            }

            const response = MessageFactory.createGetStatusResponse({
              version,
              model: currentModel || 'auto',
              contextTokens,
              contextMaxTokens,
              sessionId,
              workingDir: process.cwd(),
              gitBranch,
            });

            if (this.cloudClient) {
              (response as any)._cloudRoute = buildReplyRoute();
              this.cloudClient.sendToCloud(response);
            }
          } catch (error) {
            console.error(`获取状态信息失败: ${error instanceof Error ? error.message : String(error)}`);
          }
          break;
        }

        case 'REQUEST_UI_STATE':
        case 'request_ui_state':
          console.log(t('cloud.mode.handle.ui.state'));

          // 从消息中提取sessionId
          const uiStateSessionId = (message as any).sessionId;
          if (!uiStateSessionId) {
            console.error(t('cloud.mode.ui.state.no.session'));
            break;
          }

          // 查找对应的session
          const uiSessionInfo = this.sessions.get(uiStateSessionId);
          if (!uiSessionInfo) {
            console.error(tp('cloud.mode.session.not.exist', { sessionId: uiStateSessionId }));
            break;
          }

          console.log(tp('cloud.mode.ui.state.get', { sessionId: uiStateSessionId }));

          try {
            const uiData = uiSessionInfo.session.getUIDisplayData();

            const uiResponse = {
              id: `ui_${Date.now()}`,
              type: 'ui_state_response',
              payload: {
                completedRecords: uiData.completedRecords,
                currentRecord: uiData.currentRecord,
                isProcessing: uiData.isProcessing
              },
              timestamp: Date.now(),
              _cloudRoute: buildReplyRoute()
            };

            // 发送回云端
            if (this.cloudClient) {
              this.cloudClient.sendToCloud(uiResponse);
              console.log(tp('cloud.mode.ui.state.sent', { webId: incomingWebId || 'N/A' }));
            }
          } catch (error) {
            console.error(tp('cloud.mode.ui.state.failed', { error: error instanceof Error ? error.message : String(error) }));
          }
          break;

        case 'INTERRUPT':
        case 'interrupt':
          console.log(t('cloud.mode.handle.interrupt'));

          // 从消息中提取sessionId
          const interruptSessionId = (message as any).sessionId;
          if (!interruptSessionId) {
            console.error(t('cloud.mode.interrupt.no.session'));
            break;
          }

          // 查找对应的session并中断
          const interruptSessionInfo = this.sessions.get(interruptSessionId);
          if (!interruptSessionInfo) {
            console.error(tp('cloud.mode.session.not.exist', { sessionId: interruptSessionId }));
            break;
          }

          console.log(tp('cloud.mode.interrupt.session', { sessionId: interruptSessionId }));

          try {
            // 调用session的handleInterrupt方法
            interruptSessionInfo.session.handleInterrupt();
            console.log(t('cloud.mode.interrupt.success'));
          } catch (error) {
            console.error(tp('cloud.mode.interrupt.failed', { error: error instanceof Error ? error.message : String(error) }));
          }
          break;

        case 'CLEAR_SESSION':
        case 'clear_session':
          console.log(t('cloud.mode.handle.clear.session'));

          // 从消息中提取sessionId
          const clearSessionId = (message as any).sessionId;
          if (!clearSessionId) {
            console.error(t('cloud.mode.clear.session.no.session'));
            break;
          }

          // 查找对应的session并清理
          const clearSessionInfo = this.sessions.get(clearSessionId);
          if (!clearSessionInfo) {
            console.error(tp('cloud.mode.session.not.exist', { sessionId: clearSessionId }));
            break;
          }

          console.log(tp('cloud.mode.clear.session.cleaning', { sessionId: clearSessionId }));

          try {
            // 调用session的clearSessionData方法
            clearSessionInfo.session.clearSessionData();
            console.log(t('cloud.mode.clear.session.success'));

            // 发送清理成功响应
            if (this.cloudClient) {
              const clearResponse = {
                id: `clear_${Date.now()}`,
                type: 'clear_session_response',
                payload: {
                  success: true,
                  sessionId: clearSessionId
                },
                timestamp: Date.now(),
                _cloudRoute: buildReplyRoute()
              };
              this.cloudClient.sendToCloud(clearResponse);
            }
          } catch (error) {
            console.error(tp('cloud.mode.clear.session.failed', { error: error instanceof Error ? error.message : String(error) }));

            // 发送清理失败响应
            if (this.cloudClient) {
              const clearResponse = {
                id: `clear_${Date.now()}`,
                type: 'clear_session_response',
                payload: {
                  success: false,
                  sessionId: clearSessionId,
                  error: error instanceof Error ? error.message : String(error)
                },
                timestamp: Date.now(),
                _cloudRoute: buildReplyRoute()
              };
              this.cloudClient.sendToCloud(clearResponse);
            }
          }
          break;

        default:
          console.log(tp('cloud.mode.unhandled.message', { type: message.type }));
      }
    } catch (error) {
      console.error(tp('cloud.mode.handle.message.failed', { error: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * 🆕 获取所有session信息 - 供CloudClient使用
   */
  public getAllSessionsInfo(): Array<{
    id: string;
    createdAt: number;
    lastActiveAt: number;
    firstUserInput?: string;
    lastUserInput?: string;
    messageCount?: number;
    isProcessing?: boolean;
  }> {
    const result = [];

    for (const sessionInfo of this.sessions.values()) {
      // 更新摘要信息
      this.updateSessionSummary(sessionInfo);

      // 获取处理状态
      const uiData = sessionInfo.session.getUIDisplayData();

      result.push({
        id: sessionInfo.id,
        createdAt: sessionInfo.createdAt,
        lastActiveAt: sessionInfo.lastActiveAt,
        firstUserInput: sessionInfo.firstUserInput,
        lastUserInput: sessionInfo.lastUserInput,
        messageCount: uiData.completedRecords.length,
        isProcessing: uiData.isProcessing
      });
    }

    return result.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /**
   * 🆕 获取活跃session数量 - 供CloudClient使用
   */
  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * 🆕 检查是否为云端模式 - 供外部调用
   */
  public isCloudMode(): boolean {
    return this.cloudMode;
  }
}


/**
 * 🆕 启动云端模式的主函数
 */
export async function startCloudMode(config: Config, cloudServerUrl: string): Promise<void> {
  const server = new RemoteServer(config);

  // 处理进程退出
  process.on('SIGINT', async () => {
    console.log('\n' + t('cloud.disconnecting'));
    await server.stop(); // 断开云端连接
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n' + t('cloud.disconnecting'));
    await server.stop(); // 断开云端连接
    process.exit(0);
  });

  try {
    await server.startCloudMode(cloudServerUrl);

    // 保持服务器运行
    return new Promise((resolve) => {
      // 服务器将一直运行直到收到退出信号
    });
  } catch (error) {
    console.error(tp('cloud.mode.start.failed', { error: error instanceof Error ? error.message : String(error) }));
    throw error;
  }
}
