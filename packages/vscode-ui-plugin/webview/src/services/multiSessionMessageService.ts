/**
 * Multi-Session Message Service
 * 支持多Session的消息服务
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import { SessionInfo } from '../../../src/types/sessionTypes';
import { ChatMessage, MessageContent } from '../types';
import { SessionType } from '../../../src/constants/sessionConstants';
// MessageFromExtension, MessageToExtension imports removed - not used

// =============================================================================
// 多Session消息类型定义
// =============================================================================

interface MultiSessionMessageFromExtension {
  type: 'tool_execution_result' |
       'tool_execution_error' |
       'tool_execution_confirmation_request' |
       'tool_calls_update' |
       'tool_confirmation_request' |
       'tool_results_continuation' |
       'chat_response' |
       'chat_error' |
       'chat_start' |
       'chat_chunk' |
       'chat_reasoning' |
       'chat_complete' |
       'context_update' |
       'quick_action' |
       // 🎯 新增流程状态消息类型
       'flow_state_update' |
       'flow_aborted' |
       // 新的多Session消息类型
       'session_list_update' |
       'session_created' |
       'session_updated' |
       'session_deleted' |
       'session_switched' |
       'session_export_complete' |
       'session_import_complete' |
       'session_history_response' |  // 🎯 历史列表分页响应
       // 🎯 UI历史记录相关
       'restore_ui_history' |
       'request_ui_history' |
       'update_rollbackable_ids' |
       // 🎯 文件搜索结果
       'file_search_result' |
       // 🎯 文件夹浏览结果
       'folder_browse_result' |
       // 🎯 符号搜索结果
       'symbol_search_result' |
       // 🎯 文件路径解析结果
       'file_paths_resolved' |
       // 🎯 登录相关消息类型
       'login_status_response' |
       'login_response' |
       // 🎯 项目设置相关
       'project_settings_response' |
       // 🎯 服务初始化状态
       'service_initialization_status' |
       // 🎯 模型配置相关
       'model_response' |
       // 🎯 消息预填充（自动发送）
       'prefill_message' |
       // 🎯 插入代码到输入框（只插入，不自动发送）
       'insert_code_to_input' |
       // 🎯 剪贴板缓存响应
       'clipboard_cache_response' |
       // 🎯 自定义规则管理
       'open_rules_management' |
       'rules_list_response' |
       'rules_save_response' |
       'rules_delete_response' |
       // 🎯 目标驱动模式向导
       'open_goal_wizard' |
       // 🎯 文本优化命令（/refine）
       'refine_result' |
       'refine_error' |
       // 🎯 MCP 状态更新
       'mcp_status_update' |
       // 🎯 循环检测和压缩通知
       'loop_detected' |
       'chat_compressed' |
       // 🎯 模型切换压缩确认
       'compression_confirmation_request' |
       // 🎯 Token使用情况更新（压缩后）
       'token_usage_update' |
       // 🎯 模型切换完成
       'model_switch_complete' |
       // 🆕 流中断恢复倒计时
       'stream_recovery_start' |
       'stream_recovery_countdown' |
       'stream_recovery_end' |
       // 🔐 认证过期通知
       'auth_expired' |
       // 🟢 自定义模型管理响应
       'custom_models_response' |
       'custom_models_changed' |
       'fetch_easy_router_models_response' |
       'fetch_easy_claw_metadata_response';
  payload: Record<string, unknown> & {
    sessionId?: string; // 大部分消息都包含sessionId
  };
}

export interface MultiSessionMessageToExtension {
  type: 'tool_execution_request' |
       'tool_execution_confirm' |
       'tool_confirmation_response' |
       'tool_cancel_all' |
       'chat_message' |
       'edit_message_and_regenerate' |
       'rollback_to_message' |          // 🎯 新增：回退到指定消息
       'get_context' |
       'ready' |
       // 🎯 新增流程控制消息类型
       'flow_abort' |
       // 新的多Session消息类型
       'session_create' |
       'session_delete' |
       'session_switch' |
       'session_update' |
       'session_duplicate' |
       'session_clear' |
       'session_export' |
       'session_import' |
       'session_list_request' |
       'session_reorder' |  // 🎯 新增：会话拖拽排序
       // 🎯 UI消息保存相关
       'save_ui_message' |
       'save_session_ui_history' |
       // 🎯 文件搜索和路径解析相关
       'file_search' |
       'folder_browse' |
       'symbol_search' |
       'resolve_file_paths' |
       // 🎯 登录相关消息类型
       'login_check_status' |
       'login_start' |
       'logout' |
       // 🎯 项目设置相关
       'project_settings_update' |
       'project_settings_request' |
       // 🎯 模型配置相关
       'get_available_models' |
       'set_current_model' |
       'get_current_model' |
       'compression_confirmation_response' |  // 🎯 新增：压缩确认响应
       // 🎯 剪贴板缓存请求（用于智能粘贴代码引用）
       'request_clipboard_cache' |
       // 🎯 自定义规则管理
       'rules_list_request' |
       'rules_save' |
       'rules_delete' |
       // 🎯 MCP 状态请求
       'get_mcp_status' |
       // 🎯 显示通知
       'show_notification' |
       // 🎯 打开 MCP 设置
       'open_mcp_settings' |
       // 🎯 后台任务管理
       'background_task_request' |
       'background_task_move_to_background' |
       // 🎯 注入系统消息到 AI 历史（不显示在 UI）
       'inject_system_message' |
       // 🟢 自定义模型管理请求
       'list_custom_models' |
       'add_custom_models' |
       'delete_custom_model' |
       'fetch_easy_router_models' |
       'fetch_easy_claw_metadata';
  payload: Record<string, unknown> & {
    sessionId?: string; // 大部分消息都包含sessionId
  };
}

// =============================================================================
// Session操作请求接口
// =============================================================================

interface CreateSessionRequest extends Record<string, unknown> {
  name?: string;
  type: SessionType;
  systemPrompt?: string;
  fromTemplate?: boolean;
}

interface UpdateSessionRequest extends Record<string, unknown> {
  sessionId: string;
  updates: {
    name?: string;
    type?: SessionType;
    description?: string;
  };
}

interface SessionSwitchRequest extends Record<string, unknown> {
  sessionId: string;
}

interface SessionExportRequest extends Record<string, unknown> {
  sessionIds?: string[];
}

interface SessionImportRequest extends Record<string, unknown> {
  filePath?: string;
  overwriteExisting?: boolean;
}

// =============================================================================
// 多Session消息服务类
// =============================================================================

export class MultiSessionMessageService {
  private listeners = new Map<string, Function[]>();
  private messageQueue: MultiSessionMessageToExtension[] = [];
  private isReady = false;
  private retryTimer: NodeJS.Timeout | null = null;  // 🎯 防止重复创建 setTimeout

  constructor() {
    this.setupMessageListener();
    // 🎯 立即发送ready消息，MessageService创建即可用
    this.sendReady();
  }

  /**
   * 标记为ready（已在构造函数中调用）
   */
  markAsReady() {
    // 构造函数中已经发送ready，这里只是兼容接口
    if (!this.isReady) {
      this.sendReady();
    }
  }

  /**
   * 设置消息监听器
   */
  private setupMessageListener() {
    window.addEventListener('message', (event) => {
      const message: MultiSessionMessageFromExtension = event.data;
      this.handleMessage(message);
    });
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(message: MultiSessionMessageFromExtension) {
    // 🎯 忽略由其他服务处理的消息类型（现在model_response由MultiSessionMessageService处理）
    const ignoredTypes: string[] = [];
    if (ignoredTypes.includes(message.type)) {
      return;
    }

    const handlers = this.listeners.get(message.type);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(message.payload);
        } catch (error) {
          console.error(`❌ Handler error for ${message.type}:`, error);
        }
      });
    }
  }

  /**
   * 发送消息到Extension
   */
  private sendMessage(message: MultiSessionMessageToExtension) {
    // 🎯 检查VSCode API是否可用
    if (typeof window.vscode === 'undefined' || !window.vscode) {
      console.log('VSCode API not ready, queueing message:', message.type);
      this.messageQueue.push(message);

      // 🎯 防止重复创建 setTimeout：只在没有定时器时创建
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;  // 清除定时器标记
          if (typeof window.vscode !== 'undefined' && window.vscode && this.messageQueue.length > 0) {
            console.log('VSCode API now ready, flushing queue');
            const queue = [...this.messageQueue];
            this.messageQueue = [];
            queue.forEach(msg => this.sendMessage(msg));
          }
        }, 500);
      }
      return;
    }

    // 🎯 这些消息必须立即发送，不受ready状态限制
    const immediateMessages = ['ready', 'login_check_status', 'login_start', 'logout'];

    if (!this.isReady && !immediateMessages.includes(message.type)) {
      console.log('Queueing message (not ready):', message.type);
      this.messageQueue.push(message);
      return;
    }

    try {
      console.log('Sending message to extension:', message.type);
      window.vscode.postMessage(message);
    } catch (error) {
      console.error('Failed to send message to extension:', error);
    }
  }

  /**
   * 发送就绪消息
   */
  private sendReady() {
    this.isReady = true;
    this.sendMessage({ type: 'ready', payload: {} });

    // 发送队列中的消息
    this.messageQueue.forEach(message => {
      this.sendMessage(message);
    });
    this.messageQueue = [];

    // 请求Session列表
    this.requestSessionList();
  }

  // =============================================================================
  // Session管理消息发送方法
  // =============================================================================

  /**
   * 请求Session列表
   */
  requestSessionList(options?: { includeAll?: boolean }) {
    this.sendMessage({
      type: 'session_list_request',
      payload: options || {}
    });
  }

  /**
   * 🎯 请求历史列表（分页）
   * 临时方案：复用 session_list_request，通过 offset/limit 参数区分
   */
  requestSessionHistory(options: { offset: number; limit: number; searchQuery?: string }) {
    console.log('🔥 [TEMP] Sending pagination request via session_list_request:', options);
    this.sendMessage({
      type: 'session_list_request',  // 🔥 临时改为复用现有消息类型
      payload: options as any
    });
  }

  /**
   * 创建新Session
   */
  createSession(request: CreateSessionRequest) {
    this.sendMessage({
      type: 'session_create',
      payload: request
    });
  }

  /**
   * 删除Session
   */
  deleteSession(sessionId: string) {
    this.sendMessage({
      type: 'session_delete',
      payload: { sessionId }
    });
  }

  /**
   * 切换Session
   */
  switchSession(sessionId: string) {
    this.sendMessage({
      type: 'session_switch',
      payload: { sessionId }
    });
  }

  /**
   * 更新Session信息
   */
  updateSession(request: UpdateSessionRequest) {
    this.sendMessage({
      type: 'session_update',
      payload: request
    });
  }

  /**
   * 复制Session
   */
  duplicateSession(sessionId: string) {
    this.sendMessage({
      type: 'session_duplicate',
      payload: { sessionId }
    });
  }

  /**
   * 清空Session内容
   */
  clearSession(sessionId: string) {
    this.sendMessage({
      type: 'session_clear',
      payload: { sessionId }
    });
  }

  /**
   * 🎯 保存Session顺序（用于拖拽排序）
   */
  saveSessionsOrder(sessionIds: string[]) {
    this.sendMessage({
      type: 'session_reorder',
      payload: { sessionIds }
    });
  }

  /**
   * 导出Session
   */
  exportSessions(request: SessionExportRequest = {}) {
    this.sendMessage({
      type: 'session_export',
      payload: request
    });
  }

  /**
   * 导入Session
   */
  importSessions(request: SessionImportRequest = {}) {
    this.sendMessage({
      type: 'session_import',
      payload: request
    });
  }

  // =============================================================================
  // 聊天和工具相关消息发送方法（需要sessionId）
  // =============================================================================

  /**
   * 发送聊天消息
   *
   * @param goalContext 可选 — /goal 模式启动元数据。仅由 GoalWizardDialog
   *   提交路径传入；extension 侧在 onChatMessage 收到后会先 setGoalContext
   *   再处理消息内容。详见 types/messages.ts 的 ChatMessage.goalContext 注释。
   */
  sendChatMessage(
    sessionId: string,
    content: MessageContent,
    msgId: string,
    goalContext?: { startedAt: number; hours: number; task: string },
  ) {
    this.sendMessage({
      type: 'chat_message',
      payload: {
        sessionId,
        id: msgId,
        content,
        timestamp: Date.now(),
        ...(goalContext ? { goalContext } : {}),
      },
    });
  }

  /**
   * 🎯 发送编辑消息并重新生成请求
   */
  sendEditMessageAndRegenerate(sessionId: string, messageId: string, newContent: MessageContent, originalMessages?: any[]) {
    this.sendMessage({
      type: 'edit_message_and_regenerate',
      payload: {
        sessionId,
        messageId,
        newContent,
        originalMessages, // 🎯 新增：传递完整的原始消息历史用于文件回滚分析
        timestamp: Date.now()
      }
    });
  }

  /**
   * 🎯 发送回退到指定消息请求
   */
  sendRollbackToMessage(sessionId: string, messageId: string, originalMessages?: any[]) {
    this.sendMessage({
      type: 'rollback_to_message',
      payload: {
        sessionId,
        messageId,
        originalMessages, // 🎯 传递完整的原始消息历史用于文件回滚分析
        timestamp: Date.now()
      }
    });
  }

  /**
   * 🎯 撤销单个文件的变更
   */
  undoFileChange(sessionId: string, fileData: { fileName: string; filePath?: string; originalContent: string; isNewFile: boolean; isDeletedFile: boolean }) {
    this.sendMessage({
      type: 'undo_file_change' as any,
      payload: {
        sessionId,
        ...fileData
      }
    });
  }

  /**
   * 发送工具执行请求
   */
  sendToolExecutionRequest(sessionId: string, request: {
    id: string;
    toolName: string;
    parameters: Record<string, any>;
    context?: any;
    requiresConfirmation?: boolean;
  }) {
    this.sendMessage({
      type: 'tool_execution_request',
      payload: {
        sessionId,
        ...request
      }
    });
  }

  /**
   * 发送工具确认响应
   *
   * @param sessionId
   * @param toolId
   * @param confirmed 用户是否允许
   * @param userInput 旧版的 edit 模式行内改写内容（可选）
   * @param outcome 'proceed_once' | 'proceed_always' | 'proceed_always_project' | 'cancel' 等
   * @param extra 🎯 AskUserQuestion 专用字段（answers / annotations / feedback）
   */
  sendToolConfirmationResponse(
    sessionId: string,
    toolId: string,
    confirmed: boolean,
    userInput?: string,
    outcome?: string,
    extra?: {
      answers?: Record<string, string>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
      feedback?: string;
    }
  ) {
    this.sendMessage({
      type: 'tool_confirmation_response',
      payload: {
        sessionId,
        toolId,
        confirmed,
        userInput,
        outcome,
        ...(extra?.answers && { answers: extra.answers }),
        ...(extra?.annotations && { annotations: extra.annotations }),
        ...(extra?.feedback && { feedback: extra.feedback }),
      }
    });
  }

  /**
   * 取消所有工具调用
   */
  sendCancelAllTools(sessionId: string) {
    this.sendMessage({
      type: 'tool_cancel_all',
      payload: { sessionId }
    });
  }

  /**
   * 🎯 中断当前流程
   */
  sendFlowAbort(sessionId: string) {
    this.sendMessage({
      type: 'flow_abort',
      payload: { sessionId }
    });
  }

  /**
   * 请求上下文信息
   */
  requestContext(sessionId?: string) {
    this.sendMessage({
      type: 'get_context',
      payload: { sessionId }
    });
  }

  /**
   * 🎯 保存单个UI消息到后端
   */
  saveUIMessage(sessionId: string, message: ChatMessage) {
    this.sendMessage({
      type: 'save_ui_message',
      payload: { sessionId, message }
    });
  }

  /**
   * 🎯 批量保存UI消息历史到后端
   */
  saveSessionUIHistory(sessionId: string, messages: ChatMessage[]) {
    this.sendMessage({
      type: 'save_session_ui_history',
      payload: { sessionId, messages }
    });
  }

  /**
   * 🎯 发送项目设置更新
   */
  sendProjectSettingsUpdate(settings: { yoloMode: boolean; preferredModel?: string; thinkingConfig?: any }) {
    this.sendMessage({
      type: 'project_settings_update',
      payload: settings
    });
  }

  /**
   * 🎯 请求当前项目设置
   */
  requestProjectSettings() {
    this.sendMessage({
      type: 'project_settings_request',
      payload: {}
    });
  }

  // =============================================================================
  // 消息监听器注册方法
  // =============================================================================

  /**
   * 监听Session列表更新
   * @returns 取消订阅的函数
   */
  onSessionListUpdate(handler: (data: { sessions: SessionInfo[]; currentSessionId: string | null }) => void): () => void {
    return this.addMessageHandler('session_list_update', handler);
  }

  /**
   * 🎯 监听历史列表分页响应
   */
  onSessionHistoryResponse(handler: (data: { sessions: SessionInfo[]; total: number; hasMore: boolean; offset: number }) => void) {
    return this.addMessageHandler('session_history_response', handler);
  }

  /**
   * 监听Session创建
   */
  onSessionCreated(handler: (data: { session: SessionInfo }) => void) {
    return this.addMessageHandler('session_created', handler);
  }

  /**
   * 监听Session更新
   */
  onSessionUpdated(handler: (data: { sessionId: string; session: SessionInfo }) => void) {
    return this.addMessageHandler('session_updated', handler);
  }

  /**
   * 监听Session删除
   */
  onSessionDeleted(handler: (data: { sessionId: string }) => void) {
    return this.addMessageHandler('session_deleted', handler);
  }

  /**
   * 监听Session切换
   */
  onSessionSwitched(handler: (data: { sessionId: string; session: SessionInfo }) => void) {
    return this.addMessageHandler('session_switched', handler);
  }

  /**
   * 监听Session导出完成
   */
  onSessionExportComplete(handler: (data: { filePath: string; sessionCount: number }) => void) {
    return this.addMessageHandler('session_export_complete', handler);
  }

  /**
   * 监听Session导入完成
   */
  onSessionImportComplete(handler: (data: { importedSessions: SessionInfo[] }) => void) {
    return this.addMessageHandler('session_import_complete', handler);
  }

  /**
   * 监听UI历史恢复消息
   */
  onRestoreUIHistory(handler: (data: { sessionId: string; messages: ChatMessage[]; rollbackableMessageIds: string[] }) => void) {
    return this.addMessageHandler('restore_ui_history', handler);
  }

  /**
   * 🎯 监听可回滚消息ID列表更新
   */
  onUpdateRollbackableIds(handler: (data: { sessionId: string; rollbackableMessageIds: string[] }) => void) {
    return this.addMessageHandler('update_rollbackable_ids', handler);
  }

  /**
   * 🎯 监听后端请求UI历史记录的消息
   */
  onRequestUIHistory(handler: (data: { sessionId: string }) => void) {
    return this.addMessageHandler('request_ui_history', handler);
  }

  // 原有的消息监听器（现在包含sessionId）
  onToolExecutionResult(handler: (data: { sessionId: string; requestId: string; result: any }) => void) {
    return this.addMessageHandler('tool_execution_result', handler);
  }

  onToolExecutionError(handler: (data: { sessionId: string; requestId: string; error: string }) => void) {
    return this.addMessageHandler('tool_execution_error', handler);
  }

  onToolCallsUpdate(handler: (data: { sessionId: string; toolCalls: any[]; associatedMessageId?: string }) => void) {
    return this.addMessageHandler('tool_calls_update', handler);
  }

  onToolConfirmationRequest(handler: (data: { sessionId: string; toolCall: any }) => void) {
    return this.addMessageHandler('tool_confirmation_request', handler);
  }

  onChatResponse(handler: (data: { sessionId: string; response: any }) => void) {
    return this.addMessageHandler('chat_response', handler);
  }

  onChatError(handler: (data: { sessionId: string; error: string }) => void) {
    return this.addMessageHandler('chat_error', handler);
  }

  /**
   * 监听流式聊天开始事件
   */
  onChatStart(handler: (data: { sessionId: string; messageId: string }) => void) {
    return this.addMessageHandler('chat_start', handler);
  }

  /**
   * 监听流式聊天内容块事件
   */
  onChatChunk(handler: (data: { sessionId: string; content: string; messageId: string; isComplete?: boolean }) => void) {
    return this.addMessageHandler('chat_chunk', handler);
  }

  /**
   * 监听流式聊天完成事件
   */
  onChatComplete(handler: (data: { sessionId: string; messageId: string; tokenUsage?: any }) => void) {
    return this.addMessageHandler('chat_complete', handler);
  }

  /**
   * 🎯 监听AI思考过程事件
   */
  onChatReasoning(handler: (data: { sessionId: string; content: string; messageId: string }) => void) {
    return this.addMessageHandler('chat_reasoning', handler);
  }

  onContextUpdate(handler: (data: { sessionId?: string; context: any }) => void) {
    return this.addMessageHandler('context_update', handler);
  }

  onQuickAction(handler: (data: { sessionId?: string; action: any }) => void) {
    return this.addMessageHandler('quick_action', handler);
  }

  onToolResultsContinuation(handler: (data: { sessionId: string; response: any }) => void) {
    return this.addMessageHandler('tool_results_continuation', handler);
  }

  onToolMessage(handler: (data: { sessionId: string; toolId: string; content: string; toolMessageType: 'status' | 'output'; [key: string]: any }) => void) {
    return this.addMessageHandler('tool_message', handler);
  }

  /**
   * 🎯 监听流程状态更新
   */
  onFlowStateUpdate(handler: (data: { sessionId: string; isProcessing: boolean; currentProcessingMessageId?: string; canAbort: boolean }) => void) {
    return this.addMessageHandler('flow_state_update', handler);
  }

  /**
   * 🎯 监听流程中断
   */
  onFlowAborted(handler: (data: { sessionId: string }) => void) {
    return this.addMessageHandler('flow_aborted', handler);
  }

  /**
   * 🎯 监听记忆文件路径更新
   */
  onMemoryFilesUpdate(handler: (data: { filePaths: string[]; fileCount: number }) => void) {
    return this.addMessageHandler('memory_files_update', handler);
  }

  // =============================================================================
  // 私有辅助方法
  // =============================================================================

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 移除消息处理器
   */
  removeMessageHandler(type: string, handler: Function) {
    const handlers = this.listeners.get(type);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  // =============================================================================
  // 🎯 登录相关方法
  // =============================================================================

  /**
   * 检查登录状态
   */
  checkLoginStatus(): void {
    this.sendMessage({
      type: 'login_check_status',
      payload: {}
    });
  }

  /**
   * 开始登录流程
   */
  startLogin(): void {
    this.sendMessage({
      type: 'login_start',
      payload: {}
    });
  }

  /**
   * 监听登录状态响应
   */
  onLoginStatusResponse(callback: (data: { isLoggedIn: boolean; error?: string }) => void) {
    return this.addMessageHandler('login_status_response', callback);
  }

  /**
   * 监听登录结果
   */
  onLoginResponse(callback: (data: { success: boolean; error?: string }) => void) {
    return this.addMessageHandler('login_response', callback);
  }

  /**
   * 发送登出请求
   */
  logout(): void {
    this.sendMessage({
      type: 'logout',
      payload: {}
    });
  }

  /**
   * 监听登出结果
   */
  onLogoutResponse(callback: (data: { success: boolean; error?: string }) => void) {
    return this.addMessageHandler('logout_response', callback);
  }

  /**
   * 🔐 监听认证过期通知（服务端返回 HTTP 401 时触发）
   */
  onAuthExpired(callback: (data: { reason: string }) => void) {
    return this.addMessageHandler('auth_expired', callback);
  }

  /**
   * 🎯 监听项目设置响应
   */
  onProjectSettingsResponse(callback: (data: { yoloMode: boolean }) => void) {
    return this.addMessageHandler('project_settings_response', callback);
  }

  /**
   * 🎯 监听服务初始化状态
   */
  onServiceInitializationStatus(callback: (data: { status: string; message: string; timestamp: number }) => void) {
    return this.addMessageHandler('service_initialization_status', callback);
  }

  /**
   * 🎯 监听消息预填充（用于右键菜单快捷操作 - 自动发送）
   */
  onPrefillMessage(callback: (data: { message: string }) => void) {
    return this.addMessageHandler('prefill_message', callback);
  }

  /**
   * 🎯 监听插入代码到输入框（只插入，不自动发送）
   */
  onInsertCodeToInput(callback: (data: { fileName: string; filePath: string; code: string; startLine?: number; endLine?: number }) => void) {
    return this.addMessageHandler('insert_code_to_input', callback);
  }

  /**
   * 🎯 请求剪贴板缓存（用于智能粘贴代码引用）
   */
  requestClipboardCache(code: string): void {
    this.sendMessage({
      type: 'request_clipboard_cache',
      payload: { code }
    });
  }

  /**
   * 🎯 监听剪贴板缓存响应
   */
  onClipboardCacheResponse(callback: (data: {
    found: boolean;
    fileName?: string;
    filePath?: string;
    code?: string;
    startLine?: number;
    endLine?: number;
  }) => void) {
    return this.addMessageHandler('clipboard_cache_response', callback);
  }
  /**
   * 🎯 监听打开规则管理对话框
   */
  onOpenRulesManagement(callback: () => void) {
    return this.addMessageHandler('open_rules_management', callback);
  }

  /**
   * 🎯 监听打开目标驱动模式向导
   */
  onOpenGoalWizard(callback: () => void) {
    return this.addMessageHandler('open_goal_wizard', callback);
  }

  /**
   * 🎯 监听规则列表响应
   */
  onRulesListResponse(callback: (data: { rules: any[] }) => void): () => void {
    return this.addMessageHandler('rules_list_response', callback);
  }

  /**
   * 🎯 监听规则保存响应
   */
  onRulesSaveResponse(callback: (data: { success: boolean; error?: string }) => void): () => void {
    return this.addMessageHandler('rules_save_response', callback);
  }

  /**
   * 🎯 监听规则删除响应
   */
  onRulesDeleteResponse(callback: (data: { success: boolean; error?: string }) => void): () => void {
    return this.addMessageHandler('rules_delete_response', callback);
  }

  /**
   * 🎯 请求规则列表
   */
  requestRulesList() {
    this.sendMessage({
      type: 'rules_list_request',
      payload: {}
    });
  }

  /**
   * 🎯 保存规则
   */
  saveRule(rule: any) {
    this.sendMessage({
      type: 'rules_save',
      payload: { rule }
    });
  }

  /**
   * 🎯 删除规则
   */
  deleteRule(ruleId: string) {
    this.sendMessage({
      type: 'rules_delete',
      payload: { ruleId }
    });
  }

  // =============================================================================
  // 🎯 文本优化命令（/refine）
  // =============================================================================

  /**
   * 🎯 监听文本优化结果
   */
  onRefineResult(callback: (data: { original: string; refined: string }) => void): () => void {
    return this.addMessageHandler('refine_result', callback);
  }

  /**
   * 🎯 监听文本优化错误
   */
  onRefineError(callback: (data: { error: string }) => void): () => void {
    return this.addMessageHandler('refine_error', callback);
  }

  // =============================================================================
  // 🎯 MCP 状态管理
  // =============================================================================

  /**
   * 🎯 监听 MCP 状态更新
   */
  onMcpStatusUpdate(callback: (data: { discoveryState: string; servers: Array<{ name: string; status: string; toolCount: number; enabled?: boolean }> }) => void): () => void {
    return this.addMessageHandler('mcp_status_update', callback);
  }

  /**
   * 🔌 设置 MCP Server 启用状态
   */
  setMcpEnabled(serverName: string, enabled: boolean): void {
    console.log(`🔌 [MCP WebView] Sending set_mcp_enabled: serverName='${serverName}', enabled=${enabled}`);
    this.sendMessage({
      type: 'set_mcp_enabled' as any,
      payload: { serverName, enabled }
    });
  }

  /**
   * 🔌 获取 MCP Server 启用状态
   */
  getMcpEnabledStates(serverNames: string[]): void {
    this.sendMessage({
      type: 'get_mcp_enabled_states' as any,
      payload: { serverNames }
    });
  }

  /**
   * 🔌 监听 MCP 启用状态更新
   */
  onMcpEnabledStates(callback: (data: { states: Record<string, boolean> }) => void): () => void {
    return this.addMessageHandler('mcp_enabled_states', callback);
  }

  // =============================================================================
  // 🎯 文件操作相关
  // =============================================================================

  /**
   * 📝 打开文件
   */
  openFile(filePath: string, line?: number): void {
    this.sendMessage({
      type: 'open_file' as any,
      payload: { filePath, line }
    });
  }

  /**
   * 📝 刷新内存文件
   */
  refreshMemory(): void {
    this.sendMessage({
      type: 'refresh_memory' as any,
      payload: {}
    });
  }

  /**
   * 🎯 打开 VS Code 扩展设置
   */
  openExtensionSettings(): void {
    this.sendMessage({
      type: 'open_extension_settings' as any,
      payload: {}
    });
  }

  // =============================================================================
  // 🎯 用户规则相关
  // =============================================================================

  /**
   * 📝 获取用户规则
   */
  getUserRules(): void {
    this.sendMessage({
      type: 'get_user_rules' as any,
      payload: {}
    });
  }

  /**
   * 📝 保存用户规则
   */
  saveUserRules(rules: string): void {
    this.sendMessage({
      type: 'save_user_rules' as any,
      payload: { rules }
    });
  }

  /**
   * 📝 监听用户规则响应
   */
  onUserRulesResponse(callback: (data: { rules: string }) => void): () => void {
    return this.addMessageHandler('user_rules_response', callback);
  }

  /**
   * 📝 监听用户规则保存结果
   */
  onUserRulesSaved(callback: (data: { success: boolean; error?: string }) => void): () => void {
    return this.addMessageHandler('user_rules_saved', callback);
  }

  // =============================================================================
  // 🎯 NanoBanana 图像生成
  // =============================================================================

  /**
   * 🎯 发送NanoBanana图片上传请求（单张）
   */
  sendNanoBananaUpload(data: { filename: string; contentType: string; fileData: string }) {
    this.sendMessage({
      type: 'nanobanana_upload' as any,
      payload: data
    });
  }

  /**
   * 🎯 发送NanoBanana批量图片上传请求（多张）
   */
  sendNanoBananaBatchUpload(data: { files: Array<{ filename: string; contentType: string; fileData: string }> }) {
    this.sendMessage({
      type: 'nanobanana_batch_upload' as any,
      payload: data
    });
  }

  /**
   * 🎯 监听NanoBanana上传响应（单张）
   * @returns 取消订阅的函数
   */
  onNanoBananaUploadResponse(callback: (data: { success: boolean; publicUrl?: string; error?: string }) => void) {
    return this.addMessageHandler('nanobanana_upload_response', callback);
  }

  /**
   * 🎯 监听NanoBanana批量上传响应（多张）
   * @returns 取消订阅的函数
   */
  onNanoBananaBatchUploadResponse(callback: (data: { success: boolean; publicUrls?: string[]; error?: string }) => void) {
    return this.addMessageHandler('nanobanana_batch_upload_response', callback);
  }

  /**
   * 🎯 发送NanoBanana生成请求（支持多轮会话 + 多图参考）
   */
  sendNanoBananaGenerate(data: {
    prompt: string;
    aspectRatio: string;
    imageSize: string;
    referenceImageUrl?: string;
    referenceImageUrls?: string[];
    // 多轮会话上下文
    conversationContext?: {
      previousGeneratedImageUrl: string;
      history: Array<{
        role: 'user' | 'assistant';
        prompt?: string;
        imageUrl?: string;
      }>;
    };
  }) {
    this.sendMessage({
      type: 'nanobanana_generate' as any,
      payload: data
    });
  }

  /**
   * 🎯 监听NanoBanana生成响应
   * @returns 取消订阅的函数
   */
  onNanoBananaGenerateResponse(callback: (data: { success: boolean; taskId?: string; estimatedTime?: number; error?: string }) => void) {
    return this.addMessageHandler('nanobanana_generate_response', callback);
  }

  /**
   * 🎯 发送NanoBanana状态查询请求
   */
  sendNanoBananaStatus(data: { taskId: string }) {
    this.sendMessage({
      type: 'nanobanana_status' as any,
      payload: data
    });
  }

  /**
   * 🎯 监听NanoBanana状态更新
   * @returns 取消订阅的函数
   */
  onNanoBananaStatusUpdate(callback: (data: {
    taskId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress?: number;
    resultUrls?: string[];
    originalUrls?: string[];
    errorMessage?: string;
    creditsDeducted?: number;
  }) => void) {
    return this.addMessageHandler('nanobanana_status_update', callback);
  }

  // =============================================================================
  // 🎯 PPT 生成相关方法 (无状态轮询，任务提交后直接返回编辑页面URL)
  // =============================================================================

  /**
   * 🎯 发送PPT生成请求
   */
  sendPPTGenerate(data: { topic: string; pageCount: number; style: string; outline: string }) {
    this.sendMessage({
      type: 'ppt_generate' as any,
      payload: data
    });
  }

  /**
   * 🎯 监听PPT生成响应
   */
  onPPTGenerateResponse(callback: (data: { success: boolean; taskId?: string; editUrl?: string; error?: string }) => void) {
    return this.addMessageHandler('ppt_generate_response', callback);
  }

  /**
   * 🎯 发送PPT大纲AI优化请求
   */
  sendPPTOptimizeOutline(data: { topic: string; pageCount: number; style: string; colorScheme: string; outline: string }) {
    this.sendMessage({
      type: 'ppt_optimize_outline' as any,
      payload: data
    });
  }

  /**
   * 🎯 监听PPT大纲AI优化响应
   */
  onPPTOptimizeOutlineResponse(callback: (data: { success: boolean; optimizedOutline?: string; error?: string }) => void) {
    return this.addMessageHandler('ppt_optimize_outline_response', callback);
  }

  /**
   * 🎯 注入系统消息到 AI 历史（不显示在 UI）
   */
  sendInjectSystemMessage(sessionId: string, content: string) {
    this.sendMessage({
      type: 'inject_system_message',
      payload: { sessionId, content }
    });
  }

  /**
   * 🎯 打开外部URL
   */
  openExternalUrl(url: string) {
    this.sendMessage({
      type: 'open_external_url' as any,
      payload: { url }
    });
  }

  // =============================================================================
  // 公共方法
  // =============================================================================

  /**
   * 添加消息处理器 - 公共接口
   * @returns 取消订阅的函数
   */
  addMessageHandler(type: string, handler: Function): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(handler);

    // 返回取消订阅函数
    return () => {
      const handlers = this.listeners.get(type);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index > -1) {
          handlers.splice(index, 1);
        }
      }
    };
  }

  // =============================================================================
  // 公共 API 方法
  // =============================================================================

  /**
   * 发送消息到扩展（公共方法）
   */
  send(message: MultiSessionMessageToExtension) {
    this.sendMessage(message);
  }

  /**
   * 监听来自扩展的消息
   */
  onExtensionMessage(type: string, handler: (payload: any) => void): () => void {
    return this.addMessageHandler(type, handler);
  }

  // =============================================================================
  // 私有辅助方法
  // =============================================================================

  /**
   * 清理所有监听器
   */
  dispose() {
    // 🎯 清理定时器，防止内存泄漏
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.listeners.clear();
    this.messageQueue = [];
    this.isReady = false;
  }
}
