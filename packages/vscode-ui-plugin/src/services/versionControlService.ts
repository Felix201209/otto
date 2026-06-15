/**
 * Version Control Service
 * 版本控制核心服务
 *
 * 负责管理对话级别的代码变更版本控制，实现类似Cursor的回退功能
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Logger } from '../utils/logger';
import {
  EditOperation,
  VersionNode,
  Snapshot,
  VersionControlState,
  RevertOptions,
  RevertResult,
  ConflictInfo,
  VersionPath,
  VersionPathStep,
  SnapshotPolicy,
  PatchHunk,
  TimelineItem,
  TurnVersionMetadata,
  FileImpact
} from '../types/versionControl';
import { SessionMessage } from '../types/sessionTypes';
import { ToolCall } from '../types/messages';

/**
 * 版本控制服务
 */
export class VersionControlService {
  private readonly state: VersionControlState = {
    currentNodeId: null,
    nodes: new Map(),
    snapshots: new Map(),
    rootNodeId: null,
    isOperating: false
  };

  private readonly snapshotPolicy: SnapshotPolicy = {
    patchSizeThreshold: 1024 * 1024, // 1MB
    fileCountThreshold: 10,
    timeIntervalThreshold: 15 * 60 * 1000, // 15分钟
    autoSnapshot: true
  };

  // 快照存储路径
  private snapshotStoragePath: string;

  // 最后一次快照时间
  private lastSnapshotTime = 0;

  // 累计补丁大小
  private accumulatedPatchSize = 0;

  constructor(
    private readonly logger: Logger,
    private readonly sessionId: string,
    private readonly workspaceRoot: string,
    storagePath: string
  ) {
    this.snapshotStoragePath = storagePath;
    this.logger.info(`📋 Version Control Service initialized for session: ${sessionId}`);
  }

  // =============================================================================
  // 核心API：生命周期挂点
  // =============================================================================

  /**
   * 开始记录回合上下文
   */
  async beginTurn(turnId: string, meta: any): Promise<void> {
    this.logger.debug(`📝 Begin turn: ${turnId}`, meta);
  }

  /**
   * 从对话消息和工具调用计算编辑操作
   */
  async computeOps(turnId: string, toolCalls: ToolCall[]): Promise<EditOperation[]> {
    const operations: EditOperation[] = [];

    for (const toolCall of toolCalls) {
      // 🎯 为文件修改工具创建模拟的编辑操作
      const op = await this.createEditOperationFromToolCall(toolCall);
      if (op) {
        operations.push(op);
      }
    }

    this.logger.info(`📊 Computed ${operations.length} edit operations for turn: ${turnId}`);
    return operations;
  }

