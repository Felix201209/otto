export interface OrganizationInviteOrganizationView {
  id: string;
  name: string;
  slug: string;
  parkId: string | null;
  parkAddress?: string | null;
  parkRoomNumber?: string | null;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationInviteView {
  id: string;
  organizationId: string;
  code: string;
  link: string;
  status: 'active' | 'expired' | 'revoked';
  defaultDepartment: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  defaultRole: string | null;
  maxUses: number | null;
  usedCount: number;
  issuedAt: string;
  expiresAt: string;
  validHours: 168;
}

export type OrganizationInviteStatus =
  'active' | 'expired' | 'revoked' | 'invalid';

export interface OrganizationInviteInspection {
  status: OrganizationInviteStatus;
  organizationId: string | null;
}

export interface OrganizationInviteIssueInput {
  defaultDepartment?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  defaultRole?: string | null;
  maxUses?: number | null;
}

export interface OrganizationInviteResolution {
  organization: OrganizationInviteOrganizationView;
  inviteId: string;
  defaultDepartment: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  defaultRole: string | null;
}
