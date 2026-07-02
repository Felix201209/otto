/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  otto-server 线协议（FROZEN CONTRACT — Issue #2）
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 这是 server ↔ desktop renderer（以及未来 ↔ TUI 只读）之间的唯一契约源。
 * 形态复用 `packages/vscode-ui-plugin/webview/src/types/index.ts` 的
 * `{ type, payload }` 信封 + MessageContentPart / ToolCall 等渲染类型，
 * 在其上扩展：
 *   - `source: 'feishu' | 'local' | 'tui'`（消息/会话来源标记）
 *   - 会话列表 / 历史拉取 / 流式增量 / 工具调用 / 状态 / 错误
 *   - app → 飞书回推
 *
 * ⚠️ 任何字段改动都是「破契约」：必须同步 desktop renderer 与 server 两端。
 *    渲染类型（MessageContentPart / ToolCall / ToolCallStatus …）是从 webview
 *    平移过来的「孪生定义」，名字与结构刻意保持一致，让 webview 组件零改可用。
 *
 * 实装 agent 对齐点：
 *   - server 端（NaturalScience）：把 core 的 ServerOttoStreamEvent 序列化成
 *     下面的 ServerToClient 帧；HTTP 端实现 sessions/history。
 *   - desktop renderer（Felix）：preload 暴露的 client 收发的就是这些帧；
 *     webview 的 multiSessionMessageService 传输底换成订阅这些帧。
 *   - feishu（NaturalScience + IE）：gateway.onMessage → ingestUserMessage(source:'feishu')；
 *     app 内对 feishu 会话发言 → SendUserMessage(source:'local') → server 回推飞书。
 */

// ============================================================================
// 0. 版本 / 信封
// ============================================================================

/** 协议版本。bump 时 server 与 desktop 必须同步。 */
export const PROTOCOL_VERSION = '1' as const;

/**
 * 消息/会话来源。
 * - 'local'：app（Electron renderer）内用户输入
 * - 'feishu'：飞书网关收到的消息
 * - 'tui'：Ink 终端（P1，目前只读）
 */
export type MessageSource = 'local' | 'feishu' | 'tui';

/**
 * 统一信封。所有 WS 帧都是这个形状（与 webview `{ type, payload }` 对齐）。
 * `T` 是判别字段（type 字符串），`P` 是 payload 形状。
 */
export interface Envelope<T extends string, P> {
  type: T;
  payload: P;
}

// ============================================================================
// 1. 渲染内容类型（从 webview/src/types/index.ts 平移 —— 保持结构一致）
// ============================================================================

/** 富消息内容片段（与 webview MessageContentPart 同构）。 */
export type MessageContentPart =
  | { type: 'text'; value: string }
  | { type: 'file_reference'; value: { fileName: string; filePath: string } }
  | {
      type: 'folder_reference';
      value: { folderName: string; folderPath: string };
    }
  | {
      type: 'image_reference';
      value: {
        id: string;
        fileName: string;
        data: string;
        mimeType: string;
        originalSize: number;
        compressedSize: number;
        width?: number;
        height?: number;
      };
    }
  | {
      type: 'code_reference';
      value: {
        fileName: string;
        filePath: string;
        code: string;
        startLine?: number;
        endLine?: number;
      };
    }
  | {
      type: 'text_file_content';
      value: {
        fileName: string;
        content: string;
        language?: string;
        size: number;
      };
    };

export type MessageContent = MessageContentPart[];

/** 工具调用状态（与 webview ToolCallStatus 同值，保持字符串字面量一致）。 */
export enum ToolCallStatus {
  Scheduled = 'scheduled',
  Validating = 'validating',
  Executing = 'executing',
  WaitingForConfirmation = 'awaiting_approval',
  Success = 'success',
  Error = 'error',
  Canceled = 'cancelled',
  BackgroundRunning = 'background_running',
}

/** 工具执行结果（与 webview ToolExecutionResult 同构）。 */
export interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  executionTime: number;
  toolName: string;
}

/** 工具确认详情（与 webview ToolCallConfirmationDetails 同构，按需精简）。 */
export interface ToolCallConfirmationDetails {
  message?: string;
  requiresConfirmation?: boolean;
  riskLevel?: 'low' | 'medium' | 'high';
  affectedFiles?: string[];
  reversible?: boolean;
  type?: 'edit' | 'exec' | 'mcp' | 'info' | 'delete' | 'question';
  title?: string;
  fileDiff?: string;
  fileName?: string;
  originalContent?: string | null;
  newContent?: string;
  filePath?: string;
  fileContent?: string;
  fileSize?: number;
  reason?: string;
  command?: string;
  rootCommand?: string;
  metadata?: { source?: string };
}

