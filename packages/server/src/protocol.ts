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

import type { ProductWorkspaceSnapshot } from './productWorkspaceStore.js';

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

/**
 * AskUserQuestion 单个选项（与 core `AskUserQuestionOption` 同构）。
 * 渲染层据此画选项按钮；label 也是回传答案时的取值。
 */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
  /** 可选预览内容（markdown），单选时并排展示。 */
  preview?: string;
}

/** AskUserQuestion 单个问题（与 core `AskUserQuestion` 同构）。 */
export interface AskUserQuestion {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
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
  /**
   * AskUserQuestion（type === 'question'）待用户作答的问题清单。
   * 渲染层据此画交互式问答卡，用户提交后经 tool_confirmation_response 回传答案。
   */
  questions?: AskUserQuestion[];
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
  /** 受服务端白名单验证的会话 Agent profile；不携带可注入 prompt。 */
  agentProfileId?: string;
  agentProfileName?: string;
  productEdition?: 'personal' | 'enterprise';
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
  { title?: string; model?: string; agentProfileId?: string; clientRequestId?: string }
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
    /**
     * 会话 busy 时消息的排队策略：
     * - 'merge'：注入到当前轮（安全边界如工具结果返回后合并）
     * - 'next_turn'：等当前轮完成后下一轮处理（默认）
     * - 'new_session'：另开话题，创建新会话路由消息
     */
    queueAction?: 'merge' | 'next_turn' | 'new_session';
  }
>;

/**
 * 工具确认应答携带的用户输入。
 * AskUserQuestion 走 answers/annotations/feedback；可修改工具的内联改写走 newContent。
 */
export interface ToolConfirmationResponsePayload {
  /**
   * AskUserQuestion 答案：answers[问题文本] = 选中选项 label。
   * 多选逗号连接；"Other" 自由文本为原文。
   */
  answers?: Record<string, string>;
  /** 每题可选备注 / 预览内容（回传给模型）。 */
  annotations?: Record<string, { preview?: string; notes?: string }>;
  /** 用户选择"聊聊/跳过"时的自由文本反馈。 */
  feedback?: string;
  /** 可修改工具的内联改写内容。 */
  newContent?: string;
}

/** 工具确认应答。 */
export type ToolConfirmationResponseMsg = Envelope<
  'tool_confirmation_response',
  {
    sessionId: string;
    callId: string;
    outcome: 'approved' | 'rejected' | 'always_approve';
    payload?: ToolConfirmationResponsePayload;
  }
>;

/** 取消当前轮（中止流式 / 工具），可选清除排队消息队列。 */
export type CancelMsg = Envelope<
  'cancel',
  { sessionId: string; clearQueue?: boolean }
>;

/** 设置当前模型。 */
export type SetModelMsg = Envelope<
  'set_model',
  { sessionId: string; model: string }
>;

/** 设置执行授权。session 仅当前会话；all 同步所有会话并作为后续会话默认值。 */
export type SetAuthorizationModeMsg = Envelope<
  'set_authorization_mode',
  { sessionId: string; mode: 'manual' | 'auto'; scope: 'session' | 'all' }
>;

/** 拉取可用模型列表（BYO-key 自定义模型）。 */
export type GetModelsMsg = Envelope<'get_models', Record<string, never>>;

/**
 * 删除会话（不可逆）。server 收到后：从 store 删会话（dispose runtime + 清
 * feishuIndex）→ 广播最新 `sessions_list`（权威快照，客户端据此移除该会话）。
 * 删除当前选中会话时的善后（落到下一个 / 置空）由前端 reducer 处理。
 */
export type DeleteSessionMsg = Envelope<
  'delete_session',
  { sessionId: string }
>;

/**
 * 重命名会话。server 收到后：改 title → 广播最新 `sessions_list`（权威快照）。
 * title 空白 / 超长由 server 做兜底（trim + 截断），非法即回 error(bad_payload)。
 */
export type RenameSessionMsg = Envelope<
  'rename_session',
  { sessionId: string; title: string }
>;

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
/** 删除自定义模型：id 为 models_list 里的 ModelInfo.id（generateCustomModelId 结果）。 */
export type DeleteCustomModelMsg = Envelope<
  'delete_custom_model',
  { id: string }
>;

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
    /**
     * 批量：同一 provider / baseUrl / apiKey 下要一次性加入的多个模型 id。
     * 给出且非空时，忽略单个 modelId/displayName，按此列表批量落盘（共享同一个 key），
     * 每条 displayName 取其 modelId。makeActive 只作用于列表第一个。
     */
    modelIds?: string[];
    /** 上下文窗口大小（可选）。 */
    maxTokens?: number;
    /** 是否启用（缺省 true）。 */
    enabled?: boolean;
    /** 编辑模式：要被原子替换的旧 ModelInfo.id。 */
    replaceId?: string;
    /** 写入成功后是否把该模型设为当前会话模型（保留给前端，server 仅写盘+广播）。 */
    makeActive?: boolean;
  }
>;

/**
 * GetSettingsMsg placeholder doc
 */
export type GetSettingsMsg = Envelope<'get_settings', Record<string, never>>;

export type SearchProvider = 'bing' | 'bocha' | 'gemini' | 'volcengine';

/** 读取联网搜索配置；密钥只返回 hasApiKey，绝不回传原文。 */
export type GetSearchConfigMsg = Envelope<
  'get_search_config',
  Record<string, never>
>;

/** 原子保存搜索 provider / API / 模型与可选密钥。空 apiKey 表示保留旧值。 */
export type SaveSearchConfigMsg = Envelope<
  'save_search_config',
  {
    provider: SearchProvider;
    apiUrl?: string;
    model?: string;
    apiKey?: string;
    clearApiKey?: boolean;
  }
>;

export type SetSettingMsg = Envelope<
  'set_setting',
  {
    key: 'agentStyle' | 'healthyUse' | 'preferredLanguage';
    value: string | boolean;
  }
>;

export type McpListMsg = Envelope<'mcp_list', Record<string, never>>;

