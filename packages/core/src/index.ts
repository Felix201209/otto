/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Export config
export * from './config/config.js';
export * from './config/agent-loop-context.js';
export * from './policy/policy-engine.js';
export * from './policy/policy-updater.js';
export * from './confirmation-bus/message-bus.js';
export * from './config/projectSettings.js';
export * from './config/messageRoles.js';
export * from './config/serverConfig.js';
export * from './config/proxyConfig.js';
export * from './config/modelCapabilities.js';

// Export extended types
export * from './types/extendedContent.js';
export * from './types/customModel.js';

// Export Core Logic
export * from './core/client.js';
export * from './core/contentGenerator.js';
export * from './core/ottoChat.js';
export * from './core/logger.js';
export * from './core/prompts.js';
export * from './core/tokenLimits.js';
export * from './core/modelConfig.js';
export * from './core/turn.js';
export * from './core/invalidStreamError.js';
export * from './core/ottoRequest.js';
export * from './core/coreToolScheduler.js';
export * from './core/nonInteractiveToolExecutor.js';
export * from './tools/task.js';
export * from './core/subAgent.js';
export * from './core/proxyAuth.js';
export * from './core/toolSchedulerAdapter.js';
export { ToolExecutionEngine } from './core/toolExecutionEngine.js';
export * from './core/mainAgentAdapter.js';
export * from './core/subAgentAdapter.js';
export * from './core/sceneManager.js';
export * from './core/imageGenerator.js';
export * from './core/workflowRegistry.js';

export * from './code_assist/codeAssist.js';
// clearCachedCredentialFile removed with OAuth2 - no longer needed for Otto custom-model auth
// OAuth2 module removed - only Otto custom-model authentication supported
export * from './code_assist/server.js';
export * from './code_assist/types.js';
export * from './code_assist/inlineCompletion.js';

// Export utilities
export * from './utils/paths.js';
export * from './utils/userAgent.js';
export * from './utils/schemaValidator.js';
export * from './utils/errors.js';
export * from './utils/httpErrorFallback.js';
export * from './utils/getFolderStructure.js';
export * from './utils/memoryDiscovery.js';
export * from './utils/gitIgnoreParser.js';
export * from './utils/editor.js';
export * from './utils/quotaErrorDetection.js';
export * from './utils/fileUtils.js';
export * from './utils/retry.js';
export * from './utils/functionCallValidator.js';
export * from './utils/modelDiagnostics.js';
export * from './utils/logging.js';
export * from './utils/pathUtils.js';
export * from './utils/healthyUseReminderState.js';
export * from './utils/constants.js';
export * from './utils/stdio.js';
export * from './utils/version.js';
export * from './utils/events.js';
export * from './utils/sessionUtils.js';
export * from './utils/sessionSelector.js';
export * from './utils/goalContinuationPrompt.js';

export * from './utils/enhancedLogger.js';

// Export environment detection utilities
export * from './utils/environment/index.js';

// Export auth
export * from './auth/authenticatedHttpClient.js';
export * from './auth/authNavigator.js';
export * from './auth/login/authServer.js';
export * from './auth/login/ottoAuth.js';
export * from './auth/login/templates/index.js';
// Explicitly export AuthServer class
export { AuthServer } from './auth/login/authServer.js';

// Export services
export * from './services/fileDiscoveryService.js';
export * from './services/fileSystemService.js';
export * from './services/gitService.js';
export * from './services/sessionManager.js';
export * from './services/mcpResponseGuard.js';
export * from './services/fileOperationQueue.js';
export * from './services/backgroundTaskManager.js';
export * from './services/backgroundModeSignal.js';
export * from './services/doctor.js';
export { formatClaudeCodeTaskResult, isAcpDelegateTask } from './tools/delegate-agent.js';
export {
  CacheSafeParamsStore,
  type CacheSafeParams,
} from './services/cacheSafeParams.js';
export {
  runForkedAgent,
  type RunForkedAgentOptions,
  type RunForkedAgentResult,
} from './agents/runForkedAgent.js';
export {
  runSideQuestion,
  SIDE_QUESTION_SYSTEM_PROMPT,
  type RunSideQuestionOptions,
  type RunSideQuestionResult,
} from './agents/runSideQuestion.js';
export {
  EXTERNAL_AGENT_TYPES,
  isExternalAgentType,
  resolveExternalAgentSpec,
  type ExternalAgentType,
  type ExternalAgentSpec,
} from './acp-client/externalAgentRegistry.js';
export {
  runDelegatedTask,
  type RunTaskOptions,
  type DelegateResult,
  type DelegateStatus,
  type DelegateProgress,
  type DelegatePlanEntry,
} from './acp-client/acpAgentClient.js';
export {
  listExternalSessions,
  type ExternalSessionDescriptor,
  type ListExternalSessionsOptions,
  type ListExternalSessionsResult,
} from './acp-client/sessionDiscovery.js';

