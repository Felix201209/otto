/**
 * @license
 * Copyright 2025 Easy Code
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

// 使用 core 包中的 LintDiagnostic 类型
export interface LintDiagnostic {
  file: string;          // 文件路径
  line: number;          // 行号
  column: number;        // 列号
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;       // 错误信息
  source: string;        // 来源（如 'eslint', 'typescript'）
  code?: string;         // 错误代码
}

export interface DiagnosticChange {
  file: string;
  oldErrorCount: number;
  newErrorCount: number;
  addedErrors: LintDiagnostic[];
  resolvedErrors: LintDiagnostic[];
  changeType: 'improved' | 'degraded' | 'new_file' | 'fixed_file';
}

export interface DiagnosticsChangeListener {
  (changes: DiagnosticChange[]): Promise<void>;
}

/**
 * 诊断监控服务 - 主动监听代码质量变化
 */
export class DiagnosticsMonitorService {
  private disposables: vscode.Disposable[] = [];
  private listeners: DiagnosticsChangeListener[] = [];
  private fileErrorHistory: Map<string, LintDiagnostic[]> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingChanges: Set<string> = new Set();

  constructor(private logger: Logger) {}

  /**
   * 初始化监控服务
   */
  async initialize(): Promise<void> {
    this.logger.info('🎯 Initializing DiagnosticsMonitorService');

    // 监听诊断变化
    const diagnosticsListener = vscode.languages.onDidChangeDiagnostics((e) => {
      this.handleDiagnosticsChangeEvent(e);
    });

    // 监听文件保存 - 关键时机
    const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
      this.handleFileSaved(document);
    });

    // 监听活动编辑器变化
    const editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        this.handleActiveEditorChange(editor);
      }
    });

    this.disposables.push(diagnosticsListener, saveListener, editorListener);

    // 初始化当前诊断状态
    await this.initializeCurrentDiagnostics();

    this.logger.info('✅ DiagnosticsMonitorService initialized');
  }

  /**
   * 添加变化监听器
   */
  addChangeListener(listener: DiagnosticsChangeListener): void {
    this.listeners.push(listener);
  }

  /**
   * 移除变化监听器
   */
  removeChangeListener(listener: DiagnosticsChangeListener): void {
    const index = this.listeners.indexOf(listener);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * 处理诊断变化事件
   */
  private handleDiagnosticsChangeEvent(e: vscode.DiagnosticChangeEvent): void {
    // 收集变化的文件
    for (const uri of e.uris) {
      this.pendingChanges.add(uri.fsPath);
    }

    // 防抖处理 - 避免频繁触发
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.processPendingChanges();
    }, 1000); // 1秒后处理
  }

  /**
   * 处理文件保存事件 - 立即检查
   */
  private async handleFileSaved(document: vscode.TextDocument): Promise<void> {
    this.logger.info(`📁 File saved: ${document.fileName}`);

    // 文件保存是关键时机，立即检查
    await this.processFileChanges([document.uri.fsPath]);
  }

  /**
   * 处理活动编辑器变化
   */
  private handleActiveEditorChange(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    this.logger.debug(`👁️ Active editor changed: ${filePath}`);

    // 延迟检查新打开的文件
    setTimeout(() => {
      this.processPendingChanges();
    }, 500);
  }

  /**
   * 初始化当前诊断状态
   */
  private async initializeCurrentDiagnostics(): Promise<void> {
    const allDiagnostics = vscode.languages.getDiagnostics();

    for (const [uri, diagnostics] of allDiagnostics) {
      const filePath = uri.fsPath;
      const lintDiagnostics = this.convertVSCodeDiagnostics(uri, diagnostics);
      this.fileErrorHistory.set(filePath, lintDiagnostics);
    }

    this.logger.info(`📊 Initialized diagnostics for ${this.fileErrorHistory.size} files`);
  }

  /**
   * 处理待处理的变化
   */
  private async processPendingChanges(): Promise<void> {
    if (this.pendingChanges.size === 0) return;

    const changedFiles = Array.from(this.pendingChanges);
    this.pendingChanges.clear();

    await this.processFileChanges(changedFiles);
  }

  /**
   * 处理文件变化
   */
  private async processFileChanges(filePaths: string[]): Promise<void> {
    const changes: DiagnosticChange[] = [];

    for (const filePath of filePaths) {
      try {
        const uri = vscode.Uri.file(filePath);
        const currentDiagnostics = vscode.languages.getDiagnostics(uri);
        const currentLintDiagnostics = this.convertVSCodeDiagnostics(uri, currentDiagnostics);

        const previousDiagnostics = this.fileErrorHistory.get(filePath) || [];
        const change = this.calculateChange(filePath, previousDiagnostics, currentLintDiagnostics);

        if (this.isSignificantChange(change)) {
          changes.push(change);
        }

        // 更新历史记录
        this.fileErrorHistory.set(filePath, currentLintDiagnostics);

      } catch (error) {
        this.logger.error(`❌ Error processing file ${filePath}`, error instanceof Error ? error : undefined);
      }
    }

    if (changes.length > 0) {
      await this.notifyListeners(changes);
    }
  }

  /**
   * 计算诊断变化
   */
  private calculateChange(
    filePath: string,
    oldDiagnostics: LintDiagnostic[],
    newDiagnostics: LintDiagnostic[]
  ): DiagnosticChange {
    const oldErrors = oldDiagnostics.filter(d => d.severity === 'error');
    const newErrors = newDiagnostics.filter(d => d.severity === 'error');

    const oldErrorCount = oldErrors.length;
    const newErrorCount = newErrors.length;

    // 简化的差异计算 - 可以改进为更精确的匹配
    const addedErrors = newErrors.filter(newErr =>
      !oldErrors.some(oldErr =>
        oldErr.line === newErr.line &&
        oldErr.column === newErr.column &&
        oldErr.message === newErr.message
      )
    );

    const resolvedErrors = oldErrors.filter(oldErr =>
      !newErrors.some(newErr =>
        newErr.line === oldErr.line &&
        newErr.column === oldErr.column &&
        newErr.message === oldErr.message
      )
    );

    let changeType: DiagnosticChange['changeType'];
    if (oldErrorCount === 0 && newErrorCount > 0) {
      changeType = 'degraded';
    } else if (oldErrorCount > 0 && newErrorCount === 0) {
      changeType = 'fixed_file';
    } else if (newErrorCount < oldErrorCount) {
      changeType = 'improved';
    } else if (newErrorCount > oldErrorCount) {
      changeType = 'degraded';
    } else {
      changeType = 'improved'; // 默认假设是改进（如换了不同类型的错误）
    }

    return {
      file: vscode.workspace.asRelativePath(vscode.Uri.file(filePath)),
      oldErrorCount,
      newErrorCount,
      addedErrors,
      resolvedErrors,
      changeType
    };
  }

  /**
   * 判断是否为显著变化
   */
  private isSignificantChange(change: DiagnosticChange): boolean {
    // 只关注错误级别的变化
    const errorCountDelta = Math.abs(change.newErrorCount - change.oldErrorCount);

    // 显著变化的条件：
    // 1. 错误数量变化 >= 1
    // 2. 文件完全修复（从有错误到无错误）
    // 3. 新文件出现错误
    return errorCountDelta >= 1 ||
           change.changeType === 'fixed_file' ||
           (change.oldErrorCount === 0 && change.newErrorCount > 0);
  }

  /**
   * 通知所有监听器
   */
  private async notifyListeners(changes: DiagnosticChange[]): Promise<void> {
    if (changes.length === 0) return;

    this.logger.info(`🔔 Notifying ${this.listeners.length} listeners about ${changes.length} diagnostic changes`);

    for (const listener of this.listeners) {
      try {
        await listener(changes);
      } catch (error) {
        this.logger.error('❌ Error notifying diagnostic change listener', error instanceof Error ? error : undefined);
      }
    }
  }

  /**
   * 转换VSCode诊断为标准格式
   */
  private convertVSCodeDiagnostics(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): LintDiagnostic[] {
    return diagnostics.map(diagnostic => ({
      file: vscode.workspace.asRelativePath(uri),
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      severity: this.convertSeverity(diagnostic.severity),
      message: diagnostic.message,
      source: diagnostic.source || 'unknown',
      code: diagnostic.code?.toString(),
    }));
  }

  /**
   * 转换严重性级别
   */
  private convertSeverity(severity: vscode.DiagnosticSeverity): LintDiagnostic['severity'] {
    switch (severity) {
      case vscode.DiagnosticSeverity.Error: return 'error';
      case vscode.DiagnosticSeverity.Warning: return 'warning';
      case vscode.DiagnosticSeverity.Information: return 'info';
      case vscode.DiagnosticSeverity.Hint: return 'hint';
      default: return 'info';
    }
  }

  /**
   * 获取当前文件的诊断摘要
   */
  async getCurrentDiagnosticsSummary(): Promise<{
    totalFiles: number;
    totalErrors: number;
    totalWarnings: number;
    hotspots: Array<{ file: string; errorCount: number }>;
  }> {
    const allDiagnostics = vscode.languages.getDiagnostics();
    let totalErrors = 0;
    let totalWarnings = 0;
    const fileStats: Array<{ file: string; errorCount: number }> = [];

    for (const [uri, diagnostics] of allDiagnostics) {
      const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
      const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;

      totalErrors += errors;
      totalWarnings += warnings;

      if (errors > 0) {
        fileStats.push({
          file: vscode.workspace.asRelativePath(uri),
          errorCount: errors
        });
      }
    }

    // 按错误数量排序，取前5个热点文件
    const hotspots = fileStats
      .sort((a, b) => b.errorCount - a.errorCount)
      .slice(0, 5);

    return {
      totalFiles: allDiagnostics.length,
      totalErrors,
      totalWarnings,
      hotspots
    };
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.listeners = [];
    this.fileErrorHistory.clear();

    this.logger.info('🧹 DiagnosticsMonitorService disposed');
  }
}