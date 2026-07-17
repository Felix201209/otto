/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  ServerManager,
  type ServerManagerDependencies,
} from './server-manager.js';

const MAIN_ENDPOINT = {
  host: '127.0.0.1',
  port: 4_123,
  protocolVersion: 1,
  pid: 123,
  startedAt: 1,
};

function discoveredMainModule() {
  return {
    readEndpoint: vi.fn(() => MAIN_ENDPOINT),
    clearEndpoint: vi.fn(),
    DEFAULT_PORT: 3_700,
    HTTP_ROUTES: { health: '/health' },
  } as unknown as Awaited<ReturnType<ServerManagerDependencies['loadOttoServer']>>;
}

function fakeHttpServer(
  start: (server: EventEmitter) => void,
): {
  server: HttpServer;
  close: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const close = vi.fn((callback?: () => void) => {
    callback?.();
    return emitter;
  });
  const listen = vi.fn(() => {
    start(emitter);
    return emitter;
  });
  Object.assign(emitter, {
    listen,
    close,
  });
  return { server: emitter as unknown as HttpServer, close, listen };
}

function dependencies(
  overrides: Partial<ServerManagerDependencies> = {},
): ServerManagerDependencies {
  return {
    loadOttoServer: async () => discoveredMainModule(),
    loadEnterpriseServer: async () => {
      throw new Error('enterprise factory was not configured');
    },
    pidAlive: () => true,
    probeHealth: async (_host, port) => port === MAIN_ENDPOINT.port,
    enterpriseListenTimeoutMs: 25,
    ...overrides,
  };
}

