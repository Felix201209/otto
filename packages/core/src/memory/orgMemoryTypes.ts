export type OrgMemoryScope = 'self' | 'session' | 'project' | 'team' | 'company' | 'skill';
export type OrgMemoryType = 'profile' | 'preference' | 'fact' | 'decision' | 'workflow' | 'policy' | 'lesson' | 'warning' | 'summary' | 'skill_candidate';
export type OrgMemoryVisibility = 'private' | 'project_members' | 'team_visible' | 'manager_visible' | 'company_visible';
export type ProjectType = 'code' | 'marketing' | 'sales' | 'product' | 'finance' | 'legal' | 'hr' | 'ops' | 'docs' | 'other';
export type ProjectStatus = 'planning' | 'active' | 'paused' | 'completed' | 'archived';
export type LicenseScope = 'company' | 'team' | 'project' | 'employee';
export type LicenseRole = 'owner' | 'manager' | 'employee' | 'viewer';
export type Permission = 'memory:self:read' | 'memory:self:write' | 'memory:project:read' | 'memory:project:write' | 'memory:team:read' | 'memory:team:write' | 'memory:company:read' | 'memory:company:write' | 'skill:team:read' | 'skill:team:write' | 'skill:team:approve' | 'skill:company:read' | 'skill:company:approve' | 'analytics:self:read' | 'analytics:team:read' | 'analytics:company:read' | 'license:assign' | 'license:revoke';
export type FeatureFlag = 'desktop' | 'feishu-bot' | 'voice-input' | 'browser' | 'ide' | 'ppt' | 'docs' | 'data-analysis' | 'custom-skills' | 'company-dashboard' | 'team-dashboard';

export interface CompanyRecord {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamRecord {
  id: string;
  companyId: string;
  name: string;
  managerUserIds: string[];
  memberUserIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserProfileRecord {
  id: string;
  companyId: string;
  teamIds: string[];
  name: string;
  role: string;
  selfMemory: string;
  workStyle?: string;
  strengths?: string[];
  commonTasks?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  companyId: string;
  teamId: string;
  name: string;
  type: ProjectType;
  status: ProjectStatus;
  goal: string;
  ownerUserId: string;
  memberUserIds: string[];
  linkedSessionIds: string[];
  assetRefs: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}


export interface OrgMemoryRecord {
  id: string;
  scope: OrgMemoryScope;
  companyId: string;
  teamId?: string;
  projectId?: string;
  userId?: string;
  sessionId?: string;
  skillId?: string;
  type: OrgMemoryType;
  title: string;
  content: string;
  tags: string[];
  visibility: OrgMemoryVisibility;
  source: 'manual' | 'session' | 'task_summary' | 'feishu' | 'desktop' | 'imported' | 'auto_learned';
  confidence: number;
  createdBy: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface SkillRecord {
  id: string;
  companyId: string;
  teamId?: string;
  name: string;
  description: string;
  scope: 'team' | 'company';
  status: 'draft' | 'candidate' | 'team_approved' | 'company_candidate' | 'company_approved' | 'deprecated';
  triggerPatterns: string[];
  requiredInputs: string[];
  workflowSteps: string[];
  outputSchema: string;
  examples: string[];
  sourceProjectIds: string[];
  sourceTaskIds: string[];
  usageCount: number;
  successRate: number;
  avgTokenCost: number;
  avgRevisionCount: number;
  avgTimeSavedMinutes: number;
  createdBy: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsageRecord {
  id: string;
  companyId: string;
  teamId?: string;
  projectId?: string;
  userId: string;
  sessionId?: string;
  taskType: string;
  skillId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  outputAccepted?: boolean;
  revisionCount: number;
  estimatedTimeSavedMinutes?: number;
  createdAt: string;
}

export interface LicenseRecord {
  id: string;
  companyId: string;
  issuerUserId: string;
  assigneeUserId: string;
  scope: LicenseScope;
  teamId?: string;
  projectId?: string;
  role: LicenseRole;
  permissions: Permission[];
  tokenQuota: { monthlyLimit: number; usedThisMonth: number; hardLimit: boolean };
  allowedModels: string[];
  allowedSkillIds: string[];
  allowedKnowledgeScopes: OrgMemoryScope[];
  features: FeatureFlag[];
  startsAt: string;
  expiresAt?: string;
  revokedAt?: string;
}