/** 单个工具调用卡（与 webview ToolCall 同构）。 */
export interface ToolCall {
  id: string;
  toolName: string;
  displayName?: string;
  parameters: Record<string, unknown>;
  result?: ToolExecutionResult;
  description?: string;
  status: ToolCallStatus;
  liveOutput?: string;
  progressText?: string;
  confirmationDetails?: ToolCallConfirmationDetails;
  subToolCalls?: ToolCall[];
  renderOutputAsMarkdown?: boolean;
  startTime?: number;
  endTime?: number;
  executionDuration?: number;
}

/** Token 用量（与 webview ChatMessage.tokenUsage 同构子集）。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenLimit?: number;
  model?: string;
}

/**
 * 一条会话消息（server 持久化的会话条目，渲染层直接映射成 ChatMessage）。
 * 与 webview ChatMessage 兼容，但加了 `source` 与 `sessionId` 归属。
 */
export interface OttoMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'notification';
  content: MessageContent;
  timestamp: number;
  /** 来源标记（飞书 / 本地 / TUI）。 */
  source: MessageSource;
  isStreaming?: boolean;
  reasoning?: string;
  isReasoning?: boolean;
  associatedToolCalls?: ToolCall[];
  isProcessingTools?: boolean;
  toolsCompleted?: boolean;
  tokenUsage?: TokenUsage;
  modelName?: string;
}

// ============================================================================
// 2. 会话元数据
// ============================================================================

/** 会话状态。 */
export type SessionStatus = 'idle' | 'thinking' | 'streaming' | 'error';

/**
 * 会话摘要（列表项）。一个会话 = 一个 core Config 实例。
 * 飞书会话以 chatId 映射；本地会话用生成的 id。
 */
export interface SessionSummary {
  sessionId: string;
  /** 会话主来源（飞书会话 / 本地会话）。 */
  source: MessageSource;
  title: string;
  /** 飞书会话携带 chatId，便于回推。 */
  feishuChatId?: string;
  status: SessionStatus;
  model?: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
  messageCount: number;
}

// ============================================================================
// 3. Client → Server 帧（出站，desktop/app 发起）
// ============================================================================

/** 握手：连接建立后客户端首帧，声明协议版本与身份。 */
export type HelloMsg = Envelope<
  'hello',
  { protocolVersion: string; clientKind: 'desktop' | 'tui'; clientId?: string }
>;

/** 拉取会话列表。 */
export type ListSessionsMsg = Envelope<'list_sessions', Record<string, never>>;

/** 拉取某会话历史。 */
export type GetHistoryMsg = Envelope<
  'get_history',
  { sessionId: string; limit?: number; before?: number }
>;

/** 订阅某会话的实时事件（多客户端可订阅同一会话）。 */
export type SubscribeMsg = Envelope<'subscribe', { sessionId: string }>;

/** 取消订阅。 */
export type UnsubscribeMsg = Envelope<'unsubscribe', { sessionId: string }>;

/** 新建会话。 */
export type CreateSessionMsg = Envelope<
  'create_session',
  { title?: string; model?: string }
>;

/**
 * 用户发消息（app→server）。若目标是飞书会话，server 在生成回复后
 * 经 gateway 回推飞书（source 决定回推与否：'local' 在飞书会话里 → 回推）。
 */
export type SendUserMessageMsg = Envelope<
  'send_user_message',
  {
    sessionId: string;
    content: MessageContent;
    source: MessageSource;
    /** 客户端临时 id，用于乐观渲染对账。 */
    clientMessageId?: string;
  }
>;

/** 工具确认应答。 */
export type ToolConfirmationResponseMsg = Envelope<
  'tool_confirmation_response',
  {
    sessionId: string;
    callId: string;
    outcome: 'approved' | 'rejected' | 'always_approve';
    payload?: Record<string, unknown>;
  }
>;

/** 取消当前轮（中止流式 / 工具）。 */
export type CancelMsg = Envelope<'cancel', { sessionId: string }>;

/** 设置当前模型。 */
export type SetModelMsg = Envelope<
  'set_model',
  { sessionId: string; model: string }
>;

/** 拉取可用模型列表（BYO-key 自定义模型）。 */
export type GetModelsMsg = Envelope<'get_models', Record<string, never>>;

