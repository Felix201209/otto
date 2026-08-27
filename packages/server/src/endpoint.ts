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

/**
 * 磁盘端点记录可以附带本机控制令牌。普通 ServerEndpoint 仍是可公开的连接信息，
 * 避免 token 被意外带进 renderer/线协议类型。
 */
export interface ServerEndpointRecord extends ServerEndpoint {
  controlToken?: string;
  /** 仅写入可信端点文件，用于区分桌面托管进程与用户手动启动的 CLI。 */
  owner?: 'desktop';
}

export function endpointFilePath(): string {
  return ENDPOINT_FILE;
}

/** 写端点文件（server 启动后调）。 */
export function writeEndpoint(
  host: string,
  port: number,
  clientToken: string,
  controlToken?: string,
  owner?: 'desktop',
): ServerEndpoint {
  if (!clientToken.trim()) {
    throw new Error('clientToken 不能为空');
  }
  const ep: ServerEndpointRecord = {
    host,
    port,
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    startedAt: Date.now(),
    clientToken,
    ...(controlToken ? { controlToken } : {}),
    ...(owner ? { owner } : {}),
  };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(ENDPOINT_FILE, JSON.stringify(ep, null, 2), { mode: 0o600 });
  // writeFile 的 mode 不会收紧既有文件权限；显式 chmod 保证每次都是 0600。
  fs.chmodSync(ENDPOINT_FILE, 0o600);
  return publicEndpoint(ep);
}

/** 读端点文件（desktop / daemon 发现 server 用）。不存在返回 undefined。 */
export function readEndpoint(): ServerEndpoint | undefined {
  const record = readEndpointRecord();
  return record ? publicEndpoint(record) : undefined;
}

/**
 * 可信主进程读取含控制令牌的 0600 记录。不得把返回值透传 renderer；
 * 普通发现、status/stop 一律使用上面的 readEndpoint()。
 */
export function readEndpointRecord(): ServerEndpointRecord | undefined {
  try {
    const raw = fs.readFileSync(ENDPOINT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ServerEndpointRecord>;
    if (
      typeof parsed.host !== 'string' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.protocolVersion !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.clientToken !== 'string' ||
      !parsed.clientToken.trim() ||
      (parsed.owner !== undefined && parsed.owner !== 'desktop')
    ) {
      return undefined;
    }
    return parsed as ServerEndpointRecord;
  } catch {
    return undefined;
  }
}

function publicEndpoint(record: ServerEndpointRecord): ServerEndpoint {
  return {
    host: record.host,
    port: record.port,
    protocolVersion: record.protocolVersion,
    pid: record.pid,
    startedAt: record.startedAt,
    clientToken: record.clientToken,
  };
}

/** 清除端点文件（server 停止时调）。 */
export function clearEndpoint(): void {
  try {
    fs.rmSync(ENDPOINT_FILE, { force: true });
  } catch {
    // 忽略：文件不存在即视为已清。
  }
}
