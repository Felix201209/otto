/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PartListUnion,
  GenerateContentResponse,
  FunctionCall,
  FunctionDeclaration,
  FinishReason,
} from '@google/genai';
import {
  ToolCallConfirmationDetails,
  ToolResult,
  ToolResultDisplay,
} from '../tools/tools.js';
import { getResponseText } from '../utils/generateContentResponseUtilities.js';
import { reportError } from '../utils/errorReporting.js';
import {
  getErrorMessage,
  UnauthorizedError,
  toFriendlyError,
} from '../utils/errors.js';
import { GeminiChat } from './geminiChat.js';
import { SceneType } from './sceneManager.js';
import { validateAndFixFunctionCall } from '../utils/functionCallValidator.js';

// Define a structure for tools passed to the server
export interface ServerTool {
  name: string;
  schema: FunctionDeclaration;
  // The execute method signature might differ slightly or be wrapped
  execute(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  shouldConfirmExecute(
    params: Record<string, unknown>,
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false>;
}

export enum GeminiEventType {
  Content = 'content',
  ToolCallRequest = 'tool_call_request',
  ToolCallResponse = 'tool_call_response',
  ToolCallConfirmation = 'tool_call_confirmation',
  UserCancelled = 'user_cancelled',
  Error = 'error',
  ChatCompressed = 'chat_compressed',
  Thought = 'thought',
  Reasoning = 'reasoning',
  MaxSessionTurns = 'max_session_turns',
  Finished = 'finished',
  LoopDetected = 'loop_detected',
  TokenUsage = 'token_usage',
}

export interface StructuredError {
  message: string;
  status?: number;
}

export interface GeminiErrorEventValue {
  error: StructuredError;
}

export interface ToolCallRequestInfo {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  isClientInitiated: boolean;
  prompt_id: string;
  // 🎯 新增字段：标记这是runtime confirmation的虚拟工具调用
  isRuntimeConfirmation?: boolean;
}

export interface ToolCallResponseInfo {
  callId: string;
  responseParts: PartListUnion;
  resultDisplay: ToolResultDisplay | undefined;
  error: Error | undefined;
}

export interface ServerToolCallConfirmationDetails {
  request: ToolCallRequestInfo;
  details: ToolCallConfirmationDetails;
}

export type ThoughtSummary = {
  subject: string;
  description: string;
};

export type ReasoningSummary = {
  text: string;
};

export type ServerGeminiContentEvent = {
  type: GeminiEventType.Content;
  value: string;
};

export type ServerGeminiThoughtEvent = {
  type: GeminiEventType.Thought;
  value: ThoughtSummary;
};

export type ServerGeminiReasoningEvent = {
  type: GeminiEventType.Reasoning;
  value: ReasoningSummary;
};

export type ServerGeminiToolCallRequestEvent = {
  type: GeminiEventType.ToolCallRequest;
  value: ToolCallRequestInfo;
};

export type ServerGeminiToolCallResponseEvent = {
  type: GeminiEventType.ToolCallResponse;
  value: ToolCallResponseInfo;
};

export type ServerGeminiToolCallConfirmationEvent = {
  type: GeminiEventType.ToolCallConfirmation;
  value: ServerToolCallConfirmationDetails;
};

export type ServerGeminiUserCancelledEvent = {
  type: GeminiEventType.UserCancelled;
};

export type ServerGeminiErrorEvent = {
  type: GeminiEventType.Error;
  value: GeminiErrorEventValue;
};

export interface ChatCompressionInfo {
  originalTokenCount: number;
  newTokenCount: number;
}

/**
 * 自动压缩事件 payload。
 * - success=true：压缩成功，info 非空，携带 original/new token count
 * - success=true + degraded=true：全量 LLM 压缩失败，但兜底的 MicroCompact 瘦身成功
 *   （通过清除旧工具输出为占位符的方式释放了上下文），clearedCount 说明清了多少条
 * - success=false：压缩完全失败或熔断器跳闸，reason 说明原因
 */
export interface ChatCompressionEventPayload {
  success: boolean;
  info?: ChatCompressionInfo;
  reason?: string;
  /** 降级模式：全量压缩失败，仅依靠 MicroCompact 兜底瘦身 */
  degraded?: boolean;
  /** 降级模式下清除的旧工具结果数量 */
  clearedCount?: number;
}

export interface ModelSwitchResult {
  success: boolean;
  modelName: string;
  compressionInfo?: ChatCompressionInfo;
  compressionSkipReason?: string;
  error?: string;
}

export interface TokenUsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedContentTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  creditsUsage?: number;
  model?: string; // 🎯 新增：记录真实使用的模型名称
}

export type ServerGeminiChatCompressedEvent = {
  type: GeminiEventType.ChatCompressed;
  value: ChatCompressionEventPayload | null;
};

export type ServerGeminiMaxSessionTurnsEvent = {
  type: GeminiEventType.MaxSessionTurns;
};

export type ServerGeminiFinishedEvent = {
  type: GeminiEventType.Finished;
  value: FinishReason;
  errorDetails?: string; // 可选的错误详情，用于提供更具体的错误信息
};

export type ServerGeminiLoopDetectedEvent = {
  type: GeminiEventType.LoopDetected;
  value?: string; // Optional loop type: 'consecutive_identical_tool_calls', 'chanting_identical_sentences', 'llm_detected_loop'
};

export type ServerGeminiTokenUsageEvent = {
  type: GeminiEventType.TokenUsage;
  value: TokenUsageInfo;
};

// The original union type, now composed of the individual types
export type ServerGeminiStreamEvent =
  | ServerGeminiContentEvent
  | ServerGeminiToolCallRequestEvent
  | ServerGeminiToolCallResponseEvent
  | ServerGeminiToolCallConfirmationEvent
  | ServerGeminiUserCancelledEvent
  | ServerGeminiErrorEvent
  | ServerGeminiChatCompressedEvent
  | ServerGeminiThoughtEvent
  | ServerGeminiReasoningEvent
  | ServerGeminiMaxSessionTurnsEvent
  | ServerGeminiFinishedEvent
  | ServerGeminiLoopDetectedEvent
  | ServerGeminiTokenUsageEvent;

// A turn manages the agentic loop turn within the server context.
export class Turn {
  readonly pendingToolCalls: ToolCallRequestInfo[];
  private debugResponses: GenerateContentResponse[];
  private config: any; // Config reference for hook access

