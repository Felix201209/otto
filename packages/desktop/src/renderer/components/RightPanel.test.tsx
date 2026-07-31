/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ProductWorkspaceSnapshot } from 'otto-server';
import { RightPanel } from './RightPanel.js';
import { BASE_AGENT_PROFILES } from '../agents/departmentAgents.js';
import type { CustomAgentDefinition } from '../customAgents.js';
import { clearEnterpriseOrganizationFeaturesCache } from '../state/enterpriseOrganizationFeatures.js';

afterEach(() => {
  cleanup();
  clearEnterpriseOrganizationFeaturesCache();
  delete (window as unknown as { otto?: unknown }).otto;
});

interface TestWorkLogEntry {
  time: string;
  category: string;
  action: string;
  success: boolean;
  entryType: 'tool' | 'work_result';
  details?: string;
  taskTitle?: string;
}

interface TestWorkLogDay {
  date: string;
  entries: TestWorkLogEntry[];
}

function installBridge(
  recent: TestWorkLogDay[] | (() => Promise<TestWorkLogDay[]>) = [],
  knowledgeEnabled = false,
  skillMarketEnabled = true,
) {
  const openPath = vi.fn(async () => undefined);
  const saveTextFile = vi.fn(async () => '/tmp/edited-worklog.md');
  const selectFiles = vi.fn(async () => ['/tmp/enterprise-summary.md']);
  const readFilePath = vi.fn(async () => ({
    filePath: '/tmp/enterprise-summary.md',
    fileName: 'enterprise-summary.md',
    size: 24,
    mimeType: 'text/markdown',
    data: Buffer.from('# 企业总结\n\n初稿。', 'utf8').toString('base64'),
  }));
  const extractEditableDocument = vi.fn(async () => ({
    filePath: '/tmp/enterprise-summary.md',
    fileName: 'enterprise-summary.md',
    sourceFormat: 'markdown' as 'text' | 'markdown' | 'docx' | 'pdf',
    editableFormat: 'markdown' as const,
    content: '# 企业总结\n\n初稿。',
    readonly: false,
    message: '已读取文本文件。',
  }));
  const exportEditedDocument = vi.fn(async () => ({
    ok: true,
    path: '/tmp/enterprise-summary.edited.docx',
    format: 'docx' as const,
    message: '已保存编辑稿：enterprise-summary.edited.docx',
  }));
  const enterpriseKnowledgeList = vi.fn(async (): Promise<unknown[]> => []);
  const enterpriseKnowledgeRecord = vi.fn(async () => ({
    status: 'added' as const,
    added: true,
    reviewStatus: 'active' as const,
    knowledgeId: 1,
  }));
  const enterpriseKnowledgeReview = vi.fn(async () => ({}));
  const enterpriseKnowledgeRevise = vi.fn(async () => ({}));
  const enterpriseKnowledgeRevisions = vi.fn(async (): Promise<unknown[]> => []);
  const enterpriseOrganizationFeaturesGet = vi.fn(async () => ({
    enterprise_tree: true,
    park_service: true,
    feishu_auto_reply: true,
    direct_messages: true,
    atoa: true,
    knowledge: knowledgeEnabled,
    skill_market: skillMarketEnabled,
  }));
  const workLogReport = vi.fn(async () => ({
    ok: true,
    date: '2026-07-10',
    title: '市场竞品调研报告',
    markdown: '# 市场竞品调研报告\n\n已完成对比。',
    path: '/tmp/2026-07-10-市场竞品调研报告.md',
    message: '已生成并保存「市场竞品调研报告」',
  }));
  (window as unknown as { otto: unknown }).otto = {
    parkConfig: async () => null,
    workLogRecent: typeof recent === 'function' ? recent : async () => recent,
    workLogToday: async () => ({
      summary: '今天还没有工作记录。',
      date: '2026-07-10',
      totalActions: 0,
      workResults: 0,
    }),
    enterpriseKnowledgeList,
    enterpriseKnowledgeRecord,
    enterpriseKnowledgeReview,
    enterpriseKnowledgeRevise,
    enterpriseKnowledgeRevisions,
    enterpriseOrganizationFeaturesGet,
    workLogReport,
    openPath,
    saveTextFile,
    selectFiles,
    readFilePath,
    extractEditableDocument,
    exportEditedDocument,
  };
  return {
    openPath,
    saveTextFile,
    selectFiles,
    readFilePath,
    extractEditableDocument,
    exportEditedDocument,
    workLogReport,
    enterpriseKnowledgeList,
    enterpriseKnowledgeRecord,
    enterpriseKnowledgeReview,
    enterpriseKnowledgeRevise,
    enterpriseKnowledgeRevisions,
    enterpriseOrganizationFeaturesGet,
  };
}

