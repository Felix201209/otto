import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AutoSkillDialog,
  CustomAgentManagerDialog,
  EnterpriseMemoryDialog,
} from './WorkspaceDialogs.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

beforeEach(() => {
  Object.assign(window.otto, {
    enterpriseKnowledgeList: vi.fn(async () => []),
    enterpriseKnowledgeRecord: vi.fn(async () => ({ status: 'added', added: true })),
    enterpriseKnowledgeRevise: vi.fn(async () => ({ status: 'updated' })),
    enterpriseKnowledgeReview: vi.fn(async () => ({ status: 'approved' })),
    enterpriseKnowledgeRevisions: vi.fn(async () => []),
    workLogRecent: vi.fn(async () => []),
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('WorkspaceDialogs', () => {
  it('关闭再打开后，旧范围的企业记忆响应不能覆盖新结果', async () => {
    const oldRequest = deferred<Awaited<ReturnType<typeof window.otto.enterpriseKnowledgeList>>>();
    const newRequest = deferred<Awaited<ReturnType<typeof window.otto.enterpriseKnowledgeList>>>();
    const list = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    Object.assign(window.otto, { enterpriseKnowledgeList: list });
    const props = { role: 'company_admin' as const, onClose: vi.fn() };
    const view = render(<EnterpriseMemoryDialog open {...props} />);
    view.rerender(<EnterpriseMemoryDialog open={false} {...props} />);
    view.rerender(<EnterpriseMemoryDialog open {...props} />);

    newRequest.resolve([{
      id: 'new', title: '新组织制度', category: '制度', content: '只显示新结果',
      organizationId: 'org-new', sourceId: null, department: null, contributor: null,
      confidence: 0.9, createdAt: '2026-08-27T00:00:00.000Z', status: 'active',
    }]);
    await screen.findByText('新组织制度');
    oldRequest.resolve([{
      id: 'old', title: '旧组织制度', category: '制度', content: '不得回填',
      organizationId: 'org-old', sourceId: null, department: null, contributor: null,
      confidence: 0.9, createdAt: '2026-08-26T00:00:00.000Z', status: 'active',
    }]);
    await Promise.resolve();
    expect(screen.queryByText('旧组织制度')).toBeNull();
  });

  it('企业记忆保留最近工作成果候选，并按成果来源沉淀', async () => {
    Object.assign(window.otto, {
      workLogRecent: vi.fn(async () => [{
        date: '2026-08-27',
        entries: [{
          time: '10:30', category: '文档', action: '完成客户方案', success: true,
          details: '交付最终版', entryType: 'work_result', taskTitle: '客户方案定稿',
        }],
      }]),
    });
    render(<EnterpriseMemoryDialog open role="company_admin" onClose={vi.fn()} />);

    await screen.findByText('客户方案定稿');
    fireEvent.click(screen.getByRole('button', { name: '沉淀' }));

    await waitFor(() => expect(window.otto.enterpriseKnowledgeRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'work_result',
        title: '客户方案定稿',
        content: '客户方案定稿\n交付最终版',
      }),
    ));
    await waitFor(() => expect(
      (screen.getByRole('button', { name: '沉淀' }) as HTMLButtonElement).disabled,
    ).toBe(false));
  });

  it('企业知识保留部门、证据、来源和完整记忆沿革', async () => {
    Object.assign(window.otto, {
      enterpriseKnowledgeList: vi.fn(async () => [{
        id: 'knowledge-1', organizationId: 'org-a', sourceId: 'source-1',
        sourceLabel: '项目复盘', sourceType: 'work_result', title: '交付规范',
        department: '客户成功部', category: '流程', content: '先审核再交付',
        contributor: '小周', confidence: 0.92, status: 'active', version: 2,
        evidenceCount: 3, distinctSessionCount: 2, distinctContributorCount: 2,
        lastObservedAt: '2026-08-27T08:00:00.000Z', createdAt: '2026-08-26T00:00:00.000Z',
      }]),
      enterpriseKnowledgeRevisions: vi.fn(async () => [{
        id: 'revision-1', knowledgeId: 'knowledge-1', version: 1, title: '交付规范',
        category: '流程', content: '初版流程', status: 'active', changedBy: '管理员',
        changeNote: '形成知识', createdAt: '2026-08-26T00:00:00.000Z',
      }]),
    });
    render(<EnterpriseMemoryDialog open role="company_admin" onClose={vi.fn()} />);

    await screen.findByText('交付规范');
    expect(screen.getByText('客户成功部')).toBeTruthy();
    expect(screen.getByText('3 条证据')).toBeTruthy();
    expect(screen.getByText('来源：项目复盘')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '记忆沿革' }));
    await screen.findByText('初版流程');
    expect(screen.getByText(/管理员 · 形成知识/)).toBeTruthy();
  });

  it('有未保存的企业知识草稿时，关闭前需要确认', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const onClose = vi.fn();
    render(<EnterpriseMemoryDialog open role="company_admin" onClose={onClose} />);
    await screen.findByText('暂无企业知识。');
    fireEvent.click(screen.getByRole('button', { name: '新增知识' }));
    fireEvent.change(screen.getByRole('textbox', { name: '知识标题' }), {
      target: { value: '尚未保存的制度' },
    });
    fireEvent.click(screen.getByRole('button', { name: '关闭企业记忆' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('尚未保存的制度')).toBeTruthy();
  });

  it('自动 Skill 弹窗保留确认、拒绝和分析动作', () => {
    const onRefresh = vi.fn(); const onConfirm = vi.fn(); const onReject = vi.fn();
    render(<AutoSkillDialog open candidates={[{
      id: 'candidate-1', name: '周报生成', description: '自动整理周报',
      detectedPattern: '重复周报', occurrenceCount: 3, reason: '存在稳定重复流程', recommendation: 'create',
    }]} lastAction={null} onRefresh={onRefresh} onConfirm={onConfirm} onReject={onReject} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '立即分析' }));
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    fireEvent.click(screen.getByRole('button', { name: '不再建议' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('candidate-1');
    expect(onReject).toHaveBeenCalledWith('candidate-1');
  });

  it('自定义专家草稿在关闭后清空', async () => {
    const props = {
      agents: [], onCreate: vi.fn(), onDelete: vi.fn(), onUpdateIcon: vi.fn(), onClose: vi.fn(),
    };
    const view = render(<CustomAgentManagerDialog open {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: '专家名称' }), { target: { value: '未保存草稿' } });
    view.rerender(<CustomAgentManagerDialog open={false} {...props} />);
    view.rerender(<CustomAgentManagerDialog open {...props} />);
    await waitFor(() => expect((screen.getByRole('textbox', { name: '专家名称' }) as HTMLInputElement).value).toBe(''));
  });

  it('创建专家时可以从 30 个预置图标中选择模块头像', async () => {
    const onCreate = vi.fn();
    render(<CustomAgentManagerDialog
      open
      agents={[]}
      onCreate={onCreate}
      onDelete={vi.fn()}
      onUpdateIcon={vi.fn()}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '选择模块图标' }));
    expect(screen.getAllByRole('button', { name: /^选择图标：/ })).toHaveLength(30);
    fireEvent.click(screen.getByRole('button', { name: '选择图标：客户成功' }));
    await waitFor(() => expect(
      screen.queryByRole('region', { name: '模块图标选择器' }),
    ).toBeNull());
    fireEvent.change(screen.getByRole('textbox', { name: '专家名称' }), {
      target: { value: '续费助手' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '职责说明' }), {
      target: { value: '跟进客户续费风险。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建专家' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      name: '续费助手',
      instructions: '跟进客户续费风险。',
      icon: { kind: 'preset', name: 'agent-customer-success' },
    }));
  });

  it('已有专家可以更换图标，并提供本地图片上传入口', async () => {
    const onUpdateIcon = vi.fn();
    render(<CustomAgentManagerDialog
      open
      agents={[{
        id: 'custom-bid',
        name: '招投标助手',
        instructions: '整理投标材料。',
        createdAt: '2026-08-27T00:00:00.000Z',
      }]}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onUpdateIcon={onUpdateIcon}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '更换招投标助手的图标' }));
    fireEvent.click(screen.getByRole('button', { name: '选择图标：财务分析' }));
    await waitFor(() => expect(onUpdateIcon).toHaveBeenCalledWith(
      'custom-bid',
      { kind: 'preset', name: 'agent-finance-analysis' },
    ));
    await waitFor(() => expect(
      screen.queryByRole('region', { name: '模块图标选择器' }),
    ).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '更换招投标助手的图标' }));
    fireEvent.click(screen.getByRole('tab', { name: '上传图片' }));
    expect(screen.getByLabelText('选择本地图片')).toBeTruthy();
  });

  it('更换图标保存失败时保留选择器并显示错误', async () => {
    render(<CustomAgentManagerDialog
      open
      agents={[{
        id: 'custom-risk',
        name: '风险助手',
        instructions: '识别风险。',
        createdAt: '2026-08-27T00:00:00.000Z',
      }]}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onUpdateIcon={() => { throw new Error('本机存储不可用，专家未保存'); }}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '更换风险助手的图标' }));
    fireEvent.click(screen.getByRole('button', { name: '选择图标：经营管理' }));

    expect((await screen.findByRole('alert')).textContent).toContain('本机存储不可用，专家未保存');
    expect(screen.getByRole('region', { name: '模块图标选择器' })).toBeTruthy();
  });
});