export type McpAddMsg = Envelope<
  'mcp_add',
  {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    httpUrl?: string;
    headers?: Record<string, string>;
    timeout?: number;
    trust?: boolean;
    description?: string;
  }
>;

export type McpRemoveMsg = Envelope<'mcp_remove', { name: string }>;

export type GetContextBreakdownMsg = Envelope<
  'get_context_breakdown',
  { sessionId: string }
>;

export type GetStatsMsg = Envelope<'get_stats', Record<string, never>>;

export type RunDoctorMsg = Envelope<'run_doctor', Record<string, never>>;

export type GetTodosMsg = Envelope<'get_todos', Record<string, never>>;

// ── P1：记忆文件 / 技能库 / 工具清单 / 压缩上下文 / 导出会话 ──────────────

/** 拉取层级记忆文件内容（对齐 CLI /memory show：项目 OTTO.md + 全局 ~/.otto/OTTO.md）。 */
export type GetMemoryMsg = Envelope<'get_memory', Record<string, never>>;

/** 追加一条记忆事实（对齐 save_memory 工具 / CLI /memory add），写入项目级 OTTO.md。 */
export type AddMemoryMsg = Envelope<'add_memory', { fact: string }>;

/** 拉取已装技能列表（对齐 CLI /skill list）。 */
export type GetSkillsMsg = Envelope<'get_skills', Record<string, never>>;

/** 拉取当前会话可用工具清单（内置 + MCP，对齐 CLI /tools）。 */
export type GetToolsMsg = Envelope<'get_tools', { sessionId: string }>;

/** 手动压缩某会话的上下文（对齐 CLI /compress）。 */
export type CompressContextMsg = Envelope<
  'compress_context',
  { sessionId: string }
>;

/** 导出某会话为 Markdown 文本（对齐 CLI /export），server 只负责拼文本，落盘由 desktop 侧 dialog 完成。 */
export type ExportConversationMsg = Envelope<
  'export_conversation',
  { sessionId: string }
>;

// ── P2：Workflow 面板 / 扩展列表 / IDE 伴生状态 ───────────────────────────

/** 拉取 workflow 记录（进程级单例 WorkflowRegistry，与会话无关）。 */
export type GetWorkflowsMsg = Envelope<'get_workflows', Record<string, never>>;

/** 拉取已安装扩展列表（对齐 CLI /extensions list）。 */
export type GetExtensionsMsg = Envelope<
  'get_extensions',
  Record<string, never>
>;

// ── P3：斜杠命令（桌面端命令面板 ↔ server 命令执行层）────────────────────

/**
 * 执行一条 server 侧斜杠命令。
 * name 是命令名（不含前导 `/`），args 是命令名之后的整段原始文本
 * （如 `/kb search 报销` → name:'kb', args:'search 报销'），子命令解析在 server 侧。
 */
export type RunSlashCommandMsg = Envelope<
  'run_slash_command',
  { sessionId: string; name: string; args?: string }
>;

/** 拉取 server 侧可执行的斜杠命令清单。 */
export type ListSlashCommandsMsg = Envelope<
  'list_slash_commands',
  Record<string, never>
>;

/** 拉取个人知识库全部条目（对齐 CLI knowledge_base list）。 */
export type GetKnowledgeMsg = Envelope<'get_knowledge', { limit?: number }>;

/** 在个人知识库中检索。 */
export type SearchKnowledgeMsg = Envelope<
  'search_knowledge',
  { query: string; category?: string }
>;

/** 向个人知识库添加一条知识。 */
export type AddKnowledgeMsg = Envelope<
  'add_knowledge',
  { content: string; category?: string; tags?: string[] }
>;

/** 从个人知识库删除一条知识。 */
export type RemoveKnowledgeMsg = Envelope<'remove_knowledge', { id: string }>;
/** 拉取 IDE 伴生（VS Code companion）连接状态（对齐 CLI /ide status）。 */
export type GetIdeStatusMsg = Envelope<'get_ide_status', Record<string, never>>;

// ── v1.7：个人版 / 企业版产品工作区与统一日程 ─────────────────────────────

export type GetProductWorkspaceMsg = Envelope<
  'get_product_workspace',
  Record<string, never>
>;
export type ConfigureEnterpriseMsg = Envelope<
  'configure_enterprise',
  {
    managerName: string;
    companyName: string;
    industry?: string;
    employeeScale?: string;
  }
>;
export type SwitchToPersonalMsg = Envelope<
  'switch_to_personal',
  Record<string, never>
>;
export type JoinEnterpriseMsg = Envelope<
  'join_enterprise',
  { link: string; userId: string; displayName: string }
>;
export type CreateEnterpriseInviteMsg = Envelope<
  'create_enterprise_invite',
  | {
      kind: 'position';
      departmentId: string;
      positionId: string;
      expiresInSeconds?: number;
    }
  | { kind: 'company'; expiresInSeconds?: number }
  | {
      kind: 'company_link';
      direction: 'parent_invites_child' | 'child_requests_parent';
      targetCompanyId?: string;
      expiresInSeconds?: number;
    }
>;
export type AddFriendMsg = Envelope<
  'add_friend',
  { displayName: string; note?: string }
>;
export type AcceptCompanyLinkMsg = Envelope<
  'accept_company_link',
  { link: string }
>;

export interface AutoSkillCandidateInfo {
  id: string;
  name: string;
  description: string;
  detectedPattern: string;
  occurrenceCount: number;
  reason: string;
}
export type GetPendingAutoSkillsMsg = Envelope<
  'get_pending_auto_skills',
  Record<string, never>
>;
export type ScanPendingAutoSkillsMsg = Envelope<
  'scan_pending_auto_skills',
  Record<string, never>
>;
export type ConfirmPendingAutoSkillMsg = Envelope<
  'confirm_pending_auto_skill',
  { candidateId: string }
>;
export type RejectPendingAutoSkillMsg = Envelope<
  'reject_pending_auto_skill',
  { candidateId: string }
>;