/**
 * setup 落盘：写入一个 BYO-key 自定义模型到 `~/.otto-user/custom-models.json`。
 *
 * payload 传 **结构化字段**（与 core `CustomModelConfig` 的子集对齐），**不传**
 * desktop 算出的 id —— id 由 server 用 `generateCustomModelId` 统一生成，避免
 * 「desktop 一套算法 / core 一套算法」双源漂移。displayName 缺省时由 server 兜底
 * （取 modelId）。
 *
 * server 收到后：校验 → 复用 CLI 同格式的原子写盘 → 成功广播最新 `models_list`；
 * 失败广播 `error`（code:'save_failed'）。
 */
export type SaveCustomModelMsg = Envelope<
  'save_custom_model',
  {
    /** 协议类型：'openai' | 'openai-responses' | 'anthropic' | 'gemini'。 */
    provider: string;
    baseUrl: string;
    apiKey: string;
    modelId: string;
    /** 显示名（唯一标识，去重键）。缺省时 server 取 modelId 兜底。 */
    displayName?: string;
    /** 上下文窗口大小（可选）。 */
    maxTokens?: number;
    /** 是否启用（缺省 true）。 */
    enabled?: boolean;
    /** 写入成功后是否把该模型设为当前会话模型（保留给前端，server 仅写盘+广播）。 */
    makeActive?: boolean;
  }
>;

export type ClientToServer =
  | HelloMsg
  | ListSessionsMsg
  | GetHistoryMsg
  | SubscribeMsg
  | UnsubscribeMsg
  | CreateSessionMsg
  | SendUserMessageMsg
  | ToolConfirmationResponseMsg
  | CancelMsg
  | SetModelMsg
  | GetModelsMsg
  | SaveCustomModelMsg;

export type ClientToServerType = ClientToServer['type'];

// ============================================================================
// 4. Server → Client 帧（入站，server 广播）
// ============================================================================

/** 握手确认。 */
export type WelcomeMsg = Envelope<
  'welcome',
  { protocolVersion: string; serverVersion: string; sessionId?: string }
>;

/** 会话列表回包。 */
export type SessionsListMsg = Envelope<
  'sessions_list',
  { sessions: SessionSummary[] }
>;

/** 单会话被创建 / 更新（用于列表实时刷新，含飞书新会话）。 */
export type SessionUpsertMsg = Envelope<
  'session_upsert',
  { session: SessionSummary }
>;

/** 历史回包（恢复 UI）。 */
export type HistoryMsg = Envelope<
  'history',
  { sessionId: string; messages: OttoMessage[] }
>;

/**
 * 一条新消息落库（用户消息 / assistant 起头）。携带 source 让 UI 区分
 * 飞书来的还是本地发的。流式回复先发这条占位（isStreaming=true），
 * 再用 chat_chunk 增量填充。
 */
export type MessageStartMsg = Envelope<
  'message_start',
  { message: OttoMessage }
>;

/** 流式文本增量。 */
export type ChatChunkMsg = Envelope<
  'chat_chunk',
  { sessionId: string; messageId: string; delta: string }
>;

/** 流式 reasoning（思考过程）增量。 */
export type ChatReasoningMsg = Envelope<
  'chat_reasoning',
  { sessionId: string; messageId: string; delta: string }
>;

/** 流式结束，消息定稿。 */
export type ChatCompleteMsg = Envelope<
  'chat_complete',
  {
    sessionId: string;
    messageId: string;
    tokenUsage?: TokenUsage;
    finishReason?: string;
  }
>;

/** 工具调用状态批量更新（新增/状态变更/输出）。 */
export type ToolCallsUpdateMsg = Envelope<
  'tool_calls_update',
  { sessionId: string; messageId?: string; toolCalls: ToolCall[] }
>;

/** 需要用户确认的工具调用。 */
export type ToolConfirmationRequestMsg = Envelope<
  'tool_confirmation_request',
  { sessionId: string; callId: string; toolCall: ToolCall }
>;

/** 会话状态变化（idle/thinking/streaming/error）。 */
export type SessionStatusMsg = Envelope<
  'session_status',
  { sessionId: string; status: SessionStatus }
>;

/** 错误帧。 */
export type ErrorMsg = Envelope<
  'error',
  { sessionId?: string; code: string; message: string }
>;

/** 可用模型列表回包。 */
export type ModelsListMsg = Envelope<
  'models_list',
  { models: ModelInfo[]; current?: string }
>;

/** 模型信息（BYO-key 自定义模型摘要）。 */
export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  enabled?: boolean;
}

/**
 * 飞书回推确认（可观测性）：app→飞书 的回推已发出 / 失败。
 * 双向同步视图（Issue #6）用它显示同步状态指示。
 */
