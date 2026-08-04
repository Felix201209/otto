/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  classifyLoginFailure,
  resolvableLoginFailure,
  safePublicLoginFailureMessage,
  type LoginEvaluation,
} from './loginFailureDiagnosis.js';

const GENERIC = '账号或密码错误，请核对后重试';

describe('login failure diagnosis (NSI-06)', () => {
  it('未知账号 → 可解决，统一公开文案，不泄露存在性', () => {
    const issue = classifyLoginFailure({ accountFound: false });
    expect(issue).not.toBeNull();
    expect(issue!.kind).toBe('unknown_account');
    expect(issue!.resolvable).toBe(true);
    expect(issue!.publicMessage).toBe(GENERIC);
    expect(issue!.sensitiveDetail).toContain('未找到');
  });

  it('账号已删除（注销）→ account_deleted', () => {
    const issue = classifyLoginFailure({
      accountFound: true,
      accountDeleted: true,
    });
    expect(issue!.kind).toBe('account_deleted');
    expect(issue!.sensitiveDetail).toContain('已删除');
  });

  it('账号停用 → account_disabled', () => {
    const issue = classifyLoginFailure({
      accountFound: true,
      accountDeleted: false,
      accountDisabled: true,
      organizationActive: true,
    });
    expect(issue!.kind).toBe('account_disabled');
    expect(issue!.resolvable).toBe(true);
  });

  it('组织停用优先于账号停用判断 → organization_disabled', () => {
    const issue = classifyLoginFailure({
      accountFound: true,
      accountDeleted: false,
      accountDisabled: true,
      organizationActive: false,
    });
    expect(issue!.kind).toBe('organization_disabled');
  });

  it('密码错误 → wrong_password，可解决', () => {
    const issue = classifyLoginFailure({
      accountFound: true,
      accountDeleted: false,
      accountDisabled: false,
      organizationActive: true,
      passwordMatches: false,
    });
    expect(issue!.kind).toBe('wrong_password');
    expect(issue!.resolvable).toBe(true);
    expect(issue!.actionHint).toContain('忘记密码');
  });

  it('评估结果不构成登录失败 → 返回 null', () => {
    const issue = classifyLoginFailure({
      accountFound: true,
      accountDeleted: false,
      accountDisabled: false,
      organizationActive: true,
      passwordMatches: true,
    });
    expect(issue).toBeNull();
  });

  it('safePublicLoginFailureMessage 对所有原因均返回同一通用文案（反枚举）', () => {
    const cases: LoginEvaluation[] = [
      { accountFound: false },
      { accountFound: true, accountDeleted: true },
      { accountFound: true, accountDisabled: true, organizationActive: true },
      {
        accountFound: true,
        passwordMatches: false,
        organizationActive: true,
      },
    ];
    for (const evaluation of cases) {
      expect(safePublicLoginFailureMessage(evaluation)).toBe(GENERIC);
    }
  });

  it('未证明 identifier 归属时，sensitiveDetail 不得泄露', () => {
    const publicIssue = resolvableLoginFailure(
      { accountFound: false },
      false,
    );
    expect(publicIssue.sensitiveDetail).toBeNull();
    expect(publicIssue.publicMessage).toBe(GENERIC);
  });

  it('证明 identifier 归属后，才返回敏感诊断细节', () => {
    const proven = resolvableLoginFailure(
      { accountFound: true, accountDisabled: true, organizationActive: true },
      true,
    );
    expect(proven.kind).toBe('account_disabled');
    expect(proven.sensitiveDetail).toContain('停用');
    // 未证明时同一评估结果不泄露细节。
    const unproven = resolvableLoginFailure(
      { accountFound: true, accountDisabled: true, organizationActive: true },
      false,
    );
    expect(unproven.sensitiveDetail).toBeNull();
  });

  it('无法分类（不构成失败）时返回兜底诊断且不可解决', () => {
    const fallback = resolvableLoginFailure(
      { accountFound: false },
      true,
    );
    expect(fallback.resolvable).toBe(true);
    expect(fallback.publicMessage).toBe(GENERIC);
  });
});