export interface ScheduleItemInfo {
  id: string;
  title: string;
  startAt: string;
  endAt?: string;
  notes?: string;
  source: 'user' | 'otto';
  reason?: string;
  createdAt: string;
  updatedAt: string;
}
export type GetSchedulesMsg = Envelope<
  'get_schedules',
  { date?: string; timezone?: string }
>;
export type CreateScheduleMsg = Envelope<
  'create_schedule',
  {
    title: string;
    startAt: string;
    endAt?: string;
    notes?: string;
    reason?: string;
  }
>;
export type UpdateScheduleMsg = Envelope<
  'update_schedule',
  {
    id: string;
    title?: string;
    startAt?: string;
    endAt?: string | null;
    notes?: string | null;
    reason?: string | null;
  }
>;
export type DeleteScheduleMsg = Envelope<'delete_schedule', { id: string }>;

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
  | SetAuthorizationModeMsg
  | GetModelsMsg
  | SaveCustomModelMsg
  | DeleteCustomModelMsg
  | DeleteSessionMsg
  | RenameSessionMsg
  | GetSettingsMsg
  | SetSettingMsg
  | GetSearchConfigMsg
  | SaveSearchConfigMsg
  | McpListMsg
  | McpAddMsg
  | McpRemoveMsg
  | GetContextBreakdownMsg
  | GetStatsMsg
  | RunDoctorMsg
  | GetTodosMsg
  | GetMemoryMsg
  | AddMemoryMsg
  | GetSkillsMsg
  | GetToolsMsg
  | CompressContextMsg
  | ExportConversationMsg
  | GetWorkflowsMsg
  | GetExtensionsMsg
  | GetIdeStatusMsg
  | GetKnowledgeMsg
  | SearchKnowledgeMsg
  | AddKnowledgeMsg
  | RemoveKnowledgeMsg
  | RunSlashCommandMsg
  | ListSlashCommandsMsg
  | GetProductWorkspaceMsg
  | ConfigureEnterpriseMsg
  | SwitchToPersonalMsg
  | JoinEnterpriseMsg
  | CreateEnterpriseInviteMsg
  | AddFriendMsg
  | AcceptCompanyLinkMsg
  | GetPendingAutoSkillsMsg
  | ScanPendingAutoSkillsMsg
  | ConfirmPendingAutoSkillMsg
  | RejectPendingAutoSkillMsg
  | GetSchedulesMsg
  | CreateScheduleMsg
  | UpdateScheduleMsg
  | DeleteScheduleMsg;

export type ClientToServerType = ClientToServer['type'];

/** 会话标题最大长度（server 兜底截断，防超长标题撑爆列表 / 内存）。 */
export const SESSION_TITLE_MAX_LEN = 120;

/** 个人知识库条目（从 core LocalKnowledgeStore 透传）。 */
export interface KnowledgeItem {
  id: string;
  category: string;
  content: string;
  tags: string[];
  createdAt: string;
  /** 自动捕获置信度；手动或旧条目可为空。 */
  confidence?: number;
}

/** 知识库列表 / 检索结果（S→C）。 */
export type KnowledgeDataMsg = Envelope<
  'knowledge_data',
  { entries: KnowledgeItem[]; action: 'list' | 'search'; query?: string }
>;

/** 单条知识添加成功（S→C）。 */
export type KnowledgeAddedMsg = Envelope<
  'knowledge_added',
  { entry: KnowledgeItem }
>;

/** 单条知识删除成功（S→C）。 */
export type KnowledgeRemovedMsg = Envelope<'knowledge_removed', { id: string }>;

/** 知识库自动沉淀活动通知（S→C）。每次自动 capture/merge 后广播。 */
export type KnowledgeActivityMsg = Envelope<
  'knowledge_activity',
  {
    /** 活动类型 */
    action: 'auto_capture' | 'merge';
    /** 来源会话（auto_capture 时有值） */
    sessionId?: string;
    /** 写入条目数 */
    written?: number;
    /** 去重跳过的条目数 */
    skippedDuplicate?: number;
    /** 脱敏后跳过数 */
    skippedSanitized?: number;
    /** 低置信度跳过数 */
    skippedLowConfidence?: number;
    /** 最近条目（最多 5 条，供 UI 展示） */
    recent?: KnowledgeItem[];
    /** 本次真正新增的条目；组织知识库同步必须只消费它，避免重复上传 recent。 */
    captured?: KnowledgeItem[];
  }
>;

/** 知识操作错误（S→C）：统一走 error 帧，code='knowledge_error'。 */

// ── 斜杠命令 ────────────────────────────────────────────

export interface SlashCommandInfo {
  name: string;
  description: string;
  /** 用法提示（含子命令/参数形态），如 'kb add|search|list|remove …'。 */
  usage?: string;
}

/** server 侧可执行命令清单（list_slash_commands 回包）。 */
export type SlashCommandsListMsg = Envelope<
  'slash_commands_list',
  { commands: SlashCommandInfo[] }
>;

/**
 * 一条 server 侧命令的执行结果（S→C）。
 * 注意：命令结果**不落库**——它是即时查询回执，不属于会话内容。
 */
export type SlashCommandResultMsg = Envelope<
  'slash_command_result',
  {
    sessionId: string;
    name: string;
    args: string;
    ok: boolean;
    markdown: string;
  }
>;

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

/**
 * 本端创建的会话已落库（含 clientRequestId 对账）。
 * 携带 create_session 时传入的 clientRequestId，让发起方精确选出自己新建的会话，
 * 避免飞书同步 / 其他窗口创建的 session_upsert 抢焦点。
 */
export type SessionCreatedMsg = Envelope<
  'session_created',
  { session: SessionSummary; clientRequestId: string }
>;

/**
 * 消息已排队通知：会话 busy 时用户消息未立即处理，
 * 而是入队等待。客户端据此显示排队位置。
 */
export type MessageQueuedMsg = Envelope<
  'message_queued',
  {
    sessionId: string;
    queuePosition: number;
    clientMessageId?: string;
  }
>;

/**
 * 排队已清空通知：客户端取消排队（cancel with clearQueue）或
 * 队列被 drain 后发送。
 */
