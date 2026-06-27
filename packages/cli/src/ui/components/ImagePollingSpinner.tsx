/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { Text } from 'ink';
import Spinner from 'ink-spinner';
import React from 'react';
import { Colors } from '../colors.js';
import { isChineseLocale } from '../utils/i18n.js';

interface ImagePollingSpinnerProps {
  isVisible: boolean;
  elapsed: number;
  estimated: number;
}

export const ImagePollingSpinner: React.FC<ImagePollingSpinnerProps> = ({
  isVisible,
  elapsed,
  estimated,
}) => {
  if (!isVisible) return null;

  const isChinese = isChineseLocale();
  const _remaining = Math.max(0, estimated - elapsed);
  const progress = Math.min(100, Math.round((elapsed / estimated) * 100));

  const message = isChinese
    ? `${elapsed}s/${estimated}s (${progress}%)`
    : `${elapsed}s/${estimated}s (${progress}%)`;

  return (
    <Text color={Colors.AccentGreen}>
      <Spinner type="dots" /> {message}
    </Text>
  );
};
