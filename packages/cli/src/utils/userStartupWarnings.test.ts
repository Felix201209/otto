/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getUserStartupWarnings } from './userStartupWarnings.js';
import * as os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { LoadedSettings } from '../config/settings.js';

// Mock os.homedir to control the home directory in tests
vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof os>();
  return {
    ...actualOs,
    homedir: vi.fn(),
  };
});

// Mock creditsService to avoid ProxyAuthManager initialization errors
const mockGetCreditsInfo = vi.fn().mockResolvedValue(null);
const mockIsCreditsLow = vi.fn().mockReturnValue(false);
vi.mock('../services/creditsService.js', () => ({
  getCreditsService: vi.fn(() => ({
    getCreditsInfo: mockGetCreditsInfo,
    isCreditsLow: mockIsCreditsLow,
  })),
}));

describe('getUserStartupWarnings', () => {
  let testRootDir: string;
  let homeDir: string;
  let emptySettings: LoadedSettings;

  beforeEach(async () => {
    testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'warnings-test-'));
    homeDir = path.join(testRootDir, 'home');
    await fs.mkdir(homeDir, { recursive: true });
    vi.mocked(os.homedir).mockReturnValue(homeDir);

    // Empty settings without custom proxy server
    emptySettings = {
      user: { path: '', settings: {} },
      workspace: { path: '', settings: {} },
      system: { path: '', settings: {} },
    };
  });

  afterEach(async () => {
    await fs.rm(testRootDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('home directory check', () => {
    it('should return a warning when running in home directory', async () => {
      const warnings = await getUserStartupWarnings(homeDir, emptySettings);
      expect(warnings).toContainEqual(
        expect.stringContaining('home directory'),
      );
    });

    it('should not return a warning when running in a project directory', async () => {
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);
      const warnings = await getUserStartupWarnings(projectDir, emptySettings);
      expect(warnings).not.toContainEqual(
        expect.stringContaining('home directory'),
      );
    });
  });

  describe('root directory check', () => {
    it('should return a warning when running in a root directory', async () => {
      const rootDir = path.parse(testRootDir).root;
      const warnings = await getUserStartupWarnings(rootDir, emptySettings);
      expect(warnings).toContainEqual(
        expect.stringContaining('root directory'),
      );
      expect(warnings).toContainEqual(
        expect.stringContaining('folder structure will be used'),
      );
    });

    it('should not return a warning when running in a non-root directory', async () => {
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);
      const warnings = await getUserStartupWarnings(projectDir, emptySettings);
      expect(warnings).not.toContainEqual(
        expect.stringContaining('root directory'),
      );
    });
  });

  describe.skip('custom proxy server check', () => {
    it('should return a warning when custom proxy server URL is configured in user settings', async () => {
      const settings: LoadedSettings = {
        user: { path: '', settings: { customProxyServerUrl: 'https://custom.proxy.com' } },
        workspace: { path: '', settings: {} },
        system: { path: '', settings: {} },
      };
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);
      const warnings = await getUserStartupWarnings(projectDir, settings);
      expect(warnings).toContainEqual(
        expect.stringContaining('Custom proxy server'),
      );
      expect(warnings).toContainEqual(
        expect.stringContaining('https://custom.proxy.com'),
      );
    });

    it('should not return a warning when custom proxy server URL is not configured', async () => {
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);
      const warnings = await getUserStartupWarnings(projectDir, emptySettings);
      expect(warnings).not.toContainEqual(
        expect.stringContaining('Custom proxy server'),
      );
    });
  });

  describe('error handling', () => {
    it('should handle errors when checking directory', async () => {
      const nonExistentPath = path.join(testRootDir, 'non-existent');
      const warnings = await getUserStartupWarnings(nonExistentPath, emptySettings);
      const expectedWarning =
        'Could not verify the current directory due to a file system error.';
      expect(warnings).toEqual([expectedWarning, expectedWarning]);
    });
  });

  describe('low credits check', () => {
    // 业务变更说明：lowCreditsCheck 已从 getUserStartupWarnings 移走，迁移到
    // App 组件内异步、非阻塞地拉取并显示积分（避免启动时 1-2s 网络延迟）。
    // 见 packages/cli/src/utils/userStartupWarnings.ts 注释（"lowCreditsCheck removed -
    // moved to App for non-blocking startup"）以及 packages/cli/src/ui/App.tsx 中的
    // fetchCredits useEffect。因此这里的所有用例都断言：getUserStartupWarnings
    // 不再返回任何 credits 相关警告（无论 mock 的 usagePercentage 是多少）。
    beforeEach(() => {
      mockGetCreditsInfo.mockReset();
      mockIsCreditsLow.mockReset();
    });

    it('should NOT show warning when remaining credits is exactly 5% (moved to App)', async () => {
      // usagePercentage = 95%, remaining = 5%
      mockGetCreditsInfo.mockResolvedValue({ usagePercentage: 95 });
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir, { recursive: true });
      const warnings = await getUserStartupWarnings(projectDir, emptySettings);
      expect(warnings).not.toContainEqual(expect.stringContaining('credits'));
      expect(warnings).not.toContainEqual(expect.stringContaining('积分'));
      expect(warnings).not.toContainEqual(expect.stringContaining('5%'));
    });

    it('should NOT show warning when remaining credits is exactly 1% (moved to App)', async () => {
      // usagePercentage = 99%, remaining = 1%
      mockGetCreditsInfo.mockResolvedValue({ usagePercentage: 99 });
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir, { recursive: true });
      const warnings = await getUserStartupWarnings(projectDir, emptySettings);
      expect(warnings).not.toContainEqual(expect.stringContaining('credits'));
      expect(warnings).not.toContainEqual(expect.stringContaining('积分'));
      expect(warnings).not.toContainEqual(expect.stringContaining('1%'));
    });

    it('should NOT show warning when remaining credits rounds to 5% (moved to App)', async () => {
      // usagePercentage = 94.01%, remaining = 5.99% -> floor to 5%
      mockGetCreditsInfo.mockResolvedValue({ usagePercentage: 94.01 });
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir, { recursive: true });
      const warnings = await getUserStartupWarnings(projectDir, emptySettings);
      expect(warnings).not.toContainEqual(expect.stringContaining('credits'));
      expect(warnings).not.toContainEqual(expect.stringContaining('积分'));
      expect(warnings).not.toContainEqual(expect.stringContaining('5%'));
    });

    it('should NOT show warning when remaining credits is 6%', async () => {
      // usagePercentage = 94%, remaining = 6%
      mockGetCreditsInfo.mockResolvedValue({ usagePercentage: 94 });
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir, { recursive: true });
      const warnings = await getUserStartupWarnings(projectDir, emptySettings);
      expect(warnings).not.toContainEqual(expect.stringContaining('credits'));
      expect(warnings).not.toContainEqual(expect.stringContaining('积分'));
    });

    it('should NOT show warning when remaining credits is 3%', async () => {
      // usagePercentage = 97%, remaining = 3%
      mockGetCreditsInfo.mockResolvedValue({ usagePercentage: 97 });
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir, { recursive: true });
      const warnings = await getUserStartupWarnings(projectDir, emptySettings);
      expect(warnings).not.toContainEqual(expect.stringContaining('credits'));
      expect(warnings).not.toContainEqual(expect.stringContaining('积分'));
    });

    it('should NOT show warning when remaining credits is 0%', async () => {
      // usagePercentage = 100%, remaining = 0%
      mockGetCreditsInfo.mockResolvedValue({ usagePercentage: 100 });
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir, { recursive: true });
      const warnings = await getUserStartupWarnings(projectDir, emptySettings);
      expect(warnings).not.toContainEqual(expect.stringContaining('credits'));
      expect(warnings).not.toContainEqual(expect.stringContaining('积分'));
    });

    it('should NOT show warning when credits info is null', async () => {
      mockGetCreditsInfo.mockResolvedValue(null);
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir, { recursive: true });
      const warnings = await getUserStartupWarnings(projectDir, emptySettings);
      expect(warnings).not.toContainEqual(expect.stringContaining('credits'));
      expect(warnings).not.toContainEqual(expect.stringContaining('积分'));
    });

    // ─────────── 回归测试：迁移后契约 ───────────
    it('should NOT call getCreditsInfo at all from getUserStartupWarnings (moved to App)', async () => {
      // 关键回归契约：lowCreditsCheck 已彻底从 getUserStartupWarnings 移走，
      // 因此 getUserStartupWarnings 的执行路径不应再调用 creditsService。
      // 这道断言可以防止"代码回滚把 creditsService 调用放回 startup warning"导致 1-2s 启动延迟。
      mockGetCreditsInfo.mockResolvedValue({ usagePercentage: 99 });
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir, { recursive: true });
      await getUserStartupWarnings(projectDir, emptySettings);
      expect(mockGetCreditsInfo).not.toHaveBeenCalled();
      expect(mockIsCreditsLow).not.toHaveBeenCalled();
    });
  });
});
