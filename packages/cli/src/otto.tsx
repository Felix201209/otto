/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, type RenderOptions } from 'ink';
import { AppWrapper } from './ui/App.js';
import { loadCliConfig, parseArguments, CliArgs } from './config/config.js';
import { readStdin } from './utils/readStdin.js';
import { basename, resolve, normalize } from 'node:path';
import v8 from 'node:v8';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { start_sandbox } from './utils/sandbox.js';
import {
  LoadedSettings,
  loadSettings,
  SettingScope,
 loadEnvironment } from './config/settings.js';
import { themeManager } from './ui/themes/theme-manager.js';
import { getStartupWarnings } from './utils/startupWarnings.js';
import { getUserStartupWarnings } from './utils/userStartupWarnings.js';
import { runNonInteractive } from './nonInteractiveCli.js';
import { loadExtensions, Extension } from './config/extension.js';
import { registerCleanup, runExitCleanup } from './utils/cleanup.js';
import { getIsQuitting } from './utils/quitState.js';
import { getCliVersion } from './utils/version.js';
import { checkForUpdates, executeUpdateCommand } from './ui/utils/updateCheck.js';
import { t, tp } from './ui/utils/i18n.js';
import {
  ApprovalMode,
  Config,
  EditTool,
  ShellTool,
  WriteFileTool,
  getSessionId,
  logUserPrompt,
  AuthType,
  SessionManager,
  migrateLegacyDirectories,
 setSilentMode } from 'otto-core';
import { validateAuthMethod } from './config/auth.js';
import { setMaxSizedBoxDebugging } from './ui/components/shared/MaxSizedBox.js';
import { validateNonInteractiveAuth } from './validateNonInterActiveAuth.js';
import { enableSilentMode, disableSilentMode, logIfNotSilent } from './utils/silentMode.js';
import { appEvents, AppEvent } from './utils/events.js';
import { createConfirmationReadlineInterface } from './ui/utils/readlineOptimized.js';
import { setupGitErrorMonitoring } from './utils/gitErrorHandler.js';
import { AudioNotification } from './utils/audioNotification.js';
import { performStartupResize } from './ui/utils/vscodeStartupResize.js';
import { terminalSizeManager } from './ui/utils/terminalSizeManager.js';

async function listAvailableSessions(config: Config): Promise<void> {
  try {
    const sessionManager = new SessionManager(config.getProjectRoot());
    const sessions = await sessionManager.listSessions();

    if (sessions.length === 0) {
      console.log('No available sessions found.');
      return;
    }

    console.log('Available sessions:');
    console.log('---');

    // 按最后活跃时间排序（最新的在前）
    const sortedSessions = sessions.sort((a, b) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
    );

    for (const session of sortedSessions) {
      const createdAt = new Date(session.createdAt).toLocaleString();
      const lastActiveAt = new Date(session.lastActiveAt).toLocaleString();
      const hasCheckpoint = session.hasCheckpoint ? ' [CP]' : '';

      console.log(`Session ID: ${session.sessionId}${hasCheckpoint}`);
      console.log(`  Title: ${session.title || 'Untitled'}`);
      console.log(`  Created: ${createdAt}`);
      console.log(`  Last Active: ${lastActiveAt}`);
      console.log(`  Messages: ${session.messageCount}`);
      console.log(`  Tokens: ${session.totalTokens}`);
      if (session.model) {
        console.log(`  Model: ${session.model}`);
      }
      if (session.firstUserMessage) {
        console.log(`  First Message: ${session.firstUserMessage}${session.firstUserMessage.length >= 100 ? '...' : ''}`);
      }
      if (session.lastAssistantMessage) {
        console.log(`  Last Response: ${session.lastAssistantMessage}${session.lastAssistantMessage.length >= 100 ? '...' : ''}`);
      }
      console.log('---');
    }

    console.log(`\nTotal: ${sessions.length} sessions`);
    console.log('\nTo continue a session, use: otto --session <session-id>');
    console.log('To continue the last active session, use: otto --continue');
  } catch (error) {
    console.error('Error listing sessions:', error);
    process.exit(1);
  }
}

function getNodeMemoryArgs(config: Config): string[] {
  const totalMemoryMB = os.totalmem() / (1024 * 1024);
  const heapStats = v8.getHeapStatistics();
  const currentMaxOldSpaceSizeMb = Math.floor(
    heapStats.heap_size_limit / 1024 / 1024,
  );

  // Set target to 50% of total memory
  const targetMaxOldSpaceSizeInMB = Math.floor(totalMemoryMB * 0.5);
  if (config.getDebugMode()) {
    console.debug(
      `Current heap size ${currentMaxOldSpaceSizeMb.toFixed(2)} MB`,
    );
  }

  if (process.env.OTTO_CLI_NO_RELAUNCH ?? process.env.GEMINI_CLI_NO_RELAUNCH) {
    return [];
  }

  // Linus fix: 始终启用GC访问，用于强制内存清理
  const args = ['--expose-gc'];

  if (targetMaxOldSpaceSizeInMB > currentMaxOldSpaceSizeMb) {
    if (config.getDebugMode()) {
      console.debug(
        `Need to relaunch with more memory: ${targetMaxOldSpaceSizeInMB.toFixed(2)} MB`,
      );
    }
    args.push(`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`);
  }

  return args;
}

async function relaunchWithAdditionalArgs(additionalArgs: string[]) {
  const nodeArgs = [...additionalArgs, ...process.argv.slice(1)];
  // Set both new and legacy names so the relaunched child (any version) detects
  // the no-relaunch guard and avoids an infinite relaunch loop.
  const newEnv = {
    ...process.env,
    OTTO_CLI_NO_RELAUNCH: 'true',
    GEMINI_CLI_NO_RELAUNCH: 'true',
  };

  const child = spawn(process.execPath, nodeArgs, {
    stdio: 'inherit',
    env: newEnv,
  });

  await new Promise((resolve) => child.on('close', resolve));
  process.exit(0);
}
import { runAcpClient } from './acp/acpStdioTransport.js';
import { cleanupOldClipboardImages } from './ui/utils/clipboardUtils.js';
import { exportSessionToMarkdown } from './utils/sessionExport.js';

