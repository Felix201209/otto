/**
 * Otto Skills System - Skill Context Injector
 *
 * Manages AI Context injection with three-tier loading:
 * - Level 1: Metadata (启动时) - ~100 tokens/skill
 * - Level 2: Full SKILL.md (触发时) - ~1500 tokens/skill
 * - Level 3: Resources (按需) - 0 tokens (脚本输出)
 *
 * Token optimization strategy:
 * - Startup: Only inject metadata for all enabled skills
 * - On demand: Load full content when skill is mentioned/triggered
 * - Resources: Execute scripts and inject output, not code
 */

import {
  Skill,
  SkillLoadLevel,
  SkillContextResult,
  SkillError,
  SkillErrorCode,
} from './skill-types.js';
import { SkillLoader } from './skill-loader.js';
import { SettingsManager } from './settings-manager.js';

/**
 * Context 注入选项
 */
interface ContextInjectionOptions {
  /** 是否包含完整的 markdown 内容 */
  includeFullContent?: boolean;
  /** 是否包含脚本和资源 */
  includeResources?: boolean;
  /** 最大 token 数限制 */
  maxTokens?: number;
  /** 是否包含统计信息 */
  includeStats?: boolean;
}

/**
 * SkillContextInjector - AI Context 管理器
 *
 * 职责:
 * 1. 三级加载策略管理
 * 2. 格式化 Skills 为 AI Context 字符串
 * 3. Token 成本估算和优化
 * 4. 按需加载完整 SKILL.md
 * 5. 脚本执行和输出注入
 */
export class SkillContextInjector {
  constructor(
    private skillLoader: SkillLoader,
    private settingsManager: SettingsManager,
  ) {}

  // ============================================================================
  // Level 1: 启动时注入元数据
  // ============================================================================

  /**
   * 注入启动时的 Skills Context（元数据 + 脚本列表）
   *
   * 策略: 启动时加载元数据和脚本列表（不含脚本代码），最小化 Token 成本
   * 平均成本: ~150 tokens/skill (元数据 ~100 + 脚本列表 ~50)
   *
   * 关键优化：
   * - 只加载脚本文件名，不加载脚本内容（0 tokens for script code）
   * - 明确告诉 AI 使用现成脚本而不是自己写代码
   * - 提供"按需加载详细指令"的机制
   */
  async injectStartupContext(): Promise<SkillContextResult> {
    try {
      // 加载所有已启用的 Skills（包含资源信息，但不加载脚本内容）
      const skills = await this.skillLoader.loadEnabledSkills(SkillLoadLevel.RESOURCES);

      // 格式化为 Context 字符串
      const context = this.formatMetadataContext(skills);

      // 估算 token 数
      const estimatedTokens = this.estimateTokens(context);

      return {
        context,
        estimatedTokens,
        skillCount: skills.length,
        levelStats: {
          metadata: skills.length,
          full: 0,
          resources: skills.length, // 包含资源列表，但不含脚本代码
        },
      };
    } catch (error) {
      throw new SkillError(
        `Failed to inject startup context: ${error instanceof Error ? error.message : String(error)}`,
        SkillErrorCode.SKILL_LOAD_FAILED,
        { originalError: error },
      );
    }
  }

