/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * server 端点发现：把运行期连接信息写进 `~/.otto-user/server-endpoint.json`，
 * 让 Electron 主进程 / 飞书 daemon 无需约定端口即可发现已运行的 server
 * （对齐 feishuDaemon.ts 的 `~/.otto-user/` 三件套约定）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PROTOCOL_VERSION, type ServerEndpoint } from './protocol.js';

const CONFIG_DIR = path.join(os.homedir(), '.otto-user');
const ENDPOINT_FILE = path.join(CONFIG_DIR, 'server-endpoint.json');

export function endpointFilePath(): string {
  return ENDPOINT_FILE;
}

/** 写端点文件（server 启动后调）。 */
export function writeEndpoint(host: string, port: number): ServerEndpoint {
  const ep: ServerEndpoint = {
    host,
    port,
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    startedAt: Date.now(),
  };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(ENDPOINT_FILE, JSON.stringify(ep, null, 2), { mode: 0o600 });
  return ep;
}

/** 读端点文件（desktop / daemon 发现 server 用）。不存在返回 undefined。 */
export function readEndpoint(): ServerEndpoint | undefined {
  try {
    const raw = fs.readFileSync(ENDPOINT_FILE, 'utf8');
    return JSON.parse(raw) as ServerEndpoint;
  } catch {
    return undefined;
  }
}

/** 清除端点文件（server 停止时调）。 */
export function clearEndpoint(): void {
  try {
    fs.rmSync(ENDPOINT_FILE, { force: true });
  } catch {
    // 忽略：文件不存在即视为已清。
  }
}
