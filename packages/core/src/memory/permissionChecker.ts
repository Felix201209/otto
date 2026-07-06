import type { LicenseRecord, OrgMemoryRecord, Permission } from './orgMemoryTypes.js';

export interface AccessContext {
  userId: string;
  companyId: string;
  teamIds: string[];
  managedTeamIds: string[];
  projectIds: string[];
  isOwner?: boolean;
  licenses: LicenseRecord[];
}

function activeLicenses(ctx: AccessContext): LicenseRecord[] {
  const now = Date.now();
  return ctx.licenses.filter((license) => {
    if (license.assigneeUserId !== ctx.userId) return false;
    if (license.companyId !== ctx.companyId) return false;
    if (license.revokedAt) return false;
    if (license.expiresAt && Date.parse(license.expiresAt) <= now) return false;
    return true;
  });
}

export function hasPermission(ctx: AccessContext, permission: Permission): boolean {
  if (ctx.isOwner) return true;
  return activeLicenses(ctx).some((license) => license.permissions.includes(permission));
}

export function canReadMemory(ctx: AccessContext, memory: OrgMemoryRecord): boolean {
  if (ctx.isOwner) return memory.companyId === ctx.companyId;
  if (memory.companyId !== ctx.companyId) return false;
  if (memory.scope === 'self') {
    return memory.userId === ctx.userId || hasPermission(ctx, 'analytics:team:read');
  }
  if (memory.scope === 'session') {
    return memory.userId === ctx.userId || memory.visibility !== 'private';
  }
  if (memory.scope === 'project') {
    return Boolean(memory.projectId && ctx.projectIds.includes(memory.projectId)) || hasPermission(ctx, 'memory:project:read');
  }
  if (memory.scope === 'team') {
    return Boolean(memory.teamId && ctx.teamIds.includes(memory.teamId)) || Boolean(memory.teamId && ctx.managedTeamIds.includes(memory.teamId)) || hasPermission(ctx, 'memory:team:read');
  }
  if (memory.scope === 'company') {
    return hasPermission(ctx, 'memory:company:read');
  }
  if (memory.scope === 'skill') {
    return hasPermission(ctx, 'skill:team:read') || hasPermission(ctx, 'skill:company:read');
  }
  return false;
}

export function canAssignLicense(ctx: AccessContext, targetTeamId?: string): boolean {
  if (ctx.isOwner) return true;
  if (!hasPermission(ctx, 'license:assign')) return false;
  return !targetTeamId || ctx.managedTeamIds.includes(targetTeamId);
}
