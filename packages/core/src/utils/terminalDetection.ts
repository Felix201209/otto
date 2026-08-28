/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * 检测当前终端环境
 */

import { execSync } from 'child_process';

interface TerminalInfo {
  platform: string;
  shell?: string;
  terminal?: string;
  version?: string;
}

// 缓存检测结果，避免重复检测
let cachedTerminalInfo: TerminalInfo | null = null;

/**
 * 检测当前的终端和Shell环境
 * @returns TerminalInfo 包含平台、Shell、终端类型等信息
 */
export function detectTerminalEnvironment(): TerminalInfo {
  // 如果已经检测过，直接返回缓存结果
  if (cachedTerminalInfo) {
    return cachedTerminalInfo;
  }

  const platform = process.platform;
  const env = process.env;

  const result: TerminalInfo = {
    platform,
  };

  if (platform === 'win32') {
    // Windows 环境检测：使用进程树扫描准确检测 Shell 类型
    result.shell = detectWindowsShell(env);
    result.terminal = detectWindowsTerminal(env);
  } else if (platform === 'darwin') {
    // macOS 环境检测
    result.shell = detectUnixShell(env);
    result.terminal = detectMacTerminal(env);
  } else {
    // Linux/Unix 环境检测
    result.shell = detectUnixShell(env);
    result.terminal = detectLinuxTerminal(env);
  }

  // 缓存初步结果
  cachedTerminalInfo = result;
  return result;
}

/**
 * 检测 Windows 下的 Shell 类型
 * 使用进程树扫描准确检测，但优化为找到第一个 shell 立即返回
 */
function detectWindowsShell(env: NodeJS.ProcessEnv): string {
  // 首先检查特殊环境（通过环境变量快速判断）
  const hasGitBash = env.MSYSTEM || env.MINGW_PREFIX || env.MSYS2_PATH_TYPE;
  if (hasGitBash) return 'Git Bash (MSYS2)';

  const hasWSL = env.WSL_DISTRO_NAME || (env.WSLENV && env.WSL_INTEROP);
  if (hasWSL) return `WSL (${env.WSL_DISTRO_NAME || 'Unknown Distribution'})`;

  const hasCygwin = !!env.CYGWIN;
  if (hasCygwin) return 'Cygwin';

  // 使用进程树快速查找第一个 shell（找到即返回，不遍历整棵树）
  try {
    const shellFromProcessTree = findFirstShellInProcessTree(process.pid);
    if (shellFromProcessTree) return shellFromProcessTree;
  } catch {
    // 进程树检测失败，继续使用环境变量回退
  }

  // 回退方案：使用环境变量检测（不太可靠，但作为兜底）
  if (env.PSEdition === 'Core') return 'PowerShell Core';
  if (env.__PSHOME || env.POWERSHELL_DISTRIBUTION_CHANNEL) return 'Windows PowerShell';

  return 'Command Prompt (CMD)';
}

/**
 * 快速查找进程树中的第一个 Shell 进程（找到即返回，不继续遍历）
 * 比 findShellInProcessTree 更快，因为不需要遍历整棵树
 * 通常 1-2 层就能找到 shell，最多查 3 层
 */
function findFirstShellInProcessTree(currentPid: number, visited: Set<number> = new Set(), depth: number = 0): string | null {
  // 限制深度为 3 层，通常足够找到 shell，避免耗时过长
  if (depth > 3 || visited.has(currentPid)) {
    return null;
  }

  visited.add(currentPid);

  try {
    const wmicCommand = `wmic process where "ProcessId=${currentPid}" get ParentProcessId,Name /format:value`;
    const result = execSync(wmicCommand, {
      encoding: 'utf8',
      timeout: 1000,  // 缩短超时时间
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const parentPidMatch = result.match(/ParentProcessId=(\d+)/);
    const processNameMatch = result.match(/Name=([^\r\n]+)/);

    if (!parentPidMatch?.[1] || !processNameMatch?.[1]) {
      return null;
    }

    const parentPid = parseInt(parentPidMatch[1], 10);
    const processName = processNameMatch[1].toLowerCase().trim();

    // 检测到 shell 立即返回，不继续向上遍历
    if (processName.includes('powershell.exe')) return 'Windows PowerShell';
    if (processName.includes('pwsh.exe')) return 'PowerShell Core';
    if (processName.includes('cmd.exe')) return 'Command Prompt (CMD)';
    if (processName.includes('bash.exe')) return 'Git Bash';

    // 未找到 shell，继续向上查找父进程
    if (parentPid > 0 && parentPid !== currentPid) {
      return findFirstShellInProcessTree(parentPid, visited, depth + 1);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 检测 Windows 下的终端类型
 */
function detectWindowsTerminal(env: NodeJS.ProcessEnv): string {
  if (env.WT_SESSION || env.WT_PROFILE_ID) return 'Windows Terminal';
  if (env.VSCODE_PID || env.TERM_PROGRAM === 'vscode') return 'VS Code Integrated Terminal';
  if (env.ConEmuPID || env.ConEmuWorkDir) return 'ConEmu';
  if (env.CMDER_ROOT) return 'Cmder';
  if (env.HYPER) return 'Hyper';
  if (env.TERMINAL_EMULATOR?.includes('JetBrains')) return 'JetBrains IDE Terminal';
  return 'Windows Console Host';
}

/**
 * 检测 Unix/Linux 下的 Shell 类型
 */
function detectUnixShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL || '';
  if (shell.includes('bash')) return 'Bash';
  if (shell.includes('zsh')) return 'Zsh';
  if (shell.includes('fish')) return 'Fish';
  if (shell.includes('tcsh')) return 'Tcsh';
  if (shell.includes('csh')) return 'Csh';
  if (shell.includes('sh')) return 'Sh';
  return shell || 'Unknown Shell';
}

/**
 * 检测 macOS 下的终端类型
 */
function detectMacTerminal(env: NodeJS.ProcessEnv): string {
  if (env.ITERM_SESSION_ID || env.TERM_PROGRAM === 'iTerm.app') return 'iTerm2';
  if (env.TERM_PROGRAM === 'Apple_Terminal') return 'Apple Terminal';
  if (env.VSCODE_PID || env.TERM_PROGRAM === 'vscode') return 'VS Code Integrated Terminal';
  if (env.HYPER) return 'Hyper';
  if (env.TERM_PROGRAM === 'WarpTerminal') return 'Warp';
  return env.TERM_PROGRAM || 'Unknown Terminal';
}

/**
 * 检测 Linux 下的终端类型
 */
function detectLinuxTerminal(env: NodeJS.ProcessEnv): string {
  if (env.VSCODE_PID || env.TERM_PROGRAM === 'vscode') return 'VS Code Integrated Terminal';
  if (env.GNOME_TERMINAL_SERVICE || env.VTE_VERSION) return 'GNOME Terminal';
  if (env.KONSOLE_VERSION) return 'Konsole';
  if (env.TERMINATOR_UUID) return 'Terminator';
  if (env.TILIX_ID) return 'Tilix';
  if (env.KITTY_WINDOW_ID) return 'Kitty';
  if (env.ALACRITTY_SOCKET) return 'Alacritty';
  return env.TERM || 'Unknown Terminal';
}

/**
 * 格式化终端信息为字符串
 */
export function formatTerminalInfo(info: TerminalInfo): string {
  const parts: string[] = [info.platform];
  if (info.terminal) parts.push(`terminal: ${info.terminal}`);
  if (info.shell) parts.push(`shell: ${info.shell}`);
  if (info.version) parts.push(`version: ${info.version}`);
  return parts.join(', ');
}
