/**
 * Otto Skills Command
 *
 * Manages AI Skills: Marketplace → Plugin → Skill
 */

import path from 'path';
import os from 'os';
import { MessageType } from '../types.js';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import { t, tp } from '../utils/i18n.js';
import { normalizeGitHubUrl } from '../../utils/gitUrlNormalizer.js';
import {
  SettingsManager,
  MarketplaceManager,
  PluginInstaller,
  SkillLoader,
  SkillLoadLevel,
  SkillsPaths,
  clearSkillsContextCache,
  type Marketplace,
  type Plugin,
  type Skill,
} from 'otto-core';
import { PROJECT_DIR_PREFIX } from 'otto-core';

/**
 * Skills 系统单例缓存
 * 避免每次命令调用都重新创建实例，使 SkillLoader 缓存生效
 */
let skillsSystemInstance: {
  settings: SettingsManager;
  marketplace: MarketplaceManager;
  installer: PluginInstaller;
  loader: SkillLoader;
} | null = null;

/**
 * 初始化 Skills 系统组件（单例模式）
 */
export async function initSkillsSystem() {
  if (!skillsSystemInstance) {
    const settings = new SettingsManager();
    await settings.initialize();

    const marketplace = new MarketplaceManager(settings);
    const installer = new PluginInstaller(settings, marketplace);
    const loader = new SkillLoader(settings, marketplace);

    skillsSystemInstance = { settings, marketplace, installer, loader };
  }

  return skillsSystemInstance;
}

/**
 * 重置 Skills 系统单例（在 install/uninstall/enable/disable 后调用）
 */
export function resetSkillsSystem(): void {
  skillsSystemInstance = null;
}

/**
 * Plugin install action logic
 */
export const handlePluginInstallAction = (context: CommandContext, args?: string) => {
  const input = args?.trim();

  // If no input, show interactive selection dialog
  if (!input) {
    return {
      type: 'dialog' as const,
      dialog: 'plugin-install' as const,
    };
  }

  // Process with arguments asynchronously
  (async () => {
    try {
      const { marketplace, installer } = await initSkillsSystem();

      // Parse input: could be "plugin-name", "marketplace:plugin-name", or "plugin-name@marketplace"
      const colonIndex = input.indexOf(':');
      const atIndex = input.lastIndexOf('@');
      let marketplaceId: string | undefined;
      let pluginName: string;

      if (colonIndex !== -1) {
        // Explicit format: marketplace:plugin
        marketplaceId = input.substring(0, colonIndex);
        pluginName = input.substring(colonIndex + 1);
      } else if (atIndex !== -1) {
        // New format: plugin@marketplace
        pluginName = input.substring(0, atIndex);
        marketplaceId = input.substring(atIndex + 1);
      } else {
        // Implicit format: just plugin-name
        pluginName = input;
        const allMarketplaces = await marketplace.listMarketplaces();

        // Search for plugin in all marketplaces
        const matches: Array<{ mpId: string; mpName: string }> = [];
        for (const mp of allMarketplaces) {
          try {
            const plugins = await marketplace.getPlugins(mp.id);
            const found = plugins.find(p => p.name === pluginName);
            if (found) {
              matches.push({ mpId: mp.id, mpName: mp.name });
            }
          } catch {
            // Ignore errors for individual marketplaces
          }
        }

        if (matches.length === 0) {
          throw new Error(
            `Plugin "${pluginName}" not found in any marketplace.\n` +
            `Try specifying marketplace explicitly: /skill install ${pluginName}@<marketplace>`
          );
        } else if (matches.length > 1) {
          const marketplaceList = matches
            .map(m => `  • ${m.mpName} (${m.mpId})`)
            .join('\n');
          throw new Error(
            `Plugin "${pluginName}" found in ${matches.length} marketplaces:\n${marketplaceList}\n\n` +
            `Please specify which one to use:\n` +
            `  /skill install ${pluginName}@${matches[0].mpId}`
          );
        } else {
          // Unique match
          marketplaceId = matches[0].mpId;
        }
      }

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: tp('skill.plugin.install.progress', { plugin: pluginName, marketplace: marketplaceId }),
        },
        Date.now(),
      );

      const plugin = await installer.installPlugin(marketplaceId, pluginName);

      // Clear Skills context cache
      clearSkillsContextCache();
              resetSkillsSystem();

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: tp('skill.plugin.install.success', { name: plugin.name, id: plugin.id, count: plugin.skillPaths.length }),
        },
        Date.now(),
      );
    } catch (error) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: tp('skill.plugin.install.failed', { error: error instanceof Error ? error.message : String(error) }),
        },
        Date.now(),
      );
    }
  })();
};

/**
 * Plugin install completion logic
 */
