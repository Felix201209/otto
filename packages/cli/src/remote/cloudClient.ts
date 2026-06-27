/**
 * CloudClient - CLI端连接云端server的客户端
 * 负责建立WebSocket连接并与云端server进行通信
 */

import WebSocket from 'ws';
import { Config, type FeishuUserInfo, ProxyAuthManager } from 'otto-core';
import { RemoteServer } from './remoteServer.js';
import { t, tp } from '../ui/utils/i18n.js';
import chalk from 'chalk';
import * as os from 'os';

// ===== 消息类型定义 =====

type CloudRoute = Record<string, unknown>;
type LocalSessionInfo = ReturnType<RemoteServer['getAllSessionsInfo']>[number];

interface CloudMessage {
  type: string;
  payload?: Record<string, unknown>;
  id?: string;
  timestamp: number;
  _cloudRoute?: CloudRoute;
}

interface HeartbeatMessage extends CloudMessage {
  type: 'CLI_HEARTBEAT';
  payload: {
    cliId: string;
    activeSessions: number;
    memoryUsage: number;
    cpuUsage: number;
  };
}

interface SessionListMessage extends CloudMessage {
  type: 'CLI_SESSION_LIST';
  payload: {
    sessions: LocalSessionInfo[];
  };
}

/**
 * 云端连接客户端
 * CLI通过此客户端连接到云端server，实现远程访问
 */
