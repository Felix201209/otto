/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box,Text } from 'ink';
import Gradient from 'ink-gradient';
import process from 'node:process';
import { Config,IDEConnectionStatus,shortenPath,tildeifyPath } from 'otto-core';
import React from 'react';
import { Colors } from '../colors.js';
import { getFooterDisplayConfig,getShortVersion } from '../utils/footerUtils.js';
import { getAgentStyleShortLabel, t } from '../utils/i18n.js';
import { ConsoleSummaryDisplay } from './ConsoleSummaryDisplay.js';
import { MemoryUsageDisplay } from './MemoryUsageDisplay.js';

interface FooterProps {
  model: string;
  targetDir: string;
  branchName?: string;
  debugMode: boolean;
  debugMessage: string;
  corgiMode: boolean;
  errorCount: number;
  showErrorDetails: boolean;
  showMemoryUsage?: boolean;
  promptTokenCount: number;
  nightly: boolean;
  vimMode?: string;
  version?: string;
  ideConnectionStatus?: IDEConnectionStatus;
  config?: Config;
  terminalWidth?: number;
  isFeishuProcessing?: boolean;
}

// 平台感知的「换行/编辑器/取消」键位提示，复用已有 i18n key（与 InputPrompt.getNewlineHint 同源），
// 让 ⌃J 在 Windows 下自动变为 Ctrl+Enter，并随 locale 切换中/英。
const getFooterNewlineHint = (): string => {
  const isVSCodeTerminal = !!(
    process.env.VSCODE_PID || process.env.TERM_PROGRAM === 'vscode'
  );
  switch (process.platform) {
    case 'darwin':
      return isVSCodeTerminal
        ? t('input.hint.newline.darwin.vscode')
        : t('input.hint.newline.darwin');
    case 'win32':
      return isVSCodeTerminal
        ? t('input.hint.newline.win32.vscode')
        : t('input.hint.newline.win32');
    case 'linux':
      return t('input.hint.newline.linux');
    default:
      return t('input.hint.newline.default');
  }
};

export const Footer: React.FC<FooterProps> = ({
  model: _model,
  targetDir,
  branchName,
  debugMode,
  debugMessage,
  corgiMode: _corgiMode,
  errorCount,
  showErrorDetails,
  showMemoryUsage,
  promptTokenCount: _promptTokenCount,
  nightly,
  vimMode,
  version,
  ideConnectionStatus,
  config,
  terminalWidth = 80,
  isFeishuProcessing: _isFeishuProcessing = false,
}) => {
  // 响应式显示配置(版本号长短等)
  const displayConfig = getFooterDisplayConfig(terminalWidth);

  // 计算显示内容(模型与上下文百分比已按用户要求从底部移除)
  const versionDisplay = version ? getShortVersion(version, displayConfig.showNodeVersion) : null;

  // 获取 Agent Style
  const agentStyle = config?.getAgentStyle() ?? 'default';

  // Claude-Code-style separator: a thin dim middot instead of the heavier
  // " | " pipe. Rendered with a leading+trailing space so segments breathe
  // and the eye reads them as one calm status line rather than a chain.
  const Separator = () => <Text color={Colors.Gray} dimColor>{' · '}</Text>;

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
    <Box justifyContent="space-between" width="100%">
      {/* Left Section: [Status] label + model · context · cwd — the primary
          status line. Model leads (what's answering), context next (how much
          room is left), cwd anchors where we are, all in one dim row. */}
      <Box alignItems="center">
        {vimMode ? <Text color={Colors.Gray}>[{vimMode}] </Text> : null}

        {/* Work-mode indicator — persisted ids stay internal; users see a
            short everyday label such as "Work code" or "Enterprise office". */}
        {agentStyle !== 'default' ? (
          <Box>
            <Text color={Colors.AccentCyan}>{getAgentStyleShortLabel(agentStyle)}</Text>
            <Separator />
          </Box>
        ) : null}

        {/* Working directory + branch — first item after [Status]/style.
            模型与上下文百分比按用户要求不在底部显示。 */}
        <Box>
          {nightly ? (
            <Gradient colors={Colors.GradientColors}>
              <Text>
                {shortenPath(tildeifyPath(targetDir), Math.max(20, terminalWidth - 20))}
                {branchName ? <Text> ({branchName}*)</Text> : null}
              </Text>
            </Gradient>
          ) : (
            <Text color={Colors.Gray} dimColor>
              {shortenPath(tildeifyPath(targetDir), Math.max(20, terminalWidth - 20))}
              {branchName ? <Text color={Colors.Gray} dimColor> ({branchName}*)</Text> : null}
            </Text>
          )}
        </Box>

        {/* Version — trails the path, deepest in the hierarchy. */}
        {versionDisplay ? (
          <Box>
            <Separator />
            <Text color={Colors.Gray} dimColor>{versionDisplay}</Text>
          </Box>
        ) : null}

        {debugMode ? (
          <Text color={Colors.AccentRed}>
            {' ' + (debugMessage || '--debug')}
          </Text>
        ) : null}
      </Box>

      {/* Middle Section: Centered Sandbox Info */}
      <Box
        flexGrow={1}
        alignItems="center"
        justifyContent="center"
        display="flex"
      >
        {process.env.SANDBOX && process.env.SANDBOX !== 'sandbox-exec' ? (
          <Text color={Colors.AccentGreen}>
            {process.env.SANDBOX.replace(/^(?:otto|gemini)-(?:cli-)?/, '')}
          </Text>
        ) : process.env.SANDBOX === 'sandbox-exec' ? (
          <Text color={Colors.AccentYellow}>
            macOS Seatbelt{' '}
            <Text color={Colors.Gray}>({process.env.SEATBELT_PROFILE})</Text>
          </Text>
        ) : null}
      </Box>

      {/* Right Section: status indicators (IDE / errors / memory) — kept on
          the far right so the primary status line on the left stays clean. */}
      <Box alignItems="center">
        {/* IDE Connection Status */}
        {ideConnectionStatus === IDEConnectionStatus.Connected ? (
          <Box>
            <Text color={Colors.AccentGreen}>{t('ide.connected')}</Text>
          </Box>
        ) : null}

        {/* Corgi mode display disabled
        {corgiMode ? (
          <Text>
            <Text color={Colors.Gray}>| </Text>
            <Text color={Colors.AccentRed}>▼</Text>
            <Text color={Colors.Foreground}>(´</Text>
            <Text color={Colors.AccentRed}>ᴥ</Text>
            <Text color={Colors.Foreground}>`)</Text>
            <Text color={Colors.AccentRed}>▼ </Text>
          </Text>
        ) : null}
        */}
        {!showErrorDetails && errorCount > 0 ? (
          <Box>
            {ideConnectionStatus === IDEConnectionStatus.Connected ? (
              <Separator />
            ) : null}
            <ConsoleSummaryDisplay errorCount={errorCount} />
          </Box>
        ) : null}
        {showMemoryUsage ? <MemoryUsageDisplay /> : null}
      </Box>
    </Box>

    {/* [Keys] line — concise keybinding hints, learned from the reference CLI.
        换行/编辑器/取消段改用平台感知的 i18n（与 InputPrompt.getNewlineHint 同源），
        修正 Windows 下 ⌃J 与平台主推键不符的问题；发送/命令/文件标签暂无对应 i18n key，保持原样。 */}
    <Box>
      <Text color={Colors.Gray} dimColor>
        {`⏎ 发送 · / 命令 · @ 文件 · ${getFooterNewlineHint()}`}
      </Text>
    </Box>
    </Box>
  );
};
