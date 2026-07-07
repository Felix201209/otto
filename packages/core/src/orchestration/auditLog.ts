/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * AuditLog — 操作审计日志。
 *
 * 复用 AfterTool Hook 事件，每次工具调用自动记录：
 * 谁、什么时候、调了什么工具、操作了什么资源、结果如何。
 *
 * 存储：~/.otto-user/audit/audit-<date>.jsonl
 * 每个 JSONL 行为一条审计记录，按天分文件。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

/** 审计日志根目录 */
const AUDIT_DIR = path.join(homedir(), '.otto-user', 'audit');

/** 单条审计记录 */
export interface AuditEntry {
  /** ISO 时间戳 */
  timestamp: string;
  /** 会话 ID */
  sessionId: string;
  /** 用户标识（OS 用户名或飞书用户） */
  userId: string;
  /** 工具名称 */
  toolName: string;
  /** 操作描述（人类可读） */
  action: string;
  /** 操作分类 */
  category: string;
  /** 是否成功 */
  success: boolean;
  /** 操作的输入参数摘要（脱敏后） */
  inputSummary: string;
  /** 操作的输出结果摘要 */
  outputSummary: string;
  /** 执行耗时（毫秒） */
  durationMs?: number;
  /** 操作来源（terminal / feishu / desktop） */
  source: string;
  /** 风险等级 */
  riskLevel: 'low' | 'medium' | 'high';
}

/** 审计查询参数 */
export interface AuditQueryParams {
  startDate?: string;
  endDate?: string;
  userId?: string;
  toolName?: string;
  category?: string;
  successOnly?: boolean;
  failedOnly?: boolean;
  highRiskOnly?: boolean;
  limit?: number;
}

/**
 * 审计日志记录器。
 *
 * 由 toolExecutionEngine 的 AfterTool Hook 调用，
 * fire-and-forget，不阻塞主流程。
 */
export class AuditLogger {
  private initialized = false;

  /** 确保目录存在 */
  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(AUDIT_DIR, { recursive: true }).catch(() => {});
    this.initialized = true;
  }

  /**
   * 记录一条审计日志。
   */
  async log(entry: Omit<AuditEntry, 'timestamp' | 'riskLevel'> & { riskLevel?: AuditEntry['riskLevel'] }): Promise<void> {
    await this.ensureDir();

    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      riskLevel: entry.riskLevel || this.inferRiskLevel(entry.toolName, entry.action),
    };

    const date = fullEntry.timestamp.split('T')[0];
    const filePath = path.join(AUDIT_DIR, `audit-${date}.jsonl`);
    const line = JSON.stringify(fullEntry) + '\n';

    await fs.appendFile(filePath, line, 'utf-8').catch((err) => {
      console.warn(`[AuditLog] Failed to write: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * 读取某天的审计日志。
   */
  async readDay(date: string): Promise<AuditEntry[]> {
    const filePath = path.join(AUDIT_DIR, `audit-${date}.jsonl`);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch {
      return [];
    }
  }

  /**
   * 查询审计日志（支持多条件过滤）。
   */
  async query(params: AuditQueryParams): Promise<AuditEntry[]> {
    const entries: AuditEntry[] = [];

    // 计算日期范围
    const endDate = params.endDate || new Date().toISOString().split('T')[0];
    const startDate = params.startDate || (() => {
      const d = new Date(endDate);
      d.setDate(d.getDate() - 7); // 默认查最近7天
      return d.toISOString().split('T')[0];
    })();

    const current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
      const dateStr = current.toISOString().split('T')[0];
      const dayEntries = await this.readDay(dateStr);
      entries.push(...dayEntries);
      current.setDate(current.getDate() + 1);
    }

    // 过滤
    let filtered = entries;
    if (params.userId) filtered = filtered.filter((e) => e.userId === params.userId);
    if (params.toolName) filtered = filtered.filter((e) => e.toolName === params.toolName);
    if (params.category) filtered = filtered.filter((e) => e.category === params.category);
    if (params.successOnly) filtered = filtered.filter((e) => e.success);
    if (params.failedOnly) filtered = filtered.filter((e) => !e.success);
    if (params.highRiskOnly) filtered = filtered.filter((e) => e.riskLevel === 'high');

    // 排序（最新的在前）
    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // 限制返回数
    if (params.limit) filtered = filtered.slice(0, params.limit);

    return filtered;
  }

  /**
   * 生成审计报告摘要。
   */
  async generateReport(startDate: string, endDate: string): Promise<string> {
    const entries = await this.query({ startDate, endDate });

    if (entries.length === 0) {
      return `审计日志 (${startDate} 至 ${endDate})\n无记录。`;
    }

    const byCategory: Record<string, number> = {};
    const byTool: Record<string, number> = {};
    const byUser: Record<string, number> = {};
    let successCount = 0;
    let highRiskCount = 0;

    for (const entry of entries) {
      byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
      byTool[entry.toolName] = (byTool[entry.toolName] || 0) + 1;
      byUser[entry.userId] = (byUser[entry.userId] || 0) + 1;
      if (entry.success) successCount++;
      if (entry.riskLevel === 'high') highRiskCount++;
    }

    const lines: string[] = [];
    lines.push(`# 审计日志报告`);
    lines.push(`## 时间范围：${startDate} 至 ${endDate}`);
    lines.push('');
    lines.push(`## 概览`);
    lines.push(`- 总操作数：${entries.length}`);
    lines.push(`- 成功：${successCount}  失败：${entries.length - successCount}`);
    lines.push(`- 高风险操作：${highRiskCount}`);
    lines.push(`- 涉及用户：${Object.keys(byUser).length}`);
    lines.push('');

    lines.push(`## 按用户`);
    for (const [user, count] of Object.entries(byUser).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${user}: ${count} 次操作`);
    }
    lines.push('');

    lines.push(`## 按类别`);
    for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${cat}: ${count} 次`);
    }
    lines.push('');

    lines.push(`## 高风险操作`);
    const highRisk = entries.filter((e) => e.riskLevel === 'high');
    if (highRisk.length === 0) {
      lines.push('无高风险操作。');
    } else {
      for (const entry of highRisk.slice(0, 20)) {
        lines.push(`- [${entry.timestamp}] ${entry.userId} ${entry.action} (${entry.success ? '成功' : '失败'})`);
      }
      if (highRisk.length > 20) {
        lines.push(`... 共 ${highRisk.length} 条，仅显示前20条`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 根据工具名和操作推断风险等级。
   */
  private inferRiskLevel(toolName: string, action: string): AuditEntry['riskLevel'] {
    const name = toolName.toLowerCase();
    const act = action.toLowerCase();

    // 高风险：删除、发送消息、执行命令、发邮件
    if (name.includes('delete') || name.includes('remove') || act.includes('删除')) return 'high';
    if (name.includes('shell') || name.includes('run_shell')) return 'high';
    if (name.includes('send') && (name.includes('message') || name.includes('mail'))) return 'high';
    if (name.includes('write_file') || name.includes('replace')) return 'medium';

    // 中风险：创建、更新
    if (name.includes('create') || name.includes('update') || name.includes('write')) return 'medium';

    // 低风险：读取、搜索、查询
    return 'low';
  }
}

/**
 * 全局单例。
 */
let globalAuditLogger: AuditLogger | null = null;

export function getAuditLogger(): AuditLogger {
  if (!globalAuditLogger) {
    globalAuditLogger = new AuditLogger();
  }
  return globalAuditLogger;
}
