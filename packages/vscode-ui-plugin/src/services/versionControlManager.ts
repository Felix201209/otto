/**
 * Version Control Manager
 * 版本控制管理器
 *
 * 协调SessionManager和VersionControlService，
 * 管理多个会话的版本控制实例
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { VersionControlService } from './versionControlService';
import { SessionMessage } from '../types/sessionTypes';
import { ToolCall } from '../types/messages';
import {
  EditOperation,
  RevertOptions,
  RevertResult,
  TimelineItem,
  TurnVersionMetadata,
  VersionNode
} from '../types/versionControl';

/**
 * 版本控制管理器
 */
export class VersionControlManager {
  // 每个session对应一个VersionControlService实例
  private readonly versionServices = new Map<string, VersionControlService>();

  // 存储路径
  private readonly storagePath: string;

  // 工作区根目录
  private readonly workspaceRoot: string;

  constructor(
    private readonly logger: Logger,
    private readonly extensionContext: vscode.ExtensionContext
  ) {
    this.storagePath = extensionContext.globalStoragePath;
    this.workspaceRoot = this.getWorkspaceRoot();

    // 确保存储目录存在
    vscode.workspace.fs.createDirectory(vscode.Uri.file(this.storagePath));

    this.logger.info('📋 Version Control Manager initialized');
  }

  /**
   * 获取VSCode工作区根目录
   */
  private getWorkspaceRoot(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      return workspaceFolder.uri.fsPath;
    }

    if (vscode.workspace.rootPath) {
      return vscode.workspace.rootPath;
    }

