/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_PROFILES, resolveAgentProfile } from './agentProfiles.js';

describe('服务端 Agent profile 白名单', () => {
  it('覆盖个人 Otto、企业助手、会议 Agent、8 位通用专家和六部门各 4 个 profile', () => {
    expect(BUILTIN_AGENT_PROFILES).toHaveLength(37);
    expect(BUILTIN_AGENT_PROFILES.filter((item) => item.scope === 'base')).toHaveLength(13);
    expect(BUILTIN_AGENT_PROFILES.filter((item) => item.scope === 'department')).toHaveLength(24);
    expect(resolveAgentProfile('otto-personal')).toMatchObject({ edition: 'personal' });
    expect(resolveAgentProfile('otto-enterprise-ceo')).toMatchObject({
      name: 'CEO Agent', edition: 'enterprise', roles: ['company_owner', 'company_admin'],
    });
    expect(resolveAgentProfile('otto-enterprise-work')).toMatchObject({ edition: 'enterprise' });
    for (const id of ['ppt', 'meeting', 'doc', 'sheet', 'pdf', 'dataviz', 'research', 'copy']) {
      expect(resolveAgentProfile(id)).toMatchObject({ scope: 'base', edition: 'both' });
    }
  });

  it('会议 Agent 使用 system prompt，未知或客户端自造 profile 不会被接受', () => {
    expect(resolveAgentProfile('meeting-initiator')).toMatchObject({
      name: '会议发起 Agent',
      systemPrompt: expect.stringContaining('会议'),
    });
    expect(resolveAgentProfile('meeting-notes-followup')?.systemPrompt).toContain('纪要');
    expect(resolveAgentProfile('evil-client-prompt')).toBeUndefined();
  });
});
