/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CoreSessionRuntime —— 把 otto-core「跑一整轮对话」封进一个 SessionRuntime。
 *
 * 设计参照 `packages/cli/src/nonInteractiveCli.ts` 的 while 循环（headless，无 Ink）：
 *   1. chat.sendMessageStream(...) 拿逐 chunk 流；
 *   2. 文本 chunk → publish('chat_chunk')；functionCalls 累积；
 *   3. 本轮有工具调用 → 用 executeToolCall 一次性执行，把状态/结果 publish
 *      成 'tool_calls_update'，工具响应作为下一轮 user message 回灌；
 *   4. 无工具调用 → 本轮收口，publish('chat_complete')，返回。
 *
 * 与 nonInteractiveCli 的差异：
 *   - 输出不写 stdout，而是序列化成 protocol.ts 的 ServerToClient 帧，经
 *     store.publish 广播给该会话的所有订阅者（多 desktop 客户端各自实时收到）。
 *   - 一个 runtime 绑定一个 core Config（= 一个会话），持久 chat 历史在 core 内部。
 *   - cancel() 触发 AbortController；run() 被中止时收尾发 session_status=idle。
 *
 * 不在本文件做的（留接缝）：
 *   - 工具确认（CoreToolScheduler / handleConfirmationResponse）——当前用
 *     executeToolCall 直接执行（YOLO 风格，对齐 nonInteractive）。带确认的 GUI
 *     调度是后续增强，见 TODO。
 */

import {
  AuthType,
  Config,
  MESSAGE_ROLES,
  SceneType,
  executeToolCall,
  getModelCapabilities,
  areAllFunctionCallsValid,
  fixAllFunctionCalls,
  appearIncompleteFromStreaming,
  type ToolCallRequestInfo,
  type ToolRegistry,
} from 'otto-core';
import type {
  Content,
  FunctionCall,
  GenerateContentResponse,
  FinishReason,
  Part,
} from '@google/genai';

import type { SessionStore, SessionRuntime } from './sessions.js';
import {
  ToolCallStatus,
  type MessageContent,
  type MessageSource,
  type ToolCall,
  type ToolExecutionResult,
} from './protocol.js';

/** 创建并初始化一个绑定到指定 core Config 的会话运行时。 */
export async function createCoreSessionRuntime(
  store: SessionStore,
  sessionId: string,
  config: Config,
): Promise<CoreSessionRuntime> {
  const runtime = new CoreSessionRuntime(store, sessionId, config);
  await runtime.initialize();
  return runtime;
}

/**
 * 把协议的 MessageContent（富片段）构造成 core 的 Part[]（首轮 user message）。
 * 文本类片段（text / 各种引用）合并成一个 text part；image_reference 转成
 * inlineData part —— core 的 customModelAdapter 会据 provider 自动转成 OpenAI
 * image_url / Anthropic image / Responses input_image，无需在此区分 provider。
 * 文本置于图片之前；若既无文本也无图片，回退一个空 text part 避免空 user turn。
 */
function messageContentToParts(content: MessageContent): Part[] {
  const imageParts: Part[] = [];
  const textChunks: string[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        textChunks.push(part.value);
        break;
      case 'file_reference':
        textChunks.push(`@${part.value.filePath}`);
        break;
      case 'folder_reference':
        textChunks.push(`@${part.value.folderPath}`);
        break;
      case 'code_reference':
        textChunks.push(`\n\`\`\`\n${part.value.code}\n\`\`\`\n`);
        break;
      case 'text_file_content':
        textChunks.push(`\n[${part.value.fileName}]\n${part.value.content}\n`);
        break;
      case 'image_reference':
        imageParts.push({
          inlineData: {
            mimeType: part.value.mimeType,
            data: part.value.data,
          },
        });
        break;
      default:
        break;
    }
  }
  const text = textChunks.join('\n').trim();
  const parts: Part[] = [];
  if (text) parts.push({ text });
  parts.push(...imageParts);
  if (parts.length === 0) parts.push({ text: '' });
  return parts;
}

/** 从一条流式响应里抽取可流式输出的文本（跳过 thought 片段）。 */
function extractStreamText(resp: GenerateContentResponse): string | null {
  const candidate = resp.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!parts || parts.length === 0) return null;
  // 与 nonInteractiveCli getResponseText 一致：首片段是 thought 时整体跳过。
  if (parts[0]?.thought) return null;
  const text = parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join('');
  return text.length > 0 ? text : null;
}

