/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getPackageJson } from '../../utils/package.js';
import { t, tp, isChineseLocale } from './i18n.js';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 服务器地址配置 - 动态获取以确保环境变量正确加载
function getServerUrl(): string {
  // 开发环境下默认使用本地服务器
  if (process.env.DEV === 'true' || process.env.NODE_ENV === 'development') {
    return process.env.DEEPX_SERVER_URL || 'http://localhost:6699';
  }

  return process.env.DEEPX_SERVER_URL || 'https://api-code.deepvlab.ai';
}

interface UpdateCheckResponse {
  success: boolean;
  hasUpdate: boolean;
  currentVersion?: string;
  latestVersion?: string;
  updateCommand?: string;
  downloadUrl?: string;
  forceUpdate?: boolean;
  message?: string;
}

interface UpdateCheckCache {
  lastCheckTime: number;
  lastResult: string | null;
  version: string;
}

// 获取缓存文件路径
function getCacheFilePath(): string {
  const settingsDir = join(homedir(), '.otto-user');
  return join(settingsDir, 'update-check.json');
}

// 读取缓存
async function readUpdateCheckCache(): Promise<UpdateCheckCache | null> {
  try {
    const cacheFile = getCacheFilePath();
    const content = await fs.readFile(cacheFile, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

// 写入缓存
async function writeUpdateCheckCache(cache: UpdateCheckCache): Promise<void> {
  try {
    const cacheFile = getCacheFilePath();
    const settingsDir = join(homedir(), '.otto-user');

    // 确保目录存在
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.warn(tp('update.cache.write.error', { error: error instanceof Error ? error.message : String(error) }));
  }
}

// 格式化时间显示
function formatNextCheckTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  const locale = isChineseLocale() ? 'zh-CN' : 'en-US';
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

  if (date.toDateString() === now.toDateString()) {
    return tp('update.time.today', { time });
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) {
    return tp('update.time.tomorrow', { time });
  }

  return date.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function checkForUpdates(
  showProgress: boolean = false,
  forceCheck: boolean = false
): Promise<string | null> {
  try {
    // Skip update check when running from source (development mode) unless forced
    if (process.env.DEV === 'true' && !forceCheck) {
      if (showProgress) {
      }
      return null;
    }

    const packageJson = await getPackageJson();
    if (!packageJson || !packageJson.name || !packageJson.version) {
      return null;
    }

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000; // 24小时

    // 检查缓存（非强制模式）
    if (!forceCheck) {
      const cache = await readUpdateCheckCache();

      if (cache && cache.version === packageJson.version) {
        const timeSinceLastCheck = now - cache.lastCheckTime;

        if (timeSinceLastCheck < oneDayMs) {
          // 缓存有效，静默返回
          return cache.lastResult;
        }
      }
    }

    const serverUrl = getServerUrl();
    const updateApiUrl = `${serverUrl}/api/update-check?version=${encodeURIComponent(packageJson.version)}`;

    // 调用自己服务器的更新检测API
    const response = await fetch(
      updateApiUrl,
      {
        method: 'GET',
        headers: {
          'User-Agent': `${packageJson.name}/${packageJson.version}`,
        },
        // 设置超时
        signal: AbortSignal.timeout(10000), // 10秒超时
      }
    );

    if (!response.ok) {
      const message = tp('update.check.failed.http', { status: response.status });
      if (showProgress) {
        console.warn(message);
      } else {
        console.warn(message);
      }
      return null;
    }

    const data: UpdateCheckResponse = await response.json();

    if (!data.success) {
      const message = tp('update.check.failed.message', { message: String(data.message || '') });
      if (showProgress) {
        console.warn(message);
      } else {
        console.warn(message);
      }
      return null;
    }

    // 简化：移除不必要的显示

    let result: string | null = null;
    const MESSAGE_SEPARATOR = '::MSG::';

    if (data.hasUpdate && data.forceUpdate && data.latestVersion && data.updateCommand) {
      // 返回特殊标记，表示需要强制更新
      result = `FORCE_UPDATE:${data.latestVersion}:${data.updateCommand}${MESSAGE_SEPARATOR}${t('update.force.message.header')}
${tp('update.version.line', { current: packageJson.version, latest: String(data.latestVersion) })}
${tp('update.command.line', { command: String(data.updateCommand) })}

${t('update.after.success.exit')}`;
    } else if (data.hasUpdate && showProgress && data.latestVersion && data.updateCommand) {
      // 非强制更新时的提示
      result = `UPDATE_AVAILABLE:${data.latestVersion}:${data.updateCommand}${MESSAGE_SEPARATOR}${t('update.available.message.header')}
${tp('update.version.line', { current: packageJson.version, latest: String(data.latestVersion) })}
${tp('update.command.line', { command: String(data.updateCommand) })}`;
    }

    // 保存缓存（非强制检查时）
    if (!forceCheck) {
      const cache: UpdateCheckCache = {
        lastCheckTime: now,
        lastResult: result,
        version: packageJson.version
      };
      await writeUpdateCheckCache(cache);
    }

    return result;
  } catch (e) {
    // 网络错误或其他错误时静默失败，不影响正常使用
    const message = tp('update.check.failed.generic', { error: String(e) });
    console.warn(message);
    return null;
  }
}

// 内部使用的命令执行辅助函数
async function runSingleCommand(commandStr: string): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    const parts = commandStr.trim().split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    const isWindows = process.platform === 'win32';
    const actualCommand = isWindows ? 'cmd.exe' : command;
    const actualArgs = isWindows ? ['/c', command, ...args] : args;

    const proc = spawn(actualCommand, actualArgs, {
      stdio: 'inherit',
      shell: false
    });

    proc.on('close', (code) => {
      resolve({ code });
    });

    proc.on('error', (error) => {
      resolve({ code: null, error });
    });
  });
}