  /**
   * 批量应用编辑操作并生成版本节点
   */
  async applyOpsAsBatch(
    turnId: string,
    ops: EditOperation[],
    description?: string
  ): Promise<string> {
    try {
      this.state.isOperating = true;

      this.logger.info(`🎯 applyOpsAsBatch START - turnId: ${turnId}, opsCount: ${ops.length}, description: ${description}, currentNodeId: ${this.state.currentNodeId}`);

      // 创建新的版本节点
      const newNode = this.createVersionNode(
        this.state.currentNodeId,
        [turnId],  // 记录关联的turnId以便后续回退查找
        ops,
        'ai_edit',
        description
      );

      this.logger.info(`📝 Created new version node - nodeId: ${newNode.nodeId}, parentId: ${newNode.parentId}, turnRefs: ${newNode.turnRefs.join(',')}, opCount: ${newNode.ops.length}`);

      // 将节点添加到状态树
      this.state.nodes.set(newNode.nodeId, newNode);
      this.logger.info(`📊 Node added to state.nodes - newNodeId: ${newNode.nodeId}, totalNodesAfterAdd: ${this.state.nodes.size}`);

      // 更新父节点的子节点列表
      if (this.state.currentNodeId) {
        const parentNode = this.state.nodes.get(this.state.currentNodeId);
        if (parentNode) {
          if (!parentNode.childrenIds.includes(newNode.nodeId)) {
            parentNode.childrenIds.push(newNode.nodeId);
            this.logger.info(`🔗 Updated parent node - parentNodeId: ${this.state.currentNodeId}, childNodeId: ${newNode.nodeId}, totalChildren: ${parentNode.childrenIds.length}`);
          } else {
            this.logger.warn(`⚠️ Child node already exists in parent's children list`);
          }
        } else {
          const err = new Error(`Parent node not found in state - expectedParentId: ${this.state.currentNodeId}`);
          this.logger.error(`❌ ${err.message}`, err);
        }
      } else {
        // 如果没有父节点，这是根节点
        if (!this.state.rootNodeId) {
          this.state.rootNodeId = newNode.nodeId;
          this.logger.info(`🌳 Set root node - rootNodeId: ${newNode.nodeId}`);
        } else {
          this.logger.warn(`⚠️ Root node already exists but current node is null - existingRootId: ${this.state.rootNodeId}`);
        }
      }

      // 移动游标到新节点
      const previousNodeId = this.state.currentNodeId;
      this.state.currentNodeId = newNode.nodeId;
      this.logger.info(`➡️ Moved current node pointer - fromNodeId: ${previousNodeId}, toNodeId: ${newNode.nodeId}`);

      // 累计补丁大小
      const patchSize = ops.reduce((sum, op) => sum + op.patch.length, 0);
      this.accumulatedPatchSize += patchSize;
      this.logger.debug(`📈 Accumulated patch size: ${this.accumulatedPatchSize} bytes`);

      // 检查是否需要拍快照
      if (this.snapshotPolicy.autoSnapshot) {
        const snapshotId = await this.ensureSnapshot();
        if (snapshotId) {
          this.logger.info(`📸 Snapshot created - snapshotId: ${snapshotId}, nodeId: ${newNode.nodeId}`);
        }
      }

      // 验证节点被正确存储
      const storedNode = this.state.nodes.get(newNode.nodeId);
      if (!storedNode) {
        const err = new Error(`Node ${newNode.nodeId} not found after adding to state`);
        this.logger.error(`❌ CRITICAL: ${err.message}`, err);
        throw err;
      }

      this.logger.info(`✅ applyOpsAsBatch COMPLETE - nodeId: ${newNode.nodeId}, turnRefs: ${newNode.turnRefs.join(',')}, totalNodesAfterComplete: ${this.state.nodes.size}, currentNodeId: ${this.state.currentNodeId}`);

      return newNode.nodeId;

    } catch (error) {
      this.logger.error(`❌ applyOpsAsBatch FAILED:`, error instanceof Error ? error : undefined);
      this.state.isOperating = false;
      throw error;
    } finally {
      if (this.state.isOperating) {
        this.state.isOperating = false;
      }
    }
  }

  /**
   * 回退到目标节点
   *
   * 🎯 改进：检查回退限制（每条消息仅允许回退一次）
   */
  async revertTo(
    targetNodeId: string,
    options: RevertOptions = { scope: 'workspace' }
  ): Promise<RevertResult> {
    const startTime = Date.now();

    try {
      this.state.isOperating = true;

      this.logger.info(`🎯 revertTo START - target: ${targetNodeId}, current: ${this.state.currentNodeId}`);

      // 验证目标节点存在
      const targetNode = this.state.nodes.get(targetNodeId);
      if (!targetNode) {
        const allNodes = Array.from(this.state.nodes.entries());
        const diagnosticMsg = `Target version node not found: ${targetNodeId}. Available nodes: ${allNodes.map(([id]) => id).join(', ') || 'none'}`;
        this.logger.error(`❌ ${diagnosticMsg}`);
        throw new Error(diagnosticMsg);
      }

      this.logger.info(`✅ Found target node - targetNodeId: ${targetNodeId}, nodeType: ${targetNode.nodeType}, ops: ${targetNode.ops.length}`);

      // 🎯 检查回退限制：该节点是否已被回退过？
      if (targetNode.hasBeenReverted) {
        const errorMsg = `Cannot revert to this message - it has already been reverted once. (Cursor-style single revert limit)`;
        this.logger.warn(`⚠️ ${errorMsg}`);
        return {
          success: false,
          revertedFiles: [],
          conflictFiles: [],
          error: errorMsg,
          executionTime: 0
        };
      }

      // 🎯 检查是否被锁定：该节点及之后的节点是否被锁定？
      if (targetNode.isLocked) {
        const errorMsg = `Cannot revert to this message - it has been locked after a previous revert.`;
        this.logger.warn(`⚠️ ${errorMsg}`);
        return {
          success: false,
          revertedFiles: [],
          conflictFiles: [],
          error: errorMsg,
          executionTime: 0
        };
      }

      // 如果当前节点ID不存在，设置为根节点ID
      if (!this.state.currentNodeId) {
        this.logger.warn(`⚠️ No current node set, initializing to root or target`);
        this.state.currentNodeId = this.state.rootNodeId || targetNodeId;
      }

      // 计算从当前节点到目标节点的路径
      const path = this.findPath(this.state.currentNodeId!, targetNodeId);
      this.logger.info(`📍 Computed revert path - steps: ${path.steps.length}, direction: ${path.isForward ? 'forward' : 'backward'}`);

      // 执行回退
      const result = await this.executePath(path, options);

      // 如果成功，更新当前节点指针并应用回退限制
      if (result.success && result.newNodeId) {
        this.state.currentNodeId = result.newNodeId;
        this.logger.info(`➡️ Updated current node to: ${result.newNodeId}`);

        // 🎯 应用回退限制：标记该节点已被回退
        targetNode.hasBeenReverted = true;
        targetNode.revertCount = (targetNode.revertCount || 0) + 1;
        targetNode.revertedAt = Date.now();
        this.logger.info(`🔒 Marked node ${targetNodeId} as reverted (count: ${targetNode.revertCount})`);

        // 🎯 锁定该节点及所有后续节点
        this.lockNodeAndDescendants(targetNodeId);
      } else {
        this.logger.warn(`⚠️ Revert failed, current node unchanged`);
      }

      result.executionTime = Date.now() - startTime;
      this.logger.info(`✅ revertTo COMPLETE - executionTime: ${result.executionTime}ms, success: ${result.success}`);

      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('❌ revertTo failed:', error instanceof Error ? error : undefined);

      return {
        success: false,
        revertedFiles: [],
        conflictFiles: [],
        error: errorMsg,
        executionTime: Date.now() - startTime
      };

    } finally {
      this.state.isOperating = false;
    }
  }