export type QueueDrainedMsg = Envelope<
  'queue_drained',
  { sessionId: string }
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
    /**
     * 定稿纯文本全文（对账自愈）：客户端若中途取消订阅又切回（会话切换），
     * 切走期间的 chat_chunk 已丢失、本地 content 缺头。带上全文让客户端在
     * 收口时直接覆盖 content 补齐，而不是永远缺一截。可选：旧端无此字段时
     * 行为不变（只置 isStreaming=false）。
     */
    text?: string;
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
  /** 接入端点（可选）：UI 据域名识别真实厂商（provider 只是协议名）。 */
  baseUrl?: string;
  /** 上游实际模型 id（非敏感，用于编辑表单预填）。 */
  modelId?: string;
  /** 上下文窗口大小（非敏感，用于编辑表单预填）。 */
  maxTokens?: number;
  enabled?: boolean;
  /** personal=用户 BYOK；enterprise=Otto 托管。旧客户端可忽略。 */
  source?: 'byok' | 'otto';
  /** true 表示企业托管模型，不允许客户端编辑或删除。 */
  managed?: boolean;
  /** 展示倍率；真实账本仍按输入/输出 Credits/MTok 结算。 */
  creditMultiplier?: number;
  inputCreditsPerMTok?: number;
  outputCreditsPerMTok?: number;
  tier?: 'standard' | 'premium';
  pricingStatus?: 'provisional' | 'active';
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

/** 全局偏好设置快照（get_settings 回包 / set_setting 成功后广播）。 */
export interface SettingsSnapshot {
  agentStyle: string;
  healthyUse: boolean;
  preferredLanguage?: string;
}

export type SettingsMsg = Envelope<'settings', SettingsSnapshot>;

export interface SearchConfigSnapshot {
  provider: SearchProvider;
  apiUrl: string;
  model: string;
  hasApiKey: boolean;
}

export type SearchConfigMsg = Envelope<'search_config', SearchConfigSnapshot>;

/** MCP 服务器摘要（配置 + 实时连接状态）。 */
export interface McpServerInfo {
  name: string;
  status: 'connected' | 'connecting' | 'disconnected';
  command?: string;
  url?: string;
  httpUrl?: string;
  description?: string;
}

export type McpServersMsg = Envelope<
  'mcp_servers',
  { servers: McpServerInfo[] }
>;

/** Context 用量分解（对齐 CLI /context 的口径）。 */
export interface ContextBreakdown {
  sessionId: string;
  modelDisplayName: string;
  maxTokens: number;
  systemPromptTokens: number;
  systemToolsTokens: number;
  memoryFilesTokens: number;
  messagesTokens: number;
  totalInputTokens: number;
  freeSpaceTokens: number;
}

export type ContextBreakdownMsg = Envelope<
  'context_breakdown',
  ContextBreakdown
>;

/** 用量统计快照（对齐 CLI /stats，按模型/工具聚合）。 */
export interface StatsSnapshot {
  models: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
  >;
  tools: {
    totalCalls: number;
    totalSuccess: number;
    totalFail: number;
    byName: Record<string, { count: number; success: number; fail: number }>;
  };
  /** 会话管理器概览（可选——session 管理器未初始化时缺省）。 */
  sessions?: {
    total: number;
    active: number;
    idle: number;
    archived: number;
    frozen: number;
  };
}

export type StatsSnapshotMsg = Envelope<'stats_snapshot', StatsSnapshot>;

/** 单项依赖体检结果（对齐 core DoctorCheck）。 */
export interface DoctorCheckInfo {
  name: string;
  category: string;
  present: boolean;
  version?: string;
  installHint?: string;
}

export interface DoctorReportInfo {
  platform: string;
  checks: DoctorCheckInfo[];
  presentCount: number;
  missingCount: number;
  affectedCapabilities: string[];
}

export type DoctorReportMsg = Envelope<'doctor_report', DoctorReportInfo>;

/** 单条 todo（与 core todoStore 的 TodoItem 同构）。 */
export interface TodoItemInfo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

export type TodosListMsg = Envelope<'todos_list', { todos: TodoItemInfo[] }>;

// ── P1：记忆文件 / 技能库 / 工具清单 / 压缩上下文 / 导出会话 回包 ──────────

/** 单个记忆文件（层级：项目 OTTO.md / 全局 ~/.otto/OTTO.md）。 */
export interface MemoryFileInfo {
  /** 'project' | 'global'。 */
  scope: 'project' | 'global';
  /** 文件绝对路径。 */
  path: string;
  /** 文件是否存在（不存在时 content 为空串）。 */
  exists: boolean;
  /** 文件全文内容。 */
  content: string;
}

export type MemorySnapshotMsg = Envelope<
  'memory_snapshot',
  { files: MemoryFileInfo[] }
>;

/** 单个已装技能摘要（对齐 core SkillInfo）。 */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  marketplaceId: string;
  pluginId: string;
  enabled: boolean;
}

export type SkillsListMsg = Envelope<'skills_list', { skills: SkillSummary[] }>;

/** 单个可用工具摘要（内置 + MCP，MCP 工具附 serverName）。 */
export interface ToolSummary {
  name: string;
  displayName: string;
  description: string;
  /** 来自哪个 MCP 服务器（内置工具为 undefined）。 */
  serverName?: string;
}

export type ToolsListMsg = Envelope<
  'tools_list',
  { sessionId: string; tools: ToolSummary[] }
>;

/** 压缩结果：成功携带前后 token 数，失败/无需压缩时 compressed=false。 */
export type CompressResultMsg = Envelope<
  'compress_result',
  {
    sessionId: string;
    compressed: boolean;
    originalTokenCount?: number;
    newTokenCount?: number;
    message: string;
  }
>;

/** 导出内容：拼好的 Markdown 文本 + 建议文件名，落盘交给 desktop 侧。 */
export type ExportResultMsg = Envelope<
  'export_result',
  { sessionId: string; suggestedFileName: string; markdown: string }
>;

// ── P2：Workflow 面板 / 扩展列表 / IDE 伴生状态 回包 ───────────────────────

