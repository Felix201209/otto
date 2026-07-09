/**
 * AI Service - 最终精简版本，直接使用CoreToolScheduler
 * 职责清晰：AI对话 + 工具结果处理，移除所有中间层
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {
  ChatMessage,
  ChatResponse,
  ToolCall as VSCodeToolCall,
  ContextInfo,
  ToolCallStatus,
  ToolCallConfirmationDetails
} from '../types/messages';
import { Logger } from '../utils/logger';

// 🎯 导入core包
import {
  OttoClient,
  Config,
  AuthType,
  ServerOttoStreamEvent,
  OttoEventType,
  ToolCallRequestInfo,
  CoreToolScheduler,
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
  OutputUpdateHandler,
  AllToolCallsCompleteHandler,
  ToolCallsUpdateHandler,
  PreToolExecutionHandler,
  parseToolOutputMessage,
  ApprovalMode,
  EditorType,
  ReadLintsTool,
  LintDiagnostic,
  LintFixTool,
  tokenLimit,
  TokenUsageInfo,
  // 🎯 导入 WaitingToolCall 类型用于工具确认状态检测
  WaitingToolCall,
  // 🔌 MCP 相关导入
  addMCPStatusChangeListener,
  removeMCPStatusChangeListener,
  getMCPServerStatus,
  getAllMCPServerStatuses,
  getMCPDiscoveryState,
  getMCPServerToolCount,
  getAllMCPServerToolCounts,
  getAllMCPServerToolNames,
  MCPServerStatus,
  MCPDiscoveryState,
  unloadMcpServer,
  UnauthorizedError,
  formatHttpErrorFallback
} from 'otto-core';

import { ContextBuilder } from './contextBuilder';
import { MultiSessionCommunicationService } from './multiSessionCommunicationService';
import { SessionMessage } from '../types/sessionTypes';
import { LoginService } from './loginService';
import { DiagnosticsMonitorService } from './diagnosticsMonitorService';
import { SmartLintNotificationService, SmartNotificationConfig } from './smartLintNotificationService';
import { LOOP_DETECTION_MESSAGES } from '../i18n/messages';

// 🎯 接口定义，避免循环依赖
interface ISessionHistoryManager {
  saveSessionHistory(sessionId: string, uiHistory: SessionMessage[], aiClientHistory?: unknown[]): Promise<void>;
  saveCompleteSessionHistory(sessionId: string): Promise<void>;
  updateSessionInfo(sessionId: string, updates: Partial<import('../types/sessionTypes').SessionInfo>): Promise<void>;
}

// 🎯 版本控制管理器接口
interface IVersionControlManager {
  recordAppliedChanges(sessionId: string, turnId: string, toolCalls: VSCodeToolCall[], description?: string): Promise<string | null>;
  getRollbackableMessageIds?(sessionId: string): Promise<string[]>;
}

export class AIService {
  private ottoClient?: OttoClient;
  private config?: Config;
  private coreToolScheduler?: CoreToolScheduler;
  private loginService: LoginService;
  private isInitialized = false;

  // 🎯 静态回调：当 AI 处理完成时调用（用于后台任务通知等）
  private static processingCompleteCallbacks: Array<(sessionId: string) => void> = [];

  /**
   * 🎯 注册处理完成回调
   */
  static onProcessingComplete(callback: (sessionId: string) => void): () => void {
    AIService.processingCompleteCallbacks.push(callback);
    return () => {
      const index = AIService.processingCompleteCallbacks.indexOf(callback);
      if (index > -1) {
        AIService.processingCompleteCallbacks.splice(index, 1);
      }
    };
  }

  // 🎯 状态管理
  private isCurrentlyResponding: boolean = false;
  private isProcessing: boolean = false;
  private currentProcessingMessageId: string | null = null;
  private currentUserMessageId: string | null = null; // 🎯 新增：当前处理的用户消息ID
  private canAbortFlow: boolean = false;
  private abortController?: AbortController;
  private currentTokenUsage?: any; // 🎯 新增：当前Token使用情况
  private sharedPromptId: string = ''; // 🎯 新增：共享prompt_id，用于保持循环检测状态（不被reset清空）

  // 🎯 通信和工具状态
  private communicationService?: MultiSessionCommunicationService;
  private sessionHistoryManager?: ISessionHistoryManager;
  private versionControlManager?: IVersionControlManager;

  // 🎯 增强的 Lint 功能
  private diagnosticsMonitor?: DiagnosticsMonitorService;
  private smartNotificationService?: SmartLintNotificationService;
  private sessionId!: string;
  private currentToolCalls: Map<string, VSCodeToolCall> = new Map();
  private toolCallUpdateCallbacks: Set<(tools: VSCodeToolCall[]) => void> = new Set();

  // 🎯 内存刷新状态跟踪
  private processedMemoryTools: Set<string> = new Set();
  private memoryRefreshCallback?: () => Promise<void>;

  // 🔌 MCP 状态管理
  private mcpStatusListener?: (serverName: string, status: MCPServerStatus) => void;
  private mcpServerStatuses: Map<string, MCPServerStatus> = new Map();
  // 🎯 工具数量现在使用全局缓存 (getMCPServerToolCount)，不再需要本地缓存
  private mcpStatusUpdateTimer?: NodeJS.Timeout; // 🎯 防抖定时器
  private lastMCPStatusUpdate: number = 0; // 🎯 上次更新时间
  private mcpListenerRegistered: boolean = false; // 🎯 防止重复注册监听器
  private pendingMCPUpdate: boolean = false; // 🎯 是否有待发送的更新（避免限流丢失）

  constructor(private logger: Logger, extensionPath?: string) {
    this.loginService = LoginService.getInstance(logger, extensionPath);
  }

  async initialize(workspaceRoot?: string, memoryOptions?: { userMemory?: string; geminiMdFileCount?: number; sessionModel?: string; userRules?: string }) {
    this.logger.info('Initializing AIService');

    try {
      // 🎯 使用传入的工作区路径，如果没有则使用当前工作目录作为回退
      const targetDir = workspaceRoot || process.cwd();
      this.logger.info(`Using workspace root: ${targetDir}`);

      // 🎯 使用传入的用户内存内容，如果没有则为空
      const userMemory = memoryOptions?.userMemory || '';
      const geminiMdFileCount = memoryOptions?.geminiMdFileCount || 0;
      const userRules = memoryOptions?.userRules || '';

      if (userMemory.length > 0) {
        this.logger.info(`📝 Using shared user memory: ${Math.round(userMemory.length / 1024)}KB from ${geminiMdFileCount} file(s)`);
      }

      // 🎯 确定使用的模型：优先使用session模型，其次使用VS Code设置中的默认模型
      let modelToUse: string;
      if (memoryOptions?.sessionModel) {
        // 如果session有模型配置，使用session的模型
        modelToUse = memoryOptions.sessionModel;
        this.logger.info(`📱 Using session model: ${modelToUse}`);
      } else {
        // 否则使用VS Code设置中的默认模型
        const vscodeConfig = vscode.workspace.getConfiguration('otto');
        modelToUse = vscodeConfig.get<string>('preferredModel', 'auto');

        // 🎯 确保 'auto' 模式被正确传递，不进行任何额外的解析或回退
        if (modelToUse === 'auto') {
          this.logger.info(`⚙️ Using default model from settings: auto (explicitly set)`);
        } else {
          this.logger.info(`⚙️ Using default model from settings: ${modelToUse}`);
        }
      }

      // 🎯 加载 MCP 服务器配置和自定义代理URL（完全容错，失败不影响主流程）
      let mcpServers: Record<string, any> = {};
      let customProxyServerUrl: string | undefined;
      const { McpEnabledStateService } = await import('./mcpEnabledStateService.js');
      const mcpEnabledService = McpEnabledStateService.getInstance();

      try {
        const { MCPSettingsService } = await import('./mcpSettingsService.js');
        const fileSettings = MCPSettingsService.loadSettings(targetDir);
        const allMcpServers = MCPSettingsService.loadMCPServers(targetDir);
        customProxyServerUrl = fileSettings.customProxyServerUrl;

        // 🎯 过滤掉禁用的服务器，防止启动时加载
        for (const [name, config] of Object.entries(allMcpServers)) {
          if (mcpEnabledService.isEnabled(name)) {
            mcpServers[name] = config;
          } else {
            this.logger.info(`🔌 [MCP] Server '${name}' is disabled, skipping load on startup`);
          }
        }

        if (Object.keys(mcpServers).length > 0) {
          this.logger.info(`Loaded ${Object.keys(mcpServers).length} active MCP server(s) from settings`);
        }
        if (customProxyServerUrl) {
          this.logger.info(`Using custom proxy server from file settings: ${customProxyServerUrl}`);
        }
      } catch (mcpLoadError) {
        this.logger.warn('⚠️ Failed to load MCP/proxy settings, continuing without them', mcpLoadError instanceof Error ? mcpLoadError : undefined);
        mcpServers = {};
      }

      // 🎯 从 VSCode 扩展设置中读取 customProxyServerUrl（优先级高于文件配置）
      const vscodeExtConfig = vscode.workspace.getConfiguration('otto');
      const vscodeCustomProxyUrl = vscodeExtConfig.get<string>('customProxyServerUrl', '');
      if (vscodeCustomProxyUrl && vscodeCustomProxyUrl.trim()) {
        customProxyServerUrl = vscodeCustomProxyUrl.trim();
        this.logger.info(`Using custom proxy server from VSCode extension settings: ${customProxyServerUrl}`);
      }

      // 🟢 从 ~/.otto/custom-models.json 加载用户配置的自定义模型
      // 这与 CLI 完全等价；webview 端添加/删除走 IPC 后会调
      // config.setCustomModels() 做热重载，新会话则在这里读到最新值。
      let customModels: Array<import('otto-core').CustomModelConfig> | undefined;
      try {
        const { CustomModelsStorageService } = await import('./customModelsStorageService.js');
        customModels = CustomModelsStorageService.getInstance(this.logger).loadCustomModels();
        if (customModels.length > 0) {
          this.logger.info(`📦 Loaded ${customModels.length} custom model(s) from ~/.otto/custom-models.json`);
        }
      } catch (cmErr) {
        this.logger.warn(
          '⚠️ Failed to load custom models, continuing without them',
          cmErr instanceof Error ? cmErr : undefined,
        );
        customModels = undefined;
      }

      this.config = new Config({
        sessionId: this.sessionId,
        targetDir: targetDir,
        debugMode: false,
        cwd: targetDir,
        model: modelToUse,
        approvalMode: ApprovalMode.DEFAULT,
        fullContext: false,
        showMemoryUsage: false,
        checkpointing: false,
        usageStatisticsEnabled: false,
        userMemory: userMemory,              // 🎯 传入用户内存内容
        geminiMdFileCount: geminiMdFileCount, // 🎯 传入文件计数
        userRules: userRules,                // 🎯 传入用户规则
        mcpServers: mcpServers,              // 🎯 传入 MCP 服务器配置
        customProxyServerUrl: customProxyServerUrl, // 🎯 传入自定义代理服务器URL
        customModels: customModels,          // 🟢 自定义模型 — 与 CLI 共享存储
        fileFiltering: {
          respectGitIgnore: true,
          respectGeminiIgnore: true,
          enableRecursiveFileSearch: true
        },
        telemetry: { enabled: false },
        vsCodePluginMode: true
      });

      await this.config.initialize();

      // 等待必需的授权初始化（会话启动前必要）
      await this.config.refreshAuth(AuthType.USE_PROXY_AUTH);

      // 🎯 异步同步云端模型配置（不阻塞会话初始化）
      // 云模型列表的更新可以在后台进行，不影响会话的启动和使用
      this.syncCloudModelsInBackground();
      this.ottoClient = this.config.getOttoClient();
      await this.initializeCoreToolScheduler();

      // 🎯 初始化增强的 lint 功能
      await this.initializeEnhancedLintFeatures();

      // 🔌 设置 MCP 状态监听器（完全容错）
      try {
        this.setupMCPStatusListener();
      } catch (mcpListenerError) {
        this.logger.warn('⚠️ Failed to setup MCP status listener, continuing without MCP', mcpListenerError instanceof Error ? mcpListenerError : undefined);
      }

      // 🔌 异步加载 MCP 工具 - 不阻塞初始化（完全容错）
      // MCP 工具会在后台加载,通过状态监听器通知前端
      // 这确保 WebView 能立即显示,不会被 MCP 连接阻塞
      try {
        this.startMCPLoadingInBackground();
      } catch (mcpStartError) {
        this.logger.warn('⚠️ Failed to start MCP background loading, continuing without MCP', mcpStartError instanceof Error ? mcpStartError : undefined);
      }

      // 🔌 立即应用 MCP 启用状态过滤（确保新会话遵守全局设置）
      try {
        await this.refreshToolsWithMcpFilter();
        this.logger.info('Applied MCP enabled filter on initialization');
      } catch (mcpFilterError) {
        this.logger.warn('⚠️ Failed to apply MCP filter on init, tools may include disabled servers', mcpFilterError instanceof Error ? mcpFilterError : undefined);
      }

      this.isInitialized = true;
      this.logger.info('✅ AIService initialized successfully');

    } catch (error) {
      this.logger.error('❌ Failed to initialize AIService', error instanceof Error ? error : undefined);
      this.isInitialized = false;
      throw new Error(`Failed to initialize AI service: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 🔌 设置 MCP 状态监听器（完全容错，防止重复注册）
   */
  private setupMCPStatusListener() {
    // 🎯 防止重复注册
    if (this.mcpListenerRegistered) {
      this.logger.debug('MCP listener already registered, skipping');
      return;
    }

    try {
      // 创建状态监听器
      this.mcpStatusListener = (serverName: string, status: MCPServerStatus) => {
        try {
          // 🎯 去重：如果状态没有变化，忽略
          const oldStatus = this.mcpServerStatuses.get(serverName);
          if (oldStatus === status) {
            return;
          }

          this.logger.info(`🔌 MCP Server '${serverName}' status: ${oldStatus || 'unknown'} -> ${status}`);
          this.mcpServerStatuses.set(serverName, status);

          // 🎯 只在连接成功时更新工具列表
          if (status === 'connected') {
            // 更新 AI 工具列表
            if (this.ottoClient) {
              this.updateAIToolsAsync().catch(err => {
                this.logger.warn('⚠️ Failed to update AI tools after MCP connection', err);
              });
            }

            // 🎯 立即发送状态（工具数量从全局缓存获取，无需本地更新）
            if (this.communicationService) {
              this.sendMCPStatusUpdateImmediate();
            }
          } else {
            // 🎯 其他状态变化使用防抖
            if (this.communicationService) {
              this.sendMCPStatusUpdate();
            }
          }
        } catch (listenerError) {
          this.logger.warn('⚠️ Error in MCP status listener', listenerError instanceof Error ? listenerError : undefined);
        }
      };

      // 注册监听器
      addMCPStatusChangeListener(this.mcpStatusListener);
      this.mcpListenerRegistered = true; // 🎯 标记已注册
      this.logger.info('MCP status listener registered');

      // 初始化当前所有服务器的状态
      const allStatuses = getAllMCPServerStatuses();
      allStatuses.forEach((status, serverName) => {
        this.mcpServerStatuses.set(serverName, status);
      });

      // 如果有服务器，发送初始状态
      if (this.mcpServerStatuses.size > 0) {
        this.logger.info(`Monitoring ${this.mcpServerStatuses.size} MCP server(s)`);
      }
    } catch (error) {
      this.logger.warn('⚠️ Failed to setup MCP status listener', error instanceof Error ? error : undefined);
    }
  }

  /**
   * 🔌 在后台启动 MCP 加载 - 完全异步,不阻塞初始化,完全容错
   *
   * 设计理念:
   * 1. AIService 初始化立即完成,WebView 可以马上显示
   * 2. MCP 服务器在后台异步连接（由 Config.initialize 触发，仅非 VSCode 模式）
   * 3. 通过状态监听器实时通知前端连接进度
   * 4. 连接成功后动态更新 AI 工具列表
   * 5. 任何 MCP 错误都不影响主流程
   *
   * 🎯 VSCode 插件模式：只需发送当前状态，不触发重新发现
   * MCP 发现由第一个 Config 触发，后续 AIService 复用全局状态
   */
  private startMCPLoadingInBackground(): void {
    // 🎯 使用 setImmediate 确保不阻塞当前调用栈
    setImmediate(async () => {
      try {
        this.logger.info('[MCP] Starting background MCP status sync...');

        // 🎯 策略1: 先快速检查一次当前状态
        const initialState = getMCPDiscoveryState();
        if (initialState === 'completed') {
          this.logger.info('[MCP] Discovery already completed, syncing status to frontend');
          await this.updateAIToolsAsync().catch(err => {
            this.logger.warn('⚠️ [MCP] Failed to update tools after discovery', err);
          });
          // 🎯 直接发送状态，工具数量从全局缓存获取
          this.sendMCPStatusUpdate();
          return;
        }

        // 🎯 策略2: 如果未完成,设置轮询监听 (最多30秒)
        const maxWaitTime = 30000; // 30秒超时
        const checkInterval = 500; // 每500ms检查一次
        let elapsed = 0;

        const pollInterval = setInterval(async () => {
          try {
            elapsed += checkInterval;

            const currentState = getMCPDiscoveryState();

            if (currentState === 'completed') {
              clearInterval(pollInterval);
              this.logger.info('[MCP] Discovery completed via polling, syncing status');
              await this.updateAIToolsAsync().catch(err => {
                this.logger.warn('⚠️ [MCP] Failed to update tools after polling', err);
              });
              // 🎯 直接发送状态，工具数量从全局缓存获取
              this.sendMCPStatusUpdate();
              return;
            }

            if (elapsed >= maxWaitTime) {
              clearInterval(pollInterval);
              this.logger.warn('[MCP] Discovery polling timeout after 30s, tools will update when servers connect');
              this.sendMCPStatusUpdate();
            }
          } catch (pollError) {
            this.logger.warn('⚠️ [MCP] Error during polling', pollError instanceof Error ? pollError : undefined);
          }
        }, checkInterval);

      } catch (error) {
        this.logger.warn('⚠️ [MCP] Background MCP sync failed, continuing without MCP', error instanceof Error ? error : undefined);
      }
    });
  }

  /**
   * 🎯 后台异步同步云端模型配置
   * 不阻塞会话初始化 - 模型列表会在后台更新
   * 使用 setImmediate 确保优先级在当前调用栈之后
   */
  private syncCloudModelsInBackground(): void {
    setImmediate(async () => {
      try {
        this.logger.debug('[Cloud Models] Starting background sync...');

        const vsCodeConfig = vscode.workspace.getConfiguration('otto');
        const cloudModels = vsCodeConfig.get<any[]>('cloudModels', []);

        if (Array.isArray(cloudModels) && cloudModels.length > 0) {
          this.config?.setCloudModels(cloudModels);
          this.logger.info(`✅ Cloud models synced in background: ${cloudModels.length} models available`);
        } else {
          this.logger.debug('[Cloud Models] No cloud models found in VSCode settings');
        }
      } catch (error) {
        this.logger.warn('[Cloud Models] Background sync failed', error instanceof Error ? error : undefined);
        // 失败不影响会话初始化，仅记录警告
      }
    });
  }

  /**
   * 🔌 异步更新 AI 工具列表
   * 🎯 关键修复：确保 toolRegistry 同步了 MCP 工具后再更新 AI 工具列表
   */
  private async updateAIToolsAsync() {
    try {
      if (!this.ottoClient || !this.config) {
        this.logger.warn('Cannot update tools: ottoClient or config not initialized');
        return;
      }

      // 🎯 关键修复：先确保 toolRegistry 同步了 MCP 工具
      // 这对于后续创建的 AIService 实例尤其重要，因为它们的 toolRegistry
      // 不会通过 discoverMcpToolsAsync() 获取 MCP 工具
      const toolRegistry = await this.config.getToolRegistry();
      await toolRegistry.discoverMcpTools();
      this.logger.debug('ToolRegistry MCP tools synced');

      // 🔌 应用 MCP 启用状态过滤（使用 refreshToolsWithMcpFilter 统一逻辑）
      await this.refreshToolsWithMcpFilter();
      this.logger.info('AI tools updated successfully with MCP filter applied');
    } catch (error) {
      this.logger.error('Failed to update AI tools', error instanceof Error ? error : undefined);
    }
  }

  /**
   * 🔌 发送 MCP 状态更新到 WebView（防抖 + 缓存优化）
   */
  private sendMCPStatusUpdate() {
    // 🎯 清除之前的定时器
    if (this.mcpStatusUpdateTimer) {
      clearTimeout(this.mcpStatusUpdateTimer);
    }

    // 🎯 防抖：延迟 300ms 后再发送，避免频繁更新
    this.mcpStatusUpdateTimer = setTimeout(async () => {
      await this.sendMCPStatusUpdateImmediate();
    }, 300);
  }

  /**
   * 🔌 立即发送 MCP 状态更新（内部方法）
   * 使用智能限流：不丢弃更新，而是延迟后重试
   */
  private async sendMCPStatusUpdateImmediate() {
    if (!this.communicationService) return;

    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastMCPStatusUpdate;

    // 🎯 智能限流：如果距离上次更新不足 300ms，延迟后重试（不丢弃）
    if (timeSinceLastUpdate < 300) {
      if (!this.pendingMCPUpdate) {
        this.pendingMCPUpdate = true;
        const delay = 300 - timeSinceLastUpdate;
        this.logger.debug(`[MCP] Rate limited, scheduling retry in ${delay}ms`);
        setTimeout(() => {
          this.pendingMCPUpdate = false;
          this.sendMCPStatusUpdateImmediate();
        }, delay);
      }
      return;
    }
    this.lastMCPStatusUpdate = now;

    try {
      // 🎯 使用全局的工具数量和名称缓存，而不是本地 ToolRegistry
      // 这确保所有 AIService 实例看到相同的工具信息
      const globalToolCounts = getAllMCPServerToolCounts();
      const globalToolNames = getAllMCPServerToolNames();

      // 🔌 导入 McpEnabledStateService 获取启用状态
      const { McpEnabledStateService } = await import('./mcpEnabledStateService.js');
      const mcpEnabledService = McpEnabledStateService.getInstance();

      const servers = Array.from(this.mcpServerStatuses.entries()).map(([name, status]) => ({
        name,
        status,
        toolCount: globalToolCounts.get(name) ?? 0,
        toolNames: globalToolNames.get(name) ?? [],
        enabled: mcpEnabledService.isEnabled(name) // 🔌 添加启用状态
      }));

      await this.communicationService.sendMessage({
        type: 'mcp_status_update',
        payload: {
          sessionId: this.sessionId,
          discoveryState: getMCPDiscoveryState(),
          servers
        }
      });

      this.logger.debug(`[MCP] Status update sent: ${servers.map(s => `${s.name}(${s.status}:${s.toolCount}:enabled=${s.enabled})`).join(', ')}`);
    } catch (error) {
      this.logger.error('Failed to send MCP status update', error instanceof Error ? error : undefined);
    }
  }

  /**
   * 🎯 向 AI 客户端历史记录中添加系统消息，使其能够感知 UI 层的状态变化（如撤销）
   */
  async addSystemMessageToHistory(content: string): Promise<void> {
    if (!this.ottoClient) {
      this.logger.warn('Cannot add system message to history: OttoClient not initialized');
      return;
    }

    try {
      // 🎯 模拟为用户消息，以便 AI 在下一轮对话中能够读取到
      this.ottoClient.addHistory({
        role: 'user',
        parts: [{ text: `[SYSTEM NOTIFICATION] ${content}` }],
      });
      this.logger.info(`✅ System notification added to AI history: ${content}`);
    } catch (error) {
      this.logger.error('❌ Failed to add system message to history', error instanceof Error ? error : undefined);
    }
  }

  /**
   * 🎯 检查AIService是否已初始化
   */
  get isServiceInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * 🎯 直接初始化CoreToolScheduler
   */
  private async initializeCoreToolScheduler() {
    if (!this.config) throw new Error('Config not initialized');

    try {
      const toolRegistryPromise = this.config.getToolRegistry();

      // 🎯 输出更新处理
      const outputUpdateHandler: OutputUpdateHandler = (toolCallId, outputChunk) => {
        const tool = this.currentToolCalls.get(toolCallId);
        if (!tool) return;

        const message = parseToolOutputMessage(outputChunk);

        // 🎯 使用类型安全的方式检查消息属性
        if (message && typeof message === 'object' && 'liveOutput' in message) {
          const liveOutput = message.liveOutput as string;
          tool.liveOutput = liveOutput;
          this.sendToolOutput(toolCallId, liveOutput);
        }

        if (message && typeof message === 'object' && 'progressText' in message) {
          const progressText = message.progressText as string;
          tool.progressText = progressText;
          this.sendToolOutput(toolCallId, progressText);
        }

        if (typeof outputChunk === 'string' &&
            !(message && typeof message === 'object' && ('liveOutput' in message || 'progressText' in message))) {
          this.sendToolOutput(toolCallId, outputChunk);
        }

        this.currentToolCalls.set(toolCallId, { ...tool });
        this.notifyToolsUpdate();
      };

      // 🎯 工具完成处理 - 核心职责
      const allToolCallsCompleteHandler: AllToolCallsCompleteHandler = (completedToolCalls) => {
        const completedVSCodeTools: VSCodeToolCall[] = [];

        completedToolCalls.forEach(coreTool => {
          const tool = this.currentToolCalls.get(coreTool.request.callId);
          if (tool) {
            // 🎯 检测是否是后台运行状态
            const resultDisplay = coreTool.response?.resultDisplay;
            const isBackgroundRunning = typeof resultDisplay === 'string' &&
                                         resultDisplay.includes('Running in background');

            tool.status = isBackgroundRunning ? ToolCallStatus.BackgroundRunning :
                          coreTool.status === 'success' ? ToolCallStatus.Success :
                          coreTool.status === 'error' ? ToolCallStatus.Error :
                          ToolCallStatus.Canceled;

            tool.endTime = Date.now();
            tool.executionDuration = tool.endTime - (tool.startTime || tool.endTime);

            if (coreTool.status === 'success') {
              tool.result = {
                success: true,
                data: coreTool.response.resultDisplay,
                executionTime: tool.executionDuration || 0,
                toolName: tool.toolName
              };
              tool.responseParts = coreTool.response.responseParts;

              // 🎯 Debug: 记录工具完成信息
              this.logger.debug(`Tool completed: ${tool.toolName} (${tool.id}), status: ${tool.status}, params:`, tool.parameters);
            } else if (coreTool.status === 'error') {
              tool.result = {
                success: false,
                error: typeof coreTool.response.resultDisplay === 'string' ?
                       coreTool.response.resultDisplay : 'Tool execution failed',
                executionTime: tool.executionDuration || 0,
                toolName: tool.toolName
              };
              tool.responseParts = coreTool.response.responseParts;
            } else if (coreTool.status === 'cancelled') {
              tool.result = {
                success: false,
                error: 'User Cancelled',
                executionTime: tool.executionDuration || 0,
                toolName: tool.toolName
              };
              tool.responseParts = coreTool.response.responseParts;
            }

            this.currentToolCalls.set(coreTool.request.callId, tool);
            completedVSCodeTools.push(tool);
          }
        });

        // 🎯 Debug: 记录即将处理的已完成工具
        this.logger.info(`🔧 About to handle batch complete with ${completedVSCodeTools.length} tools`);
        this.logger.info(`   Current user message ID: ${this.currentUserMessageId}`);
        this.logger.info(`   Current processing message ID: ${this.currentProcessingMessageId}`);

        this.notifyToolsUpdate();

        // 🎯 立即捕获当前的用户消息ID，避免异步执行时被改变
        const capturedUserMessageId = this.currentUserMessageId;
        const capturedProcessingMessageId = this.currentProcessingMessageId;

        // 使用捕获的ID来处理工具完成
        this.handleToolBatchCompleteWithIds(completedVSCodeTools, capturedUserMessageId, capturedProcessingMessageId);
      };

      // 🎯 工具状态更新处理
      const toolCallsUpdateHandler: ToolCallsUpdateHandler = (updatedCoreToolCalls) => {
        updatedCoreToolCalls.forEach(coreTool => {
          const existingTool = this.currentToolCalls.get(coreTool.request.callId);
          if (existingTool) {
            const previousStatus = existingTool.status;
            existingTool.status = this.mapCoreStatusToVSCodeStatus(coreTool.status);

            // 🎯 检测工具进入等待确认状态，发送确认请求到 webview
            // 当工具状态从非确认状态变为确认状态时，发送 tool_confirmation_request
            if (coreTool.status === 'awaiting_approval' && previousStatus !== ToolCallStatus.WaitingForConfirmation) {
              const waitingTool = coreTool as WaitingToolCall;
              if (waitingTool.confirmationDetails && this.sessionId && this.communicationService) {
                this.logger.info(`🔔 Tool awaiting confirmation: ${existingTool.toolName} (${coreTool.request.callId})`);

                // 发送确认请求到 webview，触发红色问号显示
                this.communicationService.sendToolConfirmationRequest(
                  this.sessionId,
                  coreTool.request.callId,
                  existingTool.toolName,
                  existingTool.displayName,
                  existingTool.parameters || {},
                  waitingTool.confirmationDetails
                );
              }
            }

            this.currentToolCalls.set(coreTool.request.callId, existingTool);
          }
        });

        this.notifyToolsUpdate();
      };

      const preToolExecutionHandler: PreToolExecutionHandler = async (toolCall): Promise<void> => {
        this.logger.info(`🚀 About to execute tool: ${toolCall.tool.name}`);
      };

      // 🎯 直接创建CoreToolScheduler
      this.coreToolScheduler = new CoreToolScheduler({
        toolRegistry: toolRegistryPromise,
        outputUpdateHandler,
        onAllToolCallsComplete: allToolCallsCompleteHandler,
        onToolCallsUpdate: toolCallsUpdateHandler,
        onPreToolExecution: preToolExecutionHandler,
        approvalMode: this.config.getApprovalMode() || ApprovalMode.DEFAULT,
        getPreferredEditor: () => 'vscode' as EditorType,
        config: this.config
      });

      // 🎯 Setup ReadLintsTool callback for VSCode diagnostics integration
      this.setupReadLintsCallback();

      this.logger.info('✅ CoreToolScheduler initialized');

    } catch (error) {
      this.logger.error('❌ Failed to initialize CoreToolScheduler', error instanceof Error ? error : undefined);
    }
  }

  /**
   * 🎯 设置ReadLintsTool的VSCode诊断回调
   */
  private setupReadLintsCallback() {
    const vscodeDiagnosticsCallback = async (paths?: string[]): Promise<LintDiagnostic[]> => {
      try {
        const diagnostics: LintDiagnostic[] = [];

        // 获取当前工作区的所有诊断信息
        const allDiagnostics = vscode.languages.getDiagnostics();

        for (const [uri, uriDiagnostics] of allDiagnostics) {
          // 如果指定了路径，则过滤
          if (paths && paths.length > 0) {
            const filePath = uri.fsPath;
            const shouldInclude = paths.some(requestedPath => {
              // 支持相对路径和绝对路径
              if (path.isAbsolute(requestedPath)) {
                return filePath === requestedPath || filePath.startsWith(requestedPath);
              } else {
                return filePath.endsWith(requestedPath) || filePath.includes(requestedPath);
              }
            });

            if (!shouldInclude) {
              continue;
            }
          }

          // 转换VSCode诊断到我们的格式
          for (const diagnostic of uriDiagnostics) {
            diagnostics.push({
              file: vscode.workspace.asRelativePath(uri),
              line: diagnostic.range.start.line + 1, // VSCode使用0-based，我们使用1-based
              column: diagnostic.range.start.character + 1,
              severity: this.convertVSCodeSeverity(diagnostic.severity),
              message: diagnostic.message,
              source: diagnostic.source || 'unknown',
              code: diagnostic.code?.toString(),
            });
          }
        }

        this.logger.info(`🔍 ReadLints retrieved ${diagnostics.length} diagnostics`);
        return diagnostics;

      } catch (error) {
        this.logger.error('❌ Error retrieving VSCode diagnostics', error instanceof Error ? error : undefined);
        return [];
      }
    };

    // 设置回调到ReadLintsTool
    ReadLintsTool.setCallback(vscodeDiagnosticsCallback);
    this.logger.info('✅ ReadLintsTool VSCode callback initialized');
  }

  /**
   * 🎯 转换VSCode诊断严重性到我们的格式
   */
  private convertVSCodeSeverity(severity: vscode.DiagnosticSeverity): LintDiagnostic['severity'] {
    switch (severity) {
      case vscode.DiagnosticSeverity.Error:
        return 'error';
      case vscode.DiagnosticSeverity.Warning:
        return 'warning';
      case vscode.DiagnosticSeverity.Information:
        return 'info';
      case vscode.DiagnosticSeverity.Hint:
        return 'hint';
      default:
        return 'info';
    }
  }

  /**
   * 🎯 初始化增强的 lint 功能
   */
  private async initializeEnhancedLintFeatures(): Promise<void> {
    try {
      this.logger.info('🚀 Initializing enhanced lint features...');

      // 1. 初始化诊断监控服务
      this.diagnosticsMonitor = new DiagnosticsMonitorService(this.logger);
      await this.diagnosticsMonitor.initialize();

      // 2. 初始化智能通知服务
      if (this.communicationService) {
        this.smartNotificationService = new SmartLintNotificationService(
          this.logger,
          this.communicationService,
          this.diagnosticsMonitor,
          {
            enableAutoNotifications: true,
            minErrorThreshold: 1,
            notificationCooldown: 30000, // 30 秒
            onlyNotifyOnDegradation: false, // 改进时也通知
            enableSaveNotifications: true,
            enableFileOpenNotifications: false
          }
        );
        await this.smartNotificationService.initialize();
      }

      // 3. 设置 LintFixTool 回调
      this.setupLintFixCallback();

      this.logger.info('✅ Enhanced lint features initialized successfully');

    } catch (error) {
      this.logger.error('❌ Failed to initialize enhanced lint features', error instanceof Error ? error : undefined);
    }
  }

  /**
   * 🎯 设置 LintFixTool 的 VSCode 回调
   */
  private setupLintFixCallback(): void {
    const vscodeFixCallback = async (params: any): Promise<{
      previews?: any[];
      results?: any[];
      totalFixes: number;
      success: boolean;
    }> => {
      try {
        this.logger.info('🔧 Executing VSCode lint fixes', params);

        const results: any[] = [];
        const previews: any[] = [];
        let totalFixCount = 0;

        // 获取要处理的文件
        const filesToProcess = await this.getFilesToFix(params.files);

        for (const filePath of filesToProcess) {
          const uri = vscode.Uri.file(filePath);

          try {
            // 获取当前文件的诊断信息
            const diagnostics = vscode.languages.getDiagnostics(uri);

            if (diagnostics.length === 0) {
              continue; // 没有问题需要修复
            }

            // 获取可用的代码操作（修复）
            const codeActions = await this.getCodeActionsForFile(uri, diagnostics, params);

            if (params.preview) {
              // 预览模式：收集修复信息
              const preview = await this.generateFixPreview(uri, codeActions);
              if (preview.fixes.length > 0) {
                previews.push(preview);
                totalFixCount += preview.fixes.length;
              }
            } else {
              // 应用模式：实际执行修复
              const result = await this.applyCodeActions(uri, codeActions, params);
              results.push(result);
              totalFixCount += result.appliedFixes;
            }

          } catch (fileError) {
            this.logger.error(`❌ Error processing file ${filePath}`, fileError instanceof Error ? fileError : undefined);

            if (!params.preview) {
              results.push({
                file: vscode.workspace.asRelativePath(uri),
                appliedFixes: 0,
                failedFixes: 1,
                errors: [fileError instanceof Error ? fileError.message : String(fileError)]
              });
            }
          }
        }

        this.logger.info(`✅ Lint fix operation completed. Total fixes: ${totalFixCount}`);

        return {
          previews: params.preview ? previews : undefined,
          results: params.preview ? undefined : results,
          totalFixes: totalFixCount,
          success: true
        };

      } catch (error) {
        this.logger.error('❌ Error in lint fix callback', error instanceof Error ? error : undefined);
        return {
          totalFixes: 0,
          success: false
        };
      }
    };

    // 设置回调
    LintFixTool.setCallback(vscodeFixCallback);
    this.logger.info('✅ LintFixTool VSCode callback initialized');
  }

  /**
   * 🎯 获取要修复的文件列表
   */
  private async getFilesToFix(specifiedFiles?: string[]): Promise<string[]> {
    if (specifiedFiles && specifiedFiles.length > 0) {
      // 解析指定的文件路径
      return specifiedFiles.map(file => {
        if (path.isAbsolute(file)) {
          return file;
        } else {
          // 相对路径，相对于工作区根目录
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          return workspaceRoot ? path.resolve(workspaceRoot, file) : file;
        }
      });
    } else {
      // 获取所有有诊断问题的文件
      const allDiagnostics = vscode.languages.getDiagnostics();
      const filesWithIssues: string[] = [];

      for (const [uri, diagnostics] of allDiagnostics) {
        if (diagnostics.length > 0) {
          filesWithIssues.push(uri.fsPath);
        }
      }

      return filesWithIssues;
    }
  }

  /**
   * 🎯 获取文件的代码操作（修复）
   */
  private async getCodeActionsForFile(
    uri: vscode.Uri,
    diagnostics: readonly vscode.Diagnostic[],
    params: any
  ): Promise<vscode.CodeAction[]> {
    const codeActions: vscode.CodeAction[] = [];

    // 为每个诊断获取可用的代码操作
    for (const diagnostic of diagnostics) {
      try {
        // 过滤错误类型（如果指定了）
        if (params.fixTypes && params.fixTypes.length > 0) {
          const diagnosticId = `${diagnostic.source}:${diagnostic.code}`;
          if (!params.fixTypes.some((fixType: string) => diagnosticId.includes(fixType))) {
            continue;
          }
        }

        // 获取该诊断的代码操作
        const range = diagnostic.range;
        const context = {
          diagnostics: [diagnostic]
        } as unknown as vscode.CodeActionContext;

        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          'vscode.executeCodeActionProvider',
          uri,
          range,
          context
        );

        if (actions && actions.length > 0) {
          // 只添加自动修复类型的操作
          const autoFixActions = actions.filter(action =>
            action.kind && vscode.CodeActionKind.QuickFix.contains(action.kind) &&
            action.edit && // 必须有编辑操作
            !action.command // 优先选择直接编辑操作，而不是命令
          );

          codeActions.push(...autoFixActions);
        }

      } catch (actionError) {
        this.logger.debug(`Failed to get code actions for diagnostic`, actionError instanceof Error ? actionError : undefined);
      }
    }

    // 限制修复数量
    const maxFixes = params.maxFixes || 50;
    return codeActions.slice(0, maxFixes);
  }

  /**
   * 🎯 生成修复预览
   */
  private async generateFixPreview(uri: vscode.Uri, codeActions: vscode.CodeAction[]): Promise<any> {
    const fixes = codeActions.map(action => {
      const edit = action.edit;
      if (!edit || !edit.has(uri)) {
        return null;
      }

      const textEdits = edit.get(uri);
      if (!textEdits || textEdits.length === 0) {
        return null;
      }

      // 使用第一个编辑操作作为预览
      const firstEdit = textEdits[0];

      return {
        range: {
          start: { line: firstEdit.range.start.line, character: firstEdit.range.start.character },
          end: { line: firstEdit.range.end.line, character: firstEdit.range.end.character }
        },
        newText: firstEdit.newText,
        description: action.title,
        fixKind: action.kind?.value || 'quickfix'
      };
    }).filter(fix => fix !== null);

    return {
      file: vscode.workspace.asRelativePath(uri),
      fixes
    };
  }

  /**
   * 🎯 应用代码操作
   */
  private async applyCodeActions(
    uri: vscode.Uri,
    codeActions: vscode.CodeAction[],
    params: any
  ): Promise<any> {
    const result: any = {
      file: vscode.workspace.asRelativePath(uri),
      appliedFixes: 0,
      failedFixes: 0,
      errors: []
    };

    for (const action of codeActions) {
      try {
        if (action.edit) {
          // 应用工作区编辑
          const success = await vscode.workspace.applyEdit(action.edit);
          if (success) {
            result.appliedFixes++;
          } else {
            result.failedFixes++;
            result.errors.push(`Failed to apply edit: ${action.title}`);
          }
        } else if (action.command) {
          // 执行命令
          await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments || []));
          result.appliedFixes++;
        }

      } catch (error) {
        result.failedFixes++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Error applying ${action.title}: ${errorMsg}`);
        this.logger.error(`❌ Error applying code action: ${action.title}`, error instanceof Error ? error : undefined);
      }
    }

    return result;
  }

  /**
   * 🎯 手动触发项目质量概览
   */
  async triggerProjectQualityOverview(): Promise<void> {
    if (this.smartNotificationService) {
      await this.smartNotificationService.sendProjectQualityOverview();
    } else {
      this.logger.warn('Smart notification service not initialized');
    }
  }

  /**
   * 🎯 更新智能通知配置
   */
  updateLintNotificationConfig(config: Partial<SmartNotificationConfig>): void {
    if (this.smartNotificationService) {
      this.smartNotificationService.updateConfig(config);
    }
  }

  /**
   * 🎯 处理工具批次完成 - AI核心职责
   */
  private async handleToolBatchComplete(completedTools: VSCodeToolCall[]) {
    // 使用当前的ID调用
    await this.handleToolBatchCompleteWithIds(completedTools, this.currentUserMessageId, this.currentProcessingMessageId);
  }

  /**
   * 🎯 处理工具批次完成 - 带有捕获的消息ID
   */
  private async handleToolBatchCompleteWithIds(
    completedTools: VSCodeToolCall[],
    capturedUserMessageId: string | null,
    capturedProcessingMessageId: string | null
  ) {
    if (this.isCurrentlyResponding) {
      this.logger.info(`⏳ AI still responding, skipping tool results submission`);
      return;
    }

    // 🎯 检测成功完成的save_memory工具调用
    await this.handleMemoryToolsCompleted(completedTools);

    // 🎯 记录版本信息 - 使用捕获的消息ID
    await this.recordVersionForCompletedToolsWithIds(completedTools, capturedUserMessageId, capturedProcessingMessageId);

    const toolsToSubmit = completedTools.filter(tool =>
      (tool.status === ToolCallStatus.Success ||
      tool.status === ToolCallStatus.Error ||
      tool.status === ToolCallStatus.Canceled ||
      tool.status === ToolCallStatus.BackgroundRunning) &&
      !tool.responseSubmittedToGemini
    );

    if (toolsToSubmit.length === 0) {
      if (!this.isCurrentlyResponding) {
        this.setProcessingState(false, null, false);
      }
      return;
    }

    await this.submitToolResultsToLLM(toolsToSubmit);
  }

  /**
   * 🎯 为成功完成的工具调用记录版本信息
   */
  private async recordVersionForCompletedTools(completedTools: VSCodeToolCall[]) {
    // 使用当前的ID调用
    await this.recordVersionForCompletedToolsWithIds(completedTools, this.currentUserMessageId, this.currentProcessingMessageId);
  }

  /**
   * 🎯 为成功完成的工具调用记录版本信息 - 使用捕获的消息ID
   */
  private async recordVersionForCompletedToolsWithIds(
    completedTools: VSCodeToolCall[],
    capturedUserMessageId: string | null,
    capturedProcessingMessageId: string | null
  ) {
    if (!this.versionControlManager || !this.sessionId) {
      this.logger.debug('Version control manager or sessionId not available');
      return;
    }

    // 🎯 调试：记录所有完成的工具
    this.logger.debug(`Checking ${completedTools.length} completed tools for file modifications`);
    completedTools.forEach(tool => {
      this.logger.debug(`Tool: ${tool.toolName}, Status: ${tool.status}, ID: ${tool.id}`);
    });

    // 🎯 使用更智能的方式识别文件修改工具
    const fileModifyingTools = completedTools.filter(tool => {
      // 必须是成功的工具
      if (tool.status !== ToolCallStatus.Success) {
        return false;
      }

      const toolNameLower = tool.toolName.toLowerCase();

      // 检查是否是文件相关的工具
      const isFileOperation =
        // 写入操作
        toolNameLower.includes('write') ||
        // 编辑操作
        toolNameLower.includes('edit') ||
        toolNameLower.includes('replace') ||
        toolNameLower.includes('modify') ||
        // 删除操作
        toolNameLower.includes('delete') ||
        toolNameLower.includes('remove') ||
        // Lint修复
        toolNameLower.includes('fix') ||
        // 检查参数是否有文件路径相关
        (tool.parameters && (
          tool.parameters.file_path ||
          tool.parameters.target_file ||
          tool.parameters.fileName ||
          tool.parameters.path ||
          tool.parameters.filePath
        ));

      if (isFileOperation) {
        this.logger.info(`✅ Identified file modifying tool: ${tool.toolName}`);
      }

      return isFileOperation;
    });

    if (fileModifyingTools.length === 0) {
      // 🎯 降级方案：如果没有明确的文件修改工具，但有成功的工具，也创建版本节点
      const anySuccessfulTool = completedTools.filter(tool =>
        tool.status === ToolCallStatus.Success
      );

      if (anySuccessfulTool.length > 0) {
        this.logger.warn('⚠️ No specific file tools found, but recording version for successful tools');
        this.logger.debug('Successful tools:', anySuccessfulTool.map(t => ({
          name: t.toolName,
          params: t.parameters
        })));

        // 🎯 关键修复：必须有有效的messageId，否则不创建版本节点
        let turnId = capturedUserMessageId;
        if (!turnId && capturedProcessingMessageId) {
          turnId = capturedProcessingMessageId;
        }

        if (!turnId) {
          this.logger.warn(`❌ Cannot record version in fallback: both message IDs are null`);
          return;
        }

        try {
          const versionNodeId = await this.versionControlManager.recordAppliedChanges(
            this.sessionId,
            turnId,
            anySuccessfulTool,
            `Executed ${anySuccessfulTool.length} tools`
          );

          if (versionNodeId) {
            this.logger.info(`✅ Fallback: Recorded version node: ${versionNodeId} for turn: ${turnId}`);

            // 通知前端更新
            if (this.communicationService && this.versionControlManager.getRollbackableMessageIds) {
              const rollbackableIds = await this.versionControlManager.getRollbackableMessageIds(this.sessionId);
              this.logger.info(`📋 Updated rollbackable message IDs: ${rollbackableIds.join(', ')}`);
              await this.communicationService.sendRollbackableIdsUpdate(this.sessionId, rollbackableIds);
            }
          }
        } catch (error) {
          this.logger.error('❌ Fallback version recording failed', error instanceof Error ? error : undefined);
        }
      } else {
        this.logger.warn('⚠️ No successful tools to record');
      }

      return;
    }

      this.logger.info(`🎯 Found ${fileModifyingTools.length} file modifying tools to record`);
      this.logger.debug('File modifying tools:', fileModifyingTools.map(t => ({
        name: t.toolName,
        id: t.id,
        params: t.parameters,
        result: t.result
      })));

      try {
        // 🎯 关键修复：必须使用实际捕获的用户消息ID，不允许使用虚假的fallback ID
        // 如果没有有效的messageId，就不创建版本节点（避免创建无法回退的版本）
        let turnId = capturedUserMessageId;

        // 只有当用户消息ID不可用时，才尝试使用响应消息ID
        if (!turnId && capturedProcessingMessageId) {
          this.logger.warn(`⚠️ No user message ID, using processing message ID as fallback: ${capturedProcessingMessageId}`);
          turnId = capturedProcessingMessageId;
        }

        // 如果两者都没有，完全放弃创建版本节点
        if (!turnId) {
          this.logger.warn(`❌ Cannot record version: both capturedUserMessageId and capturedProcessingMessageId are null`);
          this.logger.warn(`   - currentUserMessageId: ${this.currentUserMessageId}`);
          this.logger.warn(`   - currentProcessingMessageId: ${this.currentProcessingMessageId}`);
          return;
        }

        this.logger.info(`🔄 Recording version for turnId: ${turnId}`);
        this.logger.info(`   - capturedUserMessageId: ${capturedUserMessageId}`);
        this.logger.info(`   - capturedProcessingMessageId: ${capturedProcessingMessageId}`);
        this.logger.info(`   - Using turnId: ${turnId}`);

        const versionNodeId = await this.versionControlManager.recordAppliedChanges(
          this.sessionId,
          turnId,
          fileModifyingTools,
          `Applied ${fileModifyingTools.length} file changes`
        );

        if (versionNodeId) {
          this.logger.info(`✅ Recorded version node: ${versionNodeId} for turn: ${turnId} with ${fileModifyingTools.length} file changes`);

          // 🎯 通知前端更新可回滚消息ID列表
          if (this.communicationService && this.versionControlManager.getRollbackableMessageIds) {
            const rollbackableIds = await this.versionControlManager.getRollbackableMessageIds(this.sessionId);
            this.logger.info(`📋 Updated rollbackable message IDs: ${rollbackableIds.join(', ')}`);
            await this.communicationService.sendRollbackableIdsUpdate(this.sessionId, rollbackableIds);
          }
        } else {
          this.logger.warn(`⚠️ Failed to create version node for turn: ${turnId}`);
        }

    } catch (error) {
      this.logger.error('❌ Failed to record version for completed tools', error instanceof Error ? error : undefined);
      // 不抛出错误，版本记录失败不应该中断主流程
    }
  }

  /**
   * 🎯 处理内存工具完成，自动刷新内存内容
   */
  private async handleMemoryToolsCompleted(completedTools: VSCodeToolCall[]) {
    // 识别新的、成功的save_memory工具调用
    const newSuccessfulMemorySaves = completedTools.filter(tool =>
      tool.toolName === 'save_memory' &&
      tool.status === ToolCallStatus.Success &&
      !this.processedMemoryTools.has(tool.id)
    );

    if (newSuccessfulMemorySaves.length > 0) {
      try {
        // 执行内存刷新
        if (this.memoryRefreshCallback) {
          this.logger.info(`🔄 Detected ${newSuccessfulMemorySaves.length} successful save_memory operation(s), refreshing memory...`);
          await this.memoryRefreshCallback();
        } else {
          this.logger.warn('⚠️ Memory refresh callback not set, skipping memory refresh');
        }

        // 标记这些工具已处理，避免重复刷新
        newSuccessfulMemorySaves.forEach(tool =>
          this.processedMemoryTools.add(tool.id)
        );
      } catch (error) {
        this.logger.error('❌ Failed to refresh memory after save_memory tool execution', error instanceof Error ? error : undefined);
      }
    }
  }

  /**
   * 🎯 提交工具结果给LLM - AI核心职责
   */
  private async submitToolResultsToLLM(tools: VSCodeToolCall[]) {
    if (!this.ottoClient || tools.length === 0) return;
    if (!this.canAbortFlow || !this.isProcessing) return;

    try {
      const toolResponseParts: any[] = [];

      tools.forEach(tool => {
        if (tool.responseParts) {
          if (Array.isArray(tool.responseParts)) {
            toolResponseParts.push(...tool.responseParts);
          } else {
            toolResponseParts.push(tool.responseParts);
          }
        } else {
          let fallbackOutput: string;

          if (tool.status === ToolCallStatus.Canceled) {
            fallbackOutput = 'User Cancelled';
          } else if (tool.result?.success) {
            fallbackOutput = tool.result.data || `Tool ${tool.toolName} executed successfully`;
          } else {
            fallbackOutput = `Error in ${tool.toolName}: ${tool.result?.error || 'Unknown error'}`;
          }

          toolResponseParts.push({
            functionResponse: {
              id: tool.id,
              name: tool.toolName,
              response: { output: String(fallbackOutput) }
            }
          });
        }
      });

      tools.forEach(tool => {
        tool.responseSubmittedToGemini = true;
      });

      if (this.abortController?.signal.aborted) return;

      // 🎯 完成当前阶段，开始新阶段
      if (this.currentProcessingMessageId && this.communicationService && this.sessionId) {
        await this.communicationService.sendChatComplete(this.sessionId, this.currentProcessingMessageId, this.currentTokenUsage);
      }

      const nextStageId = `continuation-${Date.now()}`;
      if (this.communicationService && this.sessionId) {
        await this.communicationService.sendChatStart(this.sessionId, nextStageId);
        this.setProcessingState(true, nextStageId, true);
      }

      // 🎯 在开始新一轮 AI 响应流之前，确保重置工具调度器状态
      this.coreToolScheduler?.reset();

      const abortController = new AbortController();
      this.abortController = abortController;

      // 🎯 使用共享的prompt_id以保持循环检测状态不被reset清空
      const stream = this.ottoClient.sendMessageStream(
        toolResponseParts,
        abortController.signal,
        this.sharedPromptId
      );

      this.isCurrentlyResponding = true;
      this.currentToolCalls.clear();

      await this.processGeminiStreamEvents(
        stream,
        { id: nextStageId, content: [], timestamp: Date.now(), type: 'assistant' },
        undefined,
        abortController.signal,
        nextStageId
      );

    } catch (error) {
      this.logger.error('❌ Failed to submit tool results to LLM', error instanceof Error ? error : undefined);
      this.isCurrentlyResponding = false;
      this.setProcessingState(false, null, false);
      throw error;
    }
  }

  /**
   * 🎯 处理编辑消息并重新生成 - 回滚历史并重新处理
   */
  async processEditMessageAndRegenerate(messageId: string, newContent: any, context: ContextInfo): Promise<void> {
    // 🎯 使用原始消息ID作为prompt_id，保持ID一致性，允许用户回滚到编辑前的状态
    this.sharedPromptId = messageId;

    try {
      if (!this.isInitialized) {
        throw new Error('AI service is not initialized');
      }

      // 🎯 开启重新生成前，强制重置工具调度器状态
      this.coreToolScheduler?.reset();

      // 🎯 1. 回滚AI客户端历史到指定消息位置
      await this.rollbackHistoryToMessage(messageId);

      // 🎯 2. 创建更新后的消息
      const updatedMessage: ChatMessage = {
        id: messageId,
        type: 'user',
        content: newContent,
        timestamp: Date.now()
      };

      // 🎯 3. 重新处理编辑后的消息
      const result = await ContextBuilder.buildContextualContent(newContent, context);
      await this.processStreamingResponseWithParts(messageId, result.parts, `ai-response-${Date.now()}`);

    } catch (error) {
      this.logger.error('❌ Failed to process edit message', error instanceof Error ? error : undefined);

      if (error instanceof UnauthorizedError) {
        if (this.communicationService) {
          await this.communicationService.sendAuthExpired('AI API returned authentication error - login session expired');
        }
        return;
      }

      if (this.communicationService && this.sessionId) {
        // 🆕 兜底显示 HTTP code + message
        const errorMessage = `Edit Error: ${formatHttpErrorFallback(error) ?? (error instanceof Error ? error.message : String(error))}`;
        await this.communicationService.sendChatError(this.sessionId, errorMessage);
      }
    }
  }

  /**
   * 🎯 回滚AI历史到指定消息位置
   */
  private async rollbackHistoryToMessage(messageId: string): Promise<void> {
    if (!this.ottoClient) {
      throw new Error('Gemini client is not initialized');
    }

    console.log('🎯 开始回滚AI历史:', { messageId });

    // 🎯 1. 获取当前历史
    const currentHistory = this.ottoClient.getChat().getHistory();
    console.log('🎯 当前历史长度:', currentHistory.length);

    // 🎯 2. 查找目标消息位置
    let rollbackIndex = -1;
    for (let i = 0; i < currentHistory.length; i++) {
      const content = currentHistory[i];
      if (content.prompt_id === messageId) {
        rollbackIndex = i;
        break;
      }
    }

    if (rollbackIndex === -1) {
      console.warn('🎯 未找到目标消息，无需回滚:', { messageId });
      return;
    }

    console.log('🎯 找到目标消息位置:', {
      rollbackIndex,
      totalMessages: currentHistory.length,
      messagesToRemove: currentHistory.length - rollbackIndex
    });

    // 🎯 3. 截断历史 - 移除目标消息及其之后的所有消息
    const truncatedHistory = currentHistory.slice(0, rollbackIndex);

    console.log('🎯 截断后的历史长度:', truncatedHistory.length);
    console.log('🎯 被移除的消息:', {
      目标消息索引: rollbackIndex,
      目标消息prompt_id: currentHistory[rollbackIndex]?.prompt_id,
      移除的消息数量: currentHistory.length - rollbackIndex
    });

    // 🎯 4. 设置新的历史
    this.ottoClient.getChat().setHistory(truncatedHistory);

    console.log('🎯 AI历史回滚完成:', {
      原始长度: currentHistory.length,
      回滚后长度: truncatedHistory.length,
      删除的消息数: currentHistory.length - truncatedHistory.length
    });
  }

  /**
   * 🎯 处理聊天消息 - AI核心职责
   */
  async processChatMessage(message: ChatMessage, context?: ContextInfo): Promise<void> {
    // 🎯 使用前端消息ID作为prompt_id，确保回滚按钮可以正确匹配
    // 原来的格式 `msg-${message.id}-${Date.now()}` 会导致前端无法识别此ID
    this.sharedPromptId = message.id;
    const responseId = `ai-response-${Date.now()}`;

    try {
      if (!this.isInitialized) {
        throw new Error('AI service is not initialized');
      }

      // 🎯 开启新 Turn 前，强制重置工具引擎状态，防止孤儿确认导致的死锁
      this.coreToolScheduler?.reset();

      // 🎯 保存当前用户消息ID，用于版本控制
      this.currentUserMessageId = message.id;
      this.logger.info(`📝 Processing user message: ${message.id} (sharedPromptId: ${this.sharedPromptId})`);

      // 简单回退服务会在extension.ts中自动创建快照，这里不需要额外处理

      const result = await ContextBuilder.buildContextualContent(message.content, context);
      await this.processStreamingResponseWithParts(message.id, result.parts, responseId);

    } catch (error) {
      this.logger.error('❌ Failed to process AI chat', error instanceof Error ? error : undefined);

      if (error instanceof UnauthorizedError) {
        if (this.communicationService) {
          await this.communicationService.sendAuthExpired('AI API returned authentication error - login session expired');
        }
        return;
      }

      if (this.communicationService && this.sessionId) {
        // 🆕 兜底显示 HTTP code + message，避免错误被原始堆栈淹没
        const errorMessage = `Error: ${formatHttpErrorFallback(error) ?? (error instanceof Error ? error.message : String(error))}`;
        await this.communicationService.sendChatError(this.sessionId, errorMessage);
      }
    }
  }

  /**
   * 🎯 处理流式AI响应 - 支持 PartListUnion
   */
  private async processStreamingResponseWithParts(prompt_id: string, parts: import('@google/genai').PartListUnion, responseId: string): Promise<void> {
    this.setProcessingState(true, responseId, true);

    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      if (this.communicationService && this.sessionId) {
        await this.communicationService.sendChatStart(this.sessionId, responseId);
      }

      // 🎯 使用共享的prompt_id以保持循环检测状态不被reset清空
      const stream = this.ottoClient!.sendMessageStream(
        parts,
        abortController.signal,
        this.sharedPromptId
      );

      await this.processGeminiStreamEvents(
        stream,
        { id: responseId, content: [], timestamp: Date.now(), type: 'assistant' },
        undefined,
        abortController.signal,
        responseId
      );

    } catch (error) {
      this.logger.error('❌ Failed to process streaming response with parts', error instanceof Error ? error : undefined);

      // 🔐 检测认证过期错误，避免作为普通错误展示给用户
      if (error instanceof UnauthorizedError) {
        if (this.communicationService) {
          await this.communicationService.sendAuthExpired('AI API returned authentication error - login session expired');
        }
        return;
      }

      if (this.communicationService && this.sessionId) {
        // 🆕 兜底显示 HTTP code + message，避免错误被原始堆栈淹没
        const errorMessage = `Error: ${formatHttpErrorFallback(error) ?? (error instanceof Error ? error.message : String(error))}`;
        await this.communicationService.sendChatError(this.sessionId, errorMessage);
      }
    } finally {
      // this.setProcessingState(false, null, false);
      // this.abortController = undefined;
    }
  }

  /**
   * 🎯 处理Gemini流式事件
   */
  private async processGeminiStreamEvents(
    stream: AsyncIterable<ServerOttoStreamEvent>,
    originalMessage: ChatMessage,
    context: ContextInfo | undefined,
    signal: AbortSignal,
    responseId: string
  ): Promise<void> {
    const toolCallRequests: ToolCallRequestInfo[] = [];
    this.isCurrentlyResponding = true;

    try {
      for await (const event of stream) {
        if (signal.aborted) break;

        switch (event.type) {
          case OttoEventType.Content:
            if (this.communicationService && this.sessionId) {
              await this.communicationService.sendChatChunk(this.sessionId, {
                content: event.value,
                messageId: responseId,
                isComplete: false
              });
            }
            break;

          case OttoEventType.Reasoning:
            // 🎯 处理AI思考过程
            if (this.communicationService && this.sessionId) {
              await this.communicationService.sendChatReasoning(
                this.sessionId,
                event.value.text,
                responseId
              );
            }
            break;

          case OttoEventType.ToolCallRequest:
            toolCallRequests.push(event.value);
            break;

          case OttoEventType.TokenUsage:
            // 🎯 处理Token使用情况，更新Session信息
            await this.handleTokenUsage(event.value);
            break;

          case OttoEventType.LoopDetected:
            // 🎯 检测到循环 - 显示本地化的循环检测消息
            await this.handleLoopDetected((event as any).value);
            // 🎯 清空待执行的工具调用，防止已缓存的工具被执行
            toolCallRequests.length = 0;
            return;

          case OttoEventType.Error:
            // 🆕 检测流中断错误，抛出异常让外层 catch 处理自动恢复
            const errorMessage = event.value.error?.message || 'Unknown error';
            const isStreamInterrupt =
              errorMessage.includes('Stream interrupted') ||
              errorMessage.includes('terminated mid-stream') ||
              errorMessage.includes('Connection was terminated');

            if (isStreamInterrupt) {
              const streamInterruptError = new Error(errorMessage);
              (streamInterruptError as any).isStreamInterrupt = true;
              throw streamInterruptError;
            }

            // 🔐 检测认证过期错误（HTTP 401），触发自动登出
            // 🆕 必须同时包含 AUTHENTICATION_FAILED，说明是我们服务端的 401，而不是上游模型的 401
            const isAuthError =
              errorMessage.includes('AUTHENTICATION_FAILED') &&
              (errorMessage.includes('401') ||
               errorMessage.includes('Unauthorized') ||
               errorMessage.includes('Authentication required') ||
               errorMessage.includes('re-authenticate'));

            if (isAuthError && this.communicationService) {
              this.logger.warn('🔐 Authentication error detected in AI stream, triggering auth expired');
              await this.communicationService.sendAuthExpired('AI API returned authentication error - login session expired');
              this.isCurrentlyResponding = false;
              this.setProcessingState(false, null, false);
              return;
            }

            if (this.communicationService && this.sessionId) {
              // 🆕 使用 core 的 fallback 工具，确保 HTTP code + message 都展示给用户
              // 而不是直接显示原始堆栈或被吞掉。优先使用 fallback，否则退回原始 message。
              const fallback = formatHttpErrorFallback(event.value.error) ?? errorMessage;
              await this.communicationService.sendChatError(this.sessionId, `❌ AI响应时出现错误：${fallback}`);
            }
            return;

          case OttoEventType.Finished:
            this.logger.info('Stream finished');
            break;
        }
      }

      this.isCurrentlyResponding = false;

      if (toolCallRequests.length === 0) {
        this.setProcessingState(false, null, false);

        // 🎯 Send chat complete with token usage BEFORE saving history
        if (this.communicationService && this.sessionId) {
          await this.communicationService.sendChatComplete(this.sessionId, responseId, this.currentTokenUsage);
        }

        // 🎯 消息处理完成，保存历史记录
        await this.saveSessionHistoryIfAvailable();
      }

      // 🎯 直接调度工具
      if (toolCallRequests.length > 0 && this.coreToolScheduler) {
        await this.scheduleToolCalls(toolCallRequests, signal);
      }

    } catch (streamError) {
      // 🆕 检测流中断错误（TCP连接中断、服务器重启等）
      const isStreamInterruptError = streamError instanceof Error && (
        (streamError as any).isStreamInterrupt ||
        streamError.message.includes('Stream interrupted') ||
        streamError.message.includes('terminated mid-stream') ||
        streamError.message.includes('Connection was terminated')
      );

      if (isStreamInterruptError) {
        this.logger.warn('⚠️ Stream interrupted, attempting auto-recovery...');

        // 🆕 通过专门的消息类型发送恢复倒计时通知给 WebView
        if (this.communicationService && this.sessionId) {
          const countdownTotal = 10;

          // 发送开始恢复的消息
          await this.communicationService.sendStreamRecoveryStart(this.sessionId, countdownTotal);

          // 倒计时
          for (let remaining = countdownTotal; remaining > 0; remaining--) {
            await this.communicationService.sendStreamRecoveryCountdown(this.sessionId, remaining);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          // 发送恢复结束的消息
          await this.communicationService.sendStreamRecoveryEnd(this.sessionId);
        }

        // 🆕 重置状态并自动发送继续消息
        this.isCurrentlyResponding = false;

        // 自动发送继续消息
        const continueMessage = '[系统] 上次回复因网络问题中断了，请从中断处继续。';
        this.logger.info(`🔄 Auto-retry: "${continueMessage}"`);

        try {
          // 重新发送继续消息
          await this.processStreamingResponseWithParts(
            responseId,
            [{ text: continueMessage }],
            `recovery-${Date.now()}`
          );
        } catch (retryError) {
          this.logger.error('❌ Auto-recovery failed', retryError instanceof Error ? retryError : undefined);
          this.setProcessingState(false, null, false);
          if (this.communicationService && this.sessionId) {
            await this.communicationService.sendChatError(this.sessionId, `❌ 自动恢复失败，请重新发送消息`);
          }
        }
        return;
      }

      // 🔐 检测认证过期错误（核心层抛出的 UnauthorizedError）
      if (streamError instanceof UnauthorizedError) {
        this.logger.warn('🔐 UnauthorizedError caught in stream processing, triggering auth expired');
        this.isCurrentlyResponding = false;
        this.setProcessingState(false, null, false);
        if (this.communicationService) {
          await this.communicationService.sendAuthExpired('AI API returned authentication error - login session expired');
        }
        return;
      }

      this.logger.error('Error processing stream events', streamError instanceof Error ? streamError : undefined);
      this.isCurrentlyResponding = false;
      this.setProcessingState(false, null, false);

      if (this.communicationService && this.sessionId) {
        // 🆕 把 streamError 的 HTTP code + message 暴露出来，便于排查
        const detail = formatHttpErrorFallback(streamError) ?? (streamError instanceof Error ? streamError.message : String(streamError));
        await this.communicationService.sendChatError(this.sessionId, `❌ 处理AI流式响应时出错：${detail}`);
      }
    }
  }

  /**
   * 🎯 处理Token使用情况，更新Session信息
   */
  private async handleTokenUsage(tokenUsageInfo: TokenUsageInfo): Promise<void> {
    try {
      if (!this.sessionHistoryManager || !this.sessionId || !this.config) {
        return;
      }

      // 获取当前模型的token限制
      const currentModel = this.config.getModel();
      const cloudModelInfo = this.config.getCloudModelInfo(currentModel);
      const cloudModels = this.config.getCloudModels();
      this.logger.info(`📊 [Context Left Debug] currentModel="${currentModel}", cloudModelInfo=${JSON.stringify(cloudModelInfo)}, availableModels=${cloudModels?.map(m => m.name).join(', ')}`);
      const currentTokenLimit = tokenLimit(currentModel, this.config);

      // Calculate cache hit rate
      let cacheHitRate = 0;
      if (tokenUsageInfo.inputTokens > 0 && tokenUsageInfo.cacheReadInputTokens) {
        cacheHitRate = tokenUsageInfo.cacheReadInputTokens / tokenUsageInfo.inputTokens;
      }

      // 构建token使用情况更新
      const tokenUsageUpdate = {
        tokenUsage: {
          inputTokens: tokenUsageInfo.inputTokens,
          outputTokens: tokenUsageInfo.outputTokens,
          totalTokens: tokenUsageInfo.totalTokens,
          tokenLimit: currentTokenLimit,
          cachedContentTokens: tokenUsageInfo.cachedContentTokens,
          cacheCreationInputTokens: tokenUsageInfo.cacheCreationInputTokens,
          cacheReadInputTokens: tokenUsageInfo.cacheReadInputTokens,
          creditsUsage: tokenUsageInfo.creditsUsage,
          cacheHitRate: cacheHitRate,
          model: tokenUsageInfo.model // 🎯 传入真实使用的模型名称
        }
      };

      // 🎯 保存当前Token使用情况
      this.currentTokenUsage = tokenUsageUpdate.tokenUsage;

      // 更新Session信息
      await this.sessionHistoryManager.updateSessionInfo(this.sessionId, tokenUsageUpdate);

      // 🎯 详细的 Context Left 调试日志
      const usedPercentage = (tokenUsageInfo.totalTokens / currentTokenLimit) * 100;
      const contextLeftPercentage = Math.max(0, 100 - usedPercentage);
      this.logger.info(`📊 [Context Left Debug] totalTokens=${tokenUsageInfo.totalTokens}, tokenLimit=${currentTokenLimit}, used=${usedPercentage.toFixed(2)}%, contextLeft=${Math.round(contextLeftPercentage)}%`);
      this.logger.info(`📊 [Context Left Debug] inputTokens=${tokenUsageInfo.inputTokens}, outputTokens=${tokenUsageInfo.outputTokens}, cachedContentTokens=${tokenUsageInfo.cachedContentTokens || 0}`);

    } catch (error) {
      this.logger.error('❌ Failed to handle token usage', error instanceof Error ? error : undefined);
    }
  }

  /**
   * 🎯 处理循环检测 - 向用户和AI显示循环原因和解决方案
   */
  private async handleLoopDetected(loopType?: string): Promise<void> {
    try {
      if (!this.communicationService || !this.sessionId) {
        return;
      }

      // 🎯 检测系统语言 - 简单的语言检测，根据VSCode环境
      // 如果无法确定，默认为英文
      const isChineseLocale = () => {
        try {
          // 尝试从VSCode配置获取语言设置
          const config = vscode.workspace.getConfiguration();
          const locale = config.get<string>('locale') ||
                        process.env.LANG ||
                        process.env.LANGUAGE ||
                        '';
          return /^zh/i.test(locale) || /^zh-/i.test(locale);
        } catch {
          return false;
        }
      };

      const useChinese = isChineseLocale();

      // 🎯 根据循环类型构建本地化消息
      let loopMessage = '';

      switch (loopType) {
        case 'consecutive_identical_tool_calls':
          loopMessage = useChinese
            ? `${LOOP_DETECTION_MESSAGES.CONSECUTIVE_TOOL_CALLS_TITLE_ZH}\n${LOOP_DETECTION_MESSAGES.CONSECUTIVE_TOOL_CALLS_DESCRIPTION_ZH}\n${LOOP_DETECTION_MESSAGES.CONSECUTIVE_TOOL_CALLS_ACTION_ZH}`
            : `${LOOP_DETECTION_MESSAGES.CONSECUTIVE_TOOL_CALLS_TITLE}\n${LOOP_DETECTION_MESSAGES.CONSECUTIVE_TOOL_CALLS_DESCRIPTION}\n${LOOP_DETECTION_MESSAGES.CONSECUTIVE_TOOL_CALLS_ACTION}`;
          break;

        case 'chanting_identical_sentences':
          loopMessage = useChinese
            ? `${LOOP_DETECTION_MESSAGES.CHANTING_IDENTICAL_SENTENCES_TITLE_ZH}\n${LOOP_DETECTION_MESSAGES.CHANTING_IDENTICAL_SENTENCES_DESCRIPTION_ZH}\n${LOOP_DETECTION_MESSAGES.CHANTING_IDENTICAL_SENTENCES_ACTION_ZH}`
            : `${LOOP_DETECTION_MESSAGES.CHANTING_IDENTICAL_SENTENCES_TITLE}\n${LOOP_DETECTION_MESSAGES.CHANTING_IDENTICAL_SENTENCES_DESCRIPTION}\n${LOOP_DETECTION_MESSAGES.CHANTING_IDENTICAL_SENTENCES_ACTION}`;
          break;

        case 'llm_detected_loop':
          loopMessage = useChinese
            ? `${LOOP_DETECTION_MESSAGES.LLM_DETECTED_LOOP_TITLE_ZH}\n${LOOP_DETECTION_MESSAGES.LLM_DETECTED_LOOP_DESCRIPTION_ZH}\n${LOOP_DETECTION_MESSAGES.LLM_DETECTED_LOOP_ACTION_ZH}`
            : `${LOOP_DETECTION_MESSAGES.LLM_DETECTED_LOOP_TITLE}\n${LOOP_DETECTION_MESSAGES.LLM_DETECTED_LOOP_DESCRIPTION}\n${LOOP_DETECTION_MESSAGES.LLM_DETECTED_LOOP_ACTION}`;
          break;

        default:
          loopMessage = useChinese
            ? '🔄 检测到对话循环，对话已停止'
            : '🔄 Repetitive loop detected, conversation stopped';
      }

      this.logger.warn(`🔴 Loop detected: ${this.sessionId} (type: ${loopType || 'unknown'})`);

      // 🎯 添加反馈消息到AI历史，让AI理解为什么被停止（与Core层同步）
      const feedbackMessage = this.generateLoopFeedbackForAI(loopType);
      if (this.ottoClient) {
        try {
          this.ottoClient.addHistory({
            role: 'user',
            parts: [{ text: feedbackMessage }],
          });
          this.logger.info(`✅ Loop detection feedback added to AI history`);
        } catch (error) {
          this.logger.warn('Failed to add loop feedback to AI history', error instanceof Error ? error : undefined);
        }
      }

      // 🎯 发送循环检测消息给前端
      await this.communicationService.sendChatError(this.sessionId, loopMessage);

      // 🎯 停止处理状态
      this.isCurrentlyResponding = false;
      this.setProcessingState(false, null, false);

      // 🎯 保存会话历史
      await this.saveSessionHistoryIfAvailable();

    } catch (error) {
      this.logger.error('Failed to handle loop detection', error instanceof Error ? error : undefined);
    }
  }

  /**
   * 🎯 为AI生成循环检测反馈消息（与Core层addLoopDetectionFeedbackToHistory同步）
   */
  private generateLoopFeedbackForAI(loopType?: string): string {
    switch (loopType) {
      case 'consecutive_identical_tool_calls':
        return `🔴 LOOP DETECTED: You were repeatedly calling the same tool, which wastes context and API quota.

⚠️ Why this happened:
• You may be stuck in the same approach
• The current direction is not productive
• Missing or unclear task context

✅ What to do next:
1. Review the task: Was the original request clear enough?
2. Take a different approach: Try exploring from a different angle
3. Ask for clarification: Request more specific guidance or context
4. Example: Instead of reading many files, focus on specific files mentioned in the error or task

💡 Tips:
• Break complex tasks into smaller, focused subtasks
• Be explicit about what you're trying to achieve
• When stuck, ask for hints or a different approach`;

      case 'chanting_identical_sentences':
        return `🔴 LOOP DETECTED: You were repeatedly generating the same text, which indicates being stuck.

⚠️ Why this happened:
• The model may be stuck on a specific pattern or thought
• Unable to progress beyond a certain point
• May need external guidance to break the pattern

✅ What to do next:
1. Acknowledge the issue: Understand what went wrong
2. Take a fresh approach: Try a completely different angle
3. Ask for help: Request guidance on how to proceed differently
4. Example: If stuck explaining something, ask to try a different explanation method`;

      case 'llm_detected_loop':
        return `🔴 LOOP DETECTED: The AI analysis detected that you're not making meaningful progress.

⚠️ Why this happened:
• The current approach is not advancing the task
• May be exploring unproductive paths
• Need to refocus on the core objective

✅ What to do next:
1. Clarify the goal: Restate what needs to be accomplished
2. Provide constraints: Give clear boundaries or requirements
3. Break it down: Divide into smaller, achievable steps
4. Change direction: Try a fundamentally different approach`;

      default:
        return `🔴 LOOP DETECTED: The conversation entered a repetitive loop without making progress.

✅ What to do next:
• Provide more specific guidance or constraints
• Clarify what you're trying to achieve
• Try a different approach to the problem
• Start fresh with a new session if needed`;
    }
  }

  /**
   * 🎯 直接调度工具调用
   */
  private async scheduleToolCalls(toolCallRequests: ToolCallRequestInfo[], signal: AbortSignal) {
    if (!this.coreToolScheduler) return;

    try {
      const toolRegistry = await this.config!.getToolRegistry();

      // 🎯 创建VSCode工具调用对象
      for (const request of toolCallRequests) {
        let displayName = request.name; // 默认显示名称为原始名称
        let description = '';

        try {
          const tool = toolRegistry.getTool(request.name);
          if (tool) {
            displayName = tool.displayName;
            try {
              description = tool.getDescription(request.args);
            } catch {
              description = `将执行 ${displayName}`;
            }
          }
        } catch (error) {
          this.logger.warn(`Failed to get tool ${request.name} from registry`, error);
        }

        const toolCall: VSCodeToolCall = {
            id: request.callId,
          toolName: request.name, // 🎯 保存原始工具名称
          displayName: displayName, // 🎯 保存显示名称
          description: description,
            parameters: request.args,
          status: ToolCallStatus.Scheduled,
          startTime: Date.now(),
          responseSubmittedToGemini: false,
          // 🎯 为 batch 工具提取子工具信息
          batchSubTools: request.name === 'batch' ? this.extractBatchSubTools(request.args, toolRegistry) : undefined
        };

        this.currentToolCalls.set(request.callId, toolCall);
      }

      this.notifyToolsUpdate();

      // 🎯 直接调用CoreToolScheduler - 🔥 关键修复：添加 await 以确保所有异步工具执行完成
      try {
        await this.coreToolScheduler.schedule(toolCallRequests, signal);
        this.logger.info(`✅ Core scheduler execution completed`);
      } catch (error) {
        this.logger.error('❌ Core scheduler execution failed', error instanceof Error ? error : undefined);
        this.handleToolSchedulingError(toolCallRequests, error);
      }

        } catch (error) {
      this.logger.error('❌ Failed to schedule tools', error instanceof Error ? error : undefined);
      this.handleToolSchedulingError(toolCallRequests, error);
    }
  }

  // 🎯 工具相关处理方法

  private sendToolOutput(toolId: string, outputText: string) {
    if (this.communicationService) {
      this.communicationService.sendToolMessage(this.sessionId, {
        id: `tool-output-${toolId}-${Date.now()}`,
        toolId: toolId,
        toolName: undefined,
        content: outputText,
        timestamp: Date.now(),
        toolMessageType: 'output',
        toolStatus: undefined
      });
    }
  }

  private notifyToolsUpdate() {
    const tools = Array.from(this.currentToolCalls.values());

    if (this.communicationService && this.sessionId) {
      this.communicationService.sendToolCallsUpdate(
        this.sessionId,
        tools,
        this.currentProcessingMessageId || undefined
      );
    }

    this.toolCallUpdateCallbacks.forEach(callback => {
      try {
        callback(tools);
      } catch (error) {
        this.logger.error('Tool update callback error', error instanceof Error ? error : undefined);
      }
    });
  }

  /**
   * 🎯 为 batch 工具提取子工具信息用于 UI 友好显示
   */
  private extractBatchSubTools(
    args: Record<string, unknown>,
    toolRegistry: { getTool: (name: string) => { displayName: string } | undefined }
  ): { tool: string; displayName: string; summary: string }[] | undefined {
    const toolCalls = args.tool_calls as Array<{ tool: string; parameters: Record<string, unknown> }> | undefined;
    if (!toolCalls || !Array.isArray(toolCalls)) {
      return undefined;
    }

    return toolCalls.map(call => ({
      tool: call.tool,
      displayName: this.getToolDisplayNameForBatch(call.tool, toolRegistry),
      summary: this.generateBatchSubToolSummary(call.tool, call.parameters),
    }));
  }

  /**
   * 获取工具的显示名称（用于 batch 子工具）
   */
  private getToolDisplayNameForBatch(
    toolName: string,
    toolRegistry: { getTool: (name: string) => { displayName: string } | undefined }
  ): string {
    try {
      const tool = toolRegistry.getTool(toolName);
      if (tool) {
        return tool.displayName;
      }
    } catch {
      // ignore
    }

    // 回退到静态映射
    const TOOL_DISPLAY_NAME_MAP: Record<string, string> = {
      'read_file': 'ReadFile',
      'read_many_files': 'ReadManyFiles',
      'write_file': 'WriteFile',
      'replace': 'Edit',
      'multiedit': 'MultiEdit',
      'delete_file': 'DeleteFile',
      'run_shell_command': 'Bash',
      'search_file_content': 'SearchText',
      'glob': 'FindFiles',
      'list_directory': 'ReadFolder',
      'web_fetch': 'WebFetch',
      'web_search': 'WebSearch',
      'google_web_search': 'WebSearch', // 旧名兼容：改名前的历史会话回放仍能正确显示
      'save_memory': 'SaveMemory',
      'task': 'Task',
      'todo_write': 'TodoWrite',
      'lsp': 'LSP',
      'read_lints': 'ReadLints',
      'lint_fix': 'LintFix',
      'batch': 'Batch',
      'codesearch': 'CodeSearch',
    };
    return TOOL_DISPLAY_NAME_MAP[toolName] || toolName;
  }

  /**
   * 为 batch 工具的子工具生成简短摘要
   */
  private generateBatchSubToolSummary(tool: string, parameters: Record<string, unknown>): string {
    const extractPathSummary = (path: string | undefined): string => {
      if (!path) return '';
      const parts = path.replace(/\\/g, '/').split('/');
      const fileName = parts[parts.length - 1];
      return fileName.length > 40 ? fileName.substring(0, 37) + '...' : fileName;
    };

    switch (tool) {
      case 'read_file':
        return extractPathSummary(parameters.absolute_path as string | undefined);
      case 'read_many_files': {
        const paths = parameters.paths as string[] | undefined;
        if (paths && paths.length > 0) {
          return paths.length === 1 ? extractPathSummary(paths[0]) : `${paths.length} files`;
        }
        return '';
      }
      case 'write_file':
        return extractPathSummary(parameters.file_path as string | undefined);
      case 'replace':
      case 'multiedit':
        return extractPathSummary(parameters.file_path as string | undefined);
      case 'delete_file':
        return extractPathSummary(parameters.file_path as string | undefined);
      case 'run_shell_command': {
        const cmd = parameters.command as string | undefined;
        if (cmd) {
          return cmd.length > 30 ? cmd.substring(0, 27) + '...' : cmd;
        }
        return '';
      }
      case 'search_file_content': {
        const pattern = parameters.pattern as string | undefined;
        return pattern ? `"${pattern.substring(0, 20)}${pattern.length > 20 ? '...' : ''}"` : '';
      }
      case 'glob':
        return (parameters.pattern as string) || '';
      case 'list_directory':
        return extractPathSummary(parameters.path as string | undefined);
      case 'web_fetch': {
        const prompt = parameters.prompt as string | undefined;
        const urlMatch = prompt?.match(/https?:\/\/[^\s]+/);
        return urlMatch ? urlMatch[0].substring(0, 40) : '';
      }
      case 'web_search':
      case 'google_web_search': // 旧名兼容
        return (parameters.query as string)?.substring(0, 30) || '';
      default:
        return '';
    }
  }

  private handleToolSchedulingError(requests: ToolCallRequestInfo[], error: any) {
    const failedTools: VSCodeToolCall[] = [];

    requests.forEach(request => {
      const tool = this.currentToolCalls.get(request.callId);
      if (tool) {
        tool.status = ToolCallStatus.Error;
        tool.result = {
          success: false,
          error: `Failed to schedule tool: ${error instanceof Error ? error.message : String(error)}`,
          executionTime: 0,
          toolName: tool.toolName
        };

        // 🎯 构造 responseParts 以便回传给 AI
        tool.responseParts = [{
          functionResponse: {
            id: request.callId,
            name: tool.toolName,
            response: {
              error: tool.result.error
            }
          }
        }];

        this.currentToolCalls.set(request.callId, tool);
        failedTools.push(tool);
      }
    });
    this.notifyToolsUpdate();

    // 🎯 将调度失败的错误回传给 AI，让 AI 知道工具调用失败了
    if (failedTools.length > 0) {
      const capturedUserMessageId = this.currentUserMessageId;
      const capturedProcessingMessageId = this.currentProcessingMessageId;

      this.logger.info(`⚠️ Reporting ${failedTools.length} scheduling errors back to AI`);

      // 异步调用以避免阻塞当前流程
      this.handleToolBatchCompleteWithIds(failedTools, capturedUserMessageId, capturedProcessingMessageId).catch(err => {
        this.logger.error('❌ Failed to report scheduling errors to AI', err instanceof Error ? err : undefined);
      });
    }
  }

  // 🎯 工具确认方法

  /**
   * @param toolId
   * @param userInput  兼容旧路径：edit 工具行内修改后的 newContent
   * @param outcome    'proceed_once' | 'proceed_always' | 'proceed_always_project' 等
   * @param extra      🎯 AskUserQuestion 的结构化答案（answers / annotations / feedback）
   */
  async approveToolCall(
    toolId: string,
    userInput?: string,
    outcome?: string,
    extra?: {
      answers?: Record<string, string>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
      feedback?: string;
    }
  ): Promise<void> {
    if (!this.coreToolScheduler) throw new Error('Core scheduler not available');

    const coreOutcome: ToolConfirmationOutcome =
      outcome === 'proceed_always' ? ToolConfirmationOutcome.ProceedAlways :
      outcome === 'proceed_always_tool' ? ToolConfirmationOutcome.ProceedAlwaysTool :
      outcome === 'proceed_always_server' ? ToolConfirmationOutcome.ProceedAlwaysServer :
      outcome === 'proceed_always_project' ? ToolConfirmationOutcome.ProceedAlwaysProject :
      outcome === 'modify_with_editor' ? ToolConfirmationOutcome.ModifyWithEditor :
      ToolConfirmationOutcome.ProceedOnce;

    // 🎯 构造 payload：优先携带 AskUserQuestion 的结构化答案，
    // 兜底走旧的 newContent（edit 工具的行内改写路径）。
    let confirmationPayload: ToolConfirmationPayload | undefined;
    if (extra?.answers || extra?.annotations || extra?.feedback) {
      confirmationPayload = {
        ...(extra.answers && { answers: extra.answers }),
        ...(extra.annotations && { annotations: extra.annotations }),
        ...(extra.feedback && { feedback: extra.feedback }),
      };
    } else if (userInput) {
      confirmationPayload = { newContent: String(userInput) };
    }

    this.coreToolScheduler.handleConfirmationResponse(toolId, coreOutcome, confirmationPayload);
  }

  async rejectToolCall(toolId: string, reason?: string): Promise<void> {
    if (!this.coreToolScheduler) throw new Error('Core scheduler not available');

    const coreOutcome: ToolConfirmationOutcome = ToolConfirmationOutcome.Cancel;
    const confirmationPayload: ToolConfirmationPayload | undefined = reason ? { newContent: String(reason) } : undefined;

    this.coreToolScheduler.handleConfirmationResponse(toolId, coreOutcome, confirmationPayload);
  }

  // 🎯 辅助方法

  private mapCoreStatusToVSCodeStatus(coreStatus: string): ToolCallStatus {
    switch (coreStatus) {
      case 'scheduled': return ToolCallStatus.Scheduled;
      case 'validating': return ToolCallStatus.Validating;
      case 'executing': return ToolCallStatus.Executing;
      case 'awaiting_approval': return ToolCallStatus.WaitingForConfirmation;
      case 'success': return ToolCallStatus.Success;
      case 'error': return ToolCallStatus.Error;
      case 'cancelled': return ToolCallStatus.Canceled;
      default: return ToolCallStatus.Error;
    }
  }

  private setProcessingState(isProcessing: boolean, messageId: string | null = null, canAbort = false): void {
    const wasProcessing = this.isProcessing;
    this.isProcessing = isProcessing;
    this.currentProcessingMessageId = messageId;
    this.canAbortFlow = canAbort;

    if (this.communicationService && this.sessionId) {
      this.communicationService.sendFlowStateUpdate(this.sessionId, isProcessing, messageId || undefined, canAbort);

      // 🎯 当处理完成时，发送可回滚ID列表给UI
      if (!isProcessing) {
        const rollbackableIds = this.getRollbackableMessageIds();
        this.communicationService.sendRollbackableIdsUpdate(this.sessionId, rollbackableIds);

        // 🎯 触发处理完成回调（用于后台任务通知等）
        if (wasProcessing) {
          for (const callback of AIService.processingCompleteCallbacks) {
            try {
              callback(this.sessionId);
            } catch (e) {
              this.logger.error('Error in processing complete callback', e instanceof Error ? e : undefined);
            }
          }
        }
      }
    }
  }

  async abortCurrentFlow(): Promise<void> {
    if (!this.canAbortFlow) return;

    try {
      this.canAbortFlow = false;

      if (this.abortController) {
        this.abortController.abort();
        this.abortController = undefined;
      }

      this.isCurrentlyResponding = false;
      this.setProcessingState(false, null, false);

      if (this.currentProcessingMessageId && this.communicationService && this.sessionId) {
          await this.communicationService.sendChatComplete(this.sessionId, this.currentProcessingMessageId);
      }

    } catch (error) {
      this.logger.error('❌ Failed to abort flow', error instanceof Error ? error : undefined);
      this.setProcessingState(false, null, false);
      throw error;
    }
  }

  // 🎯 公共API方法

  setCommunicationService(communicationService: MultiSessionCommunicationService) {
    this.communicationService = communicationService;
  }

  setSessionHistoryManager(sessionHistoryManager: ISessionHistoryManager) {
    this.sessionHistoryManager = sessionHistoryManager;
  }

  setVersionControlManager(versionControlManager: IVersionControlManager) {
    this.versionControlManager = versionControlManager;
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  setMemoryRefreshCallback(callback: () => Promise<void>) {
    this.memoryRefreshCallback = callback;
  }

  getCurrentToolCalls(): VSCodeToolCall[] {
    return Array.from(this.currentToolCalls.values());
  }

  onToolCallsUpdate(callback: (tools: VSCodeToolCall[]) => void): () => void {
    this.toolCallUpdateCallbacks.add(callback);

    const currentTools = this.getCurrentToolCalls();
    if (currentTools.length > 0) {
      callback(currentTools);
    }

    return () => {
      this.toolCallUpdateCallbacks.delete(callback);
    };
  }

  getCurrentFlowState(): { isProcessing: boolean; canAbort: boolean; currentMessageId: string | null } {
    return {
      isProcessing: this.isProcessing,
      canAbort: this.canAbortFlow,
      currentMessageId: this.currentProcessingMessageId
    };
  }

  /**
   * 🎯 获取所有可回滚的消息ID列表
   */
  getRollbackableMessageIds(): string[] {
    if (!this.ottoClient) {
      return [];
    }

    const currentHistory = this.ottoClient.getChat().getHistory();
    return currentHistory
      .filter(content => content.prompt_id)
      .map(content => content.prompt_id!)
      .filter((id): id is string => !!id);
  }

  // 🎯 历史记录保存方法 - 触发SessionManager的统一保存
  private async saveSessionHistoryIfAvailable(): Promise<void> {
    this.sessionHistoryManager!.saveCompleteSessionHistory(this.sessionId);
  }

  // 🎯 获取OttoClient实例（供SessionManager统一保存时使用）
  getOttoClient(): OttoClient | undefined {
    return this.ottoClient;
  }

  // 🎯 获取Config实例（供SessionManager进行YOLO模式同步使用）
  getConfig(): Config | undefined {
    return this.config;
  }

  // 🎯 获取当前Token使用情况（供模型切换时检查是否需要压缩）
  getCurrentTokenUsage(): { totalTokens: number; tokenLimit: number } | undefined {
    return this.currentTokenUsage;
  }

  async dispose() {
    this.logger.info('Disposing AIService');

    // 🎯 清理增强的 lint 功能
    if (this.diagnosticsMonitor) {
      this.diagnosticsMonitor.dispose();
      this.diagnosticsMonitor = undefined;
    }

    if (this.smartNotificationService) {
      this.smartNotificationService.dispose();
      this.smartNotificationService = undefined;
    }

    this.ottoClient = undefined;
    this.config = undefined;
    this.coreToolScheduler = undefined;
    this.currentToolCalls.clear();
    this.toolCallUpdateCallbacks.clear();

    // 🎯 清理内存刷新相关状态
    this.processedMemoryTools.clear();
    this.memoryRefreshCallback = undefined;

    // 🔌 清理 MCP 状态监听器
    if (this.mcpStatusListener) {
      removeMCPStatusChangeListener(this.mcpStatusListener);
      this.mcpStatusListener = undefined;
      this.mcpListenerRegistered = false; // 🎯 重置注册标记
    }

    // 🔌 清理 MCP 相关定时器和缓存
    if (this.mcpStatusUpdateTimer) {
      clearTimeout(this.mcpStatusUpdateTimer);
      this.mcpStatusUpdateTimer = undefined;
    }
    this.mcpServerStatuses.clear();
    // 🎯 工具数量现在使用全局缓存，无需本地清理

    this.isInitialized = false;
  }

  /**
   * 🔌 获取 MCP 服务器状态（供外部查询）
   */
  getMCPServerStatuses(): Map<string, MCPServerStatus> {
    return new Map(this.mcpServerStatuses);
  }

  /**
   * 🔌 获取 MCP 发现状态
   */
  getMCPDiscoveryState(): MCPDiscoveryState {
    return getMCPDiscoveryState();
  }

  /**
   * 🔌 刷新 AI 工具列表，根据 MCP 启用状态过滤工具
   * 当用户启用/禁用某个 MCP Server 时调用此方法
   *
   * 🎯 升级逻辑：不再仅仅是过滤，而是真正的物理加载/卸载
   */
  async refreshToolsWithMcpFilter(): Promise<void> {
    try {
      if (!this.ottoClient || !this.config) {
        this.logger.warn('Cannot refresh tools: ottoClient or config not initialized');
        return;
      }

      // 导入 McpEnabledStateService
      const { McpEnabledStateService } = await import('./mcpEnabledStateService.js');
      const mcpEnabledService = McpEnabledStateService.getInstance();

      // 🎯 获取配置中的所有服务器
      const { MCPSettingsService } = await import('./mcpSettingsService.js');
      const allMcpServers = MCPSettingsService.loadMCPServers(this.config.getProjectRoot());

      const toolRegistry = await this.config.getToolRegistry();

      // 🎯 遍历所有服务器，执行真实的物理加卸载
      for (const serverName of Object.keys(allMcpServers)) {
        const isEnabled = mcpEnabledService.isEnabled(serverName);
        const currentStatus = getMCPServerStatus(serverName);

        if (isEnabled && currentStatus === MCPServerStatus.DISCONNECTED) {
          // 💡 状态：已启用但未连接 -> 执行动态加载
          this.logger.info(`🔌 [MCP] Dynamically loading enabled server: ${serverName}`);

          // 🎯 关键修复：将配置注入 Config 对象，否则加载会因为找不到配置而失败
          const serverConfig = allMcpServers[serverName];
          if (serverConfig) {
            this.config.addMcpServer(serverName, serverConfig);
            await toolRegistry.discoverToolsForServer(serverName);
          }
        } else if (!isEnabled && currentStatus !== MCPServerStatus.DISCONNECTED) {
          // 💡 状态：已禁用但当前有连接 -> 执行物理卸载
          this.logger.info(`🔌 [MCP] Dynamically unloading disabled server: ${serverName}`);
          await unloadMcpServer(
            serverName,
            toolRegistry,
            this.config.getPromptRegistry(),
            this.config.getResourceRegistry()
          );

          // 🎯 同步：从 Config 对象中移除配置
          this.config.removeMcpServer(serverName);
        }
      }

      // 获取更新后的所有工具声明
      const allTools = toolRegistry.getAllTools();

      // 再次确认过滤（多重保障）
      const filteredTools = allTools.filter(tool => {
        const serverName = (tool as any).serverName;
        if (!serverName) {
          return true; // 非 MCP 工具，始终保留
        }
        return mcpEnabledService.isEnabled(serverName);
      });

      // 构建工具声明并设置到 geminiChat
      const filteredDeclarations = filteredTools.map(tool => tool.schema);
      const tools = [{ functionDeclarations: filteredDeclarations }];
      this.ottoClient.getChat().setTools(tools);

      this.logger.info(`Tools refreshed: ${filteredTools.length}/${allTools.length} tools available`);

      // 🎯 关键：更新 AI 引擎内部的工具状态，确保下一轮对话生效
      if (this.ottoClient.isInitialized()) {
        await this.ottoClient.setTools();
      }
    } catch (error) {
      this.logger.error('Failed to refresh tools with MCP filter', error instanceof Error ? error : undefined);
    }
  }
}
