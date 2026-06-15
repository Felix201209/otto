/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { PartListUnion } from '@google/genai';
import { Content } from '../types/extendedContent.js';
import { Config } from '../config/config.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { PreToolExecutionHandler } from '../tools/tools.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { GeminiClient } from './client.js';
import { GeminiChat } from './geminiChat.js';
import { ToolCallRequestInfo } from './turn.js';
import { ToolExecutionEngine, ToolExecutionContext } from './toolExecutionEngine.js';
import { SubAgentAdapter } from './subAgentAdapter.js';
// TaskStateManager 已移除，简化状态管理
import { TaskPrompts } from './taskPrompts.js';
import { SessionManager } from '../services/sessionManager.js';
import { CompressionService } from '../services/compressionService.js';
import { SceneManager, SceneType } from './sceneManager.js';
import { t } from '../utils/simpleI18n.js';
import { AgentDefinition, resolveAgentTools } from '../agents/agentDefinition.js';

// ─── SubAgent 超时与内存保护常量 ───

/** 单轮流式响应的最大 wall-clock 时间。超时后 abort signal 并返回已收集的部分结果。 */
const TURN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** 工具完成回调的最大等待时间。从 10 分钟降至 3 分钟，减少卡住感知时间。 */
const TOOL_COMPLETION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

/** executionLog 最大条目数。超出时截断旧条目，防止内存无限增长。 */
const MAX_EXECUTION_LOG_ENTRIES = 200;

/** SubAgent 整体执行的最大 wall-clock 时间（由 TaskTool 设置，此处仅作文档说明）。 */
// const SUBAGENT_OVERALL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — enforced in TaskTool.execute()

