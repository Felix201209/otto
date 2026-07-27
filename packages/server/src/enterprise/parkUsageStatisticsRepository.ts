/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import {
  getAccount,
  getDB,
  getPark,
  listParkServices,
  listParkTenantOrganizations,
} from './db.js';

const PARK_SERVICE_DEFINITIONS = [
  ['renovation', '装修管理'],
  ['parking', '停车办理'],
  ['network-phone', '网络与固话'],
  ['meeting-room', '会议室预定'],
  ['electric-card', '电卡服务'],
  ['repair', '物业报修'],
  ['vehicle-visit', '车辆与访客'],
] as const;

const PARK_REQUEST_SERVICE_IDS = new Set<string>(
  PARK_SERVICE_DEFINITIONS.map(([serviceId]) => serviceId),
);

export interface ParkServiceUsageCount {
  serviceId: string;
  name: string;
  count: number;
  amountCny: number;
  recurringMonthlyCny: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
}

export interface ParkTenantServiceStatistics {
  organizationId: string;
  name: string;
  slug: string;
  status: 'active' | 'disabled';
  address: string | null;
  roomNumber: string | null;
  totalUses: number;
  totalAmountCny: number;
  recurringMonthlyCny: number;
  vehicleVisits: number;
  meetingRoomBookings: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  services: ParkServiceUsageCount[];
}

export interface ParkServiceStatisticsView {
  parkId: string;
  parkName: string;
  generatedAt: string;
  organizationCount: number;
  activeOrganizationCount: number;
  totalServiceUses: number;
  totalAmountCny: number;
  recurringMonthlyCny: number;
  vehicleVisits: number;
  meetingRoomBookings: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  services: ParkServiceUsageCount[];
  organizations: ParkTenantServiceStatistics[];
}

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

function ticketStoredMoney(formData: string | null): {
  amountCny: number;
  recurringMonthlyCny: number;
} {
  try {
    const parsed = formData ? JSON.parse(formData) as Record<string, unknown> : {};
    const amountCny = Number(parsed.amountCny);
    const recurringMonthlyCny = Number(parsed.recurringMonthlyCny);
    return {
      amountCny: Number.isFinite(amountCny) && amountCny > 0 ? amountCny : 0,
      recurringMonthlyCny: Number.isFinite(recurringMonthlyCny) && recurringMonthlyCny > 0
        ? recurringMonthlyCny
        : 0,
    };
  } catch {
    return { amountCny: 0, recurringMonthlyCny: 0 };
  }
}

export function getParkServiceStatistics(input: {
  parkId: string;
  actorAccountId: string;
}): ParkServiceStatisticsView {
  const park = getPark(input.parkId);
  if (!park || park.status !== 'active') throw new Error('Park not found');
  const actor = getAccount(input.actorAccountId, park.adminOrganizationId);
  if (!actor?.isAdmin || actor.status !== 'active') {
    throw new Error('Only park administrators can view park statistics');
  }

  const tenants = listParkTenantOrganizations(park.id);
  const configuredNames = new Map(
    listParkServices(park.id).map((service) => [service.id, service.name]),
  );
  const serviceDefinitions = PARK_SERVICE_DEFINITIONS.map(([serviceId, defaultName]) => ({
    serviceId,
    name: configuredNames.get(serviceId) || defaultName,
  }));
  const tenantIds = new Set(tenants.map((tenant) => tenant.id));
  const usage = new Map<string, Map<string, ParkUsageAggregate>>();
  const rows = getDB().prepare(
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
    generatedAt: new Date().toISOString(),
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
