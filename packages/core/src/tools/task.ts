/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { Type } from '@google/genai';
import {
  BaseTool,
  ToolResult,
  Icon,
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolExecutionServices
} from './tools.js';
import { ToolRegistry } from './tool-registry.js';
import { Config } from '../config/config.js';
import { GeminiClient } from '../core/client.js';
import { SubAgent, SubAgentResult } from '../core/subAgent.js';
import { ToolExecutionContext } from '../core/toolSchedulerAdapter.js';
import { createSubAgentUpdateMessage } from './toolOutputMessage.js';
import { SubAgentDisplay } from './tools.js';
import { TaskPrompts } from '../core/taskPrompts.js';
import {
  AgentDefinition,
  BUILT_IN_AGENT_TYPES,
  DEFAULT_SUBAGENT_AGENT_TYPE,
  getBuiltInAgentDefinition,
  resolveAgentTools,
} from '../agents/agentDefinition.js';

// Type alias for easier usage within this module
type SubAgentDisplayData = SubAgentDisplay;
type SubAgentToolCall = SubAgentDisplay['toolCalls'][0];

/**
 * 创建初始的SubAgent显示数据
 */
function createInitialSubAgentDisplay(
  agentId: string,
  taskDescription: string,
  description: string,
  maxTurns: number
): SubAgentDisplayData {
  return {
    type: 'subagent_display',
    agentId,
    taskDescription,
    description,
    status: 'starting',
    currentTurn: 0,
    maxTurns,
    toolCalls: [],
    stats: {
      filesCreated: [],
      commandsRun: [],
      totalToolCalls: 0,
      successfulToolCalls: 0,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    },
    showDetailedProcess: true,
    startTime: Date.now(),
  };
}



/**
 * Parameters for the Task tool
 */
export interface TaskToolParams {
  /**
   * 子Agent类型。当前默认支持 code-analysis，未来可扩展为更多内置/自定义Agent。
   */
  agent_type?: string;

  /**
   * 任务的详细描述 - 告诉子agent要完成什么
   */
  prompt: string;

  /**
   * 任务的简短描述 (3-5个字)，用于UI展示
   */
  description: string;

  /**
   * 最大对话轮数限制 (防止无限循环)
   */
  max_turns: number;
}

/**
 * Task工具 - 启动子agent执行复杂任务
 *
 * 这个工具创建一个独立的子agent来处理复杂的多步骤任务，
 * 子agent具备与AI多轮对话和调用工具的能力
 */
export class TaskTool extends BaseTool<TaskToolParams, ToolResult> {
  static readonly Name: string = 'task';



  constructor(
    private readonly config: Config,
    private readonly toolRegistry: ToolRegistry,
  ) {
    super(
      TaskTool.Name,
      'Code Analysis Expert', // 代码分析专家
      // 启动一个专业的代码分析子agent，深入探索代码库并提供综合技术洞察。该分析专家将系统性地分析代码模式、依赖关系和架构决策，提供详细的分析报告以帮助做出明智的实现决策。最适合用于代码库探索、架构分析和技术调研。
      'Launch a specialized code analysis sub-agent that deeply explores codebases and provides comprehensive technical insights. This analysis expert systematically analyzes code patterns, dependencies, and architectural decisions to provide detailed analysis reports for informed implementation decisions. Best used for codebase exploration, architecture analysis, and technical research.',
      Icon.Tasks,
      {
        type: Type.OBJECT,
        properties: {
          agent_type: {
            type: Type.STRING,
            description: `Sub-agent type to use. Defaults to ${DEFAULT_SUBAGENT_AGENT_TYPE}. Available built-in agents: ${BUILT_IN_AGENT_TYPES.join(', ')}.`,
          },
          prompt: {
            type: Type.STRING,
            // 要分析的内容或问题的详细描述。分析专家将系统性地探索相关代码，理解架构和模式，并提供深入的技术洞察和实现建议。
            description: 'Detailed description of what to analyze or investigate. The analysis expert will systematically explore relevant code, understand architecture and patterns, and provide deep technical insights and implementation recommendations.',
          },
          description: {
            type: Type.STRING,
            // 分析任务的简短描述(3-5个字)，用于UI显示
            description: 'Short description (3-5 words) of the analysis task for UI display',
          },
          max_turns: {
            type: Type.NUMBER,
            description: 'Maximum conversation turns. You MUST set this explicitly based on task complexity: 3-5 for simple lookups (find a function, check a config value, locate a file), 6-12 for moderate tasks (trace a feature across files, understand a module), 12-20 for complex tasks (multi-file dependency analysis, architecture overview). Only use 20-30 for very deep cross-cutting investigations. Always set this as low as feasible to save tokens.',
            minimum: 1,
            maximum: 30,
          },
        },
        required: ['prompt', 'description', 'max_turns'],
      },
      true,  // isOutputMarkdown
      false, // forceMarkdown
      true,  // canUpdateOutput - 支持实时输出
      false, // allowSubAgentUse - Task工具本身不允许被子agent调用(防止无限嵌套)
    );
  }