  /**
   * 格式化元数据 Context
   *
   * 输出 XML 格式的 skills 列表，类似 Claude Code
   */
  private formatMetadataContext(skills: Skill[]): string {
    if (skills.length === 0) {
      return '<available_skills>\n(No skills installed)\n</available_skills>';
    }

    const lines: string[] = [
      '<available_skills>',
    ];

    // 为每个 skill 生成 XML 格式
    for (const skill of skills) {
      lines.push('<skill>');
      lines.push('<name>');
      lines.push(skill.id); // 使用完整 ID，如 "plugin-name:skill-name"
      lines.push('</name>');

      // 添加类型信息
      if (skill.type) {
        lines.push('<type>');
        lines.push(skill.type);
        lines.push('</type>');
      }

      lines.push('<description>');

      // 构建描述，包含脚本信息
      let description = skill.description;

      // 如果有脚本，在描述中强调
      if (skill.scripts && skill.scripts.length > 0) {
        const scriptNames = skill.scripts.map(s => s.name).join(', ');
        description += ` 📜 **Has executable scripts: ${scriptNames}**. You MUST use the use_skill tool to load instructions before executing any scripts. DO NOT write new code if scripts are available.`;
      }

      // 添加插件信息
      const pluginInfo = skill.id.split(':')[0];
      description += ` (plugin:${pluginInfo})`;

      lines.push(description);
      lines.push('</description>');
      lines.push('<location>');
      lines.push('plugin'); // 可以根据实际情况设置为 'local', 'plugin', 'marketplace'
      lines.push('</location>');

      // 如果有脚本，添加额外的脚本信息标签
      if (skill.scripts && skill.scripts.length > 0) {
        lines.push('<has_scripts>');
        lines.push('true');
        lines.push('</has_scripts>');
        lines.push('<scripts>');
        for (const script of skill.scripts) {
          lines.push(`  <script>${script.name}</script>`);
        }
        lines.push('</scripts>');
      }

      lines.push('</skill>');
    }

    lines.push('</available_skills>');

    return lines.join('\n');
  }

  // ============================================================================
  // Level 2: 按需加载完整内容
  // ============================================================================

  /**
   * 加载并注入完整的 SKILL.md 内容
   *
   * 策略: 当 AI 提到或需要使用某个 Skill 时，加载其完整内容
   * 平均成本: ~1500 tokens/skill
   */
  async loadSkillLevel2(skillId: string): Promise<string> {
    try {
      // 加载 Skill（Level 2: 完整内容）
      const skill = await this.skillLoader.loadSkill(skillId, SkillLoadLevel.FULL);

      if (!skill) {
        throw new SkillError(
          `Skill ${skillId} not found`,
          SkillErrorCode.SKILL_NOT_FOUND,
        );
      }

      // 格式化完整内容
      return this.formatFullContent(skill);
    } catch (error) {
      throw new SkillError(
        `Failed to load skill level 2: ${error instanceof Error ? error.message : String(error)}`,
        SkillErrorCode.SKILL_LOAD_FAILED,
        { skillId, originalError: error },
      );
    }
  }