function enterpriseWorkspace(): ProductWorkspaceSnapshot {
  return {
    schemaVersion: 1,
    context: {
      edition: 'enterprise',
      role: 'company_owner',
      userId: 'owner-1',
      displayName: 'Felix',
      companyId: 'company-1',
      capabilities: [
        'agent:base',
        'model:otto',
        'skill:built-in',
        'skill:auto-create',
        'organization:read',
        'organization:manage',
      ],
    },
    managerWorkspace: {
      profile: {
        managerId: 'owner-1',
        managerName: 'Felix',
        companyName: '宏创 AI',
        createdAt: '2026-07-10T00:00:00.000Z',
      },
      context: {
        edition: 'enterprise',
        role: 'company_owner',
        userId: 'owner-1',
        companyId: 'company-1',
        capabilities: [],
      },
      organization: {
        rootCompanyId: 'company-1',
        companies: [{ id: 'company-1', name: '宏创 AI', ownerUserId: 'owner-1' }],
        departments: [{ id: 'dept-1', companyId: 'company-1', name: 'CEO 办公室' }],
        positions: [{
          id: 'position-1',
          companyId: 'company-1',
          departmentId: 'dept-1',
          title: 'CEO',
          incumbentUserId: 'owner-1',
        }],
      },
    },
    members: [{
      userId: 'owner-1',
      displayName: 'Felix',
      companyId: 'company-1',
      departmentId: 'dept-1',
      positionId: 'position-1',
      role: 'company_owner',
    }],
    friends: [],
    credits: { balance: 0, frozen: 0, status: 'design-preview' },
  };
}

