/**
 * Orchestration 模块统一导出。
 *
 * 包含：
 * - LangGraph 任务编排状态机
 * - OR-Tools 任务分配优化
 * - 多 Agent 协作网络
 * - 主动服务引擎
 * - 离职交接/岗位传承
 */

// LangGraph 任务编排
export {
  buildTaskOrchestrationGraph,
  startTaskOrchestration,
  submitReview,
} from './taskOrchestrator.js';
export type {
  TaskDefinition,
  TaskStatus,
  TaskPriority,
  AllocationSuggestion,
  EmployeeProfile,
  TaskExecutionResult,
  ReviewResult,
} from './taskOrchestrator.js';

// OR-Tools 优化
export { optimizeAllocation, checkOrToolsHealth, dualLayerAllocate } from './ortoolsClient.js';

// 多 Agent 协作
export {
  MultiAgentCollaboration,
  getCollaborationManager,
  initCollaboration,
} from './multiAgent.js';
export type { CollaborationRequest, CollaborationResponse, AgentRegistration } from './multiAgent.js';

// 主动服务
export { ProactiveService, getProactiveService } from './proactiveService.js';
export type { ProactiveRule, ProactiveContext } from './proactiveService.js';

// 离职交接
export { exportMemoryPackage, importMemoryPackage } from './knowledgeTransfer.js';
export type { MemoryPackage } from './knowledgeTransfer.js';

// 工作日志
export { WorkLogger, getWorkLogger, inferCategory, describeAction } from './workLog.js';
export type { WorkLogEntry, DailySummary, WeeklyReport, LogCategory } from './workLog.js';

// 自动 Skill 生成
export { detectPatterns, generateSkillCandidates, confirmAndSaveSkill, rejectSkill, generateSkillContent } from './autoSkillGenerator.js';
export type { SkillCandidate } from './autoSkillGenerator.js';
