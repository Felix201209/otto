/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { CustomModelConfig } from 'otto-core';

import { loadEnterpriseModelCatalog } from './modelCatalog.js';
import type { AuthenticatedManagedModelGateway } from './productWorkspaceStore.js';

export const MANAGED_MODEL_UNAVAILABLE_CODE = 'managed_model_unavailable';

export class ManagedModelUnavailableError extends Error {
  readonly code = MANAGED_MODEL_UNAVAILABLE_CODE;

  constructor(message = '企业托管模型暂不可用，请检查授权、余额或服务器连接。') {
    super(message);
    this.name = 'ManagedModelUnavailableError';
  }
}

function requireAccess(
  model: string,
  expectedBaseUrl: string | null,
  provider: () => AuthenticatedManagedModelGateway | null,
): AuthenticatedManagedModelGateway {
  const access = provider();
  if (
    !access ||
    Date.parse(access.expiresAt) <= Date.now() ||
    !access.allowedModels.includes(model) ||
    (expectedBaseUrl !== null && access.baseUrl !== expectedBaseUrl)
  ) {
    throw new ManagedModelUnavailableError();
  }
  return access;
}

/**
 * 将稳定的 `otto:*` 目录项映射为运行时专用 OpenAI-compatible 配置。
 * `apiKey` 只是非敏感占位符，真实短令牌由 apiKeyProvider 每次出网前从
 * ProductWorkspace 的内存身份读取，不会写入模型配置文件。
 */
export function createManagedModelConfig(
  model: string,
  accessProvider: () => AuthenticatedManagedModelGateway | null,
): CustomModelConfig {
  const catalogEntry = loadEnterpriseModelCatalog().find(
    (entry) => entry.id === model,
  );
  if (!catalogEntry) {
    throw new ManagedModelUnavailableError('未知的企业托管模型。');
  }
  const initial = requireAccess(model, null, accessProvider);
  return {
    displayName: catalogEntry.displayName,
    provider: 'openai',
    baseUrl: initial.baseUrl,
    apiKey: '__OTTO_MANAGED_RUNTIME_TOKEN__',
    apiKeyProvider: async () =>
      requireAccess(model, initial.baseUrl, accessProvider).accessToken,
    modelId: model,
    enabled: true,
  };
}

