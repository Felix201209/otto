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
  });
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
    const props = { agents: [], onCreate: vi.fn(), onDelete: vi.fn(), onClose: vi.fn() };
    const view = render(<CustomAgentManagerDialog open {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: '专家名称' }), { target: { value: '未保存草稿' } });
    view.rerender(<CustomAgentManagerDialog open={false} {...props} />);
    view.rerender(<CustomAgentManagerDialog open {...props} />);
    await waitFor(() => expect((screen.getByRole('textbox', { name: '专家名称' }) as HTMLInputElement).value).toBe(''));
  });
});
