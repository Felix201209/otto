/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import {
  ToolCallRequestInfo,
  ToolCallResponseInfo,
  ToolConfirmationOutcome,
  Tool,
  ToolCallConfirmationDetails,
  ToolResult,
  ToolExecutionServices,
  ToolRegistry,
  ApprovalMode,
  EditorType,
  Config,
  logToolCall,
  ToolCallEvent,
  ToolConfirmationPayload,
} from '../index.js';
import { PartListUnion, Part } from '@google/genai';
import { convertToFunctionResponse } from './coreToolScheduler.js';
import { todoStore, checkTodoStaleness } from '../tools/todo-store.js';
import {
  ToolSchedulerAdapter,
  ToolExecutionContext,
} from './toolSchedulerAdapter.js';
import { MCPResponseGuard } from '../services/mcpResponseGuard.js';
import type { HookEventHandler } from '../hooks/hookEventHandler.js';

// Re-export ToolExecutionContext for convenience
export { ToolExecutionContext } from './toolSchedulerAdapter.js';
import {
  isModifiableTool,
  ModifyContext,
  modifyWithEditor,
} from '../tools/modifiable-tool.js';
import { FileOperationQueue } from '../services/fileOperationQueue.js';

/**
 * 工具调用的 Agent 上下文信息
 * 用于区分和管理主Agent和SubAgent的工具调用
 */
export interface ToolCallAgentContext {
  agentId: string;
  agentType: 'main' | 'sub';
  parentAgentId?: string;    // SubAgent 指向创建它的主Agent
  taskDescription?: string;  // SubAgent 的任务描述
}

/**
 * 工具调用状态类型 - 从 coreToolScheduler 中复制
 */
export type ValidatingToolCall = {
  status: 'validating';
  request: ToolCallRequestInfo;
  tool: Tool;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
  agentContext: ToolCallAgentContext;
  subToolCalls?: EngineToolCall[];
};

export type ScheduledToolCall = {
  status: 'scheduled';
  request: ToolCallRequestInfo;
  tool: Tool;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
  agentContext: ToolCallAgentContext;
  subToolCalls?: EngineToolCall[];
};

export type ErroredToolCall = {
  status: 'error';
  request: ToolCallRequestInfo;
  response: ToolCallResponseInfo;
  durationMs?: number;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
  agentContext: ToolCallAgentContext;
  subToolCalls?: EngineToolCall[];
};

export type SuccessfulToolCall = {
  status: 'success';
  request: ToolCallRequestInfo;
  tool: Tool;
  response: ToolCallResponseInfo;
  durationMs?: number;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
  agentContext: ToolCallAgentContext;
  subToolCalls?: EngineToolCall[];
};

export type ExecutingToolCall = {
  status: 'executing';
  request: ToolCallRequestInfo;
  tool: Tool;
  liveOutput?: string | object;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
  agentContext: ToolCallAgentContext;
  subToolCalls?: EngineToolCall[];
};

export type CancelledToolCall = {
  status: 'cancelled';
  request: ToolCallRequestInfo;
  response: ToolCallResponseInfo;
  tool: Tool;
  durationMs?: number;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
  agentContext: ToolCallAgentContext;
  subToolCalls?: EngineToolCall[];
};

export type WaitingToolCall = {
  status: 'awaiting_approval';
  request: ToolCallRequestInfo;
  tool: Tool;
  confirmationDetails: ToolCallConfirmationDetails;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
  agentContext: ToolCallAgentContext;
  subToolCalls?: EngineToolCall[];
};

export type Status = EngineToolCall['status'];

export type EngineToolCall =
  | ValidatingToolCall
  | ScheduledToolCall
  | ErroredToolCall
  | SuccessfulToolCall
  | ExecutingToolCall
  | CancelledToolCall
  | WaitingToolCall;

export type CompletedEngineToolCall =
  | SuccessfulToolCall
  | CancelledToolCall
  | ErroredToolCall;

/**
 * 执行中确认请求接口
 * 用于工具在执行过程中请求用户确认
 */
export interface RuntimeConfirmationRequest {
  details: ToolCallConfirmationDetails;
  context: ToolExecutionContext;
  resolve: (outcome: ToolConfirmationOutcome) => void;
  reject: (error: Error) => void;
}

/**
 * 工具执行引擎配置选项
 */
interface ToolExecutionEngineOptions {
  toolRegistry: Promise<ToolRegistry>;
  adapter: ToolSchedulerAdapter;
  config: Config;
  hookEventHandler?: HookEventHandler;
  approvalMode?: ApprovalMode;
  getPreferredEditor: () => EditorType | undefined;
}

/**
 * 错误响应创建函数 - 从 coreToolScheduler 复制
 */
