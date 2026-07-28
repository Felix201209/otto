/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface ParkInviteView {
  id: string;
  parkId: string;
  code: string;
  status: 'active' | 'expired' | 'revoked';
  usedCount: number;
  maxUses: number | null;
  issuedAt: string;
  expiresAt: string;
}

export interface ParkTenantProfileView {
  organizationId: string;
  parkId: string;
  address: string;
  roomNumber: string;
  updatedAt: string;
}
