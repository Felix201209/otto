/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  JoinEnterpriseDialog,
  type EnterpriseVerificationApplication,
} from './JoinEnterpriseDialog.js';

function renderDialog(over: Partial<React.ComponentProps<typeof JoinEnterpriseDialog>> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn(async () => undefined);
  const onSubmitEnterpriseVerification = vi.fn(async () => ({
    id: 'application-1',
    status: 'approved',
    legalName: '北京示例科技有限公司',
  }));
  const onGetEnterpriseVerification = vi.fn(async () => null);
  const onCancelEnterpriseVerification = vi.fn(async () => ({
    id: 'application-1',
    status: 'cancelled',
  }));
  const onReloadEnterpriseIdentity = vi.fn(async () => undefined);
  const result = render(
    <JoinEnterpriseDialog
      open
      onCancel={onCancel}
      onConfirm={onConfirm}
      onSubmitEnterpriseVerification={onSubmitEnterpriseVerification}
      onGetEnterpriseVerification={onGetEnterpriseVerification}
      onCancelEnterpriseVerification={onCancelEnterpriseVerification}
      onReloadEnterpriseIdentity={onReloadEnterpriseIdentity}
      {...over}
    />,
  );
  return {
    ...result,
    onCancel,
    onConfirm,
    onSubmitEnterpriseVerification,
    onGetEnterpriseVerification,
    onCancelEnterpriseVerification,
    onReloadEnterpriseIdentity,
  };
}

async function openCreation(): Promise<HTMLElement> {
  const dialog = screen.getByRole('dialog', { name: '加入或创建企业' });
  fireEvent.click(within(dialog).getByRole('tab', { name: '创建企业' }));
  await waitFor(() => expect(within(dialog).getByRole('textbox', { name: '企业名称' })).toBeTruthy());
  return dialog;
}

describe('JoinEnterpriseDialog 企业自助创建', () => {
  it('保留邀请码和创建企业两个同级入口', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '加入或创建企业' });
    expect(within(dialog).getByRole('tab', { name: '使用企业邀请码' })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: '创建企业' })).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: '企业邀请码' })).toBeTruthy();
    await openCreation();
    expect(within(dialog).getByRole('textbox', { name: '企业名称' })).toBeTruthy();
  });

  it('创建表单只要求企业名称，不显示认证和材料字段', async () => {
    const { container } = renderDialog();
    const dialog = await openCreation();
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(within(dialog).getByText('当前登录账号和已验证手机号会自动带入，无需重复填写。')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/营业执照|授权书|统一社会信用代码|法定代表人|申请人身份|主体认证|认证材料|审核中|待审核/);
  });

  it('提交时只传企业名称，成功后刷新身份并关闭弹窗', async () => {
    const {
      onCancel,
      onSubmitEnterpriseVerification,
      onReloadEnterpriseIdentity,
    } = renderDialog();
    const dialog = await openCreation();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '企业名称' }), {
      target: { value: '  北京示例科技有限公司  ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建企业' }));

    await waitFor(() => expect(onSubmitEnterpriseVerification).toHaveBeenCalledWith({
      legalName: '北京示例科技有限公司',
    }));
    await waitFor(() => expect(onReloadEnterpriseIdentity).toHaveBeenCalledOnce());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['manual_review', '正在处理'],
    ['rejected', '创建失败'],
  ])('兼容旧 %s 状态并展示真实处理说明', async (status, label) => {
    const application: EnterpriseVerificationApplication = {
      id: 'application-1',
      status,
      legalName: '北京示例科技有限公司',
      reviewNote: '旧材料需要补充',
    };
    renderDialog({
      onGetEnterpriseVerification: vi.fn(async () => application),
    });
    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.getByText('旧材料需要补充')).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/审核中|待审核|营业执照|授权书|主体认证|法定代表人/);
  });

  it('成功状态固定显示友好文案，不暴露服务端内部备注', async () => {
    const application: EnterpriseVerificationApplication = {
      id: 'application-1',
      status: 'approved',
      legalName: '北京示例科技有限公司',
      reviewNote: 'internal: provisioned organization=org-secret',
    };
    renderDialog({
      onGetEnterpriseVerification: vi.fn(async () => application),
    });

    expect(await screen.findByText('企业已经创建')).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).not.toContain('org-secret');
  });

  it('身份刷新失败会显示错误，并允许用户再次重试', async () => {
    const reloadIdentity = vi.fn()
      .mockRejectedValueOnce(new Error('网络暂不可用'))
      .mockResolvedValueOnce(undefined);
    const { onCancel } = renderDialog({
      onReloadEnterpriseIdentity: reloadIdentity,
    });
    const dialog = await openCreation();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '企业名称' }), {
      target: { value: '北京示例科技有限公司' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建企业' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain('身份刷新失败');
    expect(within(dialog).getByRole('button', { name: '重新读取身份' })).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '重新读取身份' }));
    await waitFor(() => expect(reloadIdentity).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
  });

  it('旧处理中申请仍可取消，并等待服务端确认状态', async () => {
    const current: EnterpriseVerificationApplication = {
      id: 'application-1',
      status: 'manual_review',
      legalName: '北京示例科技有限公司',
    };
    const cancel = vi.fn(async () => ({ ...current, status: 'cancelled' }));
    renderDialog({
      onGetEnterpriseVerification: vi.fn(async () => current),
      onCancelEnterpriseVerification: cancel,
    });
    const button = await screen.findByRole('button', { name: '取消申请' });
    fireEvent.click(button);
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(await screen.findByText('已取消')).toBeTruthy();
  });
});