const createErrorResponse = (
  request: ToolCallRequestInfo,
  error: Error,
): ToolCallResponseInfo => ({
  callId: request.callId,
  error,
  responseParts: {
    functionResponse: {
      id: request.callId,
      name: request.name,
      response: { error: error.message },
    },
  },
  resultDisplay: error.message,
});

/**
 * 工具执行引擎 - 纯粹的工具调度逻辑，与UI完全解耦
 *
 * 这个类包含从CoreToolScheduler中提取的所有核心调度逻辑，
 * 但通过ToolSchedulerAdapter接口与UI交互，实现完全解耦。
 */
export class ToolExecutionEngine {
  // ✅ 唯一的状态源
  private toolCalls: EngineToolCall[] = [];

  private toolRegistry: Promise<ToolRegistry>;
  private adapter: ToolSchedulerAdapter;
  private approvalMode: ApprovalMode;
  private config: Config;
  private getPreferredEditor: () => EditorType | undefined;
  private hookEventHandler?: HookEventHandler;

  // 🛡️ MCP响应保护
  private mcpResponseGuard: MCPResponseGuard;

  // 📁 文件操作队列 - 确保同一文件的编辑操作顺序执行
  private fileOperationQueue: FileOperationQueue;

  // 用于 Promise 驱动的完成检测，避免轮询竞态条件
  private completionResolvers: Array<(calls: CompletedEngineToolCall[]) => void> = [];

  constructor(options: ToolExecutionEngineOptions) {
    this.config = options.config;
    this.toolRegistry = options.toolRegistry;
    this.adapter = options.adapter;
    this.hookEventHandler = options.hookEventHandler;
    this.approvalMode = options.approvalMode ?? ApprovalMode.DEFAULT;
    this.getPreferredEditor = options.getPreferredEditor;
    // 🛡️ 初始化MCP响应保护器
    this.mcpResponseGuard = new MCPResponseGuard({
      maxResponseSize: 100 * 1024, // 100KB - 激进的大小限制，防止一轮请求就消耗完上下文
      contextLowThreshold: 0.2, // 20%
      contextCriticalThreshold: 0.1, // 10%
    });
    // 📁 初始化文件操作队列
    this.fileOperationQueue = new FileOperationQueue();
  }

  /**
   * 🎯 获取当前工具调用状态（只读访问）
   */
  getToolCalls(): readonly EngineToolCall[] {
    return [...this.toolCalls];
  }

  /**
   * 🎯 强制重置引擎状态
   * 用于在开启新 Turn 或发现状态异常时，清理所有挂起的工具调用。
   * 这是一个安全的兜底操作，确保引擎不会因为孤儿调用而永久锁定。
   */
  public reset(): void {
    if (this.toolCalls.length === 0) return;

    // 通知适配器
    const execContext: ToolExecutionContext = {
      agentId: 'system-reset',
      agentType: 'main' as const,
    };

    // 清空状态
    this.toolCalls = [];

    // 通知所有等待完成的 Promise (避免 await executeTools 永久挂起)
    const resolvers = [...this.completionResolvers];
    this.completionResolvers = [];
    resolvers.forEach((resolve) => {
      resolve([]);
    });

    // 通知适配器状态已清空
    this.adapter.onToolCallsUpdate([...this.toolCalls], execContext);
  }

  /**
   * 🎯 获取确认优先级
   */
  private getConfirmationPriority(toolCall: EngineToolCall): number {
    if (toolCall.agentContext.agentType === 'sub') return 1;  // SubAgent 最高优先级
    return 2;  // MainAgent
  }

  /**
   * 🎯 获取当前应该显示的确认（按优先级排序）
   */
  getActiveConfirmation(): WaitingToolCall | null {
    const confirmingCalls = this.toolCalls.filter(tc =>
      tc.status === 'awaiting_approval'
    ) as WaitingToolCall[];

    if (confirmingCalls.length === 0) return null;

    return confirmingCalls.sort((a, b) =>
      this.getConfirmationPriority(a) - this.getConfirmationPriority(b)
    )[0];
  }

  /**
   * 🎯 统一确认处理 - 不再区分runtime vs 工具前确认
   * 内置确认逻辑，通过适配器统一处理
   */
  // async requestConfirmation(
  //   type: 'tool_execution' | 'runtime',
  //   details: ToolCallConfirmationDetails,
  //   context: ToolExecutionContext,
  // ): Promise<ToolConfirmationOutcome> {
  //   // 🎯 为runtime confirmation创建临时工具调用状态
  //   const runtimeCallId = 'runtime-' + Date.now();
  //   const modifiedDetails: ToolCallConfirmationDetails = {
  //     ...details,
  //     title: type === 'runtime'
  //       ? `🔄 执行中确认: ${details.title || details.type}`
  //       : details.title,
  //   };

