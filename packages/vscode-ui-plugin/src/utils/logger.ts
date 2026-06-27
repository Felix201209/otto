/**
 * Logging utility for the extension
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export class Logger {
  private logLevel: LogLevel = LogLevel.INFO;
  private logFilePath: string;

  constructor(
    private context: vscode.ExtensionContext,
    private outputChannel: vscode.OutputChannel
  ) {
    // Get log level from configuration
    const config = vscode.workspace.getConfiguration('otto');
    const configLevel = config.get<string>('logLevel', 'info');
    this.logLevel = this.parseLogLevel(configLevel);

    // 🎯 设置日志文件路径
    const logDir = path.join(os.homedir(), '.vscode', 'extensions', 'otto-logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.logFilePath = path.join(logDir, 'otto-debug.log');

    // 🗑️ 启动时删除旧日志文件
    try {
      if (fs.existsSync(this.logFilePath)) {
        fs.unlinkSync(this.logFilePath);
      }
      // 写入启动标记
      this.writeToFile(`=== Otto Extension Started at ${new Date().toISOString()} ===\n`);
    } catch (error) {
      // 忽略文件删除错误
    }
  }

  debug(message: string, data?: any) {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: any) {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: any) {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, error?: Error) {
    this.log(LogLevel.ERROR, message, error);
  }

  private log(level: LogLevel, message: string, data?: any) {
    if (level < this.logLevel) {
      return;
    }

    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level];
    const logMessage = `[${timestamp}] [${levelStr}] ${message}`;

    // 输出到VSCode面板
    this.outputChannel.appendLine(logMessage);

    // 🎯 同时写入日志文件
    this.writeToFile(`${logMessage}\n`);

    if (data) {
      let dataStr = '';
      if (data instanceof Error) {
        const errorInfo = `  Error: ${data.message}`;
        this.outputChannel.appendLine(errorInfo);
        dataStr += errorInfo + '\n';
        if (data.stack) {
          const stackInfo = `  Stack: ${data.stack}`;
          this.outputChannel.appendLine(stackInfo);
          dataStr += stackInfo + '\n';
        }
      } else {
        const dataInfo = `  Data: ${JSON.stringify(data, null, 2)}`;
        this.outputChannel.appendLine(dataInfo);
        dataStr += dataInfo + '\n';
      }

      // 写入数据到文件
      this.writeToFile(dataStr);
    }

    // Also log to console in development
    if (this.context.extensionMode === vscode.ExtensionMode.Development) {
      const consoleFn = level === LogLevel.ERROR ? console.error :
                       level === LogLevel.WARN ? console.warn :
                       console.log;
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
      if (data) {
        consoleFn(`[Otto] - ${timeStr} - ${message}`, data);
      } else {
        consoleFn(`[Otto] - ${timeStr} - ${message}`);
      }
    }
  }

  private writeToFile(content: string) {
    try {
      fs.appendFileSync(this.logFilePath, content, 'utf8');
    } catch (error) {
      // 忽略文件写入错误，避免无限递归
    }
  }

  /**
   * 🎯 获取日志文件路径
   */
  getLogFilePath(): string {
    return this.logFilePath;
  }

  private parseLogLevel(level: string): LogLevel {
    switch (level.toLowerCase()) {
      case 'debug': return LogLevel.DEBUG;
      case 'info': return LogLevel.INFO;
      case 'warn': return LogLevel.WARN;
      case 'error': return LogLevel.ERROR;
      default: return LogLevel.INFO;
    }
  }

  dispose() {
    // 写入结束标记
    this.writeToFile(`=== Otto Extension Disposed at ${new Date().toISOString()} ===\n`);
    this.outputChannel.dispose();
  }
}