/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { Config } from '../config/config.js';

/**
 * 新品牌 npm 包名与全局命令名。
 * 自更新固定从 npm 拉取 latest，并以飞书常驻模式重新拉起。
 */
export const SELF_UPDATE_PACKAGE = 'otto-ai';
export const SELF_UPDATE_RELAUNCH_COMMAND = 'otto';
export const SELF_UPDATE_RELAUNCH_ARGS = ['--feishu'];

/**
 * 安装模式（三选一）：
 *  - none：仅重启，不安装任何东西（用于 /feishu restart 热重启救卡死）
 *  - npm：全局安装 <packageName>@latest
 *  - tgz：全局安装一个本地 .tgz 绝对路径
 */
export type RelaunchInstallMode =
  | { type: 'none' }
  | { type: 'npm'; packageName: string }
  | { type: 'tgz'; path: string };

export interface BuildRelaunchScriptOptions {
  /** 父 CLI 进程 PID —— 外挂会轮询它消失后再操作，避免文件占用。 */
  parentPid: number;
  /** 安装模式。 */
  install: RelaunchInstallMode;
  /** 重新拉起的命令（全局 bin 名）。Windows 下通过 cmd.exe 执行，非 Windows 下通过 login shell 执行。 */
  relaunchCommand: string;
  /** 重新拉起的参数。 */
  relaunchArgs: string[];
  /** 外挂脚本自身的绝对路径（用于结束时自删）。 */
  scriptPath: string;
  /** 重启日志路径。提供后 relaunch 的 stdout/stderr 会重定向到此文件，便于排障。 */
  logPath?: string;
}

/**
 * 生成跨平台的"重启外挂"脚本内容（纯 JS）。
 *
 * 外挂生命周期：
 *   1) 轮询父 PID，直到父进程退出（process.kill(pid, 0) 抛 ESRCH 即已退出）
 *   2) 按 install 模式安装（none 跳过 / npm latest / 本地 tgz）
 *   3) 拉起新进程：
 *      - Windows: cmd.exe /c <command>（有 conpty，用户可见 TUI）
 *      - Linux/macOS: node <entryScript> <args>（绝对路径自举，不依赖 PATH）
 *   4) 删除自身临时脚本
 *
 * 同一套脚本被 SelfUpdateTool（更新+重启 / 仅重启）与 /feishu restart 共用。
 * 纯函数，只产字符串，便于单测。
 */
