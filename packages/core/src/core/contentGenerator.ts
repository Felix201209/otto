/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CountTokensResponse,
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentResponse,
  EmbedContentParameters,
} from '@google/genai';
import { Config } from '../config/config.js';
import { UserTierId } from '../code_assist/types.js';
import { OttoServerAdapter } from './OttoServerAdapter.js';
import { getActiveProxyServerUrl, hasAvailableProxyServer } from '../config/proxyConfig.js';
import { SceneType } from './sceneManager.js';

/**
 * Interface abstracting the core functionalities for generating content and counting tokens.
 */
export interface ContentGenerator {
  generateContent(
    request: GenerateContentParameters,
    scene: SceneType,
  ): Promise<GenerateContentResponse>;

  generateContentStream(
    request: GenerateContentParameters,
    scene: SceneType,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;

  userTier?: UserTierId;
}

export enum AuthType {
  USE_PROXY_AUTH = 'proxy-auth',
}

export type ContentGeneratorConfig = {
  //model: string;
  authType?: AuthType | undefined;
  proxy?: string | undefined;
};

export function createContentGeneratorConfig(
  config: Config,
  authType: AuthType | undefined,
): ContentGeneratorConfig {

  // BUG修复: 系统默认使用Claude模型，无需特殊处理
  // 修复策略: 直接使用配置的模型或默认模型（现在默认就是Claude）
  // ✅ 移除默认模型依赖 - 服务端内部决定模型
  const effectiveModel = config.getModel() || 'auto'; // 使用auto让服务端决定

  const contentGeneratorConfig: ContentGeneratorConfig = {
    //model: effectiveModel,
    authType,
    proxy: config?.getProxy(),
  };

  // Proxy server authentication - no additional validation needed
  if (authType === AuthType.USE_PROXY_AUTH) {
    return contentGeneratorConfig;
  }


  return contentGeneratorConfig;
}

export async function createContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
  sessionId?: string,
): Promise<ContentGenerator> {
  // NOTE: The DeepV server path below (the only active path) builds its request
  // headers — including the User-Agent — via proxyAuthManager.getUserHeaders(),
  // which uses the unified getUserAgent() from utils/userAgent.ts. No local
  // httpOptions/User-Agent is needed here.

  // 🎯 统一DeepV Server处理：所有模型都使用OttoServerAdapter，但路由逻辑会自动选择正确的API端点
  const isDeepVServer = true; // 现在所有模型都通过DeepV Server，适配器内部会根据模型类型选择正确路径

  if (isDeepVServer) {

    // Use custom proxy server URL if configured, otherwise use default
    const customProxyUrl = gcConfig.getCustomProxyServerUrl();
    let proxyServerUrl: string;

    if (customProxyUrl) {
      proxyServerUrl = customProxyUrl;
      console.log(`[DeepX] Using custom proxy server: ${proxyServerUrl}`);
    } else {
      // 确保有可用的代理服务器
      if (!hasAvailableProxyServer()) {
        throw new Error(
          'Otto server is required for all models but is not available. ' +
          'Please start the Otto server or use proxy authentication.'
        );
      }

      proxyServerUrl = getActiveProxyServerUrl();
      console.log(`[DeepX] Connecting to Otto server: ${proxyServerUrl}`);
    }

    // 🔧 Linus式修复：统一使用OttoServerAdapter，内部会根据模型类型自动路由
    // NOTE: googleCloudLocation and googleCloudProject are legacy parameters, no longer used after switching to proxy-based architecture
    const googleCloudLocation = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    const googleCloudProject = process.env.GOOGLE_CLOUD_PROJECT || 'default-project';

    return new OttoServerAdapter(googleCloudLocation, googleCloudProject, proxyServerUrl, gcConfig);
  }

  // For other auth types (should only be USE_PROXY_AUTH now), fall through to error

  throw new Error(
    `Error creating contentGenerator: Unsupported authType: ${config.authType}`,
  );
}
