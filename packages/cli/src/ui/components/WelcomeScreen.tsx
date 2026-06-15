/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import React, { useMemo } from 'react';
import os from 'node:os';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { type Config, ProxyAuthManager } from 'otto-core';
import { ottoWordmark } from './AsciiArt.js';

interface WelcomeScreenProps {
  config: Config;
  version: string;
  customProxyUrl?: string;
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

// 标签行:两格缩进 + 定宽标签列 + 值
const LABEL_WIDTH = 9;

const InfoRow: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <Box>
    <Text>{'  '}</Text>
    <Text color={Colors.AccentCyan} bold>
      {label.padEnd(LABEL_WIDTH)}
    </Text>
    <Text>{children}</Text>
  </Box>
);

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  config,
  version,
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

  const dir = prettyPath(config.getProjectRoot() ?? '');
  const welcome = userName ? `Welcome back, ${userName}!` : 'Welcome back!';

  // 大字标右侧的元信息,对齐到第 2/3/4 行
  const meta = ['', `v${version}`, '你的飞书数字同事', `Dir: ${dir}`, '', ''];

  return (
    <Box flexDirection="column" marginBottom={0}>
      {/* 大字标 + 右侧元信息(逐行对齐) */}
      {ottoWordmark.map((line, i) => (
        <Box key={i}>
          <Text color={Colors.AccentBlue}>{line}</Text>
          {meta[i] ? <Text dimColor>{'   ' + meta[i]}</Text> : null}
        </Box>
      ))}

      <Box height={1} />

      <InfoRow label="SYSTEM">
        <Text color={Colors.AccentBlue} bold>
          {welcome}
        </Text>
      </InfoRow>
      <InfoRow label="MODEL">
        <Text dimColor>{model}</Text>
      </InfoRow>
      <InfoRow label="HINT">
        <Text color={Colors.AccentCyan}>/help</Text>
        <Text dimColor> 看命令  ·  </Text>
        <Text color={Colors.AccentCyan}>/tools</Text>
        <Text dimColor> 看工具  ·  直接说你想做什么</Text>
      </InfoRow>
    </Box>
  );
};