// Export IDE specific logic
export * from './ide/ide-client.js';
export * from './ide/ideContext.js';

// Export hooks
export * from './hooks/types.js';

// Export base tool definitions
export * from './tools/tools.js';
export * from './tools/tool-registry.js';
export * from './tools/local-schedule.js';
export * from './resources/resource-registry.js';

// Export prompt logic
export * from './prompts/mcp-prompts.js';

// Export specific tool logic
export * from './tools/read-file.js';
export * from './tools/ls.js';
export * from './tools/grep.js';
export * from './tools/glob.js';
export * from './tools/edit.js';
export * from './tools/write-file.js';
export * from './tools/web-fetch.js';
export * from './tools/memoryTool.js';
export * from './memory/memoryProvider.js';
export * from './memory/mem0Adapter.js';
export * from './memory/codebaseMemoryTypes.js';
export * from './memory/codebaseMemoryProvider.js';
export * from './memory/orgMemoryTypes.js';
export * from './memory/orgMemoryStore.js';
export * from './memory/permissionChecker.js';
export * from './memory/skillFormation.js';
export * from './tools/shell.js';
export * from './tools/web-search.js';
export * from './tools/image-reader.js';
export * from './tools/audio-reader.js';
export * from './tools/video-analyzer.js';
export * from './tools/self-update.js';
export * from './tools/read-many-files.js';
export * from './tools/read-lints.js';
export * from './tools/lint-fix.js';
export * from './tools/ask-user-question.js';
export * from './tools/local-time.js';
export * from './tools/goal-achieved.js';
export * from './tools/mcp-client.js';
export * from './tools/mcp-tool.js';
export * from './tools/todo-store.js';

// PPT tools
export * from './tools/ppt/index.js';

// Session 处理
export {
  OttoSessionManager,
  getSessionManager,
} from './sessions/index.js';
export type {
  SessionMeta,
  SessionStatus,
  SplitStrategy,
  MergeStrategy as MergeSessionStrategy,
  SessionRoutingRule,
  ContextBridge,
  SessionManagerConfig,
} from './sessions/index.js';

// 任务插入引擎
export * from './insertion/index.js';

// 记忆自动合并分割
export type {
  MemoryEntry,
  MergeSuggestion,
  SplitSuggestion,
  MemoryCompressionResult,
  MemoryStats,
  AutoMemoryEngineConfig,
} from './memory/autoMerge.js';
export {
  AutoMemoryEngine,
  getAutoMemoryEngine,
} from './memory/autoMerge.js';

// Otto Enterprise 能力工具
export * from './tools/desktop-automation.js';
export * from './tools/convert-document.js';
export * from './tools/generate-document.js';
export * from './tools/analyze-data.js';
export * from './tools/diagnose-system.js';
export * from './tools/web-automation.js';
export * from './tools/memory-manager.js';
export * from './orchestration/index.js';
export * from './tools/voice-bridge.js';
export * from './tools/doctor.js';

// 多渠道通知服务
export { NotificationService, getNotificationService } from './services/notificationService.js';
export type { NotificationRecord, NotificationPriority, NotificationChannel, EscalationPolicy, FeishuNotifySender, SmsNotifySender } from './services/notificationService.js';
export { AliyunSmsSender, createAliyunSmsFromEnv } from './services/aliyunSmsSender.js';
export type { AliyunSmsConfig, SmsSendResult } from './services/aliyunSmsSender.js';

// 个人知识库（本地，无企业授权可用）
export * from './tools/knowledge-base.js';
export * from './knowledge/localKnowledgeStore.js';
export * from './knowledge/knowledgeCapture.js';

// MCP OAuth
export { MCPOAuthProvider } from './mcp/oauth-provider.js';
export {
  MCPOAuthToken,
  MCPOAuthCredentials,
  MCPOAuthTokenStorage,
} from './mcp/oauth-token-storage.js';
export type { MCPOAuthConfig } from './mcp/oauth-provider.js';
export type {
  OAuthAuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from './mcp/oauth-utils.js';
export { OAuthUtils } from './mcp/oauth-utils.js';

// Export telemetry functions
export * from './telemetry/index.js';
export { sessionId, getSessionId, setSessionId, resetSessionId } from './utils/session.js';
export * from './utils/browser.js';

// Export skills system (consolidated from cli package)
export * from './skills/index.js';

// Export ACP-facing command helpers
export * as AcpCommands from './commands/index.js';
