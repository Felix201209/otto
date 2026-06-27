/**
 * SkillLoader Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { SkillLoader } from './skill-loader.js';
import { SettingsManager, SkillsPaths } from './settings-manager.js';
import { MarketplaceManager } from './marketplace-manager.js';
import { PluginInstaller } from './plugin-installer.js';
import { SkillLoadLevel } from './skill-types.js';

describe('SkillLoader', () => {
  let loader: SkillLoader;
  let settingsManager: SettingsManager;
  let marketplaceManager: MarketplaceManager;
  let pluginInstaller: PluginInstaller;
  let testRoot: string;
  let testMarketplacePath: string;

  beforeEach(async () => {
    // 创建临时测试目录
    testRoot = path.join(
      os.tmpdir(),
      `otto-test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    testMarketplacePath = path.join(testRoot, 'test-marketplace');

    // Mock SkillsPaths
    vi.spyOn(SkillsPaths, 'OTTO_HOME', 'get').mockReturnValue(testRoot);
    vi.spyOn(SkillsPaths, 'SKILLS_ROOT', 'get').mockReturnValue(
      path.join(testRoot, 'skills'),
    );
    vi.spyOn(SkillsPaths, 'MARKETPLACE_ROOT', 'get').mockReturnValue(
      path.join(testRoot, 'marketplace'),
    );
    vi.spyOn(SkillsPaths, 'SETTINGS_FILE', 'get').mockReturnValue(
      path.join(testRoot, 'skills', 'settings.json'),
    );
    vi.spyOn(SkillsPaths, 'INSTALLED_PLUGINS_FILE', 'get').mockReturnValue(
      path.join(testRoot, 'skills', 'installed_plugins.json'),
    );
    vi.spyOn(SkillsPaths, 'BACKUP_DIR', 'get').mockReturnValue(
      path.join(testRoot, 'skills', 'backups'),
    );

    settingsManager = new SettingsManager();
    await settingsManager.initialize();
    settingsManager.clearCache();

    marketplaceManager = new MarketplaceManager(settingsManager);
    pluginInstaller = new PluginInstaller(settingsManager, marketplaceManager);
    // Pass testRoot as projectRoot to isolate tests from actual project directory
    loader = new SkillLoader(settingsManager, marketplaceManager, undefined, testRoot);
  });

  afterEach(async () => {
    // 清理测试目录
    await fs.remove(testRoot);
    vi.restoreAllMocks();
  });

  /**
   * 创建测试用的 Marketplace 和 Plugin
   */
  async function createTestMarketplace() {
    await fs.ensureDir(testMarketplacePath);
    await fs.ensureDir(path.join(testMarketplacePath, '.claude-plugin'));
    await fs.ensureDir(path.join(testMarketplacePath, 'test-plugin', 'skill1'));
    await fs.ensureDir(path.join(testMarketplacePath, 'test-plugin', 'skill2'));

    const marketplaceJson = {
      name: 'test-marketplace',
      plugins: [
        {
          name: 'test-plugin',
          description: 'Test Plugin',
          source: './',
          strict: false,
          skills: ['./test-plugin/skill1', './test-plugin/skill2'],
        },
      ],
    };

    await fs.writeFile(
      path.join(testMarketplacePath, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(marketplaceJson, null, 2),
    );

    // 创建 SKILL.md 文件
    await fs.writeFile(
      path.join(testMarketplacePath, 'test-plugin', 'skill1', 'SKILL.md'),
      `---
name: skill1
description: Test Skill 1
license: MIT
allowedTools:
  - read_file
  - write_file
---

# Skill 1 Content

This is the full content of skill 1.
`,
    );

    await fs.writeFile(
      path.join(testMarketplacePath, 'test-plugin', 'skill2', 'SKILL.md'),
      `---
name: skill2
description: Test Skill 2
---

# Skill 2 Content
`,
    );

    // 添加脚本目录
    const scriptsPath = path.join(testMarketplacePath, 'test-plugin', 'skill1', 'scripts');
    await fs.ensureDir(scriptsPath);
    await fs.writeFile(path.join(scriptsPath, 'test.py'), 'print("Hello")');
    await fs.writeFile(path.join(scriptsPath, 'test.sh'), 'echo "Hello"');

    // 添加引用文档
    await fs.writeFile(
      path.join(testMarketplacePath, 'test-plugin', 'skill1', 'reference.md'),
      '# Reference',
    );

    // 添加 Marketplace 和 Plugin
    await marketplaceManager.addLocalMarketplace(testMarketplacePath, 'test-mp');
    await pluginInstaller.installPlugin('test-mp', 'test-plugin');
  }

  describe('loadEnabledSkills', () => {
    it('should load all enabled skills with metadata level', async () => {
      await createTestMarketplace();

      const skills = await loader.loadEnabledSkills(SkillLoadLevel.METADATA);

      expect(skills).toHaveLength(2);
      expect(skills[0].name).toBe('skill1');
      expect(skills[1].name).toBe('skill2');
      expect(skills[0].loadLevel).toBe(SkillLoadLevel.METADATA);
      expect(skills[0].content).toBeUndefined();
    });

    it('should load skills with full content', async () => {
      await createTestMarketplace();

      const skills = await loader.loadEnabledSkills(SkillLoadLevel.FULL);

      expect(skills).toHaveLength(2);
      expect(skills[0].content).toBeDefined();
      expect(skills[0].content).toContain('Skill 1 Content');
      expect(skills[0].loadLevel).toBe(SkillLoadLevel.FULL);
    });

    it('should load skills with resources', async () => {
      await createTestMarketplace();

      const skills = await loader.loadEnabledSkills(SkillLoadLevel.RESOURCES);

      expect(skills).toHaveLength(2);
      const skill1 = skills.find((s) => s.name === 'skill1');

      expect(skill1?.scripts).toBeDefined();
      expect(skill1?.scripts).toHaveLength(2);
      expect(skill1?.references).toBeDefined();
      expect(skill1?.references).toHaveLength(1);
      expect(skill1?.loadLevel).toBe(SkillLoadLevel.RESOURCES);
    });

    it('should return empty array if no plugins enabled', async () => {
      const skills = await loader.loadEnabledSkills();
      expect(skills).toHaveLength(0);
    });
  });

  describe('parseSkillFile', () => {
    it('should parse SKILL.md correctly', async () => {
      await createTestMarketplace();

      const skillPath = path.join(testMarketplacePath, 'test-plugin', 'skill1');
      const skill = await loader.parseSkillFile(
        skillPath,
        'test-mp:test-plugin',
        'test-mp',
        SkillLoadLevel.FULL,
      );

      expect(skill.name).toBe('skill1');
      expect(skill.description).toBe('Test Skill 1');
      expect(skill.metadata.license).toBe('MIT');
      expect(skill.metadata.allowedTools).toEqual(['read_file', 'write_file']);
      expect(skill.content).toContain('Skill 1 Content');
    });

    it('should throw error if SKILL.md not found', async () => {
      await createTestMarketplace();

      const skillPath = path.join(testMarketplacePath, 'non-existent');

      await expect(
        loader.parseSkillFile(skillPath, 'test-mp:test-plugin', 'test-mp'),
      ).rejects.toThrow('Skill file not found');
    });

    it('should validate required metadata fields', async () => {
      await createTestMarketplace();

      // 创建无效的 SKILL.md（缺少 description）
      const invalidSkillPath = path.join(
        testMarketplacePath,
        'test-plugin',
        'invalid-skill',
      );
      await fs.ensureDir(invalidSkillPath);
      await fs.writeFile(
        path.join(invalidSkillPath, 'SKILL.md'),
        `---
name: invalid
---

Content
`,
      );

      await expect(
        loader.parseSkillFile(invalidSkillPath, 'test-mp:test-plugin', 'test-mp'),
      ).rejects.toThrow('description');
    });

    it('should validate skill name format', async () => {
      await createTestMarketplace();

      // 创建无效名称的 SKILL.md
      const invalidSkillPath = path.join(
        testMarketplacePath,
        'test-plugin',
        'invalid-name-skill',
      );
      await fs.ensureDir(invalidSkillPath);
      await fs.writeFile(
        path.join(invalidSkillPath, 'SKILL.md'),
        `---
name: Invalid_Name
description: Test
---

Content
`,
      );

      await expect(
        loader.parseSkillFile(invalidSkillPath, 'test-mp:test-plugin', 'test-mp'),
      ).rejects.toThrow('must contain only lowercase letters');
    });
  });

  describe('loadSkill', () => {
    it('should load skill by id', async () => {
      await createTestMarketplace();

      const skill = await loader.loadSkill(
        'test-mp:test-plugin:skill1',
        SkillLoadLevel.FULL,
      );

      expect(skill).not.toBeNull();
      expect(skill?.name).toBe('skill1');
      expect(skill?.content).toBeDefined();
    });

    it('should return null for non-existent skill', async () => {
      await createTestMarketplace();

      const skill = await loader.loadSkill('test-mp:test-plugin:non-existent');

      expect(skill).toBeNull();
    });

    it('should use cache for repeated loads', async () => {
      await createTestMarketplace();

      const skill1 = await loader.loadSkill('test-mp:test-plugin:skill1');
      const skill2 = await loader.loadSkill('test-mp:test-plugin:skill1');

      expect(skill1).toBe(skill2); // 同一对象引用
    });
  });

  describe('searchSkills', () => {
    it('should search skills by name', async () => {
      await createTestMarketplace();

      const results = await loader.searchSkills('skill1');

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('skill1');
    });

    it('should search skills by description', async () => {
      await createTestMarketplace();

      const results = await loader.searchSkills('Test Skill 2');

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('skill2');
    });

    it('should return empty array for no matches', async () => {
      await createTestMarketplace();

      const results = await loader.searchSkills('non-existent');

      expect(results).toHaveLength(0);
    });
  });

  describe('getSkillsByMarketplace', () => {
    it('should group skills by marketplace', async () => {
      await createTestMarketplace();

      const grouped = await loader.getSkillsByMarketplace();

      expect(grouped.size).toBe(1);
      expect(grouped.get('test-mp')).toHaveLength(2);
    });
  });

  describe('getSkillsByPlugin', () => {
    it('should group skills by plugin', async () => {
      await createTestMarketplace();

      const grouped = await loader.getSkillsByPlugin();

      expect(grouped.size).toBe(1);
      expect(grouped.get('test-mp:test-plugin')).toHaveLength(2);
    });
  });

  describe('getSkillStats', () => {
    it('should return skill statistics', async () => {
      await createTestMarketplace();

      const stats = await loader.getSkillStats();

      expect(stats.total).toBe(2);
      expect(stats.byMarketplace['test-mp']).toBe(2);
      expect(stats.byPlugin['test-mp:test-plugin']).toBe(2);
    });

    it('should force reload settings when requested', async () => {
      await createTestMarketplace();

      // First call without force reload
      const stats1 = await loader.getSkillStats(false);
      expect(stats1.total).toBe(2);

      // Simulate external config change by directly modifying settings
      const settingsManager = (loader as any).settingsManager;
      const readSettingsSpy = vi.spyOn(settingsManager, 'readSettings');

      // Second call with force reload
      const stats2 = await loader.getSkillStats(true);

      // Verify readSettings was called with forceReload=true
      expect(readSettingsSpy).toHaveBeenCalledWith(true);
      expect(stats2.total).toBe(2);
    });
  });

  describe('cache management', () => {
    it('should cache skills', async () => {
      await createTestMarketplace();

      await loader.loadEnabledSkills();
      const stats = loader.getCacheStats();

      expect(stats.size).toBeGreaterThan(0);
      expect(stats.skills).toContain('test-mp:test-plugin:skill1');
    });

    it('should clear cache', async () => {
      await createTestMarketplace();

      await loader.loadEnabledSkills();
      loader.clearCache();

      const stats = loader.getCacheStats();
      expect(stats.size).toBe(0);
    });

    it('should clear specific skill cache', async () => {
      await createTestMarketplace();

      await loader.loadEnabledSkills();
      loader.clearSkillCache('test-mp:test-plugin:skill1');

      const stats = loader.getCacheStats();
      expect(stats.skills).not.toContain('test-mp:test-plugin:skill1');
    });
  });

  // ==========================================================================
  // 🎯 Regression: symlinked user-project skills must be discovered.
  //
  // Bug: `fs.readdir(root, { withFileTypes: true })` returns Dirent objects
  // whose `isDirectory()` method returns false for symlinks — even when
  // the link points at a real directory. The pre-fix scanner used that
  // method to filter entries, so `ln -s <repo> ~/.otto/skills/foo`
  // created a skill that silently failed to load.
  // ==========================================================================
  describe('symlink discovery', () => {
    it('discovers symlinked skill directories alongside real ones', async () => {
      // Project skill root (isolated by the `testRoot` wiring in beforeEach).
      const projectSkillsDir = path.join(testRoot, '.otto-user', 'skills');
      await fs.ensureDir(projectSkillsDir);

      // 1. A regular skill directory — the "happy path" baseline.
      const realSkillDir = path.join(projectSkillsDir, 'real-skill');
      await fs.ensureDir(realSkillDir);
      await fs.writeFile(
        path.join(realSkillDir, 'SKILL.md'),
        `---\nname: real-skill\ndescription: regular folder skill\nlicense: MIT\n---\n\nBody`,
      );

      // 2. A skill that lives elsewhere and is surfaced via a symlink
      //    — this is what users get on macOS when they `ln -s` a checkout
      //    into ~/.otto/skills/.
      const externalSkillDir = path.join(testRoot, 'external', 'external-skill');
      await fs.ensureDir(externalSkillDir);
      await fs.writeFile(
        path.join(externalSkillDir, 'SKILL.md'),
        `---\nname: external-skill\ndescription: symlinked skill\nlicense: MIT\n---\n\nBody`,
      );

      const linkPath = path.join(projectSkillsDir, 'external-skill');
      try {
        await fs.symlink(externalSkillDir, linkPath, 'dir');
      } catch (err: any) {
        // On Windows without Developer Mode / admin rights symlink creation
        // fails with EPERM; the bug can't be reproduced there, so skip.
        if (err.code === 'EPERM' || err.code === 'ENOSYS') return;
        throw err;
      }

      // Sanity: confirm the symlink looks like a file to Dirent (this is the
      // exact pitfall the fix addresses — if this ever stops being true,
      // Node's behavior changed and the helper can be simplified).
      const rawEntries = await fs.readdir(projectSkillsDir, {
        withFileTypes: true,
      });
      const linkEntry = rawEntries.find((e) => e.name === 'external-skill');
      expect(linkEntry?.isDirectory()).toBe(false);
      expect(linkEntry?.isSymbolicLink()).toBe(true);

      // Load and assert BOTH skills are discovered.
      const skills = await loader.loadEnabledSkills();
      const skillNames = skills.map((s) => s.metadata.name).sort();
      expect(skillNames).toContain('real-skill');
      expect(skillNames).toContain('external-skill');
    });
  });
});