/** 把 executeToolCall 的 resultDisplay 规整成字符串（用于 ToolCall.result）。 */
function resultDisplayToString(display: unknown): string {
  if (display == null) return '';
  if (typeof display === 'string') return display;
  try {
    return JSON.stringify(display);
  } catch {
    return String(display);
  }
}

export class CoreSessionRuntime implements SessionRuntime {
  private toolRegistry?: ToolRegistry;
  private abort?: AbortController;
  private running = false;

  constructor(
    private readonly store: SessionStore,
    private readonly sessionId: string,
    private readonly config: Config,
  ) {}

  /**
   * 初始化 core：config.initialize() + refreshAuth（USE_PROXY_AUTH，自定义模型走此鉴权）。
   * MCP 工具发现 best-effort：失败不阻塞会话可用（与 nonInteractiveCli 等价但更宽容）。
   */
  async initialize(): Promise<void> {
    await this.config.initialize();
    // 自定义模型（BYO-key）经 USE_PROXY_AUTH 鉴权，对齐 validateNonInteractiveAuth。
    await this.config.refreshAuth(AuthType.USE_PROXY_AUTH);
    this.toolRegistry = await this.config.getToolRegistry();
    // 同步 MCP 工具（若已配置）。失败仅告警，不阻塞。
    try {
      await this.toolRegistry.discoverMcpTools();
    } catch {
      // MCP 不可用不影响纯对话与内置工具。
    }
  }

  setModel(model: string): void {
    // core 的 setModel 接受 'custom:...' 形态；选中自定义模型即在此切换。
    this.config.setModel(model);
  }

  cancel(): void {
    this.abort?.abort();
  }

  async dispose(): Promise<void> {
    this.abort?.abort();
    // core Config 目前无显式 close；GC 即可。预留 hook（TODO：若 core 增 dispose 在此调）。
  }

