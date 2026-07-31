/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'path';
import fs from 'fs-extra';
import { spawnSync } from 'child_process';
import {
  UnifiedComponent,
  UnifiedPlugin,
  ComponentSource,
  ComponentType,
} from '../models/unified.js';
import { IPluginLoader } from './types.js';
import { SettingsManager, SkillsPaths } from '../settings-manager.js';
import { PluginStructureAnalyzer, ComponentParser } from '../parsers/index.js';
import { isDirentDirectoryFollowingSymlinks } from '../utils/fs-helpers.js';
import { PluginSource } from '../skill-types.js';

type ComponentPath = string | { path?: string };
interface MarketplacePluginDefinition {
  name: string;
  source?: string | PluginSource;
  version?: string;
  description?: string;
  author?: string;
  metadata?: { pluginRoot?: string };
  skills?: ComponentPath | ComponentPath[];
  commands?: ComponentPath | ComponentPath[];
  agents?: ComponentPath | ComponentPath[];
  hooks?: unknown;
}
interface PluginMetadata {
  name?: string;
  description?: string;
  author?: string;
  version?: string;
  pluginRoot?: string;
  skills?: string | string[];
  commands?: string | string[];
  agents?: string | string[];
}

/**
 * Marketplace 加载器
 * 负责从 ~/.otto/marketplace 加载插件和组件
 */
export class MarketplaceLoader implements IPluginLoader {
  private componentParser: ComponentParser;

  constructor(private settingsManager: SettingsManager) {
    this.componentParser = new ComponentParser();
  }

  async loadPlugins(): Promise<UnifiedPlugin[]> {
    const plugins: UnifiedPlugin[] = [];

    // 1. 获取已安装的插件列表（仅加载已安装的插件）
    const installedPlugins = await this.settingsManager.readInstalledPlugins();
    const installedPluginIds = new Set(Object.keys(installedPlugins.plugins));

    // 2. 获取已安装的 Marketplace
    const marketplaces = await this.settingsManager.getMarketplaces();

    for (const mp of marketplaces) {
      if (!mp.enabled) continue;

      const mpPath = mp.source === 'local' ? mp.location : path.join(SkillsPaths.MARKETPLACE_ROOT, mp.id);
      if (!(await fs.pathExists(mpPath))) continue;

      // 3. 尝试从 marketplace.json 加载插件定义
      const manifestPath = path.join(mpPath, '.claude-plugin', 'marketplace.json');
      const loadedPluginIds = new Set<string>();

      // 🔧 新增：检查是否为 Claude Code marketplace
      const isClaudeCodeMarketplace = mp.id === 'claude-code' || mp.id?.includes('claude-code');

      if (await fs.pathExists(manifestPath)) {
        try {
          const manifest = await fs.readJson(manifestPath);
          if (manifest.plugins && Array.isArray(manifest.plugins)) {
            for (const pluginDef of manifest.plugins) {
              try {
                const pluginId = `${mp.id}:${pluginDef.name}`;

                // 🔧 优化：Claude Code marketplace 自动加载所有插件（不检查 installed_plugins.json）
                // 其他 marketplace 仍然遵循原有逻辑
                if (!isClaudeCodeMarketplace && !installedPluginIds.has(pluginId)) {
                  continue;
                }

                const plugin = await this.loadPluginFromManifest(mp.id, mpPath, pluginDef);
                if (plugin) {
                  plugins.push(plugin);
                  loadedPluginIds.add(plugin.id);
                }
              } catch (error) {
                console.warn(`Failed to load plugin ${pluginDef.name} from manifest:`, error);
              }
            }
          }
        } catch (error) {
          console.warn(`Failed to read marketplace.json for ${mp.id}:`, error);
        }
      }

      // 4. 扫描目录以发现未在 manifest 中定义的插件
      const pluginDirs = await this.discoverPluginDirs(mpPath);

      for (const pluginDir of pluginDirs) {
        const pluginName = path.basename(pluginDir);
        const pluginId = `${mp.id}:${pluginName}`;

        // 跳过已从 manifest 加载的插件
        if (loadedPluginIds.has(pluginId)) continue;

        // 🔧 优化：Claude Code marketplace 自动加载所有插件（不检查 installed_plugins.json）
        // 其他 marketplace 仍然遵循原有逻辑
        if (!isClaudeCodeMarketplace && !installedPluginIds.has(pluginId)) {
          continue;
        }

        try {
          const plugin = await this.loadPluginFromDir(mp.id, pluginDir);
          if (plugin) {
            plugins.push(plugin);
          }
        } catch (error) {
          console.warn(`Failed to load plugin from ${pluginDir}:`, error);
        }
      }
    }

    return plugins;
  }

