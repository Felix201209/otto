/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import * as readline from 'node:readline';
import { execSync } from 'node:child_process';

/**
 * 启动时触发简单的resize模拟
 */
function triggerStartupResize(): void {
  if (!process.stdout.isTTY) return;
  
  const originalColumns = process.stdout.columns || 80;
  const originalRows = process.stdout.rows || 24;
  
  // 简单的resize模拟：暂时调整为略小的尺寸再恢复
  setTimeout(() => {
    // 修改为略小的尺寸
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns - 1,
      writable: true,
      configurable: true
    });
    
    // 触发resize事件
    process.stdout.emit('resize');
    
    // 100ms后恢复原始尺寸
    setTimeout(() => {
      Object.defineProperty(process.stdout, 'columns', {
        value: originalColumns,
        writable: true,
        configurable: true
      });
      
      // 再次触发resize事件
      process.stdout.emit('resize');
    }, 100);
  }, 300);
}

/**
 * 创建优化的readline接口，专门处理中文输入法等问题
 * 
 * 优化点：
 * 1. 检测中文环境，适当调整terminal选项
 * 2. 设置更长的escape code timeout来处理复杂输入序列
 * 3. 在小窗口环境下禁用某些TTY特性来减少重绘
 * 4. 特殊处理输入法候选区域引起的终端宽度变化
 */
export function createOptimizedReadlineInterface(
  options: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    completer?: readline.Completer | readline.AsyncCompleter;
    terminal?: boolean;
    historySize?: number;
    prompt?: string;
    crlfDelay?: number;
    removeHistoryDuplicates?: boolean;
    escapeCodeTimeout?: number;
    tabSize?: number;
    signal?: AbortSignal;
  } = {}
): readline.Interface {
  
  // 检测是否是中文环境
  const isChineseEnvironment = detectChineseEnvironment();
  
  // 检测是否是小窗口环境
  const isSmallWindow = detectSmallWindow();
  
  // 🔧 检测是否是SSH/WSL环境
  const isSSHOrWSL = detectSSHOrWSLEnvironment();
  
  // 基础配置
  const baseOptions = {
    input: process.stdin,
    output: process.stdout,
    escapeCodeTimeout: 500, // 默认值
    ...options,
  };
  
  // 🔧 SSH/WSL环境优化
  if (isSSHOrWSL) {
    // SSH/WSL环境需要更长的escape code timeout来处理网络延迟
    baseOptions.escapeCodeTimeout = Math.max(baseOptions.escapeCodeTimeout || 500, 1000);
    
    // 在SSH/WSL环境中禁用某些终端特性以提高兼容性
    if (isSmallWindow || !process.stdout.isTTY) {
      baseOptions.terminal = false;
    }
    
    // 减少历史记录以节省内存和提高响应速度
    baseOptions.historySize = Math.min(baseOptions.historySize || 30, 10);
  }
  
  // 中文输入法激进优化
  if (isChineseEnvironment) {
    // 大幅增加escape code timeout以处理长候选列表
    baseOptions.escapeCodeTimeout = Math.max(baseOptions.escapeCodeTimeout || 500, 2000);
    
    // 在任何可能有输入法干扰的环境下都禁用terminal模式
    if (isSmallWindow || isSSHOrWSL || process.env.TERM_PROGRAM) {
      // 完全禁用terminal模式来避免实时光标位置跟踪
      baseOptions.terminal = false;
    }
  }
  
  // 小窗口激进优化
  if (isSmallWindow) {
    // 最小化历史记录
    baseOptions.historySize = 0;
    
    // 增加CRLF延迟
    baseOptions.crlfDelay = 300;
    
    // 在IDE环境或SSH/WSL中强制禁用terminal模式
    if (process.env.TERM_PROGRAM || process.env.VSCODE_PID || isSSHOrWSL) {
      baseOptions.terminal = false;
    }
  }
  
  // 在IDE环境中，只执行启动时的resize模拟
  const isIDEEnvironment = !!(
    process.env.TERM_PROGRAM || 
    process.env.VSCODE_PID || 
    process.env.TERMINAL_EMULATOR
  );
  
  if (isIDEEnvironment) {
    // 🎯 只保留启动时的resize模拟，去掉其他输入法校准功能
    triggerStartupResize();
  }
  
  // 使用标准的readline接口创建方法
  const rl = readline.createInterface(baseOptions);
  
  // 为中文环境添加额外的输入法处理（仅在非IDE环境）
  if (isChineseEnvironment && !isIDEEnvironment && baseOptions.terminal !== false) {
    setupInputMethodHandling(rl);
  }
  
  // 设置readline事件处理
  setupReadlineEvents(rl, isIDEEnvironment);
  
  return rl;
}

/**
 * 设置输入法特殊处理
 */