    return process.cwd();
  }

  // =============================================================================
  // Session级别的版本控制服务管理
  // =============================================================================

  /**
   * 获取或创建指定session的版本控制服务
   */
  private getOrCreateVersionService(sessionId: string): VersionControlService {
    let service = this.versionServices.get(sessionId);

    if (!service) {
      const sessionStoragePath = path.join(this.storagePath, 'versions', sessionId);
      service = new VersionControlService(
        this.logger,
        sessionId,
        this.workspaceRoot,
        sessionStoragePath
      );

      this.versionServices.set(sessionId, service);
      this.logger.info(`✨ Created version control service for session: ${sessionId}`);
    }

    return service;
  }

  /**
   * 移除指定session的版本控制服务
   */
  removeVersionService(sessionId: string): void {
    const service = this.versionServices.get(sessionId);
    if (service) {
      service.dispose();
      this.versionServices.delete(sessionId);
      this.logger.info(`🗑️ Removed version control service for session: ${sessionId}`);
    }
  }

  // =============================================================================
  // 生命周期挂点接口（由SessionManager/AIService调用）
  // =============================================================================

  /**
   * A. 建议已生成 - 开始记录回合
   */
  async beginTurn(sessionId: string, turnId: string, meta: any): Promise<void> {
    const service = this.getOrCreateVersionService(sessionId);
    await service.beginTurn(turnId, meta);
  }

  /**
   * B. 用户点击'应用' - 记录编辑操作并生成版本节点
   *
   * @param sessionId 会话ID
   * @param turnId 回合ID（通常是对应的消息ID）
   * @param toolCalls 工具调用列表
   * @param description 版本描述
   * @returns 新创建的版本节点ID
   */
  async recordAppliedChanges(
    sessionId: string,
    turnId: string,
    toolCalls: ToolCall[],
    description?: string
  ): Promise<string | null> {
    try {
      // 🎯 参数验证：防止无效的sessionId或turnId
      if (!sessionId || !turnId) {
        this.logger.error(`❌ recordAppliedChanges: Invalid parameters - sessionId: ${sessionId}, turnId: ${turnId}, toolCount: ${toolCalls.length}`);
        return null;
      }

      const service = this.getOrCreateVersionService(sessionId);

      this.logger.info(`📌 recordAppliedChanges START - sessionId: ${sessionId}, turnId: ${turnId}, toolCount: ${toolCalls.length}, description: ${description}`);

      // 从工具调用计算编辑操作
      const ops = await service.computeOps(turnId, toolCalls);
      this.logger.info(`📊 Computed ${ops.length} operations from ${toolCalls.length} tool calls for turn: ${turnId}`);

      // 🎯 关键修复：即使没有具体的操作，也必须创建版本节点（用于回退点）
      // 这确保了每个用户消息都有对应的版本节点，即使没有文件修改
      if (ops.length === 0 && toolCalls.length > 0) {
        this.logger.info(`⚠️ No operations computed, creating ${toolCalls.length} placeholder operations for fallback`);
        // 为每个工具创建一个占位操作
        for (const tool of toolCalls) {
          const placeholderOp: any = {
            opId: `op-${Date.now()}-${Math.random()}`,
            fileUri: `(${tool.toolName})`,
            baseHash: '',
            resultHash: '',
            patch: `Tool: ${tool.toolName}`,
            inversePatch: `Revert: ${tool.toolName}`,
            hunks: [],
            stats: { linesAdded: 0, linesRemoved: 0 },
            operationType: 'modify',
            createdAt: Date.now()
          };
          ops.push(placeholderOp);
        }
      }

      if (ops.length === 0) {
        this.logger.debug(`❌ No operations to record for turn: ${turnId}`);
        return null;
      }

      // 批量应用操作并生成版本节点
      const nodeId = await service.applyOpsAsBatch(turnId, ops, description);

      // 🎯 验证版本节点是否被正确创建并存储
      const createdNode = service.getNode(nodeId);
      if (createdNode) {
        this.logger.info(`✅ recordAppliedChanges COMPLETE - node: ${nodeId}, turnRefs: ${JSON.stringify(createdNode.turnRefs)}, opCount: ${createdNode.ops.length}`);
      } else {
        const error = new Error(`VERSION NODE CREATION FAILED: Node ${nodeId} not found in service`);
        this.logger.error(`❌ ${error.message}`, error);
      }

      return nodeId;

    } catch (error) {
      this.logger.error('❌ recordAppliedChanges FAILED:', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * C. 手动编辑检测
   * 当检测到用户手动编辑时调用
   */
  async recordManualEdit(
    sessionId: string,
    fileUri: string,
    originalContent: string,
    newContent: string
  ): Promise<void> {
    // 可选实现：记录手动编辑为特殊的版本节点
    this.logger.debug(`Manual edit detected in session ${sessionId}: ${fileUri}`);
  }

  // =============================================================================
  // 回退命令接口
  // =============================================================================

  /**
   * 回退到上一回合
   */
  async revertPrevious(
    sessionId: string,
    options?: RevertOptions
  ): Promise<RevertResult> {
    try {
      const service = this.getOrCreateVersionService(sessionId);
      const result = await service.revertPrevious(options);

      this.logger.info(`📍 Revert previous completed for session: ${sessionId}`, result);
      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to revert previous:', error instanceof Error ? error : undefined);

      return {
        success: false,
        revertedFiles: [],
        conflictFiles: [],
        error: errorMsg,
        executionTime: 0
      };
    }
  }

  /**
   * 回退到指定回合
   *
   * @param sessionId 会话ID
   * @param turnId 目标回合ID（消息ID）
   * @param options 回退选项
   */
  async revertToTurn(
    sessionId: string,
    turnId: string,
    options?: RevertOptions
  ): Promise<RevertResult> {
    try {
      const service = this.getOrCreateVersionService(sessionId);

      this.logger.info(`🔄 Starting revert to turn: ${turnId} in session: ${sessionId}`);

      // 通过turnId找到对应的版本节点
      const node = this.findNodeByTurnId(service, turnId);
      if (!node) {
        const availableNodes = service.getAllNodes();
        const allTurnRefs = availableNodes.flatMap(n => n.turnRefs);

        const errorMsg = `Version node not found for turn: ${turnId}. Available nodes: ${availableNodes.length}, Available turnRefs: ${allTurnRefs.join(', ') || '(none)'}`;

        const diagnosticDetails = availableNodes.map(n =>
          `[${n.nodeId}] turnRefs=${n.turnRefs.join(',')} ops=${n.ops.length} type=${n.nodeType}`
        ).join(' | ');

        this.logger.error(`❌ ${errorMsg}`);
        this.logger.error(`Diagnostic: ${diagnosticDetails}`);

        return {
          success: false,
          revertedFiles: [],
          conflictFiles: [],
          error: errorMsg,
          executionTime: 0
        };
      }

      this.logger.info(`✅ Located version node: ${node.nodeId}, nodeType: ${node.nodeType}, ops: ${node.ops.length}, executing revert...`);
      const result = await service.revertTo(node.nodeId, options);

      if (result.success) {
        this.logger.info(`✅ Revert to turn completed successfully - session: ${sessionId}, turn: ${turnId}, revertedFiles: ${result.revertedFiles.length}, newNodeId: ${result.newNodeId}, executionTime: ${result.executionTime}ms`);
      } else {
        this.logger.error(`❌ Revert to turn failed - session: ${sessionId}, turn: ${turnId}, error: ${result.error}, revertedFiles: ${result.revertedFiles.length}, executionTime: ${result.executionTime}ms`);
      }

      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('❌ revertToTurn caught exception:', error instanceof Error ? error : undefined);

      return {
        success: false,
        revertedFiles: [],
        conflictFiles: [],
        error: errorMsg,
        executionTime: 0
      };
    }
  }

  /**
   * 回退到指定版本节点
   *
   * @param sessionId 会话ID
   * @param nodeId 版本节点ID
   * @param options 回退选项
   */
  async revertTo(
    sessionId: string,
    nodeId: string,
    options?: RevertOptions
  ): Promise<RevertResult> {
    try {
      const service = this.getOrCreateVersionService(sessionId);
      const result = await service.revertTo(nodeId, options);

      this.logger.info(`📍 Revert to version completed for session: ${sessionId}, node: ${nodeId}`, result);
      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to revert to version:', error instanceof Error ? error : undefined);

      return {
        success: false,
        revertedFiles: [],
        conflictFiles: [],
        error: errorMsg,
        executionTime: 0
      };
    }
  }

  /**
   * 局部回滚（按文件或按补丁块）
   */
  async partialRevert(
    sessionId: string,
    nodeId: string,
    options: RevertOptions
  ): Promise<RevertResult> {
    try {
      const service = this.getOrCreateVersionService(sessionId);
      const result = await service.revertTo(nodeId, options);

      this.logger.info(`📍 Partial revert completed for session: ${sessionId}`, result);
      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to partial revert:', error instanceof Error ? error : undefined);

      return {
        success: false,
        revertedFiles: [],
        conflictFiles: [],
        error: errorMsg,
        executionTime: 0
      };
    }
  }

  // =============================================================================
  // 查询接口
  // =============================================================================

  /**
   * 获取指定session的时间线
   */
  getTimeline(sessionId: string): TimelineItem[] {
    const service = this.versionServices.get(sessionId);
    if (!service) {
      return [];
    }

    return service.getTimeline();
  }

  /**
   * 获取Turn的版本元数据
   */
  getTurnMetadata(sessionId: string, nodeId: string): TurnVersionMetadata | null {
    const service = this.versionServices.get(sessionId);
    if (!service) {
      return null;
    }

    return service.getTurnMetadata(nodeId);
  }

  /**
   * 获取当前版本节点ID
   */
  getCurrentNodeId(sessionId: string): string | null {
    const service = this.versionServices.get(sessionId);
    return service?.getCurrentNodeId() || null;
  }

  /**
   * 获取版本节点详情
   */
  getNodeDetails(sessionId: string, nodeId: string): VersionNode | null {
    const service = this.versionServices.get(sessionId);
    return service?.getNode(nodeId) || null;
  }

  /**
   * 获取可回滚的消息ID列表
   *
   * @param sessionId 会话ID
   * @returns 可回滚的消息ID列表
   */
  getRollbackableMessageIds(sessionId: string): string[] {
    const service = this.versionServices.get(sessionId);
    if (!service) {
      this.logger.debug(`No version service found for session: ${sessionId}`);
      return [];
    }

    const nodes = service.getAllNodes();
    const messageIds: string[] = [];

    // 🎯 收集所有有 turnRefs 的节点
    // 不再要求必须有 ops，因为我们简化了版本控制
    for (const node of nodes) {
      if (node.turnRefs && node.turnRefs.length > 0) {
        messageIds.push(...node.turnRefs);
      }
    }

    this.logger.info(`📋 Found ${messageIds.length} rollbackable message IDs from ${nodes.length} nodes:`, {
      messageIds: messageIds.slice(0, 5), // 只显示前5个用于调试
      totalCount: messageIds.length,
      nodeDetails: nodes.map(n => ({ nodeId: n.nodeId, turnRefs: n.turnRefs }))
    });

    // 去重并排序
    return [...new Set(messageIds)].sort();
  }

  /**
   * 检查指定消息是否可以回退
   *
   * 🎯 实现 Cursor 风格的回退限制：
   * - 每条消息仅允许回退一次
   * - 回退后，该消息及之后的所有消息均不可再回退
   *
   * @param sessionId 会话ID
   * @param turnId 消息ID
   * @returns { canRevert: boolean, reason?: string }
   */
  canRevertMessage(sessionId: string, turnId: string): { canRevert: boolean; reason?: string } {
    const service = this.versionServices.get(sessionId);
    if (!service) {
      return { canRevert: false, reason: 'No version service found' };
    }

    // 通过 turnId 找到对应的版本节点
    const node = this.findNodeByTurnId(service, turnId);
    if (!node) {
      return { canRevert: false, reason: 'Message version not found' };
    }

    // 检查是否已被回退
    if (node.hasBeenReverted) {
      return {
        canRevert: false,
        reason: 'This message has already been reverted once (single revert limit)'
      };
    }

    // 检查是否被锁定
    if (node.isLocked) {
      return {
        canRevert: false,
        reason: 'This message cannot be reverted - locked after a previous revert'
      };
    }

    // 可以回退
    return { canRevert: true };
  }

  /**
   * 获取消息的回退状态信息
   *
   * @param sessionId 会话ID
   * @param turnId 消息ID
   * @returns 回退状态对象
   */
  getMessageRevertStatus(
    sessionId: string,
    turnId: string
  ): {
    canRevert: boolean;
    hasBeenReverted: boolean;
    isLocked: boolean;
    reason?: string;
  } {
    const service = this.versionServices.get(sessionId);
    if (!service) {
      return { canRevert: false, hasBeenReverted: false, isLocked: false, reason: 'No version service' };
    }

    const node = this.findNodeByTurnId(service, turnId);
    if (!node) {
      return { canRevert: false, hasBeenReverted: false, isLocked: false, reason: 'Message not found' };
    }

    const canRevertCheck = this.canRevertMessage(sessionId, turnId);

    return {
      canRevert: canRevertCheck.canRevert,
      hasBeenReverted: node.hasBeenReverted || false,
      isLocked: node.isLocked || false,
      reason: canRevertCheck.reason
    };
  }

  // =============================================================================
  // 辅助方法
  // =============================================================================

  /**
   * 通过turnId查找版本节点
   */
  private findNodeByTurnId(service: VersionControlService, turnId: string): VersionNode | null {
    this.logger.info(`🔍 findNodeByTurnId: Searching for turnId: ${turnId}`);

    // 使用service提供的方法进行查找
    const node = service.findNodeByTurnRef(turnId);

    if (node) {
      this.logger.info(`✅ Found version node: ${node.nodeId} for turnId: ${turnId}`);
      return node;
    }

    // 诊断：列出所有可用的节点信息
    const nodes = service.getAllNodes();
    const allTurnRefs = nodes.flatMap(node => node.turnRefs);

    // 🎯 改进诊断：寻找可能的匹配
    const possibleMatches = nodes.filter(n =>
      n.turnRefs.some(ref =>
        ref.includes(turnId) ||
        turnId.includes(ref) ||
        (ref.startsWith('user-') && turnId.startsWith('user-') && ref.split('-')[1] === turnId.split('-')[1])
      )
    );

    this.logger.error(`❌ Version node not found for turnId: ${turnId}`);
    this.logger.error(`   Exact match: FAILED, Total nodes: ${nodes.length}, Available turnRefs count: ${allTurnRefs.length}`);
    this.logger.error(`   Available turnRefs: ${allTurnRefs.join(', ')}`);

    if (possibleMatches.length > 0) {
      const possibleMatchesStr = possibleMatches.map(n => `[${n.nodeId}]:${n.turnRefs.join(',')}`).join(' ');
      this.logger.error(`   ⚠️ Found ${possibleMatches.length} POSSIBLE MATCHES: ${possibleMatchesStr}`);
    }

    const nodeDetailsStr = nodes.map(n =>
      `[${n.nodeId}] turnRefs=${n.turnRefs.join(',')} ops=${n.ops.length} type=${n.nodeType} created=${new Date(n.createdAt).toISOString()}`
    ).join(' | ');
    this.logger.error(`   Detailed node info: ${nodeDetailsStr}`);

    return null;
  }

  /**
   * 清理所有版本控制服务
   */
  dispose(): void {
    for (const [sessionId, service] of this.versionServices) {
      service.dispose();
      this.logger.debug(`Disposed version service for session: ${sessionId}`);
    }

    this.versionServices.clear();
    this.logger.info('🔄 Version Control Manager disposed');
  }
}
