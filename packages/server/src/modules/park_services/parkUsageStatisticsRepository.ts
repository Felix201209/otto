/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type { ParkStatisticsRepositoryStore } from './parkStatisticsRepository.js';
import {
  PARK_REQUEST_SERVICE_DEFINITIONS,
  PARK_REQUEST_SERVICE_IDS,
} from './parkServiceCatalog.js';
import type {
  ParkServiceStatisticsView,
  ParkServiceUsageCount,
  ParkTenantServiceStatistics,
} from './parkStatisticsTypes.js';

interface ParkServiceTicketRow {
  organization_id: string;
  service_id: string;
  form_data: string | null;
  created_at: string;
}

interface ParkUsageAggregate {
  count: number;
  amountCny: number;
  recurringMonthlyCny: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
}

function normalizedStoredMoney(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && amount <= 1_000_000_000
    ? Math.round(amount * 100) / 100
    : 0;
}

function ticketStoredMoney(formData: string | null): {
  amountCny: number;
  recurringMonthlyCny: number;
} {
  try {
    const parsed = formData ? JSON.parse(formData) as Record<string, unknown> : {};
    return {
      amountCny: normalizedStoredMoney(parsed.amountCny),
      recurringMonthlyCny: normalizedStoredMoney(
        parsed.recurringMonthlyCny,
      ),
    };
  } catch {
    return { amountCny: 0, recurringMonthlyCny: 0 };
  }
}

export function getParkServiceStatisticsFromRepository(
  store: ParkStatisticsRepositoryStore,
  input: {
    parkId: string;
    actorAccountId: string;
  },
): ParkServiceStatisticsView {
  const park = store.getPark(input.parkId);
  if (!park || park.status !== 'active') throw new Error('Park not found');
  const actor = store.getAccount(
    input.actorAccountId,
    park.adminOrganizationId,
  );
  const activeOrganization = store
    .db()
    .prepare("SELECT id FROM organizations WHERE id = ? AND status = 'active'")
    .get(park.adminOrganizationId) as { id: string } | undefined;
  if (!actor?.isAdmin || actor.status !== 'active' || !activeOrganization) {
    throw new Error('Only park administrators can view park statistics');
  }
  if (!store.getOrganizationFeatures(park.adminOrganizationId).park_service) {
    throw new Error('Park service feature is disabled');
  }

  const tenants = store.listParkTenantOrganizations(park.id);
  const configuredNames = new Map(
    store.listParkServices(park.id).map((service) => [service.id, service.name]),
  );
  const serviceDefinitions = PARK_REQUEST_SERVICE_DEFINITIONS.map(([serviceId, defaultName]) => ({
    serviceId,
    name: configuredNames.get(serviceId) || defaultName,
  }));
  const tenantIds = new Set(tenants.map((tenant) => tenant.id));
  const usage = new Map<string, Map<string, ParkUsageAggregate>>();
  const rows = store.db().prepare(
    `SELECT organization_id, service_id, form_data, created_at
     FROM it_tickets
     WHERE park_id = ?
     ORDER BY created_at`,
  ).all(park.id) as ParkServiceTicketRow[];
  for (const row of rows) {
    if (!tenantIds.has(row.organization_id) || !PARK_REQUEST_SERVICE_IDS.has(row.service_id)) {
      continue;
    }
    const organizationUsage = usage.get(row.organization_id) ?? new Map();
    const current = organizationUsage.get(row.service_id) ?? {
      count: 0,
      amountCny: 0,
      recurringMonthlyCny: 0,
      firstUsedAt: null,
      lastUsedAt: null,
    };
    const money = ticketStoredMoney(row.form_data);
    current.count += 1;
    current.amountCny += money.amountCny;
    current.recurringMonthlyCny += money.recurringMonthlyCny;
    current.firstUsedAt = current.firstUsedAt && current.firstUsedAt < row.created_at
      ? current.firstUsedAt
      : row.created_at;
    current.lastUsedAt = current.lastUsedAt && current.lastUsedAt > row.created_at
      ? current.lastUsedAt
      : row.created_at;
    organizationUsage.set(row.service_id, current);
    usage.set(row.organization_id, organizationUsage);
  }

  const organizations = tenants.map((tenant): ParkTenantServiceStatistics => {
    const organizationUsage = usage.get(tenant.id) ?? new Map();
    const services = serviceDefinitions.map(({ serviceId, name }): ParkServiceUsageCount => {
      const aggregate = organizationUsage.get(serviceId);
      return {
        serviceId,
        name,
        count: aggregate?.count ?? 0,
        amountCny: aggregate?.amountCny ?? 0,
        recurringMonthlyCny: aggregate?.recurringMonthlyCny ?? 0,
        firstUsedAt: aggregate?.firstUsedAt ?? null,
        lastUsedAt: aggregate?.lastUsedAt ?? null,
      };
    });
    const timestamps = services.flatMap((service) => (
      [service.firstUsedAt, service.lastUsedAt].filter((value): value is string => Boolean(value))
    )).sort();
    return {
      organizationId: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      address: tenant.parkAddress ?? null,
      roomNumber: tenant.parkRoomNumber ?? null,
      totalUses: services.reduce((total, service) => total + service.count, 0),
      totalAmountCny: services.reduce((total, service) => total + service.amountCny, 0),
      recurringMonthlyCny: services.reduce(
        (total, service) => total + service.recurringMonthlyCny,
        0,
      ),
      vehicleVisits: organizationUsage.get('vehicle-visit')?.count ?? 0,
      meetingRoomBookings: organizationUsage.get('meeting-room')?.count ?? 0,
      firstUsedAt: timestamps[0] ?? null,
      lastUsedAt: timestamps.at(-1) ?? null,
      services,
    };
  });
  const services = serviceDefinitions.map(({ serviceId, name }): ParkServiceUsageCount => {
    const matching = organizations.map((organization) => (
      organization.services.find((service) => service.serviceId === serviceId)
    )).filter((service): service is ParkServiceUsageCount => Boolean(service));
    const timestamps = matching.flatMap((service) => (
      [service.firstUsedAt, service.lastUsedAt].filter((value): value is string => Boolean(value))
    )).sort();
    return {
      serviceId,
      name,
      count: matching.reduce((total, service) => total + service.count, 0),
      amountCny: matching.reduce((total, service) => total + service.amountCny, 0),
      recurringMonthlyCny: matching.reduce(
        (total, service) => total + service.recurringMonthlyCny,
        0,
      ),
      firstUsedAt: timestamps[0] ?? null,
      lastUsedAt: timestamps.at(-1) ?? null,
    };
  });
  const allTimestamps = services.flatMap((service) => (
    [service.firstUsedAt, service.lastUsedAt].filter((value): value is string => Boolean(value))
  )).sort();

  return {
    parkId: park.id,
    parkName: park.name,
    generatedAt: store.nowISO(),
    organizationCount: organizations.length,
    activeOrganizationCount: organizations.filter((organization) => organization.status === 'active').length,
    totalServiceUses: services.reduce((total, service) => total + service.count, 0),
    totalAmountCny: services.reduce((total, service) => total + service.amountCny, 0),
    recurringMonthlyCny: services.reduce(
      (total, service) => total + service.recurringMonthlyCny,
      0,
    ),
    vehicleVisits: services.find((service) => service.serviceId === 'vehicle-visit')?.count ?? 0,
    meetingRoomBookings: services.find((service) => service.serviceId === 'meeting-room')?.count ?? 0,
    firstUsedAt: allTimestamps[0] ?? null,
    lastUsedAt: allTimestamps.at(-1) ?? null,
    services,
    organizations,
  };
}
