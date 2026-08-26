/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { EnterpriseOrganizationFeatures } from '../preload/index.js';
import type { AgentProfile } from './agents/departmentAgents.js';
import type { CustomAgentDefinition } from './customAgents.js';
import type { ModuleIconKey } from './components/ModuleIcon.js';

export type ModuleAvailability = 'available' | 'disabled' | 'hidden';
export type ModuleCategory = 'common' | 'park' | 'capability' | 'custom-agent';

export type ParkModuleTarget =
  | 'overview'
  | 'announcement'
  | 'satisfaction'
  | 'renovation'
  | 'parking'
  | 'network-phone'
  | 'meeting-room'
  | 'electric-card'
  | 'repair'
  | 'vehicle-visit'
  | 'staff-tasks'
  | 'my-applications';

export type ModuleActivation =
  | { kind: 'dialog'; dialog: 'park'; target: ParkModuleTarget }
  | { kind: 'dialog'; dialog: 'enterprise-memory' | 'auto-skill' }
  | { kind: 'route'; route: 'skill-zone' }
  | { kind: 'agent'; profileId: string; customAgentId?: string };

export interface ParkModuleAuthorization {
  hasParkContext: boolean;
  canViewStatistics: boolean;
  canViewStaffTasks: boolean;
}

export interface ModuleCatalogContext {
  edition: 'personal' | 'enterprise';
  profiles: readonly AgentProfile[];
  organizationFeatures: EnterpriseOrganizationFeatures | null;
  parkAuthorization: ParkModuleAuthorization;
  customAgents: readonly CustomAgentDefinition[];
}

export interface ModuleDefinition {
  id: string;
  label: string;
  description?: string;
  category: ModuleCategory;
  icon: ModuleIconKey;
  activation: ModuleActivation;
  availability: ModuleAvailability;
  disabledReason?: string;
}

type StaticAvailabilityRule =
  | 'park'
  | 'park-statistics'
  | 'park-staff'
  | 'enterprise-memory'
  | 'auto-skill'
  | 'skill-zone';

interface StaticModuleSpec extends Omit<ModuleDefinition, 'availability' | 'disabledReason'> {
  availabilityRule: StaticAvailabilityRule;
}

export const STATIC_MODULE_SPECS: readonly StaticModuleSpec[] = [
  {
    id: 'park-overview', label: '园区服务统计', category: 'park', icon: 'park-overview',
    activation: { kind: 'dialog', dialog: 'park', target: 'overview' },
    availabilityRule: 'park-statistics',
  },
  {
    id: 'park-announcement', label: '园区公告', category: 'park', icon: 'park-announcement',
    activation: { kind: 'dialog', dialog: 'park', target: 'announcement' },
    availabilityRule: 'park',
  },
  {
    id: 'park-satisfaction', label: '满意度调查', category: 'park', icon: 'park-satisfaction',
    activation: { kind: 'dialog', dialog: 'park', target: 'satisfaction' },
    availabilityRule: 'park',
  },
  {
    id: 'park-renovation', label: '装修管理', category: 'park', icon: 'park-renovation',
    activation: { kind: 'dialog', dialog: 'park', target: 'renovation' },
    availabilityRule: 'park',
  },
  {
    id: 'park-parking', label: '停车办理', category: 'park', icon: 'park-parking',
    activation: { kind: 'dialog', dialog: 'park', target: 'parking' },
    availabilityRule: 'park',
  },
  {
    id: 'park-network-phone', label: '网络与固话', category: 'park', icon: 'park-network-phone',
    activation: { kind: 'dialog', dialog: 'park', target: 'network-phone' },
    availabilityRule: 'park',
  },
  {
    id: 'park-meeting-room', label: '会议室预约', category: 'park', icon: 'park-meeting-room',
    activation: { kind: 'dialog', dialog: 'park', target: 'meeting-room' },
    availabilityRule: 'park',
  },
  {
    id: 'park-electric-card', label: '电卡服务', category: 'park', icon: 'park-electric-card',
    activation: { kind: 'dialog', dialog: 'park', target: 'electric-card' },
    availabilityRule: 'park',
  },
  {
    id: 'park-repair', label: '物业报修', category: 'park', icon: 'park-repair',
    activation: { kind: 'dialog', dialog: 'park', target: 'repair' },
    availabilityRule: 'park',
  },
  {
    id: 'park-vehicle-visit', label: '车辆与访客', category: 'park', icon: 'park-vehicle-visit',
    activation: { kind: 'dialog', dialog: 'park', target: 'vehicle-visit' },
    availabilityRule: 'park',
  },
  {
    id: 'park-staff-tasks', label: '园区待办', category: 'park', icon: 'park-staff-tasks',
    activation: { kind: 'dialog', dialog: 'park', target: 'staff-tasks' },
    availabilityRule: 'park-staff',
  },
  {
    id: 'park-my-applications', label: '我的申请', category: 'park', icon: 'park-my-applications',
    activation: { kind: 'dialog', dialog: 'park', target: 'my-applications' },
    availabilityRule: 'park',
  },
  {
    id: 'enterprise-memory', label: '企业记忆', category: 'capability', icon: 'enterprise-memory',
    activation: { kind: 'dialog', dialog: 'enterprise-memory' },
    availabilityRule: 'enterprise-memory',
  },
  {
    id: 'auto-skill', label: '自动 Skill', category: 'capability', icon: 'auto-skill',
    activation: { kind: 'dialog', dialog: 'auto-skill' },
    availabilityRule: 'auto-skill',
  },
  {
    id: 'skill-zone', label: 'Skill 专区', category: 'capability', icon: 'skill-zone',
    activation: { kind: 'route', route: 'skill-zone' },
    availabilityRule: 'skill-zone',
  },
] as const;

