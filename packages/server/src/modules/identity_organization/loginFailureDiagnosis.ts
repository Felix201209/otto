/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 登录失败「可解决原因」诊断（NSI-06）。
 *
 * 目标：把登录失败从「一刀切」升级为一组可操作、可解决的诊断原因，
 * 同时坚守反账号枚举（anti-enumeration）底线：
 *  - 未验证身份调用方（公开登录端点）永远只拿到统一的通用文案；
 *  - 只有「能证明自己掌握该 identifier」的调用方（例如已通过该账号的
 *    SMS 挑战、或已存在绑定到该账号的有效会话）才能看到账号存在性细节。
 *
 * 本模块为纯函数、无副作用、不访问数据库——输入是一份描述登录评估结果
 * 的普通对象，因此可完全脱离数据库进行单元测试。
 */

/** 登录失败的可诊断原因分类。 */
export type LoginFailureKind =
  | 'unknown_account'
  | 'wrong_password'
  | 'account_disabled'
  | 'account_deleted'
  | 'organization_disabled';

/** 由调用方（认证层）提供的、描述一次登录评估结果的原始事实。 */
export interface LoginEvaluation {
  /** 是否按 identifier 找到账号记录（含已删除/禁用，不含被反枚举屏蔽的情况）。 */
  accountFound: boolean;
  /** 找到的账号是否处于 deleted 状态。 */
  accountDeleted?: boolean;
  /** 找到的账号 status 是否为 disabled。 */
  accountDisabled?: boolean;
  /** 找到的账号所属组织是否 active。 */
  organizationActive?: boolean;
  /** 提供密码是否与存储哈希匹配。 */
  passwordMatches?: boolean;
}

/** 一条可解决原因。 */
export interface ResolvableLoginIssue {
  kind: LoginFailureKind;
  resolvable: boolean;
  /** 统一对外文案——不泄露账号存在性，公开端点可用。 */
  publicMessage: string;
  /** 可向用户展示、指引如何自行解决的操作提示。 */
  actionHint: string;
  /** 仅当调用方证明 identifier 归属时才暴露的细节（可能泄露账号存在性）。 */
  sensitiveDetail: string | null;
}

const GENERIC_PUBLIC_MESSAGE = '账号或密码错误，请核对后重试';

function classify(evaluation: LoginEvaluation): ResolvableLoginIssue | null {
  if (!evaluation.accountFound) {
    return {
      kind: 'unknown_account',
      resolvable: true,
      publicMessage: GENERIC_PUBLIC_MESSAGE,
      actionHint: '请核对用户名或手机号是否正确；若从未注册，请联系企业管理员开通账号。',
      sensitiveDetail: '未找到与该登录标识匹配的账号记录。',
    };
  }
  if (evaluation.accountDeleted) {
    return {
      kind: 'account_deleted',
      resolvable: true,
      publicMessage: GENERIC_PUBLIC_MESSAGE,
      actionHint: '该账号已被注销。如为误操作，请联系企业管理员恢复。',
      sensitiveDetail: '账号处于已删除（注销）状态。',
    };
  }
  if (evaluation.organizationActive === false) {
    return {
      kind: 'organization_disabled',
      resolvable: true,
      publicMessage: GENERIC_PUBLIC_MESSAGE,
      actionHint: '企业工作区当前不可用，请联系系统管理员确认服务状态。',
      sensitiveDetail: '账号所属企业工作区处于停用状态。',
    };
  }
  if (evaluation.accountDisabled) {
    return {
      kind: 'account_disabled',
      resolvable: true,
      publicMessage: GENERIC_PUBLIC_MESSAGE,
      actionHint: '账号已被停用，请联系企业管理员重新启用。',
      sensitiveDetail: '账号处于停用（disabled）状态。',
    };
  }
  if (evaluation.passwordMatches === false) {
    return {
      kind: 'wrong_password',
      resolvable: true,
      publicMessage: GENERIC_PUBLIC_MESSAGE,
      actionHint: '密码不正确。可使用“忘记密码”重置，或联系企业管理员。',
      sensitiveDetail: '登录标识存在，但密码不匹配。',
    };
  }
  // 未提供 passwordMatches（例如纯存在性探测）——不视为登录失败。
  return null;
}

/**
 * 分类一次登录失败。返回 null 表示评估结果并不构成登录失败
 * （例如调用方只做存在性探测且未评估密码）。
 */
export function classifyLoginFailure(
  evaluation: LoginEvaluation,
): ResolvableLoginIssue | null {
  return classify(evaluation);
}

/**
 * 面向公开/未证明身份调用方的安全失败文案。
 * 无论失败原因如何，返回的字符串恒定统一，绝不泄露账号存在性。
 */
export function safePublicLoginFailureMessage(
  evaluation: LoginEvaluation,
): string {
  return classify(evaluation)?.publicMessage ?? GENERIC_PUBLIC_MESSAGE;
}

/**
 * 面向「已证明掌握该 identifier」调用方的可解决原因诊断。
 * 仅当 `proofOfIdentifierControl` 为 true（例如已通过该账号的 SMS 挑战、
 * 或已有绑定到该账号的有效会话）时，才返回包含 sensitiveDetail 的完整
 * 诊断；否则降级为统一的通用文案（sensitiveDetail 置 null）。
 */
export function resolvableLoginFailure(
  evaluation: LoginEvaluation,
  proofOfIdentifierControl: boolean,
): ResolvableLoginIssue {
  const base = classify(evaluation);
  if (!base) {
    return {
      kind: 'unknown_account',
      resolvable: false,
      publicMessage: GENERIC_PUBLIC_MESSAGE,
      actionHint: '登录失败。',
      sensitiveDetail: null,
    };
  }
  if (!proofOfIdentifierControl) {
    return { ...base, sensitiveDetail: null };
  }
  return base;
}
