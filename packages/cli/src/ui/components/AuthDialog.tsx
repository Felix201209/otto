/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Colors } from '../colors.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { AuthType } from 'otto-core';
import { validateAuthMethod, handleDeepvlabAuth } from '../../config/auth.js';
import { t, tp } from '../utils/i18n.js';

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
      process.env.DEEPV_DEFAULT_AUTH_TYPE,
    );

    if (process.env.DEEPV_DEFAULT_AUTH_TYPE && defaultAuthType === null) {
      return (
        `Invalid value for DEEPV_DEFAULT_AUTH_TYPE: "${process.env.DEEPV_DEFAULT_AUTH_TYPE}". ` +
        `Valid values are: ${Object.values(AuthType).join(', ')}.`
      );
    }

    // API key detection removed - only Cheeth OA authentication supported
    return null;
  });

  // 添加认证进行中的状态，防止重复提交
  const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false);
  // 添加认证URL状态
  const [authUrl, setAuthUrl] = useState<string>('');

  // 功能实现: 显示DeepVlab统一认证选项和自定义模型选项
  // 实现方案: 使用DeepVlab统一认证系统进行认证，或使用自定义模型（无需登录）
  // 影响范围: AuthDialog组件的认证选项列表
  // 实现日期: 2025-01-26
  const items = [
    { label: t('auth.option.deepvlab'), value: AuthType.USE_PROXY_AUTH },
    { label: t('auth.option.custom.model'), value: USE_CUSTOM_MODEL_VALUE },
  ];

  // 隐藏的认证选项（保留代码以便未来恢复）:
  // {
  //   label: '使用 Google 登录',
  //   value: AuthType.LOGIN_WITH_GOOGLE,
  // },
  // ...(process.env.CLOUD_SHELL === 'true'
  //   ? [
  //       {
  //         label: '使用 Cloud Shell 用户凭据',
  //         value: AuthType.CLOUD_SHELL,
  //       },
  //     ]
  //   : []),
  // {
  //   label: '使用 Gemini API 密钥',
  //   value: AuthType.USE_GEMINI,
  // },
  // { label: 'Vertex AI', value: AuthType.USE_VERTEX_AI },

  // 只有一个认证选项（Cheeth OA），直接默认选择
  const initialAuthIndex = 0;

  const handleAuthSelect = (authMethod: AuthType | string) => {
    console.log('🔍 AuthDialog: handleAuthSelect called with authMethod:', authMethod);

    // 防止重复提交：如果正在认证中，忽略后续的选择
    if (isAuthenticating) {
      console.log('⚠️ AuthDialog: Authentication already in progress, ignoring duplicate selection');
      return;
    }

    // 处理"使用自定义模型"选项
    if (authMethod === USE_CUSTOM_MODEL_VALUE) {
      console.log('🔧 AuthDialog: Custom model option selected');
      if (onUseCustomModel) {
        onUseCustomModel();
      }
      return;
    }

    if (authMethod === AuthType.USE_PROXY_AUTH) {
      console.log('🚀 AuthDialog: Proxy auth selected, starting DeepVlab auth...');
      setIsAuthenticating(true); // 设置认证状态为进行中
      setErrorMessage(t('auth.deepvlab.starting'));

      // 异步处理DeepVlab认证 - 主动重新认证时清除现有token
      handleDeepvlabAuth(
        'http://localhost:9000',
        settings,
        true,
        // URL准备好时的回调
        (url: string) => {
          console.log('🌐 AuthDialog: Auth URL ready:', url);
          setAuthUrl(url);
        }
      )
        .then((deepvlabAuthResult) => {
          console.log('✅ AuthDialog: DeepVlab auth result:', deepvlabAuthResult);
          if (!deepvlabAuthResult.success) {
            setErrorMessage(t('auth.deepvlab.failed'));
            setIsAuthenticating(false); // 重置认证状态
            setAuthUrl(''); // 清除URL
            return;
          }

          // DeepVlab认证成功后，验证代理服务器配置
          const error = validateAuthMethod(authMethod);
          if (error) {
            setErrorMessage(tp('auth.deepvlab.config.error', { error }));
            setIsAuthenticating(false); // 重置认证状态
          } else {
            setErrorMessage(t('auth.deepvlab.config.success'));
            // 注意：这里不重置认证状态，因为即将调用onSelect完成认证流程
            onSelect(authMethod, SettingScope.User);
          }
        })
        .catch((error) => {
          console.error('❌ AuthDialog: DeepVlab auth error:', error);
          const errorMsg = error instanceof Error ? error.message : '未知错误';
          setErrorMessage(tp('auth.deepvlab.error', { error: errorMsg }));
          setIsAuthenticating(false); // 重置认证状态
        });
    } else {
      console.log('📝 AuthDialog: Other auth method selected:', authMethod);
      // 其他认证方式的原有逻辑（不需要飞书认证）
      const error = validateAuthMethod(authMethod as AuthType);
      if (error) {
        setErrorMessage(error);
      } else {
        setErrorMessage(null);
        onSelect(authMethod as AuthType, SettingScope.User);
      }
    }
  };

  useInput((_input, key) => {
    if (key.escape) {
      // 如果正在认证中，允许取消认证
      if (isAuthenticating) {
        setIsAuthenticating(false);
        setAuthUrl('');
        setErrorMessage(t('auth.deepvlab.cancelled'));
        return;
      }

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
        <Text>{t('auth.dialog.how.to.authenticate')}</Text>
      </Box>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={items}
          initialIndex={initialAuthIndex}
          onSelect={handleAuthSelect}
          isFocused={!isAuthenticating}
        />
      </Box>
      {errorMessage && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{errorMessage}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          {isAuthenticating ? t('auth.dialog.authenticating') : t('auth.dialog.select.hint')}
        </Text>
      </Box>
      {isAuthenticating && authUrl && (
        <Box marginTop={1}>
          <Text color={Colors.AccentBlue}>{tp('auth.deepvlab.browser.url', { url: authUrl })}</Text>
        </Box>
      )}
      {isAuthenticating && (
        <Box marginTop={1}>
          <Text color={Colors.Gray}>{t('auth.deepvlab.cancel.hint')}</Text>
        </Box>
      )}
    </Box>
  );
}