  async loadPlugin(_pluginId: string): Promise<UnifiedPlugin | null> {
    // TODO: Implement single plugin loading
    return null;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * 从 marketplace.json 的 plugin entry 加载插件
   * 支持官方文档中的所有 source 类型和内联配置
   */
  private async loadPluginFromManifest(
    marketplaceId: string,
    mpPath: string,
    pluginDef: MarketplacePluginDefinition
  ): Promise<UnifiedPlugin | null> {
    const id = `${marketplaceId}:${pluginDef.name}`;
    const source = pluginDef.source;
    let pluginDir = mpPath;

    // 0. 优先使用 installPath（如果已安装）
    const installedInfo = await this.settingsManager.getInstalledPlugin(id);
    if (installedInfo?.installPath && await fs.pathExists(installedInfo.installPath)) {
      // Startup log suppressed for clean CLI output
      // console.log(`[MarketplaceLoader] Using installPath from installed plugin: ${installedInfo.installPath}`);
      pluginDir = installedInfo.installPath;
    } else if (source && this.isRemoteGitSource(source)) {
      // 1. 远程 Git source（需要缓存）
      const version = pluginDef.version || 'unknown';
      const cachePath = SkillsPaths.getPluginCachePath(marketplaceId, pluginDef.name, version);

      // 检查缓存是否存在
      if (await fs.pathExists(cachePath)) {
        // Startup log suppressed for clean CLI output
        // console.log(`[MarketplaceLoader] Using cached plugin: ${cachePath}`);
        pluginDir = cachePath;
      } else {
        // 克隆到缓存目录
        const gitUrl = this.extractGitUrl(source as PluginSource);
        if (gitUrl) {
          await this.clonePluginToCache(gitUrl, cachePath, source as PluginSource);
          pluginDir = cachePath;
        } else {
          console.warn(`Cannot extract Git URL from source: ${JSON.stringify(source)}`);
          return null;
        }
      }
    } else if (typeof source === 'string') {
      // 2. 字符串类型：相对路径
      pluginDir = path.join(mpPath, source);
    } else {
      // 3. 未知类型，回退到插件名
      pluginDir = path.join(mpPath, pluginDef.name);
    }

    if (!(await fs.pathExists(pluginDir))) {
      console.warn(`Plugin directory not found: ${pluginDir}`);
      return null;
    }

    const components: UnifiedComponent[] = [];

    // 2. 处理显式定义的组件
    // 按照官方文档，可以在 manifest 中定义 commands, agents, hooks 等
    // 支持字符串数组或对象数组（对象包含 path 属性）

    // 🔧 新增：支持 marketplace.json 中的 metadata.pluginRoot
    const pluginRootPrefix = pluginDef.metadata?.pluginRoot || '';

    // Helper to get full path respecting pluginRoot
    const getFullPath = (p: string) => {
      const targetPath = pluginRootPrefix ? path.join(pluginRootPrefix, p) : p;
      return path.isAbsolute(targetPath) ? targetPath : path.join(pluginDir, targetPath);
    };

    // 🔧 新增：处理 marketplace.json 中的显式定义（ui-ux-pro-max 情景）
    if (pluginDef.skills && (Array.isArray(pluginDef.skills) || typeof pluginDef.skills === 'string')) {
      const skillItems = Array.isArray(pluginDef.skills) ? pluginDef.skills : [pluginDef.skills];
      for (const skillItem of skillItems) {
        const skillPath = typeof skillItem === 'string' ? skillItem : skillItem?.path;
        if (skillPath) {
          const fullPath = getFullPath(skillPath);
          const component = await this.componentParser.parse(fullPath, ComponentType.SKILL, id, marketplaceId, pluginDir);
          if (component) components.push(component);
        }
      }
    }

    if (pluginDef.commands && (Array.isArray(pluginDef.commands) || typeof pluginDef.commands === 'string')) {
      const cmdItems = Array.isArray(pluginDef.commands) ? pluginDef.commands : [pluginDef.commands];
      for (const cmdItem of cmdItems) {
        const cmdPath = typeof cmdItem === 'string' ? cmdItem : cmdItem?.path;
        if (cmdPath) {
          const fullPath = getFullPath(cmdPath);
          const component = await this.componentParser.parse(fullPath, ComponentType.COMMAND, id, marketplaceId, pluginDir);
          if (component) components.push(component);
        }
      }
    }

    if (pluginDef.agents && (Array.isArray(pluginDef.agents) || typeof pluginDef.agents === 'string')) {
      const agentItems = Array.isArray(pluginDef.agents) ? pluginDef.agents : [pluginDef.agents];
      for (const agentItem of agentItems) {
        const agentPath = typeof agentItem === 'string' ? agentItem : agentItem?.path;
        if (agentPath) {
          const fullPath = getFullPath(agentPath);
          const component = await this.componentParser.parse(fullPath, ComponentType.AGENT, id, marketplaceId, pluginDir);
          if (component) components.push(component);
        }
      }
    }

    // 🔧 尝试加载 plugin.json 进行补充 (如果有的话)
    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    const claudePluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
    let metadata: PluginMetadata = {};
    if (await fs.pathExists(pluginJsonPath)) {
      metadata = await fs.readJson(pluginJsonPath);
    } else if (await fs.pathExists(claudePluginJsonPath)) {
      metadata = await fs.readJson(claudePluginJsonPath);
    }

    if (metadata.skills && !pluginDef.skills) {
      const skillPaths = Array.isArray(metadata.skills) ? metadata.skills : [metadata.skills];
      for (const sp of skillPaths) {
        const fullPath = getFullPath(sp);
        const component = await this.componentParser.parse(fullPath, ComponentType.SKILL, id, marketplaceId, pluginDir);
        if (component) components.push(component);
      }
    }

    // 3. 自动发现组件
    // 始终执行自动发现，确保不遗漏任何组件
    // 显式定义的组件优先（去重时保留显式定义的版本）
    // 注：第三方插件的 strict 字段原意是限制 Claude Code 的行为，
    //     不应阻止我们发现和加载组件
    {
      // 自动发现标准目录
      // 按照标准目录和常见第三方工具目录进行自动发现
      const discoveryTasks = [
        { name: 'agents', type: ComponentType.AGENT },
        { name: 'commands', type: ComponentType.COMMAND },
        { name: 'skills', type: ComponentType.SKILL },
        { name: '.claude/agents', type: ComponentType.AGENT },
        { name: '.claude/commands', type: ComponentType.COMMAND },
        { name: '.claude/skills', type: ComponentType.SKILL },
        { name: '.cursor/commands', type: ComponentType.COMMAND },
        { name: '.roo/commands', type: ComponentType.COMMAND },
      ];

      const discoveredComponents: UnifiedComponent[] = [];
      for (const task of discoveryTasks) {
        discoveredComponents.push(...await this.scanComponents(
          pluginDir, task.name, task.type, id, marketplaceId
        ));
      }

      // 合并显式定义的组件和自动发现的组件（去重）
      // 显式定义的组件优先（保持在前面），然后添加新发现的组件
      const existingIds = new Set(components.map(c => c.id));
      let addedCount = 0;
      for (const discovered of discoveredComponents) {
        if (!existingIds.has(discovered.id)) {
          components.push(discovered);
          existingIds.add(discovered.id);
          addedCount++;
        }
      }

      // Debug logging for skill discovery
      if (process.env.DEBUG_SKILLS) {
        console.log(`[MarketplaceLoader] Plugin ${id}:`);
        console.log(`  - Explicit components: ${components.length - addedCount}`);
        console.log(`  - Auto-discovered: ${addedCount}`);
        console.log(`  - Total: ${components.length}`);
      }
    }

    // 4. 构建 UnifiedPlugin
    // 从 installed_plugins.json 读取实际启用状态
    const pluginEnabled = installedInfo?.enabled ?? true;

    return {
      id,
      name: pluginDef.name,
      description: pluginDef.description || '',
      version: pluginDef.version || 'unknown',
      author: pluginDef.author,
      source: ComponentSource.MARKETPLACE,
      location: {
        type: 'directory',
        path: pluginDir
      },
      components,
      structure: {
        hasMarketplaceJson: true,
        hasPluginJson: false,
        hasClaudePluginDir: false,
        directories: {
          agents: pluginDef.agents ? true : false,
          commands: pluginDef.commands ? true : false,
          skills: pluginDef.skills ? true : false,
          hooks: pluginDef.hooks ? true : false,
          scripts: false
        },
        detectedFormat: 'otto-code'
      },
      installed: true,
      enabled: pluginEnabled,
      marketplace: {
        id: marketplaceId,
        name: marketplaceId
      },
      rawConfig: pluginDef
    };
  }

  private async discoverPluginDirs(mpPath: string): Promise<string[]> {
    const dirs: string[] = [];

    // 注意：必须跟随 symlink —— marketplace 根下 plugin 可能是软链接到开发中
    // 的仓库（monorepo workspace 常见），`Dirent.isDirectory()` 对 symlink 返回
    // false，所以要显式 follow。

    // 1. 检查根目录下的插件 (Otto 风格)
    const rootEntries = await fs.readdir(mpPath, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.name.startsWith('.')) continue;
      const isDir = await isDirentDirectoryFollowingSymlinks(entry, mpPath);
      if (!isDir) continue;
      // 排除 plugins 目录，因为它会被单独处理
      if (entry.name !== 'plugins') {
        dirs.push(path.join(mpPath, entry.name));
      }
    }

    // 2. 检查 plugins/ 子目录 (Claude Code 风格)
    const pluginsPath = path.join(mpPath, 'plugins');
    if (await fs.pathExists(pluginsPath)) {
      const pluginEntries = await fs.readdir(pluginsPath, { withFileTypes: true });
      for (const entry of pluginEntries) {
        if (entry.name.startsWith('.')) continue;
        const isDir = await isDirentDirectoryFollowingSymlinks(entry, pluginsPath);
        if (!isDir) continue;
        dirs.push(path.join(pluginsPath, entry.name));
      }
    }

    return dirs;
  }