export type WorkflowStatusValue = 'running' | 'completed' | 'failed';

export interface WorkflowAgentSummary {
  agentId: string;
  label: string;
  status: WorkflowStatusValue;
  startTime: number;
  endTime?: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  toolCallCount: number;
  currentPhase?: 'thinking' | 'executing_tools';
  outcome?: string;
}

export interface WorkflowPhaseSummary {
  index: number;
  name: string;
  description: string;
  agents: WorkflowAgentSummary[];
}

export interface WorkflowSummary {
  id: string;
  slug: string;
  description: string;
  status: WorkflowStatusValue;
  startTime: number;
  endTime?: number;
  totalTokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  phases: WorkflowPhaseSummary[];
  /** 无 phase 信息时的兜底扁平 agent 列表。 */
  agents: WorkflowAgentSummary[];
}

/** workflow 列表：get_workflows 回包，也在 WorkflowRegistry 变化时主动广播（实时进度）。 */
export type WorkflowsListMsg = Envelope<
  'workflows_list',
  { workflows: WorkflowSummary[] }
>;

/** 单个已安装扩展摘要（对齐 CLI /extensions list）。 */
export interface ExtensionSummary {
  name: string;
  version: string;
  /** 扩展所在目录（项目级或全局 ~/.otto-user/extensions）。 */
  path: string;
}

export type ExtensionsListMsg = Envelope<
  'extensions_list',
  { extensions: ExtensionSummary[] }
>;

/** IDE 伴生连接状态（对齐 CLI /ide status）。desktop 独立应用不跑该协议，恒为 not_applicable。 */
export type IdeConnectionStatusValue =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'not_applicable';

export type IdeStatusMsg = Envelope<
  'ide_status',
  { status: IdeConnectionStatusValue; details?: string }
>;

export type ProductWorkspaceMsg = Envelope<
  'product_workspace',
  ProductWorkspaceSnapshot
>;
export type EnterpriseInviteCreatedMsg = Envelope<
  'enterprise_invite_created',
  {
    kind: 'position' | 'company' | 'company_link';
    link: string;
    expiresAt: string;
  }
>;
export type SchedulesListMsg = Envelope<
  'schedules_list',
  { date?: string; timezone?: string; schedules: ScheduleItemInfo[] }
>;

/** 主动服务推送（晨间简报/明早日程提醒/空闲提醒等） */
export type ProactiveAlertMsg = Envelope<
  'proactive_alert',
  {
    ruleId: string;
    ruleName: string;
    message: string;
    priority: 'low' | 'medium' | 'high';
    timestamp: string;
  }
>;
/** 实时模式触发（操作重复达阈值，建议生成Skill） */
/** 习惯分析洞察（HabitAnalyzer定期产出） */
export type HabitInsightMsg = Envelope<
  "habit_insight",
  {
    insights: Array<{
      id: string;
      type: "workflow" | "bottleneck" | "suggestion" | "peak_hour" | "tool_chain" | "summary";
      title: string;
      description: string;
      evidence: string[];
      action?: string;
      priority: number;
      confidence: number;
      timestamp: string;
    }>;
  }
>;

export type RealtimePatternMsg = Envelope<
  "realtime_pattern",
  {
    pattern: string;
    count: number;
    samples: Array<{ action: string; details?: string; time: string }>;
    suggestion: string;
    timestamp: string;
  }
>;

export type PendingAutoSkillsMsg = Envelope<
  'pending_auto_skills',
  {
    candidates: AutoSkillCandidateInfo[];
    lastAction?: {
      kind: 'confirmed' | 'rejected';
      candidateId: string;
      savedPath?: string;
    };
  }
>;
export type ServerToClient =
  | WelcomeMsg
  | SessionsListMsg
  | SessionUpsertMsg
  | SessionCreatedMsg
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
  | FeishuPushResultMsg
  | SettingsMsg
  | SearchConfigMsg
  | McpServersMsg
  | ContextBreakdownMsg
  | StatsSnapshotMsg
  | DoctorReportMsg
  | TodosListMsg
  | MemorySnapshotMsg
  | SkillsListMsg
  | ToolsListMsg
  | CompressResultMsg
  | ExportResultMsg
  | WorkflowsListMsg
  | ExtensionsListMsg
  | IdeStatusMsg
  | KnowledgeDataMsg
  | KnowledgeAddedMsg
  | KnowledgeRemovedMsg
  | KnowledgeActivityMsg
  | SlashCommandsListMsg
  | SlashCommandResultMsg

  | ProductWorkspaceMsg
  | EnterpriseInviteCreatedMsg
  | SchedulesListMsg
  | ProactiveAlertMsg
  | RealtimePatternMsg
  | HabitInsightMsg
  | PendingAutoSkillsMsg
  | MessageQueuedMsg
  | QueueDrainedMsg;


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
  feishu: { enabled: boolean; connected: boolean; status?: FeishuHealthStatus };
}

/**
 * GET /local-agent/ping — 跨域探测响应。
 * 仅返回最小化只读信息，不暴露 session/工具等敏感数据。
 * 企业服务器网页用此接口检测用户机器上是否运行着 otto。
 */
export interface LocalAgentPingResponse {
  status: 'ok';
  serverVersion: string;
  protocolVersion: string;
  instanceId: string;
}

/** 飞书网关健康状况（供桌面端渲染状态徽章）。 */
export interface FeishuHealthStatus {
  running: boolean;
  forwarding?: boolean;
  configured: boolean;
  connected?: boolean;
  reconnecting?: boolean;
  nextRetryAt?: number | null;
  lockHeldByOtherPid?: number | null;
  lastEventAt?: number | null;
  lastConnectedAt?: number | null;
  lastDisconnectAt?: number | null;
  lastDisconnectReason?: string | null;
  reconnectAttempts: number;
}

/**
 * 飞书凭证的对外脱敏视图（GET /feishu/config）。
 * appSecret 永不出现在任何响应里——客户端只需要知道「配没配」。
 */
