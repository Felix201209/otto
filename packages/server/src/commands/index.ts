/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * server 侧斜杠命令层（桌面端命令面板的执行后端）。
 * server.ts 只需要 executeSlashCommand / listSlashCommands 两个入口。
 */

export * from './types.js';
export {
  executeSlashCommand,
  listSlashCommands,
  getSlashCommand,
} from './registry.js';