describe('RightPanel fixed Agent catalog', () => {
  it('在右边栏创建、保存并立即启动自定义智能体，不混入固定 9 Agent', async () => {
    installBridge();
    const create = vi.fn();
    const launch = vi.fn();
    const saved: CustomAgentDefinition = {
      id: 'custom-bid',
      name: '招投标助手',
      instructions: '整理标书要求并生成检查清单。',
      createdAt: '2026-07-20T16:00:00.000Z',
    };

    const { container } = render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="member"
        workspace={enterpriseWorkspace()}
        customAgents={[saved]}
        onCreateCustomAgent={create}
        onLaunchCustomAgent={launch}
      />,
    );

    expect(container.querySelectorAll('.otto-profile-card')).toHaveLength(9);
    fireEvent.click(screen.getByRole('button', { name: '创建智能体' }));
    expect(screen.getByRole('dialog', { name: '创建智能体' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('智能体名称'), {
      target: { value: '客户成功助手' },
    });
    fireEvent.change(screen.getByLabelText('职责说明'), {
      target: { value: '跟进客户风险与续费待办。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建并启动' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      name: '客户成功助手',
      instructions: '跟进客户风险与续费待办。',
    }));
    expect(screen.queryByRole('dialog', { name: '创建智能体' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '启动招投标助手' }));
    expect(launch).toHaveBeenCalledWith(saved);
  });

  it('keeps the fixed 9 enterprise Agents out of personal mode', () => {
    installBridge();

    const { container } = render(<RightPanel busy={false} />);

    for (const profile of BASE_AGENT_PROFILES) {
      expect(screen.getByText(profile.name)).toBeTruthy();
    }
    expect(screen.queryByText('PPT 创作专家')).toBeNull();
    expect(screen.queryByText('会议 Agent')).toBeNull();
    expect(screen.queryByText('品牌营销文案')).toBeNull();
    expect(screen.queryByText('企业AI自主开发')).toBeNull();
    expect(screen.queryByText('开发 AI 智能体')).toBeNull();
    expect(screen.queryByText('自主开发')).toBeNull();
    expect(screen.queryByText('CEO Agent')).toBeNull();
    expect(screen.queryByText('战略与竞争 Agent')).toBeNull();
    expect(screen.queryByText('装修 · 公告 · 停车 · 网络 · 会议 · 报修')).toBeNull();
    expect(screen.queryByText('访客 · 会议室 · 报修 · 后勤 · 班车 · 餐饮')).toBeNull();
    expect(container.querySelectorAll('.otto-profile-card')).toHaveLength(1);
  });

  it('launches the independent development AI without counting it among the fixed 9 cards', () => {
    installBridge();
    const launch = vi.fn();

    const { container } = render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="member"
        workspace={enterpriseWorkspace()}
        onLaunchAgentProfile={launch}
      />,
    );

    fireEvent.click(screen.getByText('自主开发'));
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      id: 'self-development',
      name: '自主开发',
    }));
    expect(container.querySelectorAll('.otto-profile-card')).toHaveLength(9);
  });

  it('keeps the enterprise admin on the shared enterprise-work 9-Agent catalog', () => {
    installBridge();

    const { container } = render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="company_admin"
        workspace={enterpriseWorkspace()}
        onOpenSkillZone={vi.fn()}
      />,
    );

    expect(screen.getByText('企业工作 Agent')).toBeTruthy();
    expect(screen.getByText('PPT 创作专家')).toBeTruthy();
    expect(screen.getByText('品牌营销文案')).toBeTruthy();
    expect(screen.queryByText('CEO Agent')).toBeNull();
    expect(screen.queryByText('产品需求 Agent')).toBeNull();
    expect(container.querySelectorAll('.otto-profile-card')).toHaveLength(9);
  });

  it('ignores a stale local owner workspace for an authenticated central member', () => {
    installBridge();

    const { container } = render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="member"
        workspace={enterpriseWorkspace()}
      />,
    );

    expect(screen.getByText('企业工作 Agent')).toBeTruthy();
    expect(screen.queryByText('CEO Agent')).toBeNull();
    expect(container.querySelectorAll('.otto-profile-card')).toHaveLength(9);
  });

  it('keeps worklog popovers inside the panel on the left and right calendar edges', async () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const mondayDay = 1 + ((7 - firstWeekday) % 7);
    const sundayDay = 1 + ((6 - firstWeekday + 7) % 7);
    const keyFor = (day: number): string =>
      `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    installBridge(async () => [
      {
        date: keyFor(mondayDay),
        entries: [{
          time: '09:00',
          category: 'test',
          action: '左侧成果',
          success: true,
          entryType: 'work_result',
        }],
      },
      {
        date: keyFor(sundayDay),
        entries: [{
          time: '18:00',
          category: 'test',
          action: '右侧成果',
          success: true,
          entryType: 'work_result',
        }],
      },
    ]);

    const { container } = render(<RightPanel busy={false} />);
    fireEvent.click(screen.getByRole('tab', { name: '工作日志' }));

    await waitFor(() => {
      expect(container.querySelector('button[title*="左侧成果"]')).toBeTruthy();
      expect(container.querySelector('button[title*="右侧成果"]')).toBeTruthy();
    });

    expect(container.querySelector('button[title*="左侧成果"]')?.className)
      .toContain('is-pop-col-0');
    expect(container.querySelector('button[title*="左侧成果"]')?.className)
      .toContain('is-pop-left');
    expect(container.querySelector('button[title*="右侧成果"]')?.className)
      .toContain('is-pop-col-6');
    expect(container.querySelector('button[title*="右侧成果"]')?.className)
      .toContain('is-pop-right');
  });

  it('keeps the park service entry wired to the park-services event', async () => {
    installBridge();
    const parkOpen = vi.fn();
    window.addEventListener('otto:open-park-services', parkOpen, { once: true });

    render(<RightPanel busy={false} />);

    await screen.findAllByText('园区服务');
    const parkCard = document.querySelector<HTMLButtonElement>(
      '.otto-expert-card[title*="装修管理"]',
    );
    expect(parkCard).toBeTruthy();
    expect(parkCard?.getAttribute('title')).toContain('装修管理');
    fireEvent.click(parkCard!);
    expect(parkOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps the Feishu status and multi-channel shortcuts in the tools tab', () => {
    installBridge();
    render(<RightPanel busy={false} />);

    fireEvent.click(screen.getByRole('tab', { name: '工具' }));

    expect(screen.getByText('/feishu-status')).toBeTruthy();
    expect(screen.getByText('/multi-channel')).toBeTruthy();
    expect(screen.getByText('点击把命令填入输入框，回车执行')).toBeTruthy();
  });

  it('keeps one mascot stage outside the tabs while switching panels', () => {
    installBridge();
    render(<RightPanel busy={false} />);
    expect(screen.getAllByRole('region', { name: 'Otto 吉祥物活动区' }))
      .toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: '工作日志' }));

    expect(screen.getAllByRole('region', { name: 'Otto 吉祥物活动区' }))
      .toHaveLength(1);
  });

  it('keeps personal mode on its right-panel tabs without enterprise-only actions', () => {
    installBridge();
    render(<RightPanel busy={false} />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '专家',
      '工具',
      '文档',
      '工作日志',
    ]);
    expect(screen.queryByText('企业记忆')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skill 专区' })).toBeNull();
    expect(screen.queryByRole('button', { name: /企业与好友/ })).toBeNull();
  });

  it('loads, edits, and saves a text document from the right panel', async () => {
    const { extractEditableDocument, readFilePath, saveTextFile, selectFiles } = installBridge();
    render(<RightPanel busy={false} />);

    fireEvent.click(screen.getByRole('tab', { name: '文档' }));
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));

    expect(selectFiles).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(readFilePath).toHaveBeenCalledWith('/tmp/enterprise-summary.md'));
    await waitFor(() => expect(extractEditableDocument).toHaveBeenCalledWith('/tmp/enterprise-summary.md'));
    const editor = await screen.findByLabelText('编辑 /tmp/enterprise-summary.md');
    fireEvent.change(editor, { target: { value: '# 企业总结\n\n终稿。' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(saveTextFile).toHaveBeenCalledWith(
      'enterprise-summary.md',
      expect.stringContaining('终稿。'),
    ));
  });

  it('exports an edited PDF document from the right panel', async () => {
    const { exportEditedDocument, extractEditableDocument, readFilePath, selectFiles } = installBridge();
    selectFiles.mockResolvedValueOnce(['/tmp/readiness.pdf']);
    readFilePath.mockResolvedValueOnce({
      filePath: '/tmp/readiness.pdf',
      fileName: 'readiness.pdf',
      size: 8192,
      mimeType: 'application/pdf',
      data: '',
    });
    extractEditableDocument.mockResolvedValueOnce({
      filePath: '/tmp/readiness.pdf',
      fileName: 'readiness.pdf',
      sourceFormat: 'pdf' as const,
      editableFormat: 'markdown' as const,
      content: '# 验收清单\n\n待确认。',
      readonly: false,
      message: '已从 PDF 提取可编辑文本。',
    });
    render(<RightPanel busy={false} />);

    fireEvent.click(screen.getByRole('tab', { name: '文档' }));
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));

    const editor = await screen.findByLabelText('编辑 /tmp/readiness.pdf');
    fireEvent.change(editor, { target: { value: '# 验收清单\n\n已确认。' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(exportEditedDocument).toHaveBeenCalledWith(
      '/tmp/readiness.pdf',
      'readiness.edited.pdf',
      expect.stringContaining('已确认。'),
    ));
  });

  it('exports an edited Word document from the right panel', async () => {
    const { exportEditedDocument, extractEditableDocument, readFilePath, selectFiles } = installBridge();
    selectFiles.mockResolvedValueOnce(['/tmp/proposal.docx']);
    readFilePath.mockResolvedValueOnce({
      filePath: '/tmp/proposal.docx',
      fileName: 'proposal.docx',
      size: 4096,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: '',
    });
    extractEditableDocument.mockResolvedValueOnce({
      filePath: '/tmp/proposal.docx',
      fileName: 'proposal.docx',
      sourceFormat: 'docx' as const,
      editableFormat: 'markdown' as const,
      content: '# 方案\n\n初稿。',
      readonly: false,
      message: '已从 Word 提取可编辑文本。',
    });
    render(<RightPanel busy={false} />);

    fireEvent.click(screen.getByRole('tab', { name: '文档' }));
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));

    const editor = await screen.findByLabelText('编辑 /tmp/proposal.docx');
    fireEvent.change(editor, { target: { value: '# 方案\n\n终稿。' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(exportEditedDocument).toHaveBeenCalledWith(
      '/tmp/proposal.docx',
      'proposal.edited.docx',
      expect.stringContaining('终稿。'),
    ));
  });

  it('中心返回未加入园区时不显示宏创园区入口，不读取旧本机品牌', async () => {
    installBridge();
    const enterpriseParkView = vi.fn(async () => null);
    const parkConfig = vi.fn(async () => ({ brandName: '旧本机宏创园区服务' }));
    Object.assign(window.otto, { enterpriseParkView, parkConfig });

    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        workspace={enterpriseWorkspace()}
      />,
    );

    await waitFor(() => expect(enterpriseParkView).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: /宏创园区服务/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '旧本机宏创园区服务' })).toBeNull();
    expect(parkConfig).not.toHaveBeenCalled();
  });

  it('已加入园区时使用中心返回的动态品牌', async () => {
    installBridge();
    const parkConfig = vi.fn(async () => ({ brandName: '旧本机品牌' }));
    Object.assign(window.otto, {
      parkConfig,
      enterpriseParkView: vi.fn(async () => ({
        id: 'park_star',
        name: '星火产业园',
        slug: 'star-park',
        brandName: '星火智慧园区服务',
        adminOrganizationId: 'org-park',
        status: 'active' as const,
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
      })),
    });

    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        workspace={enterpriseWorkspace()}
      />,
    );

    expect(await screen.findByText('星火智慧园区服务')).toBeTruthy();
    expect(parkConfig).not.toHaveBeenCalled();
  });

  it('keeps enterprise tabs, Skill Zone, and collaboration in fixed-catalog mode', async () => {
    installBridge([], true);
    const openSkillZone = vi.fn();
    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        workspace={enterpriseWorkspace()}
        onOpenSkillZone={openSkillZone}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
        '专家', '工具', '文档', '企业记忆', '工作日志',
      ]);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Skill 专区' }));
    expect(openSkillZone).toHaveBeenCalledTimes(1);

    const toggle = screen.getByRole('button', { name: /企业与好友/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByText('宏创 AI')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('hides Skill Zone when the organization feature is disabled', async () => {
    const bridge = installBridge([], false, false);
    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        workspace={enterpriseWorkspace()}
      />,
    );

    await waitFor(() => expect(bridge.enterpriseOrganizationFeaturesGet).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'Skill 专区' })).toBeNull();
  });

  it('loads and displays real enterprise memory entries', async () => {
    installBridge([], true);
    (window as unknown as { otto: { enterpriseKnowledgeList: () => Promise<unknown[]> } }).otto.enterpriseKnowledgeList = vi.fn(async () => [
      {
        id: 'k1',
        organizationId: 'org-1',
        sourceId: 's1',
        department: '研发部',
        category: 'solution',
        content: '客户部署必须先完成企业邀请码校验。',
        contributor: 'Felix',
        confidence: 0.86,
        sourceType: 'auto_capture',
        evidenceCount: 4,
        distinctSessionCount: 3,
        distinctContributorCount: 2,
        lastObservedAt: '2026-07-20T04:00:00.000Z',
        createdAt: '2026-07-20T04:00:00.000Z',
      },
    ]);

    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        workspace={enterpriseWorkspace()}
      />,
    );

    fireEvent.click(await screen.findByRole('tab', { name: '企业记忆' }));

    expect(await screen.findByText('客户部署必须先完成企业邀请码校验。')).toBeTruthy();
    expect(screen.getByText('研发部')).toBeTruthy();
    expect(screen.getByText('solution')).toBeTruthy();
    expect(screen.getByText('86%')).toBeTruthy();
    expect(screen.getByText('Felix')).toBeTruthy();
    expect(screen.getByText('4 条证据')).toBeTruthy();
    expect(screen.getByText('3 个会话')).toBeTruthy();
    expect(screen.getByText('2 名贡献者')).toBeTruthy();
  });

  it('separates approved enterprise knowledge from its revision timeline', async () => {
    const bridge = installBridge([], true);
    bridge.enterpriseKnowledgeList.mockResolvedValue([{
      id: 'timeline-1',
      organizationId: 'org-1',
      sourceId: 'manual-timeline',
      title: '客户交付规则',
      department: null,
      category: '制度',
      content: '当前规则',
      contributor: '管理员',
      confidence: 0.95,
      status: 'active',
      version: 2,
      createdAt: '2026-07-19T04:00:00.000Z',
      updatedAt: '2026-07-20T04:00:00.000Z',
    }]);
    bridge.enterpriseKnowledgeRevisions.mockResolvedValue([{
      id: 'timeline-revision-1',
      knowledgeId: 'timeline-1',
      version: 1,
      title: '客户交付规则',
      category: '制度',
      content: '第一版规则',
      status: 'active',
      changedBy: '管理员',
      changeNote: '首次形成',
      createdAt: '2026-07-19T04:00:00.000Z',
    }]);

    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="company_admin"
        workspace={enterpriseWorkspace()}
      />,
    );
    fireEvent.click(await screen.findByRole('tab', { name: '企业记忆' }));
    fireEvent.click(await screen.findByRole('tab', { name: '记忆沿革' }));

    expect(await screen.findByText('第一版规则')).toBeTruthy();
    expect(screen.getByText(/管理员 · 首次形成/)).toBeTruthy();
  });

  it('lets enterprise admins publish a curated knowledge entry from the panel', async () => {
    const bridge = installBridge([], true);
    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="company_admin"
        workspace={enterpriseWorkspace()}
      />,
    );

    fireEvent.click(await screen.findByRole('tab', { name: '企业记忆' }));
    fireEvent.click(await screen.findByRole('button', { name: '新增' }));
    fireEvent.change(screen.getByRole('textbox', { name: '知识标题' }), {
      target: { value: '客户交付检查' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '知识分类' }), {
      target: { value: '交付流程' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '知识内容' }), {
      target: { value: '上线前检查备份、监控和回滚方案。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发布知识' }));

    await waitFor(() => expect(bridge.enterpriseKnowledgeRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '客户交付检查',
        category: '交付流程',
        content: '上线前检查备份、监控和回滚方案。',
        sourceType: 'manual',
      }),
    ));
    expect(await screen.findByText('企业知识已发布。')).toBeTruthy();
  });

  it('lets enterprise admins revise knowledge and inspect its audit history', async () => {
    const bridge = installBridge([], true);
    bridge.enterpriseKnowledgeList.mockResolvedValue([{
      id: '12',
      organizationId: 'org-1',
      sourceId: 'manual-12',
      title: '旧流程',
      department: null,
      category: '制度',
      content: '旧内容',
      contributor: '管理员',
      confidence: 0.9,
      status: 'active',
      version: 2,
      createdAt: '2026-07-20T04:00:00.000Z',
    }]);
    bridge.enterpriseKnowledgeRevisions.mockResolvedValue([{
      id: 'revision-1',
      knowledgeId: '12',
      version: 1,
      title: '旧流程',
      category: '制度',
      content: '第一版内容',
      status: 'active',
      changedBy: '管理员',
      changeNote: '首次发布',
      createdAt: '2026-07-20T04:00:00.000Z',
    }]);
    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="company_admin"
        workspace={enterpriseWorkspace()}
      />,
    );

    fireEvent.click(await screen.findByRole('tab', { name: '企业记忆' }));
    expect(await screen.findByText('旧内容')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '修订' }));
    fireEvent.change(screen.getByRole('textbox', { name: '知识内容' }), {
      target: { value: '新内容' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修订' }));
    await waitFor(() => expect(bridge.enterpriseKnowledgeRevise).toHaveBeenCalledWith(
      '12',
      expect.objectContaining({ content: '新内容' }),
    ));

    fireEvent.click(await screen.findByRole('button', { name: '版本' }));
    expect(await screen.findByText('首次发布')).toBeTruthy();
    expect(bridge.enterpriseKnowledgeRevisions).toHaveBeenCalledWith('12');
  });

  it('组织未启用知识功能时隐藏企业记忆且不调用 list', async () => {
    const bridge = installBridge([], false);
    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        workspace={enterpriseWorkspace()}
      />,
    );

    await waitFor(() => expect(bridge.enterpriseOrganizationFeaturesGet).toHaveBeenCalledOnce());
    expect(screen.queryByRole('tab', { name: '企业记忆' })).toBeNull();
    expect(bridge.enterpriseKnowledgeList).not.toHaveBeenCalled();
  });

  it('已启用后刷新功能快照失败时 fail closed 隐藏入口', async () => {
    const bridge = installBridge([], true);
    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        workspace={enterpriseWorkspace()}
      />,
    );

    const memoryTab = await screen.findByRole('tab', { name: '企业记忆' });
    bridge.enterpriseOrganizationFeaturesGet.mockRejectedValueOnce(
      new Error('组织功能快照暂时不可用'),
    );
    fireEvent.click(memoryTab);

    await waitFor(() => {
      expect(bridge.enterpriseOrganizationFeaturesGet).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('tab', { name: '企业记忆' })).toBeNull();
    });
    expect(bridge.enterpriseKnowledgeList).not.toHaveBeenCalled();
  });

  it('shows the authenticated central organization before stale local company data', () => {
    installBridge();
    const workspace = {
      ...enterpriseWorkspace(),
      authenticatedOrganization: { id: 'central-org', name: '中心企业' },
    };
    const openOrganization = vi.fn();

    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="member"
        workspace={workspace}
        onOpenOrganization={openOrganization}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /企业与好友/ }));
    expect(screen.getByText('中心企业')).toBeTruthy();
    expect(screen.queryByText('宏创 AI')).toBeNull();
    expect(screen.getByText('成员与部门由中心组织树实时加载')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开企业组织树' }));
    expect(openOrganization).toHaveBeenCalledOnce();
  });

  it('requires an explicit confirmation or rejection for auto-Skill candidates', () => {
    installBridge();
    const confirm = vi.fn();
    const reject = vi.fn();
    render(
      <RightPanel
        busy={false}
        autoSkillCandidates={[{
          id: 'candidate-1',
          name: 'auto-report',
          description: '重复报告流程',
          detectedPattern: '整理数据 → 生成报告',
          occurrenceCount: 3,
          reason: '连续三天重复',
          qualityScore: 86,
          confidence: 0.82,
          evidence: ['跨 3 天观察到 3 次同类流程'],
          failureLessons: ['导出前先确认统计周期'],
        }]}
        onConfirmAutoSkill={confirm}
        onRejectAutoSkill={reject}
      />,
    );

    expect(screen.getByText('重复报告流程')).toBeTruthy();
    expect(screen.getByText('质量 86/100')).toBeTruthy();
    expect(screen.getByText(/可信度 82%/)).toBeTruthy();
    expect(screen.getByText('跨 3 天观察到 3 次同类流程')).toBeTruthy();
    expect(screen.getByText(/导出前先确认统计周期/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    fireEvent.click(screen.getByRole('button', { name: '不再建议' }));
    expect(confirm).toHaveBeenCalledWith('candidate-1');
    expect(reject).toHaveBeenCalledWith('candidate-1');
  });

  it('generates and opens the work report without turning worklog into a notes editor', async () => {
    const { openPath, saveTextFile, workLogReport } = installBridge();
    render(<RightPanel busy={false} />);
    fireEvent.click(screen.getByRole('tab', { name: '工作日志' }));
    fireEvent.click(screen.getByRole('button', { name: '生成今日总结' }));

    expect(workLogReport).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/已生成并保存「市场竞品调研报告」/))
      .toBeTruthy();
    expect(screen.queryByLabelText('编辑 /tmp/2026-07-10-市场竞品调研报告.md')).toBeNull();
    expect(screen.queryByRole('button', { name: '打开已保存编辑稿' })).toBeNull();
    expect(saveTextFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '打开总结' }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(
      '/tmp/2026-07-10-市场竞品调研报告.md',
    ));
  });

  it('lists every worklog item and its details in the calendar tooltip', async () => {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    installBridge([{
      date,
      entries: [
        {
          time: '09:30',
          category: 'document',
          action: '生成调研报告',
          success: true,
          entryType: 'work_result',
          details: '完成宏创园区竞品数据对比与结论。',
        },
        {
          time: '14:20',
          category: 'calendar',
          action: '安排复盘日程',
          success: false,
          entryType: 'tool',
        },
      ],
    }]);
    render(<RightPanel busy={false} />);
    fireEvent.click(screen.getByRole('tab', { name: '工作日志' }));
    const day = screen.getByRole('button', { name: String(now.getDate()) });

    await waitFor(() => expect(day.getAttribute('title')).toBe(
      '• 09:30 生成调研报告\n• 14:20 安排复盘日程',
    ));
    const tooltipText = screen.getByRole('tooltip').textContent ?? '';
    expect(tooltipText).toContain('• 完成 · 生成调研报告');
    expect(tooltipText).toContain('完成宏创园区竞品数据对比与结论。');
    expect(tooltipText).toContain('• calendar · 安排复盘日程（失败）');
  });
});