// 执行自动更新命令
export async function executeUpdateCommand(updateCommand: string): Promise<boolean> {
  console.log(t('update.auto.exec.start'));
  console.log(tp('update.command.line', { command: updateCommand }));

  const result = await runSingleCommand(updateCommand);

  if (result.code === 0) {
    console.log(t('update.completed'));
    return true;
  }

  // 检查是否为全局 npm 安装包命令
  const isNpmGlobalInstall = updateCommand.includes('npm install -g') || updateCommand.includes('npm i -g');
  if (isNpmGlobalInstall) {
    const isZH = isChineseLocale();
    console.log(isZH
      ? '\n⚠️ 检测到更新失败，可能是由于原全局文件被占用（如 ENOTEMPTY/EPERM 错误）。\n正在尝试通过“先安全卸载旧版本，再重新安装”的 Fallback 重试策略...'
      : '\n⚠️ Update failed, possibly due to locked/busy global files (e.g., ENOTEMPTY/EPERM error).\nAttempting fallback strategy: "safely uninstall old version first, then reinstall"...'
    );

    // 提取包名（例如从 "npm install -g deepv-code" 提取 "deepv-code"）
    let packageName = 'deepv-code';
    const match = updateCommand.match(/(?:npm\s+(?:install|i)\s+-g\s+|npm\s+-g\s+(?:install|i)\s+)([^\s@]+)/);
    if (match && match[1]) {
      packageName = match[1];
    }

    const uninstallCommand = `npm uninstall -g ${packageName}`;
    console.log(isZH
      ? `正在执行卸载命令：${uninstallCommand}`
      : `Executing uninstall command: ${uninstallCommand}`
    );

    const uninstallResult = await runSingleCommand(uninstallCommand);
    if (uninstallResult.code === 0) {
      console.log(isZH
        ? '卸载成功！正在重新执行安装...'
        : 'Uninstall succeeded! Re-executing install command...'
      );

      const reinstallResult = await runSingleCommand(updateCommand);
      if (reinstallResult.code === 0) {
        console.log(t('update.completed'));
        return true;
      }
    } else {
      console.warn(isZH
        ? '⚠️ 卸载失败，正在尝试使用 --force 参数强制覆盖安装...'
        : '⚠️ Uninstall failed, attempting to force install with --force flag...'
      );

      const forceInstallCommand = `${updateCommand} --force`;
      console.log(isZH
        ? `正在执行强制安装命令：${forceInstallCommand}`
        : `Executing force install command: ${forceInstallCommand}`
      );

      const forceResult = await runSingleCommand(forceInstallCommand);
      if (forceResult.code === 0) {
        console.log(t('update.completed'));
        return true;
      }
    }
  }

  if (result.error) {
    console.error(tp('update.exec.command.error', { error: result.error.message }));
  } else {
    console.error(tp('update.failed.code', { code: String(result.code) }));
  }

  const isZH = isChineseLocale();
  const cleanPackageName = updateCommand.includes('deepv-code') ? 'deepv-code' : 'deepv-code-cli';

  console.error(isZH
    ? `\n❌ 自动更新失败。您可以尝试手动执行以下命令进行安全更新：\n👉 npm uninstall -g ${cleanPackageName} && npm install -g ${cleanPackageName}\n`
    : `\n❌ Automatic update failed. You can try manually executing the following command for a safe update:\n👉 npm uninstall -g ${cleanPackageName} && npm install -g ${cleanPackageName}\n`
  );

  return false;
}
