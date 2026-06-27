/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { Box,Text,useInput } from 'ink';
import { AuthType } from 'otto-core';
import React,{ useState } from 'react';
import { LoadedSettings,SettingScope } from '../../config/settings.js';
import { Colors } from '../colors.js';

interface LoginDialogProps {
  onSelect: (authMethod: AuthType | undefined, scope: SettingScope) => void;
  settings: LoadedSettings;
  initialErrorMessage?: string | null;
}

function parseDefaultAuthType(
  defaultAuthType: string | undefined,
): AuthType | null {
  if (
    defaultAuthType &&
    Object.values(AuthType).includes(defaultAuthType as AuthType)
  ) {
    return defaultAuthType as AuthType;
  }
  return null;
}

export function LoginDialog({
  onSelect,
  settings,
  initialErrorMessage,
}: LoginDialogProps): React.JSX.Element {
  const [errorMessage, setErrorMessage] = useState<string | null>(() => {
    if (initialErrorMessage) {
      return initialErrorMessage;
    }

    const defaultAuthType = parseDefaultAuthType(
      process.env.OTTO_DEFAULT_AUTH_TYPE,
    );

    if (process.env.OTTO_DEFAULT_AUTH_TYPE && defaultAuthType === null) {
      return (
        `Invalid value for OTTO_DEFAULT_AUTH_TYPE: "${process.env.OTTO_DEFAULT_AUTH_TYPE}". ` +
        `Valid values are: ${Object.values(AuthType).join(', ')}.`
      );
    }

    // 仅支持自定义模型配置路径
    return null;
  });

  // 已移除云登录路径：本对话框仅提示用户去配置自定义模型，
  // 不再提供任何云端登录选项。用户按 Esc 关闭后可通过模型管理配置自定义模型。
  useInput((_input, key) => {
    if (key.escape) {
      // Prevent exit if there is an error message.
      // This means the user is not authenticated yet.
      if (errorMessage) {
        return;
      }
      if (settings.merged.selectedAuthType === undefined) {
        // Prevent exiting if no auth method is set
        setErrorMessage(
          'You must configure a custom model to proceed. Press Ctrl+C twice to exit.',
        );
        return;
      }
      onSelect(undefined, SettingScope.User);
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.Gray}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Box marginBottom={1}>
        <Text bold color={Colors.AccentCyan}>需要配置模型 / Model Setup Required</Text>
      </Box>
      <Box marginTop={1}>
        <Text>请配置自定义模型以继续使用。</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          Please configure a custom model to continue.
        </Text>
      </Box>
      {errorMessage && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{errorMessage}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          按 Esc 关闭 / Press Esc to dismiss
        </Text>
      </Box>
    </Box>
  );
}