export function setupUnhandledRejectionHandler() {
  let unhandledRejectionOccurred = false;
  process.on('unhandledRejection', (reason, _promise) => {
    const errorMessage = `=========================================
This is an unexpected error. Please report this issue.
CRITICAL: Unhandled Promise Rejection!
=========================================
Reason: ${reason}${
      reason instanceof Error && reason.stack
        ? `
Stack trace:
${reason.stack}`
        : ''
    }`;
    appEvents.emit(AppEvent.LogError, errorMessage);
    if (!unhandledRejectionOccurred) {
      unhandledRejectionOccurred = true;
      appEvents.emit(AppEvent.OpenDebugConsole);
    }
  });
}

// 询问用户是否进行可选更新。assumeYes=true 时直接返回 true（-uy 场景）。
async function askUserForUpdate(assumeYes: boolean = false): Promise<boolean> {
  if (assumeYes) {
    console.log(`\n${t('update.prompt.now')}y (auto-confirmed via -y)`);
    return true;
  }
  return new Promise((resolve) => {
    const rl = createConfirmationReadlineInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(`\n${t('update.prompt.now')}`, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes');
    });
  });
}

// -------------------------------------------------------------------------
// Note: Startup animation removed for instant startup experience
// Technical users prefer seeing the input prompt immediately
// -------------------------------------------------------------------------

// Note: checkAndPromptHistoryCleanup moved to App component for non-blocking startup
// See packages/cli/src/ui/hooks/useHistoryCleanup.ts

/**
 * Handle and validate the --workdir parameter.
 * Supports both Windows and Unix-style paths.
 * Converts paths to absolute and validates they exist.
 */
function processWorkdirParameter(workdirPath: string | undefined): string | null {
  if (!workdirPath) {
    return null;
  }

  try {
    // Normalize the path (handles both Windows and Unix separators)
    // This converts backslashes to forward slashes on Unix and vice versa on Windows
    const normalizedPath = normalize(workdirPath);

    // Resolve to absolute path (relative to current working directory if not absolute)
    const absolutePath = resolve(normalizedPath);

    // Verify the directory exists
    const stats = fs.statSync(absolutePath);

    if (!stats.isDirectory()) {
      console.error(`Error: --workdir path is not a directory: ${absolutePath}`);
      process.exit(1);
    }

    return absolutePath;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      console.error(`Error: --workdir path does not exist: ${workdirPath}`);
    } else {
      console.error(`Error: Invalid --workdir path: ${workdirPath}`);
      if (error instanceof Error) {
        console.error(`Details: ${error.message}`);
      }
    }
    process.exit(1);
  }
}

