/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Newline, Text, useInput } from 'ink';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';
import { usePrivacySettings } from '../hooks/usePrivacySettings.js';
import { CloudPaidPrivacyNotice } from './CloudPaidPrivacyNotice.js';
import { Config } from 'otto-core';
import { Colors } from '../colors.js';

interface CloudFreePrivacyNoticeProps {
  config: Config;
  onExit: () => void;
}

export const CloudFreePrivacyNotice = ({
  config,
  onExit,
}: CloudFreePrivacyNoticeProps) => {
  const { privacyState, updateDataCollectionOptIn } =
    usePrivacySettings(config);

  useInput((input, key) => {
    if (privacyState.error && key.escape) {
      onExit();
    }
  });

  if (privacyState.isLoading) {
    return <Text color={Colors.Gray}>加载中...</Text>;
  }

  if (privacyState.error) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text color={Colors.AccentRed}>
          加载选择加入设置时出错: {privacyState.error}
        </Text>
        <Text color={Colors.Gray}>按 Esc 退出。</Text>
      </Box>
    );
  }

  if (privacyState.isFreeTier === false) {
    return <CloudPaidPrivacyNotice onExit={onExit} />;
  }

  const items = [
    { label: 'Yes', value: true },
    { label: 'No', value: false },
  ];

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color={Colors.AccentPurple}>
        Otto Privacy Notice
      </Text>
      <Newline />
      <Text>
        Otto is a CLI for the AI model endpoints you configure yourself. Your
        prompts, code, and conversations are sent only to the model provider you
        set up. Otto does not collect or store your code.
      </Text>
      <Newline />
      <Text>
        Each provider handles your data under its own privacy policy. Review the
        terms of the provider you configure before sending sensitive
        information.
      </Text>
      <Newline />
      <Text>
        Optionally, you can allow Otto to collect anonymous usage statistics
        (such as feature usage and error reports) to help improve the product.
        This never includes your code or conversation content.
      </Text>
      <Newline />
      <Box flexDirection="column">
        <Text>Allow Otto to collect anonymous usage statistics?</Text>
        <RadioButtonSelect
          items={items}
          initialIndex={privacyState.dataCollectionOptIn ? 0 : 1}
          onSelect={(value) => {
            updateDataCollectionOptIn(value);
            // Only exit if there was no error.
            if (!privacyState.error) {
              onExit();
            }
          }}
        />
      </Box>
      <Newline />
      <Text>
        <Text color={Colors.AccentBlue}>[1]</Text> https://www.otto.bot
      </Text>
      <Newline />
      <Text color={Colors.Gray}>Press Enter to choose an option and exit.</Text>
    </Box>
  );
};
