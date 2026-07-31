/**
 * Otto Skills System - Plugin Installer
 *
 * Manages Plugin lifecycle:
 * - Install/Uninstall plugins from marketplaces
 * - Enable/Disable plugins
 * - Plugin structure validation
 * - Update installed_plugins.json
 * - Dependency checking (YAML frontmatter)
 */

import fs from 'fs-extra';
import path from 'path';
import {
  Plugin,
  InstalledPluginInfo,
  PluginError,
  SkillErrorCode,
  ValidationError,
  SkillType,
  PluginSource,
} from './skill-types.js';
import { SettingsManager, SkillsPaths } from './settings-manager.js';
import { MarketplaceManager } from './marketplace-manager.js';

/**
 * PluginInstaller - Plugin 生命周期管理器
 *
 * 职责:
 * 1. 安装 Plugin（从 Marketplace 复制到个人目录）
 * 2. 卸载 Plugin（删除个人目录副本）
 * 3. 启用/禁用 Plugin
 * 4. Plugin 结构验证
 * 5. 更新 installed_plugins.json
 */
export class PluginInstaller {
  constructor(
    private settingsManager: SettingsManager,
    private marketplaceManager: MarketplaceManager,
  ) {}

  // ============================================================================
  // 安装 Plugin
  // ============================================================================

  /**
   * 安装 Plugin 到个人目录
   */
  async installPlugin(marketplaceId: string, pluginName: string): Promise<Plugin> {
    try {
      // 获取 Plugin 信息
      const plugins = await this.marketplaceManager.getPlugins(marketplaceId);
      const plugin = plugins.find((p) => p.name === pluginName);

      if (!plugin) {
        const availablePlugins = plugins.map((p) => `${p.name} (id: ${p.id})`).join(', ');
        throw new PluginError(
          `Plugin "${pluginName}" not found in marketplace "${marketplaceId}"\n` +
          `Available plugins: ${availablePlugins || 'none'}`,
          SkillErrorCode.PLUGIN_NOT_FOUND,
        );
      }

      // 检查是否已安装
      const existingPlugin = await this.settingsManager.getInstalledPlugin(plugin.id);
      if (existingPlugin) {
        throw new PluginError(
          `Plugin ${plugin.id} is already installed`,
          SkillErrorCode.PLUGIN_ALREADY_INSTALLED,
        );
      }

      // 🔑 关键修复：对于远程插件，先下载到 cache
      // 这样验证时才能找到 skillPaths
      if (this.isRemoteGitSource(plugin.source)) {
        await this.ensureRemotePluginDownloaded(plugin, marketplaceId);

        // 重新获取插件信息（现在应该有 skillPaths 了）
        const updatedPlugins = await this.marketplaceManager.getPlugins(marketplaceId);
        const updatedPlugin = updatedPlugins.find((p) => p.name === pluginName);
        if (updatedPlugin) {
          Object.assign(plugin, updatedPlugin); // 更新插件信息
        }
      }

      // 验证 Plugin 结构
      await this.validatePlugin(plugin, marketplaceId);

      // 复制 Plugin 到个人目录（如果是 Git Marketplace）
      const marketplace = await this.marketplaceManager.getMarketplace(marketplaceId);
      if (marketplace.source === 'git') {
        await this.copyPluginToPersonalDir(plugin, marketplaceId);
      }

      // 确定插件的本地安装路径
      let installPath: string;

      // 判断是否为远程 Git source（使用缓存路径）
      if (this.isRemoteGitSource(plugin.source)) {
        // 远程插件：使用 cache 路径
        const version = plugin.version || 'unknown';
        installPath = SkillsPaths.getPluginCachePath(marketplaceId, plugin.name, version);
      } else if (typeof plugin.source === 'string') {
        // 字符串：使用 source 作为相对路径
        const pluginLocalPath = plugin.source;
        installPath = path.join(
          SkillsPaths.MARKETPLACE_ROOT,
          marketplaceId,
          pluginLocalPath
        );
      } else {
        // 兜底：使用插件名
        installPath = path.join(
          SkillsPaths.MARKETPLACE_ROOT,
          marketplaceId,
          plugin.name
        );
      }

      // 判断是否为本地插件（基于 plugin.source 而非 marketplace.source）
      // 本地插件：source 为相对路径（如 './' 或 '../'）
      // 远程插件：source 为 object（github/git/url）
      const isLocal = this.isLocalPluginSource(plugin.source);

      // 记录已安装 Plugin
      const installedInfo: InstalledPluginInfo = {
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        marketplaceId,
        installPath,
        installedAt: new Date().toISOString(),
        enabled: true, // 默认启用
        skillCount: plugin.skillPaths.length,
        version: plugin.version || 'unknown', // 默认 'unknown'
        isLocal, // 本地插件标记
      };
      await this.settingsManager.addInstalledPlugin(installedInfo);

      // 启用 Plugin
      await this.settingsManager.enablePlugin(plugin.id);

      // 更新 Plugin 状态
      plugin.installed = true;
      plugin.enabled = true;
      plugin.installedAt = new Date(installedInfo.installedAt);

      return plugin;
    } catch (error) {
      if (error instanceof PluginError) {
        throw error;
      }
      throw new PluginError(
        `Failed to install plugin: ${error instanceof Error ? error.message : String(error)}`,
        SkillErrorCode.PLUGIN_INSTALL_FAILED,
        { marketplaceId, pluginName, originalError: error },
      );
    }
  }

