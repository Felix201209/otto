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
  ApprovalMode,
  Config,
  MESSAGE_ROLES,
  SceneType,
  ToolConfirmationOutcome,
  executeToolCall,
  getModelCapabilities,
  areAllFunctionCallsValid,
  fixAllFunctionCalls,
  appearIncompleteFromStreaming,
  getWorkLogger,
  generateCustomModelId,
  loadBuiltinSkillInstructions,
  MODEL_SERVICE_URL_UNAVAILABLE,
  type ToolCallRequestInfo,
  type ToolRegistry,
  type ToolQuestionConfirmationDetails,
  type LogCategory,
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
  type TokenUsage,
  type AskUserQuestion,
  type ToolConfirmationResponsePayload,
} from './protocol.js';
import {
  shouldRequestConfirmation,
  type RuntimeAuthorizationMode,
} from './authorizationPolicy.js';

const MODEL_CONNECTION_ERROR =
  '当前模型连接失败，已重试但仍无法访问其 API。请在模型菜单切换到其他模型，或在设置中检查 Base URL、API Key 和网络代理。';

/** 把带 cause 的 Node/undici 网络错误链摊平成可匹配文本，但不暴露给最终用户。 */
function runtimeErrorText(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current != null && !seen.has(current) && messages.length < 6) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(`${current.name}: ${current.message}`);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  return messages.join(' | ');
}

/** 只对连接层故障自动换模型；鉴权、配额、参数错误仍交给当前模型如实报错。 */
function isRetryableModelConnectionError(error: unknown): boolean {
  return /(?:fetch failed|network\s*error|socket(?:\s+hang\s+up)?|connection\s+(?:reset|refused|closed)|\bECONN(?:RESET|REFUSED|ABORTED)\b|\bEPIPE\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bUND_ERR_[A-Z_]+\b|\b(?:502|503|504)\b)/i.test(
    runtimeErrorText(error),
  );
}

function userFacingRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('Failed to parse URL from /v1/') ||
    (message.includes('Invalid URL') && message.includes('/v1/'))
  ) {
    return MODEL_SERVICE_URL_UNAVAILABLE;
  }
  if (isRetryableModelConnectionError(error)) return MODEL_CONNECTION_ERROR;
  return message;
}

/** 创建并初始化一个绑定到指定 core Config 的会话运行时。 */
export async function createCoreSessionRuntime(
  store: SessionStore,
  sessionId: string,
  config: Config,
): Promise<CoreSessionRuntime> {
  const runtime = new CoreSessionRuntime(store, sessionId, config, getWorkLogger());
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

/** 把员工本轮输入规整成可落日志的纯文本。 */
function messageContentToText(content: MessageContent): string {
  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.value;
        case 'file_reference':
          return `@${part.value.filePath}`;
        case 'folder_reference':
          return `@${part.value.folderPath}`;
        case 'code_reference':
          return part.value.code;
        case 'text_file_content':
          return `${part.value.fileName}: ${part.value.content}`;
        case 'image_reference':
          return '[图片]';
        default:
          return '';
      }
    })
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 普通会话中的 PPT 意图也要命中内置工作流，不能要求用户先找到专家入口。 */
export function messageNeedsBuiltinPptSkill(text: string): boolean {
  return /(?:\b(?:ppt|pptx)\b|幻灯片|演示文稿|\b(?:pitch|slide)\s+deck\b)/i.test(
    text,
  );
}

const GENERIC_SESSION_TITLES = new Set([
  '新会话',
  '新对话',
  '新会话…',
  '新对话…',
]);

function deriveWorkTitle(
  sessionTitle: string | undefined,
  userInput: string,
): string {
  const firstSentence = userInput.split(/[。！？!?\n]/)[0]?.trim() || '';
  const isFollowUp =
    /^(继续|好的?|可以|确认|开始|按这个来|就这样|下一步)$/i.test(firstSentence);
  if (firstSentence.length >= 4 && !isFollowUp)
    return firstSentence.slice(0, 60);
  const cleanSessionTitle = sessionTitle?.trim();
  if (cleanSessionTitle && !GENERIC_SESSION_TITLES.has(cleanSessionTitle)) {
    return cleanSessionTitle.slice(0, 60);
  }
  return (firstSentence || '本轮工作').slice(0, 60);
}