  /**
   * 跑一整轮对话（可能多回合工具往返）。
   * 期间所有流式/工具事件经 store.publish 广播；不写 stdout。
   */
  async run(input: MessageContent, _source: MessageSource): Promise<void> {
    if (this.running) {
      // 同一会话已有一轮在跑：拒绝并行（保护 core chat 历史一致性）。
      this.store.publish(this.sessionId, {
        type: 'error',
        payload: {
          sessionId: this.sessionId,
          code: 'busy',
          message: '该会话正在生成回复，请稍候或先取消。',
        },
      });
      return;
    }
    void _source; // source 用于飞书回推判定，运行层不需要。

    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const promptId = `${this.sessionId}-${Date.now()}`;

    if (!this.toolRegistry) {
      // initialize 未成功：直接报错收口，避免 NPE。
      this.fail('not_initialized', 'core 运行时未初始化');
      this.running = false;
      return;
    }
    const toolRegistry = this.toolRegistry;

    const chat = await this.config.getOttoClient().getChat();
    const modelName = this.config.getModel();
    const caps = getModelCapabilities(modelName);

    // 首轮 user message：把协议 content 构造成 core Part[]（文本 + 图片 inlineData）。
    let currentMessages: Content[] = [
      {
        role: MESSAGE_ROLES.USER,
        parts: messageContentToParts(input),
      },
    ];

    // 本轮 assistant 消息：先落一条占位（isStreaming），后续 chunk 增量填充。
    let assistantId: string | null = null;
    let assistantText = '';

    const startAssistant = (): string => {
      const msg = this.store.appendMessage(this.sessionId, {
        role: 'assistant',
        content: [{ type: 'text', value: '' }],
        source: 'local',
        isStreaming: true,
        modelName,
      });
      this.store.publish(this.sessionId, {
        type: 'message_start',
        payload: { message: msg },
      });
      return msg.id;
    };

    try {
      this.store.setStatus(this.sessionId, 'thinking');
      let turnCount = 0;
      const maxTurns = this.config.getMaxSessionTurns();

      // 多回合工具往返循环（移植自 nonInteractiveCli）。
      // 每一轮：流式拿文本+functionCalls；有工具则执行并回灌，无工具则收口。
      while (true) {
        turnCount++;
        if (maxTurns > 0 && turnCount > maxTurns) {
          this.fail('max_turns', '已达到本会话最大回合数。');
          break;
        }
        if (signal.aborted) {
          this.onCancelled(assistantId, assistantText);
          break;
        }

        // 本轮一开始就落一条 assistant 占位（isStreaming=true、正文暂空）：让渲染层在
        // 等待 LLM 首个 token 期间就显示"思考中"三点跳动，而不是空白→正文突然蹦出。
        // 多回合工具往返里每轮都补一次（上一轮工具执行后 assistantId 会被重置为 null）。
        if (assistantId === null) {
          assistantId = startAssistant();
        }

        const functionCalls: FunctionCall[] = [];
        let lastFinishReason: FinishReason | undefined;

        const responseStream = await chat.sendMessageStream(
          {
            message: currentMessages[0]?.parts ?? [],
            config: {
              abortSignal: signal,
              tools: [
                { functionDeclarations: toolRegistry.getFunctionDeclarations() },
              ],
            },
          },
          promptId,
          SceneType.CHAT_CONVERSATION,
        );

        // 流式：第一段文本到来时才起占位 assistant 消息，避免空泡。
        this.store.setStatus(this.sessionId, 'streaming');
        for await (const resp of responseStream) {
          if (signal.aborted) break;
          if (resp.candidates?.[0]?.finishReason) {
            lastFinishReason = resp.candidates[0].finishReason;
          }
          const delta = extractStreamText(resp);
          if (delta) {
            if (assistantId === null) {
              assistantId = startAssistant();
            }
            assistantText += delta;
            this.store.publish(this.sessionId, {
              type: 'chat_chunk',
              payload: {
                sessionId: this.sessionId,
                messageId: assistantId,
                delta,
              },
            });
          }
          if (resp.functionCalls) {
            functionCalls.push(...resp.functionCalls);
          }
        }

        if (signal.aborted) {
          this.onCancelled(assistantId, assistantText);
          break;
        }

        // 无工具调用：本轮即终轮，定稿 assistant 消息并收口。
        if (functionCalls.length === 0) {
          if (assistantId === null) {
            // 模型一句话都没出（极少见）：补一条空 assistant 以保 UI 一致。
            assistantId = startAssistant();
          }
          this.store.patchMessage(this.sessionId, assistantId, {
            content: [{ type: 'text', value: assistantText }],
            isStreaming: false,
          });
          this.store.publish(this.sessionId, {
            type: 'chat_complete',
            payload: {
              sessionId: this.sessionId,
              messageId: assistantId,
              finishReason: lastFinishReason
                ? String(lastFinishReason)
                : undefined,
            },
          });
          this.store.setStatus(this.sessionId, 'idle');
          break;
        }

        // 有工具调用：定稿当前 assistant 文本段（若有），再执行工具并回灌。
        if (assistantId !== null) {
          this.store.patchMessage(this.sessionId, assistantId, {
            content: [{ type: 'text', value: assistantText }],
            isStreaming: false,
            isProcessingTools: true,
          });
          this.store.publish(this.sessionId, {
            type: 'chat_complete',
            payload: { sessionId: this.sessionId, messageId: assistantId },
          });
        }

        // 小模型格式容错（移植自 nonInteractiveCli）。
        let processed = functionCalls;
        if (caps.needsFormatTolerance) {
          const incomplete =
            caps.proneToIncompleteStream &&
            appearIncompleteFromStreaming(functionCalls, modelName);
          if (!areAllFunctionCallsValid(functionCalls, modelName) || incomplete) {
            processed = fixAllFunctionCalls(functionCalls, modelName);
          }
        }

        const toolResponseParts = await this.runToolCalls(
          processed,
          promptId,
          toolRegistry,
          caps.maxConcurrentTools,
          signal,
        );

        if (signal.aborted) {
          this.onCancelled(assistantId, assistantText);
          break;
        }

        // 工具响应回灌为下一轮 user message；重置本段 assistant 累积。
        currentMessages = [
          { role: MESSAGE_ROLES.USER, parts: toolResponseParts },
        ];
        assistantId = null;
        assistantText = '';
        this.store.setStatus(this.sessionId, 'thinking');
      }
    } catch (e) {
      if (signal.aborted) {
        this.onCancelled(assistantId, assistantText);
      } else {
        const message = e instanceof Error ? e.message : String(e);
        if (assistantId !== null) {
          this.store.patchMessage(this.sessionId, assistantId, {
            content: [{ type: 'text', value: assistantText }],
            isStreaming: false,
          });
        }
        this.fail('core_error', message);
      }
    } finally {
      this.running = false;
      this.abort = undefined;
    }
  }