  validateToolParams(params: TaskToolParams): string | null {
    if (!params.prompt || params.prompt.trim().length === 0) {
      return TaskPrompts.VALIDATION_ERRORS.TASK_DESCRIPTION_EMPTY;
    }

    if (!params.description || params.description.trim().length === 0) {
      return '任务描述不能为空';
    }

    if (params.max_turns === undefined || params.max_turns === null) {
      return TaskPrompts.VALIDATION_ERRORS.MAX_TURNS_REQUIRED;
    }

    if (params.max_turns < 1 || params.max_turns > 30) {
      return TaskPrompts.VALIDATION_ERRORS.MAX_TURNS_OUT_OF_RANGE;
    }

    if (params.agent_type && !BUILT_IN_AGENT_TYPES.includes(params.agent_type as typeof BUILT_IN_AGENT_TYPES[number])) {
      return `Unsupported agent_type '${params.agent_type}'. Available agent types: ${BUILT_IN_AGENT_TYPES.join(', ')}`;
    }

    return null;
  }

  async shouldConfirmExecute(
    params: TaskToolParams,
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    // Task工具本身不需要确认
    return false;
  }



  getDescription(params: TaskToolParams): string {
    const agentDefinition = getBuiltInAgentDefinition(
      params.agent_type,
      [],
      params.max_turns,
    );

    return agentDefinition?.displayName ?? params.description;
  }

  toolLocations(params: TaskToolParams): Array<{ path: string; type: 'file' | 'directory' }> {
    // 返回空数组使多个task调用可以真正并行执行
    // SubAgent内部有自己独立的ToolExecutionEngine，其子工具调用仍会通过FileOperationQueue保证文件安全
    return [];
  }

