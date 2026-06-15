/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ProxyAuthManager, Config, AuthType } from 'otto-core';
import { createFeishuAuthHandler } from '../auth/feishuAuth.js';
import { loadEnvironment, LoadedSettings, SettingScope } from './settings.js';
import { getFeishuConfigFromServer, testServerConnection } from 'otto-core';
import { AuthServer } from 'otto-core';
import { t, tp } from '../ui/utils/i18n.js';
import { exec } from 'child_process';

/**
 * 检测是否在VSCode终端环境中运行
 */
function isVSCodeTerminal(): boolean {
  return !!(
    process.env.VSCODE_PID ||
    process.env.TERM_PROGRAM === 'vscode'
  );
}

/**
 * VSCode终端状态恢复函数
 * 解决认证完成后VSCode内置终端无法输入的问题
 */
async function restoreVSCodeTerminalState(): Promise<void> {
  if (!isVSCodeTerminal()) {
    return; // 非VSCode环境，无需特殊处理
  }

  console.log('🔧 检测到VSCode终端环境，正在恢复终端状态...');

  try {
    // 方法1：强制刷新终端状态
    if (process.stdout.isTTY) {
      // 发送终端重置序列
      process.stdout.write('\x1b[0m'); // 重置所有属性
      process.stdout.write('\x1b[?25h'); // 显示光标

      // 触发终端重新计算
      const originalColumns = process.stdout.columns;
      if (originalColumns) {
        // 模拟resize事件来强制终端重新校准
        process.stdout.emit('resize');
      }
    }

    // 方法2：短暂延迟让VSCode终端稳定
    await new Promise(resolve => setTimeout(resolve, 100));

    // 方法3：发送一个空的输入提示来激活输入状态
    process.stdout.write('\r'); // 回车符

    console.log('✅ VSCode终端状态恢复完成');

  } catch (error) {
    console.warn('⚠️ VSCode终端状态恢复时出现警告:', error);
    // 即使恢复失败也不影响主流程
  }
}

export const validateAuthMethod = (authMethod: string): string | null => {
  loadEnvironment();

  // BUG修复: 只支持代理服务器认证方式
  // 修复策略: 简化认证验证逻辑，只允许代理认证
  // 影响范围: packages/cli/src/config/auth.ts:validateAuthMethod函数
  // 修复日期: 2025-01-09
  if (authMethod === AuthType.USE_PROXY_AUTH) {
    // 代理服务器模式 - 后端根据多种 OAuth2 源自动处理认证
    console.log('[Login Check] Proxy server authentication mode');
    return null;
  }

  return 'Invalid auth method selected. Only proxy server authentication is supported.';
};

/**
 * 处理飞书认证流程
 * 功能实现: 在Vertex AI认证前先进行飞书OAuth2认证
 * 实现方案: 启动本地服务器接收OAuth2回调，完成后重定向到下一步
 * 影响范围: 认证流程增加飞书认证步骤
 * 实现日期: 2025-01-08
 */
/**
 * 使用access token从飞书API获取用户信息
 */