export class CloudClient {
  private ws: WebSocket | null = null;
  private cliId: string;
  private userId: string = '';
  private reconnectAttempts: number = 0;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private cloudServerUrl: string,
    private localRemoteServer: RemoteServer,
    private config: Config
  ) {
    this.cliId = this.generateCLIId();
    console.log(tp('cloud.cli.id', { cliId: this.cliId }));
  }

  /**
   * 连接状态检查方法
   */
  private isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private isConnecting(): boolean {
    return this.ws?.readyState === WebSocket.CONNECTING;
  }

  private isClosed(): boolean {
    return !this.ws ||
           this.ws?.readyState === WebSocket.CLOSED ||
           this.ws?.readyState === WebSocket.CLOSING;
  }

  /**
   * 连接到云端server
   */
  async connect(): Promise<void> {
    // 已连接 - 直接返回
    if (this.isConnected()) {
      console.log(t('cloud.connection.already.exists'));
      return;
    }

    // 正在连接 - 等待完成
    if (this.isConnecting()) {
      console.log(t('cloud.connection.waiting'));
      return this.waitForConnection();
    }

    // 需要新建连接
    try {
      await this.createNewConnection();
      console.log(t('cloud.connection.established'));
      this.reconnectAttempts = 0;
    } catch (error) {
      console.error(tp('cloud.connection.failed', { error: error instanceof Error ? error.message : String(error) }));
      this.scheduleReconnect();
    }
  }

  /**
   * 创建新的连接
   */
  private async createNewConnection(): Promise<void> {
    console.log(t('cloud.mode.connecting.to.server.progress'));

    // 清理旧连接
    this.cleanup();

    // 获取认证信息
    const authToken = await this.getAuthToken();
    if (!authToken) {
      throw new Error('无法获取认证token');
    }

    const userInfo = await this.getUserInfo();
    this.userId = userInfo?.userId || userInfo?.openId || 'unknown';

    // 建立WebSocket连接
    const connectUrl = this.buildConnectUrl(authToken);
    const { maskUrl } = await import('../utils/urlMask.js');
    console.log(`${t('cloud.connection.url')} ${maskUrl(connectUrl)}`);

    this.ws = new WebSocket(connectUrl);
    this.setupEventHandlers();

    // 等待连接建立
    await this.waitForConnection();
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    console.log(t('cloud.disconnecting'));

    this.cleanup();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000); // 正常关闭
    }

    this.ws = null;
    console.log(t('cloud.disconnected'));
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    // 停止所有定时器
    [this.heartbeatInterval, this.reconnectTimer].forEach(timer => {
      if (timer) clearInterval(timer);
    });

    this.heartbeatInterval = null;
    this.reconnectTimer = null;

    // 关闭现有WebSocket连接
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws?.readyState === WebSocket.OPEN ||
          this.ws?.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  /**
   * 生成CLI ID
   */
  private generateCLIId(): string {
    const hostname = os.hostname();
    const timestamp = Date.now();
    const random = Math.random().toString(16).slice(2, 8);
    return `cli_${hostname}_${timestamp}_${random}`;
  }

  /**
   * 获取认证token
   */
  private async getAuthToken(): Promise<string> {
    try {
      const proxyAuthManager = ProxyAuthManager.getInstance();
      const token = await proxyAuthManager.getAccessToken();

      if (!token) {
        console.error('❌ 没有有效的JWT访问令牌');
        console.error('💡 请先运行以下命令进行认证：');
        console.error('   npm start  # 进行飞书认证');
        throw new Error('No valid JWT access token');
      }

      return token;
    } catch (error) {
      console.error('❌ 获取认证token失败:', error);
      throw error;
    }
  }

  /**
   * 获取用户信息
   */
  private async getUserInfo(): Promise<FeishuUserInfo> {
    try {
      const proxyAuthManager = ProxyAuthManager.getInstance();
      const userInfo = proxyAuthManager.getUserInfo();

      if (!userInfo) {
        console.error('❌ 没有找到用户认证信息');
        throw new Error('No user authentication info');
      }

      const { maskEmail } = await import('../utils/urlMask.js');
      const displayInfo = userInfo.email ? maskEmail(userInfo.email) : (userInfo.openId || 'N/A');
      console.log(tp('cloud.user.info', { name: userInfo.name, info: displayInfo }));
      return userInfo;
    } catch (error) {
      console.error('❌ 获取用户信息失败:', error);
      throw error;
    }
  }

  /**
   * 构造连接URL
   */
  private buildConnectUrl(authToken: string): string {
    const url = new URL('/ws/cli', this.cloudServerUrl.replace(/^http/, 'ws'));

    // 添加认证参数
    url.searchParams.set('token', authToken);
    url.searchParams.set('cliId', this.cliId);

    // 添加元数据
    url.searchParams.set('platform', process.platform);
    url.searchParams.set('nodeVersion', process.version);
    url.searchParams.set('workingDir', process.cwd());
    url.searchParams.set('hostname', os.hostname());
    url.searchParams.set('pid', process.pid.toString());

    return url.toString();
  }

  /**
   * 设置事件处理
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      console.log(t('cloud.websocket.connected'));
      // 连接建立后启动心跳和同步
      this.startHeartbeat();
      this.triggerSessionSync();
    });

    this.ws.on('message', async (data: Buffer) => {
      try {
        const message: CloudMessage = JSON.parse(data.toString());
        await this.handleCloudMessage(message);
      } catch (error) {
        console.error(tp('cloud.message.handle.failed', { error: error instanceof Error ? error.message : String(error) }));
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(tp('cloud.websocket.closed', { code, reason: reason.toString() }));
      this.stopTimers();

      // 非正常关闭才重连
      if (code !== 1000) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error) => {
      console.error(tp('cloud.websocket.error', { error: error instanceof Error ? error.message : String(error) }));
      // error事件后通常会触发close事件，所以这里不直接重连
    });
  }

  /**
   * 停止定时器
   */
  private stopTimers(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * 等待连接建立
   */
  private async waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not initialized'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);

      this.ws.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * 处理云端消息
   */
  private async handleCloudMessage(message: CloudMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'CLI_REGISTER_SUCCESS':
          console.log(tp('cloud.cli.register.success', {
            message: typeof message.payload?.message === 'string' ? message.payload.message : ''
          }));
          console.log('');
          console.log('✅🎉🚀 ' + chalk.green(tp('cloud.remote.access.ready', { url: 'https://www.otto.bot/remote' })));
          break;

        case 'CLI_HEARTBEAT_RESPONSE':
          // 心跳响应，无需特殊处理
          break;

        default:
          // 其他消息转发给本地RemoteServer处理
          await this.forwardToLocalServer(message);
          break;
      }
    } catch (error) {
      console.error(`❌ 处理云端消息失败 (${message.type}):`, error);
    }
  }

  /**
   * 转发消息到本地RemoteServer
   */
  private async forwardToLocalServer(message: CloudMessage): Promise<void> {
    try {
      // 保留 _cloudRoute：CLI 回包时需要透传路由信息，
      // 让服务端能正确路由到消息来源（Web / 飞书等）
      const localMessage = { ...message };

      // 转发给本地RemoteServer的消息处理逻辑
      console.log(tp('cloud.message.forward.local', { type: message.type }));

      // 调用RemoteServer的handleCloudMessage方法处理消息
      await this.localRemoteServer.handleCloudMessage(localMessage);

    } catch (error) {
      console.error(tp('cloud.message.forward.failed', { error: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * 发送消息到云端
   */
  sendToCloud(message: unknown): boolean {
    if (!this.isConnected()) {
      console.warn(t('cloud.send.unavailable'));
      return false;
    }

    try {
      this.ws!.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(tp('cloud.send.failed', { error: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    // 先清理现有的心跳定时器
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected()) {
        this.sendHeartbeat();
      }
    }, 30000); // 30秒心跳间隔
  }

  /**
   * 发送心跳
   */
  private sendHeartbeat(): void {
    const memUsage = process.memoryUsage();

    const heartbeatMessage: HeartbeatMessage = {
      type: 'CLI_HEARTBEAT',
      payload: {
        cliId: this.cliId,
        activeSessions: this.getActiveSessionCount(),
        memoryUsage: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
        cpuUsage: 0 // TODO: 实现CPU使用率获取
      },
      timestamp: Date.now()
    };

    this.sendToCloud(heartbeatMessage);
  }

  /**
   * 手动触发Session列表同步
   */
  triggerSessionSync(): void {
    if (this.isConnected()) {
      console.log(t('cloud.session.sync.triggered'));
      this.syncSessionList();
    }
  }

  /**
   * 同步Session列表到云端
   */
  private syncSessionList(): void {
    try {
      const sessions = this.getLocalSessions();

      const sessionListMessage: SessionListMessage = {
        type: 'CLI_SESSION_LIST',
        payload: { sessions },
        timestamp: Date.now()
      };

      this.sendToCloud(sessionListMessage);
      // 不打印session同步日志

    } catch (error) {
      console.error('❌ 同步Session列表失败:', error);
    }
  }

  /**
   * 获取本地sessions
   */
  private getLocalSessions(): LocalSessionInfo[] {
    try {
      return this.localRemoteServer.getAllSessionsInfo();
    } catch (error) {
      console.error(tp('cloud.session.get.failed', { error: error instanceof Error ? error.message : String(error) }));
      return [];
    }
  }

  /**
   * 获取活跃session数量
   */
  private getActiveSessionCount(): number {
    try {
      return this.localRemoteServer.getActiveSessionCount();
    } catch (error) {
      console.error(tp('cloud.session.count.failed', { error: error instanceof Error ? error.message : String(error) }));
      return 0;
    }
  }

  /**
   * 安排重连 - 超级简单版本
   */
  private scheduleReconnect(): void {
    // 清除现有定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // 如果连接正常，不需要重连
    if (this.isConnected()) {
      console.log(t('cloud.connection.normal.cancel.reconnect'));
      return;
    }

    // 计算延迟时间
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    console.log(tp('cloud.reconnect.scheduled', { delay: delay/1000, attempt: this.reconnectAttempts }));

    // 安排重连
    this.reconnectTimer = setTimeout(() => {
      if (!this.isConnected()) {
        this.connect().catch(() => this.scheduleReconnect());
      }
    }, delay);
  }

  /**
   * 获取连接状态
   */
  isCloudConnected(): boolean {
    return this.isConnected();
  }

  /**
   * 获取连接信息
   */
  getConnectionInfo() {
    return {
      cliId: this.cliId,
      userId: this.userId,
      isConnected: this.isConnected(),
      reconnectAttempts: this.reconnectAttempts,
      serverUrl: this.cloudServerUrl
    };
  }

}