export interface FeishuConfigPublic {
  /** 凭证文件存在且可解密。 */
  configured: boolean;
  appId?: string;
  domain?: 'feishu' | 'lark';
  botName?: string;
  tenantName?: string;
  /** Bot 拥有者（授权用户）的飞书 open_id。 */
  ownerOpenId?: string;
  /** 额外授权白名单人数（内容不透出，只报数量）。 */
  allowlistCount?: number;
  /** 凭证文件存在但解密/解析失败（需清除后重配）。 */
  corrupted?: boolean;
}

/**
 * 保存飞书凭证请求体（POST /feishu/config）。
 * appSecret 可省略 = 保留盘上已有 secret 只改其他字段（改 App ID 时必须重填）。
 */
export interface FeishuConfigSaveRequest {
  appId: string;
  appSecret?: string;
  domain: 'feishu' | 'lark';
  ownerOpenId?: string;
}

/**
 * REST 路由约定（server.ts 实现）：
 *   GET  /health                      → ApiResponse<HealthInfo>
 *   GET  /sessions                    → ApiResponse<SessionSummary[]>
 *   GET  /sessions/:id/history        → ApiResponse<OttoMessage[]>
 *   POST /sessions                    → ApiResponse<SessionSummary>
 *   GET  /models                      → ApiResponse<ModelInfo[]>
 *   POST /feishu/start                → ApiResponse<FeishuHealthStatus>（运行期启动飞书守护）
 *   POST /feishu/stop                 → ApiResponse<FeishuHealthStatus>（运行期停止，之后不自动重连）
 *   GET  /feishu/config               → ApiResponse<FeishuConfigPublic>（脱敏凭证视图，绝不含 secret）
 *   POST /feishu/config               → ApiResponse<FeishuConfigPublic>（保存凭证并立即尝试启动守护）
 *   DELETE /feishu/config             → ApiResponse<FeishuConfigPublic>（停守护并清除凭证）
 *   WS   /ws                          → 双向 ClientToServer / ServerToClient
 */
export const HTTP_ROUTES = {
  health: '/health',
  localAgentPing: '/local-agent/ping',
  sessions: '/sessions',
  sessionHistory: (id: string) => `/sessions/${id}/history`,
  models: '/models',
  feishuStart: '/feishu/start',
  feishuStop: '/feishu/stop',
  feishuConfig: '/feishu/config',
  ws: '/ws',
} as const;

/**
 * 企业服务器信任域白名单（硬编码，不可远程配置）。
 * 仅允许这些来源的网页通过浏览器跨域探测本地 otto。
 * 探测接口只返回最小化只读信息，不暴露 session/工具操作面。
 */
