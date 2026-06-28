/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * otto-server 包入口（barrel）。
 *
 * desktop / 未来 TUI 只读端经 `from 'otto-server'` 复用协议类型与服务类。
 * ⚠️ 不要让 cli/core 反向依赖本包（保 TUI 回归门 Issue #10）。
 */

export * from './protocol.js';
export * from './sessions.js';
export { OttoServer } from './server.js';
export type { OttoServerOptions, RuntimeFactory } from './server.js';
export { createCoreConfig } from './coreConfig.js';
export type { CreateCoreConfigOptions } from './coreConfig.js';
export {
  createCoreSessionRuntime,
  CoreSessionRuntime,
} from './runtime.js';
export {
  loadCustomModels,
  listModelInfos,
  customModelsFilePath,
} from './customModels.js';
export type {
  FeishuRegistration,
  FeishuRegisterDeps,
} from './feishu/register.js';
export { registerFeishu } from './feishu/register.js';
export {
  endpointFilePath,
  readEndpoint,
  writeEndpoint,
  clearEndpoint,
} from './endpoint.js';
