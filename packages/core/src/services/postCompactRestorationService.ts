/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 压缩后状态恢复服务 (Post-Compact Restoration)
 *
 * 在全量压缩后，恢复关键上下文信息：
 * - 追踪最近读取的文件，在压缩后重新附加文件内容摘要
 *
 * 灵感来自 ClaudeCode 的 postCompactCleanup + createPostCompactFileAttachments 策略：
 * - 压缩后自动恢复最近读取的 Top N 文件内容
 * - 有总 token 预算和单文件 token 预算限制
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * 文件读取记录
 */
export interface FileReadRecord {
  /** 文件路径 */
  filePath: string;
  /** 读取时间戳 */
  timestamp: number;
}

/**
 * 恢复配置
 */
export interface PostCompactRestorationConfig {
  /**
   * 压缩后恢复的最大文件数量
   * 默认: 5
   */
  maxFilesToRestore?: number;

  /**
   * 单个文件的最大字符数
   * 默认: 5000 (约 1.25K tokens)
   */
  maxCharsPerFile?: number;

  /**
   * 恢复文件的总字符预算
   * 默认: 50000 (约 12.5K tokens)
   */
  totalCharBudget?: number;
}

/**
 * 压缩后状态恢复服务
 */
export class PostCompactRestorationService {
  private readonly maxFilesToRestore: number;
  private readonly maxCharsPerFile: number;
  private readonly totalCharBudget: number;

  /** 文件读取记录（按读取时间排序，最近的在最后） */
  private fileReadRecords: Map<string, FileReadRecord> = new Map();

  constructor(config: PostCompactRestorationConfig = {}) {
    this.maxFilesToRestore = config.maxFilesToRestore ?? 5;
    this.maxCharsPerFile = config.maxCharsPerFile ?? 5000;
    this.totalCharBudget = config.totalCharBudget ?? 50000;
  }

  /**
   * 记录文件读取事件
   * 工具执行层在 read_file / read_many_files 执行后调用此方法
   */
  trackFileRead(filePath: string): void {
    const normalizedPath = path.resolve(filePath);
    this.fileReadRecords.set(normalizedPath, {
      filePath: normalizedPath,
      timestamp: Date.now(),
    });
  }

  /**
   * 获取最近读取的文件列表（按时间倒序，最近的在前）
   */
  getRecentlyReadFiles(limit?: number): FileReadRecord[] {
    const records = Array.from(this.fileReadRecords.values());
    records.sort((a, b) => b.timestamp - a.timestamp);
    return records.slice(0, limit ?? this.maxFilesToRestore);
  }

  /**
   * 生成压缩后的文件恢复内容
   *
   * 读取最近访问的文件的当前内容（压缩后文件可能已变更），
   * 拼接为一段上下文消息附加到压缩后的历史中。
   *
   * @returns 恢复内容文本，如果没有文件可恢复则返回 null
   */
  async generateRestorationContent(): Promise<string | null> {
    const recentFiles = this.getRecentlyReadFiles(this.maxFilesToRestore);

    if (recentFiles.length === 0) {
      return null;
    }

    const restoredFiles: string[] = [];
    let totalChars = 0;

    for (const record of recentFiles) {
      if (totalChars >= this.totalCharBudget) break;

      try {
        // 检查文件是否存在且为普通文件
        const stats = fs.statSync(record.filePath);
        if (!stats.isFile()) continue;

        // 跳过过大的文件（超过 1MB 的文件不尝试读取）
        if (stats.size > 1024 * 1024) continue;

        const content = fs.readFileSync(record.filePath, 'utf-8');
        const truncatedContent = content.length > this.maxCharsPerFile
          ? content.slice(0, this.maxCharsPerFile) + '\n... [truncated]'
          : content;

        const fileBlock = `--- ${record.filePath} ---\n${truncatedContent}`;
        totalChars += fileBlock.length;
        restoredFiles.push(fileBlock);
      } catch {
        // 文件可能已被删除或无法读取，跳过
        continue;
      }
    }

    if (restoredFiles.length === 0) {
      return null;
    }

    return `[Post-compression context restoration] The following ${restoredFiles.length} recently-read files are provided for context continuity:\n\n${restoredFiles.join('\n\n')}`;
  }

  /**
   * 清除所有文件读取记录
   */
  clear(): void {
    this.fileReadRecords.clear();
  }

  /**
   * 获取已追踪的文件数量
   */
  getTrackedFileCount(): number {
    return this.fileReadRecords.size;
  }
}