export function buildRelaunchScript(opts: BuildRelaunchScriptOptions): string {
  const {
    parentPid,
    install,
    relaunchCommand,
    relaunchArgs,
    scriptPath,
    logPath,
  } = opts;

  const PARENT_PID = JSON.stringify(parentPid);
  const RELAUNCH_CMD = JSON.stringify(relaunchCommand);
  const RELAUNCH_ARGS = JSON.stringify(relaunchArgs);
  const SCRIPT_PATH = JSON.stringify(scriptPath);
  const LOG_PATH = JSON.stringify(logPath ?? null);

  // 依据安装模式，生成 npm install 的参数数组（或空表示跳过）。
  let INSTALL_ARGS = 'null';
  if (install.type === 'npm') {
    INSTALL_ARGS = JSON.stringify(['install', '-g', `${install.packageName}@latest`]);
  } else if (install.type === 'tgz') {
    INSTALL_ARGS = JSON.stringify(['install', '-g', install.path]);
  }

  return `'use strict';
// Otto relaunch helper (auto-generated, cross-platform)
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');

const PARENT_PID = ${PARENT_PID};
const INSTALL_ARGS = ${INSTALL_ARGS}; // null = skip install (restart only)
const RELAUNCH_CMD = ${RELAUNCH_CMD};
const RELAUNCH_ARGS = ${RELAUNCH_ARGS};
const SCRIPT_PATH = ${SCRIPT_PATH};
const LOG_PATH = ${LOG_PATH};

function findLoginShell() {
  // 优先级：bash > zsh > sh（均为 login shell -l，加载 .bashrc/.profile 等）
  var candidates = ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/bin/sh'];
  for (var i = 0; i < candidates.length; i++) {
    try {
      fs.accessSync(candidates[i], fs.constants.X_OK);
      return candidates[i];
    } catch (_) { /* not found or not executable */ }
  }
  return '/bin/sh'; // 最终兜底
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg) {
  if (!LOG_PATH) return;
  try {
    fs.appendFileSync(LOG_PATH, '[' + new Date().toISOString() + '] ' + msg + '\\n');
  } catch (_) { /* best-effort */ }
}

function cleanupSelf() {
  try { fs.unlinkSync(SCRIPT_PATH); } catch (_) { /* temp dir cleanup */ }
}

async function main() {
  log('[Relauncher] Helper started. Polling parent PID ' + PARENT_PID + '...');

  // 1) 轮询父进程退出（最多 ~30s）
  const deadline = Date.now() + 30000;
  while (isAlive(PARENT_PID) && Date.now() < deadline) {
    await sleep(300);
  }
  log('[Relauncher] Parent exited or timeout.');

  // 2) 按需安装
  if (INSTALL_ARGS) {
    log('[Relauncher] Installing: npm ' + INSTALL_ARGS.join(' '));
    const install = spawnSync('npm', INSTALL_ARGS, { stdio: 'ignore', shell: true });
    log('[Relauncher] Install done, status=' + install.status);
    if (install.status !== 0) {
      log('[Relauncher] ERROR: Install failed.');
      cleanupSelf();
      process.exit(install.status || 1);
    }
  }

  // 3) 准备 stdio
  let stdio = 'ignore';
  if (LOG_PATH) {
    try {
      const fd = fs.openSync(LOG_PATH, 'a');
      stdio = ['ignore', fd, fd];
    } catch (_) { stdio = 'ignore'; }
  }

  // 4) 拉起新进程
  //    Windows: cmd.exe /c <command>（有 conpty，用户可见 TUI）
  //    Linux/macOS: login shell -l -c <command>（加载 .bashrc/.profile，
  //      使 nvm/homebrew 等 PATH 生效，确保 otto 命令可找到）
  const env = Object.assign({}, process.env, { EASYCODE_STARTUP_DELAY_MS: '2000' });
  let child;

  if (process.platform === 'win32') {
    const fullCmd = [RELAUNCH_CMD].concat(RELAUNCH_ARGS).join(' ');
    log('[Relauncher] Spawning child (cmd.exe): ' + fullCmd);
    child = spawn('cmd.exe', ['/c', fullCmd], {
      detached: true,
      stdio: stdio,
      env: env,
    });
  } else {
    // 非 Windows：用 login shell 确保用户环境（nvm/homebrew 等 PATH）完整加载。
    // bash -l 优先（最常见），zsh -l 兜底，最终 /bin/sh -l 保底。
    const shellCmd = findLoginShell();
    const fullCmd = [RELAUNCH_CMD].concat(RELAUNCH_ARGS).join(' ');
    log('[Relauncher] Spawning child (login shell): ' + shellCmd + ' -l -c ' + fullCmd);
    child = spawn(shellCmd, ['-l', '-c', fullCmd], {
      detached: true,
      stdio: stdio,
      env: env,
    });
  }

  child.on('error', (err) => {
    log('[Relauncher] Spawn error: ' + (err && err.message ? err.message : String(err)));
    cleanupSelf();
    process.exit(1);
  });

  child.unref();
  log('[Relauncher] Child spawned (PID=' + child.pid + '). Cleaning up.');

  // 5) 自清理并退出
  cleanupSelf();
  process.exit(0);
}

main();
`;
}

/**
 * 写出外挂脚本并以 detached 子进程启动它（不退出当前进程）。
 *
 * 这是 SelfUpdateTool 与 /feishu restart 共用的底层动作：调用方负责在此之后
 * 安排当前进程退出（外挂会轮询父 PID 消失后接管）。
 *
 * 重启方式（双轨）：
 *   - Windows: cmd.exe /c otto --feishu（有 conpty，用户能看到界面）
 *   - Linux/macOS: login shell -l -c otto --feishu（加载 .bashrc/.profile，
 *     使 nvm/homebrew 等 PATH 生效，确保 otto 命令可找到）
 *
 * @returns 写出的脚本路径
 */
