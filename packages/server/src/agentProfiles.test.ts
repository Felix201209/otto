/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_PROFILES, resolveAgentProfile } from './agentProfiles.js';

describe('服务端 Agent profile 白名单', () => {
  it('覆盖个人 Otto、企业助手、会议 Agent、8 位通用专家和六部门各 4 个 profile', () => {
    expect(BUILTIN_AGENT_PROFILES).toHaveLength(38);
    expect(BUILTIN_AGENT_PROFILES.filter((item) => item.scope === 'base')).toHaveLength(14);
    expect(BUILTIN_AGENT_PROFILES.filter((item) => item.scope === 'department')).toHaveLength(24);
    expect(resolveAgentProfile('otto-personal')).toMatchObject({ edition: 'personal' });
    expect(resolveAgentProfile('otto-enterprise-ceo')).toMatchObject({
      name: 'CEO Agent', edition: 'enterprise', roles: ['company_owner', 'company_admin'],
    });
    expect(resolveAgentProfile('otto-enterprise-work')).toMatchObject({ edition: 'enterprise' });
    expect(resolveAgentProfile('self-development')).toMatchObject({
      edition: 'both',
      name: '企业AI自主开发',
    });
    for (const id of ['ppt', 'meeting', 'doc', 'sheet', 'pdf', 'dataviz', 'research', 'copy']) {
      expect(resolveAgentProfile(id)).toMatchObject({ scope: 'base', edition: 'both' });
    }
  });

  it('会议 Agent 使用 system prompt，未知或客户端自造 profile 不会被接受', () => {
    expect(resolveAgentProfile('meeting-initiator')).toMatchObject({
      name: '会议发起 Agent',
      systemPrompt: expect.stringContaining('会议'),
    });
    expect(resolveAgentProfile('meeting-notes-followup')?.systemPrompt).toContain('纪要');
    expect(resolveAgentProfile('evil-client-prompt')).toBeUndefined();
  });

  it('PPT 专家强制先加载内置 Skill，并以 HTML 视觉渲染为主', () => {
    const profile = resolveAgentProfile('ppt');
    const prompt = profile?.systemPrompt ?? '';

    expect(prompt).toContain('HTML');
    expect(prompt).toContain('浏览器');
    expect(prompt).toContain('PptxGenJS');
    expect(prompt).toContain('python-pptx');
    expect(prompt).toContain('审美');
    expect(prompt).toContain('炫酷');
    expect(prompt).toContain('自定义 HTML/CSS/SVG');
    expect(prompt).toContain('固定模板');
    expect(profile?.embeddedSkills).toEqual(['ppt-creator']);
  });

  it('PPT/Word 专家会用选项式问题引导用户确定风格', () => {
    const pptPrompt = resolveAgentProfile('ppt')?.systemPrompt ?? '';
    expect(pptPrompt).toContain('ask_user_question');
    expect(pptPrompt).toContain('视觉风格');
    expect(pptPrompt).toContain('发布会高冲击');
    expect(pptPrompt).toContain('不要让用户打一大段需求');

    const docPrompt = resolveAgentProfile('doc')?.systemPrompt ?? '';
    expect(docPrompt).toContain('ask_user_question');
    expect(docPrompt).toContain('排版风格');
    expect(docPrompt).toContain('正式稳重');
    expect(docPrompt).toContain('不要让用户打一大段需求');
  });

  it('Word/Excel/PDF 专家也强制注入内置 Skill 并拥有专属工作流', () => {
    const doc = resolveAgentProfile('doc');
    expect(doc?.embeddedSkills).toEqual(['doc-writer']);
    expect(doc?.systemPrompt).toContain('视觉母题');
    expect(doc?.systemPrompt).toContain('create_docx.py');
    expect(doc?.systemPrompt).toContain('禁止');

    const sheet = resolveAgentProfile('sheet');
    expect(sheet?.embeddedSkills).toEqual(['spreadsheet-pro']);
    expect(sheet?.systemPrompt).toContain('视觉母题');
    expect(sheet?.systemPrompt).toContain('create_xlsx.py');
    expect(sheet?.systemPrompt).toContain('交替行条纹');
    expect(sheet?.systemPrompt).toContain('禁止');

    const pdf = resolveAgentProfile('pdf');
    expect(pdf?.embeddedSkills).toEqual(['pdf-toolkit']);
    expect(pdf?.systemPrompt).toContain('视觉母题');
    expect(pdf?.systemPrompt).toContain('create_pdf.py');
    expect(pdf?.systemPrompt).toContain('merge_pdf');
    expect(pdf?.systemPrompt).toContain('禁止');
  });

  it('每个专家都有对应身份的简短欢迎语', () => {
    for (const profile of BUILTIN_AGENT_PROFILES) {
      expect(profile.welcomeMessage).toContain('Hello，我是');
      expect(profile.welcomeMessage).toContain(profile.name);
      expect(profile.welcomeMessage).toContain('我可以帮你');
    }
    expect(resolveAgentProfile('ppt')?.welcomeMessage).toContain('高审美演示');
  });

  it('所有专家的系统提示都锁定当前身份及「你是谁」回答', () => {
    for (const profile of BUILTIN_AGENT_PROFILES) {
      expect(profile.systemPrompt).toContain(`你的当前身份是「${profile.name}」`);
      expect(profile.systemPrompt).toContain('用一句话回答');
      expect(profile.systemPrompt).toContain('不得自称为其他专家');
    }
  });
});