  /**
   * 格式化完整的 SKILL.md 内容
   *
   * 包含：
   * - Skill 元数据
   * - 完整的 markdown 指令
   * - **可用脚本清单和使用示例**
   * - 参考文档列表
   */
  private formatFullContent(skill: Skill): string {
    const lines: string[] = [
      `# Skill: ${skill.name}`,
      '',
      `**Description**: ${skill.description}`,
      '',
    ];

    // 添加元数据
    if (skill.metadata.license) {
      lines.push(`**License**: ${skill.metadata.license}`);
      lines.push('');
    }

    if (skill.metadata.allowedTools && skill.metadata.allowedTools.length > 0) {
      lines.push(`**Allowed Tools**: ${skill.metadata.allowedTools.join(', ')}`);
      lines.push('');
    }

    if (skill.metadata.dependencies && skill.metadata.dependencies.length > 0) {
      lines.push(`**Dependencies**: ${skill.metadata.dependencies.join(', ')}`);
      lines.push('');
    }

    // ========================================================================
    // 🔥 关键部分：脚本使用指南
    // ========================================================================
    if (skill.scripts && skill.scripts.length > 0) {
      lines.push('## 📜 Available Scripts');
      lines.push('');
      lines.push('**⚠️  IMPORTANT: Use these ready-made scripts instead of writing new code.**');
      lines.push('');
      lines.push('These scripts are tested, optimized, and designed for this skill.');
      lines.push('Using them saves tokens (script code is not loaded into context).');
      lines.push('');

      for (const script of skill.scripts) {
        lines.push(`### ${script.name}`);
        if (script.description) {
          lines.push(`${script.description}`);
        }
        lines.push('');

        // 显示脚本类型和路径
        lines.push(`**Type**: ${script.type}`);
        lines.push(`**Path**: \`${script.path}\``);
        lines.push('');

        // 提供使用示例
        const executor = script.type === 'python' ? 'python3' : script.type === 'node' ? 'node' : 'bash';
        lines.push('**Usage Example**:');
        lines.push('```bash');
        lines.push(`${executor} "${script.path}" <args>`);
        lines.push('```');
        lines.push('');

        // 强调使用 run_shell_command
        lines.push('**To execute**: Use the `run_shell_command` tool with the above command.');
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }

    // 添加完整的 Markdown 内容
    if (skill.content) {
      lines.push('## Instructions');
      lines.push('');
      lines.push(skill.content);
      lines.push('');
    }

    // 添加参考文档信息
    if (skill.references && skill.references.length > 0) {
      lines.push('## 📚 Reference Documents');
      lines.push('');
      lines.push('Additional reference documents are available:');
      lines.push('');

      for (const ref of skill.references) {
        const refName = ref.split('/').pop() || ref;
        lines.push(`- \`${refName}\``);
      }

      lines.push('');
      lines.push('*Note: These documents contain additional details. Request them if needed.*');
      lines.push('');
    }

    return lines.join('\n');
  }

  // ============================================================================
  // Level 3: 资源和脚本（按需）
  // ============================================================================

  /**
   * 加载 Skill 资源和脚本
   *
   * 策略:
   * - 脚本代码本身 0 tokens（不注入）
   * - 仅注入脚本执行输出
   * - 引用文档按需加载
   *
   * 平均成本: ~300 tokens（仅输出）
   */
  async loadSkillLevel3(skillId: string): Promise<string> {
    try {
      // 加载 Skill（Level 3: 包含资源）
      const skill = await this.skillLoader.loadSkill(skillId, SkillLoadLevel.RESOURCES);

      if (!skill) {
        throw new SkillError(
          `Skill ${skillId} not found`,
          SkillErrorCode.SKILL_NOT_FOUND,
        );
      }

      // 格式化资源信息
      return this.formatResourcesInfo(skill);
    } catch (error) {
      throw new SkillError(
        `Failed to load skill level 3: ${error instanceof Error ? error.message : String(error)}`,
        SkillErrorCode.SKILL_LOAD_FAILED,
        { skillId, originalError: error },
      );
    }
  }

  /**
   * 格式化资源信息
   */
  private formatResourcesInfo(skill: Skill): string {
    const lines: string[] = [
      `# Skill Resources: ${skill.name}`,
      '',
    ];

    // 脚本信息（不包含代码，仅列出可用脚本）
    if (skill.scripts && skill.scripts.length > 0) {
      lines.push('## Available Scripts');
      lines.push('');
      lines.push('The following scripts are available for this skill:');
      lines.push('');

      for (const script of skill.scripts) {
        lines.push(`- **${script.name}** (${script.type})`);
        if (script.description) {
          lines.push(`  - ${script.description}`);
        }
      }

      lines.push('');
      lines.push('*Note: Script code is not included to save tokens. Execute scripts to get output.*');
      lines.push('');
    }

    // 引用文档
    if (skill.references && skill.references.length > 0) {
      lines.push('## Reference Documents');
      lines.push('');
      lines.push('Additional reference documents are available:');
      lines.push('');

      for (const ref of skill.references) {
        const refName = ref.split('/').pop() || ref;
        lines.push(`- ${refName}`);
      }

      lines.push('');
    }

    // License 信息
    if (skill.licensePath) {
      lines.push('## License');
      lines.push('');
      lines.push(`License file available at: ${skill.licensePath}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  // ============================================================================
  // 自定义 Context 注入
  // ============================================================================

  /**
   * 注入自定义 Skills Context
   */
  async injectSkillsContext(options: ContextInjectionOptions = {}): Promise<SkillContextResult> {
    try {
      const {
        includeFullContent = false,
        includeResources = false,
        maxTokens,
        includeStats = false,
      } = options;

      // 确定加载级别
      let loadLevel = SkillLoadLevel.METADATA;
      if (includeResources) {
        loadLevel = SkillLoadLevel.RESOURCES;
      } else if (includeFullContent) {
        loadLevel = SkillLoadLevel.FULL;
      }

      // 加载 Skills
      const skills = await this.skillLoader.loadEnabledSkills(loadLevel);

      // 格式化 Context
      let context = '';
      if (loadLevel === SkillLoadLevel.METADATA) {
        context = this.formatMetadataContext(skills);
      } else {
        // 完整内容或资源
        const sections: string[] = [];
        for (const skill of skills) {
          if (loadLevel === SkillLoadLevel.FULL) {
            sections.push(this.formatFullContent(skill));
          } else {
            sections.push(this.formatFullContent(skill));
            sections.push(this.formatResourcesInfo(skill));
          }
        }
        context = sections.join('\n\n---\n\n');
      }

      // 估算 tokens
      const estimatedTokens = this.estimateTokens(context);

      // 检查是否超过限制
      if (maxTokens && estimatedTokens > maxTokens) {
        console.warn(
          `Warning: Context exceeds max tokens (${estimatedTokens} > ${maxTokens})`,
        );
      }

      // 统计信息
      const levelStats = {
        metadata: loadLevel === SkillLoadLevel.METADATA ? skills.length : 0,
        full: loadLevel === SkillLoadLevel.FULL ? skills.length : 0,
        resources: loadLevel === SkillLoadLevel.RESOURCES ? skills.length : 0,
      };

      // 添加统计信息（如果需要）
      if (includeStats) {
        context += `\n\n---\n\n**Skills Statistics**:\n- Total Skills: ${skills.length}\n- Estimated Tokens: ${estimatedTokens}`;
      }

      return {
        context,
        estimatedTokens,
        skillCount: skills.length,
        levelStats,
      };
    } catch (error) {
      throw new SkillError(
        `Failed to inject skills context: ${error instanceof Error ? error.message : String(error)}`,
        SkillErrorCode.SKILL_LOAD_FAILED,
        { originalError: error },
      );
    }
  }

  // ============================================================================
  // 工具方法
  // ============================================================================

  /**
   * 按 Marketplace 和 Plugin 分组 Skills
   */
  private groupSkillsByMarketplaceAndPlugin(
    skills: Skill[],
  ): Map<string, Map<string, Skill[]>> {
    const grouped = new Map<string, Map<string, Skill[]>>();

    for (const skill of skills) {
      let marketplaceGroup = grouped.get(skill.marketplaceId);
      if (!marketplaceGroup) {
        marketplaceGroup = new Map<string, Skill[]>();
        grouped.set(skill.marketplaceId, marketplaceGroup);
      }

      let pluginGroup = marketplaceGroup.get(skill.pluginId);
      if (!pluginGroup) {
        pluginGroup = [];
        marketplaceGroup.set(skill.pluginId, pluginGroup);
      }

      pluginGroup.push(skill);
    }

    return grouped;
  }

  /**
   * 估算文本的 token 数
   *
   * 简单估算: 1 token ≈ 4 字符（英文）或 1.5 字符（中文）
   * 实际应该使用 tokenizer，这里仅作估算
   */
  private estimateTokens(text: string): number {
    // 简单估算：平均每个 token 4 个字符
    return Math.ceil(text.length / 4);
  }

  /**
   * 格式化 Context 字符串
   */
  async formatContextString(skills: Skill[]): Promise<string> {
    return this.formatMetadataContext(skills);
  }
}

/**
 * 单例实例（需要在使用时注入依赖）
 */
export const skillContextInjector = new SkillContextInjector(
  {} as SkillLoader,
  {} as SettingsManager,
);