  /**
   * 执行一批工具调用（带并发上限），把状态/结果 publish 成 tool_calls_update，
   * 返回工具响应 Part[]（回灌给 core 下一轮）。
   */
  private async runToolCalls(
    calls: FunctionCall[],
    promptId: string,
    toolRegistry: ToolRegistry,
    maxConcurrent: number,
    signal: AbortSignal,
  ): Promise<Part[]> {
    const responseParts: Part[] = [];

    // 先把所有工具卡以 Executing 状态广播一遍，让 UI 立即出现工具调用卡。
    const cards = new Map<string, ToolCall>();
    for (const fc of calls) {
      const callId = this.callIdOf(fc);
      const card: ToolCall = {
        id: callId,
        toolName: (fc.name as string) ?? 'unknown',
        parameters: (fc.args ?? {}) as Record<string, unknown>,
        status: ToolCallStatus.Executing,
        startTime: Date.now(),
      };
      cards.set(callId, card);
    }
    if (cards.size > 0) {
      this.publishToolCards(cards);
    }

    // 分块并发执行（对齐 nonInteractiveCli 的并发上限）。
    const chunks: FunctionCall[][] = [];
    const limit = Math.max(1, maxConcurrent || 1);
    for (let i = 0; i < calls.length; i += limit) {
      chunks.push(calls.slice(i, i + limit));
    }

    for (const chunk of chunks) {
      if (signal.aborted) break;
      await Promise.all(
        chunk.map(async (fc) => {
          const callId = this.callIdOf(fc);
          const card = cards.get(callId)!;
          const requestInfo: ToolCallRequestInfo = {
            callId,
            name: (fc.name as string) ?? '',
            args: (fc.args ?? {}) as Record<string, unknown>,
            isClientInitiated: false,
            prompt_id: promptId,
          };

          try {
            const toolResponse = await executeToolCall(
              this.config,
              requestInfo,
              toolRegistry,
              signal,
            );

            const display = resultDisplayToString(toolResponse.resultDisplay);
            const execResult: ToolExecutionResult = {
              success: !toolResponse.error,
              data: display || undefined,
              error: toolResponse.error
                ? toolResponse.error.message
                : undefined,
              executionTime: card.startTime
                ? Date.now() - card.startTime
                : 0,
              toolName: card.toolName,
            };
            cards.set(callId, {
              ...card,
              status: toolResponse.error
                ? ToolCallStatus.Error
                : ToolCallStatus.Success,
              result: execResult,
              endTime: Date.now(),
            });

            // 工具响应 Part[] 回灌（executeToolCall 已构造 functionResponse）。
            const parts = Array.isArray(toolResponse.responseParts)
              ? toolResponse.responseParts
              : [toolResponse.responseParts];
            for (const p of parts) {
              if (typeof p === 'string') {
                responseParts.push({ text: p });
              } else if (p) {
                responseParts.push(p as Part);
              }
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            cards.set(callId, {
              ...card,
              status: ToolCallStatus.Error,
              result: {
                success: false,
                error: message,
                executionTime: card.startTime
                  ? Date.now() - card.startTime
                  : 0,
                toolName: card.toolName,
              },
              endTime: Date.now(),
            });
            // 把错误作为 functionResponse 回灌，让模型可见并自我纠正。
            responseParts.push({
              functionResponse: {
                id: callId,
                name: (fc.name as string) ?? '',
                response: { error: message },
              },
            });
          }
        }),
      );
      // 每块执行完广播一次最新状态。
      this.publishToolCards(cards);
    }

    return responseParts;
  }

  private publishToolCards(cards: Map<string, ToolCall>): void {
    this.store.publish(this.sessionId, {
      type: 'tool_calls_update',
      payload: {
        sessionId: this.sessionId,
        toolCalls: Array.from(cards.values()),
      },
    });
  }

  private callIdOf(fc: FunctionCall): string {
    return (
      fc.id ??
      `${fc.name}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
    );
  }

  private onCancelled(assistantId: string | null, assistantText: string): void {
    if (assistantId !== null) {
      this.store.patchMessage(this.sessionId, assistantId, {
        content: [{ type: 'text', value: assistantText }],
        isStreaming: false,
      });
      this.store.publish(this.sessionId, {
        type: 'chat_complete',
        payload: {
          sessionId: this.sessionId,
          messageId: assistantId,
          finishReason: 'cancelled',
        },
      });
    }
    this.store.setStatus(this.sessionId, 'idle');
  }

  private fail(code: string, message: string): void {
    this.store.publish(this.sessionId, {
      type: 'error',
      payload: { sessionId: this.sessionId, code, message },
    });
    this.store.setStatus(this.sessionId, 'error');
  }
}
