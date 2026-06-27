/**
 * Session Persistence Service
 * Session持久化存储服务
 *
 * @license Apache-2.0
 * Copyright 2025 Felix
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import { Logger } from '../utils/logger';
import { messageContentToString } from '../utils/messageContentConverter';
import {
  SessionState,
  SessionExportData,
  SessionImportOptions
} from '../types/sessionTypes';
import {
  SESSION_CONSTANTS,
  SESSION_ERROR_MESSAGES,
  SessionType,
  SessionStatus
} from '../constants/sessionConstants';

// 🎯 性能优化常量
const DEFAULT_MAX_LOAD_SESSIONS = 10; // 默认只加载最近10个session以提高性能

/**
 * SessionPersistenceService - Session数据持久化服务
 *
 * 职责：
 * - 保存和加载Session数据
 * - 管理Session存储目录
 * - 处理Session导入导出
 * - 清理过期Session数据
 */
/**
 * Session索引结构（参考CLI实现）
 */
interface SessionIndex {
  lastUpdated: string;
  sessions: SessionMetadata[];
}

/**
 * Session元数据（参考CLI实现）
 */
interface SessionMetadata {
  sessionId: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount?: number;
  hasCheckpoint?: boolean;
  firstUserMessage?: string;
  lastAssistantMessage?: string;
  modelConfig?: {
    modelName: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    stopSequences?: string[];
  };
  /** 🎯 用户自定义的显示顺序（用于拖拽排序） */
  displayOrder?: number;
}

export class SessionPersistenceService {
  private readonly storageDir: string;    // sessions目录
  private readonly sessionsDir: string;   // 实际存储session的目录
  private readonly indexFile: string;     // 索引文件路径
  private readonly backupDir: string;

  constructor(
    private readonly logger: Logger,
    private readonly context: vscode.ExtensionContext
  ) {
    // 🎯 按项目分离session存储（参考CLI结构）
    const homeDir = os.homedir();
    const projectName = this.getProjectName();
    this.storageDir = path.join(homeDir, '.otto-user', 'tmp', 'sessions_vscode', projectName);
    this.sessionsDir = path.join(this.storageDir, 'sessions');
    this.indexFile = path.join(this.sessionsDir, 'index.json');
    this.backupDir = path.join(this.storageDir, 'backups');
  }

