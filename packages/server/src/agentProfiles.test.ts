/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENT_PROFILES,
  buildEnterpriseWorkspaceContext,
  resolveAgentProfile,
} from './agentProfiles.js';

const COMMON_EXPERT_IDS = [
  'ppt',
  'meeting',
  'doc',
  'sheet',
  'pdf',
  'dataviz',
  'research',
  'copy',
];

function allowedProfileIds(
  edition: 'personal' | 'enterprise',
  role: 'company_owner' | 'company_admin' | 'manager' | 'member',
): string[] {
  return BUILTIN_AGENT_PROFILES.filter((profile) => (
    !profile.legacyOnly
    && profile.id !== 'self-development'
    &&
    (profile.edition === 'both' || profile.edition === edition)
    && (!profile.roles || profile.roles.includes(role))
  )).map((profile) => profile.id);
}

function expectIdentityProfiles(
  actualIds: string[],
  foundationId: string,
): void {
  const expectedIds = [foundationId, ...COMMON_EXPERT_IDS];
  expect(actualIds).toHaveLength(9);
  expect(new Set(actualIds)).toEqual(new Set(expectedIds));
}

describe('服务端 Agent profile 白名单', () => {
  it('保留一个历史 CEO profile，但固定 9 个工作 Agent 全部属于企业版', () => {
    expect(BUILTIN_AGENT_PROFILES).toHaveLength(12);
    expect(BUILTIN_AGENT_PROFILES.filter((item) => item.scope === 'base')).toHaveLength(12);
    expect(BUILTIN_AGENT_PROFILES.filter((item) => item.scope === 'department')).toHaveLength(0);
    expect(resolveAgentProfile('otto-personal')).toMatchObject({ edition: 'personal' });
    expect(resolveAgentProfile('otto-enterprise-ceo')).toMatchObject({
      name: 'CEO Agent',
      edition: 'enterprise',
      roles: ['company_owner', 'company_admin'],
      legacyOnly: true,
    });
    expect(resolveAgentProfile('otto-enterprise-work')).toMatchObject({
      edition: 'enterprise',
      roles: ['company_owner', 'company_admin', 'manager', 'member'],
    });
    expect(resolveAgentProfile('self-development')).toMatchObject({
      name: '自主开发',
      edition: 'enterprise',
    });
    for (const id of COMMON_EXPERT_IDS) {
      expect(resolveAgentProfile(id)).toMatchObject({ scope: 'base', edition: 'enterprise' });
    }
  });

  it('个人只允许 Otto，四种企业角色都允许固定 9 个企业工作 Agent', () => {
    expect(allowedProfileIds('personal', 'member')).toEqual(['otto-personal']);
    expectIdentityProfiles(
      allowedProfileIds('enterprise', 'company_owner'),
      'otto-enterprise-work',
    );
    expectIdentityProfiles(
      allowedProfileIds('enterprise', 'company_admin'),
      'otto-enterprise-work',
    );
    expectIdentityProfiles(
      allowedProfileIds('enterprise', 'manager'),
      'otto-enterprise-work',
    );
    expectIdentityProfiles(
      allowedProfileIds('enterprise', 'member'),
      'otto-enterprise-work',
    );
  });

  it('A2A 使用不进入 9-Agent 目录的内部 tool-free profile', () => {
    expect(BUILTIN_AGENT_PROFILES.map((profile) => profile.id))
      .not.toContain('otto-enterprise-a2a');
    expect(resolveAgentProfile('otto-enterprise-a2a')).toMatchObject({
      edition: 'enterprise',
      toolFree: true,
      roles: ['company_owner', 'company_admin', 'manager', 'member'],
    });
    expect(resolveAgentProfile('otto-enterprise-a2a')?.systemPrompt).toContain(
      '发起方提案',
    );
    expect(resolveAgentProfile('otto-enterprise-a2a')?.systemPrompt).toContain(
      '接收方回答',
    );
  });

  it('三个基础身份使用独立白名单项并锁定 edition 与角色边界', () => {
    const personal = resolveAgentProfile('otto-personal');
    const ceo = resolveAgentProfile('otto-enterprise-ceo');
    const work = resolveAgentProfile('otto-enterprise-work');

    expect(personal).toMatchObject({
      id: 'otto-personal',
      name: 'Otto',
      scope: 'base',
      edition: 'personal',
    });
    expect(personal?.roles).toBeUndefined();
    expect(ceo).toMatchObject({
      id: 'otto-enterprise-ceo',
      name: 'CEO Agent',
      scope: 'base',
      edition: 'enterprise',
      roles: ['company_owner', 'company_admin'],
    });
    expect(work).toMatchObject({
      id: 'otto-enterprise-work',
      name: '企业工作 Agent',
      scope: 'base',
      edition: 'enterprise',
      roles: ['company_owner', 'company_admin', 'manager', 'member'],
    });
    expect(new Set([personal, ceo, work]).size).toBe(3);
  });

  it('中心认证工作区的运行时提示词使用可信组织和当前成员信息', () => {
    const prompt = buildEnterpriseWorkspaceContext({
      context: {
        edition: 'enterprise',
        role: 'member',
        userId: 'central-account-1',
        displayName: '林一',
        companyId: 'central-org-1',
        capabilities: [],
      },
      authenticatedOrganization: {
        id: 'central-org-1',
        name: '北辰中心企业',
      },
      managerWorkspace: {
        profile: { companyName: '本机错误企业' },
        organization: {
          departments: [
            { id: 'local-department', name: '本机错误部门' },
          ],
          positions: [{ id: 'local-position', title: '本机错误职位' }],
        },
      },
      members: [
        {
          userId: 'central-account-1',
          displayName: '林一',
          companyId: 'central-org-1',
          departmentName: '产品与研发部',
          positionTitle: '研发工程师',
          role: 'member',
        },
        {
          userId: 'central-account-2',
          username: 'zhou.er',
          displayName: '周二',
          companyId: 'central-org-1',
          departmentName: '销售部',
          positionTitle: '销售经理',
          role: 'member',
        },
      ],
    });

    expect(prompt).toContain('公司：北辰中心企业');
    expect(prompt).toContain('姓名：林一');
    expect(prompt).toContain('部门：产品与研发部');
    expect(prompt).toContain('职位：研发工程师');
    expect(prompt).toContain('角色：成员');
    expect(prompt).toContain('由中心企业服务认证');
    expect(prompt).not.toContain('由企业管理者在 Otto 中建档生成');
    expect(prompt).not.toContain('本机错误企业');
    expect(prompt).not.toContain('本机错误部门');
    expect(prompt).not.toContain('本机错误职位');
    expect(prompt).toContain('ID=central-account-2');
    expect(prompt).toContain('姓名=周二');
    expect(prompt).toContain('部门=销售部');
    expect(prompt).toContain('生成 Word、PDF、Markdown 或演示文稿');
    expect(prompt).toContain('禁止使用电脑登录用户名');
    expect(prompt).toContain('禁止传入、猜测或在 YAML 中填写作者身份');
    expect(prompt).toContain('Word 成品必须调用 generate_document');
    expect(prompt).toContain('缺少可信身份时省略署名');
    expect(prompt).toContain('职位=销售经理');
    expect(prompt).toContain('enterprise_collaboration');
    expect(prompt).toContain('必须先获得用户确认');
    expect(prompt).toContain('尊重对方的隐私授权范围');
    expect(prompt).toContain('当前私聊、企业知识、工作日志和日程四类');
    expect(prompt).toContain('不包括文件、API 密钥或其他聊天');
    expect(prompt).toContain('不得声称已经发送');
  });

  it('会议 Agent 使用 system prompt，未知或客户端自造 profile 不会被接受', () => {
    expect(resolveAgentProfile('meeting')).toMatchObject({
      name: '会议 Agent',
      skills: ['meeting-scheduler', 'meeting-notes'],
      embeddedSkills: ['meeting-scheduler', 'meeting-notes'],
      systemPrompt: expect.stringContaining('会议'),
    });
    expect(resolveAgentProfile('meeting')?.systemPrompt).toContain('纪要');
    expect(resolveAgentProfile('meeting')?.systemPrompt).toContain('audio_reader');
    expect(resolveAgentProfile('meeting')?.systemPrompt).toContain('不要因为文件大而停止');
    expect(resolveAgentProfile('meeting')?.systemPrompt).toContain('禁止要求普通用户手动执行 Python 包安装命令');
    expect(resolveAgentProfile('meeting')?.systemPrompt).not.toContain('pip install openai-whisper');
    expect(resolveAgentProfile('meeting-initiator')).toBeUndefined();
    expect(resolveAgentProfile('meeting-notes-followup')).toBeUndefined();
    expect(resolveAgentProfile('evil-client-prompt')).toBeUndefined();
  });

  it('解析独立自主开发入口，但不解析自动生成的额外 Agent profile', () => {
    expect(resolveAgentProfile('self-development')).toMatchObject({
      scope: 'base',
      edition: 'enterprise',
    });
    expect(resolveAgentProfile('auto-weekly-report')).toBeUndefined();
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

  it('基础 Otto 与 PDF/Excel 专家也会用选项式问题引导办公文档任务', () => {
    const basePrompt = resolveAgentProfile('otto-personal')?.systemPrompt ?? '';
    expect(basePrompt).toContain('办公文档傻瓜式引导');
    expect(basePrompt).toContain('PPT、Word、PDF、Excel');
    expect(basePrompt).toContain('ask_user_question');

    const workPrompt = resolveAgentProfile('otto-enterprise-work')?.systemPrompt ?? '';
    expect(workPrompt).toContain('办公文档傻瓜式引导');
    expect(workPrompt).toContain('Excel 至少询问');

    const sheetPrompt = resolveAgentProfile('sheet')?.systemPrompt ?? '';
    expect(sheetPrompt).toContain('ask_user_question');
    expect(sheetPrompt).toContain('任务类型');
    expect(sheetPrompt).toContain('数据清洗与汇总');
    expect(sheetPrompt).toContain('可编辑 XLSX');

    const pdfPrompt = resolveAgentProfile('pdf')?.systemPrompt ?? '';
    expect(pdfPrompt).toContain('ask_user_question');
    expect(pdfPrompt).toContain('操作类型');
    expect(pdfPrompt).toContain('生成排版 PDF');
    expect(pdfPrompt).toContain('PDF 成品');
  });

  it('Word/Excel/PDF 专家也强制注入内置 Skill 并拥有专属工作流', () => {
    const doc = resolveAgentProfile('doc');
    expect(doc?.embeddedSkills).toEqual(['doc-writer']);
    expect(doc?.systemPrompt).toContain('视觉母题');
    expect(doc?.systemPrompt).toContain('create_docx.py');
    expect(doc?.systemPrompt).toContain('generate_document');
    expect(doc?.systemPrompt).toContain('Otto 运行时注入');
    expect(doc?.systemPrompt).toContain('禁止直接运行脚本');
    expect(doc?.systemPrompt).toContain('禁止传入或猜测作者');
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

    const copy = resolveAgentProfile('copy');
    expect(copy?.embeddedSkills).toEqual(['copywriting']);
    expect(copy?.systemPrompt).toContain('ask_user_question');
    expect(copy?.systemPrompt).toContain('copywriting');
    expect(copy?.systemPrompt).toContain('CTA');

    const research = resolveAgentProfile('research');
    expect(research?.embeddedSkills).toEqual(['market-research']);
    expect(research?.systemPrompt).toContain('ask_user_question');
    expect(research?.systemPrompt).toContain('market-research');
    expect(research?.systemPrompt).toContain('SWOT');
  });

  it('每个专家目录入口都把声明的内置 Skill 强制注入运行时', () => {
    for (const id of COMMON_EXPERT_IDS) {
      const profile = resolveAgentProfile(id);
      expect(profile?.skills.length).toBeGreaterThan(0);
      expect(profile?.embeddedSkills).toEqual(profile?.skills);
    }
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
