/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { getCoreSystemPrompt, isGemini3Model, formatCompactSummary } from './prompts.js';

describe('prompts', () => {
  describe('isGemini3Model', () => {
    it('should identify gemini-3 models correctly', () => {
      expect(isGemini3Model('gemini-3-flash-preview')).toBe(true);
      expect(isGemini3Model('gemini3-pro')).toBe(true);
      expect(isGemini3Model('gemini-2.0-flash')).toBe(false);
      expect(isGemini3Model(undefined)).toBe(false);
    });
  });

  describe('getCoreSystemPrompt - Environment Differences', () => {
    it('should include VSCode-specific instructions when isVSCode is true', () => {
      const prompt = getCoreSystemPrompt(undefined, true);
      expect(prompt).toContain('interactive VSCode assistant');
      // 验证是否包含 lint 检查的描述
      expect(prompt).toContain('read_lints');
    });

    it('should use CLI instructions when isVSCode is false', () => {
      const prompt = getCoreSystemPrompt(undefined, false);
      expect(prompt).toContain('interactive CLI tool');
    });

    it('should include Feishu-specific instructions when isFeishu is true', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'default', undefined, undefined, undefined, true);
      expect(prompt).toContain('Feishu/Lark Chat Gateway');
      expect(prompt).toContain('Mobile-Friendly Layout Guidelines');
      expect(prompt).toContain('Strict Guidelines for Sending Files & Media');
      expect(prompt).toContain('Prudence & Spam Prevention');
    });
  });

  describe('getCoreSystemPrompt - Model Differences', () => {
    it('should use Gemini 3 specific instructions for Gemini 3 models', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'default', 'gemini-3-flash');
      expect(prompt).toContain('strictly grounded to the information provided in context');
      expect(prompt).toContain('Context is Truth');
    });

    it('should use standard instructions for other models', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'default', 'gemini-1.5-pro');
      expect(prompt).not.toContain('Context is Truth');
    });
  });

  describe('getCoreSystemPrompt - Agent Style Differences', () => {
    it('should use Codex style prompt when requested', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'codex');
      expect(prompt).toContain('CODEX MODE');
      expect(prompt).toContain('NO NARRATION');
    });

    it('should use Cursor style prompt when requested', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'cursor');
      expect(prompt).toContain('CURSOR MODE');
      expect(prompt).toContain('STATUS UPDATES');
    });

    it('should use Windsurf style prompt when requested', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'windsurf');
      expect(prompt).toContain('WINDSURF MODE');
      expect(prompt).toContain('AI Flow');
    });
  });

  describe('getCoreSystemPrompt - Language Preference', () => {
    it('should append language preference at the end', () => {
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'default', undefined, '简体中文');
      // 检查加粗格式
      expect(prompt).toContain('**Language Preference:** Please always use "简体中文" to reply to the user.');
    });
  });

  describe('getCoreSystemPrompt - Custom Model Info', () => {
    it('should include custom model server info', () => {
      const customModel = {
        provider: 'openai',
        modelId: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1'
      };
      const prompt = getCoreSystemPrompt(undefined, false, undefined, 'default', undefined, undefined, customModel);
      // 检查 Markdown 行内代码格式
      expect(prompt).toContain('**Current Model:** `gpt-4o`');
      expect(prompt).toContain('served by user-configured endpoint `https://api.openai.com/v1`');
    });
  });

  describe('getCoreSystemPrompt - Skills Context Injection', () => {
    afterEach(async () => {
      // 恢复原始函数
      const skillsIntegration = await import('../skills/skills-integration.js');
      vi.mocked(skillsIntegration.getSkillsContext).mockRestore?.();
    });

    it('should include skills context when available', async () => {
      // Mock getSkillsContext to return sample skills
      const mockSkillsContext = `# Available Skills

<available_skills>
<skill>
<name>test-skill</name>
<description>A test skill for validation 📜</description>
</skill>
</available_skills>`;

      const skillsIntegration = await import('../skills/skills-integration.js');
      vi.spyOn(skillsIntegration, 'getSkillsContext').mockReturnValue(mockSkillsContext);

      const prompt = getCoreSystemPrompt(undefined, false);

      expect(prompt).toContain('# Available Skills');
      expect(prompt).toContain('<available_skills>');
      expect(prompt).toContain('test-skill');
    });

    it('should not add extra content when skills context is empty', async () => {
      const skillsIntegration = await import('../skills/skills-integration.js');
      vi.spyOn(skillsIntegration, 'getSkillsContext').mockReturnValue('');

      const prompt = getCoreSystemPrompt(undefined, false);

      // 不应该包含空的 Skills section
      expect(prompt).not.toContain('# Available Skills');
    });
  });

  describe('getCoreSystemPrompt - LLM Wiki Context Injection', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // 仅当探测到 .llm-wiki/index.md 时返回 true，其它路径透传真实结果
    function mockWikiPresent(present: boolean) {
      const actual = fs.existsSync.bind(fs);
      vi.spyOn(fs, 'existsSync').mockImplementation(((p: fs.PathLike) => {
        const s = String(p);
        if (s.includes('.llm-wiki') && s.includes('index.md')) {
          return present;
        }
        return actual(p);
      }) as typeof fs.existsSync);
    }

    // 提取 "# LLM Wiki" 段落本身，避免被整段 prompt 的其它文字干扰断言
    function extractWikiSection(prompt: string): string {
      const start = prompt.indexOf('# LLM Wiki');
      if (start < 0) return '';
      return prompt.slice(start);
    }

    it('should inject the LLM Wiki section when .llm-wiki/index.md exists', () => {
      mockWikiPresent(true);
      const prompt = getCoreSystemPrompt(undefined, false);
      expect(prompt).toContain('# LLM Wiki');
      expect(prompt).toContain('.llm-wiki/');
    });

    it('should NOT inject the LLM Wiki section when the wiki is absent', () => {
      mockWikiPresent(false);
      const prompt = getCoreSystemPrompt(undefined, false);
      expect(prompt).not.toContain('# LLM Wiki');
    });

    it('should proactively guide the AI to consult the wiki before exploring', () => {
      mockWikiPresent(true);
      const section = extractWikiSection(getCoreSystemPrompt(undefined, false));
      // 核心诉求：wiki 段落内必须出现"主动消费"语义，而非仅被动等待用户要求
      expect(section.toLowerCase()).toContain('consult');
      expect(section.toLowerCase()).toContain('before');
      // 必须明确建议优先查阅 index，而不是直接盲目搜索代码库
      expect(section).toContain('.llm-wiki/index.md');
      expect(section).toMatch(/consult[\s\S]*index\.md/i);
    });

    it('should still retain the wiki maintenance instructions', () => {
      mockWikiPresent(true);
      const section = extractWikiSection(getCoreSystemPrompt(undefined, false));
      // 不能丢失原有的写入/维护指引
      expect(section).toContain('save to wiki');
      expect(section).toContain('.llm-wiki/raw/');
      expect(section).toContain('/wiki');
    });

    it('should place the LLM Wiki section after the dynamic boundary (cache-safe)', () => {
      mockWikiPresent(true);
      const prompt = getCoreSystemPrompt(undefined, false);
      const boundaryIdx = prompt.indexOf('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
      const wikiIdx = prompt.indexOf('# LLM Wiki');
      expect(boundaryIdx).toBeGreaterThanOrEqual(0);
      expect(wikiIdx).toBeGreaterThan(boundaryIdx);
    });
  });

  describe('formatCompactSummary', () => {
    it('should extract content from <summary> tags', () => {
      const raw = '<analysis>Some analysis here...</analysis>\n<summary>\n<state_snapshot>Important content</state_snapshot>\n</summary>';
      const result = formatCompactSummary(raw);
      expect(result).toContain('<state_snapshot>Important content</state_snapshot>');
      expect(result).not.toContain('<analysis>');
    });

    it('should strip <analysis> tags when no <summary> tag exists', () => {
      const raw = '<analysis>Thinking process...</analysis>\n<state_snapshot>Direct content</state_snapshot>';
      const result = formatCompactSummary(raw);
      expect(result).toContain('<state_snapshot>Direct content</state_snapshot>');
      expect(result).not.toContain('<analysis>');
      expect(result).not.toContain('Thinking process');
    });

    it('should return original text when no tags present', () => {
      const raw = 'Plain text summary without any tags';
      const result = formatCompactSummary(raw);
      expect(result).toBe('Plain text summary without any tags');
    });

    it('should handle empty input', () => {
      expect(formatCompactSummary('')).toBe('');
      expect(formatCompactSummary('   ')).toBe('');
    });

    it('should handle multiple <analysis> blocks', () => {
      const raw = '<analysis>First analysis</analysis>\nMiddle text\n<analysis>Second analysis</analysis>\n<summary>Final result</summary>';
      const result = formatCompactSummary(raw);
      expect(result).toBe('Final result');
    });
  });
});
