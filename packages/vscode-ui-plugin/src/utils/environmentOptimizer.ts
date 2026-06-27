/**
 * Environment Detection Optimizer - 环境检测优化器
 *
 * 针对VSCode插件环境优化终端检测，避免不必要的进程树遍历
 *
 * @license Apache-2.0
 * Copyright 2025 Felix
 */

import * as vscode from 'vscode';

interface OptimizedTerminalInfo {
  platform: string;
  shell?: string;
  terminal?: string;
  isVSCode: boolean;
  skipProcessDetection: boolean;
}

class EnvironmentOptimizer {
  private static cachedInfo: OptimizedTerminalInfo | null = null;
  private static logger: any = null;

  /**
   * 设置 logger 引用（在 logger 初始化后调用）
   */
  static setLogger(logger: any): void {
    this.logger = logger;
  }

  /**
   * 获取优化后的环境信息
   * 在VSCode插件环境中跳过昂贵的进程树检测
   */
  static getOptimizedEnvironment(): OptimizedTerminalInfo {
    if (this.cachedInfo) {
      const msg = '[EnvOptimizer] Using cached environment info';
      if (this.logger) {
        this.logger.debug(msg);
      } else {
        console.log(`🚀 ${msg}`);
      }
      return this.cachedInfo;
    }

    const msg = '[EnvOptimizer] Detecting environment...';
    if (this.logger) {
      this.logger.debug(msg);
    } else {
      console.log(`🔍 ${msg}`);
    }

    const isVSCode = this.isVSCodeEnvironment();
    const platform = process.platform;

    let optimizedInfo: OptimizedTerminalInfo = {
      platform,
      isVSCode,
      skipProcessDetection: isVSCode // 在VSCode中跳过进程检测
    };

    if (isVSCode) {
      // 在VSCode环境中，使用简化的检测逻辑
      optimizedInfo = this.getVSCodeOptimizedInfo(optimizedInfo);
      const msg = '[EnvOptimizer] VSCode environment detected, skipping process tree detection';
      if (this.logger) {
        this.logger.info(msg);
      } else {
        console.log(`✅ ${msg}`);
      }
    } else {
      // 非VSCode环境，使用默认检测
      const msg = '[EnvOptimizer] Non-VSCode environment, will use full detection';
      if (this.logger) {
        this.logger.debug(msg);
      } else {
        console.log(`🔍 ${msg}`);
      }
    }

    this.cachedInfo = optimizedInfo;
    return optimizedInfo;
  }

  /**
   * 检测是否在VSCode环境中运行
   */
  private static isVSCodeEnvironment(): boolean {
    try {
      // 检查VSCode API是否可用
      const hasVSCode = typeof vscode !== 'undefined';

      // 检查环境变量
      const env = process.env;
      const hasVSCodePID = !!(env.VSCODE_PID);
      const hasVSCodeTerm = env.TERM_PROGRAM === 'vscode';
      const hasVSCodeIDE = !!(env.VSCODE_IPC_HOOK || env.VSCODE_IPC_HOOK_CLI);

      const isVSCode = hasVSCode || hasVSCodePID || hasVSCodeTerm || hasVSCodeIDE;

      const msg = `[EnvOptimizer] VSCode detection: ${JSON.stringify({
        hasVSCode,
        hasVSCodePID,
        hasVSCodeTerm,
        hasVSCodeIDE,
        result: isVSCode
      })}`;
      if (this.logger) {
        this.logger.debug(msg);
      } else {
        console.log(`🔍 ${msg}`);
      }

      return isVSCode;
    } catch (error) {
      const msg = `[EnvOptimizer] Error detecting VSCode environment: ${error}`;
      if (this.logger) {
        this.logger.warn(msg);
      } else {
        console.warn(`⚠️ ${msg}`);
      }
      return false;
    }
  }

  /**
   * 获取VSCode环境的优化信息
   */
  private static getVSCodeOptimizedInfo(baseInfo: OptimizedTerminalInfo): OptimizedTerminalInfo {
    const env = process.env;

    // 在VSCode中，我们可以安全地假设一些默认值
    let shell: string;
    let terminal = 'VS Code Integrated Terminal';

    if (baseInfo.platform === 'win32') {
      // Windows环境 - 使用简化检测
      if (env.PSModulePath) {
        shell = env.PSEdition === 'Core' ? 'PowerShell Core' : 'Windows PowerShell';
      } else {
        shell = 'Command Prompt (CMD)';
      }
    } else if (baseInfo.platform === 'darwin') {
      // macOS环境
      shell = env.SHELL?.includes('zsh') ? 'Zsh' :
             env.SHELL?.includes('bash') ? 'Bash' :
             env.SHELL || 'Unknown Shell';
    } else {
      // Linux/Unix环境
      shell = env.SHELL?.includes('bash') ? 'Bash' :
             env.SHELL?.includes('zsh') ? 'Zsh' :
             env.SHELL || 'Unknown Shell';
    }

    const msg = `[EnvOptimizer] VSCode optimized detection: ${shell} in ${terminal}`;
    if (this.logger) {
      this.logger.debug(msg);
    } else {
      console.log(`🎯 ${msg}`);
    }

    return {
      ...baseInfo,
      shell,
      terminal
    };
  }

  /**
   * 检查是否应该跳过进程检测
   */
  static shouldSkipProcessDetection(): boolean {
    const info = this.getOptimizedEnvironment();
    return info.skipProcessDetection;
  }

  /**
   * 获取格式化的环境信息字符串
   */
  static getFormattedInfo(): string {
    const info = this.getOptimizedEnvironment();
    const parts = [info.platform];

    if (info.terminal) {
      parts.push(`terminal: ${info.terminal}`);
    }

    if (info.shell) {
      parts.push(`shell: ${info.shell}`);
    }

    if (info.isVSCode) {
      parts.push('(VSCode optimized)');
    }

    return parts.join(', ');
  }

  /**
   * 重置缓存（用于测试或强制重新检测）
   */
  static resetCache(): void {
    const msg = '[EnvOptimizer] Cache reset';
    if (this.logger) {
      this.logger.debug(msg);
    } else {
      console.log(`🔄 ${msg}`);
    }
    this.cachedInfo = null;
  }

  /**
   * 安装全局优化器（修改全局环境变量以指示跳过检测）
   */
  static installGlobalOptimization(): void {
    const info = this.getOptimizedEnvironment();

    if (info.skipProcessDetection) {
      // 设置环境变量，让otto-core知道跳过进程检测
      process.env.OTTO_SKIP_PROCESS_DETECTION = 'true';
      process.env.OTTO_OPTIMIZED_SHELL = info.shell || 'Unknown';
      process.env.OTTO_OPTIMIZED_TERMINAL = info.terminal || 'Unknown';

      const msg = '[EnvOptimizer] Global optimization installed - process detection will be skipped';
      if (this.logger) {
        this.logger.info(msg);
      } else {
        console.log(`⚡ ${msg}`);
      }
    }
  }
}

export { EnvironmentOptimizer };