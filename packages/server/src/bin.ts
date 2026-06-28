/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * otto-server CLI 入口：`otto-server start|stop|status`。
 *
 * 风格对齐现有飞书 daemon（pid/health 文件落 ~/.otto-user/）。
 * - start：前台拉起 OttoServer，写端点文件；Ctrl-C / SIGTERM 优雅退出。
 *   （后台化由 Issue #9 的 daemon 壳负责：detached spawn 本入口，与 feishuDaemon.ts 同款。）
 * - status：读端点文件 + 探活，打印连接信息。
 * - stop：读端点文件，按 pid 发 SIGTERM。
 *
 * Electron 主进程也可不经本入口，直接 `new OttoServer().start()` 内嵌。
 */

import { OttoServer } from './server.js';
import {
  clearEndpoint,
  readEndpoint,
  writeEndpoint,
} from './endpoint.js';
import { DEFAULT_HOST, DEFAULT_PORT } from './protocol.js';

async function cmdStart(): Promise<void> {
  const port = Number(process.env.OTTO_SERVER_PORT ?? DEFAULT_PORT);
  const server = new OttoServer({ host: DEFAULT_HOST, port });
  await server.start();
  const { host, port: boundPort } = server.endpoint;
  writeEndpoint(host, boundPort);
  // eslint-disable-next-line no-console
  console.log(`[otto-server] listening on http://${host}:${boundPort} (ws ${host}:${boundPort}/ws)`);

  const shutdown = async (): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log('\n[otto-server] shutting down…');
    await server.stop();
    clearEndpoint();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

function cmdStatus(): void {
  const ep = readEndpoint();
  if (!ep) {
    // eslint-disable-next-line no-console
    console.log('[otto-server] 未发现运行中的 server（无端点文件）。');
    process.exitCode = 1;
    return;
  }
  const alive = isAlive(ep.pid);
  // eslint-disable-next-line no-console
  console.log(
    alive
      ? `[otto-server] 运行中 PID ${ep.pid} @ http://${ep.host}:${ep.port}（协议 v${ep.protocolVersion}）`
      : `[otto-server] 端点文件存在但进程 ${ep.pid} 已退出（陈旧端点）。`,
  );
  if (!alive) process.exitCode = 1;
}

function cmdStop(): void {
  const ep = readEndpoint();
  if (!ep || !isAlive(ep.pid)) {
    // eslint-disable-next-line no-console
    console.log('[otto-server] 没有运行中的 server 可停止。');
    clearEndpoint();
    return;
  }
  try {
    process.kill(ep.pid, 'SIGTERM');
    clearEndpoint();
    // eslint-disable-next-line no-console
    console.log(`[otto-server] 已向 PID ${ep.pid} 发送 SIGTERM。`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[otto-server] 停止失败: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'start';
  switch (cmd) {
    case 'start':
      await cmdStart();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'stop':
      cmdStop();
      break;
    default:
      // eslint-disable-next-line no-console
      console.error(`未知命令: ${cmd}（用 start | stop | status）`);
      process.exitCode = 2;
  }
}

void main();