function inferWorkResultCategory(text: string): LogCategory {
  if (/调研|竞品|搜索|网页|网站|资料/.test(text)) return 'web';
  if (/报告|文档|公文|方案|PPT|幻灯片/.test(text)) return 'document';
  if (/表格|Excel|数据清洗|透视/.test(text)) return 'spreadsheet';
  if (/代码|开发|修复|测试|重构|接口/.test(text)) return 'code';
  if (/会议|日程|日历/.test(text)) return 'calendar';
  if (/邮件/.test(text)) return 'email';
  if (/任务|待办/.test(text)) return 'task';
  return 'other';
}

/** Runtime 只依赖这一条窄接口，单测可验证真实落日志时机且不碰用户目录。 */
export interface WorkResultLogEntry {
  toolName: string;
  action: string;
  category: LogCategory;
  success: boolean;
  details?: string;
  sessionId?: string;
  entryType: 'work_result';
  taskTitle: string;
  userInput: string;
}

export interface WorkResultLogger {
  log(entry: WorkResultLogEntry): Promise<void>;
}

/** 从一条流式响应里抽取可流式输出的文本（跳过 thought 片段）。 */
/**
 * 把 core 的流式响应 usageMetadata 转成协议的 TokenUsage（chat_complete 帧用）。
 * 覆盖式取值：流的最后一个带 usageMetadata 的 chunk 即代表本轮全量用量
 * （与 core turn.ts 对同一字段的处理方式一致，不是逐 chunk 累加）。
 */
function toProtocolTokenUsage(
  usage: GenerateContentResponse['usageMetadata'] | undefined,
  modelName: string,
): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    totalTokens: usage.totalTokenCount || 0,
    model: modelName,
  };
}

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

/** 当前轮仍未收口的工具状态；background 已脱离本轮，不阻塞会话。 */
function isToolCallInFlight(status: ToolCallStatus): boolean {
  return (
    status !== ToolCallStatus.Success &&
    status !== ToolCallStatus.Error &&
    status !== ToolCallStatus.Canceled &&
    status !== ToolCallStatus.BackgroundRunning
  );
}

/** 把尚未收口的工具卡转为明确的取消终态，已完成卡保持原样。 */
function cancelToolCall(card: ToolCall): ToolCall {
  if (!isToolCallInFlight(card.status)) return card;
  return {
    ...card,
    status: ToolCallStatus.Canceled,
    result: {
      success: false,
      error: '用户已停止生成',
      executionTime: card.startTime
        ? Math.max(0, Date.now() - card.startTime)
        : 0,
      toolName: card.toolName,
    },
    endTime: Date.now(),
  };
}

/** 一次工具确认应答（answers 等经 payload 回传）。 */
interface ConfirmationResult {
  outcome: 'approved' | 'rejected' | 'always_approve';
  payload?: ToolConfirmationResponsePayload;
}

export class CoreSessionRuntime implements SessionRuntime {
  private toolRegistry?: ToolRegistry;
  private abort?: AbortController;
  private running = false;
  private authorizationMode: RuntimeAuthorizationMode = 'manual';
  /**
   * 挂起中的工具确认：callId → resolver。AskUserQuestion 弹卡后在此登记，
   * server 收到 tool_confirmation_response 调 resolveToolConfirmation 唤醒。
   */
  private pendingConfirmations = new Map<
    string,
    (result: ConfirmationResult) => void
  >();

  constructor(
    private readonly store: SessionStore,
    private readonly sessionId: string,
    private readonly config: Config,
    private readonly workLogger: WorkResultLogger = getWorkLogger(),
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
    // 默认使用 coreConfig 的 YOLO 模式（自动执行），
    // 用户可通过 /confirm 命令切回手动确认模式。
    // this.config.setApprovalMode?.(ApprovalMode.DEFAULT);
    // 同步 MCP 工具（若已配置）。失败仅告警，不阻塞。
    try {
      await this.toolRegistry.discoverMcpTools();
    } catch {
      // MCP 不可用不影响纯对话与内置工具。
    }
  }

