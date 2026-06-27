/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box } from 'ink';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { SafeMessageContainer } from '../shared/SafeMessageContainer.js';

interface OttoMessageContentProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
}

/*
 * Gemini message content is a semi-hacked component. The intention is to represent a partial
 * of OttoMessage and is only used when a response gets too long. In that instance messages
 * are split into multiple OttoMessageContent's to enable the root <Static> component in
 * App.tsx to be as performant as humanly possible.
 */
export const OttoMessageContent: React.FC<OttoMessageContentProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  terminalWidth,
}) => {
  const originalPrefix = '• ';
  const prefixWidth = originalPrefix.length;

  return (
    <SafeMessageContainer preventOverflow={true}>
      <Box flexDirection="column" paddingLeft={prefixWidth}>
        <MarkdownDisplay
          text={text}
          isPending={isPending}
          // 🎯 优化：对于 AI 已完成的回复，放宽高度限制（传入 undefined 禁用折叠）
          availableTerminalHeight={isPending ? availableTerminalHeight : undefined}
          terminalWidth={terminalWidth - prefixWidth}
        />
      </Box>
    </SafeMessageContainer>
  );
};
