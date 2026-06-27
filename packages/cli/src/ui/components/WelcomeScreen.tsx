/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import React, { useMemo } from 'react';
import os from 'node:os';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { type Config, ProxyAuthManager } from 'otto-core';
import { ottoGlyphs } from './AsciiArt.js';
import { isChineseLocale } from '../utils/i18n.js';

// opencode 的双色调阴影调色板（抄自 packages/opencode/src/cli/ui.ts 的 left/right）：
// 235/238 是 256 色里的两档深灰，对应 hex；左半较暗、右半较亮，形成渐变。
interface GlyphPalette {
  fg?: string; // 笔画前景色（undefined = 终端默认前景，最亮）
  shadow: string; // ~ 标记的阴影顶块颜色
  bg: string; // _ / ^ 标记的背景实块颜色（字母内腔的阴影）
}
const LEFT_PALETTE: GlyphPalette = { fg: 'gray', shadow: '#3a3a3a', bg: '#262626' };
const RIGHT_PALETTE: GlyphPalette = { fg: 'white', shadow: '#585858', bg: '#444444' };

// 把一行字形按 opencode 的 draw() 规则渲染成 Ink 文本片段：
//   _ → 背景色空格（内腔阴影实块）   ^ → 前景叠背景的 ▀   ~ → 阴影色 ▀   其余 → 前景色块
function GlyphRow({ row, palette }: { row: string; palette: GlyphPalette }): React.JSX.Element {
  const spans: React.ReactNode[] = [];
  [...row].forEach((ch, i) => {
    if (ch === '_') {
      spans.push(<Text key={i} backgroundColor={palette.bg}>{' '}</Text>);
    } else if (ch === '^') {
      spans.push(<Text key={i} color={palette.fg} backgroundColor={palette.bg}>▀</Text>);
    } else if (ch === '~') {
      spans.push(<Text key={i} color={palette.shadow}>▀</Text>);
    } else if (ch === ' ') {
      spans.push(<Text key={i}>{' '}</Text>);
    } else {
      spans.push(<Text key={i} color={palette.fg}>{ch}</Text>);
    }
  });
  return <Text>{spans}</Text>;
}

interface WelcomeScreenProps {
  config: Config;
  version: string;
  customProxyUrl?: string;
  terminalWidth?: number; // 用于水平居中字标
}

// 把过长路径压短:home 折成 ~,再按尾部截断,避免撑破启动布局
function prettyPath(p: string, max = 52): string {
  if (!p) return '';
  const home = os.homedir();
  let s = p.startsWith(home) ? '~' + p.slice(home.length) : p;
  if (s.length > max) {
    s = '…' + s.slice(s.length - (max - 1));
  }
  return s;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  config,
  version,
  terminalWidth,
}) => {
  const userName = useMemo(() => {
    try {
      return ProxyAuthManager.getInstance().getUserInfo()?.name;
    } catch {
      return undefined;
    }
  }, []);

  const model = useMemo(() => {
    try {
      return config.getModel();
    } catch {
      return 'unknown';
    }
  }, [config]);

  const welcome = isChineseLocale()
    ? (userName ? `欢迎回来，${userName}！` : '欢迎回来！')
    : (userName ? `Welcome back, ${userName}!` : 'Welcome back!');

  // 水平居中：按终端宽度给字标加左侧留白，居中显示（修掉之前贴左被切的问题）。
  // 仿 opencode 的居中观感；inline 渲染无法上下居中，只做水平居中 + 适度留白。
  // 字标宽度 = 左半(9) + 分隔(1) + 右半(9) = 19。min 2 确保任何窄终端都不贴边被切。
  const WORDMARK_WIDTH = 19;
  const cols = terminalWidth ?? 80;
  const pad = ' '.repeat(Math.max(2, Math.floor((cols - WORDMARK_WIDTH) / 2)));

  // 路径按当前终端宽度动态收缩,避免长 cwd 在窄终端撑破布局换行。
  const dir = prettyPath(config.getProjectRoot() ?? '', Math.max(12, cols - pad.length - 6));

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box height={1} />

      {/* opencode 风格双色调阴影字标（otto），水平居中：左半较暗、右半较亮 */}
      {ottoGlyphs.left.map((row, i) => (
        <Box key={i}>
          <Text>{pad}</Text>
          <GlyphRow row={row} palette={LEFT_PALETTE} />
          <Text>{' '}</Text>
          <GlyphRow row={ottoGlyphs.right[i] ?? ''} palette={RIGHT_PALETTE} />
        </Box>
      ))}

      <Box height={1} />

      {/* 品牌 + 版本 + tagline，对齐到字标左缘 */}
      <Box>
        <Text>{pad}</Text>
        <Text color={Colors.AccentOrange} bold>
          OTTO
        </Text>
        <Text dimColor wrap="truncate-end">{` v${version}  ·  ${isChineseLocale() ? '终端 & 飞书 AI 同事' : 'Terminal & Feishu AI coworker'}`}</Text>
      </Box>

      <Box marginTop={1}>
        <Text>{pad}</Text>
        <Text color={Colors.AccentCyan}>▸ </Text>
        <Text dimColor wrap="truncate-end">{`${dir}   ·   ${model}`}</Text>
      </Box>
      <Box>
        <Text>{pad}</Text>
        <Text color={Colors.AccentGreen}>● </Text>
        <Text color={Colors.Foreground}>{welcome}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{pad}</Text>
        <Text color={Colors.AccentCyan}>/help</Text>
        <Text dimColor>{isChineseLocale() ? ' 命令  ·  ' : ' commands  ·  '}</Text>
        <Text color={Colors.AccentCyan}>/tools</Text>
        <Text dimColor>{isChineseLocale() ? ' 工具  ·  直接说你想做什么' : ' tools  ·  just say what you want to do'}</Text>
      </Box>
    </Box>
  );
};