export function launchRelaunchHelper(install: RelaunchInstallMode): string {
  const parentPid = process.pid;
  const scriptPath = join(
    tmpdir(),
    `otto-relaunch-${parentPid}-${Date.now()}.js`,
  );

  // 重启日志固定写到全局配置目录，便于排障。
  let logPath: string | undefined;
  try {
    const logDir = join(homedir(), '.otto-user');
    mkdirSync(logDir, { recursive: true });
    logPath = join(logDir, 'cli-debug.log');
  } catch {
    logPath = undefined;
  }

  if (logPath) {
    try {
      appendFileSync(
        logPath,
        `[${new Date().toISOString()}] [Parent] Initiating relaunch helper.\n` +
        `  - Parent PID: ${parentPid}\n` +
        `  - Install Mode: ${JSON.stringify(install)}\n` +
        `  - Platform: ${process.platform}\n` +
        `  - Temp Script Path: ${scriptPath}\n`
      );
    } catch {
      // ignore
    }
  }

  const scriptContent = buildRelaunchScript({
    parentPid,
    install,
    relaunchCommand: SELF_UPDATE_RELAUNCH_COMMAND,
    relaunchArgs: SELF_UPDATE_RELAUNCH_ARGS,
    scriptPath,
    logPath,
  });

  writeFileSync(scriptPath, scriptContent, 'utf8');

  // 用当前 node 可执行文件跑外挂（process.execPath 一定存在、跨平台）。
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  if (logPath) {
    try {
      appendFileSync(
        logPath,
        `[${new Date().toISOString()}] [Parent] Spawned helper (PID: ${child.pid || 'unknown'}). Exiting parent soon.\n`
      );
    } catch {
      // ignore
    }
  }

  return scriptPath;
}

/** action：更新并重启 / 仅重启。 */
export type SelfUpdateAction = 'update_and_restart' | 'restart_only';
/** source：npm latest / 本地 tgz。 */
export type SelfUpdateSource = 'npm' | 'local';

/**
 * Params for SelfUpdateTool. 全部可选 —— 模型零参调用 = npm latest 更新并重启。
 */
export interface SelfUpdateParams {
  /** 'update_and_restart'（默认）或 'restart_only'（仅重启进程，救卡死/换配置）。 */
  action?: SelfUpdateAction;
  /** 更新源：'npm'（默认，装 latest）或 'local'（装本地 tgz，需 sourcePath）。 */
  source?: SelfUpdateSource;
  /** 当 source='local' 时，本地 .tgz 的绝对路径。 */
  sourcePath?: string;
  /** 可选：触发原因（仅日志）。 */
  reason?: string;
}

/**
 * SelfUpdateTool — 仅在飞书常驻模式下动态注册。
 *
 * 用法：
 *   - 默认：从 npm 安装 otto-ai@latest 并重启
 *   - action='restart_only'：不安装，仅重启当前进程（救卡死 / 应用新配置）
 *   - source='local' + sourcePath=<abs .tgz>：安装某个本地 tgz 包并重启
 */
export class SelfUpdateTool extends BaseTool<SelfUpdateParams, ToolResult> {
  static readonly Name: string = 'self_update';

