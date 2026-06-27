/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text, Box } from 'ink';
import { Colors } from '../../colors.js';

interface ErrorMessageProps {
  text: string;
}

/**
 * 语义分级:用户「可自助修复」的提示走黄色警告,真正的「被封/未知」走红色。
 *
 * 黄色(可操作):网络、超时、配额/额度、鉴权——用户改网络/换号/充值/换 key 就能恢复。
 *   这些文案带稳定标识:🌐(网络&超时)、quota/额度/配额/402(配额)、鉴权失败/Authentication
 *   failed/API key(鉴权)。任一命中即判为可修复警告。
 * 红色(不可自助):451 地区屏蔽、403 封禁、其余未知异常——默认归红色。
 *
 * 注意:402 额度不足文案虽带 🚫,但属于可操作(充值/升级),靠关键词命中归黄色,
 * 关键词判定优先于 emoji,以免被 🚫 误判成红色。
 */
const RECOVERABLE_MARKERS: readonly string[] = [
  // 网络 & 超时(统一 🌐 前缀)
  '🌐',
  // 配额 / 额度耗尽(可换号/充值/升级)
  'quota',
  'Quota',
  '额度',
  '配额',
  '(402)',
  'insufficient',
  // 鉴权失败(可换 key / 重新配置)
  '鉴权失败',
  'Authentication failed',
  'API key',
];

// 根据错误类型确定颜色
function getErrorColor(text: string): string {
  // 可自助修复(网络/超时/配额/鉴权)→ 黄色警告
  if (RECOVERABLE_MARKERS.some((marker) => text.includes(marker))) {
    return Colors.AccentYellow;
  }

  // 地区屏蔽(451)/封禁(403)/未知异常 → 红色
  return Colors.AccentRed;
}

export const ErrorMessage: React.FC<ErrorMessageProps> = ({ text }) => {
  const prefix = '✕ ';
  const prefixWidth = prefix.length;
  const errorColor = getErrorColor(text);

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box width={prefixWidth}>
        <Text color={errorColor}>{prefix}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap" color={errorColor}>
          {text}
        </Text>
      </Box>
    </Box>
  );
};