  /**
   * 批量安装 Plugins
   */
  async installPlugins(
    marketplaceId: string,
    pluginNames: string[],
  ): Promise<Plugin[]> {
    const results: Plugin[] = [];
    const errors: Array<{ pluginName: string; error: Error }> = [];

    for (const pluginName of pluginNames) {
      try {
        const plugin = await this.installPlugin(marketplaceId, pluginName);
        results.push(plugin);
      } catch (error) {
        errors.push({
          pluginName,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    if (errors.length > 0) {
      console.warn('Some plugins failed to install:', errors);
    }

    return results;
  }

  // ============================================================================
  // 卸载 Plugin
  // ============================================================================

  /**
   * 卸载 Plugin
   */
  async uninstallPlugin(pluginId: string, deleteFiles = false): Promise<void> {
    try {
      // 检查是否已安装
      const installedPlugin = await this.settingsManager.getInstalledPlugin(pluginId);
      if (!installedPlugin) {
        throw new PluginError(
          `Plugin ${pluginId} is not installed`,
          SkillErrorCode.PLUGIN_NOT_FOUND,
        );
      }

      // 禁用 Plugin
      await this.settingsManager.disablePlugin(pluginId);

      // 删除已安装记录
      await this.settingsManager.removeInstalledPlugin(pluginId);

      // 删除个人目录副本（如果请求）
      if (deleteFiles) {
        await this.deletePluginFromPersonalDir(pluginId);
      }
    } catch (error) {
      if (error instanceof PluginError) {
        throw error;
      }
      throw new PluginError(
        `Failed to uninstall plugin: ${error instanceof Error ? error.message : String(error)}`,
        SkillErrorCode.UNKNOWN,
        { pluginId, originalError: error },
      );
    }
  }

  // ============================================================================
  // 启用/禁用 Plugin
  // ============================================================================

  /**
   * 启用 Plugin
   */
  async enablePlugin(pluginId: string): Promise<void> {
    try {
      // 检查是否已安装
      const installedPlugin = await this.settingsManager.getInstalledPlugin(pluginId);
      if (!installedPlugin) {
        throw new PluginError(
          `Plugin ${pluginId} is not installed`,
          SkillErrorCode.PLUGIN_NOT_FOUND,
        );
      }

      // 更新 settings.json
      await this.settingsManager.enablePlugin(pluginId);
      try {
        // 更新 installed_plugins.json
        await this.settingsManager.updateInstalledPlugin(pluginId, (info) => ({
          ...info,
          enabled: true,
        }));
      } catch (rollbackError) {
        // 第二次写入失败，回滚第一次写入
        await this.settingsManager.disablePlugin(pluginId);
        throw rollbackError;
      }
    } catch (error) {
      if (error instanceof PluginError) {
        throw error;
      }
      throw new PluginError(
        `Failed to enable plugin: ${error instanceof Error ? error.message : String(error)}`,
        SkillErrorCode.UNKNOWN,
        { pluginId, originalError: error },
      );
    }
  }

  /**
   * 禁用 Plugin
   */
  async disablePlugin(pluginId: string): Promise<void> {
    try {
      // 检查是否已安装
      const installedPlugin = await this.settingsManager.getInstalledPlugin(pluginId);
      if (!installedPlugin) {
        throw new PluginError(
          `Plugin ${pluginId} is not installed`,
          SkillErrorCode.PLUGIN_NOT_FOUND,
        );
      }

      // 更新 settings.json
      await this.settingsManager.disablePlugin(pluginId);
      try {
        // 更新 installed_plugins.json
        await this.settingsManager.updateInstalledPlugin(pluginId, (info) => ({
          ...info,
          enabled: false,
        }));
      } catch (rollbackError) {
        // 第二次写入失败，回滚第一次写入
        await this.settingsManager.enablePlugin(pluginId);
        throw rollbackError;
      }
    } catch (error) {
      if (error instanceof PluginError) {
        throw error;
      }
      throw new PluginError(
        `Failed to disable plugin: ${error instanceof Error ? error.message : String(error)}`,
        SkillErrorCode.UNKNOWN,
        { pluginId, originalError: error },
      );
    }
  }

  // ============================================================================
  // 查询 Plugin
  // ============================================================================

  /**
   * 获取已安装 Plugin 列表
   */
  async getInstalledPlugins(): Promise<InstalledPluginInfo[]> {
    return this.settingsManager.getInstalledPlugins();
  }

  /**
   * 获取已启用 Plugin 列表
   */
  async getEnabledPlugins(): Promise<InstalledPluginInfo[]> {
    const installed = await this.getInstalledPlugins();
    return installed.filter((p) => p.enabled);
  }

  /**
   * 获取 Plugin 信息
   */
  async getPluginInfo(pluginId: string): Promise<InstalledPluginInfo | null> {
    return this.settingsManager.getInstalledPlugin(pluginId);
  }

  /**
   * 检查 Plugin 是否已安装
   */
  async isPluginInstalled(pluginId: string): Promise<boolean> {
    const plugin = await this.getPluginInfo(pluginId);
    return plugin !== null;
  }

  /**
   * 检查 Plugin 是否已启用
   */
  async isPluginEnabled(pluginId: string): Promise<boolean> {
    return this.settingsManager.isPluginEnabled(pluginId);
  }

  // ============================================================================
  // 私有方法 - Plugin Source 判断
  // ============================================================================

  /**
   * 判断 plugin source 是否为远程 Git 类型（需要缓存）
   * @param source Plugin source
   * @returns true 如果是远程 Git source（需要缓存），false 如果是本地路径（不需要缓存）
   */
  private isRemoteGitSource(source: string | PluginSource): boolean {
    if (typeof source === 'string') {
      // 字符串类型：相对路径不缓存
      return false;
    }

    if (typeof source === 'object' && source !== null) {
      // GitHub、Git、URL 都需要缓存
      return source.source === 'github' || source.source === 'git' || source.source === 'url';
    }

    return false;
  }

  /**
   * 判断 plugin source 是否为本地路径
   * @param source Plugin source
   * @returns true 如果是本地相对路径（如 './' 或 '../'），false 如果是远程 Git source
   */
  private isLocalPluginSource(source: string | PluginSource): boolean {
    if (typeof source === 'string') {
      // 字符串类型：相对路径（./ 或 ../）为本地插件
      return source.startsWith('./') || source.startsWith('../');
    }

    // object 类型（github/git/url）都是远程插件
    return false;
  }

  // ============================================================================
  // 私有方法 - Plugin 验证
  // ============================================================================

  /**
   * 验证 Plugin 结构
   */
  private async validatePlugin(plugin: Plugin, marketplaceId: string): Promise<void> {
    // 验证必需字段
    if (!plugin.id || !plugin.name || !plugin.marketplaceId) {
      throw new ValidationError(
        `Invalid plugin: missing required fields\n` +
        `Plugin: ${JSON.stringify(plugin, null, 2)}`,
        {
          plugin,
          marketplaceId,
        },
      );
    }

    // 验证 Skill 路径
    if (!plugin.skillPaths || plugin.skillPaths.length === 0) {
      throw new ValidationError(
        `Invalid plugin: no skills found\n` +
        `Plugin ID: ${plugin.id}\n` +
        `Plugin Name: ${plugin.name}\n` +
        `Marketplace: ${marketplaceId}\n` +
        `Skill Paths: ${JSON.stringify(plugin.skillPaths)}\n` +
        `Items: ${JSON.stringify(plugin.items)}`,
        {
          plugin,
          marketplaceId,
        },
      );
    }

    // 获取 Marketplace 路径
    const marketplace = await this.marketplaceManager.getMarketplace(marketplaceId);
    const marketplacePath =
      marketplace.source === 'git'
        ? path.join(SkillsPaths.MARKETPLACE_ROOT, marketplaceId)
        : marketplace.path!;

    // 验证 Skill 路径是否存在
    // Use new items structure if available
    if (plugin.items && plugin.items.length > 0) {
      // 新增：递归检查命令/Agent 目录中是否包含可用文件
      const hasCommandOrAgentFiles = async (dirPath: string): Promise<boolean> => {
        const entries = await fs.readdir(dirPath);
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const entryPath = path.join(dirPath, entry);
          const entryStat = await fs.stat(entryPath);
          if (entryStat.isFile()) {
            if (
              entry.endsWith('.md') ||
              entry.endsWith('.py') ||
              entry.endsWith('.sh')
            ) {
              return true;
            }
          } else if (entryStat.isDirectory()) {
            if (await hasCommandOrAgentFiles(entryPath)) {
              return true;
            }
          }
        }
        return false;
      };

      // 新增：允许 skills/ 作为容器目录（子目录内含 SKILL.md）
      const hasNestedSkillDir = async (dirPath: string): Promise<boolean> => {
        const entries = await fs.readdir(dirPath);
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const entryPath = path.join(dirPath, entry);
          const entryStat = await fs.stat(entryPath);
          if (entryStat.isDirectory()) {
            const skillFile = path.join(entryPath, 'SKILL.md');
            if (await fs.pathExists(skillFile)) {
              return true;
            }
          }
        }
        return false;
      };

      for (const item of plugin.items) {
        const fullPath = path.join(marketplacePath, item.path);

        // Check existence based on type
        if (item.type === SkillType.SKILL) {
          // Skills must be directories with SKILL.md
          const skillFile = path.join(fullPath, 'SKILL.md');
          if (await fs.pathExists(skillFile)) {
            continue;
          }

          // 新增：允许 skill 目录不存在时给出更明确的错误
          const exists = await fs.pathExists(fullPath);
          if (!exists) {
            throw new ValidationError(
              `Skill path not found: ${fullPath}`,
              { skillPath: item.path },
            );
          }

          // 新增：防止 skill 指向文件
          const stat = await fs.stat(fullPath);
          if (!stat.isDirectory()) {
            throw new ValidationError(
              `Skill path is not a directory: ${fullPath}`,
              { skillPath: item.path },
            );
          }

          // 新增：允许 skill 组目录（例如 skills/）
          const hasNestedSkill = await hasNestedSkillDir(fullPath);
          if (!hasNestedSkill) {
            throw new ValidationError(
              `Skill file not found: ${skillFile}`,
              { skillPath: item.path },
            );
          }
        } else {
          // Commands and Agents can be files or directories
          // If it's a file path (ends in .md), check file existence
          // If it's a directory, check for SKILL.md (legacy support)
          const exists = await fs.pathExists(fullPath);
          if (!exists) {
            throw new ValidationError(
              `Path not found: ${fullPath}`,
              { path: item.path },
            );
          }

          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            const skillFile = path.join(fullPath, 'SKILL.md');
            if (await fs.pathExists(skillFile)) {
              continue;
            }

            // 新增：目录需包含可用文件（md/py/sh）
            const hasFiles = await hasCommandOrAgentFiles(fullPath);
            if (!hasFiles) {
              throw new ValidationError(
                `Command/Agent directory contains no supported files: ${fullPath}`,
                { path: item.path },
              );
            }
          }
        }
      }
    } else {
      // Legacy validation
      for (const skillPath of plugin.skillPaths) {
        const fullPath = path.join(marketplacePath, skillPath);
        const skillFile = path.join(fullPath, 'SKILL.md');

        if (!(await fs.pathExists(skillFile))) {
          throw new ValidationError(
            `Skill file not found: ${skillFile}`,
            { skillPath },
          );
        }
      }
    }
  }

  // ============================================================================
  // 私有方法 - 文件操作
  // ============================================================================

  /**
   * 复制 Plugin 到个人目录
   * 注意: Skills 支持多层级存储：
   * - 项目级: <项目根目录>/.otto/skills/
   * - 用户级: ~/.otto/skills/
   * - Marketplace: ~/.otto/marketplace/
   * 当前方法将 Plugin 复制到用户级目录
   */
  private async copyPluginToPersonalDir(
    plugin: Plugin,
    _marketplaceId: string,
  ): Promise<void> {
    try {
      // 个人 Skills 目录
      const personalSkillsDir = SkillsPaths.SKILLS_ROOT;
      await fs.ensureDir(personalSkillsDir);

      // 注意：由于 Skills 设计为统一在 Marketplace 管理，
      // 这里实际上不需要复制文件，仅记录引用即可
      // 但保留此方法为未来可能的需求（如离线使用）

      // 复制 Skill 目录（可选，当前注释掉）
      // for (const skillPath of plugin.skillPaths) {
      //   const srcPath = path.join(marketplacePath, skillPath);
      //   const destPath = path.join(targetPluginDir, path.basename(skillPath));
      //   await fs.copy(srcPath, destPath);
      // }
    } catch (error) {
      throw new PluginError(
        `Failed to copy plugin to personal directory: ${error instanceof Error ? error.message : String(error)}`,
        SkillErrorCode.FILE_WRITE_FAILED,
        { pluginId: plugin.id, originalError: error },
      );
    }
  }

  /**
   * 从个人目录删除 Plugin
   */
  private async deletePluginFromPersonalDir(pluginId: string): Promise<void> {
    try {
      const [marketplaceId, pluginName] = pluginId.split(':');
      const personalSkillsDir = SkillsPaths.SKILLS_ROOT;
      const targetPluginDir = path.join(
        personalSkillsDir,
        `${marketplaceId}_${pluginName}`,
      );

      if (await fs.pathExists(targetPluginDir)) {
        await fs.remove(targetPluginDir);
      }
    } catch (error) {
      console.warn(`Failed to delete plugin from personal directory: ${error}`);
      // 不抛出错误，仅记录警告
    }
  }

  // ============================================================================
  // 私有方法 - 远程插件下载
  // ============================================================================

  /**
   * 确保远程插件已下载到 cache
   * 如果未下载，则克隆到 cache 目录
   */
  private async ensureRemotePluginDownloaded(
    plugin: Plugin,
    marketplaceId: string
  ): Promise<void> {
    try {
      const version = plugin.version || 'unknown';
      const cachePath = SkillsPaths.getPluginCachePath(marketplaceId, plugin.name, version);

      // 检查缓存是否已存在
      if (await fs.pathExists(cachePath)) {
        console.log(`[PluginInstaller] Plugin already cached: ${cachePath}`);
        return;
      }

      // 提取 Git URL
      const source = plugin.source as unknown as { source?: string; repo?: string; url?: string; ref?: string };
      let gitUrl: string | null = null;
      let ref: string | undefined = undefined;

      if (source.source === 'github') {
        gitUrl = `https://github.com/${source.repo}.git`;
        ref = source.ref;
      } else if (source.source === 'git') {
        gitUrl = source.url ?? null;
        ref = source.ref;
      } else if (source.source === 'url') {
        gitUrl = source.url ?? null;
      }

      if (!gitUrl) {
        throw new Error(`Cannot extract Git URL from source: ${JSON.stringify(source)}`);
      }

      // 克隆到 cache
      console.log(`[PluginInstaller] Downloading plugin ${plugin.name} from ${gitUrl}...`);
      await this.clonePluginToCache(gitUrl, cachePath, ref);
      console.log(`[PluginInstaller] Plugin downloaded successfully: ${cachePath}`);
    } catch (error) {
      throw new PluginError(
        `Failed to download remote plugin: ${error instanceof Error ? error.message : String(error)}`,
        SkillErrorCode.PLUGIN_INSTALL_FAILED,
        { pluginId: plugin.id, originalError: error },
      );
    }
  }

  /**
   * 克隆插件到 cache 目录
   */
  private async clonePluginToCache(
    gitUrl: string,
    cachePath: string,
    ref?: string
  ): Promise<void> {
    const { spawnSync } = await import('child_process');

    try {
      await fs.ensureDir(path.dirname(cachePath));

      // 构建 git clone 参数
      const args: string[] = ['clone', '--depth', '1'];

      if (ref) {
        args.push('--branch', ref);
      }

      args.push(gitUrl, cachePath);

      // 执行克隆
      const result = spawnSync('git', args, {
        stdio: 'pipe',
        encoding: 'utf-8',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0', // 禁用交互式提示
        },
      });

      if (result.status !== 0) {
        const errorMsg = result.stderr || result.error?.message || 'Unknown error';
        throw new Error(`Git clone failed: ${errorMsg}`);
      }
    } catch (error) {
      // 清理失败的缓存
      if (await fs.pathExists(cachePath)) {
        await fs.remove(cachePath);
      }
      throw error;
    }
  }
}

/**
 * 单例实例（需要在使用时注入依赖）
 */
export const pluginInstaller = new PluginInstaller(
  {} as SettingsManager,
  {} as MarketplaceManager,
);