  private async loadPluginFromDir(marketplaceId: string, pluginDir: string): Promise<UnifiedPlugin | null> {
    const pluginName = path.basename(pluginDir);
    const id = `${marketplaceId}:${pluginName}`;

    // 1. 分析结构 (使用 PluginStructureAnalyzer)
    const analyzer = new PluginStructureAnalyzer(pluginDir);
    const structure = await analyzer.analyze();

    // 2. 读取元数据 (plugin.json)
    let metadata: PluginMetadata = { name: pluginName, description: '', version: 'unknown' };
    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    const claudePluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');

    if (structure.hasPluginJson) {
      metadata = await fs.readJson(pluginJsonPath);
    } else if (structure.hasClaudePluginDir && await fs.pathExists(claudePluginJsonPath)) {
      metadata = await fs.readJson(claudePluginJsonPath);
    }

    // 3. 发现组件 (使用 ComponentParser)
    const components: UnifiedComponent[] = [];

    // 优先处理显式定义的组件 (如果有 plugin.json)
    const getMetadataPath = (p: string) => path.isAbsolute(p) ? p : path.join(pluginDir, p);

    if (metadata.skills && (Array.isArray(metadata.skills) || typeof metadata.skills === 'string')) {
      const skillPaths = Array.isArray(metadata.skills) ? metadata.skills : [metadata.skills];
      for (const sp of skillPaths) {
        const fullPath = getMetadataPath(sp);
        const component = await this.componentParser.parse(fullPath, ComponentType.SKILL, id, marketplaceId, pluginDir);
        if (component) components.push(component);
      }
    }

    if (metadata.commands && (Array.isArray(metadata.commands) || typeof metadata.commands === 'string')) {
      const cmdPaths = Array.isArray(metadata.commands) ? metadata.commands : [metadata.commands];
      for (const cp of cmdPaths) {
        const fullPath = getMetadataPath(cp);
        const component = await this.componentParser.parse(fullPath, ComponentType.COMMAND, id, marketplaceId, pluginDir);
        if (component) components.push(component);
      }
    }

    if (metadata.agents && (Array.isArray(metadata.agents) || typeof metadata.agents === 'string')) {
      const agentPaths = Array.isArray(metadata.agents) ? metadata.agents : [metadata.agents];
      for (const ap of agentPaths) {
        const fullPath = getMetadataPath(ap);
        const component = await this.componentParser.parse(fullPath, ComponentType.AGENT, id, marketplaceId, pluginDir);
        if (component) components.push(component);
      }
    }

    // 自动发现组件（去重）
    const existingIds = new Set(components.map(c => c.id));
    const addComponent = (c: UnifiedComponent) => {
      if (c && !existingIds.has(c.id)) {
        components.push(c);
        existingIds.add(c.id);
      }
    };

    // Agents
    if (structure.directories.agents) {
      if (await fs.pathExists(path.join(pluginDir, 'agents'))) {
        const found = await this.scanComponents(pluginDir, 'agents', ComponentType.AGENT, id, marketplaceId);
        found.forEach(addComponent);
      }
      if (await fs.pathExists(path.join(pluginDir, '.claude/agents'))) {
        const found = await this.scanComponents(pluginDir, '.claude/agents', ComponentType.AGENT, id, marketplaceId);
        found.forEach(addComponent);
      }
    }

    // Commands
    if (structure.directories.commands) {
      const commandDirs = ['commands', '.claude/commands', '.cursor/commands', '.roo/commands'];
      for (const dir of commandDirs) {
        if (await fs.pathExists(path.join(pluginDir, dir))) {
          const found = await this.scanComponents(pluginDir, dir, ComponentType.COMMAND, id, marketplaceId);
          found.forEach(addComponent);
        }
      }
    }

    // Skills
    if (structure.directories.skills) {
      if (await fs.pathExists(path.join(pluginDir, 'skills'))) {
        const found = await this.scanComponents(pluginDir, 'skills', ComponentType.SKILL, id, marketplaceId);
        found.forEach(addComponent);
      }
      if (await fs.pathExists(path.join(pluginDir, '.claude/skills'))) {
        const found = await this.scanComponents(pluginDir, '.claude/skills', ComponentType.SKILL, id, marketplaceId);
        found.forEach(addComponent);
      }
    } else {
      // 尝试扫描根目录下的 Skills (Otto 扁平结构)
      // 这种结构常见于旧性 Otto 插件，如 document-skills
      const skills = await this.scanComponents(
        pluginDir, '.', ComponentType.SKILL, id, marketplaceId
      );
      skills.forEach(addComponent);
    }

    // 4. 构建 UnifiedPlugin
    return {
      id,
      name: metadata.name || pluginName,
      description: metadata.description || '',
      version: metadata.version || 'unknown',
      author: metadata.author,
      source: ComponentSource.MARKETPLACE,
      location: {
        type: 'directory',
        path: pluginDir
      },
      components,
      structure,
      installed: true,
      enabled: true,
      marketplace: {
        id: marketplaceId,
        name: marketplaceId
      }
    };
  }

