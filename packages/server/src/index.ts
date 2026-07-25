/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * otto-server 包入口（barrel）。
 *
 * desktop 端经 `from 'otto-server'` 复用协议类型与服务类。
 */

export * from './protocol.js';
export * from './sessions.js';
export * from './sessions-persistent.js';
export { OttoServer } from './server.js';
export type { OttoServerOptions, RuntimeFactory } from './server.js';
export {
  createEnterpriseServer,
  startEnterpriseServer,
} from './enterprise/server.js';
export type { EnterpriseServerOptions } from './enterprise/server.js';
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
export * from './modelCatalog.js';
export * from './productWorkspace.js';
export * from './productWorkspaceStore.js';
export * from './agentProfiles.js';
export type {
  FeishuRegistration,
  FeishuRegisterDeps,
} from './feishu/register.js';
export { registerFeishu } from './feishu/register.js';
export {
  endpointFilePath,
  readEndpoint,
  readEndpointRecord,
  writeEndpoint,
  clearEndpoint,
} from './endpoint.js';
export type { ServerEndpointRecord } from './endpoint.js';
