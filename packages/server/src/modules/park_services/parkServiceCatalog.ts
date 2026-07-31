/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { ParkServiceSeed } from './parkLifecycleTypes.js';

export interface ParkServiceCatalogEntry extends ParkServiceSeed {
  requestable: boolean;
  statisticsName?: string;
}

/** The stable product catalog for services available within a park. */
export const PARK_SERVICE_CATALOG = [
  { id: 'renovation', name: '装修管理', requestable: true },
  { id: 'parking', name: '停车办理', requestable: true },
  { id: 'network-phone', name: '网络与固话', requestable: true },
  {
    id: 'meeting-room',
    name: '会议室预约',
    requestable: true,
    statisticsName: '会议室预定',
  },
  { id: 'electric-card', name: '电卡服务', requestable: true },
  { id: 'repair', name: '物业报修', requestable: true },
  { id: 'vehicle-visit', name: '车辆与访客', requestable: true },
  { id: 'announcement', name: '园区公告', requestable: false },
  { id: 'satisfaction', name: '满意度调查', requestable: false },
] as const satisfies readonly ParkServiceCatalogEntry[];

export const DEFAULT_PARK_SERVICES: readonly ParkServiceSeed[] =
  PARK_SERVICE_CATALOG.map(({ id, name }) => ({ id, name }));

export const PARK_SERVICE_IDS: ReadonlySet<string> = new Set(
  PARK_SERVICE_CATALOG.map(({ id }) => id),
);

export const PARK_REQUEST_SERVICE_DEFINITIONS = PARK_SERVICE_CATALOG.filter(
  (service) => service.requestable,
).map(
  (service) =>
    [
      service.id,
      'statisticsName' in service ? service.statisticsName : service.name,
    ] as const,
);

export const PARK_REQUEST_SERVICE_IDS: ReadonlySet<string> = new Set(
  PARK_REQUEST_SERVICE_DEFINITIONS.map(([serviceId]) => serviceId),
);

export function isParkServiceId(serviceId: string): boolean {
  return PARK_SERVICE_IDS.has(serviceId);
}

export function isParkRequestServiceId(serviceId: string): boolean {
  return PARK_REQUEST_SERVICE_IDS.has(serviceId);
}
