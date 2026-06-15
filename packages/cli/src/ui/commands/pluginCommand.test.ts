import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pluginCommand } from './pluginCommand.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';

// Mock dependencies
vi.mock('otto-core', () => ({
  SettingsManager: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
  })),
  MarketplaceManager: vi.fn().mockImplementation(() => ({
    listMarketplaces: vi.fn().mockResolvedValue([]),
    addGitMarketplace: vi.fn().mockResolvedValue({ name: 'Test MP', id: 'test-mp', plugins: [] }),
    getPlugins: vi.fn().mockResolvedValue([]),
  })),
  PluginInstaller: vi.fn().mockImplementation(() => ({
    getInstalledPlugins: vi.fn().mockResolvedValue([]),
    installPlugin: vi.fn().mockResolvedValue({ name: 'Test Plugin', id: 'test-mp:test-plugin', skillPaths: [] }),
  })),
  SkillLoader: vi.fn(),
  SkillLoadLevel: { METADATA: 0, FULL: 1, RESOURCES: 2 },
  SkillsPaths: { SKILLS_ROOT: '/mock/skills' },
  clearSkillsContextCache: vi.fn(),
  PROJECT_DIR_PREFIX: '.otto',
}));

// Mock i18n
vi.mock('../utils/i18n.js', () => ({
  t: (key: string) => key,
  tp: (key: string, args: any) => `${key}:${JSON.stringify(args)}`,
}));

describe('pluginCommand', () => {
  let mockContext: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = {
      ui: {
        addItem: vi.fn(),
      },
    };
  });

  it('should have the correct name and kind', () => {
    expect(pluginCommand.name).toBe('plugin');
    expect(pluginCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should contain expected subcommands from skill system', () => {
    const subCommandNames = pluginCommand.subCommands?.map(c => c.name);
    expect(subCommandNames).toContain('marketplace');
    expect(subCommandNames).toContain('install');
    expect(subCommandNames).toContain('list');
  });

  describe('Subcommand: marketplace add', () => {
    it('should handle github shorthand owner/repo', async () => {
      const marketplaceCmd = pluginCommand.subCommands?.find(c => c.name === 'marketplace');
      const addCmd = marketplaceCmd?.subCommands?.find(c => c.name === 'add');

      await addCmd?.action(mockContext, 'nextlevelbuilder/ui-ux-pro-max-skill');

      // Verify progress message shows normalized URL
      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git'),
        }),
        expect.any(Number)
      );
    });
  });

  describe('Subcommand: install', () => {
    it('should handle plugin@marketplace syntax', async () => {
      const installCmd = pluginCommand.subCommands?.find(c => c.name === 'install');

      // 业务实现：handlePluginInstallAction 不是 async，
      // 它在内部 (async () => {...})() 启动后台 Promise，立即返回。
      // 因此 `await action(...)` 不会等待后台完成，需要主动 flush microtasks。
      installCmd?.action(mockContext, 'ui-ux-pro-max@ui-ux-pro-max-skill');

      // 等待后台 Promise 链调用 addItem 输出进度（mock installPlugin 立即 resolve，
      // 但中间有 await initSkillsSystem 等若干 microtask，需要多次 flush）。
      await vi.waitFor(() => {
        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.INFO,
            text: expect.stringContaining('ui-ux-pro-max'),
          }),
          expect.any(Number)
        );
      });
    });

    // ─────────── 回归测试：install 参数解析路径 ───────────
    it('should handle marketplace:plugin colon syntax', async () => {
      // 业务路径：colonIndex !== -1 优先 → marketplaceId/pluginName 拆分
      const installCmd = pluginCommand.subCommands?.find(c => c.name === 'install');
      installCmd?.action(mockContext, 'my-marketplace:my-plugin');

      await vi.waitFor(() => {
        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.INFO,
            text: expect.stringContaining('my-plugin'),
          }),
          expect.any(Number)
        );
      });
    });

    it('should open dialog when install called with no args (interactive selection)', () => {
      // 业务行为：input 为空时返回 dialog 描述符让 UI 弹出 plugin-install 对话框，
      // 不会调用 addItem。
      const installCmd = pluginCommand.subCommands?.find(c => c.name === 'install');
      const result = installCmd?.action(mockContext, '');
      expect(result).toEqual({ type: 'dialog', dialog: 'plugin-install' });
      expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    });
  });
});