  setAuthorizationMode(mode: RuntimeAuthorizationMode): void {
    this.authorizationMode = mode;
    // 保持当前的 approval mode，不覆盖——用户可能已切到手动模式
    // this.config.setApprovalMode?.(ApprovalMode.DEFAULT);
  }

  async setModel(model: string): Promise<void> {
    // 不能只改 Config：OttoChat 会缓存 specifiedModel，真实出网请求仍会走旧模型。
    // 统一走 core 的 switchModel，让 Config、live chat、工具与系统提示词一起切换。
    const result = await this.config
      .getOttoClient()
      .switchModel(model, new AbortController().signal);
    if (!result.success) {
      throw new Error(result.error || `无法切换到模型 ${model}`);
    }
  }

  /**
   * 首 token 前遇到连接故障时，按“不同 API 地址优先”尝试其他已启用自定义模型。
   * API Key 不参与日志或排序；切换成功后同步会话模型，保证 UI 下拉框与真实出网一致。
   */
  private async tryFailoverModel(
    currentModel: string,
    attemptedModels: Set<string>,
  ): Promise<string | null> {
    const currentConfig = this.config.getCustomModelConfig?.(currentModel);
    const candidates = (this.config.getCustomModels?.() ?? [])
      .filter((model) => model.enabled !== false)
      .map((model) => ({ model, id: generateCustomModelId(model) }))
      .filter(({ model, id }) => {
        if (attemptedModels.has(id) || id === currentModel) return false;
        if (!currentConfig) return true;
        return !(
          model.provider === currentConfig.provider &&
          model.baseUrl === currentConfig.baseUrl &&
          model.modelId === currentConfig.modelId
        );
      })
      .sort((a, b) => {
        const aSameEndpoint =
          a.model.baseUrl === currentConfig?.baseUrl ? 1 : 0;
        const bSameEndpoint =
          b.model.baseUrl === currentConfig?.baseUrl ? 1 : 0;
        return aSameEndpoint - bSameEndpoint;
      });

    for (const candidate of candidates) {
      attemptedModels.add(candidate.id);
      try {
        await this.setModel(candidate.id);
        this.store.patchSessionModel(this.sessionId, candidate.id);
        return candidate.id;
      } catch {
        // 单个备用模型无法切换时继续尝试下一个，不让一次坏配置阻断整个兜底链。
      }
    }
    return null;
  }

  /** 供 server.ts 的 GUI 面板 handler 只读查询/即时应用设置（context 分解/mcp/healthyUse 等）。 */
  getConfig(): Config {
    return this.config;
  }

  cancel(): void {
    this.abort?.abort();
  }

  /**
   * 回传一个待确认工具的应答，唤醒 runToolCalls 里挂起的等待。
   * callId 无对应挂起时静默忽略（幂等：迟到 / 重复应答无害）。
   */
  resolveToolConfirmation(
    callId: string,
    outcome: 'approved' | 'rejected' | 'always_approve',
    payload?: ToolConfirmationResponsePayload,
  ): void {
    const done = this.pendingConfirmations.get(callId);
    if (!done) return;
    done({ outcome, payload });
  }

  async dispose(): Promise<void> {
    this.abort?.abort();
    // 释放前唤醒所有挂起的问答等待，避免 await 永久悬挂（视作用户取消）。
    for (const done of this.pendingConfirmations.values()) {
      done({ outcome: 'rejected' });
    }
    this.pendingConfirmations.clear();
    // core Config 目前无显式 close；GC 即可。预留 hook（TODO：若 core 增 dispose 在此调）。
  }