function setupInputMethodHandling(rl: readline.Interface): void {
  // 保存原始的终端宽度
  let originalColumns = process.stdout.columns;
  let inputMethodActive = false;
  let stabilizeTimer: NodeJS.Timeout | null = null;
  
  // 监听标准输入的原始数据，检测输入法状态
  if (process.stdin.isTTY) {
    const originalStdin = process.stdin;
    
    // 检测可能的输入法激活序列
    originalStdin.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      
      // 检测可能的输入法控制序列或非ASCII字符序列
      const hasInputMethodSequence = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(data) ||
        data.includes('\x1b[') || // ANSI escape sequences
        data.length > 1 && !/^[\x20-\x7e\r\n\t]+$/.test(data); // 非简单ASCII
      
      if (hasInputMethodSequence) {
        inputMethodActive = true;
        
        // 清除之前的定时器
        if (stabilizeTimer) {
          clearTimeout(stabilizeTimer);
        }
        
        // 设置输入法稳定化定时器
        stabilizeTimer = setTimeout(() => {
          inputMethodActive = false;
          // 检查终端宽度是否需要恢复
          if (process.stdout.columns !== originalColumns) {
            originalColumns = process.stdout.columns || originalColumns;
          }
        }, 1000); // 1秒后认为输入法稳定
      }
    });
  }
  
  // 拦截并过滤可能由输入法引起的resize事件
  const originalResizeHandler = process.stdout.listeners('resize');
  process.stdout.removeAllListeners('resize');
  
  process.stdout.on('resize', () => {
    // 如果输入法正在活动，延迟处理resize事件
    if (inputMethodActive) {
      setTimeout(() => {
        // 再次检查输入法状态
        if (!inputMethodActive) {
          originalResizeHandler.forEach(handler => {
            if (typeof handler === 'function') {
              handler();
            }
          });
        }
      }, 500);
    } else {
      // 立即处理resize事件
      originalResizeHandler.forEach(handler => {
        if (typeof handler === 'function') {
          handler();
        }
      });
    }
  });
}

/**
 * 检测是否是中文环境
 */
function detectChineseEnvironment(): boolean {
  const locale = process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE || '';
  const language = process.env.LANGUAGE || '';
  
  // 检查环境变量
  if (locale.toLowerCase().includes('zh') || 
      locale.toLowerCase().includes('chinese') ||
      language.toLowerCase().includes('zh')) {
    return true;
  }
  
  // 检查系统语言设置（Windows）
  if (process.platform === 'win32') {
    try {
      const systemLocale = execSync('powershell -Command "Get-Culture | Select-Object -ExpandProperty Name"', 
        { encoding: 'utf8', timeout: 1000 }).toString().trim();
      
      if (systemLocale.toLowerCase().includes('zh')) {
        return true;
      }
    } catch {
      // 忽略错误，继续其他检测
    }
  }
  
  return false;
}

/**
 * 检测是否是SSH/WSL环境
 */
function detectSSHOrWSLEnvironment(): boolean {
  // 🔧 支持手动启用SSH/WSL兼容模式
  if (process.env.DEEPV_SSH_MODE === '1' || process.env.DEEPV_SSH_MODE === 'true') {
    return true;
  }
  
  return !!(
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY ||
    process.env.SSH_CONNECTION ||
    process.env.WSL_DISTRO_NAME ||
    process.env.WSL_INTEROP ||
    process.env.WSLENV ||
    (process.env.TERM && process.env.TERM.includes('screen')) ||
    (process.env.TERM && process.env.TERM.includes('tmux')) ||
    (process.env.TERM && process.env.TERM.includes('linux')) ||
    process.env.REMOTE_CONTAINERS // Docker容器环境
  );
}

/**
 * 检测是否是IDEA/IntelliJ环境
 */
function detectIDEAEnvironment(): boolean {
  return !!(
    process.env.TERMINAL_EMULATOR && (
      process.env.TERMINAL_EMULATOR.includes('JetBrains') ||
      process.env.TERMINAL_EMULATOR.includes('IntelliJ') ||
      process.env.TERMINAL_EMULATOR.includes('IDEA')
    ) ||
    // 检测IDEA相关的环境变量
    process.env.IDEA_INITIAL_DIRECTORY ||
    process.env.JETBRAINS_IDE ||
    // 检测通过特定的Terminal设置
    (process.env.TERM_PROGRAM && process.env.TERM_PROGRAM.includes('jetbrains'))
  );
}

/**
 * 检测是否是小窗口环境
 */
function detectSmallWindow(): boolean {
  const columns = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  
  // 基于实际项目的阈值
  return columns <= 80 || rows <= 30;
}

/**
 * 设置readline事件处理
 */
function setupReadlineEvents(rl: readline.Interface, isIDEEnvironment: boolean): void {
  if (!isIDEEnvironment) return;
  
  // 在用户开始输入时执行轻量级校准
  const originalPrompt = rl.prompt.bind(rl);
  rl.prompt = function(preserveCursor?: boolean) {
    // 移除lightweightCalibration调用，避免干扰光标位置
    return originalPrompt(preserveCursor);
  };
}

/**
 * 创建专门用于确认对话框的readline接口
 * 进一步优化以减少重绘和闪烁
 */
export function createConfirmationReadlineInterface(
  options: Parameters<typeof createOptimizedReadlineInterface>[0] = {}
): readline.Interface {
  
  const isSmallWindow = detectSmallWindow();
  
  // 确认对话框的特殊优化
  const confirmationOptions = {
    ...options,
    // 禁用历史记录（确认对话框不需要）
    historySize: 0,
    // 使用更长的超时避免输入法干扰
    escapeCodeTimeout: 1500,
  };
  
  // 在极小窗口下完全禁用terminal模式
  if (isSmallWindow && (process.stdout.rows || 24) <= 15) {
    confirmationOptions.terminal = false;
  }
  
  const rl = createOptimizedReadlineInterface(confirmationOptions);
  
  // 确认对话框立即执行轻量级校准
  const isIDEEnvironment = !!(
    process.env.TERM_PROGRAM || 
    process.env.VSCODE_PID || 
    process.env.TERMINAL_EMULATOR
  );
  
  // 移除IDE环境下的额外校准调用
  
  return rl;
}