  //   // 创建Promise等待确认结果
  //   return new Promise<ToolConfirmationOutcome>((resolve, reject) => {
  //     const wrappedDetails: ToolCallConfirmationDetails = {
  //       ...modifiedDetails,
  //       onConfirm: async (outcome: ToolConfirmationOutcome, payload?: any) => {
  //         try {
  //           // 调用原始确认逻辑
  //           await details.onConfirm(outcome, payload);

  //           // 从工具调用列表中移除临时运行时确认调用
  //           this.toolCalls = this.toolCalls.filter(call => call.request.callId !== runtimeCallId);
  //           this.adapter.onToolCallsUpdate([...this.toolCalls], context);

  //           resolve(outcome);
  //         } catch (error) {
  //           // 清理临时调用
  //           this.toolCalls = this.toolCalls.filter(call => call.request.callId !== runtimeCallId);
  //           this.adapter.onToolCallsUpdate([...this.toolCalls], context);
  //           reject(error instanceof Error ? error : new Error(String(error)));
  //         }
  //       },
  //     };

  //     // 🎯 创建临时工具调用来显示运行时确认
  //     const temporaryToolCall: EngineToolCall = {
  //       status: 'awaiting_approval',
  //       request: {
  //         callId: runtimeCallId,
  //         name: 'runtime_confirmation',
  //         args: { confirmation_type: details.type },
  //         isClientInitiated: false,
  //         prompt_id: context.agentId,
  //       },
  //       tool: {
  //         name: 'runtime_confirmation',
  //         displayName: '执行中确认',
  //         schema: { name: 'runtime_confirmation', parameters: { type: 'object', properties: {} } },
  //         execute: async () => ({ llmContent: 'confirmed' }),
  //       } as any,
  //       confirmationDetails: wrappedDetails,
  //       startTime: Date.now(),
  //       agentContext: {
  //         agentId: context.agentId,
  //         agentType: context.agentType,
  //         parentAgentId: context.agentType === 'sub' ? 'main-agent' : undefined,
  //         taskDescription: context.taskDescription,
  //       },
  //     } as any;

  //     // 添加到工具调用列表并通知外界
  //     this.toolCalls.push(temporaryToolCall);
  //     this.adapter.onToolCallsUpdate([...this.toolCalls], context);
  //   });
  // }

  /**
   * 🎯 创建子Agent状态更新回调
   * 当子Agent的工具状态发生变化时，将子工具调用存储到父工具的 subToolCalls 属性中
   */
  private createStatusUpdateCallback(parentContext: ToolExecutionContext, parentCallId: string) {
    return (subAgentToolCalls: any[], subContext: any) => {
      // 找到父工具调用
      const parentToolIndex = this.toolCalls.findIndex(call =>
        call.request.callId === parentCallId
      );

      if (parentToolIndex >= 0) {
        // 🎯 直接把子工具调用存到父工具的 subToolCalls 属性
        this.toolCalls[parentToolIndex] = {
          ...this.toolCalls[parentToolIndex],
          subToolCalls: subAgentToolCalls.map(subCall => ({
            ...subCall,
            agentContext: {
              ...subCall.agentContext,
              parentAgentId: parentCallId,
            }
          }))
        };

        // 通知UI更新（传递嵌套结构）
        this.adapter.onToolCallsUpdate([...this.toolCalls], parentContext);
      }
    };
  }

  /**
   * 检查是否有工具正在运行
   */
  private isRunning(): boolean {
    return this.toolCalls.some(
      (call) =>
        call.status === 'executing' || call.status === 'awaiting_approval',
    );
  }

