/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { isCustomAgentIcon, type CustomAgentIcon } from './customAgentIcons.js';

export interface CustomAgentDefinition {
  id: string;
  name: string;
  instructions: string;
  createdAt: string;
  icon?: CustomAgentIcon;
}

export interface CustomAgentDraft {
  name: string;
  instructions: string;
  icon?: CustomAgentIcon;
}

const MAX_CUSTOM_AGENTS = 12;
const MAX_NAME_LENGTH = 40;
const MAX_INSTRUCTIONS_LENGTH = 2_000;
const SAFE_ID = /^custom-[A-Za-z0-9_-]{1,80}$/;

export function customAgentStorageKey(
  organizationId: string,
  accountId: string,
): string {
  return [
    'otto.custom-agents.v1',
    encodeURIComponent(organizationId.trim() || 'personal'),
    encodeURIComponent(accountId.trim() || 'anonymous'),
  ].join(':');
}

export function createCustomAgent(
  draft: CustomAgentDraft,
  options: { id: string; now: string },
): CustomAgentDefinition {
  const name = draft.name.trim();
  const instructions = draft.instructions.trim();
  if (!name) throw new Error('请输入专家名称');
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`专家名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  if (!instructions) throw new Error('请输入职责说明');
  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new Error(`职责说明不能超过 ${MAX_INSTRUCTIONS_LENGTH} 个字符`);
  }
  if (!SAFE_ID.test(options.id)) throw new Error('专家编号格式不正确');
  if (!Number.isFinite(Date.parse(options.now))) throw new Error('创建时间格式不正确');
  if (draft.icon !== undefined && !isCustomAgentIcon(draft.icon)) {
    throw new Error('专家图标格式不正确');
  }
  return {
    id: options.id,
    name,
    instructions,
    createdAt: options.now,
    ...(draft.icon ? { icon: draft.icon } : {}),
  };
}

function isCustomAgent(value: unknown): value is CustomAgentDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string'
    && SAFE_ID.test(item.id)
    && typeof item.name === 'string'
    && item.name.trim().length > 0
    && item.name.length <= MAX_NAME_LENGTH
    && typeof item.instructions === 'string'
    && item.instructions.trim().length > 0
    && item.instructions.length <= MAX_INSTRUCTIONS_LENGTH
    && typeof item.createdAt === 'string'
    && Number.isFinite(Date.parse(item.createdAt))
  );
}

export function parseCustomAgents(raw: string | null | undefined): CustomAgentDefinition[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: CustomAgentDefinition[] = [];
    for (const item of parsed) {
      if (!isCustomAgent(item) || seen.has(item.id)) continue;
      seen.add(item.id);
      result.push({
        id: item.id,
        name: item.name.trim(),
        instructions: item.instructions.trim(),
        createdAt: item.createdAt,
        ...(isCustomAgentIcon(item.icon) ? { icon: item.icon } : {}),
      });
      if (result.length >= MAX_CUSTOM_AGENTS) break;
    }
    return result;
  } catch {
    return [];
  }
}

export function buildCustomAgentKickoff(
  agent: CustomAgentDefinition,
  identity: {
    edition: 'personal' | 'enterprise';
    organizationName?: string | null;
    department?: string | null;
    positionTitle?: string | null;
  },
): string {
  const identityLines = identity.edition === 'enterprise'
    ? [
      `企业：${identity.organizationName?.trim() || '当前已认证企业'}`,
      `部门：${identity.department?.trim() || '未分配部门'}`,
      `职位：${identity.positionTitle?.trim() || '未指定职位'}`,
    ]
    : ['身份：当前个人账号'];
  return [
    `请在本会话中作为用户创建的工作专家「${agent.name}」协助完成任务。`,
    '',
    '职责说明：',
    agent.instructions,
    '',
    '当前真实身份：',
    ...identityLines,
    '',
    '安全与真实性边界：',
    '- 这个自定义名称只定义工作分工，不获得任何额外账号、部门、数据或操作权限。',
    '- 只能使用当前登录账号已经获授权的资料与工具；跨部门、外发、花钱或影响他人的操作仍需明确确认。',
    '- 不得编造已读取的数据、已执行的动作或交付结果，失败时说明真实原因。',
    '',
    `先用一句话确认你将作为「${agent.name}」工作，再询问用户现在要完成的第一项具体任务。`,
  ].join('\n');
}
