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
import { validateAuthMethod, handleFeishuAuth } from '../../config/auth.js';
import { AuthServer } from 'otto-core';
import { exec } from 'child_process';
import { t } from '../utils/i18n.js';

interface LoginDialogProps {
  onSelect: (authMethod: AuthType | undefined, scope: SettingScope) => void;
  settings: LoadedSettings;
  initialErrorMessage?: string | null;
}

// 全局认证服务器实例
let authServerInstance: AuthServer | null = null;

/**
 * 启动认证服务器
 */
async function startAuthServer(): Promise<void> {
  if (authServerInstance) {
    console.log('🔄 认证服务器已在运行中');
    return;
  }

  authServerInstance = new AuthServer();
  await authServerInstance.start();
}

/**
 * 打开浏览器
 */
function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' :
                  process.platform === 'win32' ? 'start' : 'xdg-open';

  exec(`${command} ${url}`, (error) => {
    if (error) {
      console.error('❌ 打开浏览器失败:', error);
    } else {
      console.log('✅ 浏览器已打开:', url);
    }
  });
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

  // 功能实现: 只显示DeepVlab统一认证选项
  // 实现方案: 使用DeepVlab统一认证系统进行认证
  // 影响范围: LoginDialog组件的认证选项列表
  // 实现日期: 2025-01-26
  const items = [
    { label: t('auth.option.deepvlab'), value: AuthType.USE_PROXY_AUTH },
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

  const handleAuthSelect = (authMethod: AuthType) => {
    console.log('🔍 AuthDialog: handleAuthSelect called with authMethod:', authMethod);

    // 防止重复提交：如果正在认证中，忽略后续的选择
    if (isAuthenticating) {
      console.log('⚠️ AuthDialog: Authentication already in progress, ignoring duplicate selection');
      return;
    }

    if (authMethod === AuthType.USE_PROXY_AUTH) {
      console.log('🚀 AuthDialog: Proxy auth selected, starting auth server...');
      setIsAuthenticating(true); // 设置认证状态为进行中
      setErrorMessage('🚀 正在启动认证服务器，请稍候...');

      // 启动认证服务器并打开浏览器
      startAuthServer()
        .then(() => {
          setErrorMessage('✅ 认证服务器已启动！正在打开浏览器...');
          // 打开浏览器到认证选择页面
          openBrowser('http://localhost:7862');

          // 验证代理服务器配置
          const error = validateAuthMethod(authMethod);
          if (error) {
            setErrorMessage(`认证服务器启动成功，但代理配置有误：\n${error}`);
            setIsAuthenticating(false); // 重置认证状态
          } else {
            setErrorMessage('✅ 认证服务器已启动！请在浏览器中选择认证方式...');
            // 注意：这里不重置认证状态，因为即将调用onSelect完成认证流程
            onSelect(authMethod, SettingScope.User);
          }
        })
        .catch((error) => {
          console.error('❌ AuthDialog: Auth server start error:', error);
          const errorMsg = error instanceof Error ? error.message : '未知错误';
          setErrorMessage(`❌ 认证服务器启动失败：${errorMsg}`);
          setIsAuthenticating(false); // 重置认证状态
        });
    } else {
      console.log('📝 AuthDialog: Other auth method selected:', authMethod);
      // 其他认证方式的原有逻辑（不需要飞书认证）
      const error = validateAuthMethod(authMethod);
      if (error) {
        setErrorMessage(error);
      } else {
        setErrorMessage(null);
        onSelect(authMethod, SettingScope.User);
      }
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
        <Text bold color={Colors.AccentCyan}>Otto 登录</Text>
      </Box>
      <Box marginTop={1}>
        <Text>请选择您的登录方式：</Text>
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
          {isAuthenticating ? '登录进行中，请稍候...' : '按回车键选择'}
        </Text>
      </Box>
    </Box>
  );
}
