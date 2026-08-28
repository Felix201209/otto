/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentProfile } from '../agents/departmentAgents.js';
import type { CustomAgentDefinition } from '../customAgents.js';
import { buildModuleCatalog, type InstalledCustomerModuleSummary, type ModuleDefinition, type ParkModuleAuthorization } from '../moduleCatalog.js';
import { normalizeServerUrlForStorage } from '../moduleWorkspace.js';
import { getEnterpriseOrganizationFeatures } from './enterpriseOrganizationFeatures.js';
import type { EnterpriseOrganizationFeatures } from '../../preload/index.js';

interface CapabilityState {
  key: string;
  status: 'loading' | 'ready' | 'failed';
  features: Awaited<ReturnType<typeof getEnterpriseOrganizationFeatures>> | null;
  park: ParkModuleAuthorization;
}

const NO_PARK: ParkModuleAuthorization = {
  hasParkContext: false,
  canViewStatistics: false,
  canViewStaffTasks: false,
};

const INTERNAL_ADMIN_PREVIEW_FEATURES: EnterpriseOrganizationFeatures = {
  enterprise_tree: true,
  park_service: true,
  feishu_auto_reply: true,
  direct_messages: true,
  atoa: true,
  knowledge: true,
  skill_market: true,
};

const INTERNAL_ADMIN_PREVIEW_PARK: ParkModuleAuthorization = {
  hasParkContext: true,
  canViewStatistics: true,
  canViewStaffTasks: true,
};

export function useModuleWorkspaceCapabilities(input: {
  edition: 'personal' | 'enterprise';
  serverUrl: string;
  organizationId?: string | null;
  accountId: string;
  accountIsAdmin?: boolean;
  internalAdminPreview?: boolean;
  profiles: readonly AgentProfile[];
  customAgents: readonly CustomAgentDefinition[];
  customerModules?: readonly InstalledCustomerModuleSummary[];
}): {
  status: CapabilityState['status'];
  ready: boolean;
  modules: ModuleDefinition[];
  retry(): void;
} {
  const key = [
    normalizeServerUrlForStorage(input.serverUrl),
    input.edition,
    input.organizationId?.trim() || 'personal',
    input.accountId.trim() || 'anonymous',
    input.accountIsAdmin ? 'admin' : 'member',
    input.internalAdminPreview ? 'preview' : 'live',
  ].join(':');
  const [retryRevision, setRetryRevision] = useState(0);
  const [state, setState] = useState<CapabilityState>(() => ({
    key,
    status: input.edition === 'personal' || input.internalAdminPreview ? 'ready' : 'loading',
    features: input.internalAdminPreview ? INTERNAL_ADMIN_PREVIEW_FEATURES : null,
    park: input.internalAdminPreview ? INTERNAL_ADMIN_PREVIEW_PARK : NO_PARK,
  }));
  useEffect(() => {
    let cancelled = false;
    if (input.internalAdminPreview) {
      setState({
        key,
        status: 'ready',
        features: INTERNAL_ADMIN_PREVIEW_FEATURES,
        park: INTERNAL_ADMIN_PREVIEW_PARK,
      });
      return () => { cancelled = true; };
    }
    if (input.edition === 'personal') {
      setState({ key, status: 'ready', features: null, park: NO_PARK });
      return () => { cancelled = true; };
    }
    const organizationId = input.organizationId?.trim();
    setState({ key, status: 'loading', features: null, park: NO_PARK });
    if (!organizationId) {
      setState({ key, status: 'failed', features: null, park: NO_PARK });
      return () => { cancelled = true; };
    }
    void getEnterpriseOrganizationFeatures(organizationId, { force: true }).then(async (features) => {
      let parkAuthorization = NO_PARK;
      try {
        const park = await window.otto.enterpriseParkView();
        const hasParkContext = Boolean(park && park.status === 'active');
        let canViewStaffTasks = false;
        if (hasParkContext) {
          try {
            const tickets = await window.otto.enterpriseTicketList();
            canViewStaffTasks = tickets.some((ticket) => ticket.isRecipient === true);
          } catch {
            // 工单是园区能力中的可选数据源；失败时仅隐藏员工待办入口。
          }
        }
        parkAuthorization = {
          hasParkContext,
          canViewStatistics: hasParkContext && Boolean(park?.isAdminOrganization),
          canViewStaffTasks,
        };
      } catch {
        // 园区服务不可用时按模块 fail-closed，不影响 Agent、Skill 等独立能力。
      }
      if (cancelled) return;
      setState({
        key,
        status: 'ready',
        features,
        park: parkAuthorization,
      });
    }).catch(() => {
      if (!cancelled) setState({ key, status: 'failed', features: null, park: NO_PARK });
    });
    return () => { cancelled = true; };
  }, [input.accountIsAdmin, input.accountId, input.edition, input.internalAdminPreview, input.organizationId, input.serverUrl, key, retryRevision]);

  const current = state.key === key ? state : {
    key,
    status: 'loading' as const,
    features: null,
    park: NO_PARK,
  };
  const modules = useMemo(() => buildModuleCatalog({
    edition: input.edition,
    profiles: input.profiles,
    organizationFeatures: current.features,
    parkAuthorization: current.park,
    customAgents: input.customAgents,
    customerModules: input.customerModules,
  }), [current.features, current.park, input.customAgents, input.customerModules, input.edition, input.profiles]);
  const retry = useCallback(() => setRetryRevision((value) => value + 1), []);
  return { status: current.status, ready: current.status === 'ready', modules, retry };
}
