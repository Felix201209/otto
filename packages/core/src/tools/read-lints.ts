/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { BaseTool, Icon, ToolResult } from './tools.js';
import { Type } from '@google/genai';
import { Config } from '../config/config.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/enhancedLogger.js';

// Lint诊断数据模型
export interface LintDiagnostic {
  file: string;          // 文件路径
  line: number;          // 行号
  column: number;        // 列号
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;       // 错误信息
  source: string;        // 来源（如 'eslint', 'typescript'）
  code?: string;         // 错误代码
}

// ReadLints工具参数接口
export interface ReadLintsParams {
  paths?: string[];  // 可选的文件或目录路径数组
}

// ReadLints回调函数类型
export type ReadLintsCallback = (paths?: string[]) => Promise<LintDiagnostic[]>;

/**
 * ReadLints工具 - 读取和显示当前工作区的linter错误
 */
export class ReadLintsTool extends BaseTool<ReadLintsParams, ToolResult> {
  static readonly Name = 'read_lints';

  // 静态回调函数，由VSCode扩展初始化时设置
  private static callback: ReadLintsCallback | null = null;

  constructor(private readonly config: Config) {
    super(
      ReadLintsTool.Name,
      'ReadLints',
      'Read and display linter errors from the current workspace. You can provide paths to specific files or directories, or omit the argument to get diagnostics for all files.\n\n- If a file path is provided, returns diagnostics for that file only\n- If a directory path is provided, returns diagnostics for all files within that directory\n- If no path is provided, returns diagnostics for all files in the workspace\n- This tool can return linter errors that were already present before your edits, so avoid calling it with a very wide scope of files\n- NEVER call this tool on a file unless you\'ve edited it or are about to edit it',
      Icon.FileSearch,
      {
        type: Type.OBJECT,
        properties: {
          paths: {
            description: 'Optional. An array of paths to files or directories to read linter errors for. You can use either relative paths in the workspace or absolute paths. If provided, returns diagnostics for the specified files/directories only. If not provided, returns diagnostics for all files in the workspace.',
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
          },
        },
        required: [],
      },
      true, // 支持 markdown 输出
      true, // 强制 markdown 渲染，即使在高度限制下
    );
  }

  /**
   * 设置linter回调函数（由VSCode扩展调用）
   */
  static setCallback(callback: ReadLintsCallback): void {
    ReadLintsTool.callback = callback;
  }

  /**
   * 获取当前设置的回调函数
   */
  static getCallback(): ReadLintsCallback | null {
    return ReadLintsTool.callback;
  }

  /**
   * 验证工具参数
   */
  validateToolParams(params: ReadLintsParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params, ReadLintsTool.Name);
    if (errors) {
      return errors;
    }

    // 验证paths参数
    if (params.paths) {
      if (!Array.isArray(params.paths)) {
        return 'paths must be an array';
      }

      for (const path of params.paths) {
        if (typeof path !== 'string' || path.trim().length === 0) {
          return 'All paths must be non-empty strings';
        }
      }
    }