  /**
   * 设置工具调用状态 - 核心状态管理逻辑
   */
  private setStatusInternal(
    targetCallId: string,
    status: 'success',
    response: ToolCallResponseInfo,
    context?: ToolExecutionContext,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'awaiting_approval',
    confirmationDetails: ToolCallConfirmationDetails,
    context?: ToolExecutionContext,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'error',
    response: ToolCallResponseInfo,
    context?: ToolExecutionContext,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'cancelled',
    reason: string,
    context?: ToolExecutionContext,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'executing' | 'scheduled' | 'validating',
    auxiliaryData?: undefined,
    context?: ToolExecutionContext,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    newStatus: Status,
    auxiliaryData?: unknown,
    context?: ToolExecutionContext,
  ): void {
    const originalCall = this.toolCalls.find(
      (call) => call.request.callId === targetCallId,
    );

    if (!originalCall) {
      console.warn(
        `setStatusInternal: Cannot find tool call with ID ${targetCallId}`,
      );
      return;
    }

    // 根据状态类型更新工具调用对象
    let updatedCall: EngineToolCall;

    switch (newStatus) {
      case 'success':
        updatedCall = {
          ...originalCall,
          status: 'success',
          response: auxiliaryData as ToolCallResponseInfo,
          durationMs: originalCall.startTime
            ? Date.now() - originalCall.startTime
            : undefined,
        } as SuccessfulToolCall;
        break;

      case 'error':
        updatedCall = {
          ...originalCall,
          status: 'error',
          response: auxiliaryData as ToolCallResponseInfo,
          durationMs: originalCall.startTime
            ? Date.now() - originalCall.startTime
            : undefined,
        } as ErroredToolCall;
        break;

      case 'awaiting_approval':
        updatedCall = {
          ...originalCall,
          status: 'awaiting_approval',
          confirmationDetails: auxiliaryData as ToolCallConfirmationDetails,
        } as WaitingToolCall;
        break;

      case 'cancelled':
        const reason = auxiliaryData as string;
        const errorResponse = createErrorResponse(
          originalCall.request,
          new Error(reason),
        );

        // 🎯 关键修复：如果是待确认状态下的取消，保留确认详情（如 diff）用于 UI 显示
        if (
          originalCall.status === 'awaiting_approval' &&
          originalCall.confirmationDetails
        ) {
          errorResponse.resultDisplay =
            originalCall.confirmationDetails as any;
        }

        updatedCall = {
          ...originalCall,
          status: 'cancelled',
          response: errorResponse,
          durationMs: originalCall.startTime
            ? Date.now() - originalCall.startTime
            : undefined,
        } as CancelledToolCall;
        break;

      default:
        updatedCall = {
          ...originalCall,
          status: newStatus,
        } as EngineToolCall;
        break;
    }

    // 更新工具调用数组
    this.toolCalls = this.toolCalls.map((call) =>
      call.request.callId === targetCallId ? updatedCall : call,
    );

    // 通知适配器状态变化
    const execContext = context || {
      agentId: 'unknown',
      agentType: 'main' as const,
    };
    this.adapter.onToolStatusChanged(
      targetCallId,
      newStatus,
      updatedCall,
      execContext,
    );

    // 通知工具调用更新
    this.adapter.onToolCallsUpdate([...this.toolCalls], execContext);

    // 检查并通知完成
    this.checkAndNotifyCompletion(execContext);
  }

  /**
   * 检查并通知所有工具完成
   */
  private checkAndNotifyCompletion(context: ToolExecutionContext): void {
    const allCallsAreTerminal = this.toolCalls.every(
      (call) =>
        call.status === 'success' ||
        call.status === 'error' ||
        call.status === 'cancelled',
    );

    if (this.toolCalls.length > 0 && allCallsAreTerminal) {
      const completedCalls = [...this.toolCalls] as CompletedEngineToolCall[];

      // 通知等待的 Promise resolvers
      const resolversToCall = [...this.completionResolvers];
      this.completionResolvers = [];

      // 记录工具调用日志
      for (const call of completedCalls) {
        logToolCall(this.config, new ToolCallEvent(call));
      }

      // 通知适配器所有工具完成
      this.adapter.onAllToolsComplete(completedCalls, context);

      // 通知所有等待的resolvers
      resolversToCall.forEach((resolve) => {
        resolve(completedCalls);
      });

      // 清空工具调用数组
      this.toolCalls = [];
      this.adapter.onToolCallsUpdate([...this.toolCalls], context);
    }
  }

