/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * enterprise_collaboration 的 renderer 可信中继。Core 只提出结构化意图；
 * 本模块在当前登录身份下重新读取企业树、执行真实 IPC，并把真实结果回传。
 */

import type {
  EnterpriseAccount,
  EnterpriseAccountUpdateInput,
  EnterpriseDirectMessage,
  EnterpriseOrganizationView,
} from '../preload/index.js';
import { buildAtoaRequest } from './atoaProtocol.js';

export type EnterpriseCollaborationRelayParams =
  | { action: 'list_members' }
  | { action: 'list_messages'; recipientAccountId: string }
  | {
      action: 'send_message';
      recipientAccountId: string;
      content: string;
    }
  | {
      action: 'ask_peer_otto';
      recipientAccountId: string;
      question: string;
    }
  | {
      action: 'consult_peer_otto';
      recipientAccountId: string;
      question: string;
    }
  | {
      action: 'assign_member_position';
      recipientAccountId: string;
      department: string;
      positionTitle: string;
      role?: string;
    };

type Member = EnterpriseOrganizationView['members'][number];

export interface EnterpriseCollaborationRelayDependencies {
  getOrganizationView(): Promise<EnterpriseOrganizationView>;
  listMessages(peerAccountId: string): Promise<EnterpriseDirectMessage[]>;
  sendMessage(
    peerAccountId: string,
    content: string,
  ): Promise<EnterpriseDirectMessage>;
  requestConsult(
    member: Member,
    question: string,
  ): Promise<EnterpriseDirectMessage>;
  updateAccount(
    accountId: string,
    input: Pick<EnterpriseAccountUpdateInput, 'department' | 'positionTitle' | 'role'>,
  ): Promise<EnterpriseAccount>;
}
const RECIPIENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ACTIONS = new Set([
  'list_members',
  'list_messages',
  'send_message',
  'ask_peer_otto',
  'consult_peer_otto',
  'assign_member_position',
]);

const ACTION_FIELDS: Record<EnterpriseCollaborationRelayParams['action'], ReadonlySet<string>> = {
  list_members: new Set(['action']),
  list_messages: new Set(['action', 'recipientAccountId']),
  send_message: new Set(['action', 'recipientAccountId', 'content']),
  ask_peer_otto: new Set(['action', 'recipientAccountId', 'question']),
  consult_peer_otto: new Set(['action', 'recipientAccountId', 'question']),
  assign_member_position: new Set([
    'action',
    'recipientAccountId',
    'department',
    'positionTitle',
    'role',
  ]),
};

function assignmentText(
  value: unknown,
  field: 'department' | 'positionTitle' | 'role',
): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) {
    throw new Error(`${field} 长度必须为 1 到 160 个字符`);
  }
  return value.trim();
}

function parseParams(value: unknown): EnterpriseCollaborationRelayParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('enterprise_collaboration 参数必须是对象');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.action !== 'string' || !ACTIONS.has(raw.action)) {
    throw new Error('enterprise_collaboration action 无效');
  }
  const action = raw.action as EnterpriseCollaborationRelayParams['action'];
  const unknownFields = Object.keys(raw).filter(
    (field) => !ACTION_FIELDS[action].has(field),
  );
  if (unknownFields.length > 0) {
    throw new Error(`enterprise_collaboration 不接受未知字段：${unknownFields.join(', ')}`);
  }
  if (action === 'list_members') return { action };

  if (
    typeof raw.recipientAccountId !== 'string' ||
    !RECIPIENT_ID.test(raw.recipientAccountId)
  ) {
    throw new Error('recipientAccountId 无效，必须使用企业树返回的账号 ID');
  }
  if (action === 'list_messages') {
    return { action, recipientAccountId: raw.recipientAccountId };
  }
  if (action === 'send_message') {
    if (
      typeof raw.content !== 'string' ||
      !raw.content.trim() ||
      raw.content.length > 4000
    ) {
      throw new Error('content 长度必须为 1 到 4000 个字符');
    }
    return {
      action,
      recipientAccountId: raw.recipientAccountId,
      content: raw.content.trim(),
    };
  }
  if (action === 'assign_member_position') {
    return {
      action,
      recipientAccountId: raw.recipientAccountId,
      department: assignmentText(raw.department, 'department'),
      positionTitle: assignmentText(raw.positionTitle, 'positionTitle'),
      ...(raw.role === undefined
        ? {}
        : { role: assignmentText(raw.role, 'role') }),
    };
  }
  if (
    typeof raw.question !== 'string' ||
    !raw.question.trim() ||
    raw.question.length > 4000
  ) {
    throw new Error('question 长度必须为 1 到 4000 个字符');
  }
  return {
    action,
    recipientAccountId: raw.recipientAccountId,
    question: raw.question.trim(),
  };
}