  /**
   * 初始化存储目录（参考CLI结构）
   */
  async initialize(): Promise<void> {
    try {
      // 创建必要的目录结构
      await this.ensureDirectoryExists(this.storageDir);
      await this.ensureDirectoryExists(this.sessionsDir);
      await this.ensureDirectoryExists(this.backupDir);

      // 确保索引文件存在
      await this.ensureIndexExists();

      this.logger.info(`✅ Session storage initialized at: ${this.sessionsDir}`);
      this.logger.info(`📄 Session index at: ${this.indexFile}`);

      // 清理过期备份
      await this.cleanupExpiredBackups();

      // 🎯 项目信息日志
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const originalPath = workspaceFolder ? workspaceFolder.uri.fsPath : (vscode.workspace.rootPath || 'unknown');
      this.logger.info(`📁 Project: ${originalPath}`);
      this.logger.info(`🏷️ Sanitized: ${this.getProjectName()}`);
      this.logger.info(`💾 Sessions dir: ${this.sessionsDir}`);

    } catch (error) {
      this.logger.error('❌ Failed to initialize session storage', error instanceof Error ? error : undefined);
      throw new Error(`Storage initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 确保索引文件存在
   */
  private async ensureIndexExists(): Promise<void> {
    try {
      await fs.access(this.indexFile);
    } catch {
      // 索引文件不存在，创建空索引
      const emptyIndex: SessionIndex = {
        lastUpdated: new Date().toISOString(),
        sessions: []
      };
      await fs.writeFile(this.indexFile, JSON.stringify(emptyIndex, null, 2), 'utf-8');
      this.logger.info('📄 Created empty session index file');
    }
  }

  /**
   * 保存单个Session状态（参考CLI结构：每个session一个目录）
   */
  async saveSession(sessionState: SessionState): Promise<void> {
    try {
      const sessionId = sessionState.info.id;

      // 🎯 跳过没有用户消息的空session - 这些session没有保存价值
      const firstUserMessage = this.getFirstUserMessage(sessionState.messages);
      if (!firstUserMessage || !firstUserMessage.trim()) {
        this.logger.debug(`🚫 Skipping save for empty session: ${sessionState.info.name} (${sessionId}) - no user messages`);
        return;
      }

      const sessionDir = this.getSessionDir(sessionId);

      // 创建 session 目录
      await this.ensureDirectoryExists(sessionDir);

      // 1. 保存 metadata.json
      // 🎯 复用之前已经获取的firstUserMessage，避免重复计算

      // 🎯 读取已有的 metadata，检查是否有手动修改过的标题
      let existingMetadata: SessionMetadata | null = null;
      try {
        const metadataPath = path.join(sessionDir, 'metadata.json');
        const metadataContent = await fs.readFile(metadataPath, 'utf-8');
        existingMetadata = JSON.parse(metadataContent);
      } catch {
        // 文件不存在或读取失败，忽略
      }

      // 🎯 决定标题：优先使用 sessionState.info.name（包含用户手动修改的标题）
      // 只有当 name 是默认值且没有已有 title 时，才用第一条消息自动生成
      let title: string = sessionState.info.name;  // 默认使用 sessionState.info.name

      const isDefaultName = sessionState.info.name === 'New Chat' ||
                            sessionState.info.name === 'Untitled Chat' ||
                            sessionState.info.name === 'New Session';  // 🔥 添加 'New Session'
      const hasExistingTitle = existingMetadata?.title &&
                               existingMetadata.title !== 'New Chat' &&
                               existingMetadata.title !== 'Untitled Chat' &&
                               existingMetadata.title !== 'New Session';  // 🔥 添加 'New Session'

      // 只在以下情况才自动生成标题：
      // 1. 当前 name 是默认值
      // 2. 没有已有的 title（新 session）或已有 title 也是默认值
      // 3. 有第一条用户消息
      if (isDefaultName && !hasExistingTitle && firstUserMessage && firstUserMessage.trim()) {
        // 使用第一条用户消息自动生成标题
        title = firstUserMessage.length > 50
          ? firstUserMessage.substring(0, 50) + '...'
          : firstUserMessage.trim();
        // 🔥 关键修复：回写到内存中的 sessionState.info.name
        sessionState.info.name = title;
      } else if (isDefaultName && hasExistingTitle) {
        // 保持已有的标题
        title = existingMetadata!.title;
        // 🔥 关键修复：同步到内存
        sessionState.info.name = title;
      }
      // 否则使用 sessionState.info.name（包括用户手动修改的）

      const metadata: SessionMetadata = {
        sessionId,
        title,
        createdAt: typeof sessionState.info.createdAt === 'string' ? sessionState.info.createdAt : new Date(sessionState.info.createdAt).toISOString(),
        lastActiveAt: sessionState.info.lastActivity ? new Date(sessionState.info.lastActivity).toISOString() : new Date().toISOString(),
        messageCount: sessionState.messages.length,
        hasCheckpoint: false,
        firstUserMessage: firstUserMessage,
        lastAssistantMessage: this.getLastAssistantMessage(sessionState.messages),
        // 🎯 保存模型配置信息
        modelConfig: sessionState.modelConfig
      };
      await fs.writeFile(
        path.join(sessionDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf-8'
      );

      // 2. 保存 history.json (UI历史记录)
      await fs.writeFile(
        path.join(sessionDir, 'history.json'),
        JSON.stringify(sessionState.messages, null, 2),
        'utf-8'
      );

      // 3. 保存 context.json (AI客户端历史)
      const aiClientHistory = sessionState.context?.aiClientHistory || [];
      await fs.writeFile(
        path.join(sessionDir, 'context.json'),
        JSON.stringify(aiClientHistory, null, 2),
        'utf-8'
      );

      // 4. 保存 tokens.json (简化版本)
      const tokens = {
        sessionId,
        startTime: sessionState.info.createdAt,
        models: {} // VSCode版暂不统计tokens
      };
      await fs.writeFile(
        path.join(sessionDir, 'tokens.json'),
        JSON.stringify(tokens, null, 2),
        'utf-8'
      );

      // 5. 更新索引文件
      await this.updateSessionIndex(metadata);

      this.logger.debug(`Session saved: ${sessionState.info.name} (${sessionState.info.id})`);

    } catch (error) {
      this.logger.error(`❌ Failed to save session ${sessionState.info.id}`, error instanceof Error ? error : undefined);
      throw new Error(`${SESSION_ERROR_MESSAGES.SESSION_SAVE_FAILED}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 保存所有Session状态（逐个保存）
   */
  async saveSessions(sessions: SessionState[]): Promise<void> {
    for (const session of sessions) {
      await this.saveSession(session);
    }
  }

  /**
   * 保存所有Session状态并创建备份（不再需要，因为每个session独立文件）
   */
  async saveSessionsWithBackup(sessions: SessionState[]): Promise<void> {
    // 新设计下不再需要整体备份，每个session都是独立文件
    await this.saveSessions(sessions);
    this.logger.debug(`📋 Sessions saved: ${sessions.length} sessions`);
  }

  /**
   * 加载最近的Session状态（从索引文件加载，限制数量以提高性能）
   * 🎯 按用户自定义的displayOrder排序（支持拖拽排序）
   */
  async loadSessions(maxSessions: number = DEFAULT_MAX_LOAD_SESSIONS): Promise<SessionState[]> {
    try {
      const index = await this.loadSessionIndex();
      const sessions: SessionState[] = [];

      // 🎯 按 displayOrder 排序（保留用户手动设置的顺序）
      // 如果 displayOrder 相同则按 createdAt 排序
      const sortedSessions = [...index.sessions].sort((a, b) => {
        const orderA = a.displayOrder ?? 0;
        const orderB = b.displayOrder ?? 0;
        if (orderA !== orderB) {
          return orderA - orderB;
        }
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }).slice(0, maxSessions);

      this.logger.info(`📂 Loading recent ${sortedSessions.length} sessions (limited from ${index.sessions.length} total sessions)`);

      // 逐个加载session
      for (const metadata of sortedSessions) {
        try {
          const session = await this.loadSingleSession(metadata.sessionId);
          if (session) {
            sessions.push(session);
          }
        } catch (error) {
          this.logger.warn(`Failed to load session ${metadata.sessionId}`, error instanceof Error ? error : undefined);
          // 继续加载其他session
        }
      }

      this.logger.info(`✅ Loaded ${sessions.length} recent sessions (max: ${maxSessions}, available: ${index.sessions.length})`);
      return sessions;

    } catch (error) {
      this.logger.error('❌ Failed to load sessions from index', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * 🎯 保存Session顺序（用于拖拽排序）
   * @param sessionIds 按用户拖拽后的新顺序排列的sessionId数组
   */
  async saveSessionsOrder(sessionIds: string[]): Promise<void> {
    try {
      const index = await this.loadSessionIndex();

      // 更新每个session的displayOrder
      for (let i = 0; i < sessionIds.length; i++) {
        const metadata = index.sessions.find(s => s.sessionId === sessionIds[i]);
        if (metadata) {
          // 🎯 displayOrder从0开始，按拖拽顺序递增
          metadata.displayOrder = i * 10000; // 使用间距便于后续插入新session
        }
      }

      // 排序后保存
      index.sessions.sort((a, b) => {
        const orderA = a.displayOrder ?? 0;
        const orderB = b.displayOrder ?? 0;
        if (orderA !== orderB) {
          return orderA - orderB;
        }
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

      index.lastUpdated = new Date().toISOString();
      await fs.writeFile(this.indexFile, JSON.stringify(index, null, 2), 'utf-8');

      this.logger.info(`✅ Sessions order saved: ${sessionIds.length} sessions reordered`);

    } catch (error) {
      this.logger.error('❌ Failed to save sessions order', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      this.logger.info(`🗑️ Deleting session: ${sessionId}`);

      const sessionDir = this.getSessionDir(sessionId);

      // 1. 删除session目录
      try {
        await fs.rm(sessionDir, { recursive: true, force: true });
        this.logger.debug(`🗑️ Deleted session directory: ${sessionDir}`);
      } catch (error) {
        this.logger.warn(`Failed to delete session directory ${sessionDir}`, error instanceof Error ? error : undefined);
      }

      // 2. 从索引中移除
      await this.removeFromIndex(sessionId);

      this.logger.info(`✅ Session deleted: ${sessionId}`);

    } catch (error) {
      this.logger.error(`❌ Failed to delete session ${sessionId}`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * 清理磁盘上过多的session（保留最近N个）
   */
  async cleanupOldSessions(maxKeep: number): Promise<void> {
    try {
      this.logger.info(`🧹 开始清理磁盘session，保留最近 ${maxKeep} 个`);

      const index = await this.loadSessionIndex();

      // 按最后活跃时间排序（最新的在前面）
      const sortedSessions = [...index.sessions].sort((a, b) =>
        new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
      );

      this.logger.debug(`📊 当前磁盘session数量: ${sortedSessions.length}, 最大保留: ${maxKeep}`);

      // 如果session数量不超过限制，无需清理
      if (sortedSessions.length <= maxKeep) {
        this.logger.debug('✅ Session数量未超过限制，无需清理');
        return;
      }

      // 计算需要删除的session
      const sessionsToDelete = sortedSessions.slice(maxKeep);

      this.logger.info(`🗑️ 需要删除 ${sessionsToDelete.length} 个过期session`);

      // 批量删除过期session
      let deletedCount = 0;
      for (const sessionMeta of sessionsToDelete) {
        try {
          const sessionDir = this.getSessionDir(sessionMeta.sessionId);
          await fs.rm(sessionDir, { recursive: true, force: true });
          deletedCount++;
          this.logger.debug(`🗑️ 已删除过期session: ${sessionMeta.sessionId} (${sessionMeta.title})`);
        } catch (error) {
          this.logger.warn(`删除session目录失败: ${sessionMeta.sessionId}`, error instanceof Error ? error : undefined);
        }
      }

      // 更新索引，移除已删除的session
      const updatedIndex: SessionIndex = {
        lastUpdated: new Date().toISOString(),
        sessions: sortedSessions.slice(0, maxKeep)
      };

      await fs.writeFile(this.indexFile, JSON.stringify(updatedIndex, null, 2), 'utf-8');

      this.logger.info(`✅ 清理完成: 删除了 ${deletedCount} 个过期session，保留了最近 ${updatedIndex.sessions.length} 个`);

    } catch (error) {
      this.logger.error('❌ 清理磁盘session失败', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * 导出Session数据
   */
  async exportSessions(sessionIds?: string[], filePath?: string): Promise<string> {
    try {
      const allSessions = await this.loadAllSessions();
      let sessionsToExport: SessionState[];

      if (sessionIds && sessionIds.length > 0) {
        sessionsToExport = allSessions.filter(s => sessionIds.includes(s.info.id));
      } else {
        sessionsToExport = allSessions;
      }

      if (sessionsToExport.length === 0) {
        throw new Error('No sessions found to export');
      }

      const exportData: SessionExportData = {
        version: '1.0.0',
        exportedAt: Date.now(),
        sessions: sessionsToExport,
        metadata: {
          totalSessions: sessionsToExport.length,
          totalMessages: sessionsToExport.reduce((sum, s) => sum + s.messages.length, 0),
          exportSource: 'Otto VSCode Extension'
        }
      };

      const exportPath = filePath || this.generateExportFilePath();
      await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2), 'utf-8');

      this.logger.info(`✅ Sessions exported to: ${exportPath}`);
      return exportPath;

    } catch (error) {
      this.logger.error('❌ Failed to export sessions', error instanceof Error ? error : undefined);
      throw new Error(`${SESSION_ERROR_MESSAGES.SESSION_EXPORT_FAILED}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 导入Session数据
   */
  async importSessions(filePath: string, options: SessionImportOptions = {}): Promise<SessionState[]> {
    try {
      const importData = await this.readImportFile(filePath);
      const validatedSessions = this.validateImportData(importData);

      if (validatedSessions.length === 0) {
        throw new Error('No valid sessions found in import file');
      }

      const existingSessions = await this.loadAllSessions();
      const processedSessions = this.processImportedSessions(validatedSessions, existingSessions, options);

      // 保存合并后的Session数据
      const allSessions = options.overwriteExisting
        ? [...existingSessions.filter(s => !processedSessions.find(p => p.info.id === s.info.id)), ...processedSessions]
        : [...existingSessions, ...processedSessions];

      await this.saveAllSessions(allSessions);

      this.logger.info(`✅ Imported ${processedSessions.length} sessions from: ${filePath}`);
      return processedSessions;

    } catch (error) {
      this.logger.error(`❌ Failed to import sessions from ${filePath}`, error instanceof Error ? error : undefined);
      throw new Error(`${SESSION_ERROR_MESSAGES.SESSION_IMPORT_FAILED}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 创建Session数据备份
   */
  async createBackup(): Promise<string> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(this.backupDir, `sessions-backup-${timestamp}.json`);

      const sessions = await this.loadAllSessions();
      const backupData = {
        version: '1.0.0',
        createdAt: Date.now(),
        sessions: sessions
      };

      await fs.writeFile(backupFile, JSON.stringify(backupData, null, 2), 'utf-8');

      this.logger.info(`✅ Session backup created: ${backupFile}`);
      return backupFile;

    } catch (error) {
      this.logger.error('❌ Failed to create session backup', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  // =============================================================================
  // 私有辅助方法
  // =============================================================================

  /**
   * 获取当前项目名称（基于完整路径避免冲突）
   */
  private getProjectName(): string {
    // 🎯 从VSCode workspace获取完整路径
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      return this.sanitizePathForDirectory(workspaceFolder.uri.fsPath);
    }

    // 备用：使用扩展上下文中的工作区路径
    const workspaceRoot = vscode.workspace.rootPath;
    if (workspaceRoot) {
      return this.sanitizePathForDirectory(workspaceRoot);
    }

    // 最后备用：使用默认名称
    return 'default-project';
  }

  /**
   * 清理路径字符串，使其适合作为目录名
   */
  private sanitizePathForDirectory(fullPath: string): string {
    // 1. 获取绝对路径并规范化
    const normalizedPath = path.resolve(fullPath);

    // 2. 替换或移除不适合作为目录名的字符
    let sanitized = normalizedPath
      .replace(/[<>:"|*?]/g, '_')        // 替换Windows禁用字符
      .replace(/\\/g, '_')               // 替换反斜杠
      .replace(/\//g, '_')               // 替换正斜杠
      .replace(/\s+/g, '_')              // 替换空格
      .replace(/_{2,}/g, '_')            // 多个下划线合并为一个
      .replace(/^_|_$/g, '');            // 移除开头和结尾的下划线

    // 3. 限制长度，避免路径过长
    if (sanitized.length > 100) {
      // 取前50个字符 + 哈希后缀
      const hash = crypto.createHash('md5').update(normalizedPath).digest('hex').substring(0, 8);
      sanitized = sanitized.substring(0, 50) + '_' + hash;
    }

    // 4. 确保不为空
    if (!sanitized) {
      sanitized = 'unknown-project';
    }

    return sanitized;
  }

  /**
   * 确保目录存在
   */
  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
    }
  }

  /**
   * 内部保存所有Session方法（已废弃，新设计使用独立文件）
   */
  private async saveAllSessions(sessions: SessionState[]): Promise<void> {
    // 新设计下不再需要这个方法，每个session都是独立文件
    this.logger.warn('saveAllSessions is deprecated in new storage design');
    for (const session of sessions) {
      await this.saveSession(session);
    }
  }

  /**
   * 内部加载所有Session方法（用于导出等需要完整数据的场景）
   */
  private async loadAllSessions(): Promise<SessionState[]> {
    // 🎯 导出等功能需要加载所有session，传入一个大数值确保加载全部
    this.logger.debug('Loading all sessions for export/import operations');
    return await this.loadSessions(Number.MAX_SAFE_INTEGER);
  }

  /**
   * 生成导出文件路径
   */
  private generateExportFilePath(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(this.storageDir, `sessions-export-${timestamp}.json`);
  }

  /**
   * 读取导入文件
   */
  private async readImportFile(filePath: string): Promise<SessionExportData> {
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(fileContent);
    } catch (error) {
      throw new Error(`Failed to read import file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 验证导入数据
   */
  private validateImportData(importData: SessionExportData): SessionState[] {
    if (!importData || !Array.isArray(importData.sessions)) {
      throw new Error('Invalid import file format');
    }

    return importData.sessions.filter(session => {
      try {
        return session && session.info && session.info.id && session.info.name;
      } catch {
        return false;
      }
    });
  }

  /**
   * 处理导入的Session
   */
  private processImportedSessions(
    importedSessions: SessionState[],
    existingSessions: SessionState[],
    options: SessionImportOptions
  ): SessionState[] {
    const maxSessions = options.maxSessions || SESSION_CONSTANTS.MAX_SESSIONS;
    let processedCount = 0;
    const processedSessions: SessionState[] = [];

    for (const session of importedSessions) {
      if (processedCount >= maxSessions) {
        break;
      }

      let processedSession = { ...session };

      // 处理ID冲突
      if (!options.preserveIds || existingSessions.find(s => s.info.id === session.info.id)) {
        processedSession.info.id = this.generateUniqueId(existingSessions);

        // 更新消息的sessionId
        processedSession.messages = session.messages.map(msg => ({
          ...msg,
          sessionId: processedSession.info.id
        }));
      }

      // 处理名称冲突
      if (existingSessions.find(s => s.info.name === session.info.name)) {
        processedSession.info.name = this.generateUniqueName(session.info.name, existingSessions);
      }

      // 重置状态
      processedSession.info.createdAt = Date.now();
      processedSession.info.lastActivity = Date.now();
      processedSession.activeToolCalls = [];
      processedSession.isLoading = false;

      processedSessions.push(processedSession);
      processedCount++;
    }

    return processedSessions;
  }

  /**
   * 生成唯一ID
   */
  private generateUniqueId(existingSessions: SessionState[]): string {
    let id: string;
    do {
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).substring(2, 8);
      id = `${SESSION_CONSTANTS.DEFAULT_SESSION_PREFIX}-${timestamp}-${random}`;
    } while (existingSessions.find(s => s.info.id === id));

    return id;
  }

  /**
   * 生成唯一名称
   */
  private generateUniqueName(baseName: string, existingSessions: SessionState[]): string {
    let counter = 1;
    let uniqueName = `${baseName} (${counter})`;

    while (existingSessions.find(s => s.info.name === uniqueName)) {
      counter++;
      uniqueName = `${baseName} (${counter})`;
    }

    return uniqueName;
  }

  /**
   * 清理过期备份
   */
  private async cleanupExpiredBackups(): Promise<void> {
    try {
      const files = await fs.readdir(this.backupDir);
      const backupFiles = files.filter(file => file.startsWith('sessions-backup-'));

      if (backupFiles.length <= 5) {
        return; // 保留最近5个备份
      }

      const fileStats = await Promise.all(
        backupFiles.map(async file => {
          const filePath = path.join(this.backupDir, file);
          const stats = await fs.stat(filePath);
          return { file, path: filePath, mtime: stats.mtime };
        })
      );

      // 按修改时间排序，删除最旧的文件
      fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      const filesToDelete = fileStats.slice(5);

      for (const fileInfo of filesToDelete) {
        await fs.unlink(fileInfo.path);
        this.logger.debug(`Deleted old backup: ${fileInfo.file}`);
      }

    } catch (error) {
      this.logger.warn('Failed to cleanup expired backups', error instanceof Error ? error : undefined);
    }
  }

  // =============================================================================
  // 公共API方法
  // =============================================================================

  /**
   * 获取当前项目的存储路径
   */
  getStorageDir(): string {
    return this.storageDir;
  }

  /**
   * 获取当前项目名称
   */
  getCurrentProjectName(): string {
    return this.getProjectName();
  }

  // =============================================================================
  // 新增的辅助方法（参考CLI实现）
  // =============================================================================

  /**
   * 获取session目录路径
   */
  private getSessionDir(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId);
  }

  /**
   * 加载session索引文件
   */
  private async loadSessionIndex(): Promise<SessionIndex> {
    try {
      const content = await fs.readFile(this.indexFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      // 索引文件不存在或损坏，返回空索引
      const emptyIndex: SessionIndex = {
        lastUpdated: new Date().toISOString(),
        sessions: []
      };
      return emptyIndex;
    }
  }

  /**
   * 🎯 获取所有session的元数据（用于历史列表）
   * 只返回轻量级的metadata，不加载完整session数据
   */
  async getAllSessionMetadata(): Promise<SessionMetadata[]> {
    try {
      const index = await this.loadSessionIndex();
      // 按创建时间倒序排序（最新的在前面）
      return index.sessions.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    } catch (error) {
      this.logger.error('Failed to get all session metadata', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * 🎯 分页获取session历史（用于历史列表的按需加载）
   */
  async getSessionHistory(options: {
    offset: number;
    limit: number;
    searchQuery?: string;
  }): Promise<{
    sessions: SessionMetadata[];
    total: number;
    hasMore: boolean;
  }> {
    try {
      const index = await this.loadSessionIndex();
      let allSessions = index.sessions;

      // 搜索过滤
      if (options.searchQuery && options.searchQuery.trim()) {
        const query = options.searchQuery.toLowerCase();
        allSessions = allSessions.filter(s =>
          s.title.toLowerCase().includes(query)  // 🔥 修复：使用 title
        );
      }

      // 排序（最新的在前）
      allSessions.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      // 分页
      const total = allSessions.length;
      const pagedSessions = allSessions.slice(
        options.offset,
        options.offset + options.limit
      );

      this.logger.info(`📄 Session history: offset=${options.offset}, limit=${options.limit}, total=${total}, returned=${pagedSessions.length}`);

      return {
        sessions: pagedSessions,
        total: total,
        hasMore: (options.offset + options.limit) < total
      };

    } catch (error) {
      this.logger.error('Failed to get session history', error instanceof Error ? error : undefined);
      return {
        sessions: [],
        total: 0,
        hasMore: false
      };
    }
  }

  /**
   * 加载单个session的完整状态（用于SessionManager）
   * 这是loadSingleSession的公开包装，保持原有私有方法不变
   */
  async loadSessionState(sessionId: string): Promise<SessionState | null> {
    return this.loadSingleSession(sessionId);
  }

  /**
   * 更新session索引
   * 🎯 支持 displayOrder 用于拖拽排序
   */
  private async updateSessionIndex(metadata: SessionMetadata, displayOrder?: number): Promise<void> {
    const index = await this.loadSessionIndex();

    // 查找是否已存在
    const existingIndex = index.sessions.findIndex(s => s.sessionId === metadata.sessionId);

    if (existingIndex >= 0) {
      // 🎯 更新现有记录时保留或更新 displayOrder
      const existingMetadata = index.sessions[existingIndex];
      index.sessions[existingIndex] = {
        ...metadata,
        displayOrder: displayOrder ?? existingMetadata.displayOrder ?? Date.now()
      };
    } else {
      // 🎯 添加新记录时设置 displayOrder
      index.sessions.push({
        ...metadata,
        displayOrder: displayOrder ?? Date.now()
      });
    }

    // 🎯 按 displayOrder 排序（保留用户手动设置的顺序），如果 displayOrder 相同则按 createdAt 排序
    index.sessions.sort((a, b) => {
      const orderA = a.displayOrder ?? 0;
      const orderB = b.displayOrder ?? 0;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      // 如果 displayOrder 相同，按 createdAt 排序
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    index.lastUpdated = new Date().toISOString();

    await fs.writeFile(this.indexFile, JSON.stringify(index, null, 2), 'utf-8');
  }

  /**
   * 从索引中移除session
   */
  private async removeFromIndex(sessionId: string): Promise<void> {
    const index = await this.loadSessionIndex();
    index.sessions = index.sessions.filter(s => s.sessionId !== sessionId);
    index.lastUpdated = new Date().toISOString();

    await fs.writeFile(this.indexFile, JSON.stringify(index, null, 2), 'utf-8');
  }

  /**
   * 加载单个session数据（内部使用）
   */
  private async loadSingleSession(sessionId: string): Promise<SessionState | null> {
    const sessionDir = this.getSessionDir(sessionId);

    try {
      // 并行读取所有文件
      const [metadataContent, historyContent, contextContent] = await Promise.all([
        fs.readFile(path.join(sessionDir, 'metadata.json'), 'utf-8'),
        fs.readFile(path.join(sessionDir, 'history.json'), 'utf-8').catch(() => '[]'),
        fs.readFile(path.join(sessionDir, 'context.json'), 'utf-8').catch(() => '[]')
      ]);

      const metadata: SessionMetadata = JSON.parse(metadataContent);
      const messages = JSON.parse(historyContent);
      const aiClientHistory = JSON.parse(contextContent);

      // 构造SessionState对象
      const sessionState: SessionState = {
        info: {
          id: metadata.sessionId,
          name: metadata.title, // 🎯 使用修正后的 title（优先使用第一条用户消息）
          type: SessionType.CHAT, // 使用正确的类型
          status: SessionStatus.IDLE, // 使用正确的枚举
          createdAt: new Date(metadata.createdAt).getTime(), // 🔧 使用磁盘中的真实创建时间
          messageCount: Number(metadata.messageCount) || 0,
          lastActivity: new Date(metadata.lastActiveAt).getTime()
        },
        messages: messages,
        context: {
          currentContext: {},
          aiClientHistory: aiClientHistory,
        },
        activeToolCalls: [],
        isLoading: false,
        // 🎯 恢复模型配置信息
        modelConfig: metadata.modelConfig
      } as SessionState;

      return sessionState;

    } catch (error) {
      this.logger.warn(`Failed to load session ${sessionId}`, error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * 获取第一条用户消息
   */
  private getFirstUserMessage(messages: any[]): string | undefined {
    const firstUserMsg = messages.find(msg => msg.type === 'user');
    if (!firstUserMsg || !firstUserMsg.content) {
      return undefined;
    }

    // 🎯 使用专用工具类安全转换content为字符串
    const contentText = messageContentToString(firstUserMsg.content);
    return contentText ? contentText.substring(0, 100) : undefined;
  }

  /**
   * 获取最后一条助手消息
   */
  private getLastAssistantMessage(messages: any[]): string | undefined {
    // 从后往前找第一条助手消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'assistant' || msg.type === 'response') {
        if (!msg.content) {
          continue;
        }

        // 🎯 使用专用工具类安全转换content为字符串
        const contentText = messageContentToString(msg.content);
        return contentText ? contentText.substring(0, 100) : undefined;
      }
    }
    return undefined;
  }
}