  constructor(
    private readonly chat: GeminiChat,
    private readonly prompt_id: string,
    private readonly modelName?: string,
    configParam?: any,
  ) {
    this.pendingToolCalls = [];
    this.debugResponses = [];
    // Get config from parameter or try to extract from chat
    this.config = configParam;
  }

  /**
   * 获取调试响应列表，用于 AfterAgent 钩子
   */
  getDebugResponses(): GenerateContentResponse[] {
    return this.debugResponses;
  }
  // The run method yields simpler events suitable for server logic
  async *run(
    req: PartListUnion,
    signal: AbortSignal,
  ): AsyncGenerator<ServerGeminiStreamEvent> {
    try {
      // 🪝 触发 BeforeModel 钩子
      if (this.config) {
        try {
          const beforeModelResult = await this.config.getHookSystem()
            .getEventHandler()
            .fireBeforeModelEvent({
              model: this.modelName,
              contents: req,
            });

          // 检查是否有修改
          if (beforeModelResult?.finalOutput?.applyLLMRequestModifications) {
            req = beforeModelResult.finalOutput.applyLLMRequestModifications(req);
          }
        } catch (hookError) {
          console.warn(`[Turn] BeforeModel hook execution failed: ${hookError}`);
        }
      }

      // 🪝 触发 BeforeToolSelection 钩子
      if (this.config) {
        try {
          await this.config.getHookSystem()
            .getEventHandler()
            .fireBeforeToolSelectionEvent({
              model: this.modelName,
              contents: req,
            });
        } catch (hookError) {
          console.warn(`[Turn] BeforeToolSelection hook execution failed: ${hookError}`);
        }
      }

      const responseStream = await this.chat.sendMessageStream(
        {
          message: req,
          config: {
            abortSignal: signal,
          },
        },
        this.prompt_id,
        SceneType.CHAT_CONVERSATION,
      );

      for await (const resp of responseStream) {
        if (signal?.aborted) {
          yield { type: GeminiEventType.UserCancelled };
          // Do not add resp to debugResponses if aborted before processing
          return;
        }
        this.debugResponses.push(resp);

        const thoughtPart = resp.candidates?.[0]?.content?.parts?.[0];
        if (thoughtPart?.thought) {
          // Thought always has a bold "subject" part enclosed in double asterisks
          // (e.g., **Subject**). The rest of the string is considered the description.
          const rawText = thoughtPart.text ?? '';
          const subjectStringMatches = rawText.match(/\*\*(.*?)\*\*/s);
          const subject = subjectStringMatches
            ? subjectStringMatches[1].trim()
            : '';
          const description = rawText.replace(/\*\*(.*?)\*\*/s, '').trim();
          const thought: ThoughtSummary = {
            subject,
            description,
          };

          yield {
            type: GeminiEventType.Thought,
            value: thought,
          };
          continue;
        }

        // 🆕 检测 reasoning 字段（模型的思考过程）
        // 格式: {"candidates":[{"content":{"parts":[{"reasoning":"..."}],"role":"model"},"index":0}]}
        if (thoughtPart && 'reasoning' in thoughtPart) {
          const reasoningText = (thoughtPart as any).reasoning || '';
          const reasoning: ReasoningSummary = {
            text: reasoningText,
          };

          yield {
            type: GeminiEventType.Reasoning,
            value: reasoning,
          };
          // reasoning 仅用于 UI 显示，不再走 getResponseText 等正文处理路径。
          // 注意：reasoning 会保留在 history 中，由 GeminiChat.processStreamResponse
          // 收集进 outputContent，再交由 DeepV Server 决定如何转发上游。
          continue;
        }

        const text = getResponseText(resp);
        if (text) {
          yield { type: GeminiEventType.Content, value: text };
        }

        // Handle function calls (requesting tool execution)
        const functionCalls = resp.functionCalls ?? [];
        for (const fnCall of functionCalls) {
          // 🛡️ 防御：跳过明显残缺的 functionCall（无 name 或 name 为空）。
          // 流式合并失败时（OttoServerAdapter.mergeStreamContent 兜底之外
          // 的边缘情况）可能会传到这里。残缺的 fnCall 进入 pendingToolCalls
          // 后会以 "undefined_tool_name" 调度，污染会话历史并导致后续模型
          // 困惑。这里直接丢弃 + 警告。
          const fnName = (fnCall.name || '').toString().trim();
          if (!fnName) {
            console.warn(
              `[Turn] Dropping incomplete functionCall (no name). args=${JSON.stringify(fnCall.args ?? null).substring(0, 200)}`,
            );
            continue;
          }
          // 🛡️ 防御：去重 callId。流式合并失败可能让同一 callId 的 functionCall
          // 在多个 chunk 里被反复 push。pendingToolCalls 重复会导致工具被多次
          // 调度，污染历史。
          const callId = fnCall.id;
          if (
            callId &&
            this.pendingToolCalls.some((tc) => tc.callId === callId)
          ) {
            console.warn(
              `[Turn] Dropping duplicate functionCall with callId=${callId} name=${fnName}`,
            );
            continue;
          }
          const event = this.handlePendingFunctionCall(fnCall);
          if (event) {
            yield event;
          }
        }

        // Check if response was truncated or stopped for various reasons
        const finishReason = resp.candidates?.[0]?.finishReason;

        if (finishReason) {
          // 🔍 STOP-DEBUG: 记录 finishReason 详情


          // 🔍 STOP-DEBUG: dump 原始响应。两种值得排查的场景：
          //   1. finishReason=STOP 且无工具调用 —— 模型是否返回了非标准工具调用？
          //   2. finishReason=FUNCTION_CALL 且无工具调用 —— ⚠ server 端 bug：
          //      Claude 模型返回了 tool_use，但 DeepV proxy 在翻译成 Gemini
          //      schema 时丢失了 functionCall part（candidates[0].content.parts
          //      变成了空数组 []），只剩 finishReason 这个壳。已知发生在
          //      claude-opus-4-7 上。需要后端修复；客户端这里只能尽量观察并报警。
          //
          // 注：FinishReason 这个 enum 来自 @google/genai，里面没有 'FUNCTION_CALL'
          // 字面量（Gemini 原生用 'STOP'/'MAX_TOKENS' 等）。但 DeepV proxy 在
          // 翻译 Claude 响应时会把 stop_reason='tool_use' 映射成 'FUNCTION_CALL'
          // 这个非标值，所以这里要按字符串比较，不能依赖 enum 类型。
          const isEmptyFunctionCallChunk =
            (finishReason as unknown as string) === 'FUNCTION_CALL' &&
            (resp.functionCalls ?? []).length === 0;
          if (
            (finishReason === 'STOP' && (resp.functionCalls ?? []).length === 0) ||
            isEmptyFunctionCallChunk
          ) {
            try {
              const candidate = resp.candidates?.[0];
              const parts = candidate?.content?.parts ?? [];
              const partsSummary = parts.map((p: any, i: number) => {
                const keys = Object.keys(p);
                let desc = `part[${i}] keys=[${keys.join(',')}]`;
                if (p.text) desc += ` text=${JSON.stringify(p.text.substring(0, 200))}${p.text.length > 200 ? '...(truncated)' : ''}`;
                if (p.functionCall) desc += ` functionCall=${JSON.stringify(p.functionCall)}`;
                if (p.functionResponse) desc += ` functionResponse=present`;
                if (p.thought) desc += ` thought=true`;
                if ('reasoning' in p) desc += ` reasoning=present`;
                return desc;
              });

              if (isEmptyFunctionCallChunk) {
                // ❌ 这是确凿的 server 端 bug：finishReason 表明模型决定调用工具了
                // （而且消耗了 candidatesToken），但 parts 数组是空的，工具调用
                // payload 没被翻译/序列化出来。
                //
                // 已知触发场景：claude-opus-4-7 走 DeepV proxy 时，Claude 原生
                // tool_use block 应被翻译成 Gemini functionCall part，但 proxy
                // 在 SSE 最后一个 chunk 里漏写了这个 part，只保留了 finishReason。
                //
                // 客户端无法兜底——调用名/参数全都丢了，根本不知道模型想调什么。
                // 只在日志里大声报警，留给后端排查。用户层面表现：模型说一句话就停。
                console.error(
                  `[Turn] ❌ SERVER BUG — empty FUNCTION_CALL chunk detected.\n` +
                  `  Symptom: finishReason="FUNCTION_CALL" but candidates[0].content.parts=[].\n` +
                  `  Meaning: the proxy server told the client the model wanted to call a tool,\n` +
                  `           but did NOT deliver the tool-call payload (name + args). The model's\n` +
                  `           intended tool call was lost in translation between the upstream model\n` +
                  `           response and the Gemini-shaped SSE stream.\n` +
                  `  Likely cause: Claude tool_use → Gemini functionCall translation drop in the\n` +
                  `                DeepV proxy /v1/chat/stream handler. Especially seen on claude-opus-4-7.\n` +
                  `  Effect: the agent appears to "say one sentence and stop". No recovery is possible\n` +
                  `          client-side — the tool name and arguments are gone. This needs a server fix.\n` +
                  `  Context: model=${this.modelName}, candidatesTokenCount=${resp.usageMetadata?.candidatesTokenCount ?? 'unknown'}, role=${candidate?.content?.role ?? 'unknown'}`,
                );
              }






              // 尝试完整dump（限制大小防止日志爆炸）
              const rawJson = JSON.stringify(resp, null, 2);
              if (rawJson.length <= 5000) {

              } else {

              }
            } catch (dumpError) {

            }
          }

          let errorDetails: string | undefined;

          // For MALFORMED_FUNCTION_CALL, try to extract detailed error information
          if (finishReason === 'MALFORMED_FUNCTION_CALL') {
            // 尝试从多个来源获取函数调用信息
            const functionCalls = resp.functionCalls ?? [];

            // 如果 resp.functionCalls 不可用，尝试从 candidates[0].content.parts 中提取
            if (functionCalls.length === 0) {
              const parts = resp.candidates?.[0]?.content?.parts ?? [];
              for (const part of parts) {
                if (part.functionCall) {
                  functionCalls.push(part.functionCall);
                }
              }
            }

            if (functionCalls.length > 0) {
              const fc = functionCalls[0];
              errorDetails = `Malformed function call detected.\n\nFunction: ${fc.name || 'unknown'}\n\nArguments received:\n${JSON.stringify(fc.args, null, 2)}`;
            } else {
              errorDetails = 'Malformed function call detected, but no function call details available. The model may have generated invalid JSON.';
            }
          }

          // 🪝 触发 AfterModel 钩子
          if (this.config) {
            try {
              await this.config.getHookSystem()
                .getEventHandler()
                .fireAfterModelEvent(
                  { model: this.modelName },
                  resp
                );
            } catch (hookError) {
              console.warn(`[Turn] AfterModel hook execution failed: ${hookError}`);
            }
          }

          yield {
            type: GeminiEventType.Finished,
            value: finishReason as FinishReason,
            errorDetails,
          };
        }

        // Emit token usage info at the end (usually comes with finishReason)
        if (resp.usageMetadata) {
          const tokenUsageInfo: TokenUsageInfo = {
            inputTokens: resp.usageMetadata.promptTokenCount || 0,
            outputTokens: resp.usageMetadata.candidatesTokenCount || 0,
            totalTokens: resp.usageMetadata.totalTokenCount || 0,
            cachedContentTokens: resp.usageMetadata.cachedContentTokenCount,
            cacheCreationInputTokens: (resp.usageMetadata as any).cacheCreationInputTokens,
            cacheReadInputTokens: (resp.usageMetadata as any).cacheReadInputTokens,
            creditsUsage: (resp.usageMetadata as any).creditsUsage,
            model: this.modelName, // 🎯 记录真实使用的模型名称
          };

          yield {
            type: GeminiEventType.TokenUsage,
            value: tokenUsageInfo,
          };
        }
      }
      // 🔍 STOP-DEBUG: Turn.run() 流正常结束，记录汇总信息

    } catch (e) {
      const error = toFriendlyError(e);
      if (error instanceof UnauthorizedError) {

        throw error;
      }
      if (signal.aborted) {

        yield { type: GeminiEventType.UserCancelled };
        // Regular cancellation error, fail gracefully.
        return;
      }

      const contextForReport = [...this.chat.getHistory(/*curated*/ true), req];
      await reportError(
        error,
        'Error communicating with AI model',
        contextForReport,
        'Turn.run-sendMessageStream',
      );
      const status =
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        typeof (error as { status: unknown }).status === 'number'
          ? (error as { status: number }).status
          : undefined;
      const structuredError: StructuredError = {
        message: getErrorMessage(error),
        status,
      };
      yield { type: GeminiEventType.Error, value: { error: structuredError } };
      return;
    }
  }

  private handlePendingFunctionCall(
    fnCall: FunctionCall,
  ): ServerGeminiStreamEvent | null {
    // 对于小模型，尝试修复函数调用格式
    let processedFnCall = fnCall;
    if (this.modelName) {
      const validationResult = validateAndFixFunctionCall(fnCall, this.modelName);
      if (validationResult.fixedCall) {
        processedFnCall = validationResult.fixedCall;
      }
    }

    const callId =
      processedFnCall.id ??
      `${processedFnCall.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const name = processedFnCall.name || 'undefined_tool_name';
    const args = (processedFnCall.args || {}) as Record<string, unknown>;

    const toolCallRequest: ToolCallRequestInfo = {
      callId,
      name,
      args,
      isClientInitiated: false,
      prompt_id: this.prompt_id,
    };

    this.pendingToolCalls.push(toolCallRequest);

    // Yield a request for the tool call, not the pending/confirming status
    return { type: GeminiEventType.ToolCallRequest, value: toolCallRequest };
  }
}