export const handlePluginInstallCompletion = async (context: CommandContext, partialArg: string): Promise<Suggestion[]> => {
  // Prevent duplicate arguments: install only takes one argument
  if (context.invocation) {
     const parts = context.invocation.raw.trim().split(/\s+/);
     const hasTrailingSpace = context.invocation.raw.endsWith(' ');

     if (parts.length >= 4 && hasTrailingSpace) {
       return [];
     }
     if (parts.length > 4) {
       return [];
     }
  }

  try {
    const { marketplace } = await initSkillsSystem();

    // Check for colon separator first (new format)
    const colonIndex = partialArg.indexOf(':');
    // Also check for space (legacy/fallback)
    const spaceIndex = partialArg.indexOf(' ');

    const separatorIndex = colonIndex !== -1 ? colonIndex : spaceIndex;

    if (separatorIndex === -1) {
      // Case 1: Typing Marketplace ID
      const input = partialArg.toLowerCase();
      const mps = await marketplace.listMarketplaces();
      return mps
        .filter(mp => mp.id.toLowerCase().startsWith(input))
        .map(mp => ({
          label: mp.name,
          value: mp.id + ':', // Use colon to prepare for plugin name
          description: mp.description || mp.url
        }));
    } else {
      // Case 2: Typing Plugin Name
      const marketplaceId = partialArg.substring(0, separatorIndex);
      const pluginInput = partialArg.substring(separatorIndex + 1).trim().toLowerCase();
      const hasTrailingSpace = partialArg.endsWith(' ');

      try {
        const plugins = await marketplace.getPlugins(marketplaceId);

        // If input has trailing space and matches a plugin name exactly,
        // the argument is complete — stop showing suggestions
        if (hasTrailingSpace && pluginInput) {
          const exactMatch = plugins.find(p => p.name.toLowerCase() === pluginInput);
          if (exactMatch) {
            return [];
          }
        }

        // 排除已安装的插件
        const { installer } = await initSkillsSystem();
        const installedPlugins = await installer.getInstalledPlugins();
        const installedIds = new Set(installedPlugins.map(p => p.id));

        return plugins
          .filter(p => !installedIds.has(`${marketplaceId}:${p.name}`))
          .filter(p => p.name.toLowerCase().includes(pluginInput))
          .map(p => ({
            label: p.name,
            value: `${marketplaceId}:${p.name}`,
            description: p.description
          }));
      } catch (e) {
        return [];
      }
    }
  } catch (error) {
    return [];
  }
};

/**
 * 格式化 Marketplace 信息
 */
export function formatMarketplace(mp: Marketplace): string {
  const lines: string[] = [];
  lines.push(`📦 ${mp.name} (${mp.id})`);
  lines.push(`   ${t('skill.label.source')}${mp.source === 'git' ? mp.url : mp.path}`);
  lines.push(`   ${t('skill.label.plugins')}${mp.plugins.length}`);
  if (mp.description) {
    lines.push(`   ${t('skill.label.description')}${mp.description}`);
  }
  if (mp.official) {
    lines.push(`   ${t('skill.label.official')}`);
  }
  return lines.join('\n');
}

/**
 * 格式化 Plugin 信息
 */
export function formatPlugin(plugin: Plugin, installed = false): string {
  const lines: string[] = [];
  const status = installed ? '✅' : '❌';
  lines.push(`🔌 ${plugin.name} ${status}`);
  lines.push(`   ${t('skill.label.id')}${plugin.id}`);
  lines.push(`   ${t('skill.label.description')}${plugin.description}`);
  lines.push(`   ${t('skill.label.skills')}${plugin.skillPaths.length}`);
  return lines.join('\n');
}

/**
 * 格式化 Skill 信息
 */
export function formatSkill(skill: Skill): string {
  const lines: string[] = [];

  // 根据类型选择图标
  let icon = '⚡';
  if (skill.type === 'agent') icon = '🤖';
  if (skill.type === 'command') icon = '⌨️';

  lines.push(`${icon} ${skill.name} (${skill.type || 'skill'})`);
  lines.push(`   ${skill.description}`);
  if (skill.metadata.allowedTools && skill.metadata.allowedTools.length > 0) {
    lines.push(`   ${t('skill.label.tools')}${skill.metadata.allowedTools.join(', ')}`);
  }
  return lines.join('\n');
}

