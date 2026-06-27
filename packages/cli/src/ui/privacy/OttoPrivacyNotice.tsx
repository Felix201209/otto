/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Newline, Text, useInput } from 'ink';
import { Colors } from '../colors.js';

interface OttoPrivacyNoticeProps {
  onExit: () => void;
}

export const OttoPrivacyNotice = ({ onExit }: OttoPrivacyNoticeProps) => {
  useInput((input, key) => {
    if (key.escape) {
      onExit();
    }
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={Colors.AccentPurple}>
        Otto API Key Notice
      </Text>
      <Newline />
      <Text>
        Otto sends your prompts and code only to the model endpoint you
        configure with your own API key. Otto does not collect or store your
        code. Your data is handled under the privacy and terms of whichever
        model provider you connect, so review that provider&apos;s policy before
        sending sensitive information.
      </Text>
      <Newline />
      <Text>
        <Text color={Colors.AccentBlue}>[1]</Text> https://www.otto.bot
      </Text>
      <Newline />
      <Text color={Colors.Gray}>Press Esc to exit.</Text>
    </Box>
  );
};
