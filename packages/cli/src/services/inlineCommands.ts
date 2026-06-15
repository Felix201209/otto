/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * 内置命令配置接口
 * 通过修改这个文件的字符串即可轻松调整命令行为
 */
export interface InlineCommandDef {
  /** 命令名称 */
  name: string;
  /** 命令描述 */
  description: string;
  /** 提示词模板，支持 {{args}} 占位符 */
  prompt: string;
  /** 命令别名 */
  altNames?: string[];
  /** 是否启用 */
  enabled?: boolean;
}

/**
 * 内置命令配置集合
 * 🎯 通过修改这里的字符串即可快速调整命令行为，无需改动代码逻辑
 */
export const INLINE_COMMANDS: InlineCommandDef[] = [
  {
    name: 'ask',
    description: 'Ask AI for information',
    altNames: ['问', 'search', 'query'],
    prompt: `Please handle the following query:

{{args}}

**IMPORTANT CONSTRAINTS**:
- 🌐 **Use ONLY web search tools**: Please use google_web_search or web_fetch and other network-related tools to get the latest information
- 🚫 **NEVER access local project**: Do NOT use read_file, write_file, list_directory, glob, search_file_content, or any file system tools
- 🚫 **Do NOT modify code**: Do NOT use replace, delete_file, run_shell_command, or any project modification tools
- 📡 **Focus on online resources**: Prioritize using public information, documentation, tutorials, and other resources from the internet

Please provide accurate and timely information based on web search results. If you need to get the latest data or verify information, please actively perform web searches.`,
    enabled: true,
  },
];

/**
 * 根据名称查找命令配置
 * @param name 命令名称或别名
 * @returns 命令配置对象，如果未找到则返回 undefined
 */
export function findInlineCommand(name: string): InlineCommandDef | undefined {
  return INLINE_COMMANDS.find(cmd =>
    cmd.enabled !== false && (
      cmd.name === name ||
      cmd.altNames?.includes(name)
    )
  );
}

/**
 * 获取所有启用的命令配置
 * @returns 启用的命令配置数组
 */
export function getEnabledInlineCommands(): InlineCommandDef[] {
  return INLINE_COMMANDS.filter(cmd => cmd.enabled !== false);
}