  /**
   * 优雅退出前的回调。cli 层注入后，SelfUpdateTool 在 process.exit(0) 前会调用它，
   * 给调用方一个中止 AI、关闭 WS 连接、清理队列的机会。
   */
  static onBeforeRestart: (() => Promise<void>) | null = null;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly config: Config) {
    super(
      SelfUpdateTool.Name,
      'SelfUpdate',
      'Updates and/or restarts Otto (Feishu/Lark gateway mode only). Use ONLY when the user ' +
        'explicitly asks to update/upgrade or restart Otto.\n' +
        'Parameters:\n' +
        '- action: "update_and_restart" (default) installs a new version then restarts; ' +
        '"restart_only" just restarts the current process WITHOUT installing (use to recover a stuck ' +
        'session or apply changed config).\n' +
        '- source: "npm" (default) installs otto-ai@latest from npm; "local" installs a local .tgz ' +
        '(requires sourcePath).\n' +
        '- sourcePath: absolute path to a local .tgz, required when source="local".\n' +
        'A detached cross-platform helper performs the work after this process exits, then relaunches ' +
        '`otto --feishu` automatically. The bot is briefly offline (tens of seconds) and returns by ' +
        'itself; Feishu credentials are stored globally so no re-login is needed. If unsure which mode the ' +
        'user wants, ASK them first.',
      Icon.Hammer,
      {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            enum: ['update_and_restart', 'restart_only'],
            description:
              'update_and_restart (default) = install then restart; restart_only = just restart, no install.',
          },
          source: {
            type: Type.STRING,
            enum: ['npm', 'local'],
            description:
              'npm (default) = install otto-ai@latest; local = install a local .tgz (needs sourcePath). Ignored when action=restart_only.',
          },
          sourcePath: {
            type: Type.STRING,
            description:
              'Absolute path to a local .tgz package. Required when source="local".',
          },
          reason: {
            type: Type.STRING,
            description: 'Optional short note about why (for logging).',
          },
        },
        required: [],
      },
    );
  }

  validateToolParams(params: SelfUpdateParams): string | null {
    if (
      params.action !== undefined &&
      params.action !== 'update_and_restart' &&
      params.action !== 'restart_only'
    ) {
      return `Invalid action "${params.action}". Must be "update_and_restart" or "restart_only".`;
    }
    if (
      params.source !== undefined &&
      params.source !== 'npm' &&
      params.source !== 'local'
    ) {
      return `Invalid source "${params.source}". Must be "npm" or "local".`;
    }
    // 仅当真的要安装（非 restart_only）且 source=local 时，才强制要求 sourcePath。
    const isRestartOnly = params.action === 'restart_only';
    if (!isRestartOnly && params.source === 'local') {
      if (!params.sourcePath || params.sourcePath.trim() === '') {
        return 'source="local" requires "sourcePath" (absolute path to a .tgz file).';
      }
    }
    return null;
  }

  getDescription(params: SelfUpdateParams): string {
    if (params.action === 'restart_only') return 'Restart Otto (Feishu mode)';
    if (params.source === 'local') {
      return `Install local package and restart: ${params.sourcePath ?? '(missing path)'}`;
    }
    return 'Update Otto to latest and restart (Feishu mode)';
  }

  /** 把参数解析为底层安装模式。 */
  private resolveInstallMode(params: SelfUpdateParams): RelaunchInstallMode {
    if (params.action === 'restart_only') {
      return { type: 'none' };
    }
    if (params.source === 'local' && params.sourcePath) {
      return { type: 'tgz', path: params.sourcePath };
    }
    return { type: 'npm', packageName: SELF_UPDATE_PACKAGE };
  }

  async execute(
    params: SelfUpdateParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Self-update input error: ${validationError}`,
        returnDisplay: `❌ 自更新参数错误：${validationError}`,
      };
    }

    const install = this.resolveInstallMode(params);

    try {
      launchRelaunchHelper(install);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        llmContent: `Self-update failed: cannot start relaunch helper: ${msg}`,
        returnDisplay: `❌ 自更新失败：无法启动重启进程 (${msg})`,
      };
    }

    // 安排当前进程退出。先执行优雅关闭回调（中止 AI、断开 WS 等），再延迟退出，
    // 给飞书侧充足时间完成消息投递确认。
    const SHUTDOWN_DELAY_MS = 1500;
    setTimeout(async () => {
      try {
        if (SelfUpdateTool.onBeforeRestart) {
          await SelfUpdateTool.onBeforeRestart();
        }
      } catch {
        // 优雅关闭失败不应阻断重启
      }
      process.exit(0);
    }, SHUTDOWN_DELAY_MS).unref?.();

    const actionText =
      install.type === 'none'
        ? 'restart (no install)'
        : install.type === 'tgz'
          ? `install local package "${install.path}" then restart`
          : `install ${SELF_UPDATE_PACKAGE}@latest then restart`;

    const nonWinHint =
      process.platform !== 'win32'
        ? '根据您的操作系统限制，重启后将以后台进程（无界面）运行，使用 `ps -ef | grep otto` 即可查看。'
        : '';
    const displayText =
      install.type === 'none'
        ? `🔄 正在热重启，稍候我就回来。${nonWinHint}`
        : install.type === 'tgz'
          ? `🔄 正在安装本地包并重启：${install.path}，稍候我就回来。${nonWinHint}`
          : `🔄 正在安装最新版并重启，稍候我就回来。${nonWinHint}`;

    return {
      llmContent:
        `Self-update started: will ${actionText} via a detached helper after this process exits, ` +
        'then relaunch `otto --feishu`. The bot will be briefly offline and return automatically. ' +
        'Tell the user it is in progress and will be back shortly.',
      returnDisplay: displayText,
      summary: 'Self-update / restart triggered',
    };
  }
}
