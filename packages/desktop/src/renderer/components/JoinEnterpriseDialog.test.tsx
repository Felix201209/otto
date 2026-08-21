/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  JoinEnterpriseDialog,
  type EnterpriseVerificationApplication,
} from './JoinEnterpriseDialog.js';

const SHA256 = '01'.repeat(32);

function makeFile(name = 'license.pdf', type = 'application/pdf', content = 'proof'): File {
  const file = new File([content], name, { type });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: async () => new TextEncoder().encode(content).buffer,
  });
  return file;
}

function renderDialog(over: Partial<React.ComponentProps<typeof JoinEnterpriseDialog>> = {}) {
  const onConfirm = vi.fn(async () => undefined);
  const onSubmitEnterpriseVerification = vi.fn(async () => ({
    id: 'application-1',
    status: 'submitted',
    legalName: '北京示例科技有限公司',
  }));
  const onGetEnterpriseVerification = vi.fn(async () => null);
  const onCancelEnterpriseVerification = vi.fn(async () => ({
    id: 'application-1',
    status: 'cancelled',
  }));
  const onUploadEnterpriseVerificationEvidence = vi.fn(async () => ({
    reference: 'evidence:secure/object',
    sha256: SHA256,
  }));
  const result = render(
    <JoinEnterpriseDialog
      open
      onCancel={vi.fn()}
      onConfirm={onConfirm}
      onSubmitEnterpriseVerification={onSubmitEnterpriseVerification}
      onGetEnterpriseVerification={onGetEnterpriseVerification}
      onCancelEnterpriseVerification={onCancelEnterpriseVerification}
      onUploadEnterpriseVerificationEvidence={onUploadEnterpriseVerificationEvidence}
      {...over}
    />,
  );
  return {
    ...result,
    onConfirm,
    onSubmitEnterpriseVerification,
    onGetEnterpriseVerification,
    onCancelEnterpriseVerification,
    onUploadEnterpriseVerificationEvidence,
  };
}

async function openVerification(): Promise<HTMLElement> {
  const dialog = screen.getByRole('dialog', { name: '加入或创建企业' });
  fireEvent.click(within(dialog).getByRole('tab', { name: '认证并创建企业' }));
  await waitFor(() => expect(within(dialog).getByText('认证企业主体')).toBeTruthy());
  return dialog;
}

async function fillRequiredForm(container: HTMLElement): Promise<void> {
  fireEvent.change(within(container).getByRole('textbox', { name: '企业全称' }), {
    target: { value: '北京示例科技有限公司' },
  });
  fireEvent.change(within(container).getByRole('textbox', { name: '统一社会信用代码' }), {
    target: { value: '91110108MA00000001' },
  });
  fireEvent.change(within(container).getByRole('textbox', { name: '法定代表人姓名' }), {
    target: { value: '张三' },
  });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).toBeTruthy();
  fireEvent.change(input!, { target: { files: [makeFile()] } });
  await waitFor(() => expect(within(container).getByText('已校验，等待上传')).toBeTruthy());
}

describe('JoinEnterpriseDialog 企业自助认证', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => new Uint8Array(32).fill(1).buffer),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('将邀请码和企业认证作为两个同级明确入口', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '加入或创建企业' });
    expect(within(dialog).getByRole('tab', { name: '使用企业邀请码' })).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: '认证并创建企业' })).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: '企业邀请码' })).toBeTruthy();
    await openVerification();
    expect(within(dialog).getByRole('textbox', { name: '企业全称' })).toBeTruthy();
  });

  it('仅受托经办人必须提交授权书', async () => {
    const { container } = renderDialog();
    const dialog = await openVerification();
    expect(within(dialog).queryByText('授权书')).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: '受托经办人' }));
    expect(within(dialog).getByText('授权书')).toBeTruthy();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('radio', { name: '法定代表人' }));
    expect(within(dialog).queryByText('授权书')).toBeNull();
  });

  it('缺少安全上传能力时 fail-closed，不调用申请接口', async () => {
    const onSubmit = vi.fn();
    renderDialog({
      onSubmitEnterpriseVerification: onSubmit,
      onUploadEnterpriseVerificationEvidence: undefined,
    });
    const dialog = await openVerification();
    await fillRequiredForm(dialog);
    expect(within(dialog).getByRole('alert').textContent).toContain('安全材料上传服务暂不可用');
    const submit = within(dialog).getByRole('button', { name: '提交企业认证' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('先上传并核对摘要，全部成功后才提交申请', async () => {
    const {
      onSubmitEnterpriseVerification,
      onUploadEnterpriseVerificationEvidence,
    } = renderDialog();
    const dialog = await openVerification();
    await fillRequiredForm(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '提交企业认证' }));

    await waitFor(() => expect(onUploadEnterpriseVerificationEvidence).toHaveBeenCalledOnce());
    await waitFor(() => expect(onSubmitEnterpriseVerification).toHaveBeenCalledOnce());
    expect(onUploadEnterpriseVerificationEvidence).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'business_license',
      fileName: 'license.pdf',
      contentType: 'application/pdf',
      contentBase64: 'cHJvb2Y=',
    }));
    expect(onUploadEnterpriseVerificationEvidence.mock.invocationCallOrder[0])
      .toBeLessThan(onSubmitEnterpriseVerification.mock.invocationCallOrder[0]);
    expect(onSubmitEnterpriseVerification).toHaveBeenCalledWith(expect.objectContaining({
      applicantAuthority: 'legal_representative',
      businessLicenseEvidence: {
        reference: 'evidence:secure/object',
        sha256: SHA256,
      },
      authorizationEvidence: null,
    }));
    expect(await within(dialog).findByText('审核中')).toBeTruthy();
  });

  it.each([
    ['submitted', '审核中'],
    ['approved', '已通过'],
    ['rejected', '被驳回'],
    ['cancelled', '已取消'],
  ])('展示 %s 申请状态', async (status, label) => {
    const application: EnterpriseVerificationApplication = {
      id: 'application-1',
      status,
      legalName: '北京示例科技有限公司',
      reviewNote: status === 'rejected' ? '营业执照照片不清晰，请重新上传' : null,
    };
    renderDialog({
      onGetEnterpriseVerification: vi.fn(async () => application),
    });
    expect(await screen.findByText(label)).toBeTruthy();
    if (status === 'rejected') {
      expect(screen.getByText('营业执照照片不清晰，请重新上传')).toBeTruthy();
    }
    if (status === 'approved') {
      expect(screen.getByRole('button', { name: '重新读取身份' })).toBeTruthy();
    }
  });

  it('审核中的申请可以取消，并等待服务端确认状态', async () => {
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
