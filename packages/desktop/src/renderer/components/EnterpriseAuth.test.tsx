/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  advanceTypewriterFrame,
  EnterpriseLoginPage,
  isRegistrationReady,
  sanitizeSmsCode,
} from './EnterpriseLoginPage.js';
import { friendlyAuthError } from '../state/useEnterpriseAuth.js';

beforeAll(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

describe('企业首次注册输入规则', () => {
  it('只保留前 6 位数字，且姓名、密码、挑战和验证码完整时才允许提交', () => {
    expect(sanitizeSmsCode('04a27 319')).toBe('042731');
    expect(isRegistrationReady({ inviteCode: '', name: '小明', password: 'password-1', confirmPassword: 'password-1', challengeId: 'sms_1', code: '042731' })).toBe(false);
    expect(isRegistrationReady({ inviteCode: 'ABCD-EFGH', name: '小明', password: 'password-1', confirmPassword: 'password-1', challengeId: '', code: '042731' })).toBe(false);
    expect(isRegistrationReady({ inviteCode: 'ABCD-EFGH', name: '小明', password: 'short', confirmPassword: 'short', challengeId: 'sms_1', code: '042731' })).toBe(false);
    expect(isRegistrationReady({ inviteCode: 'ABCD-EFGH', name: '小明', password: 'password-1', confirmPassword: 'different', challengeId: 'sms_1', code: '042731' })).toBe(false);
    expect(isRegistrationReady({ inviteCode: 'ABCD-EFGH', name: '小明', password: 'password-1', confirmPassword: 'password-1', challengeId: 'sms_1', code: '042731' })).toBe(true);
  });
});

describe('登录页能力打字机', () => {
  it('逐字输入、停留、删除并切换到下一条能力', () => {
    const phrases = ['写代码', '跑自动化'];

    expect(advanceTypewriterFrame({ phraseIndex: 0, charIndex: 2, deleting: false }, phrases))
      .toEqual({ phraseIndex: 0, charIndex: 3, deleting: false });
    expect(advanceTypewriterFrame({ phraseIndex: 0, charIndex: 3, deleting: false }, phrases))
      .toEqual({ phraseIndex: 0, charIndex: 3, deleting: true });
    expect(advanceTypewriterFrame({ phraseIndex: 0, charIndex: 0, deleting: true }, phrases))
      .toEqual({ phraseIndex: 1, charIndex: 0, deleting: false });
  });
});

describe('专业登录入口', () => {
  it('在登录和注册提交前醒目显示当前企业服务器主机', () => {
    render(
      <EnterpriseLoginPage
        initialServerUrl="https://59.110.154.44:7777/company"
        busy={false}
        error={null}
        onPasswordLogin={async () => undefined}
        onRequestRegistrationCode={async () => ({
          challengeId: 'sms_1', message: '验证码已发送', retryAfterSeconds: 60,
          organization: { id: 'org_acme', name: '星河科技' },
        })}
        onRegister={async () => undefined}
        onClearError={() => undefined}
      />,
    );

    const serverBanner = screen.getByLabelText('当前企业服务器');
    expect(serverBanner.textContent).toContain('59.110.154.44:7777');
    expect(screen.getByRole('button', { name: '进入 Otto' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '注册新账号' }));
    expect(screen.getByLabelText('当前企业服务器').textContent)
      .toContain('59.110.154.44:7777');
    expect(screen.getByRole('button', { name: '创建账号并进入' })).toBeTruthy();
  });

  it('默认只显示账号或手机号密码登录，注册位于单独入口', () => {
    render(
      <EnterpriseLoginPage
        initialServerUrl="https://59.110.154.44:7777"
        busy={false}
        error={null}
        onPasswordLogin={async () => undefined}
        onRequestRegistrationCode={async () => ({
          challengeId: 'sms_1', message: '验证码已发送', retryAfterSeconds: 60,
          organization: { id: 'org_acme', name: '星河科技' },
        })}
        onRegister={async () => undefined}
        onClearError={() => undefined}
      />,
    );

    expect(screen.queryByText('连接设置')).toBeNull();
    expect(screen.queryByLabelText('企业服务器')).toBeNull();
    expect(screen.getByLabelText('账号或手机号')).toBeTruthy();
    expect(screen.queryByLabelText('短信验证码')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '注册新账号' }));
    expect(screen.getByRole('heading', { name: '创建 Otto 账号' })).toBeTruthy();
    expect(screen.getByLabelText('企业邀请码')).toBeTruthy();
    expect(screen.getByLabelText('姓名')).toBeTruthy();
    expect(screen.getByLabelText('手机号')).toBeTruthy();
    expect(screen.getByLabelText('设置登录密码')).toBeTruthy();
    expect(screen.getByLabelText('确认登录密码')).toBeTruthy();
    expect(screen.getByLabelText('短信验证码')).toBeTruthy();
    expect(screen.getByText('验证码只在首次注册时使用。以后直接用手机号和密码登录。')).toBeTruthy();
  });

  it('邀请码与手机号共同换取注册挑战，并在任一项改变后清空旧企业挑战', async () => {
    const onRequestRegistrationCode = vi.fn(async () => ({
      challengeId: 'sms_1',
      message: '验证码已发送',
      retryAfterSeconds: 60,
      organization: { id: 'org_acme', name: '星河科技' },
    }));
    render(
      <EnterpriseLoginPage
        initialServerUrl="https://enterprise.otto.test"
        busy={false}
        error={null}
        onPasswordLogin={async () => undefined}
        onRequestRegistrationCode={onRequestRegistrationCode}
        onRegister={async () => undefined}
        onClearError={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '注册新账号' }));
    fireEvent.change(screen.getByLabelText('企业邀请码'), { target: { value: 'abcd-efgh' } });
    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13800138000' } });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));

    await waitFor(() => expect(onRequestRegistrationCode).toHaveBeenCalledWith({
      serverUrl: 'https://enterprise.otto.test',
      phone: '13800138000',
      inviteCode: 'ABCD-EFGH',
    }));
    expect(await screen.findByText('将加入「星河科技」')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '员工一号' } });
    fireEvent.change(screen.getByLabelText('设置登录密码'), { target: { value: 'password-1' } });
    fireEvent.change(screen.getByLabelText('确认登录密码'), { target: { value: 'password-1' } });
    fireEvent.change(screen.getByLabelText('短信验证码'), { target: { value: '042731' } });
    expect((screen.getByRole('button', { name: '创建账号并进入' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('企业邀请码'), { target: { value: 'WXYZ-2345' } });
    expect(screen.queryByText('将加入「星河科技」')).toBeNull();
    expect((screen.getByRole('button', { name: '创建账号并进入' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13900139000' } });
    expect((screen.getByRole('button', { name: '创建账号并进入' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('企业注册链接会自动切到首次注册并预填邀请码，仍使用 App 内置服务器', async () => {
    const onRequestRegistrationCode = vi.fn(async () => ({
      challengeId: 'sms_link',
      message: '验证码已发送',
      retryAfterSeconds: 60,
      organization: { id: 'org_acme', name: '星河科技' },
    }));
    const props = {
      initialServerUrl: 'https://enterprise.otto.test',
      busy: false,
      error: null,
      onPasswordLogin: async () => undefined,
      onRequestRegistrationCode,
      onRegister: async () => undefined,
      onClearError: () => undefined,
    };
    const view = render(
      <EnterpriseLoginPage {...props} initialInviteCode="ABCD-EFGH" />,
    );

    expect(screen.getByRole('heading', { name: '创建 Otto 账号' })).toBeTruthy();
    expect((screen.getByLabelText('企业邀请码') as HTMLInputElement).value).toBe('ABCD-EFGH');
    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13800138000' } });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
    await waitFor(() => expect(onRequestRegistrationCode).toHaveBeenCalledWith({
      serverUrl: 'https://enterprise.otto.test',
      phone: '13800138000',
      inviteCode: 'ABCD-EFGH',
    }));

    view.rerender(<EnterpriseLoginPage {...props} initialInviteCode="WXYZ-2345" />);
    expect((screen.getByLabelText('企业邀请码') as HTMLInputElement).value).toBe('WXYZ-2345');
    expect(screen.queryByText('将加入「星河科技」')).toBeNull();
  });

  it('隐藏 Electron IPC 技术前缀，只展示产品错误文案', () => {
    expect(
      friendlyAuthError(
        new Error("Error invoking remote method 'otto:enterprise-password-login': Error: 账号或密码错误"),
      ),
    ).toBe('账号或密码错误');
  });

  it('修改登录字段会清除旧错误，提交期间禁止重复提交与切换注册模式', async () => {
    let finishLogin!: () => void;
    const loginPending = new Promise<void>((resolve) => {
      finishLogin = resolve;
    });
    const onPasswordLogin = vi.fn(() => loginPending);
    const onClearError = vi.fn();
    render(
      <EnterpriseLoginPage
        initialServerUrl="https://enterprise.otto.test"
        busy={false}
        error="账号或密码错误"
        onPasswordLogin={onPasswordLogin}
        onRequestRegistrationCode={async () => ({
          challengeId: 'sms_1', message: '验证码已发送', retryAfterSeconds: 60,
          organization: { id: 'org_acme', name: '星河科技' },
        })}
        onRegister={async () => undefined}
        onClearError={onClearError}
      />,
    );

    fireEvent.change(screen.getByLabelText('账号或手机号'), {
      target: { value: 'staff01' },
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: 'password-1' },
    });
    expect(onClearError).toHaveBeenCalledTimes(2);

    const form = screen.getByRole('button', { name: '进入 Otto' }).closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(onPasswordLogin).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: '正在验证身份…' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', { name: '注册新账号' }) as HTMLButtonElement).disabled)
      .toBe(true);

    finishLogin();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '进入 Otto' }) as HTMLButtonElement).disabled)
        .toBe(false);
    });
  });

  it('邀请码或手机号改变后忽略晚到的验证码响应，切回登录时清除注册密码与验证码', async () => {
    let finishRequest!: (value: {
      challengeId: string;
      message: string;
      retryAfterSeconds: number;
      organization: { id: string; name: string };
    }) => void;
    const requestPending = new Promise<{
      challengeId: string;
      message: string;
      retryAfterSeconds: number;
      organization: { id: string; name: string };
    }>((resolve) => {
      finishRequest = resolve;
    });
    render(
      <EnterpriseLoginPage
        initialServerUrl="https://enterprise.otto.test"
        busy={false}
        error={null}
        onPasswordLogin={async () => undefined}
        onRequestRegistrationCode={() => requestPending}
        onRegister={async () => undefined}
        onClearError={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '注册新账号' }));
    fireEvent.change(screen.getByLabelText('企业邀请码'), {
      target: { value: 'ABCD-EFGH' },
    });
    fireEvent.change(screen.getByLabelText('手机号'), {
      target: { value: '13800138000' },
    });
    fireEvent.change(screen.getByLabelText('设置登录密码'), {
      target: { value: 'password-1' },
    });
    fireEvent.change(screen.getByLabelText('确认登录密码'), {
      target: { value: 'password-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));

    expect((screen.getByRole('button', { name: '发送中…' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', {
      name: '已有账号，返回登录',
    }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('手机号'), {
      target: { value: '13900139000' },
    });
    finishRequest({
      challengeId: 'stale_sms',
      message: '旧验证码已发送',
      retryAfterSeconds: 60,
      organization: { id: 'org_stale', name: '旧企业' },
    });

    await waitFor(() => {
      expect(screen.queryByText('将加入「旧企业」')).toBeNull();
      expect(screen.queryByText('旧验证码已发送')).toBeNull();
      expect((screen.getByRole('button', { name: '获取验证码' }) as HTMLButtonElement).disabled)
        .toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: '已有账号，返回登录' }));
    fireEvent.click(screen.getByRole('button', { name: '注册新账号' }));
    expect((screen.getByLabelText('设置登录密码') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('确认登录密码') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('短信验证码') as HTMLInputElement).value).toBe('');
  });
});
