/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, Config } from 'otto-core';
import { validateAuthMethod } from './config/auth.js';

export async function validateNonInteractiveAuth(
  configuredAuthType: AuthType | undefined,
  nonInteractiveConfig: Config,
) {
  // Otto 统一走服务端代理认证（飞书登录 / 自定义模型），
  // 未显式配置时兜底 USE_PROXY_AUTH，因此这里恒有有效认证方式。
  const effectiveAuthType = configuredAuthType || AuthType.USE_PROXY_AUTH;

  const err = validateAuthMethod(effectiveAuthType);
  if (err != null) {
    console.error(err);
    process.exit(1);
  }

  await nonInteractiveConfig.refreshAuth(effectiveAuthType);
  return nonInteractiveConfig;
}
