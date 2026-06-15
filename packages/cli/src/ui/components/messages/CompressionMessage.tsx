/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { CompressionProps } from '../../types.js';
import Spinner from 'ink-spinner';
import { Colors } from '../../colors.js';
import { t } from '../../utils/i18n.js';

export interface CompressionDisplayProps {
  compression: CompressionProps;
}

/*
 * Compression messages appear when the /compress command is run, or when auto-compression
 * is triggered. Shows a spinner while in progress, then a simple success message.
 *
 * Note: We intentionally do NOT display token counts here. The token numbers reported by
 * the underlying model's countTokens API are frequently inaccurate (sometimes showing
 * post-compression tokens larger than pre-compression), which confuses users. A simple
 * success/failure signal is clearer and more honest.
 */
export const CompressionMessage: React.FC<CompressionDisplayProps> = ({
  compression,
}) => {
  const text = compression.isPending
    ? t('compression.in_progress')
    : t('compression.success');

  return (
    <Box flexDirection="row">
      <Box marginRight={1}>
        {compression.isPending ? (
          <Spinner type="dots" />
        ) : (
          <Text color="#FF8C00">✦</Text>
        )}
      </Box>
      <Box>
        <Text
          color={
            compression.isPending ? Colors.AccentPurple : Colors.AccentGreen
          }
        >
          {text}
        </Text>
      </Box>
    </Box>
  );
};
