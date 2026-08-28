import { describe, expect, it } from 'vitest';

import type { EnterpriseOrganizationFeatures } from '../preload/index.js';
import {
  BASE_AGENT_PROFILES,
  COMMON_EXPERT_PROFILES,
  ENTERPRISE_WORK_PROFILE,
  SELF_DEVELOPMENT_PROFILE,
} from './agents/departmentAgents.js';
import {
  buildModuleCatalog,
  STATIC_MODULE_SPECS,
  type ModuleCatalogContext,
} from './moduleCatalog.js';

const enabledFeatures: EnterpriseOrganizationFeatures = {
  enterprise_tree: true,
  park_service: true,
  feishu_auto_reply: true,
  direct_messages: true,
  atoa: true,
  knowledge: true,
  skill_market: true,
};

function enterpriseContext(
  overrides: Partial<ModuleCatalogContext> = {},
): ModuleCatalogContext {
  return {
    edition: 'enterprise',
    profiles: [ENTERPRISE_WORK_PROFILE, SELF_DEVELOPMENT_PROFILE, ...COMMON_EXPERT_PROFILES],
    organizationFeatures: enabledFeatures,
    parkAuthorization: {
      hasParkContext: true,
      canViewStatistics: true,
      canViewStaffTasks: true,
    },
    customAgents: [],
    ...overrides,
  };
}

describe('static module catalog', () => {
  it('uses unique IDs and complete metadata without organization/contact entries', () => {
    const ids = STATIC_MODULE_SPECS.map((module) => module.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(STATIC_MODULE_SPECS.every((module) => (
      module.label.trim()
      && module.category
      && module.activation.kind
      && module.icon
    ))).toBe(true);
    expect(ids.some((id) => /organization|contact|friend/i.test(id))).toBe(false);
  });

  it('maps each fixed agent from its existing profile instead of duplicating profile data', () => {
    const catalog = buildModuleCatalog(enterpriseContext());
    const ppt = catalog.find((module) => module.id === 'agent-ppt');

    expect(ppt).toMatchObject({
      label: COMMON_EXPERT_PROFILES.find((profile) => profile.id === 'ppt')?.name,
      activation: { kind: 'agent', profileId: 'ppt' },
      availability: 'available',
    });
  });
});

describe('capability-driven availability', () => {
  it('fails closed for enterprise features while preserving supplied agent profiles', () => {
    const catalog = buildModuleCatalog(enterpriseContext({ organizationFeatures: null }));

    expect(catalog.find((module) => module.id === 'enterprise-memory')?.availability).toBe('hidden');
    expect(catalog.find((module) => module.id === 'skill-zone')?.availability).toBe('hidden');
    expect(catalog.find((module) => module.id === 'park-announcement')?.availability).toBe('hidden');
    expect(catalog.find((module) => module.id === 'agent-ppt')?.availability).toBe('available');
  });

  it('never exposes park staff/statistics modules without their existing authorization', () => {
    const catalog = buildModuleCatalog(enterpriseContext({
      parkAuthorization: {
        hasParkContext: true,
        canViewStatistics: false,
        canViewStaffTasks: false,
      },
    }));

    expect(catalog.find((module) => module.id === 'park-overview')?.availability).toBe('hidden');
    expect(catalog.find((module) => module.id === 'park-staff-tasks')?.availability).toBe('hidden');
    expect(catalog.find((module) => module.id === 'park-announcement')?.availability).toBe('available');
  });

  it('keeps personal edition free of enterprise and park capabilities', () => {
    const catalog = buildModuleCatalog({
      edition: 'personal',
      profiles: BASE_AGENT_PROFILES,
      organizationFeatures: enabledFeatures,
      parkAuthorization: {
        hasParkContext: true,
        canViewStatistics: true,
        canViewStaffTasks: true,
      },
      customAgents: [],
    });
    const availableIds = catalog
      .filter((module) => module.availability === 'available')
      .map((module) => module.id);

    expect(availableIds).toContain('agent-personal-otto');
    expect(availableIds).toContain('auto-skill');
    expect(availableIds.some((id) => id.startsWith('park-'))).toBe(false);
    expect(availableIds).not.toContain('enterprise-memory');
    expect(availableIds).not.toContain('skill-zone');
  });

  it('does not let caller-supplied personal profiles widen enterprise capabilities', () => {
    const catalog = buildModuleCatalog({
      edition: 'personal',
      profiles: [ENTERPRISE_WORK_PROFILE, ...COMMON_EXPERT_PROFILES],
      organizationFeatures: enabledFeatures,
      parkAuthorization: {
        hasParkContext: true,
        canViewStatistics: true,
        canViewStaffTasks: true,
      },
      customAgents: [],
    });

    expect(catalog.find((module) => module.id === 'agent-ppt')?.availability).not.toBe('available');
    expect(catalog.find((module) => module.id === 'agent-enterprise-work')?.availability).not.toBe('available');
  });
});

describe('custom expert modules', () => {
  it('creates dynamic agent modules without mutating their stored definitions', () => {
    const customAgent = {
      id: 'custom-bid-helper',
      name: '招投标助手',
      instructions: '整理招投标材料',
      createdAt: '2026-08-26T00:00:00.000Z',
      icon: { kind: 'preset' as const, name: 'agent-customer-success' as const },
    };
    const before = structuredClone(customAgent);
    const catalog = buildModuleCatalog(enterpriseContext({ customAgents: [customAgent] }));

    expect(catalog.find((module) => module.id === 'agent-custom-bid-helper')).toMatchObject({
      label: '招投标助手',
      category: 'custom-agent',
      activation: {
        kind: 'agent',
        profileId: 'otto-enterprise-work',
        customAgentId: 'custom-bid-helper',
      },
      icon: 'generated:agent-customer-success',
      availability: 'available',
    });
    expect(customAgent).toEqual(before);
  });
});
