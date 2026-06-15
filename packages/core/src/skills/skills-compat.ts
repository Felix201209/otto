/**
 * Skills Compatibility Layer
 *
 * Provides backward-compatible interface for migrating from SkillsContextBuilder to SkillLoader.
 * This adapter converts the new SkillLoader data model to the legacy SkillInfo format.
 *
 * @deprecated This is a temporary compatibility layer. Direct usage of SkillLoader is preferred.
 */

import { SkillLoader } from './skill-loader.js';
import { SettingsManager } from './settings-manager.js';
import { MarketplaceManager } from './marketplace-manager.js';
import { SkillLoadLevel } from './skill-types.js';
import type { Skill, SkillInfo, SkillsContext } from './skill-types.js';

/**
 * Adapter class that wraps SkillLoader with SkillsContextBuilder-compatible interface
 */
export class SkillsCompatAdapter {
  private loader: SkillLoader;
  private settings: SettingsManager;
  private marketplace: MarketplaceManager;
  private initialized = false;
  private projectRoot?: string;

  constructor(projectRoot?: string) {
    // Store projectRoot and pass it to SkillLoader for accurate project skills discovery
    // Falls back to process.cwd() if not provided (same behavior as SkillsContextBuilder)
    this.projectRoot = projectRoot;
    this.settings = new SettingsManager();
    this.marketplace = new MarketplaceManager(this.settings);
    this.loader = new SkillLoader(this.settings, this.marketplace, undefined, projectRoot);
  }

  /**
   * Initialize the skills system (async)
   * Must be called before using other methods
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.settings.initialize();
    this.initialized = true;
  }

  /**
   * List all available skills
   * Compatible with SkillsContextBuilder.listSkills()
   */
  async listSkills(): Promise<SkillInfo[]> {
    await this.initialize();

    try {
      // Load skills with METADATA level (lightweight)
      const skills = await this.loader.loadEnabledSkills(SkillLoadLevel.METADATA);

      // Convert to legacy SkillInfo format (using arrow function to preserve 'this' binding)
      return skills.map((skill) => this.convertSkillToSkillInfo(skill));
    } catch (error) {
      console.warn('[SkillsCompatAdapter] Failed to load skills:', error);
      return [];
    }
  }

  /**
   * Load raw Skill objects (for internal use, preserves all metadata)
   */
  private async loadRawSkills(): Promise<Skill[]> {
    await this.initialize();
    return await this.loader.loadEnabledSkills(SkillLoadLevel.METADATA);
  }

  /**
   * Get details for a specific skill
   * Compatible with SkillsContextBuilder.getSkillDetails()
   */
  async getSkillDetails(skillId: string): Promise<SkillInfo | null> {
    await this.initialize();

    try {
      // Load skill with METADATA level
      const skill = await this.loader.loadSkill(skillId, SkillLoadLevel.METADATA);

      if (!skill) {
        return null;
      }

      return this.convertSkillToSkillInfo(skill);
    } catch (error) {
      console.warn(`[SkillsCompatAdapter] Failed to get skill details for ${skillId}:`, error);
      return null;
    }
  }

  /**
   * Build complete skills context for AI
   * Compatible with SkillsContextBuilder.buildContext()
   */
  async buildContext(): Promise<SkillsContext> {
    await this.initialize();

    try {
      const skills = await this.listSkills();

      if (skills.length === 0) {
        return {
          available: false,
          skills: [],
          summary: 'No skills are currently installed.',
        };
      }

      const summary = await this.generateSummary(skills);

      return {
        available: true,
        skills,
        summary,
      };
    } catch (error) {
      console.error('[SkillsCompatAdapter] Error building skills context:', error);
      return {
        available: false,
        skills: [],
        summary: 'Failed to load skills information.',
      };
    }
  }

  /**
   * Convert Skill to SkillInfo (legacy format)
   */
  private convertSkillToSkillInfo(skill: Skill): SkillInfo {
    return {
      id: skill.id,
      name: skill.name,
      pluginId: skill.pluginId,
      marketplaceId: skill.marketplaceId,
      description: skill.description,
      path: skill.path,
      // 同时填充两个字段以保持向后兼容性
      skillMdPath: skill.skillFilePath,      // 保持兼容
      skillFilePath: skill.skillFilePath,    // 新字段
      enabled: skill.enabled,
    };
  }

