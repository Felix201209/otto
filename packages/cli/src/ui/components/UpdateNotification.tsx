/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { t, tp, isChineseLocale } from '../utils/i18n.js';

interface UpdateNotificationProps {
  message: string;
}

interface UpdateInfo {
  type: 'force' | 'available' | 'raw';
  content?: string;
  latestVersion?: string;
  updateCommand?: string;
  header?: string;
  versionLine?: string;
  extraLines?: string[];
  fullContent?: string;
}

export const UpdateNotification = ({ message }: UpdateNotificationProps) => {
  const isChinese = useMemo(() => isChineseLocale(), []);
  const changelogUrl = isChinese
    ? 'https://dvcode.deepvlab.ai/zh/changelog'
    : 'https://dvcode.deepvlab.ai/changelog';

  const updateInfo = useMemo<UpdateInfo | null>(() => {
    if (!message) return null;

    const isForceUpdate = message.startsWith('FORCE_UPDATE:');
    const isNormalUpdate = message.startsWith('UPDATE_AVAILABLE:');

    if (!isForceUpdate && !isNormalUpdate) {
      return {
        type: 'raw',
        content: message,
      };
    }

    const prefix = isForceUpdate ? 'FORCE_UPDATE:' : 'UPDATE_AVAILABLE:';
    const messageMarker = '::MSG::';
    const markerIndex = message.indexOf(messageMarker);

    if (markerIndex === -1) {
      return {
        type: 'raw',
        content: message,
      };
    }

    const metaPart = message.substring(prefix.length, markerIndex);
    const userMessage = message.substring(markerIndex + messageMarker.length);

    const firstColonIndex = metaPart.indexOf(':');
    const latestVersion = metaPart.substring(0, firstColonIndex);
    const updateCommand = metaPart.substring(firstColonIndex + 1);

    // 解析用户消息中的行
    const lines = userMessage.split('\n').map(l => l.trim()).filter(Boolean);

    // 找出版本行
    const versionLineIndex = lines.findIndex(l => l.includes('->') || l.includes('→'));
    const versionLine = versionLineIndex !== -1 ? lines[versionLineIndex] : undefined;

    return {
      type: isForceUpdate ? 'force' : 'available',
      latestVersion,
      updateCommand,
      versionLine,
    };
  }, [message]);

  if (!updateInfo) return null;

  if (updateInfo.type === 'raw') {
    return (
      <Box
        borderStyle="round"
        borderColor={Colors.AccentYellow}
        paddingX={1}
        marginY={0}
      >
        <Text color={Colors.AccentYellow}>{updateInfo.content}</Text>
      </Box>
    );
  }

  const isForce = updateInfo.type === 'force';
  const borderColor = isForce ? Colors.AccentRed : Colors.AccentYellow;

  // 渲染标题标签（极致简化：强制更新用红色，普通更新用黄色）
  const label = isForce ? ' ! ' : ' i ';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginY={0}
    >
      {/* 第一行：版本和命令 */}
      <Box flexDirection="row" alignItems="center">
        <Text bold backgroundColor={borderColor} color="black">{label}</Text>

        <Box marginLeft={1}>
          <Text bold>{isForce ? t('update.forced.title') : t('update.available.title')}: </Text>
          <Text color={Colors.AccentGreen}>
            {updateInfo.versionLine
              ? updateInfo.versionLine.replace(/.*[:：]/, '').trim()
              : `v${updateInfo.latestVersion}`}
          </Text>
        </Box>

        <Box marginLeft={2}>
          <Text dimColor>{tp('update.command.line', { command: '' }).replace(/📋|[:：]/g, '').trim()}: </Text>
          <Text color={Colors.AccentCyan}>{updateInfo.updateCommand}</Text>
        </Box>
      </Box>

      {/* 第二行：更新日志和提示 */}
      <Box flexDirection="row" marginTop={0} paddingLeft={4}>
        <Box>
          <Text dimColor>{isChinese ? '📖 更新日志: ' : '📖 Changelog: '}</Text>
          <Text underline dimColor>{changelogUrl}</Text>
        </Box>

        {isForce && (
          <Box marginLeft={2}>
            <Text color={borderColor} bold italic>({t('update.after.success.exit')})</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