  async execute(
    params: TaskToolParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
    services?: ToolExecutionServices,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Parameter Validation Failed: ${validationError}`,
        returnDisplay: `Parameter Validation Failed: ${validationError}`,
      };
    }

    // 创建初始的SubAgent显示数据（局部变量）
    const agentId = `subagent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let currentDisplayData = createInitialSubAgentDisplay(
      agentId,
      params.prompt,
      params.description,
      params.max_turns
    );

    // 创建状态感知的updateOutput包装器
    const wrappedUpdateOutput = (output: string) => {
      // 处理结构化状态更新消息
      if (output.startsWith('TOOL_CALL_UPDATE:')) {
        try {
          const data = JSON.parse(output.replace('TOOL_CALL_UPDATE:', ''));
          currentDisplayData = this.updateSubAgentToolCall(currentDisplayData, data);
          updateOutput?.(createSubAgentUpdateMessage(currentDisplayData));
          return;
        } catch (error) {
          console.warn('解析TOOL_CALL_UPDATE失败:', error);
        }
      }

      if (output.startsWith('SUBAGENT_STATUS_CHANGE:')) {
        try {
          const data = JSON.parse(output.replace('SUBAGENT_STATUS_CHANGE:', ''));
          currentDisplayData = this.handleStatusChangeEvent(currentDisplayData, data);
          updateOutput?.(createSubAgentUpdateMessage(currentDisplayData));
          return;
        } catch (error) {
          console.warn('解析SUBAGENT_STATUS_CHANGE失败:', error);
        }
      }

      if (output.startsWith('SUBAGENT_EVENT:')) {
        try {
          const data = JSON.parse(output.replace('SUBAGENT_EVENT:', ''));
          currentDisplayData = this.handleSubAgentEvent(currentDisplayData, data);
          updateOutput?.(createSubAgentUpdateMessage(currentDisplayData));
          return;
        } catch (error) {
          console.warn('解析SUBAGENT_EVENT失败:', error);
        }
      }

      // 其他消息直接传递
      updateOutput?.(output);
    };

    // 发送初始状态
    wrappedUpdateOutput(createSubAgentUpdateMessage(currentDisplayData));

    try {
      // 获取已初始化的 GeminiClient
      const geminiClient = this.config.getGeminiClient();
      if (!geminiClient) {
        throw new Error(TaskPrompts.EXECUTION_ERRORS.GEMINI_CLIENT_NOT_INITIALIZED);
      }

      // 验证 GeminiClient 是否已经正确初始化
      try {
        geminiClient.getChat();
      } catch (chatError) {
        const errorMsg = chatError instanceof Error ? chatError.message : String(chatError);
        throw new Error(TaskPrompts.EXECUTION_ERRORS.GEMINI_CLIENT_NOT_READY(errorMsg));
      }

      // 更新状态为启动中
      currentDisplayData = {
        ...currentDisplayData,
        status: 'starting',
      };
      wrappedUpdateOutput(createSubAgentUpdateMessage(currentDisplayData));

      // 创建子agent实例 - 使用AgentDefinition过滤后的工具
      const agentDefinition = this.createAgentDefinition(params);
      const subAgent = new SubAgent(
        this.config,
        this.createFilteredToolRegistry(agentDefinition),
        geminiClient,
        wrappedUpdateOutput,
        signal,
        services?.onPreToolExecution, // 🎯 传入外部预执行回调（用于git快照等）
        agentDefinition,
      );

      // 🎯 直接使用services中的statusUpdateCallback
      if (services?.statusUpdateCallback) {
        subAgent.getAdapter().setStatusUpdateCallback(services.statusUpdateCallback);
      }

      // 更新状态为运行中
      currentDisplayData = {
        ...currentDisplayData,
        status: 'running',
      };
      wrappedUpdateOutput(createSubAgentUpdateMessage(currentDisplayData));

      // 执行任务
      // 🛡️ 整体超时保护：SubAgent 执行最多 30 分钟，防止无限运行导致 OOM 或卡死
      const SUBAGENT_OVERALL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
      // 将 timeoutId 提取为独立变量，避免在 Promise executor 内部引用尚未赋值的
      // const 变量（TDZ ReferenceError），导致整体超时保护完全失效。
      let overallTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const overallTimeoutPromise = new Promise<SubAgentResult>((_, reject) => {
        overallTimeoutId = setTimeout(() => {
          subAgent.cancel();
          reject(new Error(`SubAgent overall timeout after ${SUBAGENT_OVERALL_TIMEOUT_MS / 1000}s — forcibly cancelled`));
        }, SUBAGENT_OVERALL_TIMEOUT_MS);
      });

      let result: SubAgentResult;
      try {
        result = await Promise.race([
          subAgent.executeTask(params.prompt, params.max_turns),
          overallTimeoutPromise,
        ]);
      } catch (overallTimeoutError) {
        // 整体超时：返回部分结果而不是让错误传播
        const errorMessage = overallTimeoutError instanceof Error ? overallTimeoutError.message : String(overallTimeoutError);
        console.warn(`[TaskTool] SubAgent overall timeout: ${errorMessage}`);
        result = {
          success: false,
          summary: `Task execution timed out after ${SUBAGENT_OVERALL_TIMEOUT_MS / 1000}s. Partial results may be available in the execution log.`,
          error: errorMessage,
          reason: 'execution_error',
          executionLog: [],
          tokenUsage: currentDisplayData.stats.tokenUsage,
        };
      } finally {
        // 🛡️ 清理整体超时 timer，防止泄漏
        if (overallTimeoutId !== undefined) {
          clearTimeout(overallTimeoutId);
          overallTimeoutId = undefined;
        }
      }

      // 更新最终状态和统计
      const finalStats = {
        filesCreated: result.filesCreated || [],
        commandsRun: result.commandsRun || [],
        totalToolCalls: currentDisplayData.stats.totalToolCalls,
        successfulToolCalls: currentDisplayData.stats.successfulToolCalls,
        tokenUsage: result.tokenUsage || currentDisplayData.stats.tokenUsage,
      };

      currentDisplayData = {
        ...currentDisplayData,
        status: result.success ? 'completed' : 'failed',
        summary: result.summary,
        error: result.error,
        showDetailedProcess: false, // 🎯 完成后隐藏详细过程
        endTime: Date.now(),
        stats: finalStats,
      };

      // 发送最终状态
      wrappedUpdateOutput(createSubAgentUpdateMessage(currentDisplayData));

      // 返回结构化数据而不是文本
      // 对 max_turns 触达的特殊路径，summary 中已包含 i18n 警告 + 子 Agent 的部分发现，
      // 此时不应再加 "Task Failed:" 前缀（会让主 Agent 误判为完全失败丢信息），
      // 改为 "Task Partially Completed (max turns reached):" 提示主 Agent 这是部分结果。
      let llmContent: string;
      if (result.success) {
        llmContent = `Task Completed: ${result.summary}`;
      } else if (result.reason === 'max_turns_exceeded') {
        llmContent = `Task Partially Completed (max turns reached):\n${result.summary}`;
      } else {
        llmContent = `Task Failed: ${result.summary}`;
      }
      return {
        llmContent,
        returnDisplay: currentDisplayData,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 更新错误状态
      currentDisplayData = {
        ...currentDisplayData,
        status: 'failed',
        error: errorMessage,
        showDetailedProcess: false,
        endTime: Date.now(),
      };
      wrappedUpdateOutput(createSubAgentUpdateMessage(currentDisplayData));

      return {
        llmContent: `Task Failed: ${errorMessage}`,
        returnDisplay: currentDisplayData,
      };
    }
  }



  /**
   * 更新SubAgent工具调用状态（纯函数）
   */
  private updateSubAgentToolCall(
    displayData: SubAgentDisplayData,
    updates: Partial<SubAgentToolCall> & { callId: string }
  ): SubAgentDisplayData {
    const { callId, ...otherUpdates } = updates;

    // 查找现有工具调用
    const existingIndex = displayData.toolCalls.findIndex(tc => tc.callId === callId);
    let newToolCalls = [...displayData.toolCalls];

    if (existingIndex >= 0) {
      // 更新现有工具调用
      newToolCalls[existingIndex] = {
        ...newToolCalls[existingIndex],
        ...updates,
      };
    } else {
      // 添加新工具调用
      const newToolCall: SubAgentToolCall = {
        callId,
        toolName: updates.toolName || 'unknown',
        description: updates.description || '',
        status: updates.status || 'Pending',
        startTime: updates.startTime || Date.now(),
        ...otherUpdates,
      };
      newToolCalls.push(newToolCall);
    }

    // 🛡️ 防止 toolCalls 无限增长导致 OOM：超过上限时截断旧条目
    const MAX_DISPLAY_TOOL_CALLS = 50;
    if (newToolCalls.length > MAX_DISPLAY_TOOL_CALLS) {
      newToolCalls = newToolCalls.slice(-MAX_DISPLAY_TOOL_CALLS);
    }

    // 重新计算统计信息
    // 注意：totalToolCalls 应反映实际总数（含被截断的），而非仅显示数
    const totalToolCalls = displayData.stats.totalToolCalls + (existingIndex >= 0 ? 0 : 1);
    const newStats = {
      ...displayData.stats,
      totalToolCalls,
      successfulToolCalls: newToolCalls.filter(tc => tc.status === 'Success').length,
    };

    return {
      ...displayData,
      toolCalls: newToolCalls,
      stats: newStats,
    };
  }

  /**
   * 处理状态变化事件（纯函数）
   */
  private handleStatusChangeEvent(
    displayData: SubAgentDisplayData,
    statusEvent: any
  ): SubAgentDisplayData {
    let updates: Partial<SubAgentDisplayData> = {};

    switch (statusEvent.status) {
      case 'starting':
        updates.status = 'starting';
        break;
      case 'running':
        updates.status = 'running';
        break;
      case 'completing':
        updates.status = 'completed';
        updates.showDetailedProcess = false;
        updates.summary = statusEvent.summary;
        break;
      case 'failed':
        updates.status = 'failed';
        updates.showDetailedProcess = false;
        updates.error = statusEvent.error;
        break;
      case 'cancelled':
        updates.status = 'cancelled';
        updates.showDetailedProcess = false;
        break;
    }

    // 更新轮次信息
    if (statusEvent.currentTurn !== undefined) {
      updates.currentTurn = statusEvent.currentTurn;
    }

    return {
      ...displayData,
      ...updates,
    };
  }

  /**
   * 处理SubAgent事件（纯函数）
   */
  private handleSubAgentEvent(
    displayData: SubAgentDisplayData,
    event: any
  ): SubAgentDisplayData {
    let updates: Partial<SubAgentDisplayData> = {};

    switch (event.type) {
      case 'conversation_turn':
        updates.currentTurn = event.turnNumber;
        break;
      case 'tools_batch_complete':
        // 更新统计信息
        updates.stats = {
          ...displayData.stats,
          filesCreated: event.filesCreated || [],
          commandsRun: event.commandsRun || [],
        };
        break;
    }

    return {
      ...displayData,
      ...updates,
    };
  }

  private createAgentDefinition(params: TaskToolParams): AgentDefinition {
    const allTools = this.toolRegistry.getAllTools();
    const selectedAgent = getBuiltInAgentDefinition(
      params.agent_type,
      [],
      params.max_turns,
    );

    if (!selectedAgent) {
      throw new Error(`Unsupported agent_type '${params.agent_type}'. Available agent types: ${BUILT_IN_AGENT_TYPES.join(', ')}`);
    }

    const availableToolNames = resolveAgentTools(
      selectedAgent,
      allTools,
    ).resolvedTools.map(tool => tool.name);

    const hydratedAgent = getBuiltInAgentDefinition(
      selectedAgent.agentType,
      availableToolNames,
      params.max_turns,
    );

    if (!hydratedAgent) {
      throw new Error(`Failed to load built-in agent '${selectedAgent.agentType}'`);
    }

    return hydratedAgent;
  }

  /**
   * 创建过滤后的工具注册表
   * 只包含当前AgentDefinition允许且设置了 allowSubAgentUse: true 的工具
   */
  private createFilteredToolRegistry(agentDefinition: AgentDefinition): ToolRegistry {
    const filteredRegistry = new ToolRegistry(this.config);
    const allTools = this.toolRegistry.getAllTools();
    const resolved = resolveAgentTools(agentDefinition, allTools);

    resolved.resolvedTools.forEach(tool => {
      filteredRegistry.registerTool(tool);
    });

    return filteredRegistry;
  }

}