describe('ServerManager enterprise lifecycle', () => {
  it('复用已运行的主服务时仍会启动企业后台服务', async () => {
    const local = fakeHttpServer((server) => queueMicrotask(() => server.emit('listening')));
    const createEnterpriseServer = vi.fn(() => ({
      server: local.server,
      host: '127.0.0.1',
      port: 7_777,
    }));
    const manager = new ServerManager({
      enterpriseServerUrl: 'http://127.0.0.1:7777',
      dependencies: dependencies({
        loadEnterpriseServer: async () => ({
          createEnterpriseServer,
        }) as unknown as Awaited<
          ReturnType<ServerManagerDependencies['loadEnterpriseServer']>
        >,
      }),
    });

    await expect(manager.ensure()).resolves.toMatchObject({
      endpoint: MAIN_ENDPOINT,
      ownership: 'discovered',
    });
    expect(createEnterpriseServer).toHaveBeenCalledOnce();
    expect(createEnterpriseServer).toHaveBeenCalledWith(expect.objectContaining({
      publicUrl: 'http://127.0.0.1:7777',
    }));
    expect(manager.currentEnterpriseOwnership).toBe('embedded');

    await manager.shutdown();
    expect(local.close).toHaveBeenCalled();
  });

  it('7777 已有健康企业服务时复用它，不重复监听端口', async () => {
    const loadEnterpriseServer = vi.fn();
    const manager = new ServerManager({
      enterpriseServerUrl: 'http://127.0.0.1:7777',
      dependencies: dependencies({
        loadEnterpriseServer,
        probeHealth: async (_host, port) => (
          port === MAIN_ENDPOINT.port || port === 7_777
        ),
      }),
    });

    await manager.ensure();

    expect(loadEnterpriseServer).not.toHaveBeenCalled();
    expect(manager.currentEnterpriseOwnership).toBe('discovered');
  });

  it('监听超时会关闭未就绪的 server，且不把它误报为已启动', async () => {
    const local = fakeHttpServer(() => undefined);
    const manager = new ServerManager({
      enterpriseServerUrl: 'http://127.0.0.1:7777',
      dependencies: dependencies({
        loadEnterpriseServer: async () => ({
          createEnterpriseServer: () => ({
            server: local.server,
            host: '127.0.0.1',
            port: 7_777,
          }),
        }) as unknown as Awaited<
          ReturnType<ServerManagerDependencies['loadEnterpriseServer']>
        >,
        enterpriseListenTimeoutMs: 10,
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(manager.ensure()).resolves.toMatchObject({ ownership: 'discovered' });

    expect(local.close).toHaveBeenCalled();
    expect(manager.currentEnterpriseOwnership).toBe('unavailable');
    warn.mockRestore();
  });

  it('探活与监听之间发生端口竞争时，若对方已健康则复用', async () => {
    const local = fakeHttpServer((server) => queueMicrotask(() => {
      const error = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
      server.emit('error', error);
    }));
    let enterpriseProbes = 0;
    const manager = new ServerManager({
      enterpriseServerUrl: 'http://127.0.0.1:7777',
      dependencies: dependencies({
        loadEnterpriseServer: async () => ({
          createEnterpriseServer: () => ({
            server: local.server,
            host: '127.0.0.1',
            port: 7_777,
          }),
        }) as unknown as Awaited<
          ReturnType<ServerManagerDependencies['loadEnterpriseServer']>
        >,
        probeHealth: async (_host, port) => {
          if (port === MAIN_ENDPOINT.port) return true;
          enterpriseProbes += 1;
          return enterpriseProbes >= 2;
        },
      }),
    });

    await manager.ensure();

    expect(manager.currentEnterpriseOwnership).toBe('discovered');
  });

  it('公网中心模式不在每台客户端创建一套脱节的本机企业库', async () => {
    const loadEnterpriseServer = vi.fn();
    const manager = new ServerManager({
      enterpriseServerUrl: 'https://59.110.154.44:7777',
      dependencies: dependencies({ loadEnterpriseServer }),
    });

    await manager.ensure();

    expect(loadEnterpriseServer).not.toHaveBeenCalled();
    expect(manager.currentEnterpriseOwnership).toBe('external');
  });

  it('并发 ensure 只启动一个本机企业服务', async () => {
    const control: { releaseListen?: () => void } = {};
    const local = fakeHttpServer((server) => {
      control.releaseListen = () => server.emit('listening');
    });
    const createEnterpriseServer = vi.fn(() => ({
      server: local.server,
      host: '127.0.0.1',
      port: 7_777,
    }));
    const manager = new ServerManager({
      enterpriseServerUrl: 'http://127.0.0.1:7777',
      dependencies: dependencies({
        loadEnterpriseServer: async () => ({
          createEnterpriseServer,
        }) as unknown as Awaited<
          ReturnType<ServerManagerDependencies['loadEnterpriseServer']>
        >,
        enterpriseListenTimeoutMs: 500,
      }),
    });

    const first = manager.ensure();
    const second = manager.ensure();
    await vi.waitFor(() => expect(control.releaseListen).toBeTypeOf('function'));
    control.releaseListen!();
    await Promise.all([first, second]);

    expect(createEnterpriseServer).toHaveBeenCalledOnce();
    await manager.shutdown();
  });

  it('enterprise listen 尚未完成就退出时会立即取消并关闭 pending server', async () => {
    const local = fakeHttpServer(() => undefined);
    const manager = new ServerManager({
      enterpriseServerUrl: 'http://127.0.0.1:7777',
      dependencies: dependencies({
        loadEnterpriseServer: async () => ({
          createEnterpriseServer: () => ({
            server: local.server,
            host: '127.0.0.1',
            port: 7_777,
          }),
        }) as unknown as Awaited<
          ReturnType<ServerManagerDependencies['loadEnterpriseServer']>
        >,
        enterpriseListenTimeoutMs: 2_000,
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const ensuring = manager.ensure();
    await vi.waitFor(() => expect(local.listen).toHaveBeenCalledOnce());
    await manager.shutdown();
    expect(local.close).toHaveBeenCalled();
    await ensuring;

    expect(manager.currentEnterpriseOwnership).toBe('unavailable');
    warn.mockRestore();
  });
});
