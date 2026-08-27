/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentProfile } from '../agents/departmentAgents.js';
import type { CustomAgentDefinition } from '../customAgents.js';
import { buildModuleCatalog, type ModuleDefinition, type ParkModuleAuthorization } from '../moduleCatalog.js';
import { normalizeServerUrlForStorage } from '../moduleWorkspace.js';
import { getEnterpriseOrganizationFeatures } from './enterpriseOrganizationFeatures.js';

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

export function useModuleWorkspaceCapabilities(input: {
  edition: 'personal' | 'enterprise';
  serverUrl: string;
  organizationId?: string | null;
  accountId: string;
  accountIsAdmin?: boolean;
  profiles: readonly AgentProfile[];
  customAgents: readonly CustomAgentDefinition[];
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
  ].join(':');
  const [retryRevision, setRetryRevision] = useState(0);
  const [state, setState] = useState<CapabilityState>(() => ({
    key,
    status: input.edition === 'personal' ? 'ready' : 'loading',
    features: null,
    park: NO_PARK,
  }));
  useEffect(() => {
    let cancelled = false;
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
    void Promise.all([
      getEnterpriseOrganizationFeatures(organizationId, { force: true }),
      window.otto.enterpriseParkView(),
    ]).then(async ([features, park]) => {
      const hasParkContext = Boolean(park && park.status === 'active');
      const tickets = hasParkContext ? await window.otto.enterpriseTicketList() : [];
      if (cancelled) return;
      setState({
        key,
        status: 'ready',
        features,
        park: {
          hasParkContext,
          canViewStatistics: hasParkContext && Boolean(park?.isAdminOrganization),
          canViewStaffTasks: hasParkContext && tickets.some((ticket) => ticket.isRecipient === true),
        },
      });
    }).catch(() => {
      if (!cancelled) setState({ key, status: 'failed', features: null, park: NO_PARK });
    });
    return () => { cancelled = true; };
  }, [input.accountIsAdmin, input.accountId, input.edition, input.organizationId, input.serverUrl, key, retryRevision]);

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
  }), [current.features, current.park, input.customAgents, input.edition, input.profiles]);
  const retry = useCallback(() => setRetryRevision((value) => value + 1), []);
  return { status: current.status, ready: current.status === 'ready', modules, retry };
}