  /**
   * 调度工具执行 - 核心调度方法
   */
  async executeTools(
    requests: ToolCallRequestInfo[],
    context: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<CompletedEngineToolCall[]> {
    if (this.isRunning()) {
      throw new Error(
        'Cannot schedule new tool calls while other tool calls are actively running (executing or awaiting approval).',
      );
    }

    const toolRegistry = await this.toolRegistry;

    // 创建新的工具调用对象
    const newToolCalls: EngineToolCall[] = requests.map(
      (reqInfo): EngineToolCall => {
        const toolInstance = toolRegistry.getTool(reqInfo.name);
        const agentContext: ToolCallAgentContext = {
          agentId: context.agentId,
          agentType: context.agentType,
          parentAgentId: context.agentType === 'sub' ? 'main-agent' : undefined,
          taskDescription: context.taskDescription,
        };

        if (!toolInstance) {
          const availableTools = toolRegistry.getAllTools().map((t) => t.name).join(', ');
          const errorMessage = `Tool "${reqInfo.name}" not found in registry. Available tools: ${availableTools}`;
          return {
            status: 'error',
            request: reqInfo,
            response: createErrorResponse(
              reqInfo,
              new Error(errorMessage),
            ),
            durationMs: 0,
            agentContext,
          };
        }
        return {
          status: 'validating',
          request: reqInfo,
          tool: toolInstance,
          startTime: Date.now(),
          agentContext,
        };
      },
    );

    this.toolCalls = this.toolCalls.concat(newToolCalls);
    this.adapter.onToolCallsUpdate([...this.toolCalls], context);

    // 🎯 修复竞态条件：先创建 Promise 并添加 resolver，再启动工具验证和执行
    // 这样在验证循环中发生的同步或异步完成也能被正确捕获
    const completionPromise = new Promise<CompletedEngineToolCall[]>((resolve) => {
      this.completionResolvers.push(resolve);
    });

    // 验证和调度每个工具调用
    for (const toolCall of newToolCalls) {
      if (toolCall.status !== 'validating') {
        continue;
      }

      const { request: reqInfo, tool: toolInstance } = toolCall;
      try {
        // 🚨 CRITICAL: Always check for dangerous commands, even in YOLO mode
        // Dangerous commands MUST require confirmation regardless of approval mode
        const confirmationDetails = await toolInstance.shouldConfirmExecute(
          reqInfo.args,
          signal,
        );

        if (signal.aborted) {
          this.setStatusInternal(
            reqInfo.callId,
            'cancelled',
            'User cancelled',
            context,
          );
          continue;
        }

        // Check if this is a dangerous command (has warning field)
        const isDangerousCommand =
          confirmationDetails &&
          (confirmationDetails as any).warning;

        // 🎯 AskUserQuestion: even in YOLO mode we MUST pop the dialog — the
        // whole point of this tool is to ask the user, so bypassing confirmation
        // would make it useless (execute() would see no answers and LLM would
        // get "User declined").
        const isAskUserQuestion =
          confirmationDetails &&
          (confirmationDetails as any).type === 'question';

        // If dangerous command or a user-question tool, always require confirmation (skip YOLO mode)
        // Workflow confirmation is also mandatory — it spins up many sub-agents and burns tokens.
        const isWorkflowConfirm =
          confirmationDetails &&
          (confirmationDetails as any).type === 'workflow';

        if (isDangerousCommand || isAskUserQuestion || isWorkflowConfirm) {
          // 🎯 保存原始onConfirm以避免递归
          const originalOnConfirm = (confirmationDetails as any).onConfirm;

          // 🎯 统一确认流程：包装onConfirm，保存原始函数引用
          const wrappedConfirmationDetails: ToolCallConfirmationDetails = {
            ...confirmationDetails,
            // 🔑 将原始onConfirm保存为私有属性，避免递归
            originalOnConfirm,
            onConfirm: (
              outcome: ToolConfirmationOutcome,
              payload?: ToolConfirmationPayload,
            ) =>
              this.handleConfirmationResponse(
                reqInfo.callId,
                outcome,
                payload,
                signal,
              ),
          } as ToolCallConfirmationDetails & { originalOnConfirm: typeof originalOnConfirm };

          // 🎯 统一设置awaiting_approval状态，通过onToolCallsUpdate通知外界
          // Adapter层会在onToolCallsUpdate中检测到awaiting_approval状态并处理确认逻辑
          this.setStatusInternal(
            reqInfo.callId,
            'awaiting_approval',
            wrappedConfirmationDetails,
            context,
          );
        } else if (this.config.getApprovalMode() === ApprovalMode.YOLO) {
          // YOLO mode: skip confirmation for normal commands
          this.setStatusInternal(reqInfo.callId, 'scheduled', undefined, context);
        } else {
          // Non-YOLO mode: handle normal confirmation logic
          if (!confirmationDetails) {
            this.setStatusInternal(reqInfo.callId, 'scheduled', undefined, context);
          } else {
            // 🎯 保存原始onConfirm以避免递归
            const originalOnConfirm = (confirmationDetails as any).onConfirm;

            // 🎯 统一确认流程：包装onConfirm，保存原始函数引用
            const wrappedConfirmationDetails: ToolCallConfirmationDetails = {
              ...confirmationDetails,
              // 🔑 将原始onConfirm保存为私有属性，避免递归
              originalOnConfirm,
              onConfirm: (
                outcome: ToolConfirmationOutcome,
                payload?: ToolConfirmationPayload,
              ) =>
                this.handleConfirmationResponse(
                  reqInfo.callId,
                  outcome,
                  payload,
                  signal,
                ),
            } as ToolCallConfirmationDetails & { originalOnConfirm: typeof originalOnConfirm };

            // 🎯 统一设置awaiting_approval状态，通过onToolCallsUpdate通知外界
            // Adapter层会在onToolCallsUpdate中检测到awaiting_approval状态并处理确认逻辑
            this.setStatusInternal(
              reqInfo.callId,
              'awaiting_approval',
              wrappedConfirmationDetails,
              context,
            );
          }
        }
      } catch (error) {
        this.setStatusInternal(
          reqInfo.callId,
          'error',
          createErrorResponse(
            reqInfo,
            error instanceof Error ? error : new Error(String(error)),
          ),
          context,
        );
      }
    }

    // 如果没有工具调用，直接返回空数组
    if (newToolCalls.length === 0) {
      // 仍然需要清理 resolver 避免内存泄漏，虽然这里还没 return
      this.completionResolvers = this.completionResolvers.filter(r => r !== (completionPromise as any).resolve);
      return [];
    }

    // 尝试执行已调度的工具
    await this.attemptExecutionOfScheduledCalls(signal, context);

    // 检查并通知完成（处理没有调度工具但有错误工具的情况）
    this.checkAndNotifyCompletion(context);

    // 等待工具完成通知
    return completionPromise;
  }

  /**
   * 🎯 外部确认响应处理接口（供CoreToolScheduler等调用）
   */
  async handleConfirmationResponse(
    callId: string,
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    console.log('[ToolExecutionEngine] handleConfirmationResponse called:', { callId, outcome });

    const toolCall = this.toolCalls.find(
      (c) => c.request.callId === callId && c.status === 'awaiting_approval',
    );

    console.log('[ToolExecutionEngine] Found toolCall:', {
      found: !!toolCall,
      status: toolCall?.status,
      allCallIds: this.toolCalls.map(c => ({ id: c.request.callId, status: c.status }))
    });

    if (!toolCall || toolCall.status !== 'awaiting_approval') return;

    const waitingCall = toolCall as WaitingToolCall;

    // 🎯 调用原始确认逻辑，避免递归
    const confirmationDetails = waitingCall.confirmationDetails as any;
    if (confirmationDetails.originalOnConfirm) {
      // 主Agent：调用保存的原始onConfirm
      await confirmationDetails.originalOnConfirm(outcome, payload);
    } else {
      // SubAgent：调用当前的onConfirm（这是包装后的）
      await waitingCall.confirmationDetails.onConfirm(outcome, payload);
    }

    // 🎯 更新工具调用状态
    this.toolCalls = this.toolCalls.map((call) => {
      if (call.request.callId !== callId) return call;
      return { ...call, outcome };
    });

    // 确定执行上下文
    const execContext: ToolExecutionContext = {
      agentId: 'main',
      agentType: 'main' as const,
    };

    console.log('[ToolExecutionEngine] Processing outcome:', outcome);

    if (outcome === ToolConfirmationOutcome.Cancel || signal?.aborted) {
      console.log('[ToolExecutionEngine] Setting status to cancelled');
      this.setStatusInternal(callId, 'cancelled', 'User cancelled', execContext);
    } else if (outcome === ToolConfirmationOutcome.ProceedAlwaysProject) {
      // 处理"本项目始终允许"选项：启用YOLO模式并保存到项目配置
      this.config.setApprovalModeWithProjectSync(ApprovalMode.YOLO, true);
      this.setStatusInternal(callId, 'scheduled', undefined, execContext);
      await this.attemptExecutionOfScheduledCalls(signal || new AbortController().signal, execContext);
    } else if (outcome === ToolConfirmationOutcome.ModifyWithEditor) {
      if (isModifiableTool(waitingCall.tool)) {
        const modifyContext = waitingCall.tool.getModifyContext(signal || new AbortController().signal);
        const editorType = this.getPreferredEditor();
        if (!editorType) {
          return;
        }

        this.setStatusInternal(
          callId,
          'awaiting_approval',
          {
            ...waitingCall.confirmationDetails,
            isModifying: true,
          } as ToolCallConfirmationDetails,
          execContext,
        );

        const { updatedParams } = await modifyWithEditor<
          typeof waitingCall.request.args
        >(
          waitingCall.request.args,
          modifyContext as ModifyContext<typeof waitingCall.request.args>,
          editorType,
          signal || new AbortController().signal,
        );

        // 更新参数并调度执行
        this.toolCalls = this.toolCalls.map((call) => {
          if (call.request.callId !== callId) return call;
          return {
            ...call,
            request: {
              ...call.request,
              args: updatedParams,
            },
          };
        });

        this.setStatusInternal(callId, 'scheduled', undefined, execContext);
        await this.attemptExecutionOfScheduledCalls(signal || new AbortController().signal, execContext);
      }
    } else {
      // 🎯 如果有 payload 且是可修改工具，说明用户在 UI 中直接修改了内容，需要更新参数
      if (payload && isModifiableTool(waitingCall.tool)) {
        try {
          const modifyContext = waitingCall.tool.getModifyContext(
            signal || new AbortController().signal,
          );
          const originalContent = await modifyContext.getCurrentContent(waitingCall.request.args);
          const updatedParams = modifyContext.createUpdatedParams(
            originalContent,
            (payload as any).newContent,
            waitingCall.request.args,
          ) as Record<string, unknown>;

          this.toolCalls = this.toolCalls.map((call) => {
            if (call.request.callId !== callId) return call;
            return {
              ...call,
              request: {
                ...call.request,
                args: updatedParams,
              },
            };
          });
        } catch (error) {
          console.warn(
            `[ToolExecutionEngine] Failed to apply payload to tool args: ${error}`,
          );
        }
      }

      this.setStatusInternal(callId, 'scheduled', undefined, execContext);
      await this.attemptExecutionOfScheduledCalls(
        signal || new AbortController().signal,
        execContext,
      );
    }
  }

  /**
   * 获取工具调用涉及的文件路径列表
   * 用于文件操作队列的排队决策
   */
  private getToolFilePaths(toolInstance: Tool, args: Record<string, unknown>): string[] {
    try {
      const locations = toolInstance.toolLocations(args);
      return locations
        .filter(loc => loc.path) // 过滤掉无效路径
        .map(loc => loc.path);
    } catch {
      // 如果获取路径失败，返回空数组（不进行队列化）
      return [];
    }
  }

  /**
   * 执行单个工具调用的核心逻辑
   * 从 attemptExecutionOfScheduledCalls 提取出来以支持队列化
   */
  private async executeSingleToolCall(
    toolCall: ScheduledToolCall,
    signal: AbortSignal,
    context: ToolExecutionContext,
  ): Promise<void> {
    const { request: reqInfo, tool: toolInstance } = toolCall;

    try {
      this.setStatusInternal(reqInfo.callId, 'executing', undefined, context);

      // 创建工具执行服务对象
      const services: ToolExecutionServices = {
        getExecutionContext: () => ({
          agentId: context.agentId,
          agentType: context.agentType,
          taskDescription: context.taskDescription,
        }),
        statusUpdateCallback: this.createStatusUpdateCallback(context, reqInfo.callId),

        onPreToolExecution: async (toolCall: {
          callId: string;
          tool: Tool;
          args: Record<string, unknown>;
        }) => {
          await this.adapter.onPreToolExecution(toolCall.callId, toolCall.tool, toolCall.args, context);
        },
      };

      // 🪝 触发 BeforeTool 钩子
      if (this.hookEventHandler) {
        try {
          await this.hookEventHandler.fireBeforeToolEvent(
            reqInfo.name,
            reqInfo.args,
          );
        } catch (hookError) {
          console.warn(
            `[ToolExecutionEngine] BeforeTool hook execution failed: ${hookError}`,
          );
        }
      }

      const toolResult: ToolResult = await toolInstance.execute(
        reqInfo.args,
        signal,
        (output: string) => {
          // 通过适配器更新输出
          this.adapter.onOutputUpdate(reqInfo.callId, output, context);

          // 更新实时输出
          this.toolCalls = this.toolCalls.map((call) => {
            if (call.request.callId === reqInfo.callId) {
              let liveOutput: string | object = output;

              // 🔧 如果是 task 工具且在 SubAgent 环境下，尝试解析结构化数据
              if (call.request.name === 'task') {
                try {
                  // 尝试解析为结构化数据
                  const parsed = JSON.parse(output);
                  liveOutput = parsed;
                } catch {
                  // 解析失败，保持为字符串
                  liveOutput = output;
                }
              }

              return { ...call, liveOutput } as ExecutingToolCall;
            }
            return call;
          });
        },
        services,
      );

      if (signal.aborted) {
        this.setStatusInternal(
          reqInfo.callId,
          'cancelled',
          'User cancelled tool execution.',
        );
        return;
      }

      // 🛡️ 应用MCP响应保护（验证、记录大小、智能截断）
      let guardedLlmContent = toolResult.llmContent || '';
      let guardDetails = '';

      try {
        // 只对Part数组类型的响应进行保护（主要是MCP工具）
        if (Array.isArray(toolResult.llmContent) && toolResult.llmContent.length > 0 &&
            typeof toolResult.llmContent[0] === 'object' && toolResult.llmContent[0] !== null &&
            !Array.isArray(toolResult.llmContent[0]) && typeof toolResult.llmContent[0] !== 'string') {

          // 估计当前上下文使用（保守估计：使用默认50%）
          // TODO: 从client.ts的真实token统计中获取更准确的数据
          const currentContextUsage = 50;

          const guardResult = await this.mcpResponseGuard.guardResponse(
            toolResult.llmContent as Part[],
            this.config,
            reqInfo.name,
            currentContextUsage
          );

          guardedLlmContent = guardResult.parts;

          // 记录保护详情用于日志
          if (guardResult.wasTruncated) {
            guardDetails = `[GUARD] ${guardResult.truncationReason || '无原因'} | 原始: ${(guardResult.originalSize / 1024).toFixed(2)}KB -> ${(guardResult.processedSize / 1024).toFixed(2)}KB`;
            if (guardResult.wasStoredAsFile) {
              guardDetails += ` | 已存储为: ${guardResult.tempFilePath}`;
            }
          } else {
            guardDetails = `[GUARD] 响应安全 | 大小: ${(guardResult.originalSize / 1024).toFixed(2)}KB`;
          }

          console.log(`[ToolExecutionEngine] ${guardDetails}`);
        }
      } catch (guardError) {
        console.warn(`[ToolExecutionEngine] MCP响应保护失败: ${guardError}`);
        // 如果保护失败，继续使用原始响应（不中断工具执行）
        guardedLlmContent = toolResult.llmContent || '';
      }

      // 转换为响应格式
      // 📋 Todo staleness: count non-todo_write tool calls and inject reminder if stale
      if (reqInfo.name !== 'todo_write') {
        todoStore.incrementToolCallsSinceLastUpdate();
        const stalenessReminder = checkTodoStaleness();
        if (stalenessReminder) {
          if (typeof guardedLlmContent === 'string') {
            guardedLlmContent = guardedLlmContent + '\n\n' + stalenessReminder;
          } else if (Array.isArray(guardedLlmContent)) {
            guardedLlmContent = [...guardedLlmContent, stalenessReminder];
          }
        }
      }

      const responseParts = convertToFunctionResponse(
        reqInfo.name,
        reqInfo.callId,
        guardedLlmContent,
      );
      const response: ToolCallResponseInfo = {
        callId: reqInfo.callId,
        responseParts,
        resultDisplay: toolResult.returnDisplay,
        error: undefined,
      };

      this.setStatusInternal(reqInfo.callId, 'success', response, context);

      // 🪝 触发 AfterTool 钩子
      if (this.hookEventHandler) {
        try {
          const toolResponseData: Record<string, unknown> =
            typeof toolResult.llmContent === 'string'
              ? { content: toolResult.llmContent }
              : { content: toolResult.llmContent || {} };

          await this.hookEventHandler.fireAfterToolEvent(
            reqInfo.name,
            reqInfo.args,
            toolResponseData,
          );
        } catch (hookError) {
          console.warn(
            `[ToolExecutionEngine] AfterTool hook execution failed: ${hookError}`,
          );
        }
      }
    } catch (error) {
      const response = createErrorResponse(
        reqInfo,
        error instanceof Error ? error : new Error(String(error)),
      );
      this.setStatusInternal(reqInfo.callId, 'error', response, context);

      // 🪝 触发 AfterTool 钩子（即使出错）
      if (this.hookEventHandler) {
        try {
          await this.hookEventHandler.fireAfterToolEvent(
            reqInfo.name,
            reqInfo.args,
            { error: response.error?.message || 'Unknown error' },
          );
        } catch (hookError) {
          console.warn(
            `[ToolExecutionEngine] AfterTool hook execution failed: ${hookError}`,
          );
        }
      }
    }
  }

  /**
   * 尝试执行已调度的工具调用
   *
   * 📁 文件操作队列机制：
   * 当 AI 同时发起多个对同一文件的编辑调用时，这些调用会通过
   * FileOperationQueue 自动排队，确保顺序执行，避免相互覆盖。
   *
   * 例如：AI 同时调用两个 replace 操作修改 foo.ts 的不同位置
   * - 第一个 replace 读取原始内容，执行替换，写入
   * - 第二个 replace 等待第一个完成后，读取已修改的内容，执行替换，写入
   * - 最终结果：两处修改都生效
   */
  private async attemptExecutionOfScheduledCalls(
    signal: AbortSignal,
    context: ToolExecutionContext,
  ): Promise<void> {
    const callsToExecute = this.toolCalls.filter(
      (call) => call.status === 'scheduled',
    ) as ScheduledToolCall[];

    if (callsToExecute.length === 0) {
      return;
    }

    // 执行预处理钩子
    for (const toolCall of callsToExecute) {
      await this.adapter.onPreToolExecution(
        toolCall.request.callId,
        toolCall.tool,
        toolCall.request.args,
        context,
      );
    }

    // 🔥 关键修复：通过文件操作队列确保同一文件的操作顺序执行
    // 不同文件的操作仍然可以并行执行
    const executionPromises = callsToExecute.map(async (toolCall) => {
      const { tool: toolInstance, request: reqInfo } = toolCall;

      // 获取此工具调用涉及的文件路径
      const filePaths = this.getToolFilePaths(toolInstance, reqInfo.args);

      if (filePaths.length === 0) {
        // 不涉及文件操作，直接执行
        return this.executeSingleToolCall(toolCall, signal, context);
      } else if (filePaths.length === 1) {
        // 涉及单个文件，通过队列执行
        return this.fileOperationQueue.enqueue(filePaths[0], () =>
          this.executeSingleToolCall(toolCall, signal, context)
        );
      } else {
        // 涉及多个文件，通过多文件队列执行
        return this.fileOperationQueue.enqueueMultiple(filePaths, () =>
          this.executeSingleToolCall(toolCall, signal, context)
        );
      }
    });

    // 🔥 关键：等待所有工具执行完成或被中止
    await Promise.all(executionPromises);
  }
}