function publicMember(member: Member): {
  id: string;
  username: string;
  name: string;
  department: string | null;
  positionTitle: string | null;
  role: string | null;
  isAdmin: boolean;
} {
  return {
    id: member.id,
    username: member.username,
    name: member.name,
    department: member.department,
    positionTitle: member.positionTitle ?? null,
    role: member.role,
    isAdmin: member.isAdmin,
  };
}

async function currentOrganization(
  account: EnterpriseAccount,
  deps: EnterpriseCollaborationRelayDependencies,
): Promise<EnterpriseOrganizationView> {
  if (
    account.accountType === 'personal' ||
    !account.organizationId ||
    account.organizationId.startsWith('personal_')
  ) {
    throw new Error('enterprise_collaboration 仅企业账号可用');
  }
  const view = await deps.getOrganizationView();
  if (
    !view.organization ||
    view.organization.id !== account.organizationId ||
    view.organization.status !== 'active'
  ) {
    throw new Error('当前企业组织身份不可用，请重新登录');
  }
  return view;
}

async function activePeer(
  account: EnterpriseAccount,
  recipientAccountId: string,
  deps: EnterpriseCollaborationRelayDependencies,
): Promise<Member> {
  const view = await currentOrganization(account, deps);
  const member = view.members.find(
    (candidate) =>
      candidate.id === recipientAccountId &&
      candidate.status === 'active' &&
      candidate.id !== account.id,
  );
  if (!member) {
    throw new Error('目标账号不在当前企业组织树，或已经停用');
  }
  return member;
}

export async function executeEnterpriseCollaborationRelay(
  rawParams: unknown,
  account: EnterpriseAccount,
  deps: EnterpriseCollaborationRelayDependencies,
): Promise<Record<string, unknown>> {
  const params = parseParams(rawParams);
  if (params.action === 'list_members') {
    const view = await currentOrganization(account, deps);
    return {
      ok: true,
      organization: view.organization
        ? { id: view.organization.id, name: view.organization.name }
        : null,
      members: view.members
        .filter((member) => member.status === 'active')
        .map(publicMember),
    };
  }

  const member = await activePeer(
    account,
    params.recipientAccountId,
    deps,
  );
  if (params.action === 'assign_member_position') {
    if (!account.isAdmin) {
      throw new Error('assign_member_position 仅企业管理员可执行');
    }
    const updated = await deps.updateAccount(member.id, {
      department: params.department,
      positionTitle: params.positionTitle,
      ...(params.role === undefined ? {} : { role: params.role }),
    });
    return {
      ok: true,
      action: params.action,
      member: publicMember(updated),
    };
  }
  if (params.action === 'list_messages') {
    return {
      ok: true,
      action: params.action,
      peer: publicMember(member),
      messages: await deps.listMessages(member.id),
    };
  }
  if (params.action === 'send_message') {
    return {
      ok: true,
      action: params.action,
      message: await deps.sendMessage(member.id, params.content),
    };
  }
  if (params.action === 'ask_peer_otto') {
    const message = await deps.sendMessage(
      member.id,
      buildAtoaRequest(params.question, { mode: 'answer' }),
    );
    return {
      ok: true,
      action: params.action,
      status: 'waiting_for_peer_permission',
      message,
    };
  }

  const message = await deps.requestConsult(member, params.question);
  return {
    ok: true,
    action: params.action,
    status: 'waiting_for_peer_permission',
    message,
  };
}