export const TRUSTED_ORIGINS: ReadonlySet<string> = new Set([
  'https://59.110.154.44:7777',
  // 本地开发
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

/**
 * 浏览器 Private Network Access 预检所需响应头。
 * Chrome 109+ 要求公网→本地网络的请求必须先通过预检。
 * 详见 https://developer.chrome.com/blog/private-network-access-preflight
 */
export const PNA_HEADERS = {
  'access-control-allow-private-network': 'true',
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
export function isClientToServer(msg: unknown): msg is ClientToServer {
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
      if (!isNonEmptyString(p['sessionId']))
        return 'sessionId 必须是非空字符串';
      if (p['limit'] !== undefined && typeof p['limit'] !== 'number')
        return 'limit 必须是数字';
      if (p['before'] !== undefined && typeof p['before'] !== 'number')
        return 'before 必须是数字';
      return null;
    }
    case 'subscribe':
    case 'unsubscribe':
    case 'cancel':
    case 'delete_session': {
      if (!isPlainObject(p)) return `${msg.type} payload 必须是对象`;
      return isNonEmptyString(p['sessionId'])
        ? null
        : 'sessionId 必须是非空字符串';
    }
    case 'rename_session': {
      if (!isPlainObject(p)) return 'rename_session payload 必须是对象';
      if (!isNonEmptyString(p['sessionId']))
        return 'sessionId 必须是非空字符串';
      if (typeof p['title'] !== 'string') return 'title 必须是字符串';
      // trim 后不能为空（纯空白标题无意义，server 也不会兜底成有效名）。
      if (p['title'].trim().length === 0) return 'title 不能为空白';
      return null;
    }
    case 'create_session': {
      if (!isPlainObject(p)) return 'create_session payload 必须是对象';
      if (p['title'] !== undefined && typeof p['title'] !== 'string')
        return 'title 必须是字符串';
      if (p['model'] !== undefined && typeof p['model'] !== 'string')
        return 'model 必须是字符串';
      if (
        p['agentProfileId'] !== undefined &&
        !isNonEmptyString(p['agentProfileId'])
      )
        return 'agentProfileId 必须是非空字符串';
      return null;
    }
    case 'send_user_message': {
      if (!isPlainObject(p)) return 'send_user_message payload 必须是对象';
      if (!isNonEmptyString(p['sessionId']))
        return 'sessionId 必须是非空字符串';
      if (!isMessageContentValue(p['content']))
        return 'content 必须是 MessageContentPart 数组';
      if (!isMessageSourceValue(p['source']))
        return 'source 必须是 local | feishu | tui';
      // 飞书入站消息由 FeishuAdapter 直接注入 SessionRuntime，不经过客户端 WS。
      // 禁止客户端伪造 source=feishu，否则会借飞书免确认策略绕过桌面操作确认。
      if (p['source'] === 'feishu')
        return '客户端不得声明 source=feishu；飞书消息仅由服务端适配器注入';
      if (
        p['clientMessageId'] !== undefined &&
        typeof p['clientMessageId'] !== 'string'
      )
        return 'clientMessageId 必须是字符串';
      return null;
    }
    case 'tool_confirmation_response': {
      if (!isPlainObject(p))
        return 'tool_confirmation_response payload 必须是对象';
      if (!isNonEmptyString(p['sessionId']))
        return 'sessionId 必须是非空字符串';
      if (!isNonEmptyString(p['callId'])) return 'callId 必须是非空字符串';
      const o = p['outcome'];
      if (o !== 'approved' && o !== 'rejected' && o !== 'always_approve')
        return 'outcome 必须是 approved | rejected | always_approve';
      // payload 可选：存在时须为对象；answers（若给）须为对象（键值对答案）。
      const pl = p['payload'];
      if (pl !== undefined) {
        if (!isPlainObject(pl)) return 'payload 必须是对象';
        if (pl['answers'] !== undefined && !isPlainObject(pl['answers']))
          return 'payload.answers 必须是对象';
      }
      return null;
    }
    case 'set_model': {
      if (!isPlainObject(p)) return 'set_model payload 必须是对象';
      if (!isNonEmptyString(p['sessionId']))
        return 'sessionId 必须是非空字符串';
      if (!isNonEmptyString(p['model'])) return 'model 必须是非空字符串';
      return null;
    }
    case 'set_authorization_mode': {
      if (!isPlainObject(p)) return 'set_authorization_mode payload 必须是对象';
      if (!isNonEmptyString(p['sessionId']))
        return 'sessionId 必须是非空字符串';
      if (p['mode'] !== 'manual' && p['mode'] !== 'auto')
        return 'mode 必须是 manual | auto';
      if (p['scope'] !== 'session' && p['scope'] !== 'all')
        return 'scope 必须是 session | all';
      return null;
    }
    case 'delete_custom_model': {
      if (!isPlainObject(p)) return 'delete_custom_model payload 必须是对象';
      return isNonEmptyString(p['id']) ? null : 'id 必须是非空字符串';
    }
    case 'save_custom_model': {
      if (!isPlainObject(p)) return 'save_custom_model payload 必须是对象';
      if (!isNonEmptyString(p['provider'])) return 'provider 必须是非空字符串';
      if (typeof p['baseUrl'] !== 'string') return 'baseUrl 必须是字符串';
      if (typeof p['apiKey'] !== 'string') return 'apiKey 必须是字符串';
      if (!isNonEmptyString(p['modelId'])) return 'modelId 必须是非空字符串';
      if (p['modelIds'] !== undefined) {
        const ids = p['modelIds'];
        if (
          !Array.isArray(ids) ||
          !ids.every((x) => typeof x === 'string' && x.trim().length > 0)
        ) {
          return 'modelIds 必须是非空字符串数组';
        }
      }
      if (
        p['displayName'] !== undefined &&
        typeof p['displayName'] !== 'string'
      )
        return 'displayName 必须是字符串';
      if (p['maxTokens'] !== undefined && typeof p['maxTokens'] !== 'number')
        return 'maxTokens 必须是数字';
      if (p['enabled'] !== undefined && typeof p['enabled'] !== 'boolean')
        return 'enabled 必须是布尔';
      if (p['replaceId'] !== undefined && !isNonEmptyString(p['replaceId']))
        return 'replaceId 必须是非空字符串';
      if (p['makeActive'] !== undefined && typeof p['makeActive'] !== 'boolean')
        return 'makeActive 必须是布尔';
      return null;
    }
    case 'get_settings':
    case 'get_search_config':
    case 'mcp_list':
    case 'get_stats':
    case 'run_doctor':
    case 'get_todos':
    case 'get_memory':
    case 'get_skills':
    case 'get_workflows':
    case 'get_extensions':
    case 'get_ide_status':
    case 'get_knowledge':
    case 'search_knowledge':
    case 'add_knowledge':
    case 'remove_knowledge':
    case 'list_slash_commands':
    case 'get_product_workspace':
    case 'switch_to_personal':
    case 'get_pending_auto_skills':
    case 'scan_pending_auto_skills':
      return isPlainObject(p) ? null : `${msg.type} payload 必须是对象`;
    case 'configure_enterprise': {
      if (!isPlainObject(p)) return 'configure_enterprise payload 必须是对象';
      if (!isNonEmptyString(p['managerName']))
        return 'managerName 必须是非空字符串';
      if (!isNonEmptyString(p['companyName']))
        return 'companyName 必须是非空字符串';
      if (p['industry'] !== undefined && typeof p['industry'] !== 'string')
        return 'industry 必须是字符串';
      if (
        p['employeeScale'] !== undefined &&
        typeof p['employeeScale'] !== 'string'
      )
        return 'employeeScale 必须是字符串';
      return null;
    }
    case 'join_enterprise': {
      if (!isPlainObject(p)) return 'join_enterprise payload 必须是对象';
      if (!isNonEmptyString(p['link'])) return 'link 必须是非空字符串';
      if (!isNonEmptyString(p['userId'])) return 'userId 必须是非空字符串';
      if (!isNonEmptyString(p['displayName']))
        return 'displayName 必须是非空字符串';
      return null;
    }
    case 'create_enterprise_invite': {
      if (!isPlainObject(p))
        return 'create_enterprise_invite payload 必须是对象';
      const kind = p['kind'];
      if (
        kind !== 'position' &&
        kind !== 'company' &&
        kind !== 'company_link'
      ) {
        return 'kind 必须是 position | company | company_link';
      }
      if (kind === 'position') {
        if (!isNonEmptyString(p['departmentId']))
          return 'departmentId 必须是非空字符串';
        if (!isNonEmptyString(p['positionId']))
          return 'positionId 必须是非空字符串';
      }
      if (
        kind === 'company_link' &&
        p['direction'] !== 'parent_invites_child' &&
        p['direction'] !== 'child_requests_parent'
      ) {
        return 'direction 必须是 parent_invites_child | child_requests_parent';
      }
      if (
        p['expiresInSeconds'] !== undefined &&
        (!Number.isSafeInteger(p['expiresInSeconds']) ||
          (p['expiresInSeconds'] as number) <= 0)
      ) {
        return 'expiresInSeconds 必须是正整数';
      }
      return null;
    }
    case 'add_friend': {
      if (!isPlainObject(p)) return 'add_friend payload 必须是对象';
      if (!isNonEmptyString(p['displayName']))
        return 'displayName 必须是非空字符串';
      if (p['note'] !== undefined && typeof p['note'] !== 'string')
        return 'note 必须是字符串';
      return null;
    }
    case 'accept_company_link': {
      if (!isPlainObject(p)) return 'accept_company_link payload 必须是对象';
      return isNonEmptyString(p['link']) ? null : 'link 必须是非空字符串';
    }
    case 'confirm_pending_auto_skill':
    case 'reject_pending_auto_skill': {
      if (!isPlainObject(p)) return `${msg.type} payload 必须是对象`;
      return isNonEmptyString(p['candidateId'])
        ? null
        : 'candidateId 必须是非空字符串';
    }
    case 'get_schedules': {
      if (!isPlainObject(p)) return 'get_schedules payload 必须是对象';
      if (
        p['date'] !== undefined &&
        (typeof p['date'] !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(p['date']))
      ) {
        return 'date 必须是 YYYY-MM-DD';
      }
      if (p['timezone'] !== undefined && typeof p['timezone'] !== 'string')
        return 'timezone 必须是字符串';
      return null;
    }
    case 'create_schedule': {
      if (!isPlainObject(p)) return 'create_schedule payload 必须是对象';
      if (!isNonEmptyString(p['title'])) return 'title 必须是非空字符串';
      if (!isNonEmptyString(p['startAt'])) return 'startAt 必须是非空字符串';
      if (Number.isNaN(new Date(p['startAt'] as string).getTime()))
        return 'startAt 必须是合法日期时间';
      if (
        p['endAt'] !== undefined &&
        (typeof p['endAt'] !== 'string' ||
          Number.isNaN(new Date(p['endAt']).getTime()))
      ) {
        return 'endAt 必须是合法日期时间';
      }
      return null;
    }
    case 'update_schedule': {
      if (!isPlainObject(p)) return 'update_schedule payload 必须是对象';
      if (!isNonEmptyString(p['id'])) return 'id 必须是非空字符串';
      if (p['title'] !== undefined && typeof p['title'] !== 'string')
        return 'title 必须是字符串';
      if (p['startAt'] !== undefined && typeof p['startAt'] !== 'string')
        return 'startAt 必须是字符串';
      return null;
    }
    case 'delete_schedule': {
      if (!isPlainObject(p)) return 'delete_schedule payload 必须是对象';
      return isNonEmptyString(p['id']) ? null : 'id 必须是非空字符串';
    }
    case 'run_slash_command': {
      if (!isPlainObject(p)) return 'run_slash_command payload 必须是对象';
      if (!isNonEmptyString(p['sessionId']))
        return 'sessionId 必须是非空字符串';
      if (!isNonEmptyString(p['name'])) return 'name 必须是非空字符串';
      if (p['args'] !== undefined && typeof p['args'] !== 'string')
        return 'args 必须是字符串';
      return null;
    }
    case 'set_setting': {
      if (!isPlainObject(p)) return 'set_setting payload 必须是对象';
      const key = p['key'];
      if (
        key !== 'agentStyle' &&
        key !== 'healthyUse' &&
        key !== 'preferredLanguage'
      )
        return 'key 必须是 agentStyle | healthyUse | preferredLanguage';
      const value = p['value'];
      if (typeof value !== 'string' && typeof value !== 'boolean')
        return 'value 必须是字符串或布尔';
      return null;
    }
    case 'save_search_config': {
      if (!isPlainObject(p)) return 'save_search_config payload 必须是对象';
      const provider = p['provider'];
      if (
        provider !== 'bing' &&
        provider !== 'bocha' &&
        provider !== 'gemini' &&
        provider !== 'volcengine'
      ) {
        return 'provider 必须是 bing | bocha | gemini | volcengine';
      }
      if (p['apiUrl'] !== undefined) {
        if (typeof p['apiUrl'] !== 'string') return 'apiUrl 必须是字符串';
        const apiUrl = p['apiUrl'].trim();
        if (apiUrl && !apiUrl.startsWith('https://')) {
          return 'apiUrl 必须使用 HTTPS';
        }
      }
      if (p['model'] !== undefined && typeof p['model'] !== 'string') {
        return 'model 必须是字符串';
      }
      if (p['apiKey'] !== undefined && typeof p['apiKey'] !== 'string') {
        return 'apiKey 必须是字符串';
      }
      if (
        p['clearApiKey'] !== undefined &&
        typeof p['clearApiKey'] !== 'boolean'
      ) {
        return 'clearApiKey 必须是布尔';
      }
      return null;
    }
    case 'mcp_add': {
      if (!isPlainObject(p)) return 'mcp_add payload 必须是对象';
      if (!isNonEmptyString(p['name'])) return 'name 必须是非空字符串';
      if (p['command'] !== undefined && typeof p['command'] !== 'string')
        return 'command 必须是字符串';
      if (p['url'] !== undefined && typeof p['url'] !== 'string')
        return 'url 必须是字符串';
      if (p['httpUrl'] !== undefined && typeof p['httpUrl'] !== 'string')
        return 'httpUrl 必须是字符串';
      if (
        !isNonEmptyString(p['command']) &&
        !isNonEmptyString(p['url']) &&
        !isNonEmptyString(p['httpUrl'])
      ) {
        return '必须提供 command / url / httpUrl 之一';
      }
      return null;
    }
    case 'mcp_remove': {
      if (!isPlainObject(p)) return 'mcp_remove payload 必须是对象';
      return isNonEmptyString(p['name']) ? null : 'name 必须是非空字符串';
    }
    case 'get_context_breakdown':
    case 'get_tools':
    case 'compress_context':
    case 'export_conversation': {
      if (!isPlainObject(p)) return `${msg.type} payload 必须是对象`;
      return isNonEmptyString(p['sessionId'])
        ? null
        : 'sessionId 必须是非空字符串';
    }
    case 'add_memory': {
      if (!isPlainObject(p)) return 'add_memory payload 必须是对象';
      return isNonEmptyString(p['fact']) ? null : 'fact 必须是非空字符串';
    }
    default:
      return `未知帧类型：${msg.type}`;
  }
}

/** 便捷构造器：保证 type/payload 配对，避免实装手写出错。 */
export function frame<T extends ServerToClient>(msg: T): T {
  return msg;
}