  private async scanComponents(
    pluginDir: string,
    subDir: string,
    type: ComponentType,
    pluginId: string,
    marketplaceId: string
  ): Promise<UnifiedComponent[]> {
    const dirPath = path.join(pluginDir, subDir);
    const components: UnifiedComponent[] = [];

    if (!(await fs.pathExists(dirPath))) return components;

    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dirPath, entry.name);

      // 使用 ComponentParser 解析组件
      const component = await this.componentParser.parse(
        fullPath,
        type,
        pluginId,
        marketplaceId,
        pluginDir
      );

      if (component) {
        components.push(component);
      }
    }

    return components;
  }

  // ==========================================================================
  // Plugin Caching Helpers
  // ==========================================================================

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
   * 从 plugin source 提取 Git URL
   * @param source Plugin source
   * @returns Git URL 或 null
   */
  private extractGitUrl(source: PluginSource): string | null {
    if (typeof source === 'object' && source !== null) {
      if (source.source === 'github') {
        return `https://github.com/${source.repo}.git`;
      } else if (source.source === 'git') {
        return source.url;
      } else if (source.source === 'url') {
        return source.url;
      }
    }
    return null;
  }

  /**
   * 克隆插件到缓存目录
   * @param gitUrl Git 仓库 URL
   * @param cachePath 缓存目录路径
   * @param source Plugin source 对象
   */
  private async clonePluginToCache(
    gitUrl: string,
    cachePath: string,
    source: PluginSource
  ): Promise<void> {
    try {
      console.log(`[MarketplaceLoader] Cloning plugin from ${gitUrl} to ${cachePath}`);
      await fs.ensureDir(path.dirname(cachePath));

      // 构建 git clone 参数数组（防止命令注入）
      const args: string[] = ['clone', '--depth', '1'];

      // 添加 ref (分支/tag) 如果指定
      if (typeof source === 'object' && 'ref' in source && source.ref) {
        args.push('--branch', source.ref);
      }

      args.push(gitUrl, cachePath);

      // 执行克隆 - 使用 spawnSync 而不是 execSync 以防止 shell 注入
      const result = spawnSync('git', args, {
        stdio: 'pipe',
        encoding: 'utf-8'
      });

      if (result.status !== 0) {
        const errorMsg = result.stderr || result.error?.message || 'Unknown error';
        throw new Error(`Git clone failed: ${errorMsg}`);
      }

      // 如果指定了 path，需要进入子目录
      if (typeof source === 'object' && 'path' in source && source.path) {
        const subPath = path.join(cachePath, source.path);
        if (await fs.pathExists(subPath)) {
          // 将子目录内容移到 cachePath 根目录
          const tempDir = cachePath + '_temp';
          await fs.move(subPath, tempDir);
          await fs.remove(cachePath);
          await fs.move(tempDir, cachePath);
        }
      }

      console.log(`[MarketplaceLoader] Plugin cached successfully: ${cachePath}`);
    } catch (error) {
      console.error(`[MarketplaceLoader] Failed to clone plugin to cache:`, error);
      // 清理失败的缓存
      if (await fs.pathExists(cachePath)) {
        await fs.remove(cachePath);
      }
      throw error;
    }
  }
}