export type FeishuPushResultMsg = Envelope<
  'feishu_push_result',
  {
    sessionId: string;
    feishuChatId: string;
    messageId: string;
    ok: boolean;
    error?: string;
  }
>;

export type ServerToClient =
  | WelcomeMsg
  | SessionsListMsg
  | SessionUpsertMsg
  | HistoryMsg
  | MessageStartMsg
  | ChatChunkMsg
  | ChatReasoningMsg
  | ChatCompleteMsg
  | ToolCallsUpdateMsg
  | ToolConfirmationRequestMsg
  | SessionStatusMsg
  | ErrorMsg
  | ModelsListMsg
  | FeishuPushResultMsg;

export type ServerToClientType = ServerToClient['type'];

// ============================================================================
// 5. HTTP REST 形态（非流式：拉列表/历史/健康）
// ============================================================================

/** 统一 REST 响应信封。 */
export interface ApiResponse<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

/** GET /health */
export interface HealthInfo {
  status: 'ok';
  serverVersion: string;
  protocolVersion: string;
  uptimeMs: number;
  sessionCount: number;
  feishu: { enabled: boolean; connected: boolean };
}

/**
 * REST 路由约定（server.ts 实现）：
 *   GET  /health                      → ApiResponse<HealthInfo>
 *   GET  /sessions                    → ApiResponse<SessionSummary[]>
 *   GET  /sessions/:id/history        → ApiResponse<OttoMessage[]>
 *   POST /sessions                    → ApiResponse<SessionSummary>
 *   GET  /models                      → ApiResponse<ModelInfo[]>
 *   WS   /ws                          → 双向 ClientToServer / ServerToClient
 */
export const HTTP_ROUTES = {
  health: '/health',
  sessions: '/sessions',
  sessionHistory: (id: string) => `/sessions/${id}/history`,
  models: '/models',
  ws: '/ws',
} as const;

// ============================================================================
// 6. 默认连接参数 + 类型守卫
// ============================================================================

/** 默认绑定回环地址；端口可配/可发现。 */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7637; // 'OTTO' on a phone keypad-ish; 可被 env OTTO_SERVER_PORT 覆盖

/** 运行期可发现的连接信息（写盘供 desktop/daemon 读取）。 */
export interface ServerEndpoint {
  host: string;
  port: number;
  protocolVersion: string;
  pid: number;
  startedAt: number;
}

/** 判别 client 帧 type。 */
export function isClientToServer(
  msg: unknown,
): msg is ClientToServer {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as { type?: unknown }).type === 'string' &&
    'payload' in (msg as object)
  );
}

// ── 入站 payload 形状校验（第二道闸，轻量手写，不引 zod）──────────────────
//
// isClientToServer 只保证 {type,payload} 信封；畸形 payload（如 send_user_message
// 的 content 传字符串/null）若直接进 handler，会先 appendMessage 落库广播、
// 再在 previewOf 炸 TypeError，留下脏数据。这里按 type 校验每个 handler
// 依赖的字段，server 在 dispatch 前调用：失败回 bad_payload 帧，零副作用。

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isMessageSourceValue(v: unknown): v is MessageSource {
  return v === 'local' || v === 'feishu' || v === 'tui';
}

/** 校验单个 MessageContentPart 的形状（按判别 type 查各自 value 必备字段）。 */
function isMessageContentPart(p: unknown): p is MessageContentPart {
  if (!isPlainObject(p)) return false;
  const v = p['value'];
  switch (p['type']) {
    case 'text':
      return typeof v === 'string';
    case 'file_reference':
      return (
        isPlainObject(v) &&
        typeof v['fileName'] === 'string' &&
        typeof v['filePath'] === 'string'
      );
    case 'folder_reference':
      return (
        isPlainObject(v) &&
        typeof v['folderName'] === 'string' &&
        typeof v['folderPath'] === 'string'
      );
    case 'image_reference':
      return (
        isPlainObject(v) &&
        typeof v['id'] === 'string' &&
        typeof v['fileName'] === 'string' &&
        typeof v['data'] === 'string' &&
        typeof v['mimeType'] === 'string'
      );
    case 'code_reference':
      return (
        isPlainObject(v) &&
        typeof v['fileName'] === 'string' &&
        typeof v['filePath'] === 'string' &&
        typeof v['code'] === 'string'
      );
    case 'text_file_content':
      return (
        isPlainObject(v) &&
        typeof v['fileName'] === 'string' &&
        typeof v['content'] === 'string'
      );
    default:
      return false;
  }
}