export const skillCommand: SlashCommand = {
  name: 'skill',
  description: t('skill.command.description'),
  kind: CommandKind.BUILT_IN,

  action: async (context: CommandContext) => {
    // 显示帮助信息
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('skill.help.text'),
      },
      Date.now(),
    );
  },

  subCommands: [
    // ========================================================================
    // /skill marketplace
    // ========================================================================
    {
      name: 'marketplace',
      description: t('skill.marketplace.description'),
      kind: CommandKind.BUILT_IN,

      action: async (context: CommandContext) => {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t('skill.marketplace.usage'),
          },
          Date.now(),
        );
      },

      subCommands: [
        {
          name: 'list',
          description: t('skill.marketplace.list.description'),
          kind: CommandKind.BUILT_IN,

          action: async (context: CommandContext) => {
            try {
              const { marketplace } = await initSkillsSystem();
              const marketplaces = await marketplace.listMarketplaces();

              if (marketplaces.length === 0) {
                context.ui.addItem(
                  {
                    type: MessageType.INFO,
                    text: t('skill.marketplace.list.empty.hint'),
                  },
                  Date.now(),
                );
                return;
              }

              const text = tp('skill.marketplace.list.found', { count: marketplaces.length }) +
                marketplaces.map(formatMarketplace).join('\n\n');

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text,
                },
                Date.now(),
              );
            } catch (error) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: tp('skill.marketplace.list.failed', { error: error instanceof Error ? error.message : String(error) }),
                },
                Date.now(),
              );
            }
          },
        },

        {
          name: 'add',
          description: t('skill.marketplace.add.description'),
          kind: CommandKind.BUILT_IN,

          action: async (context: CommandContext, args?: string) => {
            const location = args?.trim();

            if (!location) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: t('skill.marketplace.add.usage'),
                },
                Date.now(),
              );
              return;
            }

            try {
              const { marketplace } = await initSkillsSystem();

              // Parse options
              const parts = location.split(/\s+/);
              let url = parts[0];

              let name: string | undefined;
              const nameIndex = parts.indexOf('--name');

              if (nameIndex !== -1 && parts[nameIndex + 1]) {
                name = parts[nameIndex + 1];
              } else if (parts.length > 1 && !parts[1].startsWith('--')) {
                // Support positional alias: /skill marketplace add <url> <alias>
                name = parts[1];
              }

              // Normalize GitHub short form (owner/repo) to full URL
              url = normalizeGitHubUrl(url);

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: tp('skill.marketplace.add.progress', { url, name: name ? ` as ${name}` : '' }),
                },
                Date.now(),
              );

              let mp;
              if (url.startsWith('http://') || url.startsWith('https://')) {
                mp = await marketplace.addGitMarketplace(url, name);
              } else {
                mp = await marketplace.addLocalMarketplace(url, name);
              }

              // Clear Skills context cache to reload
              clearSkillsContextCache();
              resetSkillsSystem();

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: tp('skill.marketplace.add.success', { name: mp.name, id: mp.id, count: mp.plugins.length }),
                },
                Date.now(),
              );
            } catch (error) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: tp('skill.marketplace.add.failed', { error: error instanceof Error ? error.message : String(error) }),
                },
                Date.now(),
              );
            }
          },
        },

        {
          name: 'update',
          description: t('skill.marketplace.update.description'),
          kind: CommandKind.BUILT_IN,

          action: async (context: CommandContext, args?: string) => {
            const marketplaceId = args?.trim();

            if (!marketplaceId) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: t('skill.marketplace.update.usage'),
                },
                Date.now(),
              );
              return;
            }

            try {
              const { marketplace } = await initSkillsSystem();

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: tp('skill.marketplace.update.progress', { id: marketplaceId }),
                },
                Date.now(),
              );

              const mp = await marketplace.updateMarketplace(marketplaceId);

              // Clear Skills context cache
              clearSkillsContextCache();
              resetSkillsSystem();

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: tp('skill.marketplace.update.success', { name: mp.name, count: mp.plugins.length }),
                },
                Date.now(),
              );
            } catch (error) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: tp('skill.marketplace.update.failed', { error: error instanceof Error ? error.message : String(error) }),
                },
                Date.now(),
              );
            }
          },
        },

        {
          name: 'remove',
          description: t('skill.marketplace.remove.description'),
          kind: CommandKind.BUILT_IN,

          completion: async (context: CommandContext, partialArg: string): Promise<Suggestion[]> => {
            try {
              const { marketplace } = await initSkillsSystem();
              const mps = await marketplace.listMarketplaces();
              return mps
                .filter(mp => mp.id.startsWith(partialArg))
                .map(mp => ({
                  label: mp.name,
                  value: mp.id,
                  description: mp.description || mp.url
                }));
            } catch (error) {
              return [];
            }
          },

          action: async (context: CommandContext, args?: string) => {
            const marketplaceId = args?.trim();

            try {
              const { marketplace } = await initSkillsSystem();

              if (!marketplaceId) {
                // List available marketplaces for removal
                const marketplaces = await marketplace.listMarketplaces();

                if (marketplaces.length === 0) {
                  context.ui.addItem(
                    {
                      type: MessageType.INFO,
                      text: t('skill.marketplace.remove.empty'),
                    },
                    Date.now(),
                  );
                  return;
                }

                const text = t('skill.marketplace.remove.select') +
                  marketplaces.map(mp => `📦 ${mp.name} (${mp.id})\n   Usage: /skill marketplace remove ${mp.id}`).join('\n\n');

                context.ui.addItem(
                  {
                    type: MessageType.INFO,
                    text,
                  },
                  Date.now(),
                );
                return;
              }

              const parts = marketplaceId.split(/\s+/);
              const id = parts[0];
              const preserveFiles = parts.includes('--keep-files') || parts.includes('--preserve-files');

              await marketplace.removeMarketplace(id, preserveFiles);

              // Clear Skills context cache
              clearSkillsContextCache();
              resetSkillsSystem();

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: tp('skill.marketplace.remove.success', { id, files: preserveFiles ? '' : t('skill.marketplace.remove.files_deleted') }),
                },
                Date.now(),
              );
            } catch (error) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: tp('skill.marketplace.remove.failed', { error: error instanceof Error ? error.message : String(error) }),
                },
                Date.now(),
              );
            }
          },
        },

        {
          name: 'browse',
          description: t('skill.marketplace.browse.description'),
          kind: CommandKind.BUILT_IN,

          completion: async (context: CommandContext, partialArg: string): Promise<Suggestion[]> => {
            try {
              const { marketplace } = await initSkillsSystem();
              const mps = await marketplace.listMarketplaces();
              return mps
                .filter(mp => mp.id.startsWith(partialArg))
                .map(mp => ({
                  label: mp.name,
                  value: mp.id,
                  description: mp.description || mp.url
                }));
            } catch (error) {
              return [];
            }
          },

          action: async (context: CommandContext, args?: string) => {
            const input = args?.trim();

            try {
              const { marketplace } = await initSkillsSystem();

              if (!input) {
                // List available marketplaces for browsing
                const marketplaces = await marketplace.listMarketplaces();

                if (marketplaces.length === 0) {
                  context.ui.addItem(
                    {
                      type: MessageType.INFO,
                      text: t('skill.marketplace.list.empty.hint'),
                    },
                    Date.now(),
                  );
                  return;
                }

                const text = t('skill.marketplace.browse.select') +
                  marketplaces.map(mp => `📦 ${mp.name} (${mp.id})\n   Usage: /skill marketplace browse ${mp.id}`).join('\n\n');

                context.ui.addItem(
                  {
                    type: MessageType.INFO,
                    text,
                  },
                  Date.now(),
                );
                return;
              }

              const parts = input.split(/\s+/);
              const marketplaceId = parts[0];
              const query = parts.slice(1).join(' ');

              const plugins = await marketplace.browseMarketplace(marketplaceId, query);

              if (plugins.length === 0) {
                context.ui.addItem(
                  {
                    type: MessageType.INFO,
                    text: tp('skill.marketplace.browse.empty', { id: marketplaceId, query: query ? ` (query: "${query}")` : '' }),
                  },
                  Date.now(),
                );
                return;
              }

              const text = tp('skill.marketplace.browse.found', { count: plugins.length, id: marketplaceId }) +
                plugins.map(p => formatPlugin(p, p.installed)).join('\n\n');

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text,
                },
                Date.now(),
              );
            } catch (error) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: tp('skill.marketplace.browse.failed', { error: error instanceof Error ? error.message : String(error) }),
                },
                Date.now(),
              );
            }
          },
        },
      ],
    },

    // ========================================================================
    // /skill plugin
    // ========================================================================
    {
      name: 'plugin',
      description: t('skill.plugin.description'),
      kind: CommandKind.BUILT_IN,

      action: async (context: CommandContext) => {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t('skill.plugin.usage'),
          },
          Date.now(),
        );
      },

      subCommands: [
        {
          name: 'list',
          description: t('skill.plugin.list.description'),
          kind: CommandKind.BUILT_IN,

          completion: async (context: CommandContext, partialArg: string): Promise<Suggestion[]> => {
            try {
              const { marketplace } = await initSkillsSystem();
              const mps = await marketplace.listMarketplaces();
              return mps
                .filter(mp => mp.id.startsWith(partialArg))
                .map(mp => ({
                  label: mp.name,
                  value: mp.id,
                  description: mp.description || mp.url
                }));
            } catch (error) {
              return [];
            }
          },

          action: async (context: CommandContext, args?: string) => {
            const marketplaceId = args?.trim();

            try {
              const { marketplace, installer } = await initSkillsSystem();

              if (marketplaceId) {
                // List available plugins in marketplace
                const plugins = await marketplace.getPlugins(marketplaceId);

                if (plugins.length === 0) {
                  context.ui.addItem(
                    {
                      type: MessageType.INFO,
                      text: tp('skill.plugin.list.marketplace.empty', { id: marketplaceId }),
                    },
                    Date.now(),
                  );
                  return;
                }

                const text = tp('skill.plugin.list.marketplace.found', { id: marketplaceId }) +
                  plugins.map(p => formatPlugin(p, p.installed)).join('\n\n');

                context.ui.addItem(
                  {
                    type: MessageType.INFO,
                    text,
                  },
                  Date.now(),
                );
              } else {
                // List installed plugins
                const plugins = await installer.getInstalledPlugins();

                if (plugins.length === 0) {
                  context.ui.addItem(
                    {
                      type: MessageType.INFO,
                      text: t('skill.plugin.list.installed.empty'),
                    },
                    Date.now(),
                  );
                  return;
                }

                // 动态计算每个插件的实际 skill 数量（避免依赖安装时的静态快照）
                const dynamicSkillCounts = new Map<string, number>();
                try {
                  const { loader } = await initSkillsSystem();
                  const allSkills = await loader.loadEnabledSkills(SkillLoadLevel.METADATA);
                  for (const skill of allSkills) {
                    if (skill.pluginId) {
                      dynamicSkillCounts.set(skill.pluginId, (dynamicSkillCounts.get(skill.pluginId) || 0) + 1);
                    }
                  }
                } catch {
                  // 动态计算失败时回退到静态 skillCount
                }

                const lines = [tp('skill.plugin.list.installed.found', { count: plugins.length })];

                // Detect duplicate plugin names
                const nameMap = new Map<string, typeof plugins>();
                for (const p of plugins) {
                  if (!nameMap.has(p.name)) {
                    nameMap.set(p.name, []);
                  }
                  nameMap.get(p.name)!.push(p);
                }

                const duplicates = Array.from(nameMap.entries())
                  .filter(([_, pluginList]) => pluginList.length > 1);

                if (duplicates.length > 0) {
                  lines.push('');
                  lines.push('⚠️  ' + t('skill.plugin.list.duplicates.warning'));
                  for (const [name, pluginList] of duplicates) {
                    lines.push(`   • "${name}" × ${pluginList.length} (${pluginList.map(p => p.marketplaceId).join(', ')})`);
                  }
                  lines.push('');
                }

                for (const p of plugins) {
                  const status = p.enabled ? t('skill.label.enabled') : t('skill.label.disabled');
                  // 优先使用动态计算的 skill 数量，回退到静态 skillCount
                  const skillCount = dynamicSkillCounts.get(p.id) ?? p.skillCount;
                  lines.push(`🔌 ${p.name} (${status})`);
                  lines.push(`   ${t('skill.label.id')}${p.id}`);
                  lines.push(`   ${t('skill.label.marketplace')}${p.marketplaceId}`);
                  lines.push(`   ${t('skill.label.skills')}${skillCount}`);
                  if (p.version) {
                    lines.push(`   ${t('skill.label.version')}${p.version}`);
                  }
                  lines.push('');
                }

                context.ui.addItem(
                  {
                    type: MessageType.INFO,
                    text: lines.join('\n'),
                  },
                  Date.now(),
                );
              }
            } catch (error) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: tp('skill.plugin.list.failed', { error: error instanceof Error ? error.message : String(error) }),
                },
                Date.now(),
              );
            }
          },
        },

        {
          name: 'install',
          description: t('skill.plugin.install.description'),
          kind: CommandKind.BUILT_IN,
          completion: handlePluginInstallCompletion,
          action: handlePluginInstallAction,
        },

        {
          name: 'uninstall',
          description: t('skill.plugin.uninstall.description'),
          kind: CommandKind.BUILT_IN,

          completion: async (context: CommandContext, partialArg: string): Promise<Suggestion[]> => {
            try {
              const { installer } = await initSkillsSystem();
              const plugins = await installer.getInstalledPlugins();
              const input = partialArg.trim().toLowerCase();

              return plugins
                .filter(p => p.id.toLowerCase().includes(input) || p.name.toLowerCase().includes(input))
                .map(p => ({
                  label: p.name,
                  value: p.id,
                  description: `${p.description} (${p.id})`
                }));
            } catch (error) {
              return [];
            }
          },

          action: async (context: CommandContext, args?: string) => {
            const pluginId = args?.trim();

            if (!pluginId) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: t('skill.plugin.uninstall.usage'),
                },
                Date.now(),
              );
              return;
            }

            try {
              const { installer } = await initSkillsSystem();

              const parts = pluginId.split(/\s+/);
              const id = parts[0];
              const deleteFiles = parts.includes('--delete-files');

              await installer.uninstallPlugin(id, deleteFiles);

              // Clear Skills context cache
              clearSkillsContextCache();
              resetSkillsSystem();

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: tp('skill.plugin.uninstall.success', { id }) + (deleteFiles ? t('skill.marketplace.remove.files_deleted') : ''),
                },
                Date.now(),
              );
            } catch (error) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: tp('skill.plugin.uninstall.failed', { error: error instanceof Error ? error.message : String(error) }),
                },
                Date.now(),
              );
            }
          },
        },

        {
          name: 'enable',
          description: t('skill.plugin.enable.description'),
          kind: CommandKind.BUILT_IN,

          completion: async (context: CommandContext, partialArg: string): Promise<Suggestion[]> => {
            try {
              const { installer } = await initSkillsSystem();
              const plugins = await installer.getInstalledPlugins();
              const input = partialArg.trim().toLowerCase();

              return plugins
                .filter(p => !p.enabled) // Only show disabled plugins for enable command
                .filter(p => p.id.toLowerCase().includes(input) || p.name.toLowerCase().includes(input))
                .map(p => ({
                  label: p.name,
                  value: p.id,
                  description: `${p.description} (${p.id})`
                }));
            } catch (error) {
              return [];
            }
          },

          action: async (context: CommandContext, args?: string) => {
            const pluginId = args?.trim();

            if (!pluginId) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: t('skill.plugin.enable.usage'),
                },
                Date.now(),
              );
              return;
            }

            try {
              const { installer } = await initSkillsSystem();
              await installer.enablePlugin(pluginId);

              // Clear Skills context cache
              clearSkillsContextCache();
              resetSkillsSystem();

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: tp('skill.plugin.enable.success', { id: pluginId }),
                },
                Date.now(),
              );
            } catch (error) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: tp('skill.plugin.enable.failed', { error: error instanceof Error ? error.message : String(error) }),
                },
                Date.now(),
              );
            }
          },
        },

        {
          name: 'disable',
          description: t('skill.plugin.disable.description'),
          kind: CommandKind.BUILT_IN,

          completion: async (context: CommandContext, partialArg: string): Promise<Suggestion[]> => {
            try {
              const { installer } = await initSkillsSystem();
              const plugins = await installer.getInstalledPlugins();
              const input = partialArg.trim().toLowerCase();

              return plugins
                .filter(p => p.enabled) // Only show enabled plugins for disable command
                .filter(p => p.id.toLowerCase().includes(input) || p.name.toLowerCase().includes(input))
                .map(p => ({
                  label: p.name,
                  value: p.id,
                  description: `${p.description} (${p.id})`
                }));
            } catch (error) {
              return [];
            }
          },

          action: async (context: CommandContext, args?: string) => {
            const pluginId = args?.trim();

            if (!pluginId) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: t('skill.plugin.disable.usage'),
                },
                Date.now(),
              );
              return;
            }

            try {
              const { installer } = await initSkillsSystem();
              await installer.disablePlugin(pluginId);

              // Clear Skills context cache
              clearSkillsContextCache();
              resetSkillsSystem();

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: tp('skill.plugin.disable.success', { id: pluginId }),
                },
                Date.now(),
              );
            } catch (error) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: tp('skill.plugin.disable.failed', { error: error instanceof Error ? error.message : String(error) }),
                },
                Date.now(),
              );
            }
          },
        },

        {
          name: 'info',
          description: 'Show plugin information',
          kind: CommandKind.BUILT_IN,

          completion: async (context: CommandContext, partialArg: string): Promise<Suggestion[]> => {
            try {
              const { installer } = await initSkillsSystem();
              const plugins = await installer.getInstalledPlugins();
              const input = partialArg.trim().toLowerCase();

              return plugins
                .filter(p => p.id.toLowerCase().includes(input) || p.name.toLowerCase().includes(input))
                .map(p => ({
                  label: p.name,
                  value: p.id,
                  description: `${p.description} (${p.id})`
                }));
            } catch (error) {
              return [];
            }
          },

          action: async (context: CommandContext, args?: string) => {
            const pluginId = args?.trim();

            if (!pluginId) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: 'Usage: /skill plugin info <plugin-id>',
                },
                Date.now(),
              );
              return;
            }

            try {
              const { installer, marketplace } = await initSkillsSystem();

              const installedInfo = await installer.getPluginInfo(pluginId);

              if (!installedInfo) {
                context.ui.addItem(
                  {
                    type: MessageType.INFO,
                    text: `Plugin ${pluginId} is not installed.`,
                  },
                  Date.now(),
                );
                return;
              }

              const lines = [
                `Plugin: ${installedInfo.name}`,
                `ID: ${installedInfo.id}`,
                `Marketplace: ${installedInfo.marketplaceId}`,
                `Status: ${installedInfo.enabled ? '✅ Enabled' : '❌ Disabled'}`,
                `Skills: ${installedInfo.skillCount}`,
                `Installed: ${new Date(installedInfo.installedAt).toLocaleString()}`,
              ];

              if (installedInfo.version) {
                lines.push(`Version: ${installedInfo.version}`);
              }

              // Try to get full plugin details
              try {
                const [marketplaceId] = pluginId.split(':');
                const plugins = await marketplace.getPlugins(marketplaceId);
                const fullPlugin = plugins.find(p => p.id === pluginId);

                if (fullPlugin) {
                  lines.push('');
                  lines.push('Description:');
                  lines.push(`  ${fullPlugin.description}`);
                  lines.push('');
                  lines.push('Skills:');
                  for (const skillPath of fullPlugin.skillPaths) {
                    lines.push(`  - ${skillPath}`);
                  }
                }
              } catch {
                // Ignore if marketplace not available
              }

              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: lines.join('\n'),
                },
                Date.now(),
              );
            } catch (error) {
              context.ui.addItem(
                {
                  type: MessageType.ERROR,
                  text: `Failed to get plugin info: ${error instanceof Error ? error.message : String(error)}`,
                },
                Date.now(),
              );
            }
          },
        },
      ],
    },

    // ========================================================================
    // /skill install (alias for /skill plugin install)
    // ========================================================================
    {
      name: 'install',
      description: t('skill.install.description'),
      kind: CommandKind.BUILT_IN,
      completion: handlePluginInstallCompletion,
      action: handlePluginInstallAction,
    },

    // ========================================================================
    // /skill list
    // ========================================================================
    {
      name: 'list',
      description: 'List all available skills',
      kind: CommandKind.BUILT_IN,

      action: async (context: CommandContext, args?: string) => {
        try {
          const { loader } = await initSkillsSystem();

          // Load all skills
          const skills = await loader.loadEnabledSkills(SkillLoadLevel.METADATA);

          if (skills.length === 0) {
            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: `No skills found.\n\n • User skills: ${SkillsPaths.SKILLS_ROOT.replace(os.homedir(), '~')}/\n • Project skills: {project}/${PROJECT_DIR_PREFIX}/skills/\n • Add skills by creating SKILL.md files in these directories`,
              },
              Date.now(),
            );
            return;
          }

          // Define the display function inline to avoid circular reference
          const displaySkillsWithCategories = (skillsToDisplay: any[]): string => {
            // 从实际 skill 对象获取路径，如果没有则使用默认路径
            let userPath = SkillsPaths.SKILLS_ROOT.replace(os.homedir(), '~');
            // 项目路径：使用 PROJECT_DIR_PREFIX 常量
            let projectPathDisplay = `{project}/${PROJECT_DIR_PREFIX}/skills`;

            // 尝试从第一个 skill 的 location 获取实际路径
            const userSkill = skillsToDisplay.find(s => s.isCustom && s.location?.type === 'user_global');
            if (userSkill?.location?.rootPath) {
              userPath = userSkill.location.rootPath.replace(os.homedir(), '~');
            }

            const projectSkill = skillsToDisplay.find(s => s.isCustom && s.location?.type === 'user_project');
            if (projectSkill?.location?.rootPath) {
              // 从实际路径中提取相对路径部分
              const rootPath = projectSkill.location.rootPath;
              const relativePath = path.relative(process.cwd(), rootPath);
              projectPathDisplay = `{project}/${relativePath}`;
            }

            const categories = {
              user: { skills: [] as any[], path: userPath, title: 'User skills' },
              project: { skills: [] as any[], path: projectPathDisplay, title: 'Project skills' },
              marketplace: { skills: [] as any[], path: 'plugin', title: 'Plugin skills' }
            };

            // 分类
            skillsToDisplay.forEach(skill => {
              if (skill.isCustom && skill.location?.type === 'user_global') {
                categories.user.skills.push(skill);
              } else if (skill.isCustom && skill.location?.type === 'user_project') {
                categories.project.skills.push(skill);
              } else {
                categories.marketplace.skills.push(skill);
              }
            });

            // 生成输出
            const lines: string[] = [];
            let totalSkills = skillsToDisplay.length;

            // 标题和统计
            lines.push(`Skills (${totalSkills}):\n`);

            // 分类显示
            Object.entries(categories).forEach(([key, category]: [string, any]) => {
              if (category.skills.length > 0) {
                lines.push(`\n ${category.title} (${category.path})`);

                category.skills.forEach((skill: any) => {
                  const name = skill.name;
                  const prefix = skill.scripts && skill.scripts.length > 0 ? '⚡' : '•';

                  lines.push(` ${prefix} ${name}`);
                });
              }
            });

            return lines.join('\n');
          };

          const output = displaySkillsWithCategories(skills);

          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: output,
            },
            Date.now(),
          );
        } catch (error) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: `Failed to list skills: ${error instanceof Error ? error.message : String(error)}`,
            },
            Date.now(),
          );
        }
      },
    },

    // ========================================================================
    // /skill info
    // ========================================================================
    {
      name: 'info',
      description: 'Show detailed skill information',
      kind: CommandKind.BUILT_IN,

      completion: async (context: CommandContext, partialArg: string): Promise<Suggestion[]> => {
        try {
          const { loader } = await initSkillsSystem();
          // Load metadata only for speed
          const skills = await loader.loadEnabledSkills(SkillLoadLevel.METADATA);
          const input = partialArg.trim().toLowerCase();

          return skills
            .filter(s => s.id.toLowerCase().includes(input) || s.name.toLowerCase().includes(input))
            .map(s => ({
              label: s.name,
              value: s.id,
              description: `${s.description} (${s.id})`
            }));
        } catch (error) {
          return [];
        }
      },

      action: async (context: CommandContext, args?: string) => {
        const skillId = args?.trim();

        if (!skillId) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: 'Usage: /skill info <skill-id>',
            },
            Date.now(),
          );
          return;
        }

        try {
          const { loader } = await initSkillsSystem();

          // Load skill with full content
          const skill = await loader.loadSkill(skillId, SkillLoadLevel.FULL);

          if (!skill) {
            context.ui.addItem(
              {
                type: MessageType.INFO,
                text: `Skill ${skillId} not found.\n\nList all skills:\n  /skill list`,
              },
              Date.now(),
            );
            return;
          }

          const lines = [
            `Skill: ${skill.name}`,
            `ID: ${skill.id}`,
            `Description: ${skill.description}`,
            '',
            'Metadata:',
            `  Marketplace: ${skill.marketplaceId}`,
            `  Plugin: ${skill.pluginId}`,
          ];

          if (skill.metadata.license) {
            lines.push(`  License: ${skill.metadata.license}`);
          }
          if (skill.metadata.allowedTools && skill.metadata.allowedTools.length > 0) {
            lines.push(`  Allowed Tools: ${skill.metadata.allowedTools.join(', ')}`);
          }
          if (skill.metadata.dependencies && skill.metadata.dependencies.length > 0) {
            lines.push(`  Dependencies: ${skill.metadata.dependencies.join(', ')}`);
          }

          if (skill.content) {
            lines.push('');
            lines.push('Instructions:');
            lines.push('─'.repeat(60));
            lines.push(skill.content);
            lines.push('─'.repeat(60));
          }

          // Load resources
          const skillWithResources = await loader.loadSkill(skillId, SkillLoadLevel.RESOURCES);

          if (skillWithResources?.scripts && skillWithResources.scripts.length > 0) {
            lines.push('');
            lines.push('Scripts:');
            for (const script of skillWithResources.scripts) {
              lines.push(`  - ${script.name} (${script.type})`);
            }
          }

          if (skillWithResources?.references && skillWithResources.references.length > 0) {
            lines.push('');
            lines.push('Reference Documents:');
            for (const ref of skillWithResources.references) {
              const refName = ref.split('/').pop() || ref;
              lines.push(`  - ${refName}`);
            }
          }

          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: lines.join('\n'),
            },
            Date.now(),
          );
        } catch (error) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: `Failed to get skill info: ${error instanceof Error ? error.message : String(error)}`,
            },
            Date.now(),
          );
        }
      },
    },

    // ========================================================================
    // /skill stats
    // ========================================================================
    {
      name: 'stats',
      description: 'Show skills statistics',
      kind: CommandKind.BUILT_IN,

      action: async (context: CommandContext, args: string) => {
        try {
          const { loader } = await initSkillsSystem();
          const argsArray = args.trim().split(/\s+/).filter(Boolean);
          const verbose = argsArray.includes('--verbose') || argsArray.includes('-v');

          // Always force reload to ensure stats are accurate
          const stats = await loader.getSkillStats(true);

          const lines = [
            'Skills Statistics:\n',
            `Total Skills: ${stats.total}`,
            '',
            'By Marketplace:',
          ];

          for (const [marketplaceId, count] of Object.entries(stats.byMarketplace)) {
            lines.push(`  ${marketplaceId}: ${count} skills`);
          }

          lines.push('');
          lines.push('By Plugin:');
          for (const [pluginId, count] of Object.entries(stats.byPlugin)) {
            const pluginName = pluginId.split(':').slice(1).join(':');
            lines.push(`  ${pluginName}: ${count} skills`);
          }

          // Verbose mode: show detailed skill list
          if (verbose) {
            const skills = await loader.loadEnabledSkills();
            lines.push('');
            lines.push('Detailed Skill List:');

            const groupedByMarketplace = new Map<string, typeof skills>();
            for (const skill of skills) {
              const marketplace = skill.marketplaceId;
              if (!groupedByMarketplace.has(marketplace)) {
                groupedByMarketplace.set(marketplace, []);
              }
              groupedByMarketplace.get(marketplace)!.push(skill);
            }

            for (const [marketplace, marketplaceSkills] of groupedByMarketplace) {
              lines.push(`\n  ${marketplace}:`);
              for (const skill of marketplaceSkills) {
                lines.push(`    - ${skill.id} (${skill.pluginId})`);
              }
            }
          }

          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: lines.join('\n'),
            },
            Date.now(),
          );
        } catch (error) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: `Failed to get statistics: ${error instanceof Error ? error.message : String(error)}`,
            },
            Date.now(),
          );
        }
      },
    },
  ],

  };
