/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box,Text } from 'ink';
import { type Config } from 'otto-core';
import React from 'react';
import { Colors } from '../colors.js';
import { isChineseLocale, t } from '../utils/i18n.js';

interface TipsProps {
  config: Config;
}

export const Tips: React.FC<TipsProps> = ({ config: _config }) => {
  // 简化的提示信息 - 参考 Claude Code 风格。
  // 原文案写死英文,中文 locale 下会显示英文。第一行无现成 i18n key,用 locale 分支兜底;
  // 第二行复用已有 key tips.guide.help / tips.guide.help.suffix,均不新增 key。
  const zh = isChineseLocale();
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
      <Text dimColor>
        {zh ? '试试 ' : 'Try '}
        <Text color={Colors.AccentOrange}>
          {zh ? '「编辑 〈文件路径〉 来 ...」' : '"edit <filepath> to ..."'}
        </Text>
      </Text>
      <Text dimColor>
        {zh ? '输入 ' : 'Type '}
        <Text color={Colors.AccentOrange}>{t('tips.guide.help')}</Text>
        {' '}
        {t('tips.guide.help.suffix')}
      </Text>
    </Box>
  );
};
