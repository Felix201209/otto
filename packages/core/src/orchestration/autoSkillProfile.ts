/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * AutoSkill 专家孵化模块。
 *
 * 流程：
 * 1. Skill 被确认→写盘后，本模块接收 SKILL.md 内容
 * 2. 调用 LLM 生成专家身份（名称、简介、系统指令）
 * 3. 写入 ~/.otto-user/skills/<skill-name>/profile.json
 * 4. 下次加载智能体画廊时自动出现
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { Config } from '../config/config.js';
import { SceneType, SceneManager } from '../core/sceneManager.js';
import { getResponseText } from '../utils/partUtils.js';
import { resolveAutoSkillSkillsDir, resolveAutoSkillUserDir } from './autoSkillGenerator.js';

/** 自动化专家基础数据（存盘格式，不依赖桌面类型）。 */
export interface AutoSkillProfileData {
  id: string;
  name: string;
  tagline: string;
  scope: 'personal' | 'base';
  department: string | null;
  skills: string[];
  systemPrompt: string;
}

function profilePath(skillDir: string): string {
  return path.join(skillDir, 'profile.json');
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * 为一批 Skill 生成专家 Profile。
 * config 从全局注入（由 otto-server / CLI 侧在启动时调用 setAutoSkillConfig）。
 */
export async function generateProfilePipeline(
  skills: Array<{ skillName: string; skillDir: string; skillContent: string }>,
): Promise<void> {
  const config = getGlobalConfig();
  if (!config) {
    console.warn('[AutoSkillProfile] Config not injected, using template fallback');
    for (const s of skills) {
      await writeJsonAtomic(profilePath(s.skillDir), templateProfile(s.skillName, s.skillContent));
    }
    return;
  }

  for (const { skillName, skillDir, skillContent } of skills) {
    if (await fileExists(profilePath(skillDir))) continue; // Already has a profile
    try {
      const profile = await generateViaLLM(config, skillName, skillContent);
      await writeJsonAtomic(profilePath(skillDir), profile);
      console.log(`[AutoSkillProfile] Saved via LLM: ${profilePath(skillDir)}`);
    } catch (err) {
      console.warn(`[AutoSkillProfile] LLM failed for "${skillName}", template fallback:`, (err as Error)?.message ?? String(err));
      await writeJsonAtomic(profilePath(skillDir), templateProfile(skillName, skillContent));
    }
  }
}

/**
 * 调 LLM 从 SKILL.md 生成专家 Profile（JSON）。
 */
async function generateViaLLM(
  config: Config,
  skillName: string,
  skillContent: string,
): Promise<AutoSkillProfileData> {
  const client = config.getOttoClient();
  if (!client) throw new Error('LLM client unavailable');

  const prompt = [
    '你是一位 AI 产品设计师。为下面的 Skill 创建一个专家身份：',
    '',
    '## Skill 内容',
    skillContent.slice(0, 3000),
    '',
    '## 输出（JSON）',
    '- name: 专家名称，4-8字中文，概括核心价值',
    '- tagline: 15-25字简介',
    '- systemPrompt: 200-400字系统指令（角色、擅长、方法、注意事项、输出要求）',
    '',
    '```json',
    '{"name":"专家名称","tagline":"简介","systemPrompt":"系统指令..."}',
    '```',
    '只输出 JSON，用中文。',
  ].join('\n');

  const chat = await client.createTemporaryChat(
    SceneType.CHAT_CONVERSATION,
    SceneManager.getModelForScene(SceneType.CHAT_CONVERSATION),
    { type: 'sub', agentId: 'AutoProfileGenerator' },
    { emptySystemPrompt: true },
  );

  const response = await chat.sendMessage(
    { message: prompt, config: { maxOutputTokens: 4096 } },
    `profile-${skillName}-${Date.now()}`,
    SceneType.CHAT_CONVERSATION,
  );

  const text = getResponseText(response)?.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  if (!text) throw new Error('Empty LLM response');

  let parsed: { name?: string; tagline?: string; systemPrompt?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    const fb = text.indexOf('{'), lb = text.lastIndexOf('}');
    parsed = JSON.parse(text.slice(fb, lb + 1));
  }

  return {
    id: `auto-skill-${skillName}`,
    name: parsed.name || skillName,
    tagline: parsed.tagline || `自动孵化的专家: ${skillName}`,
    scope: 'personal',
    department: null,
    skills: [skillName],
    systemPrompt: parsed.systemPrompt || `你是专家"${skillName}"，按 Skill 流程完成任务。完成后输出汇总。`,
  };
}

/** 纯模板回退（不需要 LLM）。 */
function templateProfile(skillName: string, skillContent: string): AutoSkillProfileData {
  const firstHeading = skillContent.split('\n').find(l => l.startsWith('# ') && !l.startsWith('## '));
  const title = firstHeading?.replace(/^#\s*/, '').trim() || skillName;

  return {
    id: `auto-skill-${skillName}`,
    name: title,
    tagline: `自动孵化的专家: ${skillName}`,
    scope: 'personal',
    department: null,
    skills: [skillName],
    systemPrompt: `你是自动孵化的专家「${title}」。\n\n核心流程:\n\n${skillContent.slice(0, 1500)}\n\n完成后输出简短汇总。`,
  };
}

// ── 全局 Config 注入 ──
let globalConfig: Config | null = null;
export function setAutoSkillConfigForProfile(config: Config): void { globalConfig = config; }
function getGlobalConfig(): Config | null { return globalConfig; }

// ── 加载所有自动专家 ──
/** 扫描所有 Skill 目录中的 profile.json，返回专家列表。 */
export function loadAutoGeneratedProfiles(): AutoSkillProfileData[] {
  const skillsDir = resolveAutoSkillSkillsDir();
  const result: AutoSkillProfileData[] = [];
  try {
    const fsSync = require('fs') as typeof import('fs');
    if (!fsSync.existsSync(skillsDir)) return result;
    for (const dirName of fsSync.readdirSync(skillsDir)) {
      try {
        const pp = path.join(skillsDir, dirName, 'profile.json');
        if (!fsSync.existsSync(pp)) continue;
        const data = JSON.parse(fsSync.readFileSync(pp, 'utf8')) as Partial<AutoSkillProfileData>;
        if (data.id && data.name && data.systemPrompt) {
          result.push({
            id: data.id,
            name: data.name,
            tagline: data.tagline || '',
            scope: data.scope || 'personal',
            department: data.department || null,
            skills: Array.isArray(data.skills) ? data.skills : [],
            systemPrompt: data.systemPrompt,
          });
        }
      } catch { /* skip corrupt */ }
    }
  } catch { /* skip if dir missing */ }
  return result;
}

async function fileExists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}