    return null;
  }

  /**
   * 执行工具操作
   */
  async execute(params: ReadLintsParams, signal: AbortSignal): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: `Parameter validation failed: ${validationError}`,
      };
    }

    // 检查是否有可用的回调函数
    if (!ReadLintsTool.callback) {
      const errorMsg = 'ReadLints callback not initialized. This tool requires VSCode extension integration.';
      return {
        llmContent: `Error: ${errorMsg}`,
        returnDisplay: errorMsg,
      };
    }

    try {
      // 调用VSCode扩展提供的回调函数获取linter诊断信息
      const diagnostics = await ReadLintsTool.callback(params.paths);

      logger.info(`[ReadLintsTool] Retrieved ${diagnostics.length} lint diagnostics`);

      // 按严重性和文件分组
      const groupedDiagnostics = this.groupDiagnostics(diagnostics);

      // 生成输出内容
      const output = this.formatDiagnostics(groupedDiagnostics, params.paths);
      const aiOutput = this.formatDiagnosticsForAI(groupedDiagnostics);

      // 统计信息
      const stats = this.generateStats(diagnostics);
      const summary = this.generateSummary(stats, params.paths);

      return {
        summary,
        llmContent: aiOutput,
        returnDisplay: output,
      };

    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error(`[ReadLintsTool] Error reading lints: ${errorMessage}`);

      return {
        llmContent: `Error reading linter diagnostics: ${errorMessage}`,
        returnDisplay: `Operation failed: ${errorMessage}`,
      };
    }
  }

  /**
   * 格式化诊断信息输出 (AI 专用，遵循 reference 建议)
   */
  private formatDiagnosticsForAI(groupedDiagnostics: Record<string, LintDiagnostic[]>): string {
    const files = Object.keys(groupedDiagnostics);
    if (files.length === 0) return '✅ No linter errors found.';

    let output = '';
    for (const file of files) {
      const diagnostics = groupedDiagnostics[file];
      output += `<file_diagnostics path="${file}">\n`;
      for (const d of diagnostics) {
        const severityStr = d.severity === 'error' ? 'Error' : d.severity.charAt(0).toUpperCase() + d.severity.slice(1);
        output += `[Line ${d.line}] ${severityStr}: ${d.message}${d.code ? ` (${d.code})` : ''}\n`;
      }
      output += `</file_diagnostics>\n`;
    }
    return output.trim();
  }

  /**
   * 按文件和严重性分组诊断信息
   */
  private groupDiagnostics(diagnostics: LintDiagnostic[]): Record<string, LintDiagnostic[]> {
    const grouped: Record<string, LintDiagnostic[]> = {};

    for (const diagnostic of diagnostics) {
      if (!grouped[diagnostic.file]) {
        grouped[diagnostic.file] = [];
      }
      grouped[diagnostic.file].push(diagnostic);
    }

    // 对每个文件内的诊断按行号排序
    Object.keys(grouped).forEach(file => {
      grouped[file].sort((a, b) => a.line - b.line || a.column - b.column);
    });

    return grouped;
  }

  /**
   * 格式化诊断信息输出
   */
  private formatDiagnostics(
    groupedDiagnostics: Record<string, LintDiagnostic[]>,
    requestedPaths?: string[]
  ): string {
    const files = Object.keys(groupedDiagnostics);

    if (files.length === 0) {
      const scope = requestedPaths?.length
        ? `for specified paths: ${requestedPaths.join(', ')}`
        : 'in workspace';
      return `✅ No linter errors found ${scope}`;
    }

    let output = '## Linter Diagnostics\n\n';

    // 按错误数量倒序排列文件
    const sortedFiles = files.sort((a, b) => {
      const aErrors = groupedDiagnostics[a].filter(d => d.severity === 'error').length;
      const bErrors = groupedDiagnostics[b].filter(d => d.severity === 'error').length;
      return bErrors - aErrors;
    });

    for (const file of sortedFiles) {
      const diagnostics = groupedDiagnostics[file];
      const errors = diagnostics.filter(d => d.severity === 'error');
      const warnings = diagnostics.filter(d => d.severity === 'warning');
      const others = diagnostics.filter(d => d.severity !== 'error' && d.severity !== 'warning');

      output += `### 📄 ${file}\n`;
      output += `*${errors.length} errors, ${warnings.length} warnings, ${others.length} others*\n\n`;

      for (const diagnostic of diagnostics) {
        const icon = this.getSeverityIcon(diagnostic.severity);
        const location = `${diagnostic.line}:${diagnostic.column}`;
        const codeStr = diagnostic.code ? ` (${diagnostic.code})` : '';
        const sourceStr = diagnostic.source ? ` [${diagnostic.source}]` : '';

        output += `${icon} **Line ${location}**: ${diagnostic.message}${codeStr}${sourceStr}\n`;
      }

      output += '\n';
    }

    return output.trim();
  }

  /**
   * 获取严重性图标
   */
  private getSeverityIcon(severity: LintDiagnostic['severity']): string {
    switch (severity) {
      case 'error': return '❌';
      case 'warning': return '⚠️';
      case 'info': return 'ℹ️';
      case 'hint': return '💡';
      default: return '📝';
    }
  }

  /**
   * 生成统计信息
   */
  private generateStats(diagnostics: LintDiagnostic[]): {
    total: number;
    errors: number;
    warnings: number;
    infos: number;
    hints: number;
    files: number;
  } {
    const fileSet = new Set(diagnostics.map(d => d.file));

    return {
      total: diagnostics.length,
      errors: diagnostics.filter(d => d.severity === 'error').length,
      warnings: diagnostics.filter(d => d.severity === 'warning').length,
      infos: diagnostics.filter(d => d.severity === 'info').length,
      hints: diagnostics.filter(d => d.severity === 'hint').length,
      files: fileSet.size,
    };
  }

  /**
   * 生成简要摘要
   */
  private generateSummary(
    stats: ReturnType<typeof this.generateStats>,
    requestedPaths?: string[]
  ): string {
    if (stats.total === 0) {
      const scope = requestedPaths?.length ? 'specified paths' : 'workspace';
      return `No linter errors found in ${scope}`;
    }

    const parts: string[] = [];
    if (stats.errors > 0) parts.push(`${stats.errors} errors`);
    if (stats.warnings > 0) parts.push(`${stats.warnings} warnings`);
    if (stats.infos + stats.hints > 0) parts.push(`${stats.infos + stats.hints} others`);

    const scope = requestedPaths?.length
      ? `in ${requestedPaths.length} specified path${requestedPaths.length > 1 ? 's' : ''}`
      : `across ${stats.files} files`;

    return `Found ${parts.join(', ')} ${scope}`;
  }

  /**
   * 获取操作描述
   */
  getDescription(params: ReadLintsParams): string {
    if (params.paths?.length) {
      return `Read linter diagnostics for ${params.paths.length} specified path${params.paths.length > 1 ? 's' : ''}`;
    }
    return 'Read linter diagnostics for all files in workspace';
  }
}