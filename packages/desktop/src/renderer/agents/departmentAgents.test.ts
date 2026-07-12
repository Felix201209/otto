/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_AGENT_PROFILES,
  BASE_AGENT_PROFILES,
  DEPARTMENT_AGENT_PROFILES,
  DEPARTMENT_IDS,
  ENTERPRISE_CEO_PROFILE,
  ENTERPRISE_WORK_PROFILE,
  PERSONAL_OTTO_PROFILE,
  getDepartmentAgentProfiles,
  getPersonalAgentProfiles,
  getEnterpriseAgentProfiles,
} from './departmentAgents.js';

describe('v1.7 Agent profile 目录', () => {
  it('个人版基础目录包含 Otto、两个会议 Agent 与 8 位通用专家', () => {
    expect(PERSONAL_OTTO_PROFILE).toMatchObject({
      id: 'otto-personal',
      scope: 'personal',
      department: null,
    });
    expect(BASE_AGENT_PROFILES.map((profile) => profile.id)).toEqual([
      'otto-personal',
      'meeting-initiator',
      'meeting-notes-followup',
      'ppt',
      'meeting',
      'doc',
      'sheet',
      'pdf',
      'dataviz',
      'research',
      'copy',
    ]);
  });

  it('个人版 selector 不混入任何部门 Agent', () => {
    const personal = getPersonalAgentProfiles();

    expect(personal).toEqual(BASE_AGENT_PROFILES);
    expect(personal.every((profile) => profile.scope !== 'department')).toBe(true);
    expect(personal.every((profile) => profile.department === null)).toBe(true);
  });

  it('企业管理者的通用助手变为 CEO Agent，普通成员只看到本部门 Agent', () => {
    const owner = getEnterpriseAgentProfiles('company_owner');
    const member = getEnterpriseAgentProfiles('member', 'marketing');
    expect(owner[0]).toBe(ENTERPRISE_CEO_PROFILE);
    expect(owner).not.toContain(PERSONAL_OTTO_PROFILE);
    expect(member[0]).toBe(ENTERPRISE_WORK_PROFILE);
    expect(member.filter((profile) => profile.scope === 'department')).toHaveLength(4);
    expect(member.filter((profile) => profile.scope === 'department').every(
      (profile) => profile.department === 'marketing',
    )).toBe(true);
    for (const expertId of ['ppt', 'meeting', 'doc', 'sheet', 'pdf', 'dataviz', 'research', 'copy']) {
      expect(owner.some((profile) => profile.id === expertId)).toBe(true);
      expect(member.some((profile) => profile.id === expertId)).toBe(true);
    }
  });

  it.each(DEPARTMENT_IDS)('%s 部门恰好有 4 个基础 Agent', (department) => {
    const profiles = getDepartmentAgentProfiles(department);

    expect(profiles).toHaveLength(4);
    expect(profiles.every((profile) => profile.scope === 'department')).toBe(true);
    expect(profiles.every((profile) => profile.department === department)).toBe(true);
  });

  it('全目录 id 唯一且格式稳定', () => {
    const ids = ALL_AGENT_PROFILES.map((profile) => profile.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(ids).toHaveLength(37);
  });

  it('所有 profile 都有明确 skills 与 systemPrompt，且不含自动发送 kickoff', () => {
    expect(DEPARTMENT_AGENT_PROFILES).toHaveLength(DEPARTMENT_IDS.length * 4);
    for (const profile of ALL_AGENT_PROFILES) {
      expect(Array.isArray(profile.skills)).toBe(true);
      expect(profile.systemPrompt.trim().length).toBeGreaterThan(40);
      expect(profile).not.toHaveProperty('kickoff');
    }
  });
});