/** 校验 MessageContent：必须是 MessageContentPart 数组（字符串 / null / 对象均拒）。 */
function isMessageContentValue(v: unknown): v is MessageContent {
  return Array.isArray(v) && v.every(isMessageContentPart);
}

/**
 * 按 type 校验 client 帧 payload 形状。
 * 返回 null = 通过；否则返回人类可读的失败原因（server 据此回 bad_payload 帧）。
 * 未知 type 也在此拒绝（dispatch 的穷尽 switch 不再兜运行期垃圾 type）。
 */
export function validateClientPayload(msg: {
  type: string;
  payload: unknown;
}): string | null {
  const p = msg.payload;
  switch (msg.type as ClientToServerType) {
    case 'hello':
    case 'list_sessions':
    case 'get_models':
      return isPlainObject(p) ? null : `${msg.type} payload 必须是对象`;
    case 'get_history': {
      if (!isPlainObject(p)) return 'get_history payload 必须是对象';
      if (!isNonEmptyString(p['sessionId'])) return 'sessionId 必须是非空字符串';
      if (p['limit'] !== undefined && typeof p['limit'] !== 'number')
        return 'limit 必须是数字';
      if (p['before'] !== undefined && typeof p['before'] !== 'number')
        return 'before 必须是数字';
      return null;
    }
    case 'subscribe':
    case 'unsubscribe':
    case 'cancel': {
      if (!isPlainObject(p)) return `${msg.type} payload 必须是对象`;
      return isNonEmptyString(p['sessionId'])
        ? null
        : 'sessionId 必须是非空字符串';
    }
    case 'create_session': {
      if (!isPlainObject(p)) return 'create_session payload 必须是对象';
      if (p['title'] !== undefined && typeof p['title'] !== 'string')
        return 'title 必须是字符串';
      if (p['model'] !== undefined && typeof p['model'] !== 'string')
        return 'model 必须是字符串';
      return null;
    }
    case 'send_user_message': {
      if (!isPlainObject(p)) return 'send_user_message payload 必须是对象';
      if (!isNonEmptyString(p['sessionId'])) return 'sessionId 必须是非空字符串';
      if (!isMessageContentValue(p['content']))
        return 'content 必须是 MessageContentPart 数组';
      if (!isMessageSourceValue(p['source']))
        return 'source 必须是 local | feishu | tui';
      if (
        p['clientMessageId'] !== undefined &&
        typeof p['clientMessageId'] !== 'string'
      )
        return 'clientMessageId 必须是字符串';
      return null;
    }
    case 'tool_confirmation_response': {
      if (!isPlainObject(p)) return 'tool_confirmation_response payload 必须是对象';
      if (!isNonEmptyString(p['sessionId'])) return 'sessionId 必须是非空字符串';
      if (!isNonEmptyString(p['callId'])) return 'callId 必须是非空字符串';
      const o = p['outcome'];
      if (o !== 'approved' && o !== 'rejected' && o !== 'always_approve')
        return 'outcome 必须是 approved | rejected | always_approve';
      return null;
    }
    case 'set_model': {
      if (!isPlainObject(p)) return 'set_model payload 必须是对象';
      if (!isNonEmptyString(p['sessionId'])) return 'sessionId 必须是非空字符串';
      if (!isNonEmptyString(p['model'])) return 'model 必须是非空字符串';
      return null;
    }
    case 'save_custom_model': {
      if (!isPlainObject(p)) return 'save_custom_model payload 必须是对象';
      if (!isNonEmptyString(p['provider'])) return 'provider 必须是非空字符串';
      if (typeof p['baseUrl'] !== 'string') return 'baseUrl 必须是字符串';
      if (typeof p['apiKey'] !== 'string') return 'apiKey 必须是字符串';
      if (!isNonEmptyString(p['modelId'])) return 'modelId 必须是非空字符串';
      if (p['displayName'] !== undefined && typeof p['displayName'] !== 'string')
        return 'displayName 必须是字符串';
      if (p['maxTokens'] !== undefined && typeof p['maxTokens'] !== 'number')
        return 'maxTokens 必须是数字';
      if (p['enabled'] !== undefined && typeof p['enabled'] !== 'boolean')
        return 'enabled 必须是布尔';
      if (p['makeActive'] !== undefined && typeof p['makeActive'] !== 'boolean')
        return 'makeActive 必须是布尔';
      return null;
    }
    default:
      return `未知帧类型：${msg.type}`;
  }
}

/** 便捷构造器：保证 type/payload 配对，避免实装手写出错。 */
export function frame<T extends ServerToClient>(msg: T): T {
  return msg;
}