  /**
   * 回退到上一个版本
   */
  async revertPrevious(options?: RevertOptions): Promise<RevertResult> {
    try {
      if (!this.state.currentNodeId) {
        const errorMsg = 'No current version node - no changes have been applied yet';
        this.logger.warn(`⚠️ ${errorMsg}`);
        return {
          success: false,
          revertedFiles: [],
          conflictFiles: [],
          error: errorMsg,
          executionTime: 0
        };
      }

      const currentNode = this.state.nodes.get(this.state.currentNodeId);
      if (!currentNode) {
        const errorMsg = `Current node not found: ${this.state.currentNodeId}`;
        this.logger.error(`❌ ${errorMsg}`);
        return {
          success: false,
          revertedFiles: [],
          conflictFiles: [],
          error: errorMsg,
          executionTime: 0
        };
      }

      if (!currentNode.parentId) {
        const errorMsg = 'Already at root version, cannot revert further';
        this.logger.warn(`⚠️ ${errorMsg}`);
        return {
          success: false,
          revertedFiles: [],
          conflictFiles: [],
          error: errorMsg,
          executionTime: 0
        };
      }

      this.logger.info(`⏮️ Reverting from node: ${this.state.currentNodeId} to parent: ${currentNode.parentId}`);
      return this.revertTo(currentNode.parentId, options);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('❌ revertPrevious failed:', error instanceof Error ? error : undefined);
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
  // 快照管理
  // =============================================================================

  /**
   * 根据策略确保拍摄快照
   */
  async ensureSnapshot(): Promise<string | null> {
    const now = Date.now();
    const timeSinceLastSnapshot = now - this.lastSnapshotTime;
    const currentNode = this.state.currentNodeId
      ? this.state.nodes.get(this.state.currentNodeId)
      : null;

    const fileCount = currentNode?.ops.length || 0;

    // 检查是否满足快照条件
    const shouldSnapshot =
      this.accumulatedPatchSize >= this.snapshotPolicy.patchSizeThreshold ||
      fileCount >= this.snapshotPolicy.fileCountThreshold ||
      timeSinceLastSnapshot >= this.snapshotPolicy.timeIntervalThreshold;

    if (!shouldSnapshot) {
      return null;
    }

    return this.createSnapshot();
  }

  /**
   * 创建快照
   */
  private async createSnapshot(): Promise<string> {
    try {
      if (!this.state.currentNodeId) {
        throw new Error('No current version node for snapshot');
      }

      const snapshotId = this.generateId('snap');
      const currentNode = this.state.nodes.get(this.state.currentNodeId)!;

      // 收集所有涉及的文件
      const files = currentNode.ops.map(op => op.fileUri);

      // 创建快照数据（简化版：只记录文件hash）
      const snapshotData: Record<string, string> = {};
      for (const op of currentNode.ops) {
        snapshotData[op.fileUri] = op.resultHash;
      }

      // 保存快照数据到blob
      const blobRef = await this.saveBlobData(snapshotId, snapshotData);

      const snapshot: Snapshot = {
        snapshotId,
        baseNodeId: this.state.currentNodeId,
        scope: 'files',
        files,
        blobRef,
        compressed: true,
        size: JSON.stringify(snapshotData).length,
        createdAt: Date.now()
      };

      this.state.snapshots.set(snapshotId, snapshot);

      // 更新节点的快照引用
      currentNode.snapshotId = snapshotId;

      // 重置累计状态
      this.accumulatedPatchSize = 0;
      this.lastSnapshotTime = Date.now();

      this.logger.info(`📸 Created snapshot: ${snapshotId} for node: ${this.state.currentNodeId}`);
      return snapshotId;

    } catch (error) {
      this.logger.error('Failed to create snapshot:', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  // =============================================================================
  // 路径计算和执行
  // =============================================================================

  /**
   * 计算从当前节点到目标节点的路径
   */
  findPath(currentNodeId: string, targetNodeId: string): VersionPath {
    if (currentNodeId === targetNodeId) {
      return {
        fromNodeId: currentNodeId,
        toNodeId: targetNodeId,
        steps: [],
        isForward: true
      };
    }

    // 找到共同祖先
    const currentAncestors = this.getAncestors(currentNodeId);
    const targetAncestors = this.getAncestors(targetNodeId);

    // 找到最近的共同祖先
    let commonAncestor: string | null = null;
    for (const ancestor of currentAncestors) {
      if (targetAncestors.includes(ancestor)) {
        commonAncestor = ancestor;
        break;
      }
    }

    if (!commonAncestor) {
      throw new Error('Cannot find path between versions (different branches)');
    }

    // 构建路径：current -> common ancestor (backward) -> target (forward)
    const steps: VersionPathStep[] = [];

    // 第一段：从当前节点回退到共同祖先
    let node = currentNodeId;
    while (node !== commonAncestor) {
      const currentNode = this.state.nodes.get(node);
      if (!currentNode?.parentId) break;

      steps.push({
        nodeId: node,
        direction: 'backward',
        operations: currentNode.ops
      });

      node = currentNode.parentId;
    }

    // 第二段：从共同祖先前进到目标
    const forwardPath: VersionPathStep[] = [];
    node = targetNodeId;
    while (node !== commonAncestor) {
      const currentNode = this.state.nodes.get(node);
      if (!currentNode?.parentId) break;

      forwardPath.unshift({
        nodeId: currentNode.parentId,
        direction: 'forward',
        operations: currentNode.ops
      });

      node = currentNode.parentId;
    }

    steps.push(...forwardPath);

    return {
      fromNodeId: currentNodeId,
      toNodeId: targetNodeId,
      steps,
      isForward: forwardPath.length > steps.length - forwardPath.length
    };
  }

  /**
   * 执行路径回放
   */
  private async executePath(
    path: VersionPath,
    options: RevertOptions
  ): Promise<RevertResult> {
    const revertedFiles: Set<string> = new Set();
    const conflictFiles: ConflictInfo[] = [];

    try {
      // 🎯 验证路径有效性
      if (path.steps.length === 0) {
        this.logger.info(`📊 No steps in path from ${path.fromNodeId} to ${path.toNodeId}, treating as no-op`);

        // 即使没有步骤，也应该成功并更新当前节点
        const revertNode = this.createVersionNode(
          path.toNodeId,
          [],
          [],
          'revert',
          `Reverted to ${path.toNodeId}`
        );
        this.state.nodes.set(revertNode.nodeId, revertNode);

        return {
          success: true,
          newNodeId: revertNode.nodeId,
          revertedFiles: [],
          conflictFiles,
          executionTime: 0
        };
      }

      // 🎯 收集所有需要回退的文件和操作映射
      const fileOperations = new Map<string, EditOperation>();
      const allOperations: EditOperation[] = [];

      for (const step of path.steps) {
        for (const op of step.operations) {
          if (op.fileUri) {
            fileOperations.set(op.fileUri, op);
            allOperations.push(op);
            revertedFiles.add(op.fileUri);
          }
        }
      }

      this.logger.info(`📂 Processing revert for ${revertedFiles.size} files with ${allOperations.length} total operations`);

      // 🎯 构建WorkspaceEdit并应用
      const edit = new vscode.WorkspaceEdit();
      const processedFiles: string[] = [];

      for (const [fileUri, operation] of fileOperations) {
        try {
          const uri = vscode.Uri.file(fileUri);
          const operationType = operation.operationType;

          this.logger.debug(`🔄 Processing ${operationType} operation for: ${fileUri}`);

          // 检查文件当前是否存在
          let fileExists = false;
          try {
            await vscode.workspace.fs.stat(uri);
            fileExists = true;
          } catch {
            fileExists = false;
          }

          // 根据操作类型和文件状态决定如何回退
          if (operationType === 'create') {
            // 创建操作的反向是删除
            if (fileExists) {
              edit.deleteFile(uri);
              this.logger.info(`🗑️ Deleting created file (revert): ${fileUri}`);
              processedFiles.push(fileUri);
            } else {
              this.logger.debug(`⏩ File already deleted (created file): ${fileUri}`);
              processedFiles.push(fileUri);
            }
          } else if (operationType === 'delete') {
            // 🎯 删除操作的反向是恢复 - 使用保存的 beforeContent（修改前是什么）
            if (operation.beforeContent !== undefined && operation.beforeContent !== null) {
              try {
                // 创建文件并写入原始内容
                edit.createFile(uri, { overwrite: true });
                edit.insert(uri, new vscode.Position(0, 0), operation.beforeContent);
                this.logger.info(`📝 Restoring deleted file: ${fileUri} (${operation.beforeContent.length} bytes)`);
                processedFiles.push(fileUri);
              } catch (restoreError) {
                this.logger.error(`Failed to restore deleted file ${fileUri}:`, restoreError instanceof Error ? restoreError : undefined);
              }
            } else {
              this.logger.warn(`⚠️ Cannot restore deleted file: ${fileUri} (no backup available)`);
            }
          } else if (operationType === 'modify') {
            // 🎯 修改操作的反向是使用 beforeContent 覆盖当前内容
            if (operation.beforeContent !== undefined && operation.beforeContent !== null) {
              try {
                // 打开文件并替换所有内容
                const document = await vscode.workspace.openTextDocument(uri);
                const fullRange = new vscode.Range(
                  new vscode.Position(0, 0),
                  new vscode.Position(document.lineCount, 0)
                );
                edit.replace(uri, fullRange, operation.beforeContent);
                this.logger.info(`♻️ Restoring modified file: ${fileUri} (${operation.beforeContent.length} bytes)`);
                processedFiles.push(fileUri);
              } catch (restoreError) {
                this.logger.error(`Failed to restore modified file ${fileUri}:`, restoreError instanceof Error ? restoreError : undefined);
              }
            } else {
              this.logger.warn(`⚠️ Cannot revert modifications: ${fileUri} (no backup content available)`);
            }
          }

        } catch (error) {
          this.logger.error(`Failed to process file ${fileUri}:`, error instanceof Error ? error : undefined);
          // 继续处理其他文件
        }
      }

      // 🎯 应用所有WorkspaceEdit操作
      if (edit.size > 0) {
        this.logger.info(`📝 Applying ${edit.size} file operations...`);
        const applySuccess = await vscode.workspace.applyEdit(edit);

        if (!applySuccess) {
          throw new Error('Failed to apply workspace file changes');
        }
        this.logger.info(`✅ File operations applied successfully`);
      } else {
        this.logger.info(`ℹ️ No file operations to apply for this revert`);
      }

      // 🎯 创建回退节点记录
      const revertNode = this.createVersionNode(
        path.toNodeId,
        [],
        allOperations,  // 记录执行的操作用于审计
        'revert',
        `Reverted to ${path.toNodeId}`
      );

      this.state.nodes.set(revertNode.nodeId, revertNode);
      this.logger.info(`📍 Created revert node: ${revertNode.nodeId}`);

      return {
        success: true,
        newNodeId: revertNode.nodeId,
        revertedFiles: Array.from(revertedFiles),
        conflictFiles,
        executionTime: 0
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('❌ executePath failed:', error instanceof Error ? error : undefined);

      return {
        success: false,
        newNodeId: undefined,
        revertedFiles: Array.from(revertedFiles),
        conflictFiles,
        error: errorMsg,
        executionTime: 0
      };
    }
  }

  /**
   * 将操作应用到WorkspaceEdit
   */
  private async applyOperationToEdit(
    op: EditOperation,
    edit: vscode.WorkspaceEdit,
    options: RevertOptions
  ): Promise<void> {
    const uri = vscode.Uri.file(op.fileUri);

    switch (op.operationType) {
      case 'create': {
        // 创建新文件
        const patch = this.parsePatch(op.patch);
        edit.createFile(uri, { overwrite: false });
        if (patch.newContent) {
          edit.insert(uri, new vscode.Position(0, 0), patch.newContent);
        }
        break;
      }

      case 'delete': {
        // 删除文件
        edit.deleteFile(uri);
        break;
      }

      case 'modify': {
        // 修改文件
        const patch = this.parsePatch(op.patch);
        const document = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(
          document.lineAt(0).range.start,
          document.lineAt(document.lineCount - 1).range.end
        );

        if (patch.newContent !== undefined) {
          edit.replace(uri, fullRange, patch.newContent);
        }
        break;
      }
    }
  }

  // =============================================================================
  // 冲突检测和合并
  // =============================================================================

  /**
   * 验证操作是否可以应用
   */
  private async validateOperation(op: EditOperation): Promise<{ valid: boolean; reason?: string }> {
    try {
      const uri = vscode.Uri.file(op.fileUri);

      // 检查文件是否存在
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const currentHash = this.computeHash(document.getText());

        // 检查hash是否匹配
        if (currentHash !== op.baseHash) {
          return {
            valid: false,
            reason: `File has been modified (expected hash: ${op.baseHash}, actual: ${currentHash})`
          };
        }

        return { valid: true };

      } catch (error) {
        // 文件不存在
        if (op.operationType === 'create') {
          return { valid: true };
        } else {
          return {
            valid: false,
            reason: 'File does not exist'
          };
        }
      }

    } catch (error) {
      return {
        valid: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 尝试自动合并冲突
   */
  private async attemptAutoMerge(op: EditOperation): Promise<{
    success: boolean;
    conflict?: ConflictInfo;
  }> {
    try {
      const uri = vscode.Uri.file(op.fileUri);
      const document = await vscode.workspace.openTextDocument(uri);
      const localContent = document.getText();

      const patch = this.parsePatch(op.patch);
      const baseContent = patch.originalContent || '';
      const changeContent = patch.newContent || '';

      // 简单的三方合并（实际应该使用更复杂的算法）
      const conflict: ConflictInfo = {
        filePath: op.fileUri,
        baseContent,
        localContent,
        changeContent,
        conflictRanges: [],
        requiresManualResolution: true
      };

      return {
        success: false,
        conflict
      };

    } catch (error) {
      this.logger.error('Auto merge failed:', error instanceof Error ? error : undefined);
      return { success: false };
    }
  }

  // =============================================================================
  // 工具方法
  // =============================================================================

  /**
   * 从工具调用创建编辑操作
   *
   * 🎯 关键改进：获取真实的文件内容快照用于回退
   */
  private async createEditOperationFromToolCall(toolCall: ToolCall): Promise<EditOperation | null> {
    try {
      const toolName = toolCall.toolName;
      const params = toolCall.parameters;

      this.logger.debug(`Processing tool for version control: ${toolName}`);

      const opId = this.generateId('op');

      // 从参数中提取文件路径
      let fileUri = params.file_path ||
                   params.target_file ||
                   params.fileName ||
                   params.path ||
                   params.filePath ||
                   params.file ||
                   params.filepath ||
                   params.target ||
                   '(tool operation)';

      // 根据工具类型确定操作类型
      let operationType: 'create' | 'modify' | 'delete' = 'modify';
      const toolNameLower = toolName.toLowerCase();

      if (toolNameLower.includes('write') ||
          toolNameLower.includes('create') ||
          toolNameLower === 'writefile') {
        operationType = 'create';
      } else if (toolNameLower.includes('delete') ||
                 toolNameLower.includes('remove')) {
        operationType = 'delete';
      } else if (toolNameLower.includes('edit') ||
                 toolNameLower.includes('replace') ||
                 toolNameLower.includes('modify') ||
                 toolNameLower.includes('fix')) {
        operationType = 'modify';
      }

      // 🎯 获取文件修改前的内容（用于回退）
      let beforeContent: string | undefined;
      let afterContent: string | undefined;

      try {
        const uri = vscode.Uri.file(fileUri);
        const document = await vscode.workspace.openTextDocument(uri);
        beforeContent = document.getText();
        this.logger.debug(`📖 Captured file before content for ${fileUri} (${beforeContent.length} bytes)`);
      } catch (readError) {
        // 文件不存在或无法读取 - 对于 create 操作是正常的
        this.logger.debug(`⏭️ File not yet exists or cannot be read: ${fileUri}`);
      }

      // 🎯 创建编辑操作，保存文件内容快照
      const operation: EditOperation = {
        opId,
        fileUri,
        baseHash: beforeContent ? this.computeHash(beforeContent) : this.generateId('hash'),
        resultHash: this.generateId('hash'),  // 修改后的 hash 在应用后会更新
        patch: `Tool: ${toolName}\nFile: ${fileUri}\nOperation: ${operationType}`,
        inversePatch: `Revert: ${toolName}\nFile: ${fileUri}\nOperation: ${operationType}`,
        hunks: [],
        stats: {
          linesAdded: 0,
          linesRemoved: 0
        },
        operationType,
        createdAt: Date.now(),

        // 🎯 关键：保存文件内容快照
        beforeContent,  // 修改前的内容
        afterContent    // 修改后的内容（会在 applyOpsAsBatch 后更新）
      };

      this.logger.info(`✅ Created operation - tool: ${toolName}, file: ${fileUri}, type: ${operationType}, beforeContent: ${beforeContent ? 'saved' : 'N/A'}`);
      return operation;

    } catch (error) {
      this.logger.error('Failed to create edit operation from tool call:', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * 创建版本节点
   *
   * 🎯 改进：初始化回退限制相关字段
   */
  private createVersionNode(
    parentId: string | null,
    turnRefs: string[],
    ops: EditOperation[],
    nodeType: VersionNode['nodeType'],
    description?: string
  ): VersionNode {
    const nodeId = this.generateId('node');

    return {
      nodeId,
      parentId,
      turnRefs,
      ops,
      nodeType,
      description,
      childrenIds: [],
      createdAt: Date.now(),

      // ==================== 新增：回退限制初始化 ====================
      /** 初始状态：未被回退 */
      revertCount: 0,
      /** 初始状态：未被回退 */
      hasBeenReverted: false,
      /** 初始状态：未锁定 */
      isLocked: false
    };
  }

  /**
   * 获取节点的所有祖先
   */
  private getAncestors(nodeId: string): string[] {
    const ancestors: string[] = [];
    let current: string | null = nodeId;

    while (current) {
      ancestors.push(current);
      const node = this.state.nodes.get(current);
      current = node?.parentId || null;
    }

    return ancestors;
  }

  /**
   * 锁定指定节点及其所有后续节点
   *
   * 🎯 实现 Cursor 风格的回退限制：当回退到某个节点时，
   * 该节点及之后的所有节点都被锁定，不允许再回退
   */
  private lockNodeAndDescendants(nodeId: string): void {
    const targetNode = this.state.nodes.get(nodeId);
    if (!targetNode) {
      this.logger.warn(`⚠️ Cannot lock node ${nodeId} - not found`);
      return;
    }

    // 使用队列进行广度优先遍历，锁定该节点及所有后续节点
    const queue: string[] = [nodeId];
    const locked: Set<string> = new Set();

    while (queue.length > 0) {
      const currentId = queue.shift()!;

      if (locked.has(currentId)) {
        continue;  // 跳过已处理的节点
      }

      const node = this.state.nodes.get(currentId);
      if (node) {
        // 锁定该节点
        node.isLocked = true;
        locked.add(currentId);

        // 将所有子节点加入队列
        for (const childId of node.childrenIds) {
          if (!locked.has(childId)) {
            queue.push(childId);
          }
        }

        this.logger.debug(`🔒 Locked node: ${currentId}`);
      }
    }

    this.logger.info(`🔒 Locked node ${nodeId} and ${locked.size - 1} descendants`);
  }

  /**
   * 反转操作（用于回退）
   */
  private invertOperation(op: EditOperation): EditOperation {
    return {
      ...op,
      opId: this.generateId('inv-op'),
      baseHash: op.resultHash,
      resultHash: op.baseHash,
      patch: op.inversePatch,
      inversePatch: op.patch,
      stats: {
        linesAdded: op.stats.linesRemoved,
        linesRemoved: op.stats.linesAdded
      },
      operationType: op.operationType === 'create' ? 'delete' :
                      op.operationType === 'delete' ? 'create' :
                      'modify'
    };
  }

  /**
   * 生成逆补丁
   */
  private generateInversePatch(originalContent: string, newContent: string): string {
    // 简化版：直接交换原始和新内容
    return this.generateDiff(newContent, originalContent);
  }

  /**
   * 生成diff
   */
  private generateDiff(oldContent: string, newContent: string): string {
    // 简化版：返回完整内容替换的diff
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    let diff = '--- a/file\n+++ b/file\n';
    diff += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;

    for (const line of oldLines) {
      diff += `-${line}\n`;
    }
    for (const line of newLines) {
      diff += `+${line}\n`;
    }

    return diff;
  }

  /**
   * 解析补丁块
   */
  private parseHunks(patch: string): PatchHunk[] {
    const hunks: PatchHunk[] = [];
    const lines = patch.split('\n');

    let currentHunk: Partial<PatchHunk> | null = null;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        // 新的hunk开始
        if (currentHunk) {
          hunks.push(currentHunk as PatchHunk);
        }

        // 解析hunk头: @@ -oldStart,oldLines +newStart,newLines @@
        const match = line.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
        if (match) {
          currentHunk = {
            id: this.generateId('hunk'),
            originalStart: parseInt(match[1]),
            originalLines: parseInt(match[2]),
            newStart: parseInt(match[3]),
            newLines: parseInt(match[4]),
            content: ''
          };
        }
      } else if (currentHunk) {
        currentHunk.content += line + '\n';
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk as PatchHunk);
    }

    return hunks;
  }

  /**
   * 解析补丁内容
   */
  private parsePatch(patch: string): {
    originalContent?: string;
    newContent?: string;
  } {
    const lines = patch.split('\n');
    const originalLines: string[] = [];
    const newLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('-') && !line.startsWith('---')) {
        originalLines.push(line.substring(1));
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        newLines.push(line.substring(1));
      } else if (!line.startsWith('@@') && !line.startsWith('---') && !line.startsWith('+++')) {
        originalLines.push(line);
        newLines.push(line);
      }
    }

    return {
      originalContent: originalLines.join('\n'),
      newContent: newLines.join('\n')
    };
  }

  /**
   * 计算文件内容的hash
   */
  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * 生成ID
   */
  private generateId(prefix: string): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * 保存blob数据
   */
  private async saveBlobData(id: string, data: any): Promise<string> {
    // 简化版：只返回引用，实际应该保存到文件系统
    return `blob:${id}`;
  }

  // =============================================================================
  // 公共查询方法
  // =============================================================================

  /**
   * 获取当前版本节点ID
   */
  getCurrentNodeId(): string | null {
    return this.state.currentNodeId;
  }

  /**
   * 获取版本节点
   */
  getNode(nodeId: string): VersionNode | undefined {
    const node = this.state.nodes.get(nodeId);
    if (!node) {
      this.logger.debug(`getNode: Node not found: ${nodeId}`);
    }
    return node;
  }

  /**
   * 获取所有节点
   */
  getAllNodes(): VersionNode[] {
    const nodes = Array.from(this.state.nodes.values());
    this.logger.debug(`getAllNodes: Retrieved ${nodes.length} nodes from state`);
    return nodes;
  }

  /**
   * 通过turnRef查找版本节点（用于诊断）
   */
  findNodeByTurnRef(turnRef: string): VersionNode | undefined {
    for (const node of this.state.nodes.values()) {
      if (node.turnRefs.includes(turnRef)) {
        this.logger.debug(`findNodeByTurnRef: Found node ${node.nodeId} for turnRef: ${turnRef}`);
        return node;
      }
    }
    this.logger.debug(`findNodeByTurnRef: No node found for turnRef: ${turnRef}`);
    return undefined;
  }

  /**
   * 获取时间线
   */
  getTimeline(): TimelineItem[] {
    const timeline: TimelineItem[] = [];

    // 从根节点开始遍历
    const traverse = (nodeId: string) => {
      const node = this.state.nodes.get(nodeId);
      if (!node) return;

      const stats = node.ops.reduce(
        (acc, op) => ({
          linesAdded: acc.linesAdded + op.stats.linesAdded,
          linesRemoved: acc.linesRemoved + op.stats.linesRemoved
        }),
        { linesAdded: 0, linesRemoved: 0 }
      );

      timeline.push({
        nodeId: node.nodeId,
        title: node.description || `Version ${node.nodeId.substring(5, 13)}`,
        description: `${node.ops.length} files changed`,
        timestamp: node.createdAt,
        type: node.nodeType,
        fileCount: node.ops.length,
        stats,
        isCurrent: node.nodeId === this.state.currentNodeId,
        hasBranches: node.childrenIds.length > 1
      });

      // 遍历子节点
      for (const childId of node.childrenIds) {
        traverse(childId);
      }
    };

    if (this.state.rootNodeId) {
      traverse(this.state.rootNodeId);
    }

    // 按时间排序
    timeline.sort((a, b) => a.timestamp - b.timestamp);

    return timeline;
  }

  /**
   * 获取Turn的版本元数据
   */
  getTurnMetadata(nodeId: string): TurnVersionMetadata | null {
    const node = this.state.nodes.get(nodeId);
    if (!node) return null;

    const affectedFiles: FileImpact[] = node.ops.map(op => ({
      filePath: op.fileUri,
      operationType: op.operationType,
      linesAdded: op.stats.linesAdded,
      linesRemoved: op.stats.linesRemoved
    }));

    return {
      applied: node.ops.length > 0,
      versionNodeId: nodeId,
      affectedFiles
    };
  }

  /**
   * 清理和重置
   */
  dispose(): void {
    this.state.nodes.clear();
    this.state.snapshots.clear();
    this.state.currentNodeId = null;
    this.state.rootNodeId = null;
    this.logger.info('🔄 Version Control Service disposed');
  }
}