async function getUserInfoFromFeishu(accessToken: string): Promise<any> {
  try {
    const response = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`飞书API错误: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data.code !== 0) {
      throw new Error(`飞书API错误: ${data.code} - ${data.msg || data.message}`);
    }

    if (!data.data) {
      throw new Error('飞书API返回数据为空');
    }

    // 转换为标准格式
    return {
      openId: data.data.open_id,
      userId: data.data.user_id || data.data.open_id,
      name: data.data.name,
      enName: data.data.en_name,
      email: data.data.email,
      avatar: data.data.avatar_url,
    };
  } catch (error) {
    console.error('获取飞书用户信息失败:', error);
    throw error;
  }
}

export async function handleFeishuAuth(
  nextStepUrl: string = 'http://localhost:9000',
  settings?: LoadedSettings
): Promise<boolean> {
  try {
    console.log('🚀 handleFeishuAuth: 开始飞书认证流程...');

    // 从服务端获取配置

    try {
      const feishuConfig = await getFeishuConfigFromServer();
      const FEISHU_APP_ID = feishuConfig.appId;

      if (!FEISHU_APP_ID) {
        throw new Error('服务端飞书配置不完整，请联系管理员检查配置');
      }

      console.log('📱 handleFeishuAuth: 创建认证处理器...');
      // 注意：不再传递appSecret，因为token交换将在服务端进行
      const authHandler = createFeishuAuthHandler(FEISHU_APP_ID, '', nextStepUrl);

      console.log('🌐 handleFeishuAuth: 授权URL:', authHandler.buildAuthUrl());
      console.log('📱 请在浏览器中完成飞书授权...');

      const result = await authHandler.startAuthFlow();

      // 安全修复: 移除完整认证结果打印，避免泄露访问令牌等敏感信息
      console.log('📊 handleFeishuAuth: 认证流程完成，状态:', result.success ? '成功' : '失败');

      if (result.success) {
        console.log('✅ 飞书认证成功！');
        console.log(`🔄 正在重定向到下一步: ${result.nextStepUrl}`);

        // 使用access token交换JWT令牌
        if (result.accessToken) {
          try {
            console.log('📱 正在交换JWT令牌...');

            // 调用服务端的飞书JWT交换接口（统一使用标准端点）
            const proxyServerUrl = process.env.DEEPX_SERVER_URL || 'https://api-code.deepvlab.ai';
            const jwtResponse = await fetch(`${proxyServerUrl}/auth/jwt/feishu-login`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'DeepCode-CLI/1.0.0'
              },
              body: JSON.stringify({
                feishuAccessToken: result.accessToken,
                clientInfo: {
                  platform: process.platform,
                  version: process.version,
                  timestamp: Date.now(),
                  userAgent: 'DeepCode-CLI/1.0.0'
                }
              })
            });

            if (!jwtResponse.ok) {
              const errorText = await jwtResponse.text();
              console.error('❌ JWT交换失败:', jwtResponse.status, errorText);
              throw new Error(`JWT交换失败: ${jwtResponse.status}`);
            }

            const jwtData = await jwtResponse.json();
            console.log('✅ JWT交换成功:', {
              user: jwtData.user?.name,
              email: jwtData.user?.email,
              expiresIn: jwtData.expiresIn
            });

            // 保存JWT令牌和用户信息
            const proxyAuthManager = ProxyAuthManager.getInstance();

            // 保存JWT token（包含refresh token）
            if (jwtData.accessToken) {
              proxyAuthManager.setJwtTokenData({
                accessToken: jwtData.accessToken,
                refreshToken: jwtData.refreshToken,
                expiresIn: jwtData.expiresIn || 900
              });
              console.log('✅ JWT访问令牌和刷新令牌已保存');
            }

            // 保存用户信息
            if (jwtData.user) {
              const userInfo = {
                openId: jwtData.user.open_id || jwtData.user.id,
                userId: jwtData.user.user_id || jwtData.user.id,
                name: jwtData.user.name,
                enName: jwtData.user.en_name || jwtData.user.name,
                email: jwtData.user.email,
                avatar: jwtData.user.avatar_url
              };
              proxyAuthManager.setUserInfo(userInfo);
              console.log(`✅ 用户信息已保存: ${userInfo.name} (${userInfo.email || userInfo.openId || 'N/A'})`);

              console.log('✅ JWT认证配置完成');
            }

            // 如果有刷新令牌，也保存（扩展功能）
            if (jwtData.refreshToken) {
              // TODO: 实现刷新令牌的保存逻辑
              console.log('ℹ️ 收到刷新令牌，暂未实现保存逻辑');
            }

          } catch (error) {
            console.error('❌ JWT交换过程失败:', error);
            // 降级处理：如果JWT交换失败，仍然尝试使用飞书token获取用户信息
            console.log('⚠️ 降级到直接使用飞书token...');

            try {
              const userInfo = await getUserInfoFromFeishu(result.accessToken);
              if (userInfo) {
                console.log(`✅ 降级模式：获取用户信息成功: ${userInfo.name} (${userInfo.email || userInfo.openId || 'N/A'})`);
                const proxyAuthManager = ProxyAuthManager.getInstance();
                proxyAuthManager.setUserInfo(userInfo);
              }
            } catch (fallbackError) {
              console.error('❌ 降级模式也失败:', fallbackError);
              return false;
            }
          }
        }

        return true;
      } else {
        console.error('❌ 飞书认证失败:', result.error);
        return false;
      }

    } catch (configError) {
      console.error('❌ 获取服务端配置失败:', configError);
      console.error('请确认：');
      console.error('  1. DeepX_Code_server 服务是否正在运行');
      console.error('  2. 服务端地址配置是否正确 (DEEPX_SERVER_URL)');
      console.error('  3. 服务端飞书配置是否正确');
      return false;
    }
  } catch (error) {
    console.error('❌ 飞书认证过程中发生错误:', error);
    return false;
  }
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

/**
 * 处理DeepVlab统一认证流程
 * 功能实现: 使用DeepVlab统一认证系统进行认证
 *
 * @param nextStepUrl 认证成功后的下一步URL
 * @param settings 设置对象
 * @param clearExistingAuth 是否清除现有认证（用于主动重新认证）
 * @param onUrlReady 当认证URL准备好时的回调函数
 * @returns 包含认证结果和URL的对象
 */
export async function handleDeepvlabAuth(
  nextStepUrl: string = 'http://localhost:9000',
  settings?: LoadedSettings,
  clearExistingAuth: boolean = false,
  onUrlReady?: (url: string) => void
): Promise<{ success: boolean; authUrl?: string }> {
  try {
    console.log('🚀 handleDeepvlabAuth: Starting DeepVlab unified authentication process...');

    // 如果是主动重新认证，清除现有的JWT token
    if (clearExistingAuth) {
      console.log('🧹 handleDeepvlabAuth: Clearing existing authentication tokens for re-authentication...');
      const proxyAuthManager = ProxyAuthManager.getInstance();
      proxyAuthManager.clear();
      console.log('✅ handleDeepvlabAuth: Existing authentication cleared');
    }

    // 使用authServer进行统一认证
    const authServer = new AuthServer();
    console.log('🌐 handleDeepvlabAuth: Starting authentication server...');

    // 启动认证服务器
    await authServer.start();
    console.log(t('auth.deepvlab.server.started'));

    // 打开浏览器到认证选择页面（使用实际端口）
    const selectPort = authServer.getActualSelectPort();
    const authUrl = `http://localhost:${selectPort}`;
    openBrowser(authUrl);

    // 立即通知URL已准备好
    if (onUrlReady) {
      onUrlReady(authUrl);
    }

    // 等待用户完成认证 - 轮询检查认证状态
    console.log('⏰ 等待认证完成...');
    const maxWaitTime = 300000; // 5分钟超时
    const checkInterval = 2000; // 每2秒检查一次
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // 检查认证状态
        const proxyAuthManager = ProxyAuthManager.getInstance();
        const userInfo = proxyAuthManager.getUserInfo();
        const jwtToken = await proxyAuthManager.getAccessToken();

        if (userInfo && jwtToken) {
          // 验证JWT token是否有效
          if (isValidJwtToken(jwtToken)) {
            console.log('✅ 认证完成！');
            authServer.stop(); // 关闭认证服务器

            // VSCode终端特殊处理：确保终端状态正确恢复
            await restoreVSCodeTerminalState();

            return { success: true, authUrl };
          }
        }
      } catch (error) {
        // 忽略检查过程中的错误，继续等待
      }

      // 等待一段时间后再次检查
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // 超时，关闭服务器
    console.log('⏰ 认证等待超时');
    authServer.stop();

    // VSCode终端特殊处理：即使超时也要恢复终端状态
    await restoreVSCodeTerminalState();

    return { success: false, authUrl };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(tp('auth.deepvlab.server.error', { error: errorMsg }));
    console.error('Please check the following configuration:');
    console.error('  1. Network connection is available');
    console.error('  2. DeepVlab service is accessible');
    console.error('  3. Port 7862 and 7863 are available');
    return { success: false };
  }
}

/**
 * 简单验证JWT token格式和过期时间
 */
function isValidJwtToken(token: string): boolean {
  try {
    // 检查JWT格式
    const parts = token.split('.');
    if (parts.length !== 3) {
      return false;
    }

    // 解析payload
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

    // 检查过期时间
    if (payload.exp) {
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp <= now) {
        return false;
      }
    }

    return true;
  } catch (error) {
    return false;
  }
}
