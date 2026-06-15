/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text, Box } from 'ink';
import { Colors } from '../../colors.js';
import { isLongText, smartTruncateText } from '../../utils/displayUtils.js';
import { formatAttachmentReferencesForDisplay } from '../../utils/attachmentFormatter.js';


interface UserMessageProps {
  text: string;
  terminalWidth?: number;
}

export const UserMessage: React.FC<UserMessageProps> = ({ text }) => {
  // 处理文本：先截断长文本，再格式化附件引用
  let displayText = text;

  // 截断超长文本
  if (isLongText(text, 20)) {
    displayText = smartTruncateText(text, 15);
  }

  // 格式化附件引用（@"path" -> [File #path]）
  displayText = formatAttachmentReferencesForDisplay(displayText);

  // 用户消息 = 一行 `› 用户说的话`：dim chevron + 默认前景文字，无底色/无框/无 emoji。
  // 与助手回合的 `•` 对齐在同一列。
  return (
    <Box flexDirection="row" marginY={1}>
      <Box flexShrink={0}>
        <Text color={Colors.Gray} bold dimColor>{'› '}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap">{displayText}</Text>
      </Box>
    </Box>
  );
};