  /**
   * Generate summary text for AI context
   * Preserves the original SkillsContextBuilder formatting logic
   */
  private async generateSummary(skills: SkillInfo[]): Promise<string> {
    // Load raw skills to access location metadata for proper grouping
    const rawSkills = await this.loadRawSkills();
    return this.generateSummaryFromRawSkills(rawSkills);
  }

  /**
   * Generate summary from raw Skill objects (with full metadata)
   */
  private generateSummaryFromRawSkills(rawSkills: Skill[]): string {
    const lines: string[] = [
      '# 📦 Available Skills',
      '',
      '🚨 **CRITICAL REQUIREMENT - READ THIS CAREFULLY** 🚨',
      '',
      'You have access to pre-installed skills. When a user requests functionality covered by these skills, you MUST follow this exact workflow:',
      '',
      '## Mandatory Workflow:',
      '',
      '1. ✅ **FIRST: Read the COMPLETE skill.md file**',
      '   - Use `read_file` to read the skill\'s `skill.md` file',
      '   - **CRITICAL**: Read the ENTIRE file from start to finish',
      '   - **NEVER set any range limits (offset/limit) when reading skill.md**',
      '   - The skill.md contains essential instructions, workflows, and script usage details',
      '   - Example: `read_file(path="/path/to/skill/skill.md")` - NO offset, NO limit',
      '',
      '2. ✅ **SECOND: Follow EXACT instructions from skill.md**',
      '   - Execute the scripts specified in skill.md',
      '   - Use the exact commands and parameters documented',
      '   - Follow the workflow steps in the order specified',
      '   - Pay attention to "MANDATORY", "CRITICAL", and "IMPORTANT" sections',
      '',
      '3. ❌ **FORBIDDEN: Do NOT write your own implementation**',
      '   - DO NOT create new scripts when a skill provides them',
      '   - DO NOT use alternative libraries or tools',
      '   - DO NOT skip reading the skill.md file',
      '   - DO NOT assume you know how to use the skill without reading documentation',
      '',
      '## Why This Matters:',
      '',
      '- Skills contain **pre-tested, production-ready scripts** that handle edge cases',
      '- skill.md files often contain **critical warnings and requirements** (300-500+ lines)',
      '- Skipping documentation leads to **incorrect implementations** and wasted effort',
      '- Users expect you to use **existing tools correctly**, not reinvent them',
      '',
      '## Installed Skills:',
      '',
    ];

    // 转换为 SkillInfo 以统一使用 skillMdPath 字段
    const skillInfos = rawSkills.map(skill => this.convertSkillToSkillInfo(skill));

    // Group skills by source/plugin (使用原始 Skill 对象的 location 信息进行分组)
    const userGlobalSkills: SkillInfo[] = [];
    const projectSkills: SkillInfo[] = [];
    const marketplaceSkillsByPlugin = new Map<string, SkillInfo[]>();

    for (let i = 0; i < rawSkills.length; i++) {
      const skill = rawSkills[i];
      const skillInfo = skillInfos[i];

      // 优先使用 location.type（最可靠），其次使用 marketplaceId 和 ID 前缀
      const isUserGlobal = skill.location?.type === 'user_global' ||
                           skill.marketplaceId === 'user-global' ||
                           skill.id.startsWith('user:');
      const isUserProject = skill.location?.type === 'user_project' ||
                            skill.marketplaceId === 'user-project' ||
                            skill.id.startsWith('project:');

      if (isUserGlobal) {
        userGlobalSkills.push(skillInfo);
      } else if (isUserProject) {
        projectSkills.push(skillInfo);
      } else {
        if (!marketplaceSkillsByPlugin.has(skill.pluginId)) {
          marketplaceSkillsByPlugin.set(skill.pluginId, []);
        }
        marketplaceSkillsByPlugin.get(skill.pluginId)!.push(skillInfo);
      }
    }

    // Output user global skills
    if (userGlobalSkills.length > 0) {
      lines.push(`### User Global Skills (~/.deepv/skills/)`);
      lines.push(`*Custom skills installed globally for this user*`);
      lines.push('');

      for (const skill of userGlobalSkills) {
        lines.push(`- **${skill.name}** (ID: \`${skill.id}\`)`);
        lines.push(`  - 📍 **Skill Path**: \`${skill.path}\``);
        lines.push(`  - 📖 **Documentation**: \`${skill.skillMdPath}\``);
        lines.push(`  - 🔧 **Usage Instructions**:`);
        lines.push(`    1. Read the COMPLETE skill.md: \`read_file("${skill.skillMdPath}")\` (NO offset/limit!)`);
        lines.push(`    2. Follow ALL instructions, workflows, and requirements in skill.md`);
        lines.push(`    3. Execute the scripts specified in the documentation`);
        lines.push(`    4. DO NOT create your own implementation`);
        lines.push('');
      }
    }

    // Output project skills
    if (projectSkills.length > 0) {
      lines.push(`### Project Skills (.deepvcode/skills/)`);
      lines.push(`*Custom skills specific to this project*`);
      lines.push('');

      for (const skill of projectSkills) {
        lines.push(`- **${skill.name}** (ID: \`${skill.id}\`)`);
        lines.push(`  - 📍 **Skill Path**: \`${skill.path}\``);
        lines.push(`  - 📖 **Documentation**: \`${skill.skillMdPath}\``);
        lines.push(`  - 🔧 **Usage Instructions**:`);
        lines.push(`    1. Read the COMPLETE skill.md: \`read_file("${skill.skillMdPath}")\` (NO offset/limit!)`);
        lines.push(`    2. Follow ALL instructions, workflows, and requirements in skill.md`);
        lines.push(`    3. Execute the scripts specified in the documentation`);
        lines.push(`    4. DO NOT create your own implementation`);
        lines.push('');
      }
    }

    // Output marketplace/plugin skills
    for (const [pluginId, pluginSkills] of marketplaceSkillsByPlugin) {
      const firstSkill = pluginSkills[0];
      lines.push(`### ${pluginId}`);
      // Note: Using first skill's description as plugin section description
      // This matches the legacy SkillsContextBuilder behavior
      lines.push(`*${firstSkill.description}*`);
      lines.push('');

      for (const skill of pluginSkills) {
        lines.push(`- **${skill.name}** (ID: \`${skill.id}\`)`);
        lines.push(`  - 📍 **Skill Path**: \`${skill.path}\``);
        lines.push(`  - 📖 **Documentation**: \`${skill.skillMdPath}\``);
        lines.push(`  - 🔧 **Usage Instructions**:`);
        lines.push(`    1. Read the COMPLETE skill.md: \`read_file("${skill.skillMdPath}")\` (NO offset/limit!)`);
        lines.push(`    2. Follow ALL instructions, workflows, and requirements in skill.md`);
        lines.push(`    3. Execute the scripts specified in the documentation`);
        lines.push(`    4. DO NOT create your own implementation`);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
    lines.push('## 🎯 Example: Correct Workflow');
    lines.push('');
    lines.push('```');
    lines.push('User: "Create a PowerPoint presentation about AI"');
    lines.push('');
    lines.push('✅ CORRECT approach:');
    lines.push('1. AI sees "pptx" skill is available');
    lines.push('2. AI reads COMPLETE skill.md: read_file("~/.deepv/marketplace/skills/document-skills/pptx/skill.md")');
    lines.push('3. AI discovers the skill.md contains 300+ lines with detailed workflows');
    lines.push('4. AI reads sections marked "MANDATORY - READ ENTIRE FILE"');
    lines.push('5. AI follows the documented workflow (e.g., html2pptx method)');
    lines.push('6. AI uses the exact scripts specified in skill.md');
    lines.push('');
    lines.push('❌ WRONG approach:');
    lines.push('1. AI sees "pptx" skill exists');
    lines.push('2. AI assumes it knows how PowerPoint works');
    lines.push('3. AI writes custom Node.js script using pptxgenjs');
    lines.push('4. AI violates skill usage requirements');
    lines.push('```');
    lines.push('');
    lines.push('## ⚠️ Critical Reminders:');
    lines.push('');
    lines.push('- 📚 **Read skill.md COMPLETELY** - these files are 100-500+ lines with critical details');
    lines.push('- 🚫 **NEVER use offset/limit** when reading skill.md - you MUST read the entire file');
    lines.push('- ⚡ **Follow workflows exactly** - skills provide tested, production-ready solutions');
    lines.push('- 🔍 **Pay attention to warnings** - skill.md files contain "MANDATORY", "CRITICAL", "IMPORTANT" sections');
    lines.push('- 💡 **Use provided scripts** - do not reinvent what already exists and works');
    lines.push('- ❌ **Creating your own implementation when a skill exists is a violation of system rules**');

    return lines.join('\n');
  }
}
