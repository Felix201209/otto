/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Colors } from '../colors.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { AuthType } from 'otto-core';
import { validateAuthMethod } from '../../config/auth.js';
import { t } from '../utils/i18n.js';

interface AuthDialogProps {
  onSelect: (authMethod: AuthType | undefined, scope: SettingScope) => void;
  settings: LoadedSettings;
  initialErrorMessage?: string | null;
  /** Callback when user chooses to use custom model without login */
  onUseCustomModel?: () => void;
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

// 特殊值，表示用户选择使用自定义模型
export const USE_CUSTOM_MODEL_VALUE = '__use_custom_model__';

export function AuthDialog({
  onSelect,
  settings,
  initialErrorMessage,
  onUseCustomModel,
}: AuthDialogProps): React.JSX.Element {
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

  // 功能实现: 仅显示自定义模型配置选项
  // 实现方案: 用户通过配置自定义模型完成接入（无需云登录）
  // 影响范围: AuthDialog组件的认证选项列表
  const items = [
    { label: t('auth.option.custom.model'), value: USE_CUSTOM_MODEL_VALUE },
  ];

  // 只有一个选项（配置自定义模型），直接默认选择
  const initialAuthIndex = 0;

  const handleAuthSelect = (authMethod: AuthType | string) => {
    if (process.env.DEBUG) { console.log('🔍 AuthDialog: handleAuthSelect called with authMethod:', authMethod); }

    // 处理"使用自定义模型"选项
    if (authMethod === USE_CUSTOM_MODEL_VALUE) {
      if (process.env.DEBUG) { console.log('🔧 AuthDialog: Custom model option selected'); }
      if (onUseCustomModel) {
        onUseCustomModel();
      }
      return;
    }

    // 其他认证方式的原有逻辑
    if (process.env.DEBUG) { console.log('📝 AuthDialog: Other auth method selected:', authMethod); }
    const error = validateAuthMethod(authMethod as AuthType);
    if (error) {
      setErrorMessage(error);
    } else {
      setErrorMessage(null);
      onSelect(authMethod as AuthType, SettingScope.User);
    }
  };

  useInput((_input, key) => {
    if (key.escape) {
      // Prevent exit if there is an error message.
      // This means they user is not authenticated yet.
      if (errorMessage) {
        return;
      }
      if (settings.merged.selectedAuthType === undefined) {
        // Prevent exiting if no auth method is set
        setErrorMessage(
          'You must select an auth method to proceed. Press Ctrl+C twice to exit.',
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
        <Text bold>{t('auth.dialog.title')}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{t('auth.option.custom.model')}</Text>
      </Box>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={items}
          initialIndex={initialAuthIndex}
          onSelect={handleAuthSelect}
          isFocused={true}
        />
      </Box>
      {errorMessage && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{errorMessage}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          {t('model.management.hint')}
        </Text>
      </Box>
    </Box>
  );
}