export async function main() {
  // 飞书后台 daemon 管理（脱离终端常驻）：otto feishu daemon <start|stop|status>。
  // 在任何重型 bootstrap / 目录迁移之前截获 —— 这是纯进程管理（spawn/kill/查询），
  // 处理完即退出，不进入正常启动流程。
  if (process.argv[2] === 'feishu' && process.argv[3] === 'daemon') {
    const { runFeishuDaemonControl } = await import('./feishuDaemon.js');
    const { text, code } = runFeishuDaemonControl(process.argv[4]);
    console.log(text);
    process.exit(code);
  }

  // `otto setup`：配置自定义模型。
  //  - 带 --key/--model/--provider 时走【非交互】：一条命令直接写好配置并设为默认，
  //    完全绕开终端粘贴（向导里粘 API key 在某些终端/Windows/SSH 下不稳）。
  //    例：otto setup --provider glm --key <KEY> --model glm-5.1
  //  - 不带参数时打开交互式向导。
  if (process.argv[2] === 'setup') {
    const setupArgs = process.argv.slice(3);
    const getFlag = (n: string): string | undefined => {
      const i = setupArgs.indexOf(n);
      const v = i >= 0 ? setupArgs[i + 1] : undefined;
      // 下一个 token 缺失或本身是另一个 flag（以 -- 开头）→ 视为未提供取值，
      // 防止 `--key --model glm-5.1` 把 "--model" 误当 key 写进密钥文件。
      return v !== undefined && !v.startsWith('--') ? v : undefined;
    };
    const hasFlag = (n: string): boolean => setupArgs.includes(n);
    // 出现了却没跟取值的参数，交给 modelSetupCli 统一报中文错误并非零退出
    const VALUE_FLAGS = ['--provider', '--key', '--model', '--name', '--base-url', '--key-env', '--key-file', '--models'];
    const missingValueFlags = VALUE_FLAGS.filter((n) => hasFlag(n) && getFlag(n) === undefined);
    // `otto setup --help` / `-h`：打印用法后退出，不要误启交互式 TUI。
    if (hasFlag('--help') || hasFlag('-h')) {
      console.log(
        [
          'otto setup —— 配置自定义模型',
          '',
          '用法：',
          '  otto setup',
          '      打开交互式配置向导。',
          '  otto setup --list',
          '      列出常用供应商（来自 models.dev）。',
          '  otto setup --models <id>',
          '      列出某供应商的模型，例如 otto setup --models zhipuai。',
          '  otto setup --provider <id> --model <模型> --key <你的KEY>',
          '      非交互式一条命令写好配置并设为默认（绕开终端粘贴，Windows/SSH 更稳）。',
          '',
          '可选参数：',
          '  --key-env <环境变量名>   API key 从环境变量读，配置只存 {env:...} 引用。',
          '  --key-file <路径>        API key 从文件读，配置只存 {file:...} 引用。',
          '  --base-url <接口地址>    覆盖供应商默认接口地址。',
          '  --name <显示名>          自定义这个模型在列表里的显示名。',
        ].join('\n'),
      );
      process.exit(0);
    }
    if (
      missingValueFlags.length > 0 ||
      hasFlag('--list') ||
      getFlag('--models') ||
      getFlag('--key') ||
      getFlag('--key-env') ||
      getFlag('--key-file') ||
      getFlag('--model') ||
      getFlag('--provider')
    ) {
      const { runNonInteractiveModelSetup } = await import('./modelSetupCli.js');
      const r = await runNonInteractiveModelSetup({
        provider: getFlag('--provider'),
        key: getFlag('--key'),
        model: getFlag('--model'),
        name: getFlag('--name'),
        baseUrl: getFlag('--base-url'),
        keyEnv: getFlag('--key-env'),
        keyFile: getFlag('--key-file'),
        list: hasFlag('--list'),
        listModels: getFlag('--models'),
        missingValueFlags,
      });
      console.log(r.text);
      process.exit(r.code);
    }
    // 设标志 + 从 argv 移除 'setup'（否则会被 yargs 当成 prompt 进非交互模式），
    // 随后按正常交互式启动，App 挂载后直接打开自定义模型向导。
    process.env.OTTO_SETUP = '1';
    process.argv.splice(2, 1);
  }

  // `otto enterprise`：企业组织架构管理。
  //   otto enterprise setup --app-id <ID> --app-secret <SECRET> --admin-name <NAME>
  //   otto enterprise sync
  //   otto enterprise status
  if (process.argv[2] === 'enterprise') {
    const subCmd = process.argv[3];
    const enterpriseArgs = process.argv.slice(4);
    const getEnterpriseFlag = (n: string): string | undefined => {
      const i = enterpriseArgs.indexOf(n);
      const v = i >= 0 ? enterpriseArgs[i + 1] : undefined;
      return v !== undefined && !v.startsWith('--') ? v : undefined;
    };

    if (subCmd === 'setup') {
      const appId = getEnterpriseFlag('--app-id');
      const appSecret = getEnterpriseFlag('--app-secret');
      const adminName = getEnterpriseFlag('--admin-name') || 'admin';

      if (!appId || !appSecret) {
        console.log([
          'otto enterprise setup —— 绑定飞书企业应用',
          '',
          '用法：',
          '  otto enterprise setup --app-id <ID> --app-secret <SECRET> [--admin-name <NAME>]',
          '',
          '参数：',
          '  --app-id        飞书应用 App ID（cli_xxx）',
          '  --app-secret    飞书应用 App Secret',
          '  --admin-name    管理员名称（默认 admin）',
          '',
          '获取 App ID 和 Secret：',
          '  1. 登录飞书开放平台 https://open.feishu.cn/app',
          '  2. 创建企业自建应用',
          '  3. 在「凭证与基础信息」页获取 App ID 和 App Secret',
          '  4. 确保应用已开通通讯录权限（contact:department:readonly, contact:user:readonly）',
        ].join('\n'));
        process.exit(1);
      }

      const { getEnterpriseSync } = await import('otto-core');
      const sync = getEnterpriseSync(process.cwd());
      const config = {
        companyId: `feishu_${appId}`,
        companyName: adminName + '的企业',
        appId,
        appSecret,
        adminUserId: adminName,
        adminUserName: adminName,
        boundAt: new Date().toISOString(),
      };
      await sync.saveConfig(config);
      console.log(`✅ 企业绑定成功：${config.companyName} (${config.companyId})`);
      console.log('   运行 `otto enterprise sync` 同步组织架构。');
      process.exit(0);
    }

    if (subCmd === 'sync') {
      const { getEnterpriseSync } = await import('otto-core');
      const sync = getEnterpriseSync(process.cwd());
      const config = await sync.loadConfig();
      if (!config) {
        console.error('❌ 企业未绑定，请先运行：otto enterprise setup --app-id <ID> --app-secret <SECRET>');
        process.exit(1);
      }
      console.log(`同步组织架构（${config.companyName}）...`);
      try {
        const result = await sync.syncAll();
        console.log(`✅ 同步完成：${result.departments} 个部门，${result.users} 名员工`);
        console.log('   权限许可已自动生成。');
      } catch (err) {
        console.error(`❌ 同步失败：${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      process.exit(0);
    }

    if (subCmd === 'status') {
      const { getEnterpriseSync } = await import('otto-core');
      const sync = getEnterpriseSync(process.cwd());
      const config = await sync.loadConfig();
      if (!config) {
        console.log('企业未绑定。运行 `otto enterprise setup` 绑定。');
        process.exit(0);
      }
      console.log([
        `企业：${config.companyName} (${config.companyId})`,
        `管理员：${config.adminUserName}`,
        `绑定时间：${config.boundAt}`,
        `上次同步：${config.lastSyncAt || '从未同步'}`,
      ].join('\n'));
      process.exit(0);
    }

    // 未知子命令
    console.log([
      'otto enterprise —— 企业组织架构管理',
      '',
      '用法：',
      '  otto enterprise setup --app-id <ID> --app-secret <SECRET> [--admin-name <NAME>]',
      '      绑定飞书企业应用',
      '  otto enterprise sync',
      '      同步飞书组织架构（部门 + 人员 + 权限）',
      '  otto enterprise status',
      '      查看企业绑定状态',
    ].join('\n'));
    process.exit(0);
  }

  // 品牌升级：执行历史配置文件夹平滑迁移 (.otto -> .otto 等)
  try {
    migrateLegacyDirectories(process.cwd(), () => {
      const isZh = process.env.LANG?.startsWith('zh') || false;
      if (isZh) {
        console.log('\n\x1b[36m🔄 正在为您平滑迁移历史 Otto 数据与配置，请稍候（请勿关闭终端）...\x1b[0m');
        console.log('   • 项目级配置：.otto ──> .otto');
        console.log('   • 用户级配置：~/.otto    ──> ~/.otto-user');
        console.log('\x1b[32m💡 提示：下次启动可以使用 otto 命令启动。\x1b[0m\n');
      } else {
        console.log('\n\x1b[36m🔄 Migrating legacy Otto data and configurations, please wait (do not close the terminal)...\x1b[0m');
        console.log('   • Project-level: .otto ──> .otto');
        console.log('   • User-level:    ~/.otto    ──> ~/.otto-user');
        console.log('\x1b[32m💡 Tip: You can use the "otto" command to launch next time.\x1b[0m\n');
      }
    });
  } catch {
    // 降级静默忽略
  }

  // 🔬 Startup timing analysis - enable with STARTUP_TIMING=1
  const TIMING_ENABLED = process.env.STARTUP_TIMING === '1';
  const startupStart = Date.now();
  const timings: Array<{ step: string; duration: number; total: number }> = [];
  let lastTime = startupStart;

  const logTiming = (step: string) => {
    if (!TIMING_ENABLED) return;
    const now = Date.now();
    const duration = now - lastTime;
    const total = now - startupStart;
    timings.push({ step, duration, total });
    console.log(`⏱️  [${total.toString().padStart(5)}ms total, +${duration.toString().padStart(4)}ms] ${step}`);
    lastTime = now;
  };

  // Clear screen at startup for clean interface
  console.clear();

  // 🚀 Instant startup: No loading animation - render UI as fast as possible
  // Technical users prefer seeing the input prompt immediately

  logTiming('console.clear()');

  setupUnhandledRejectionHandler();
  logTiming('setupUnhandledRejectionHandler()');

  // Setup Git error monitoring early to catch initialization errors
  setupGitErrorMonitoring();
  logTiming('setupGitErrorMonitoring()');

  // Load environment variables early to ensure Claude configuration works
  loadEnvironment();
  logTiming('loadEnvironment()');

  // 初始化 TerminalSizeManager 以集中管理 resize 事件
  // 这样可以避免 MaxListenersExceededWarning，并提升性能
  // 注意：terminalSizeManager 是单例，此调用确保其在应用启动时初始化
  terminalSizeManager.getTerminalSize();
  logTiming('terminalSizeManager.getTerminalSize()');

  // Need to parse arguments twice:
  // 1. First pass with minimal setup to get --workdir
  // This is needed to determine the workspace before loading extensions
  const tempArgv = await parseArguments([]);
  logTiming('parseArguments([]) - first pass');

  // Handle --workdir parameter before setting up workspace
  if (tempArgv.workdir) {
    const workdirPath = processWorkdirParameter(tempArgv.workdir);
    if (workdirPath) {
      process.chdir(workdirPath);
    }
  }

  const workspaceRoot = process.cwd();

  // Initialize Skills system context AFTER workdir is set
  // This ensures Skills metadata is loaded from the correct project directory
  try {
    const { initializeSkillsContext } = await import('otto-core');
    logTiming('import initializeSkillsContext');
    // 传入 workspaceRoot 确保使用正确的项目根目录
    await initializeSkillsContext(workspaceRoot);
    logTiming('initializeSkillsContext()');
  } catch {
    logTiming('initializeSkillsContext() (failed)');
    // Skills system is optional, silently continue if not available
    // console.warn('[Skills] Initialization failed:', error);
  }
  const settings = loadSettings(workspaceRoot);
  logTiming('loadSettings()');

  // Load extensions early (before final argument parsing)
  // This allows extension commands to be registered dynamically
  const extensions = await loadExtensions(workspaceRoot);
  logTiming('loadExtensions()');

  // Load prompt extensions (Gemini CLI compatible TOML prompts)
  const { loadPromptExtensions } = await import('./config/prompt-extensions.js');
  logTiming('import prompt-extensions');
  const promptExtensions = await loadPromptExtensions(extensions);
  logTiming('loadPromptExtensions()');

  // Second pass: parse arguments with extension commands registered
  const argv = await parseArguments(extensions);
  logTiming('parseArguments(extensions) - second pass');

  // Enable silent mode early for -p flag to suppress startup logs

  // Handle --login <api-key> flag: non-interactive login for Bots
  if (argv.login) {
    const apiKey = argv.login.trim();
    // BYO-key: 未配置 OTTO_SERVER_URL 时无可登录的后端，优雅提示而非访问空 URL。
    const serverUrl = process.env.OTTO_SERVER_URL || '';
    if (!serverUrl) {
      console.error('API Key login is unavailable: no server configured. Set OTTO_SERVER_URL to enable it.');
      process.exit(1);
    }
    console.log('Logging in with API Key...');
    try {
      const response = await fetch(`${serverUrl}/auth/jwt/apikey-login`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Otto-CLI/1.0.0'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Login failed (HTTP ${response.status}): ${errorText}`);
        process.exit(1);
      }

      interface ApiKeyLoginResponse {
        success?: boolean;
        accessToken?: string;
        refreshToken?: string;
        expiresIn?: number;
        message?: string;
        error?: string;
        user?: {
          openId?: string;
          userId?: string;
          name?: string;
          email?: string;
          avatar?: string;
        };
      }

      const data = (await response.json()) as ApiKeyLoginResponse;
      if (!data.success || !data.accessToken) {
        console.error(`Login failed: ${data.message || data.error || 'Unknown error'}`);
        process.exit(1);
      }

      const { ProxyAuthManager } = await import('otto-core');
      const proxyAuthManager = ProxyAuthManager.getInstance();

      proxyAuthManager.setJwtTokenData({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn || 900
      });

      if (data.user) {
        proxyAuthManager.setUserInfo({
          openId: data.user.openId || data.user.userId || '',
          userId: data.user.userId || data.user.openId || '',
          name: data.user.name || data.user.email || data.user.openId || '',
          enName: data.user.name,
          email: data.user.email,
          avatar: data.user.avatar
        });
        console.log(`Login successful: ${data.user.name || data.user.email || data.user.openId}`);
      } else {
        console.log('Login successful.');
      }
      process.exit(0);
    } catch (error) {
      console.error(`Login error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  // Handle --update flag
  if (argv.update) {
    console.log(t('update.force.checking'));
    const updateMessage = await checkForUpdates(true, true);

    if (updateMessage?.startsWith('FORCE_UPDATE:')) {
      // 正确解析：根据消息标记来分割，避免URL中的冒号干扰
      const prefix = 'FORCE_UPDATE:';
      const firstColonIndex = updateMessage.indexOf(':', prefix.length);

      // 使用稳定的消息分隔符定位消息开始位置
      const messageMarker = '::MSG::';
      const messageStartIndex = updateMessage.indexOf(messageMarker);

      const updateCommand = updateMessage.substring(firstColonIndex + 1, messageStartIndex);
      const message = updateMessage.substring(messageStartIndex + messageMarker.length);

      console.log('\n' + '='.repeat(60));
      console.log(t('update.forced.title'));
      console.log('='.repeat(60));
      console.log(message);
      console.log('='.repeat(60));

      // 🔧 用户使用 -u 参数已经明确表达更新意图，直接执行更新
      console.log(`\n${t('update.auto.executing')}`);
      const success = await executeUpdateCommand(updateCommand);
      if (success) {
        console.log(`\n${t('update.success.restart')}`);
        process.exit(0);
      } else {
        console.log(`\n${t('update.manual.then.rerun')}`);
        process.exit(1);
      }
    } else if (updateMessage?.startsWith('UPDATE_AVAILABLE:')) {
      // 正确解析：根据消息标记来分割，避免URL中的冒号干扰
      const prefix = 'UPDATE_AVAILABLE:';
      const firstColonIndex = updateMessage.indexOf(':', prefix.length);

      // 使用稳定的消息分隔符定位消息开始位置
      const messageMarker = '::MSG::';
      const messageStartIndex = updateMessage.indexOf(messageMarker);

      const updateCommand = updateMessage.substring(firstColonIndex + 1, messageStartIndex);
      const message = updateMessage.substring(messageStartIndex + messageMarker.length);

      console.log('\n' + '='.repeat(60));
      console.log(t('update.available.title'));
      console.log('='.repeat(60));
      console.log(message);
      console.log('='.repeat(60));

      // 询问用户是否更新。-u 上下文下的 -y / --yolo 视为"默认确认升级"
      // （交互 REPL 里 -y 的 yolo 语义在这条单次升级分支里用不上，
      //  挪用为 update 的 assume-yes 最符合用户对 `-uy` 的直觉）。
      const shouldUpdate = await askUserForUpdate(!!argv.yolo);
      if (shouldUpdate) {
        const success = await executeUpdateCommand(updateCommand);
        if (success) {
          console.log(`\n${t('update.success.restart')}`);
          process.exit(0);
        }
      }
      console.log(`\n${t('update.continue.current')}\n`);
    } else {
      console.log(`${t('update.current.latest.full')}\n`);
    }
  } else {
    // 正常启动时检查强制更新（显示检查状态）
    const updateMessage = await checkForUpdates(true);
    logTiming('checkForUpdates()');
    if (updateMessage?.startsWith('FORCE_UPDATE:')) {
      // 正确解析：根据消息标记来分割，避免URL中的冒号干扰
      const prefix = 'FORCE_UPDATE:';
      const firstColonIndex = updateMessage.indexOf(':', prefix.length);

      // 使用稳定的消息分隔符定位消息开始位置
      const messageMarker = '::MSG::';
      const messageStartIndex = updateMessage.indexOf(messageMarker);

      const updateCommand = updateMessage.substring(firstColonIndex + 1, messageStartIndex);
      const message = updateMessage.substring(messageStartIndex + messageMarker.length);



      console.error('\n' + '='.repeat(60));
      console.error(t('update.forced.title'));
      console.error('='.repeat(60));
      console.error(message);
      console.error('='.repeat(60));

      // 自动执行强制更新
      console.error(`\n${t('update.auto.exec.start')}`);
      const success = await executeUpdateCommand(updateCommand);
      if (success) {
        console.error(`\n${t('update.success.restart')}`);
        process.exit(0);
      } else {
        console.error(`\n${t('update.manual.then.rerun')}`);
        process.exit(1);
      }
    }
  }

  // Check both CLI args and environment variable for silent mode and enable early
  // This must be before any ProxyAuthManager initialization to prevent logging
  const shouldEnableSilentMode =
    (argv.prompt && !argv.promptInteractive) ||
    process.env.OTTO_SILENT_MODE === 'true';

  if (shouldEnableSilentMode) {
    enableSilentMode();
    // Also set silent mode in core package
    setSilentMode(true);
  }

  // 初始化ProxyAuthManager，从设置文件中恢复飞书token
  // 调试信息已关闭
  // Skip ProxyAuthManager initialization in non-interactive mode to avoid logging


  //await cleanupCheckpoints();
  if (settings.errors.length > 0) {
    for (const error of settings.errors) {
      let errorMessage = `Error in ${error.path}: ${error.message}`;
      if (!process.env.NO_COLOR) {
        errorMessage = `\x1b[31m${errorMessage}\x1b[0m`;
      }
      console.error(errorMessage);
      console.error(`Please fix ${error.path} and try again.`);
    }
    process.exit(1);
  }

  // Early check for list-sessions to avoid unnecessary session management
  if (argv.listSessions) {
    const tempConfig = await loadCliConfig(
      settings.merged,
      extensions,
      getSessionId(), // Use default session ID
      argv,
    );
    await listAvailableSessions(tempConfig);
    process.exit(0);
  }

  // Handle --export-session flag
  if (argv.exportSession) {
    try {
      const sessionId = argv.exportSession;
      console.log(tp('export.exporting', { sessionId }));
      const exportPath = await exportSessionToMarkdown(sessionId, workspaceRoot);
      console.log(tp('export.success', { path: exportPath }));
      process.exit(0);
    } catch (error) {
      console.error(tp('export.failed', { error: error instanceof Error ? error.message : String(error) }));
      process.exit(1);
    }
  }

  // Handle --test-audio flag
  if (argv.testAudio) {
    console.log('🎵 Testing audio notifications...');
    console.log('This will test all three notification sounds with a 1-second delay between each.');
    console.log('Make sure your speakers/headphones are on and volume is audible.\n');

    try {
      await AudioNotification.test();
      console.log('\n✅ Audio test completed successfully!');
      console.log('If you didn\'t hear any sounds, check your system audio settings.');
      console.log('You can disable audio notifications in your settings.json file:');
      console.log('  "audioNotifications": { "enabled": false }');
    } catch (error) {
      console.error('\n❌ Audio test failed:', error);
      console.log('Audio notifications may not work on this system.');
    }
    process.exit(0);
  }

  // Initialize session management
  let finalSessionId = getSessionId(); // Default session ID
  logTiming('pre-session setup');

  const { SessionManager } = await import('otto-core');
  logTiming('import SessionManager');
  const sessionManager = new SessionManager(workspaceRoot);

  // 添加进程信号处理器，确保在意外退出时也能清理空会话
  let isExiting = false;

  const handleExit = async () => {
    // 1. 如果已经在退出中，不重复执行
    if (isExiting) return;
    isExiting = true;

    // 🎯 macOS 优化：如果正在通过 /quit 优雅退出，快速 Ctrl+C 直接 exit 不执行 JS 清理
    // 这避免了多个信号处理器同时执行导致的内存积累和 OOM
    if (getIsQuitting()) {
      process.exit(0);
      return;
    }

    // 2. 立即移除所有现有的 SIGINT/SIGTERM 监听器（关键：防止第三方库如Ink或用户继续按Ctrl+C导致的重入）
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');

    // 3. 注册“自杀”监听器：如果用户再次按 Ctrl+C，直接强制退出，不执行任何 JS 逻辑
    const forceExit = () => process.exit(1);
    process.on('SIGINT', forceExit);
    process.on('SIGTERM', forceExit);

    // 4. 设置安全网：5秒后如果还没退完，强制退出（防止清理逻辑死锁或 OOM）
    setTimeout(forceExit, 5000).unref();

    try {
      await runExitCleanup();
      process.exit(0);
    } catch {
      // 忽略清理错误，避免影响退出
      process.exit(1);
    }
  };

  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);

  // Perform session cleanup based on settings (runs in background)
  const sessionCleanupConfig = settings.merged.sessionCleanup || {
    enabled: true, // 启用session清理
    maxSessions: 500, // 最大保留会话数
    cleanupOnStartup: true // 启动时清理
  };

  // 启动时清理超出数量限制的会话
  if (sessionCleanupConfig.enabled && sessionCleanupConfig.cleanupOnStartup) {
    sessionManager.performSessionCleanup(sessionCleanupConfig.maxSessions || 500).catch(error => {
      console.warn('[Startup] Session cleanup failed:', error);
    });
  }

  // Handle session selection based on command line arguments
  if (argv.session) {
    // 用户明确指定了要加载的会话
    logIfNotSilent('log', `🔄 Loading session: ${argv.session}`);
    const sessionData = await sessionManager.loadSession(argv.session);
    if (sessionData) {
      finalSessionId = sessionData.sessionId;
      logIfNotSilent('log', `📝 Loaded session: ${finalSessionId}`);
    } else {
      logIfNotSilent('warn', `⚠️  Session ${argv.session} not found, creating new session`);
      const newSession = await sessionManager.createNewSession();
      finalSessionId = newSession.sessionId;
      // logIfNotSilent('log', `📝 Created new session: ${finalSessionId}`);
    }
  } else if (argv.continue) {
    // 默认或用户明确要求继续上一个会话
    logIfNotSilent('log', `🔄 Continuing last session...`);
    const sessionData = await sessionManager.initializeSession(true);
    finalSessionId = sessionData.sessionId;
    logIfNotSilent('log', `📝 Continuing last session: ${finalSessionId}`);
  } else {
    // 显式指定 --no-continue：创建新的独立sessionId，不尝试恢复任何之前的会话
    logIfNotSilent('log', ``);
    const newSession = await sessionManager.createNewSession();
    finalSessionId = newSession.sessionId;
    // logIfNotSilent('log', `📝 Created new session: ${finalSessionId}`);
  }
  logTiming('session management');

  // Perform session cleanup after creating/selecting current session (runs in background)
  if (sessionCleanupConfig.enabled && sessionCleanupConfig.cleanupOnStartup) {
    // 清理时排除当前正在使用的session
    sessionManager.performSessionCleanup(
      sessionCleanupConfig.maxSessions || 500,
      false, // preserveLatestEmpty设为false，因为我们已经有了当前session
      finalSessionId // 传入当前sessionId以避免被清理
    ).catch(error => {
      console.warn('[Startup] Session cleanup failed:', error);
    });
  }

  // Startup token expiry pre-check: detect expired tokens early and prompt user to login
  if (!shouldEnableSilentMode) {
    const { ProxyAuthManager } = await import('otto-core');
    const proxyAuthManager = ProxyAuthManager.getInstance();
    const tokenStatus = proxyAuthManager.checkStartupTokenStatus();

    if (tokenStatus.hasToken && tokenStatus.isExpired) {
      // Token exists but has expired - prompt user to re-authenticate
      logIfNotSilent('log', t('auth.tokenExpiredPrompt'));
    }
  }

  const config = await loadCliConfig(
    settings.merged,
    extensions,
    finalSessionId,
    argv,
  );
  logTiming('loadCliConfig()');

  if (argv.promptInteractive && !process.stdin.isTTY) {
    console.error(
      'Error: The --prompt-interactive flag is not supported when piping input from stdin.',
    );
    process.exit(1);
  }

  if (config.getListExtensions()) {
    logIfNotSilent('log', 'Installed extensions:');
    for (const extension of extensions) {
      logIfNotSilent('log', `- ${extension.config.name}`);
    }
    process.exit(0);
  }



  // Set a default auth type if one isn't set.
  if (!settings.merged.selectedAuthType) {
    // Default to Otto custom-model authentication
    settings.setValue(
      SettingScope.User,
      'selectedAuthType',
      AuthType.USE_PROXY_AUTH,
    );
  }

  setMaxSizedBoxDebugging(config.getDebugMode());

  await config.initialize();
  logTiming('config.initialize()');

  // 注册登录成功回调：刷新云端模型列表
  if (!shouldEnableSilentMode) {
    const { ProxyAuthManager } = await import('otto-core');
    const proxyAuthManager = ProxyAuthManager.getInstance();
    proxyAuthManager.onLoginSuccess(() => {
      // 异步刷新模型列表，不阻塞主流程
      (async () => {
        try {
          const { refreshModelsInBackground } = await import('./ui/commands/modelCommand.js');
          await refreshModelsInBackground(settings, config);
          console.log('[Main] Cloud models refreshed after successful login');
        } catch (error) {
          console.warn('[Main] Failed to refresh models after login:', error);
        }
      })();
    });
  }

  // Check model compatibility and log diagnostics (only in debug mode)
  try {
    if (process.env.DEBUG) {
      const { logModelDiagnostics } = await import('otto-core');
      const modelName = config.getModel();
      logModelDiagnostics(modelName, true);
    }
  } catch {
    // Fallback if model diagnostics fail - don't block startup
    if (process.env.DEBUG) {
      logIfNotSilent('warn', '⚠️  Model compatibility check failed, continuing...\n');
    }
  }

  // Check Git service status after initialization
  if (config.getCheckpointingEnabled()) {
    try {
      const gitService = await config.getGitService();
      logTiming('config.getGitService()');
      if (gitService.isGitDisabled()) {
        // Git is disabled, but we can continue - the error message was already displayed
        logIfNotSilent('log', 'ℹ️  Continuing with Git checkpointing disabled...\n');
      }
    } catch {
      // This shouldn't happen with the new graceful error handling, but just in case
      logIfNotSilent('warn', '⚠️  Git service initialization had issues, continuing anyway...\n');
    }
  }

  // Load custom themes from settings
  themeManager.loadCustomThemes(settings.merged.customThemes);
  logTiming('themeManager.loadCustomThemes()');

  if (settings.merged.theme) {
    if (!themeManager.setActiveTheme(settings.merged.theme)) {
      // If the theme is not found during initial load, log a warning and continue.
      // The useThemeCommand hook in App.tsx will handle opening the dialog.
      logIfNotSilent('warn', `Warning: Theme "${settings.merged.theme}" not found.`);
    }
  }

  // hop into sandbox if we are outside and sandboxing is enabled
  if (!process.env.SANDBOX) {
    const memoryArgs = settings.merged.autoConfigureMaxOldSpaceSize
      ? getNodeMemoryArgs(config)
      : [];
    const sandboxConfig = config.getSandbox();
    if (sandboxConfig) {
      if (settings.merged.selectedAuthType) {
        // Validate authentication here because the sandbox will interfere with the Oauth2 web redirect.
        try {
          const err = validateAuthMethod(settings.merged.selectedAuthType);
          if (err) {
            throw new Error(err);
          }
          await config.refreshAuth(settings.merged.selectedAuthType);
        } catch (err) {
          console.error('Error authenticating:', err);
          process.exit(1);
        }
      }
      await start_sandbox(sandboxConfig, memoryArgs);
      process.exit(0);
    } else {
      // Not in a sandbox and not entering one, so relaunch with additional
      // arguments to control memory usage if needed.
      if (memoryArgs.length > 0) {
        await relaunchWithAdditionalArgs(memoryArgs);
        process.exit(0);
      }
    }
  }

  // OAuth pre-authentication removed - only Otto custom-model auth supported

  if (config.getExperimentalAcp()) {
    return runAcpClient(config, settings, argv);
  }

  let input = config.getQuestion();
  logTiming('pre-startupWarnings');
  const startupWarnings = [
    ...(await getStartupWarnings()),
    ...(await getUserStartupWarnings(workspaceRoot, settings)),
  ];
  logTiming('getStartupWarnings()');

  // Get custom proxy server URL if configured
  const customProxyUrl = settings.user?.settings?.customProxyServerUrl ||
                        settings.workspace?.settings?.customProxyServerUrl ||
                        settings.system?.settings?.customProxyServerUrl;

  // Check for cloud mode
  if (argv.cloudMode) {
    // BYO-key: cloud server 来自 --cloud-server 或 OTTO_SERVER_URL；都未配置则禁用 cloud mode。
    const cloudServerUrl = argv.cloudServer || process.env.OTTO_SERVER_URL || '';
    if (!cloudServerUrl) {
      console.error('Cloud mode is unavailable: no cloud server configured. Pass --cloud-server <url> or set OTTO_SERVER_URL.');
      return;
    }
    const { startCloudMode } = await import('./remote/remoteServer.js');
    const { maskServerUrl } = await import('./utils/urlMask.js');

    console.log(t('cloud.mode.starting'));
    console.log(tp('cloud.mode.connecting.to.server', { url: maskServerUrl(cloudServerUrl) }));

    await startCloudMode(config, cloudServerUrl);
    return;
  }

  // 清理剪切板文件
  cleanupOldClipboardImages(config.getProjectSettingsManager().getConfigDirPath()).catch(() => {
    // Ignore cleanup errors
  });

  // If --output-format stream-json is specified, it's explicitly non-interactive mode
  // This is a clear user intent to use programmatic output format
  const isExplicitNonInteractiveMode = argv.outputFormat === 'stream-json' || argv.outputFormat === 'json';

  const shouldBeInteractive =
    !!argv.promptInteractive ||
    !!argv.feishu ||
    (process.stdin.isTTY && input?.length === 0 && !isExplicitNonInteractiveMode);

  // Render UI, passing necessary config values. Check that there is no command line question.
  if (shouldBeInteractive) {
    // 🚀 Instant startup optimization: render UI immediately
    // History cleanup check moved to App component (non-blocking)

    // Perform VSCode terminal startup resize calibration before UI renders
    performStartupResize();
    logTiming('performStartupResize()');

    const version = await getCliVersion();
    logTiming('getCliVersion()');
    setWindowTitle(basename(workspaceRoot), settings);

    // Print startup timing summary before clearing screen
    if (TIMING_ENABLED) {
      console.log('\n📊 Startup Timing Summary:');
      console.log('─'.repeat(60));
      timings.forEach(t => {
        const bar = '█'.repeat(Math.min(Math.floor(t.duration / 10), 40));
        console.log(`${t.total.toString().padStart(5)}ms │ ${bar} ${t.step} (+${t.duration}ms)`);
      });
      console.log('─'.repeat(60));
      console.log(`Total: ${Date.now() - startupStart}ms before render()`);
      console.log('\nPress Enter to continue...');
      await new Promise<void>(resolve => {
        process.stdin.once('data', () => resolve());
      });
    }

    // Clear screen before rendering Welcome UI
    console.clear();

    type DummyInputStream = InstanceType<typeof import('node:stream').Readable> & {
      setRawMode: () => void;
      ref: () => void;
      unref: () => void;
      isTTY: boolean;
    };

    const renderOptions: RenderOptions = { exitOnCtrlC: false };
    if (!process.stdin.isTTY) {
      // ✅ 避免在后台/无 TTY (detached) 启动时, Ink 尝试对 process.stdin 设置 raw mode 并报错崩溃。
      // 传入一个拥有空 setRawMode / ref / unref 方法的 Readable 作为输入流，使 Ink 降级为非交互渲染而不抛出不支持 raw mode 异常或 ref 缺失错误。
      const { Readable } = await import('node:stream');
      const dummyStdin = new Readable({ read() {} }) as DummyInputStream;
      dummyStdin.setRawMode = () => {};
      dummyStdin.ref = () => {};
      dummyStdin.unref = () => {};
      dummyStdin.isTTY = true;
      renderOptions.stdin = dummyStdin as unknown as RenderOptions['stdin'];
    }

    const instance = render(
      <React.StrictMode>
        <AppWrapper
          config={config}
          settings={settings}
          startupWarnings={startupWarnings}
          version={version}
          promptExtensions={promptExtensions}
          customProxyUrl={customProxyUrl}
        />
      </React.StrictMode>,
      renderOptions,
    );

    registerCleanup(async () => {
      instance.unmount();
      // 等待 Ink/Yoga 清理资源，防止 WASM 内存访问错误
      // Wait for Ink/React to finish unmounting and Yoga to release resources
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // 注册会话清理函数，在程序退出时清理空会话
    registerCleanup(async () => {
      // 🪝 触发 SessionEnd 钩子
      try {
        const client = config.getOttoClient();
        if (client && client.endSession) {
          await client.endSession('user_exit');
        }
      } catch {
        // 忽略错误，避免影响退出
      }

      // 使用 config.getSessionId() 获取当前会话ID，而不是闭包中的 finalSessionId
      // 这样可以确保在切换会话后，清理的是正确的会话
      const currentSessionId = config.getSessionId();
      await sessionManager.cleanupCurrentEmptySessionOnExit(currentSessionId);
    });

    return;
  }
  // If not a TTY, read from stdin
  // This is for cases where the user pipes input directly into the command
  if (!process.stdin.isTTY && !input) {
    input += await readStdin();
  }
  if (!input) {
    if (argv.outputFormat && argv.outputFormat !== 'default') {
      console.error('Error: No prompt provided. When using --output-format, you must provide a prompt via:');
      console.error('  1. Positional argument: otto "your prompt" --output-format json');
      console.error('  2. -p flag: otto -p "your prompt" --output-format json');
      console.error('  3. stdin: echo "your prompt" | otto --output-format json');
    } else {
      console.error('No input provided via stdin.');
    }
    process.exit(1);
  }

  const prompt_id = Math.random().toString(16).slice(2);
  logUserPrompt(config, {
    'event.name': 'user_prompt',
    'event.timestamp': new Date().toISOString(),
    prompt: input,
    prompt_id,
    auth_type: config.getContentGeneratorConfig()?.authType,
    prompt_length: input.length,
  });

  // Non-interactive mode handled by runNonInteractive
  const nonInteractiveConfig = await loadNonInteractiveConfig(
    config,
    extensions,
    settings,
    argv,
  );

  await runNonInteractive(nonInteractiveConfig, input, prompt_id, argv.outputFormat, settings);

  // 在非交互模式结束后，运行所有cleanup函数（包括空会话清理）
  await runExitCleanup();

  // Disable silent mode before exit (cleanup)
  if (argv.prompt) {
    disableSilentMode();
  }

  process.exit(0);
}

// 全局变量保存标题信息
let currentWindowTitle: string | null = null;
let titleRestoreInterval: NodeJS.Timeout | null = null;

function setWindowTitle(title: string, settings: LoadedSettings) {
  if (!settings.merged.hideWindowTitle) {
    const windowTitle = (process.env.CLI_TITLE || `🚀 Otto - ${title}`).replace(
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1F\x7F]/g,
      '',
    );

    // 确保CLI_TITLE环境变量被设置，以便shell命令执行后能正确恢复标题
    if (!process.env.CLI_TITLE) {
      process.env.CLI_TITLE = windowTitle;
    }

    // 保存当前标题供后续恢复使用
    currentWindowTitle = windowTitle;

    // 设置标题
    process.stdout.write(`\x1b]2;${windowTitle}\x07`);

    // 检查标题保护设置
    const titleProtection = settings.merged.titleProtection;
    const protectionEnabled = titleProtection?.enabled !== false; // 默认启用
    const restoreInterval = (titleProtection?.restoreInterval || 30) * 1000; // 默认30秒

    // 启动定期标题恢复机制
    if (protectionEnabled && !titleRestoreInterval) {
      titleRestoreInterval = setInterval(() => {
        if (currentWindowTitle) {
          process.stdout.write(`\x1b]2;${currentWindowTitle}\x07`);
        }
      }, restoreInterval);
    }

    process.on('exit', () => {
      if (titleRestoreInterval) {
        clearInterval(titleRestoreInterval);
      }
      process.stdout.write(`\x1b]2;\x07`);
    });
  }
}

// 手动恢复标题的函数
function restoreWindowTitle() {
  // 强制恢复标题
  const title = currentWindowTitle || '🚀 Otto';
  process.stdout.write(`\x1b]2;${title}\x07`);
}

/**
 * 🎯 使用 Checkpoint Summary 更新窗口标题
 * 格式：🚀 <summary> - Otto - <工作目录名>
 * @param summary 生成的摘要（10字以内）
 * @param settings 用户配置
 * @param workspaceName 工作目录名（可选，默认使用当前工作目录）
 */
export function updateWindowTitleWithSummary(
  summary: string,
  settings: LoadedSettings,
  workspaceName?: string
): void {
  // 1. 参数校验
  if (!summary || summary.trim().length === 0) {
    console.log('[Title] Summary is empty, skipping title update');
    return;
  }

  // 2. 检查用户是否禁用标题
  if (settings.merged.hideWindowTitle) {
    return;
  }

  // 3. 获取工作目录名
  const workspace = workspaceName || basename(process.cwd());

  // 4. 构造新标题：🚀 <summary> | Otto - <工作目录名>
  const cleanSummary = summary.trim();
  const newTitle = `🚀 ${cleanSummary} | Otto - ${workspace}`;

  // 5. 更新全局变量（标题保护机制会自动使用这个值）
  currentWindowTitle = newTitle;
  process.env.CLI_TITLE = newTitle;  // 同步环境变量，防止音频播放完成后被旧值覆盖

  // 6. 立即设置标题到终端
  process.stdout.write(`\x1b]2;${newTitle}\x07`);

  console.log(`[Title] Updated to: ${newTitle}`);
}

/**
 * Update the window title icon (first character) without changing the text content
 * Used for animating the title icon when AI is busy
 * @param icon The new icon character (emoji)
 */
export function updateWindowTitleIcon(icon: string): void {
  if (!currentWindowTitle) {
    return;
  }

  // Split the title to replace the first character (icon)
  // Format: 🚀 summary - Otto - workspace
  // or:     🚀 Otto - workspace
  const titleParts = currentWindowTitle.split(' ');

  if (titleParts.length > 0) {
    // Replace the first element (the icon)
    titleParts[0] = icon;
    const newTitle = titleParts.join(' ');

    // Update global variable
    currentWindowTitle = newTitle;
    process.env.CLI_TITLE = newTitle;

    // Set terminal title using ANSI escape sequence
    process.stdout.write(`\x1b]2;${newTitle}\x07`);
  }
}

// 导出恢复函数供其他模块使用
export { restoreWindowTitle };

async function loadNonInteractiveConfig(
  config: Config,
  extensions: Extension[],
  settings: LoadedSettings,
  argv: CliArgs,
) {
  let finalConfig = config;
  if (config.getApprovalMode() !== ApprovalMode.YOLO) {
    // Non-YOLO non-interactive mode: exclude write tools that require user confirmation.
    // Use --yolo flag to enable all tools (dangerous commands are still blocked).
    const existingExcludeTools = settings.merged.excludeTools || [];
    const interactiveTools = [
      ShellTool.Name,
      EditTool.Name,
      WriteFileTool.Name,
    ];

    console.error(
      `[Non-interactive mode] Write tools disabled: ${interactiveTools.join(', ')}. ` +
      `Use --yolo to enable all tools.`,
    );

    const newExcludeTools = [
      ...new Set([...existingExcludeTools, ...interactiveTools]),
    ];

    const nonInteractiveSettings = {
      ...settings.merged,
      excludeTools: newExcludeTools,
    };
    finalConfig = await loadCliConfig(
      nonInteractiveSettings,
      extensions,
      config.getSessionId(),
      argv,
    );
    await finalConfig.initialize();
  }

  return await validateNonInteractiveAuth(
    settings.merged.selectedAuthType,
    finalConfig,
  );
}