export interface SubAgentExecutionContext {
  agentId: string;
  taskDescription: string;
  currentTurn: number;
  maxTurns: number;
  isRunning: boolean;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface SubAgentResult {
  success: boolean;
  summary: string;
  error?: string;
  /**
   * 失败原因的机读标识。当前已知值：
   * - 'max_turns_exceeded' —— 用尽轮数预算，summary 中已尽量保留子 Agent 的部分发现
   * - 'execution_error'   —— 抛错中止
   * - 'cancelled'         —— 被 AbortSignal 取消
   * 用于主 Agent / UI 据此分类处理。
   */
  reason?: 'max_turns_exceeded' | 'execution_error' | 'cancelled';
  executionLog: string[];
  filesCreated?: string[];
  commandsRun?: string[];
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/**
 * SubAgent - 独立的AI对话和工具执行引擎
 * 用于处理复杂任务的多轮对话和工具调用
 */
export class SubAgent {
  private context: SubAgentExecutionContext;
  private executionLog: string[] = [];
  private subAgentChat?: GeminiChat; // 子Agent专用的chat实例

  // 新架构组件
  private executionEngine: ToolExecutionEngine;
  private adapter: SubAgentAdapter;
  private toolExecutionContext: ToolExecutionContext;

  // 用于等待工具完成回调的Promise resolver
  private toolCompletionResolver?: (results: any[]) => void;
  // 工具完成超时 timer ID，正常完成时 clearTimeout 防止泄漏
  private toolCompletionTimeoutId?: ReturnType<typeof setTimeout>;

  // 待处理的工具结果，下次callGemini时一起发送
  private pendingToolResults: PartListUnion[] = [];

  // 最近一次 AI 响应的文本部分。用于 max_turns 触达时把子 Agent 已写下的
  // 报告/分析返回给主 Agent，避免长时间分析白白浪费。
  private lastAssistantText: string = '';

  // 简化：无需中央状态管理

  // Session管理
  private sessionManager: SessionManager;
  private sessionId: string;

  // 压缩服务
  private compressionService: CompressionService;

  // 🎯 AbortSignal监听器清理函数
  private abortListener: (() => void) | null = null;

  /**
   * 检查AbortSignal状态，如果已被触发则抛出错误
   */
  private checkAbortSignal(): void {
    if (this.abortSignal?.aborted) {
      throw new Error(`Task cancelled by AbortSignal`);
    }
  }

  constructor(
    private readonly config: Config,
    private readonly toolRegistry: ToolRegistry,
    private readonly geminiClient: GeminiClient,
    private readonly updateOutput?: (output: string) => void,
    private readonly abortSignal?: AbortSignal,
    private readonly externalPreToolExecutionHandler?: PreToolExecutionHandler,
    private readonly agentDefinition?: AgentDefinition,
    /** Optional model override — when set this sub-agent uses a different model than the global default. */
    private readonly modelOverride?: string,
    /** Optional callback invoked after each turn with the latest token usage (for real-time UI updates). */
    private readonly onTokenUpdate?: (tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void,
  ) {
    this.context = {
      agentId: `subagent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      taskDescription: '',
      currentTurn: 0,
      maxTurns: 10,
      isRunning: false,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    };

    // Initialize Session management
    this.sessionManager = new SessionManager(this.config.getProjectRoot());
    this.sessionId = this.config.getSessionId();

    // Initialize compression service
    this.compressionService = new CompressionService({
      compressionTokenThreshold: 0.8, // SubAgent 使用更高阈值，避免过早压缩
      compressionPreserveThreshold: 0.3, // 保留适中历史，确保任务连续性
      skipEnvironmentMessages: 2, // 只跳过真正的环境信息，任务描述是执行历史的一部分
    });

    // 创建子Agent执行上下文
    this.toolExecutionContext = {
      agentId: this.context.agentId,
      agentType: 'sub',
      taskDescription: this.context.taskDescription,
    };

    // 创建SubAgent适配器，传入工具完成回调处理器
    this.adapter = new SubAgentAdapter(
      updateOutput,
      (message) => this.executionLog.push(message),
      this.handleToolsComplete.bind(this), // 添加工具完成处理器
      this.toolRegistry, // 传入工具注册表
      this.externalPreToolExecutionHandler, // 传入外部预执行回调
    );

    // 创建独立的工具执行引擎
    this.executionEngine = new ToolExecutionEngine({
      toolRegistry: Promise.resolve(this.createSubAgentToolRegistry()),
      adapter: this.adapter,
      config: this.config,
      hookEventHandler: this.config.getHookSystem().getEventHandler(),
      approvalMode: this.config.getApprovalMode(),
      getPreferredEditor: () => undefined, // SubAgent通常不需要编辑器
    });
  }

  /**
   * 执行子agent任务的主循环
   */
  async executeTask(
    taskDescription: string,
    maxTurns: number = 10
  ): Promise<SubAgentResult> {
    this.context = {
      ...this.context,
      taskDescription,
      maxTurns,
      currentTurn: 0,
      isRunning: true,
    };

    // 简化：SubAgent 状态通过工具调用状态体现，无需中央注册

    this.log(`SubAgent started: ${taskDescription}`);
    this.sendStatusChange('starting', {
      taskDescription,
    });

    // 🎯 设置AbortSignal监听器 - 信号驱动清理
    if (this.abortSignal) {
      const handleAbort = () => {
        console.debug(`[SubAgent] Received AbortSignal, starting cleanup: ${this.context.agentId}`);
        this.context.isRunning = false;

        // 简化：无需清理中央状态

        this.log('SubAgent received cancellation signal, stopping execution');
        this.sendStatusChange('cancelled', {
          reason: 'abort_signal',
        });
      };

      this.abortSignal.addEventListener('abort', handleAbort);
      this.abortListener = () => {
        this.abortSignal?.removeEventListener('abort', handleAbort);
      };

      // 如果信号已经被触发，立即处理
      if (this.abortSignal.aborted) {
        handleAbort();
        throw new Error('Task was cancelled before startup');
      }
    }

    try {
      // 初始化子agent专用的chat实例
      await this.initializeSubAgentChat(taskDescription);

      this.log(`SubAgent chat instance initialized, available tools: ${this.getAvailableToolNames().length}`);

      // 🎯 发送运行中状态
      this.sendStatusChange('running');

      // 主对话循环
      // 关键改动：在最后一轮显式标注 isFinalTurn，让 callGemini 注入"停止调用工具、立即总结"指令，
      // 这样即便 max_turns 触达，主 Agent 也能拿到子 Agent 已积累的发现。
      while (this.context.currentTurn < this.context.maxTurns && this.context.isRunning) {
        const isFinalTurn = this.context.currentTurn + 1 >= this.context.maxTurns;
        const turnResult = await this.executeConversationTurn(isFinalTurn);

        // 如果任务完成，返回结果
        if (turnResult) {
          return turnResult;
        }
      }

      // 走到这里有两种情况：
      // 1) currentTurn 已耗尽 maxTurns —— 走 handleMaxTurnsReached 返回部分结果
      // 2) 被 abort 信号在循环条件处打断（isRunning=false） —— 抛出统一的取消错误，
      //    交给外层 catch 走 cancelled 路径，避免被错误标注为 max_turns_exceeded
      if (!this.context.isRunning && this.context.currentTurn < this.context.maxTurns) {
        throw new Error('Task cancelled by AbortSignal');
      }
      return this.handleMaxTurnsReached();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(t('task.execution.failed', { error: errorMessage }));
      // 区分主动取消与异常退出，便于主 Agent / UI 显示
      const isCancelled = this.abortSignal?.aborted === true;
      this.sendStatusChange('failed', {
        reason: isCancelled ? 'abort_signal' : 'execution_error',
        error: errorMessage,
        turnsUsed: this.context.currentTurn,
      });
      const result = this.buildErrorResult(error);
      if (isCancelled) {
        result.reason = 'cancelled';
      }
      return result;
    } finally {
      this.context.isRunning = false;

      // 🎯 清理AbortSignal监听器
      if (this.abortListener) {
        this.abortListener();
        this.abortListener = null;
      }

      // 简化：无需完成中央任务

      // 清理待处理的工具结果
      this.pendingToolResults = [];

      this.log(`SubAgent execution ended (final turn: ${this.context.currentTurn})`);
    }
  }

  /**
   * 计算AI响应中的工具调用数量
   */
  private countToolCalls(response: Content): number {
    if (!response.parts) return 0;

    return response.parts.filter(part => {
      // 检查Gemini格式的functionCall
      return !!part.functionCall;
    }).length;
  }

  /**
   * 取消子agent执行
   * 🎯 现在主要依赖AbortSignal机制，这个方法用于兼容性
   */
  cancel(): void {
    this.context.isRunning = false;
    console.debug(`[SubAgent] cancel()被调用: ${this.context.agentId}`);
    // 注意：清理逻辑现在由AbortSignal监听器处理
  }

  /**
   * 构建子agent固定系统提示（不包含任务描述）
   */
  private buildSystemPrompt(): string {
    if (this.agentDefinition) {
      return this.agentDefinition.systemPrompt;
    }

    const availableTools = this.getAvailableToolNames();
    return TaskPrompts.buildSubAgentFixedSystemPrompt(availableTools, this.context.maxTurns);
  }

  /**
   * 初始化子Agent专用的chat实例
   */
  private async initializeSubAgentChat(taskDescription: string): Promise<void> {
    // 先使用 startChat 创建实例（自动处理环境信息）
    this.subAgentChat = await this.geminiClient.startChat(
      [], // 空的额外历史
      { type: 'sub', agentId: this.context.agentId, taskDescription }
    );

    // Apply per-agent model override if specified
    if (this.modelOverride) {
      this.subAgentChat.setSpecifiedModel(this.modelOverride);
    }

    // 然后修改系统指令
    (this.subAgentChat as any).generationConfig.systemInstruction = this.buildSystemPrompt();

    // 设置子agent专用的工具
    const toolDeclarations = this.getSubAgentToolDeclarations();
    if (toolDeclarations.length > 0) {
      this.subAgentChat.setTools([{ functionDeclarations: toolDeclarations }]);
    }

    // 不在初始化时添加任务描述，而是在第一轮callGemini时发送
    this.log('SubAgent chat instance initialization completed');
  }

  /**
   * 执行单轮对话 - 一轮一次AI请求
   * @param isFinalTurn 是否是最后一轮。最后一轮会注入"停止调用工具、立即总结"提示，
   *                    并且即便 AI 仍然返回了工具调用，也不会再实际执行 —— 直接返回 null
   *                    交给主循环走 handleMaxTurnsReached 路径。
   * @returns SubAgentResult 如果任务完成，否则返回 null
   */
  private async executeConversationTurn(isFinalTurn: boolean = false): Promise<SubAgentResult | null> {
    // 🎯 检查AbortSignal - 每轮开始时检查
    this.checkAbortSignal();

    this.context.currentTurn++;
    this.log(`Conversation turn ${this.context.currentTurn}/${this.context.maxTurns}${isFinalTurn ? ' (final turn — summary mode)' : ''}`);

    // 通知 UI 当前轮次，用于显示 Turn X/Y 进度
    this.sendTurnProgress();

    // 每轮调用AI，可能携带待处理的工具结果
    const aiResponse = await this.callGemini(isFinalTurn);

    // 分析AI响应
    const responseAnalysis = this.analyzeAIResponse(aiResponse);
    this.logAIResponse(responseAnalysis);

    // 记录文本部分，无论是否伴随工具调用 —— 用于 max_turns 触达时回收已有发现
    this.lastAssistantText = responseAnalysis.responseText;

    // 如果没有工具调用，任务完成
    if (!responseAnalysis.hasToolCalls) {
      return this.handleTaskCompletion(responseAnalysis.responseText);
    }

    // 最后一轮即便 AI 仍调用了工具也不再执行 —— 直接返回 null 让主循环走 max_turns 路径，
    // 这样可以保留已经获得的文本（即便是部分总结），避免再消耗 credits 跑工具。
    if (isFinalTurn) {
      this.log('Final turn produced tool calls instead of summary; skipping tool execution to preserve findings.');
      return null;
    }

    // 有工具调用：执行工具并准备下轮携带结果
    await this.processAndStorePendingToolResults(aiResponse, responseAnalysis.toolCount);

    await this.tryCompressHistory();

    return null; // 继续下一轮对话，携带工具结果
  }



  /**
   * 分析AI响应
   */
  private analyzeAIResponse(aiResponse: Content): {
    responseText: string;
    hasToolCalls: boolean;
    toolCount: number;
  } {
    const responseText = this.extractTextFromResponse(aiResponse);
    const hasToolCalls = this.hasToolCalls(aiResponse);
    const toolCount = this.countToolCalls(aiResponse);

    return { responseText, hasToolCalls, toolCount };
  }

  /**
   * 记录AI响应信息
   */
  private logAIResponse(analysis: { responseText: string; hasToolCalls: boolean }): void {
    const { responseText, hasToolCalls } = analysis;
    const truncatedText = responseText.length > 100
      ? `${responseText.substring(0, 100)}...`
      : responseText;

    this.log(`AI response: ${truncatedText} (${hasToolCalls ? 'with' : 'without'} tool calls)`);
  }

  /**
   * 处理任务完成
   */
  private handleTaskCompletion(responseText: string): SubAgentResult {
    this.log('AI did not call any tools, task completed');

    const summary = responseText.trim() || 'Task completed';
    this.sendStatusChange('completing', { summary });

    return this.buildSuccessResult(summary);
  }

  /**
   * 执行工具调用并存储结果，下次callGemini时一起发送
   */
  private async processAndStorePendingToolResults(aiResponse: Content, toolCount: number): Promise<void> {
    // 🎯 工具调用前检查 - 这可能是长时间操作
    this.checkAbortSignal();

    this.log(`Starting execution of ${toolCount} tool calls`);

    // 执行工具调用
    const toolCallRequests: ToolCallRequestInfo[] = [];

    // 提取工具调用请求 - Gemini格式
    aiResponse.parts?.forEach(part => {
      if (part.functionCall && part.functionCall.name) {
        const toolName = part.functionCall.name;
        const toolArgs = part.functionCall.args || {};
        const toolId = part.functionCall.id || `${part.functionCall.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const toolCallRequest: ToolCallRequestInfo = {
          callId: toolId,
          name: toolName,
          args: toolArgs,
          isClientInitiated: false,
          prompt_id: this.context.agentId,
        };
        toolCallRequests.push(toolCallRequest);

        this.log(`📋 Tool call request: ${toolName}(${toolId})`);
      }
    });

    if (toolCallRequests.length === 0) {
      return;
    }

    // SubAgent 工具等待超时：从 10 分钟降至 3 分钟，减少卡住感知时间
    // 正常完成时 clearTimeout 防止 timer 泄漏
    try {
      // 创建Promise等待工具完成回调，附加超时保护
      const toolCompletionPromise = new Promise<any[]>((resolve, reject) => {
        this.toolCompletionResolver = resolve;
        this.toolCompletionTimeoutId = setTimeout(() => {
          if (this.toolCompletionResolver) {
            this.toolCompletionResolver = undefined;
            this.toolCompletionTimeoutId = undefined;
            const toolNames = toolCallRequests.map(r => r.name).join(', ');
            reject(new Error(
              `Tool completion timeout after ${TOOL_COMPLETION_TIMEOUT_MS / 1000}s. ` +
              `Stuck tool(s): [${toolNames}]. The tool may have hung — aborting this turn.`
            ));
          }
        }, TOOL_COMPLETION_TIMEOUT_MS);
      });

      // 启动工具执行
      this.executionEngine.executeTools(
        toolCallRequests,
        this.toolExecutionContext,
        this.abortSignal!,
      ).catch(error => {
        this.log(`Tool execution engine error: ${error instanceof Error ? error.message : String(error)}`);
      });

      // 等待工具完成回调
      const completedCalls = await toolCompletionPromise;

      // 🎯 正常完成：清除超时 timer，防止泄漏
      if (this.toolCompletionTimeoutId !== undefined) {
        clearTimeout(this.toolCompletionTimeoutId);
        this.toolCompletionTimeoutId = undefined;
      }

      this.log(`Received ${completedCalls.length} tool call results via callback`);

      // 将工具结果转换为function responses并存储到pendingToolResults
      completedCalls.forEach((call: any) => {
        this.pendingToolResults.push(call.response?.responseParts);
      });

      // 🎯 工具调用后检查
      this.checkAbortSignal();

      this.log(`${completedCalls.length} tool calls completed, results stored in pending queue`);
    } catch (error) {
      // 🎯 超时或异常：也要清除 timer
      if (this.toolCompletionTimeoutId !== undefined) {
        clearTimeout(this.toolCompletionTimeoutId);
        this.toolCompletionTimeoutId = undefined;
      }
      this.log(`Tool execution failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * 调用Gemini AI获取响应
   * @param isFinalTurn 是否是最后一轮。最后一轮会在消息末尾追加 final-turn reminder，
   *                    强制 AI 停止调用工具并立即输出结构化报告。
   */
  private async callGemini(isFinalTurn: boolean = false): Promise<Content> {
    if (!this.subAgentChat) {
      throw new Error('SubAgent chat not initialized');
    }

    // 🎯 在发送AI消息前检查取消信号
    this.checkAbortSignal();

    // 智能消息处理：第一轮发送任务描述，后续轮次合并工具结果和继续消息
    const isFirstTurn = this.context.currentTurn === 1;
    let messageParts: any[] = [];

    if (isFirstTurn) {
      // 第一轮：发送完整任务描述（带轮数预算提醒）
      messageParts = [{ text: TaskPrompts.buildSubAgentTaskPrompt(this.context.taskDescription, this.context.maxTurns) }];
    } else {
      // 后续轮次：检查是否有待处理的工具结果
      if (this.pendingToolResults.length > 0) {
        // 将待处理的工具结果添加到消息开头
        this.pendingToolResults.forEach(result => {
          if (Array.isArray(result)) {
            messageParts.push(...result);
          } else {
            messageParts.push(result);
          }
        });
        this.pendingToolResults = [];
      }
    }

    // 最后一轮：追加强制总结指令（即便是 maxTurns=1 的极端情况，也会和任务描述一起发送）
    if (isFinalTurn) {
      messageParts.push({
        text: TaskPrompts.buildFinalTurnReminder(this.context.currentTurn, this.context.maxTurns),
      });
    }

    // 📝 保存请求日志
    const timestamp = new Date().toISOString();
    const currentHistory = this.subAgentChat.getHistory();
    const logData = {
      timestamp,
      turn: this.context.currentTurn,
      request: {
        history: currentHistory,
        messageParts
      }
    };

    // 保存请求部分到日志
    await this.sessionManager.saveRequestLog(this.sessionId, logData).catch(error => {
      console.warn('[SubAgent] Failed to save request log:', error);
    });

    // 使用流式接口发送消息，避免非流式 response.json() 在服务端长时间处理时永久挂起
    const streamRequestStart = Date.now();
    this.log(`[turn ${this.context.currentTurn}] Sending stream request (ctx ~${messageParts.length} parts)`);

    // 🛡️ 轮次超时保护：创建本地 AbortController，与外部 signal 组合
    // 如果单轮流式响应超过 TURN_TIMEOUT_MS（5 分钟），主动中断流并返回已收集的部分结果
    const turnAbortController = new AbortController();
    const turnTimeoutId = setTimeout(() => {
      this.log(`[turn ${this.context.currentTurn}] ⚠️ Turn timeout (${TURN_TIMEOUT_MS / 1000}s) — aborting stream`);
      turnAbortController.abort();
    }, TURN_TIMEOUT_MS);

    // 组合外部 signal 和轮次超时 signal：任一触发都中断流
    const combinedSignal = this.abortSignal
      ? AbortSignal.any([this.abortSignal, turnAbortController.signal])
      : turnAbortController.signal;

    // 如果外部 signal 已经 abort，直接抛出
    if (this.abortSignal?.aborted) {
      clearTimeout(turnTimeoutId);
      throw new Error('Task cancelled by AbortSignal');
    }

    const streamGenerator = await this.subAgentChat.sendMessageStream({
      message: messageParts,
      config: {
        abortSignal: combinedSignal
      }
    }, this.context.agentId, SceneType.SUB_AGENT);

    this.log(`[turn ${this.context.currentTurn}] Stream connection established (${Date.now() - streamRequestStart}ms)`);

    // 消费 AsyncGenerator，将所有 chunks 合并为单个 Content
    const tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
    const allParts: any[] = [];
    let lastUsageMetadata: any = null;
    let chunkCount = 0;
    let firstChunkMs: number | undefined;
    let turnTimedOut = false;

    // 心跳定时器：每30秒打印一次，区分"AI慢慢推理"和"真的卡住"
    const heartbeatId = setInterval(() => {
      const elapsed = Math.round((Date.now() - streamRequestStart) / 1000);
      this.log(`[turn ${this.context.currentTurn}] Still receiving stream... ${elapsed}s elapsed, ${chunkCount} chunks so far`);
    }, 30000);

    try {
      for await (const chunk of streamGenerator) {
        // 跳过取消信号已触发的情况
        if (this.abortSignal?.aborted) break;

        // 🛡️ 检查轮次超时
        if (turnAbortController.signal.aborted) {
          turnTimedOut = true;
          this.log(`[turn ${this.context.currentTurn}] Turn timed out — returning partial response with ${allParts.length} parts collected so far`);
          break;
        }

        chunkCount++;
        if (chunkCount === 1) {
          firstChunkMs = Date.now() - streamRequestStart;
          this.log(`[turn ${this.context.currentTurn}] First chunk received (${firstChunkMs}ms)`);
        }

        // 收集 parts（排除纯 thought 内容，与 geminiChat.processStreamResponse 保持一致）
        const content = chunk.candidates?.[0]?.content;
        if (content?.parts) {
          for (const part of content.parts) {
            // thought 不进入最终 Content（与主 Agent 行为一致）
            if ((part as any).thought === true) continue;
            allParts.push(part);
          }
        }

        // 记录最后一个含有 usageMetadata 的 chunk
        if (chunk.usageMetadata) {
          lastUsageMetadata = chunk.usageMetadata;
        }
      }
    } finally {
      clearInterval(heartbeatId);
      clearTimeout(turnTimeoutId);
      const totalMs = Date.now() - streamRequestStart;
      this.log(`[turn ${this.context.currentTurn}] Stream done: ${chunkCount} chunks, first=${firstChunkMs ?? 'n/a'}ms, total=${totalMs}ms${turnTimedOut ? ' (TIMED OUT)' : ''}`);
    }

    if (lastUsageMetadata) {
      tokenUsage.inputTokens = lastUsageMetadata.promptTokenCount || 0;
      tokenUsage.outputTokens = lastUsageMetadata.candidatesTokenCount || 0;
      tokenUsage.totalTokens = lastUsageMetadata.totalTokenCount || 0;

      this.context.tokenUsage.inputTokens += tokenUsage.inputTokens;
      this.context.tokenUsage.outputTokens += tokenUsage.outputTokens;
      this.context.tokenUsage.totalTokens += tokenUsage.totalTokens;

      // Notify caller of latest cumulative token usage for real-time UI
      this.onTokenUpdate?.(this.context.tokenUsage);
    }

    // 将合并后的 parts 组装为 Content
    const aiContent: Content = {
      role: MESSAGE_ROLES.MODEL,
      parts: allParts
    };

    // 📝 保存完整日志（包含响应）
    const fullLogData = {
      ...logData,
      response: {
        content: aiContent,
        tokenUsage
      }
    };

    // 覆盖保存完整日志
    await this.sessionManager.saveRequestLog(this.sessionId, fullLogData).catch(error => {
      console.warn('[SubAgent] Failed to save response log:', error);
    });

    return aiContent;
  }

  /**
   * 检查响应中是否包含工具调用 - Gemini格式
   */
  private hasToolCalls(response: Content): boolean {
    return response.parts?.some(part => !!part.functionCall) || false;
  }

  /**
   * 处理工具完成回调
   */
  private handleToolsComplete(completedCalls: any[]): void {
    if (this.toolCompletionResolver) {
      this.toolCompletionResolver(completedCalls);
      this.toolCompletionResolver = undefined;
    }
  }

  /**
   * 获取SubAgentAdapter的执行统计
   */
  private getExecutionStats(): {
    filesCreated: string[];
    commandsRun: string[];
    executionLog: string[];
  } {
    return {
      filesCreated: this.adapter.getFilesCreated(),
      commandsRun: this.adapter.getCommandsRun(),
      executionLog: this.executionLog,
    };
  }

  /**
   * 从AI响应中提取文本 - Gemini格式
   */
  private extractTextFromResponse(response: Content): string {
    return (response.parts || [])
      .map(part => part.text || '')
      .filter(text => text.trim().length > 0)
      .join('\n');
  }

  /**
   * 创建子agent专用的工具注册表
   */
  private createSubAgentToolRegistry(): ToolRegistry {
    const subAgentRegistry = new ToolRegistry(this.config);

    const allTools = this.toolRegistry.getAllTools();
    const resolvedTools = this.agentDefinition
      ? resolveAgentTools(this.agentDefinition, allTools).resolvedTools
      : allTools.filter(tool => tool.allowSubAgentUse);

    resolvedTools.forEach(tool => {
      subAgentRegistry.registerTool(tool);
    });

    return subAgentRegistry;
  }

  /**
   * 获取子agent可用的工具名称
   */
  private getAvailableToolNames(): string[] {
    return this.createSubAgentToolRegistry()
      .getAllTools()
      .map(tool => tool.name);
  }

  /**
   * 获取子agent的工具声明
   */
  private getSubAgentToolDeclarations() {
    return this.createSubAgentToolRegistry().getFunctionDeclarations();
  }

  /**
   * 构建成功结果
   */
  private buildSuccessResult(summary: string): SubAgentResult {
    const stats = this.getExecutionStats();
    return {
      success: true,
      summary,
      executionLog: stats.executionLog,
      filesCreated: stats.filesCreated,
      commandsRun: stats.commandsRun,
      tokenUsage: this.context.tokenUsage,
    };
  }

  /**
   * 构建错误结果
   */
  private buildErrorResult(error: unknown): SubAgentResult {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.log(`❌ Execution error: ${errorMessage}`);

    const stats = this.getExecutionStats();
    return {
      success: false,
      summary: `Task execution failed: ${errorMessage}`,
      error: errorMessage,
      reason: 'execution_error',
      executionLog: stats.executionLog,
      filesCreated: stats.filesCreated,
      commandsRun: stats.commandsRun,
      tokenUsage: this.context.tokenUsage,
    };
  }

  /**
   * 处理 max_turns 触达：把子 Agent 在最后一轮已生成的文本（lastAssistantText）
   * 作为 summary 返回给主 Agent，避免长时间分析白白浪费。
   *
   * 即便 lastAssistantText 为空（极端情况：AI 在最后一轮仍坚持只调用工具不写文本），
   * 也会附带明确的 fallback 提示，让主 Agent 知道发生了什么。
   *
   * status 仍标记为 'failed' / reason 'max_turns_exceeded'，UI 不会误以为成功。
   */
  private handleMaxTurnsReached(): SubAgentResult {
    const turnsUsed = this.context.currentTurn;
    const header = t('task.timeout.partial.header', { turns: turnsUsed });
    const creditsNotice = t('task.timeout.credits.notice');
    const fallback = t('task.timeout.partial.no_summary');

    const summary = TaskPrompts.buildPartialResultSummary(
      this.lastAssistantText,
      header,
      creditsNotice,
      fallback,
    );

    this.log(`Max turns reached after ${turnsUsed} turn(s); returning partial summary (${this.lastAssistantText.trim().length} chars of assistant text).`);

    this.sendStatusChange('failed', {
      reason: 'max_turns_exceeded',
      summary,
      turnsUsed,
    });

    const stats = this.getExecutionStats();
    return {
      success: false,
      summary,
      error: t('task.timeout.warning', { turns: turnsUsed }),
      reason: 'max_turns_exceeded',
      executionLog: stats.executionLog,
      filesCreated: stats.filesCreated,
      commandsRun: stats.commandsRun,
      tokenUsage: this.context.tokenUsage,
    };
  }

  /**
   * 发送当前轮次进度通知，用于 UI 显示 Turn X/Y
   */
  private sendTurnProgress(): void {
    const event = {
      type: 'conversation_turn',
      agentId: this.context.agentId,
      turnNumber: this.context.currentTurn,
      maxTurns: this.context.maxTurns,
      timestamp: Date.now(),
    };
    this.updateOutput?.(`SUBAGENT_EVENT:${JSON.stringify(event)}`);
  }

  /**
   * 发送状态变化通知
   */
  private sendStatusChange(status: string, details?: any): void {
    const statusEvent = {
      type: 'status_change',
      agentId: this.context.agentId,
      status,
      currentTurn: this.context.currentTurn,
      maxTurns: this.context.maxTurns,
      taskDescription: this.context.taskDescription,
      timestamp: Date.now(),
      ...details,
    };

    const structuredUpdate = `SUBAGENT_STATUS_CHANGE:${JSON.stringify(statusEvent)}`;
    this.updateOutput?.(structuredUpdate);
  }

  /**
   * Log method with timestamp prefix
   */
  private log(message: string): void {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const formattedMessage = `[${timestamp}] ${message}`;
    this.executionLog.push(formattedMessage);
    // 🛡️ 防止 executionLog 无限增长导致 OOM：超出上限时截断旧条目
    if (this.executionLog.length > MAX_EXECUTION_LOG_ENTRIES) {
      this.executionLog = this.executionLog.slice(-MAX_EXECUTION_LOG_ENTRIES);
    }
    console.log('[SubAgent] ' + formattedMessage);
  }

  /**
   * 尝试压缩对话历史
   * 🛡️ 加固：压缩失败时，如果历史过长（超过 50 条消息），强制截断旧轮次，
   * 防止对话历史无限增长导致 OOM。
   */
  private async tryCompressHistory(): Promise<void> {
    if (!this.subAgentChat) {
      return;
    }

    try {
      const currentHistory = this.subAgentChat.getHistory(true); // 使用精选历史进行压缩
      const compressionModel = SceneManager.getModelForScene(SceneType.COMPRESSION);
      const historyModel = this.config.getModel(); // subAgent历史使用的模型，用于测算长度

      // 使用压缩服务检查并执行压缩
      const compressionResult = await this.compressionService.tryCompress(
        this.config,
        currentHistory,
        historyModel!,
        compressionModel!,
        this.geminiClient, // 传递 GeminiClient 实例而不是 ContentGenerator
        this.context.agentId,
        this.abortSignal!
      );

      if (compressionResult && compressionResult.success && compressionResult.newHistory) {
        // 应用压缩结果：直接设置新的历史记录
        this.subAgentChat.setHistory(compressionResult.newHistory);

        this.log(`📦 Conversation history compressed: ${compressionResult.compressionInfo?.originalTokenCount} -> ${compressionResult.compressionInfo?.newTokenCount} tokens`);
      }
    } catch (error) {
      // 压缩失败不应该影响正常执行
      this.log(`⚠️ Conversation history compression failed: ${error instanceof Error ? error.message : String(error)}`);

      // 🛡️ 硬截断兜底：压缩失败时，如果历史过长，强制截断旧轮次防止 OOM
      this.truncateHistoryIfTooLong();
    }
  }

  /**
   * 🛡️ 硬截断兜底：当压缩失败且历史过长时，强制截断旧轮次。
   * 保留系统指令 + 最近 N 轮对话，丢弃中间历史。
   * 这是最后的防线，确保即使压缩服务完全不可用，历史也不会无限增长。
   */
  private truncateHistoryIfTooLong(): void {
    if (!this.subAgentChat) return;

    const MAX_HISTORY_MESSAGES = 50; // 最多保留 50 条消息（约 25 轮对话）
    const currentHistory = this.subAgentChat.getHistory();

    if (currentHistory.length <= MAX_HISTORY_MESSAGES) return;

    // 保留前 2 条（通常是系统指令 + 第一轮任务描述）和最近的消息
    const keepHead = 2;
    const keepTail = MAX_HISTORY_MESSAGES - keepHead;
    const truncatedHistory = [
      ...currentHistory.slice(0, keepHead),
      ...currentHistory.slice(-keepTail),
    ];

    this.subAgentChat.setHistory(truncatedHistory);
    this.log(`🛡️ History truncated: ${currentHistory.length} -> ${truncatedHistory.length} messages (compression fallback)`);
  }

  /**
   * 获取适配器实例
   */
  getAdapter(): SubAgentAdapter {
    return this.adapter;
  }
}