  /**
   * 跑一整轮对话（可能多回合工具往返）。
   * 期间所有流式/工具事件经 store.publish 广播；不写 stdout。
   */
  async run(input: MessageContent, source: MessageSource): Promise<void> {
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

    // 自然语言“做 PPT”与 /ppt、专家卡片走同一内置 Skill。直接更新 system
    // instruction，不把可靠性寄托在模型是否记得调用 use_skill。
    const taskText = messageContentToText(input);
    if (messageNeedsBuiltinPptSkill(taskText)) {
      const currentRules = this.config.getUserRules();
      const marker = '<skill_loaded name="ppt-creator" source="otto-builtin">';
      if (!currentRules.includes(marker)) {
        const skill = loadBuiltinSkillInstructions('ppt-creator')?.trim();
        if (skill) {
          this.config.setUserRules(
            [
              currentRules,
              '## Otto 内置强制 Skill：ppt-creator',
              '以下完整 Skill 已由 Otto 在系统层直接加载。不要再次调用 use_skill，也不得跳过、缩写或改用快速模板；必须按其工作流执行。',
              marker,
              skill,
              '</skill_loaded>',
            ].filter(Boolean).join('\n\n'),
          );
          try {
            await this.config.getOttoClient().updateSystemPromptWithMcpPrompts();
          } catch {
            // 动态刷新失败不让本轮对话直接报错；专家 profile 路径仍在初始化时注入。
          }
        }
      }
    }

    const chat = await this.config.getOttoClient().getChat();
    let modelName = this.config.getModel();
    let caps = getModelCapabilities(modelName);
    const attemptedModels = new Set<string>([modelName]);

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
    // cancel() 必须立即让 UI 收口，不能等一个忽略 AbortSignal 的工具自行返回。
    // 后续循环仍会检查 signal；此闸门保证 chat_complete(cancelled) 只发布一次。
    let cancellationPublished = false;
    const publishCancellation = (): void => {
      if (cancellationPublished) return;
      cancellationPublished = true;
      this.onCancelled(assistantId, assistantText);
    };
    const onAbort = (): void => publishCancellation();
    signal.addEventListener('abort', onAbort, { once: true });

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
          publishCancellation();
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
        let lastUsage: GenerateContentResponse['usageMetadata'] | undefined;

        let receivedMeaningfulOutput = false;
        while (true) {
          try {
            const responseStream = await chat.sendMessageStream(
              {
                message: currentMessages[0]?.parts ?? [],
                config: {
                  abortSignal: signal,
                  tools: [
                    {
                      functionDeclarations:
                        toolRegistry.getFunctionDeclarations(),
                    },
                  ],
                },
              },
              promptId,
              SceneType.CHAT_CONVERSATION,
            );

            this.store.setStatus(this.sessionId, 'streaming');
            for await (const resp of responseStream) {
              if (signal.aborted) break;
              if (resp.candidates?.[0]?.finishReason) {
                lastFinishReason = resp.candidates[0].finishReason;
              }
              if (resp.usageMetadata) {
                lastUsage = resp.usageMetadata;
              }
              const delta = extractStreamText(resp);
              if (delta) {
                receivedMeaningfulOutput = true;
                if (assistantId === null) {
                  assistantId = startAssistant();
                }
                assistantText += delta;
                // 每个 delta 都同步把累积文本落进 store：客户端切走（退订）再切回时
                // get_history 才能拿到已生成的部分，而不是空占位（否则切走期间的
                // delta 全部丢失、回复缺头）。不改 isStreaming——收口仍由 patch 定稿。
                // 持久层对高频 patch 已做去抖合并写盘（WRITE_DEBOUNCE_MS），不会写爆；
                // patchMessage 不广播，不会产生重复帧。
                this.store.patchMessage(this.sessionId, assistantId, {
                  content: [{ type: 'text', value: assistantText }],
                });
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
                receivedMeaningfulOutput = true;
                functionCalls.push(...resp.functionCalls);
              }
            }
            break;
          } catch (error) {
            if (
              signal.aborted ||
              receivedMeaningfulOutput ||
              !isRetryableModelConnectionError(error)
            ) {
              throw error;
            }
            const fallbackModel = await this.tryFailoverModel(
              modelName,
              attemptedModels,
            );
            if (!fallbackModel) throw error;
            modelName = fallbackModel;
            caps = getModelCapabilities(modelName);
            if (assistantId !== null) {
              this.store.patchMessage(this.sessionId, assistantId, {
                modelName,
              });
            }
            this.store.setStatus(this.sessionId, 'thinking');
          }
        }

        if (signal.aborted) {
          publishCancellation();
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
              tokenUsage: toProtocolTokenUsage(lastUsage, modelName),
              // 带定稿全文：切走期间丢过 chunk 的客户端据此对账自愈（补缺头）。
              text: assistantText,
            },
          });
          await this.recordWorkResult(input, assistantText);

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
            payload: {
              sessionId: this.sessionId,
              messageId: assistantId,
              tokenUsage: toProtocolTokenUsage(lastUsage, modelName),
              // 同收口处：带定稿全文供客户端对账自愈。
              text: assistantText,
            },
          });
        }

        // 小模型格式容错（移植自 nonInteractiveCli）。
        let processed = functionCalls;
        if (caps.needsFormatTolerance) {
          const incomplete =
            caps.proneToIncompleteStream &&
            appearIncompleteFromStreaming(functionCalls, modelName);
          if (
            !areAllFunctionCallsValid(functionCalls, modelName) ||
            incomplete
          ) {
            processed = fixAllFunctionCalls(functionCalls, modelName);
          }
        }

        const toolMessageId = assistantId ?? startAssistant();
        assistantId = toolMessageId;
        const toolResponseParts = await this.runToolCalls(
          processed,
          promptId,
          toolRegistry,
          caps.maxConcurrentTools,
          signal,
          toolMessageId,
          source,
        );

        if (signal.aborted) {
          publishCancellation();
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
        publishCancellation();
      } else {
        const message = userFacingRuntimeError(e);
        if (assistantId !== null) {
          const finalText = assistantText.trim() ? assistantText : message;
          this.store.patchMessage(this.sessionId, assistantId, {
            content: [{ type: 'text', value: finalText }],
            isStreaming: false,
            isProcessingTools: false,
            toolsCompleted: true,
          });
          this.store.publish(this.sessionId, {
            type: 'chat_complete',
            payload: {
              sessionId: this.sessionId,
              messageId: assistantId,
              finishReason: 'error',
              text: finalText,
            },
          });
        }
        this.fail('core_error', message);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
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
    messageId: string,
    source: MessageSource,
  ): Promise<Part[]> {
    const responseParts: Part[] = [];

    // 某些 provider（尤其 Gemini 原生 functionCall）不提供 id。一次绑定后全程复用，
    // 避免建卡与执行各生成一个随机 id，导致 cards.get() 永远取不到同一张卡。
    const callsWithIds = calls.map((fc) => ({
      fc,
      callId: this.callIdOf(fc),
    }));

    // 先把所有工具卡以 Executing 状态广播一遍，让 UI 立即出现工具调用卡。
    const cards = new Map<string, ToolCall>();
    for (const { fc, callId } of callsWithIds) {
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
      this.publishToolCards(cards, messageId);
    }

    // AbortSignal 只保证通知，不保证工具实现会配合退出。先把卡片与持久消息立即收口；
    // 若底层工具稍后才返回，下方 signal 检查仍保持 cancelled，不让迟到结果复活转圈。
    const cancelActiveCards = (): void => {
      let changed = false;
      for (const [callId, card] of cards) {
        const cancelled = cancelToolCall(card);
        if (cancelled !== card) {
          cards.set(callId, cancelled);
          changed = true;
        }
      }
      if (changed) this.publishToolCards(cards, messageId);
    };
    signal.addEventListener('abort', cancelActiveCards, { once: true });
    if (signal.aborted) cancelActiveCards();

    // 分块并发执行（对齐 nonInteractiveCli 的并发上限）。
    const chunks: Array<typeof callsWithIds> = [];
    const limit = Math.max(1, maxConcurrent || 1);
    for (let i = 0; i < callsWithIds.length; i += limit) {
      chunks.push(callsWithIds.slice(i, i + limit));
    }

    try {
      for (const chunk of chunks) {
        if (signal.aborted) break;
        await Promise.all(
          chunk.map(async ({ fc, callId }) => {
            const card = cards.get(callId)!;
            const requestInfo: ToolCallRequestInfo = {
              callId,
              name: (fc.name as string) ?? '',
              args: (fc.args ?? {}) as Record<string, unknown>,
              isClientInitiated: false,
              prompt_id: promptId,
            };

            try {
              // AskUserQuestion 交互闸门：headless 的 executeToolCall 不会弹确认框，
              // 所以在此先弹问答卡、等用户答案写进工具的 pendingAnswers，再落入下面
              // 统一的 executeToolCall —— 它内部 execute() 会读到答案并格式化结果。
              // 用户跳过 / 会话取消时 answers 为空，execute() 自然回落到 "declined"。
              let explicitlyApproved = false;
              if ((fc.name as string) === 'ask_user_question') {
                await this.gateAskUserQuestion(
                  requestInfo,
                  toolRegistry,
                  cards,
                  callId,
                  signal,
                  messageId,
                );
                explicitlyApproved = true;
              } else {
                explicitlyApproved = await this.gateToolConfirmation(
                  requestInfo,
                  toolRegistry,
                  cards,
                  callId,
                  signal,
                  messageId,
                  source,
                );
              }

              const toolResponse = await executeToolCall(
                this.config,
                requestInfo,
                toolRegistry,
                signal,
                {
                  explicitlyApproved,
                  onOutput: (output) => {
                    if (signal.aborted) return;
                    const currentCard = cards.get(callId);
                    if (!currentCard) return;
                    cards.set(callId, { ...currentCard, liveOutput: output });
                    this.publishToolCards(cards, messageId);
                  },
                },
              );

              if (signal.aborted) {
                cards.set(callId, cancelToolCall(cards.get(callId) ?? card));
                return;
              }

              const display = resultDisplayToString(toolResponse.resultDisplay);
              const currentCard = cards.get(callId) ?? card;
              const execResult: ToolExecutionResult = {
                success: !toolResponse.error,
                data: display || undefined,
                error: toolResponse.error
                  ? toolResponse.error.message
                  : undefined,
                executionTime: currentCard.startTime
                  ? Date.now() - currentCard.startTime
                  : 0,
                toolName: currentCard.toolName,
              };
              cards.set(callId, {
                ...currentCard,
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
              const currentCard = cards.get(callId) ?? card;
              if (signal.aborted) {
                cards.set(callId, cancelToolCall(currentCard));
                return;
              }
              cards.set(callId, {
                ...currentCard,
                status: ToolCallStatus.Error,
                result: {
                  success: false,
                  error: message,
                  executionTime: currentCard.startTime
                    ? Date.now() - currentCard.startTime
                    : 0,
                  toolName: currentCard.toolName,
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
        // 每块执行完广播一次最新状态，同时写回消息持久态。
        this.publishToolCards(cards, messageId);
      }
    } finally {
      signal.removeEventListener('abort', cancelActiveCards);
      if (signal.aborted) cancelActiveCards();
    }

    return responseParts;
  }

  /** 普通工具确认：手动模式全问；自动模式只问高危/删除。 */
  private async gateToolConfirmation(
    requestInfo: ToolCallRequestInfo,
    toolRegistry: ToolRegistry,
    cards: Map<string, ToolCall>,
    callId: string,
    signal: AbortSignal,
    messageId: string,
    source: MessageSource,
  ): Promise<boolean> {
    const tool = toolRegistry.getTool(requestInfo.name);
    if (!tool) return false;
    const details = await tool.shouldConfirmExecute(requestInfo.args, signal);
    if (!details) return false;

    // 飞书没有桌面确认入口：授权用户从 FeishuAdapter 发起的普通操作直接按
    // ProceedOnce 执行，否则会永远挂在只有 Otto 桌面能看到的确认卡上。
    // ask_user_question 走独立闸门，不会落到这里；客户端 WS 又禁止伪造
    // source=feishu，因此桌面里的本地操作仍保持原确认边界。
    if (source === 'feishu') {
      await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      return true;
    }

    if (!shouldRequestConfirmation(this.authorizationMode, details))
      return false;

    const base = cards.get(callId);
    if (base) {
      const awaiting: ToolCall = {
        ...base,
        status: ToolCallStatus.WaitingForConfirmation,
        confirmationDetails: {
          ...(details as unknown as ToolCall['confirmationDetails']),
          riskLevel: (details as { warning?: string }).warning
            ? 'high'
            : (details as unknown as ToolCall['confirmationDetails'])
                ?.riskLevel,
        },
      };
      cards.set(callId, awaiting);
      this.publishToolCards(cards, messageId);
      this.store.publish(this.sessionId, {
        type: 'tool_confirmation_request',
        payload: { sessionId: this.sessionId, callId, toolCall: awaiting },
      });
    }

    const result = await this.waitForConfirmation(callId, signal);
    if (result.outcome === 'rejected') throw new Error('用户已取消此操作');
    await details.onConfirm(
      result.outcome === 'always_approve'
        ? ToolConfirmationOutcome.ProceedAlways
        : ToolConfirmationOutcome.ProceedOnce,
      result.payload,
    );
    const approved = cards.get(callId);
    if (approved) {
      cards.set(callId, {
        ...approved,
        status: ToolCallStatus.Executing,
        confirmationDetails: undefined,
      });
      this.publishToolCards(cards, messageId);
    }
    return true;
  }

  private publishToolCards(
    cards: Map<string, ToolCall>,
    messageId: string,
  ): void {
    const toolCalls = Array.from(cards.values());
    const isProcessingTools = toolCalls.some((card) =>
      isToolCallInFlight(card.status),
    );
    // 工具卡状态与消息 busy 标记必须同源持久化；否则实时 UI 虽已成功，切换会话后
    // history 会把旧的 isProcessingTools=true 重新灌回，停止键永久复活。
    this.store.patchMessage(this.sessionId, messageId, {
      associatedToolCalls: toolCalls,
      isProcessingTools,
      toolsCompleted: !isProcessingTools,
    });
    this.store.publish(this.sessionId, {
      type: 'tool_calls_update',
      payload: {
        sessionId: this.sessionId,
        messageId,
        toolCalls,
      },
    });
  }

  /**
   * AskUserQuestion 的交互闸门：把工具卡切到「待确认」并附上问题清单广播给客户端，
   * 挂起等待用户作答，收到答案后调工具的 onConfirm 把答案写进其 pendingAnswers。
   * 随后调用方的 executeToolCall → execute() 便能读到答案并格式化 tool_result。
   *
   * 校验失败 / 注册表无此工具 / 详情非 question 时直接返回，放行给 executeToolCall
   * 走它自己的错误路径（不吞异常，行为与其它工具一致）。
   */
  private async gateAskUserQuestion(
    requestInfo: ToolCallRequestInfo,
    toolRegistry: ToolRegistry,
    cards: Map<string, ToolCall>,
    callId: string,
    signal: AbortSignal,
    messageId: string,
  ): Promise<void> {
    const tool = toolRegistry.getTool('ask_user_question');
    if (!tool) return;

    let details: Awaited<ReturnType<typeof tool.shouldConfirmExecute>>;
    try {
      details = await tool.shouldConfirmExecute(requestInfo.args, signal);
    } catch {
      // 侦测阶段异常：交给 executeToolCall 复现并产出规范错误。
      return;
    }
    if (!details || (details as { type?: string }).type !== 'question') return;

    // shouldConfirmExecute 已就地自愈过 args，此处的 questions 是规范化后的清单。
    const args = requestInfo.args as unknown as {
      questions?: AskUserQuestion[];
      metadata?: { source?: string };
    };
    const questions = args.questions ?? [];

    // 工具卡 → 待确认态，挂上问题清单；广播 tool_calls_update + 单独发 confirmation_request。
    const base = cards.get(callId);
    if (base) {
      const awaitingCard: ToolCall = {
        ...base,
        status: ToolCallStatus.WaitingForConfirmation,
        confirmationDetails: {
          type: 'question',
          title: (details as { title?: string }).title ?? '请选择',
          questions,
          metadata: args.metadata,
        },
      };
      cards.set(callId, awaitingCard);
      this.publishToolCards(cards, messageId);
      this.store.publish(this.sessionId, {
        type: 'tool_confirmation_request',
        payload: {
          sessionId: this.sessionId,
          callId,
          toolCall: awaitingCard,
        },
      });
    }

    // 挂起等待用户作答（或会话取消）。
    const result = await this.waitForConfirmation(callId, signal);

    // 把答案交给工具 onConfirm 写进 pendingAnswers；rejected/取消 → Cancel（execute 回落 declined）。
    const outcome =
      result.outcome === 'rejected'
        ? ToolConfirmationOutcome.Cancel
        : ToolConfirmationOutcome.ProceedOnce;
    await (details as ToolQuestionConfirmationDetails).onConfirm(
      outcome,
      result.payload,
    );

    // 卡从「待确认」过渡回「执行中」，清掉问答详情，让 UI 收起选项、显示运行态。
    const answered = cards.get(callId);
    if (answered) {
      cards.set(callId, {
        ...answered,
        status: ToolCallStatus.Executing,
        confirmationDetails: undefined,
      });
      this.publishToolCards(cards, messageId);
    }
  }

  /**
   * 挂起等待某 callId 的确认应答；会话中止（signal.aborted）时按用户拒绝收口，
   * 避免 await 永久悬挂。resolver 登记进 pendingConfirmations，由 server 路由唤醒。
   */
  private waitForConfirmation(
    callId: string,
    signal: AbortSignal,
  ): Promise<ConfirmationResult> {
    return new Promise<ConfirmationResult>((resolve) => {
      let settled = false;
      const finish = (result: ConfirmationResult): void => {
        if (settled) return;
        settled = true;
        this.pendingConfirmations.delete(callId);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = (): void => finish({ outcome: 'rejected' });
      if (signal.aborted) {
        finish({ outcome: 'rejected' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingConfirmations.set(callId, finish);
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
        // 取消可能发生在工具执行阶段；若只清流式标记，持久历史仍会带
        // isProcessingTools=true，客户端重拉历史后又回到卡死的停止态。
        isProcessingTools: false,
        toolsCompleted: true,
      });
      this.store.publish(this.sessionId, {
        type: 'chat_complete',
        payload: {
          sessionId: this.sessionId,
          messageId: assistantId,
          finishReason: 'cancelled',
          // 取消也带已生成部分：客户端缺头时同样能自愈。
          text: assistantText,
        },
      });
    }
    this.store.setStatus(this.sessionId, 'idle');
  }

  /**
   * 记录员工真正关心的一轮最终成果；工具流水仍由 core 记录，两者用途分离。
   * 写盘失败不影响聊天收口，但这里 await，确保 run() 返回时成果已可被桌面日志读取。
   */
  private async recordWorkResult(
    input: MessageContent,
    assistantText: string,
  ): Promise<void> {
    const result = assistantText.trim();
    if (!result) return;
    const userInput = messageContentToText(input);
    const taskTitle = deriveWorkTitle(
      this.store.getSession(this.sessionId)?.title,
      userInput,
    );
    try {
      await this.workLogger.log({
        toolName: 'otto_work_result',
        action: taskTitle,
        category: inferWorkResultCategory(
          `${taskTitle} ${userInput} ${result}`,
        ),
        success: true,
        entryType: 'work_result',
        taskTitle,
        userInput: userInput.slice(0, 2_000),
        details: result.slice(0, 8_000),
        sessionId: this.sessionId,
      });
    } catch {
      // 工作日志不可用不应让已完成的对话变成失败。
    }
  }

  private fail(code: string, message: string): void {
    this.store.publish(this.sessionId, {
      type: 'error',
      payload: { sessionId: this.sessionId, code, message },
    });
    this.store.setStatus(this.sessionId, 'error');
  }
}