const PROFILE_MODULE_IDS: Readonly<Record<string, string>> = {
  'otto-personal': 'agent-personal-otto',
  'otto-enterprise-work': 'agent-enterprise-work',
  'self-development': 'agent-self-development',
  ppt: 'agent-ppt',
  meeting: 'agent-meeting',
  doc: 'agent-word',
  sheet: 'agent-excel',
  pdf: 'agent-pdf',
  dataviz: 'agent-dataviz',
  research: 'agent-research',
  copy: 'agent-copy',
};

function staticAvailability(
  rule: StaticAvailabilityRule,
  context: ModuleCatalogContext,
): ModuleAvailability {
  if (rule === 'auto-skill') return 'available';
  if (context.edition !== 'enterprise') return 'hidden';

  if (rule === 'enterprise-memory') {
    return context.organizationFeatures?.knowledge ? 'available' : 'hidden';
  }
  if (rule === 'skill-zone') {
    return context.organizationFeatures?.skill_market ? 'available' : 'hidden';
  }
  if (!context.organizationFeatures?.park_service || !context.parkAuthorization.hasParkContext) {
    return 'hidden';
  }
  if (rule === 'park-statistics' && !context.parkAuthorization.canViewStatistics) {
    return 'hidden';
  }
  if (rule === 'park-staff' && !context.parkAuthorization.canViewStaffTasks) {
    return 'hidden';
  }
  return 'available';
}

function profileIcon(profile: AgentProfile): ModuleIconKey {
  if (profile.icon) return `generated:${profile.icon}`;
  if (profile.id === 'otto-personal') return 'otto-avatar';
  if (profile.id === 'self-development') return 'self-development';
  return 'agent';
}

function profileIsAllowed(profile: AgentProfile, edition: ModuleCatalogContext['edition']): boolean {
  if (edition === 'personal') return profile.id === 'otto-personal';
  return profile.id !== 'otto-personal' && Boolean(PROFILE_MODULE_IDS[profile.id]);
}

function agentModules(context: ModuleCatalogContext): ModuleDefinition[] {
  return context.profiles
    .filter((profile) => profileIsAllowed(profile, context.edition))
    .flatMap((profile) => {
      const moduleId = PROFILE_MODULE_IDS[profile.id];
      if (!moduleId) return [];
      return [{
        id: moduleId,
        label: profile.name,
        description: profile.tagline,
        category: 'common' as const,
        icon: profileIcon(profile),
        activation: { kind: 'agent' as const, profileId: profile.id },
        availability: 'available' as const,
      }];
    });
}

function customAgentModules(context: ModuleCatalogContext): ModuleDefinition[] {
  const baseProfileId = context.edition === 'enterprise'
    ? 'otto-enterprise-work'
    : 'otto-personal';
  return context.customAgents.map((agent) => ({
    id: `agent-${agent.id}`,
    label: agent.name,
    description: agent.instructions,
    category: 'custom-agent',
    icon: 'custom-agent',
    activation: {
      kind: 'agent',
      profileId: baseProfileId,
      customAgentId: agent.id,
    },
    availability: 'available',
  }));
}

export function buildModuleCatalog(context: ModuleCatalogContext): ModuleDefinition[] {
  const staticModules = STATIC_MODULE_SPECS.map(({ availabilityRule, ...module }) => ({
    ...module,
    availability: staticAvailability(availabilityRule, context),
  }));
  const result = [...staticModules, ...agentModules(context), ...customAgentModules(context)];
  const seen = new Set<string>();
  return result.filter((module) => {
    if (seen.has(module.id)) return false;
    seen.add(module.id);
    return true;
  });
}
