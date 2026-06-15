/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  createContentGenerator,
  AuthType,
  createContentGeneratorConfig,
} from './contentGenerator.js';
import { OttoServerAdapter } from './OttoServerAdapter.js';
import { Config } from '../config/config.js';
import * as proxyConfig from '../config/proxyConfig.js';

vi.mock('./OttoServerAdapter.js');
vi.mock('../config/proxyConfig.js');

const mockConfig = {
  getCustomProxyServerUrl: vi.fn(),
  getModel: vi.fn().mockReturnValue('gemini-pro'),
  getProxy: vi.fn(),
} as unknown as Config;

describe('createContentGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(proxyConfig.hasAvailableProxyServer).mockReturnValue(true);
    vi.mocked(proxyConfig.getActiveProxyServerUrl).mockReturnValue('http://mock-server');
  });

  it('should create a OttoServerAdapter', async () => {
    const generator = await createContentGenerator(
      {
        authType: AuthType.USE_PROXY_AUTH,
      },
      mockConfig,
    );
    expect(OttoServerAdapter).toHaveBeenCalled();
    expect(generator).toBeInstanceOf(OttoServerAdapter);
  });

  it('should use custom proxy server URL if provided', async () => {
    vi.mocked(mockConfig.getCustomProxyServerUrl).mockReturnValue('http://custom-server');

    await createContentGenerator(
      {
        authType: AuthType.USE_PROXY_AUTH,
      },
      mockConfig,
    );

    expect(OttoServerAdapter).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'http://custom-server',
      mockConfig
    );
  });
});

describe('createContentGeneratorConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should create a config with proxy auth type', async () => {
    const config = await createContentGeneratorConfig(
      mockConfig,
      AuthType.USE_PROXY_AUTH,
    );
    expect(config.authType).toBe(AuthType.USE_PROXY_AUTH);
  });
});