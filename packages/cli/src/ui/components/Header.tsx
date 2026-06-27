/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import os from 'node:os';
import { Colors } from '../colors.js';
import { cuteVLogo } from './AsciiArt.js';

interface HeaderProps {
  customAsciiArt?: string; // For user-defined ASCII art
  terminalWidth: number; // For responsive logo
  version: string;
  nightly: boolean;
  feishuServerPort?: number; // 飞书认证服务器端口号
  cwd?: string; // 当前工作目录（缺省时回退到 process.cwd()）
}

// 品牌 tagline —— 与 AsciiArt.longAsciiLogo 中沿用的口径保持一致
const TAGLINE = '终端 & 飞书 AI 同事';

// 开屏上手提示：克制 2 条，紧扣最常用入口
const HINTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: '/help', label: '查看命令与帮助' },
  { key: '直接说', label: '告诉我你想做什么' },
];

// 把 $HOME 折叠成 ~，并对超长路径做中部省略，避免撑破盒子（参考 Claude Code）
function formatCwd(rawCwd: string, maxWidth: number): string {
  const home = os.homedir();
  let display = rawCwd;
  if (home && (display === home || display.startsWith(home + '/'))) {
    display = '~' + display.slice(home.length);
  }
  if (display.length <= maxWidth) {
    return display;
  }
  const head = Math.ceil((maxWidth - 1) / 2);
  const tail = Math.floor((maxWidth - 1) / 2);
  return display.slice(0, head) + '…' + display.slice(display.length - tail);
}

export const Header: React.FC<HeaderProps> = ({
  customAsciiArt,
  terminalWidth,
  version,
  nightly,
  cwd,
}) => {
  // 如果用户自定义了 ASCII art，则使用它（保留原有行为）
  if (customAsciiArt) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>{customAsciiArt}</Text>
      </Box>
    );
  }

  // 盒子整体宽度自适应：窄终端贴边，宽终端封顶 64 列，保持克制
  const boxWidth = Math.min(Math.max(terminalWidth - 2, 24), 64);
  // cwd 可用宽度 = 盒内宽度 - 左右 padding(2) - "▸ " 前缀(2)
  const cwdMaxWidth = Math.max(boxWidth - 4, 8);
  const displayCwd = formatCwd(cwd ?? process.cwd(), cwdMaxWidth);

  // Logo 仅剥首尾空行，保留行内前导空格以维持图形对齐
  const trimmedLogo = cuteVLogo.replace(/^\n+/, '').replace(/\s+$/, '');

  return (
    <Box
      flexDirection="column"
      width={boxWidth}
      borderStyle="round"
      borderColor={Colors.Gray}
      paddingX={1}
      marginBottom={1}
    >
      {/* 品牌行：Logo + Otto + 版本 + tagline */}
      <Box flexDirection="row">
        <Box marginRight={1}>
          <Text color={Colors.AccentOrange}>{trimmedLogo}</Text>
        </Box>
        <Box flexDirection="column" justifyContent="center" flexGrow={1}>
          <Box>
            <Text color={Colors.AccentOrange} bold>
              OTTO
            </Text>
            <Text dimColor> v{version}</Text>
            {nightly && (
              <Text color={Colors.AccentYellow}> · nightly</Text>
            )}
          </Box>
          <Text dimColor wrap="truncate-end">
            {TAGLINE}
          </Text>
        </Box>
      </Box>

      {/* 当前工作目录 */}
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-middle">
          ▸ {displayCwd}
        </Text>
      </Box>

      {/* 上手提示：紧凑两条 */}
      <Box flexDirection="column" marginTop={1}>
        {HINTS.map((hint) => (
          <Box key={hint.key} flexDirection="row">
            <Text color={Colors.AccentCyan}>{hint.key}</Text>
            <Text dimColor> {hint.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};
