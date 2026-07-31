/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 根目录生产启动器回归：用 preload 截获 dist 服务模块，验证启动器真的调用
 * startEnterpriseServer，而不是仅 require 模块后打印“已启动”。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temporaryDirectories: string[] = [];
const EXPECTED_BUILD_COMMIT = '0123456789abcdef0123456789abcdef01234567';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('start-enterprise.cjs', () => {
  it('调用 dist startEnterpriseServer，并按真实默认 host 输出地址', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-enterprise-launcher-'),
    );
    temporaryDirectories.push(directory);
    const capturePath = path.join(directory, 'capture.json');
    const preloadPath = path.join(directory, 'preload.cjs');
    fs.writeFileSync(
      preloadPath,
      `
const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (String(request).endsWith('packages/server/dist/src/enterprise/server.js')) {
    return {
      startEnterpriseServer(options) {
        fs.writeFileSync(process.env.OTTO_LAUNCHER_TEST_OUTPUT, JSON.stringify({
          options,
          host: process.env.OTTO_ENTERPRISE_HOST,
          port: process.env.OTTO_ENTERPRISE_PORT,
        }));
        return { close(callback) { if (callback) callback(); } };
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
`,
    );
    const launcherPath = fileURLToPath(
      new URL('../../../../start-enterprise.cjs', import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [launcherPath, '--port', '8123'],
      {
        cwd: path.dirname(launcherPath),
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS || ''} --require ${preloadPath}`.trim(),
          OTTO_ENTERPRISE_HOST: '127.0.0.1',
          OTTO_BUILD_COMMIT: EXPECTED_BUILD_COMMIT,
          GITHUB_SHA: '',
          OTTO_LAUNCHER_TEST_OUTPUT: capturePath,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(capturePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(capturePath, 'utf8'))).toMatchObject({
      host: '127.0.0.1',
      port: '8123',
      options: {
        host: '127.0.0.1',
        port: 8123,
        appVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        buildCommit: EXPECTED_BUILD_COMMIT,
      },
    });
    expect(result.stdout).toContain('http://127.0.0.1:8123');
    expect(result.stdout).not.toContain('http://0.0.0.0:8123');
  });
});
