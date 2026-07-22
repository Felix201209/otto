/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import WebSocket from 'ws';
import { type Config, type ToolRegistry, type OttoClient, type ToolCallRequestInfo, AuthType, ApprovalMode, type OttoChat, OttoEventType, type ServerOttoStreamEvent, CoreToolScheduler, type ToolCall as EngineToolCall, type CompletedToolCall, ToolConfirmationOutcome, type EditorType, type Content, getMCPDiscoveryState, MCPDiscoveryState, getMCPServerStatus, MCPServerStatus } from 'otto-core';
import type { Part } from '@google/genai';
import {
  RemoteMessage,
  MessageFactory,
  CommandMessage,
} from './remoteProtocol.js';
import { parseAndFormatApiError } from '../ui/utils/errorParsing.js';
import { remoteLogger } from './remoteLogger.js';
import { t, tp, isChineseLocale } from '../ui/utils/i18n.js';

/**
 * 格式化时间戳为 yyyy-mm-dd HH:mm:ss 格式
 */
function formatTimestamp(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const HH = String(date.getHours()).padStart(2, '0');
  const MM = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${ss}`;
}

/**
 * UI展示记录接口 - 不同于OttoChat的对话历史，这是专门为UI展示设计的数据结构
 */
interface UIDisplayRecordBase {
  id: string;
  timestamp: number;
  status?: 'pending' | 'in_progress' | 'completed' | 'error';
}

interface UIDisplayToolCallContent {
  toolName: string;
  toolDescription: string;
  callId: string;
  args: Record<string, unknown>;
  success: boolean;
  result?: string;
  error?: string;
  duration: number;
}

interface UserInputUIDisplayRecord extends UIDisplayRecordBase {
  type: 'user_input';
  content: string;
}

interface AIResponseUIDisplayRecord extends UIDisplayRecordBase {
  type: 'ai_response';
  content: string;
}

interface StatusUIDisplayRecord extends UIDisplayRecordBase {
  type: 'status';
  content: string;
}

interface ErrorUIDisplayRecord extends UIDisplayRecordBase {
  type: 'error';
  content: string;
}

interface ToolCallUIDisplayRecord extends UIDisplayRecordBase {
  type: 'tool_call';
  content: UIDisplayToolCallContent;
}

export type UIDisplayRecord =
  | UserInputUIDisplayRecord
  | AIResponseUIDisplayRecord
  | StatusUIDisplayRecord
  | ErrorUIDisplayRecord
  | ToolCallUIDisplayRecord;
type UIDisplayRecordInput = Omit<UIDisplayRecord, 'id' | 'timestamp'>;
type AwaitingApprovalToolCall = Extract<EngineToolCall, { status: 'awaiting_approval' }>;

/**
 * 远程会话管理类
 * 为每个WebSocket连接维护独立的对话状态和历史记录
 */
export class RemoteSession {
  private geminiClient: OttoClient | null = null;
  private geminiChat: OttoChat | null = null; // OttoChat实例
  private toolRegistry: ToolRegistry | null = null;
  private currentProcessingPromise: Promise<void> | null = null;
  private sessionId: string;
  private isProcessingInterrupted: boolean = false;
  private currentAbortController: AbortController | null = null;

  // 🆕 远程确认支持：当危险命令需要用户确认时，暂存确认上下文
  private pendingConfirmation: {
    callId: string;
    toolName: string;
    command: string;
    scheduler: CoreToolScheduler;
  } | null = null;

  // UI展示记录存储 - 用于断线重连后恢复UI状态
  private uiDisplayRecords: UIDisplayRecord[] = [];
  private currentAIResponse: AIResponseUIDisplayRecord | null = null; // 当前正在进行的AI响应
  private lastPromptTokenCount = 0; // 最近一次 API 调用的 prompt token 数

  // 思考流跟踪：每轮对话生成一个 thoughtId，所有 Thought/Reasoning chunk 共享
  // null 表示当前轮次还没出现过思考事件；一旦发出过 Thought/Reasoning，
  // 必须在轮次结束（status=idle、错误、中断）前发送一条 isComplete=true 收尾。
  private currentThoughtId: string | null = null;

  constructor(
    private ws: WebSocket,
    private config: Config,
    sessionId?: string
  ) {
    this.sessionId = sessionId || `session_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    // 不要在构造函数中获取 geminiClient，等到 initialize() 时再获取
    remoteLogger.info('RemoteSession', `创建新会话: ${this.sessionId}`);
  }

  /**
   * 重新绑定WebSocket连接（用于session恢复）
   */
  rebindWebSocket(ws: WebSocket): void {
    remoteLogger.info('RemoteSession', `重新绑定WebSocket: ${this.sessionId}`);
    this.ws = ws;
  }

  /**
   * 检查session是否已经初始化
   */
  isInitialized(): boolean {
    const initialized = !!(this.geminiChat && this.toolRegistry);

    return initialized;
  }

  /**
   * 初始化会话
   */
  async initialize(): Promise<void> {
    remoteLogger.info('RemoteSession', `开始初始化会话: ${this.sessionId}`);

    try {
      // 初始化配置

      await this.config.initialize();

      // ⭐ 等待MCP discovery完成（云端模式关键修复）
      // 防止MCP工具在WebSocket连接前尝试访问未初始化的资源
      await this.waitForMcpDiscovery();

      // 初始化认证 - 这是关键步骤

      await this.config.refreshAuth(AuthType.USE_PROXY_AUTH);

      // 设置远程模式为YOLO模式 - 自动执行所有工具，不需要确认

      this.config.setApprovalMode(ApprovalMode.YOLO);

      // 获取 OttoClient（在 config 初始化后）

      this.geminiClient = this.config.getOttoClient();

      if (!this.geminiClient) {
        throw new Error('无法获取OttoClient，请检查配置和认证状态');
      }

      // 初始化工具注册表

      this.toolRegistry = await this.config.getToolRegistry();

      // 创建OttoChat实例，这个实例会保持整个对话历史

      this.geminiChat = await this.geminiClient.getChat();

      remoteLogger.info('RemoteSession', `会话初始化完成: ${this.sessionId}`);
      this.sendMessage(MessageFactory.createStatus('idle', 'Otto 远程会话已就绪'));
    } catch (error) {
      remoteLogger.error('RemoteSession', `会话初始化失败: ${this.sessionId}`, error);
      this.sendError(`会话初始化失败: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * 等待MCP工具发现完成
   * 这防止了云端模式下的竞态条件，确保MCP服务器在使用前已初始化
   * MCP失败只会警告，不会中断主业务流程
   */
  private async waitForMcpDiscovery(): Promise<void> {
    const startTime = Date.now();
    const timeout = 15000; // 15秒超时，避免无限等待
    const checkInterval = 100; // 每100ms检查一次

    // 获取配置的MCP服务器列表
    const mcpServers = this.config.getMcpServers() || {};
    const serverNames = Object.keys(mcpServers);

    if (serverNames.length === 0) {
      // 没有配置MCP服务器，直接跳过等待
      remoteLogger.info('RemoteSession', '未配置MCP服务器，跳过MCP discovery等待');
      return;
    }

    remoteLogger.info('RemoteSession', `等待MCP discovery完成，服务器列表: ${serverNames.join(', ')}`);

    while (Date.now() - startTime < timeout) {
      const discoveryState = getMCPDiscoveryState();

      // 检查discovery是否已完成
      if (discoveryState === MCPDiscoveryState.COMPLETED) {
        // 检查每个服务器的状态
        const serverStatusList = serverNames.map(name => ({
          name,
          status: getMCPServerStatus(name)
        }));

        const connectedServers = serverStatusList.filter(s => s.status === MCPServerStatus.CONNECTED);
        const failedServers = serverStatusList.filter(s => s.status === MCPServerStatus.DISCONNECTED);

        if (connectedServers.length > 0) {
          remoteLogger.info('RemoteSession', `MCP已连接服务器: ${connectedServers.map(s => s.name).join(', ')}`);
        }

        if (failedServers.length > 0) {
          remoteLogger.warn('RemoteSession', `MCP连接失败的服务器（不影响主流程）: ${failedServers.map(s => s.name).join(', ')}`);
        }

        return;
      }

      // Discovery还在进行中或未开始，继续等待
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // 超时后，记录警告但不抛出异常（允许继续运行）
    remoteLogger.warn('RemoteSession', `MCP discovery超时，继续启动会话`, {
      timeout,
      discoveryState: getMCPDiscoveryState(),
      configuredServers: serverNames
    });
  }

  /**
   * 获取会话ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 获取最近一次 API 调用的 prompt token count（用于 context left 计算）
   */
  getLastPromptTokenCount(): number {
    return this.lastPromptTokenCount;
  }

  /**
   * 处理命令消息
   */
  async handleCommand(message: CommandMessage): Promise<void> {
    const { command } = message.payload;
    console.log(`[${formatTimestamp()}] ${t('cloud.remote.message.received')}`);
    remoteLogger.info('RemoteSession', `收到指令: ${this.sessionId}`, { command, messageId: message.id });

    // 🆕 如果当前正在等待用户确认危险命令，拦截输入作为确认回复
    if (this.pendingConfirmation) {
      const input = command.trim().toLowerCase();
      const { callId, command: pendingCmd, scheduler } = this.pendingConfirmation;

      if (['y', 'yes', 'ok', '确认', '是'].includes(input)) {
        this.pendingConfirmation = null;
        remoteLogger.info('RemoteSession', `用户确认执行危险命令: ${this.sessionId}`, { callId });
        this.sendMessage(MessageFactory.createOutput(
          `✅ 已确认，正在执行: \`${pendingCmd}\`\n`,
          true, 'stdout'
        ));
        await scheduler.handleConfirmationResponse(callId, ToolConfirmationOutcome.ProceedOnce);
        return;
      }

      if (['n', 'no', 'cancel', '取消', '否'].includes(input)) {
        this.pendingConfirmation = null;
        remoteLogger.info('RemoteSession', `用户取消危险命令: ${this.sessionId}`, { callId });
        this.sendMessage(MessageFactory.createOutput(
          `🛑 已取消该操作。\n`,
          true, 'stdout'
        ));
        await scheduler.handleConfirmationResponse(callId, ToolConfirmationOutcome.Cancel);
        return;
      }

      // 用户输入了无关内容，再次提醒
      this.sendMessage(MessageFactory.createOutput(
        `⚠️ 请先回复 y(确认) 或 n(取消) 来处理待确认的危险命令：\`${pendingCmd}\`\n`,
        true, 'stdout'
      ));
      return;
    }

    // 🆕 斜杠命令预处理：在发送给 AI 之前拦截本地可处理的命令
    if (command.trim().startsWith('/')) {
      const handled = await this.handleSlashCommand(command.trim());
      if (handled) return;
    }

    // 如果有正在处理的指令，则等待完成
    if (this.currentProcessingPromise) {
      remoteLogger.warn('RemoteSession', `有指令正在执行，拒绝新指令: ${this.sessionId}`);
      this.sendMessage(MessageFactory.createStatus('running', '有指令正在执行中，请等待...'));
      return;
    }

    // 重置中断状态
    this.isProcessingInterrupted = false;

    // 添加用户输入记录

    this.addUIRecord({
      type: 'user_input',
      content: command,
      status: 'completed'
    });

    // 开始处理新指令
    console.log(`[${formatTimestamp()}] ${t('cloud.remote.message.processing')}`);
    remoteLogger.info('RemoteSession', `开始处理指令: ${this.sessionId}`);
    this.currentProcessingPromise = this.processCommand(command);

    try {
      await this.currentProcessingPromise;
      console.log(`[${formatTimestamp()}] ${t('cloud.remote.message.success')}`);
      remoteLogger.info('RemoteSession', `指令处理完成: ${this.sessionId}`);
    } catch (error) {
      console.log(`[${formatTimestamp()}] ${t('cloud.remote.message.failed')}`);
      remoteLogger.error('RemoteSession', `指令处理失败: ${this.sessionId}`, error);
    } finally {
      this.currentProcessingPromise = null;
      this.currentAIResponse = null;
      this.currentAbortController = null;
      // 兜底：command 处理结束时确保任何挂起的思考段被收尾。
      // 正常路径下 finalizeThought 已在 idle/error 之前调用，这里是防御性的。
      this.finalizeThought();
    }
  }

  /**
   * 处理斜杠命令（本地拦截，不发给 AI）
   * 返回 true 表示已处理，false 表示不是已知命令，需继续走 AI 流程
   */
  private async handleSlashCommand(input: string): Promise<boolean> {
    const parts = input.substring(1).trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1).join(' ').trim();

    switch (cmd) {
      case 'model':
        await this.handleModelCommand(args);
        return true;
      default:
        return false;
    }
  }

  /**
   * 处理 /model 命令：切换模型或显示当前模型
   */
  private async handleModelCommand(modelArg: string): Promise<void> {
    try {
      const { getAvailableModels } = await import('../ui/commands/modelCommand.js');
      const { getModelNameFromDisplayName } = await import('../utils/modelUtils.js');

      if (!modelArg) {
        // /model 无参数：显示当前模型和可用列表
        const currentModel = this.config.getModel() || 'auto';
        const { modelInfos } = await getAvailableModels(undefined, this.config);
        const modelList = ['auto', ...modelInfos.map(m => m.name)]
          .map(m => `  ${m === currentModel ? '▶' : ' '} ${m}`)
          .join('\n');

        this.addUIRecord({ type: 'user_input', content: `/model`, status: 'completed' });
        this.sendMessage(MessageFactory.createOutput(
          `Current model: **${currentModel}**\n\nAvailable models:\n${modelList}\n\nUsage: \`/model <name>\` to switch.\n`,
          true, 'stdout'
        ));
        this.sendMessage(MessageFactory.createStatus('idle', ''));
        return;
      }

      this.addUIRecord({ type: 'user_input', content: `/model ${modelArg}`, status: 'completed' });

      // 获取可用模型列表
      const { modelInfos } = await getAvailableModels(undefined, this.config);
      const availableNames = ['auto', ...modelInfos.map(m => m.name)];

      // displayName → modelName 转换
      const actualModelName = getModelNameFromDisplayName(modelArg, modelInfos);

      if (!availableNames.includes(actualModelName)) {
        const list = availableNames.join(', ');
        this.sendMessage(MessageFactory.createOutput(
          `❌ Unknown model: \`${modelArg}\`\n\nAvailable: ${list}\n`,
          true, 'stdout'
        ));
        this.sendMessage(MessageFactory.createStatus('idle', ''));
        return;
      }

      // 切换模型
      this.sendMessage(MessageFactory.createOutput(
        `⏳ Switching to model **${actualModelName}**...\n`,
        true, 'stdout'
      ));

      this.config.setModel(actualModelName);

      if (this.geminiClient) {
        await this.geminiClient.waitForChatInitialized();
        const switchResult = await this.geminiClient.switchModel(
          actualModelName,
          new AbortController().signal
        );

        if (!switchResult.success) {
          this.sendMessage(MessageFactory.createOutput(
            `❌ Failed to switch model: ${switchResult.error || 'Unknown error'}\n`,
            true, 'stdout'
          ));
          this.sendMessage(MessageFactory.createStatus('error', 'Model switch failed'));
          return;
        }
      }

      this.sendMessage(MessageFactory.createOutput(
        `✅ Model switched to **${actualModelName}**\n`,
        true, 'stdout'
      ));
      this.sendMessage(MessageFactory.createStatus('idle', ''));

      remoteLogger.info('RemoteSession', `模型切换成功: ${this.sessionId}`, { model: actualModelName });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.sendMessage(MessageFactory.createOutput(
        `❌ Model switch error: ${errMsg}\n`,
        true, 'stdout'
      ));
      this.sendMessage(MessageFactory.createStatus('error', 'Model switch failed'));
      remoteLogger.error('RemoteSession', `模型切换失败: ${this.sessionId}`, error);
    }
  }

  /**
   * 处理中断信号 - 统一中断状态管理，确保tool use/result匹配
   */
  handleInterrupt(): void {
    remoteLogger.info('RemoteSession', `收到中断信号: ${this.sessionId}`);

    // 🆕 如果有待确认的危险命令，中断时自动取消
    if (this.pendingConfirmation) {
      const { callId, scheduler } = this.pendingConfirmation;
      this.pendingConfirmation = null;
      scheduler.handleConfirmationResponse(callId, ToolConfirmationOutcome.Cancel).catch(() => {});
    }

    // 设置中断标志 - 这会在适当的检查点生效，确保已开始的工具能够完成
    this.isProcessingInterrupted = true;

    // 中断当前的AbortController - 但这主要影响Gemini API调用，不影响已开始的工具执行
    if (this.currentAbortController) {

      this.currentAbortController.abort();
      this.currentAbortController = null;
    }

    // 更新当前正在进行的AI响应为中断状态
    if (this.currentAIResponse) {
      this.currentAIResponse.status = 'error';
      this.currentAIResponse.content += '\n\n[操作已中断]';

    }

    // 添加中断状态记录
    this.addUIRecord({
      type: 'status',
      content: '指令已中断',
      status: 'completed'
    });

    // 中断前先收尾思考段
    this.finalizeThought();

    // 发送中断状态消息
    this.sendMessage(MessageFactory.createStatus('idle', '✅ 指令已中断'));

    remoteLogger.info('RemoteSession', `中断处理完成: ${this.sessionId}`, {
      hasCurrentResponse: !!this.currentAIResponse,
      hasAbortController: !!this.currentAbortController
    });
  }

  /**
   * 处理单个指令 - 使用持久化的OttoChat实现连续对话
   */
  private async processCommand(input: string): Promise<void> {
    const prompt_id = Math.random().toString(16).slice(2);
    remoteLogger.info('RemoteSession', `processCommand开始: ${this.sessionId}`, { input, prompt_id });

    this.sendMessage(MessageFactory.createStatus('running', '正在处理指令...'));

    // 初始化当前AI响应为null，在每轮开始时创建新的响应记录
    this.currentAIResponse = null;
    // 新一次 processCommand 开始：确保上一轮残留的思考段被收尾
    this.finalizeThought();



    try {
      if (!this.geminiChat || !this.toolRegistry) {
        const error = '会话未正确初始化';
        remoteLogger.error('RemoteSession', error, {
          geminiChat: !!this.geminiChat,
          toolRegistry: !!this.toolRegistry
        });
        throw new Error(error);
      }



      const abortController = new AbortController();
      this.currentAbortController = abortController;



      // 多轮对话循环：处理用户输入 → AI响应 → 工具执行 → 结果反馈 → 循环
      let currentInput: Part[] = [{ text: input }];
      let turnCount = 0;

      while (true) {
        turnCount++;

        // 检查会话轮次限制
        if (this.config.getMaxSessionTurns() > 0 && turnCount > this.config.getMaxSessionTurns()) {
          this.sendError('达到最大会话轮次，请增加 maxSessionTurns 设置');
          return;
        }

        // 🔧 修复: 为每轮AI响应创建新的记录，避免多轮响应被合并
        this.currentAIResponse = null;
        // 每轮（含工具调用回合）开始时收尾上一轮的思考段。
        // 这样工具→新一轮 reasoning 会获得新的 thoughtId，客户端能正确分段。
        this.finalizeThought();


        // 发送当前轮次的消息给AI（可能是初始用户输入或工具执行结果）
        const responseStreamGenerator = this.geminiClient!.sendMessageStream(
          currentInput,
          abortController.signal,
          prompt_id
        );

        // 收集当前轮次的工具调用请求
        const toolCallRequests: ToolCallRequestInfo[] = [];
        let hasContent = false;

        // 处理AI响应事件
        for await (const event of responseStreamGenerator) {


          // 检查中断状态
          if (abortController.signal.aborted || this.isProcessingInterrupted) {
            remoteLogger.warn('RemoteSession', `第${turnCount}轮事件处理被中断: ${this.sessionId}`);
            return;
          }

          if (event.type === OttoEventType.Content) {
            hasContent = true;
            await this.handleContentEvent(event.value, turnCount);
          } else if (event.type === OttoEventType.ToolCallRequest) {
            toolCallRequests.push(event.value);
          } else {
            await this.handleOtherEvent(event);
          }
        }

        remoteLogger.info('RemoteSession', `第${turnCount}轮处理完成: ${this.sessionId}`, {
          hasContent,
          toolCallsCount: toolCallRequests.length
        });

        // 🔧 修复: 标记当前轮次的AI响应为完成状态
        const currentResponse = this.currentAIResponse as AIResponseUIDisplayRecord | null;
        if (currentResponse && hasContent) {
          currentResponse.status = 'completed';
          remoteLogger.info('RemoteSession', `第${turnCount}轮AI响应完成: ${this.sessionId}`, {
            recordId: currentResponse.id,
            contentLength: currentResponse.content.length
          });
        }

        // 如果没有工具调用，对话结束
        if (toolCallRequests.length === 0) {
          // idle 前先收尾思考段，确保客户端结束当前折叠区
          this.finalizeThought();
          this.sendMessage(MessageFactory.createStatus('idle', '指令执行完成'));
          return;
        }

        // 执行工具调用并收集结果
        const toolResults = await this.executeToolCalls(toolCallRequests, prompt_id, abortController.signal);

        // 如果被中断，退出循环
        if (this.isProcessingInterrupted) {
          remoteLogger.info('RemoteSession', `工具执行被中断，结束对话: ${this.sessionId}`);
          return;
        }

        // 将工具结果作为下一轮的输入
        currentInput = toolResults;
      }
    } catch (error) {
      remoteLogger.error('RemoteSession', `指令处理错误: ${this.sessionId}`, error);

      // 如果是中断操作，静默处理，不发送额外消息
      if (this.isProcessingInterrupted) {
        remoteLogger.info('RemoteSession', `中断期间的错误，静默处理: ${this.sessionId}`);
        return;
      }

      // 更新当前AI响应为错误状态
      const currentResponse = this.currentAIResponse as AIResponseUIDisplayRecord | null;
      if (currentResponse) {
        currentResponse.status = 'error';
        currentResponse.content += '\n\n[执行出错]';
      }

      const parsedError = parseAndFormatApiError(error);
      this.sendError(`指令处理错误: ${parsedError}`);
      // sendError 已经处理中断情况，这里也要检查
      if (!this.isProcessingInterrupted) {
        this.sendMessage(MessageFactory.createStatus('error', '指令执行失败'));
      }
    }
  }

  /**
   * 发送消息到客户端
   */
  sendMessage(message: RemoteMessage): void {


    // 🎯 确保所有消息都包含sessionId，用于云端模式的精确路由
    const messageWithSession: RemoteMessage = {
      ...message,
      sessionId: this.sessionId
    };

    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(messageWithSession));

      } catch (error) {
        remoteLogger.error('RemoteSession', `消息发送失败: ${this.sessionId}`, {
          messageId: message.id,
          error
        });
      }
    } else {
      remoteLogger.warn('RemoteSession', `WebSocket未连接，无法发送消息: ${this.sessionId}`, {
        messageId: message.id,
        readyState: this.ws?.readyState ?? 'null'
      });
    }
  }

  /**
   * 发送错误消息 - 中断时不发送冗余消息
   */
  private sendError(error: string): void {
    // 如果是中断状态，不发送错误消息（中断已经有自己的状态消息）
    if (this.isProcessingInterrupted) {
      remoteLogger.info('RemoteSession', `跳过中断期间的错误消息: ${this.sessionId}`);
      return;
    }

    remoteLogger.error('RemoteSession', `发送错误消息: ${this.sessionId}`, { error });
    // 错误前先收尾思考段，避免客户端永远等不到 isComplete
    this.finalizeThought();
    this.sendMessage(MessageFactory.createError(error));
    // 确保发送idle状态
    this.sendMessage(MessageFactory.createStatus('idle', '操作完成'));
  }

  /**
   * 清理session数据 - 清空对话历史和UI记录，但保持session活跃
   */
  clearSessionData(): void {
    remoteLogger.info('RemoteSession', `清理session数据: ${this.sessionId}`);

    // 清空UI显示记录
    this.uiDisplayRecords = [];
    this.currentAIResponse = null;
    // 清理思考段，避免下一轮误把它当延续
    this.finalizeThought();

    // 🆕 清理待确认状态
    this.pendingConfirmation = null;

    // 清理对话历史
    this.geminiClient?.resetChat();

    // 重置处理中断状态，但不清理currentProcessingPromise（可能仍在处理中）
    this.isProcessingInterrupted = false;
  }

  /**
   * 清理会话资源
   */
  cleanup(): void {
    remoteLogger.info('RemoteSession', `清理会话: ${this.sessionId}`);

    // 清理对话历史（可选）
    if (this.geminiChat) {
      // this.geminiChat.clearHistory(); // 如果需要清理历史记录
    }

    this.currentProcessingPromise = null;
  }

  /**
   * 获取对话历史（用于调试或状态查询）
   */
  getConversationHistory(): Content[] {
    if (!this.geminiChat) {
      return [];
    }

    try {
      return this.geminiChat.getHistory(true); // 获取精选历史记录
    } catch (error) {
      remoteLogger.error('RemoteSession', `获取历史记录失败: ${this.sessionId}`, error);
      return [];
    }
  }

  /**
   * 添加UI展示记录
   */
  private addUIRecord(record: UIDisplayRecordInput): UIDisplayRecord {
    const fullRecord = {
      id: `ui_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      timestamp: Date.now(),
      ...record
    } as UIDisplayRecord;

    this.uiDisplayRecords.push(fullRecord);

    // 保持记录数量在合理范围内（最多保留500条）
    if (this.uiDisplayRecords.length > 500) {
      this.uiDisplayRecords = this.uiDisplayRecords.slice(-500);
    }

    return fullRecord;
  }

  /**
   * 获取UI展示记录 - 区分已完成和正在进行的部分
   */
  getUIDisplayData(): {
    completedRecords: UIDisplayRecord[];
    currentRecord: UIDisplayRecord | null;
    isProcessing: boolean;
  } {
    // 返回所有记录，不仅仅是completed的
    // 这样前端可以恢复完整的对话历史，包括用户输入
    const completedRecords = [...this.uiDisplayRecords];

    return {
      completedRecords,
      currentRecord: this.currentAIResponse,
      isProcessing: this.currentProcessingPromise !== null && !this.isProcessingInterrupted
    };
  }

  /**
   * 获取完整的UI展示记录（用于断线重连时恢复状态）
   */
  getAllUIDisplayRecords(): UIDisplayRecord[] {
    return [...this.uiDisplayRecords];
  }

  /**
   * 处理除content和tool_call_request之外的其他事件
   */
  private async handleOtherEvent(event: ServerOttoStreamEvent): Promise<void> {
    switch (event.type) {
      case OttoEventType.ToolCallResponse:
        // 工具调用响应 - 记录到UI

        break;

      case OttoEventType.ChatCompressed: {
        // 对话压缩通知 - 按成功/降级/失败分类处理。
        // 关键：remoteLogger 只写服务端本地日志文件，不经 WebSocket。
        // 必须同时 sendMessage 把状态发到远端客户端，否则远程用户会遇到
        // 和本地 CLI 一样的"无声停止"问题——屏幕上没任何提示，对话已被截停。
        const payload = event.value;
        if (payload?.success) {
          if (payload.degraded) {
            // 降级：全量压缩失败，但 MicroCompact 兜底清理了若干旧工具输出。
            // 对话仍可继续，只是上下文更紧。告知用户但不升级为错误。
            remoteLogger.info(
              'RemoteSession',
              `对话已自动压缩(轻量模式): ${this.sessionId}, clearedCount=${payload.clearedCount}, reason=${payload.reason}`,
              payload,
            );
            this.sendMessage(
              MessageFactory.createOutput(
                `\n${tp('conversation.compress.degraded', {
                  clearedCount: payload.clearedCount ?? 0,
                })}\n`,
                true,
                'stdout',
              ),
            );
          } else {
            // 完整成功：对话无损继续，不需要打扰用户（与本地 CLI 行为一致，
            // 本地只在 /compress 手动触发时才显式展示成功消息）。
            remoteLogger.info(
              'RemoteSession',
              `对话已自动压缩(完整): ${this.sessionId}`,
              payload,
            );
          }
        } else {
          // 失败：core 层已经 return new Turn() 停掉了这一轮对话。
          // 必须告知远端用户要么手动 /compress 要么 /session new，
          // 否则用户只看到"AI 没回复"，完全不知道发生了什么。
          const reason = payload?.reason ?? 'unknown';
          const isCircuitBreaker = reason.startsWith('circuit_breaker');
          const failureKey = isCircuitBreaker
            ? 'conversation.compress.failed.circuit_breaker'
            : 'conversation.compress.failed.generic';
          const message = payload
            ? tp(failureKey, { reason })
            : t('conversation.compress.failed.unknown');

          remoteLogger.warn(
            'RemoteSession',
            `对话自动压缩失败: ${this.sessionId}, reason=${reason}`,
            payload,
          );
          this.sendError(message);
        }
        break;
      }

      case OttoEventType.MaxSessionTurns:
        // 达到最大会话轮次
        this.sendError('达到最大会话轮次，请增加 maxSessionTurns 设置');
        break;

      case OttoEventType.LoopDetected: {
        // 检测到循环
        const loopType = event.value;
        let loopMessage = '';

        switch (loopType) {
          case 'consecutive_identical_tool_calls':
            loopMessage = `${t('loop.consecutive.tool.calls.title')}\n${t('loop.consecutive.tool.calls.description')}\n${t('loop.consecutive.tool.calls.action')}`;
            break;
          case 'chanting_identical_sentences':
            loopMessage = `${t('loop.chanting.identical.sentences.title')}\n${t('loop.chanting.identical.sentences.description')}\n${t('loop.chanting.identical.sentences.action')}`;
            break;
          case 'llm_detected_loop':
            loopMessage = `${t('loop.llm.detected.title')}\n${t('loop.llm.detected.description')}\n${t('loop.llm.detected.action')}`;
            break;
          default:
            loopMessage = isChineseLocale()
              ? '检测到重复循环，对话已停止'
              : 'Repetitive loop detected, conversation stopped';
        }

        remoteLogger.warn('RemoteSession', `检测到对话循环: ${this.sessionId} (type: ${loopType || 'unknown'})`);
        this.finalizeThought();
        this.sendMessage(MessageFactory.createStatus('idle', loopMessage));
        break;
      }

      case OttoEventType.Thought: {
        // Gemini 风格的离散 Thought 事件 (subject + description)
        // 与本地 useOttoStream 一致：本机端会在 LoadingIndicator 显示 subject。
        // 远程端转发为 THOUGHT 消息，便于 Web/飞书展示思考标题与进展。
        const thoughtId = this.ensureThoughtId();
        const subject = (event.value as { subject?: string })?.subject ?? '';
        const description = (event.value as { description?: string })?.description ?? '';
        this.sendMessage(MessageFactory.createThought(thoughtId, subject, description));
        break;
      }

      case OttoEventType.Reasoning: {
        // OpenAI/Claude/DeepSeek 风格的流式 reasoning chunk
        // 远程端按 thoughtId 聚合：所有 chunk 累加成完整 reasoning，
        // 客户端可折叠展示。该轮结束时必须发一条 isComplete=true 收尾。
        const thoughtId = this.ensureThoughtId();
        const text = (event.value as { text?: string })?.text ?? '';
        if (text) {
          this.sendMessage(MessageFactory.createReasoningChunk(thoughtId, text, false));
        }
        break;
      }

      case OttoEventType.MemoryContext: {
        const count = event.value?.matchCount ?? 0;
        if (count > 0) {
          const message = isChineseLocale()
            ? `找到 ${count} 条相关历史经验，已注入本轮上下文`
            : `Found ${count} related historical item(s) and added them to this turn`;
          this.sendMessage(MessageFactory.createStatus('running', message));
        }
        break;
      }

      case OttoEventType.UserCancelled:
        // 用户取消
        remoteLogger.info('RemoteSession', `用户取消操作: ${this.sessionId}`);
        break;

      case OttoEventType.Error:
        // 错误事件
        remoteLogger.error('RemoteSession', `收到错误事件: ${this.sessionId}`, event.value);
        this.sendError(`AI处理错误: ${event.value.error.message || '未知错误'}`);
        break;

      case OttoEventType.Finished:
        // 对话完成
        remoteLogger.info('RemoteSession', `对话完成: ${this.sessionId}`);
        break;

      case OttoEventType.TokenUsage:
        // Token使用统计 - 记录最近一次的 prompt token count（用于 context left 计算）
        if (event.value && typeof event.value === 'object' && 'inputTokens' in event.value) {
          this.lastPromptTokenCount = (event.value as { inputTokens: number }).inputTokens;
        }
        break;

      default:
        // 未知事件类型
        remoteLogger.warn('RemoteSession', `未处理的事件类型: ${event.type}`, { sessionId: this.sessionId });
        break;
    }
  }

  /**
   * 执行工具调用并返回结果，供下一轮对话使用
   * 使用CoreToolScheduler进行标准化的工具执行管理
   */
  private async executeToolCalls(
    toolCallRequests: ToolCallRequestInfo[],
    prompt_id: string,
    abortSignal: AbortSignal
  ): Promise<Part[]> {
    remoteLogger.info('RemoteSession', `开始使用CoreToolScheduler执行工具: ${this.sessionId}`, {
      toolCount: toolCallRequests.length,
      tools: toolCallRequests.map((req: ToolCallRequestInfo) => req.name)
    });

    // 收集工具执行结果
    const toolResults: Part[] = [];
    let allToolsCompleted = false;

    // 为本次执行创建专用的CoreToolScheduler实例
    const toolScheduler = new CoreToolScheduler({
      toolRegistry: Promise.resolve(this.toolRegistry!),
      approvalMode: this.config.getApprovalMode(),
      outputUpdateHandler: (callId: string, outputChunk: string) => {
        // 处理工具输出流更新 - 使用工具状态消息
        const tool = this.toolRegistry?.getTool('unknown') || { displayName: 'Unknown Tool' };
        this.sendMessage(MessageFactory.createToolStatus(
          tool.displayName,
          callId,
          'running',
          outputChunk.substring(0, 200) + (outputChunk.length > 200 ? '...' : '') // 截断长输出
        ));
      },
      onAllToolCallsComplete: (completedToolCalls: CompletedToolCall[]) => {
        // 发送工具执行完成消息并收集结果
        for (const toolCall of completedToolCalls) {
          const toolName = 'tool' in toolCall ? toolCall.tool.displayName || toolCall.tool.name : toolCall.request.name;
          const duration = toolCall.durationMs || 0;

          // 获取简化的工具描述
          let toolDescription = '';
          if ('tool' in toolCall) {
            const fullDescription = toolCall.tool.getDescription(toolCall.request.args);
            // 截断过长的描述，移除换行符，确保单行显示
            const maxDescLength = 80;
            toolDescription = fullDescription
              .replace(/\n/g, ' ') // 替换换行符为空格
              .trim();
            if (toolDescription.length > maxDescLength) {
              toolDescription = toolDescription.slice(0, maxDescLength) + '...';
            }
          }

          if (toolCall.status === 'success' && toolCall.response.responseParts) {
            // 发送成功完成消息
            const resultText = typeof toolCall.response.resultDisplay === 'string'
              ? toolCall.response.resultDisplay
              : toolCall.response.resultDisplay
                ? JSON.stringify(toolCall.response.resultDisplay)
                : 'Tool executed successfully';

            this.sendMessage(MessageFactory.createToolCall(
              toolName,
              toolCall.request.callId,
              toolCall.request.args,
              true, // success
              resultText,
              undefined, // no error
              duration,
              toolDescription
            ));

            // 发送工具完成状态
            this.sendMessage(MessageFactory.createToolStatus(
              toolName,
              toolCall.request.callId,
              'completed',
              `执行完成: ${toolName}`
            ));

            // 添加工具调用UI记录
            this.addUIRecord({
              type: 'tool_call',
              content: {
                toolName,
                toolDescription,
                callId: toolCall.request.callId,
                args: toolCall.request.args,
                success: true,
                result: resultText,
                duration
              },
              status: 'completed'
            });

            // 收集结果转换为Part格式
            const responseParts = toolCall.response.responseParts;
            if (Array.isArray(responseParts)) {
              // 转换每个PartUnion为Part
              for (const part of responseParts) {
                if (typeof part === 'string') {
                  toolResults.push({ text: part });
                } else {
                  toolResults.push(part);
                }
              }
            } else {
              // 单个PartUnion转换为Part
              if (typeof responseParts === 'string') {
                toolResults.push({ text: responseParts });
              } else {
                toolResults.push(responseParts);
              }
            }
          } else if (toolCall.status === 'error' || toolCall.status === 'cancelled') {
            // 处理错误或取消的工具
            const errorMessage = toolCall.status === 'cancelled'
              ? 'User Canceled'
              : (toolCall.status === 'error'
                  ? toolCall.response.error?.message || 'Tool execution failed'
                  : 'Tool execution failed');

            // 发送错误完成消息
            this.sendMessage(MessageFactory.createToolCall(
              toolName,
              toolCall.request.callId,
              toolCall.request.args,
              false, // not success
              undefined, // no result
              errorMessage,
              duration,
              toolDescription
            ));

            // 发送工具错误状态
            this.sendMessage(MessageFactory.createToolStatus(
              toolName,
              toolCall.request.callId,
              'error',
              `执行失败: ${errorMessage}`
            ));

            // 添加错误UI记录
            this.addUIRecord({
              type: 'tool_call',
              content: {
                toolName,
                toolDescription,
                callId: toolCall.request.callId,
                args: toolCall.request.args,
                success: false,
                error: errorMessage,
                duration
              },
              status: 'error'
            });

            // 为错误或取消的工具创建错误响应
            toolResults.push({
              functionResponse: {
                id: toolCall.request.callId,
                response: {
                  output: `Error: ${errorMessage}`
                },
              },
            });
          }
        }

        remoteLogger.info('RemoteSession', `所有工具执行完成: ${this.sessionId}`, {
          completedCount: completedToolCalls.length
        });

        allToolsCompleted = true;
      },
      onToolCallsUpdate: (toolCalls: EngineToolCall[]) => {
        // 🆕 检测是否有工具进入 awaiting_approval 状态（危险命令确认）
        const confirmingTool = toolCalls.find(
          (tc): tc is AwaitingApprovalToolCall => tc.status === 'awaiting_approval',
        );
        if (confirmingTool && !this.pendingConfirmation) {
          const details = confirmingTool.confirmationDetails;
          const requestCommand = confirmingTool.request.args.command;
          const command = details.type === 'exec'
            ? details.command || requestCommand || String(confirmingTool.request.args)
            : requestCommand || String(confirmingTool.request.args);
          const warning = details.type === 'exec' && details.warning
            ? details.warning
            : '这是一个需要确认的敏感操作。';
          const toolName = confirmingTool.tool.displayName || confirmingTool.tool.name || confirmingTool.request.name || 'Unknown';

          // 保存确认上下文，等待用户回复
          this.pendingConfirmation = {
            callId: confirmingTool.request.callId,
            toolName,
            command: typeof command === 'string' ? command : JSON.stringify(command),
            scheduler: toolScheduler,
          };

          // 向远程端发送人性化的确认提示文本
          const promptText = [
            ``,
            `⚠️ **安全确认**`,
            `AI 准备执行以下命令：`,
            `\`${this.pendingConfirmation.command}\``,
            ``,
            `${warning}`,
            ``,
            `**请回复 y(确认执行) 或 n(取消)**`,
            ``,
          ].join('\n');

          this.sendMessage(MessageFactory.createOutput(promptText, true, 'stdout'));
          this.sendMessage(MessageFactory.createStatus('idle', '等待用户确认危险命令...'));

          remoteLogger.info('RemoteSession', `发送远程确认请求: ${this.sessionId}`, {
            callId: confirmingTool.request.callId,
            command: this.pendingConfirmation.command,
          });
        }
      },
      onPreToolExecution: async (toolCallInfo) => {
        // 工具执行前的预处理
        const toolDisplayName = toolCallInfo.tool.displayName || toolCallInfo.tool.name;
        this.sendMessage(MessageFactory.createToolStatus(
          toolDisplayName,
          toolCallInfo.callId,
          'starting',
          `开始执行工具: ${toolDisplayName}`
        ));
      },
      getPreferredEditor: () => 'vscode' as EditorType, // 远程会话默认使用VSCode
      config: this.config,
      hookEventHandler: this.config.getHookSystem().getEventHandler()
    });

    // 使用专用调度器执行工具
    await toolScheduler.schedule(toolCallRequests, abortSignal);

    // 等待所有工具完成
    while (!allToolsCompleted && !this.isProcessingInterrupted && !abortSignal.aborted) {
      await new Promise(resolve => setTimeout(resolve, 50)); // 50ms轮询
    }

    remoteLogger.info('RemoteSession', `CoreToolScheduler工具执行完成: ${this.sessionId}`, {
      toolCount: toolCallRequests.length,
      resultCount: toolResults.length,
      interrupted: this.isProcessingInterrupted
    });

    return toolResults;
  }

  /**
   * 处理AI文本响应事件
   */
  private async handleContentEvent(content: string, turnCount?: number): Promise<void> {
    if (!content) return;

    // 内容已经开始，对应的思考段落必须收尾。
    // 这里保持本地 CLI useOttoStream 的行为：reasoning 在 content 出现时被清空。
    this.finalizeThought();



    // 🔧 修复: 为每轮AI响应创建独立的记录，避免多轮响应被合并
    if (!this.currentAIResponse) {
      const responseRecord = this.addUIRecord({
        type: 'ai_response',
        content: '',
        status: 'in_progress'
      });
      if (responseRecord.type === 'ai_response') {
        this.currentAIResponse = responseRecord;
      }

      // 记录当前是第几轮对话，用于调试
      if (turnCount && this.currentAIResponse) {
        remoteLogger.info('RemoteSession', `创建新的AI响应记录 - 第${turnCount}轮: ${this.sessionId}`, {
          recordId: this.currentAIResponse.id
        });
      }
    }

    if (this.currentAIResponse) {
      this.currentAIResponse.content += content;
    }

    // 发送实时响应到前端
    this.sendMessage(MessageFactory.createOutput(content, false, 'stdout'));
  }

  /**
   * 获取或创建本轮 thoughtId。
   * 同一个对话轮次内的所有 Thought / Reasoning 事件共享一个 id，
   * 客户端用它聚合渲染 / 节流刷新。
   */
  private ensureThoughtId(): string {
    if (!this.currentThoughtId) {
      this.currentThoughtId = `t_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    }
    return this.currentThoughtId;
  }

  /**
   * 收尾当前思考段：发送一条 isComplete=true 的空 chunk，并清空 thoughtId。
   * 调用时机：内容开始、轮次结束（idle/error/中断）、新轮次开始。
   * 幂等：未发出过思考事件时无任何动作。
   */
  private finalizeThought(): void {
    if (this.currentThoughtId) {
      this.sendMessage(
        MessageFactory.createReasoningChunk(this.currentThoughtId, '', true),
      );
      this.currentThoughtId = null;
    }
  }


}
