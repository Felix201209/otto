/**
 * Otto Skills System - Integration with Core
 *
 * Provides Skills context to the AI system prompt
 */

import { SkillContextInjector } from './index.js';
import { seedDefaultSkills } from './seed-skills.js';

let cachedSkillsContext: string | null = null;
let lastCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get Skills context for AI system prompt (synchronous)
 *
 * Returns cached context if available, empty string otherwise.
 * Call initializeSkillsContext() at startup to populate cache.
 */
export function getSkillsContext(): string {
  return cachedSkillsContext || '';
}

/**
 * Initialize Skills context asynchronously
 *
 * This should be called once at startup to load and cache
 * the Skills metadata for injection into the system prompt.
 *
 * @param projectRoot - 项目根目录路径（可选，默认为 process.cwd()）
 */
export async function initializeSkillsContext(projectRoot?: string): Promise<void> {
  // Check cache
  const now = Date.now();
  if (cachedSkillsContext && now - lastCacheTime < CACHE_TTL) {
    return; // Cache still valid
  }

  try {
    // 预置内置 skill 到 ~/.otto-user/skills/（幂等），保证开箱即有 skill 可被发现/加载。
    try {
      seedDefaultSkills();
    } catch {
      // 预置失败不影响后续（skills 系统本就可选）
    }

    // Create dependencies
    const { SettingsManager, MarketplaceManager, SkillLoader } = await import('./index.js');

    const settings = new SettingsManager();
    await settings.initialize();

    const marketplace = new MarketplaceManager(settings);
    // 传入 projectRoot 参数，确保 SkillLoader 使用正确的项目根目录
    const loader = new SkillLoader(settings, marketplace, undefined, projectRoot);
    const injector = new SkillContextInjector(loader, settings);

    const result = await injector.injectStartupContext();

    if (!result.context || result.context.trim().length === 0) {
      // No skills available
      cachedSkillsContext = '';
      lastCacheTime = now;
      return;
    }

    // Format for system prompt - minimal, since detailed instructions are in use_skill tool
    const formattedContext = `
# Available Skills

You have access to specialized Skills that provide domain knowledge, workflows, and executable scripts.

${result.context}

**Mandatory Skill Usage**:
If a skill's description says it MUST be used for the current task, you MUST call \`use_skill\` before doing any work.
When in doubt, prefer loading the skill first.

**Important**: Skills marked with 📜 or <has_scripts>true</has_scripts> have executable scripts.
You MUST use the \`use_skill\` tool to load their instructions before executing any scripts.
See the \`use_skill\` tool description for complete usage instructions.

**Token cost**: ~${result.estimatedTokens} tokens (metadata only, full instructions loaded on-demand)
`;

    cachedSkillsContext = formattedContext.trim();
    lastCacheTime = now;
  } catch (error) {
    // Silently fail - Skills system is optional
    console.warn('[Skills] Failed to load context:', error);
    cachedSkillsContext = '';
    lastCacheTime = now;
  }
}

/**
 * Clear the Skills context cache
 *
 * Call this when skills are installed/uninstalled/enabled/disabled
 */
export function clearSkillsContextCache(): void {
  cachedSkillsContext = null;
  lastCacheTime = 0;
}
