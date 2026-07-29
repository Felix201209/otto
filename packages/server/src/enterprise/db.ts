/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise SQLite database - all data stored on admin/owner device.
 * Zero cloud dependency. All data is local.
 * 存储层通过 data_platform 使用 Node 内置 node:sqlite，无原生依赖。
 */

import {
  applyDatabaseSchemaContributors,
  createEnterpriseDatabaseLifecycle,
  createFileEncryptionKeyProvider,
  Database,
} from '../modules/data_platform/index.js';
import { createOrganizationFeatureAccessFacade } from '../modules/authorization/index.js';
import {
  COLLABORATION_SCHEMA_CONTRIBUTOR,
  createAccountPresenceFacade,
  createDirectMessageFacade,
  type AccountPresenceView as CollaborationAccountPresenceView,
} from '../modules/collaboration/index.js';
import {
  createEnterpriseKnowledgeFacade,
  createEnterpriseKnowledgeSchemaContributor,
} from '../modules/enterprise_knowledge/index.js';
import { createFeishuAutoReplyFacade } from '../modules/integration_adapters/index.js';
import {
  createModelUsageFacade,
  MODEL_GATEWAY_SCHEMA_CONTRIBUTOR,
} from '../modules/model_gateway/index.js';
import {
  createAccountSyncFacade,
  createWorklogSchemaContributor,
  createWorklogFacade,
  ESTIMATE,
  normalizeCostCNY,
  normalizeTokens,
  PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR,
} from '../modules/personal_intelligence/index.js';
import {
  createParkLifecycleFacade,
  createParkMembershipFacade,
  createParkPublicationFacade,
  createParkPublicationSchemaContributor,
  createParkResourceFacade,
  PARK_RESOURCE_SCHEMA_CONTRIBUTOR,
  createParkServiceConfigurationFacade,
  createParkStatisticsFacade,
  createParkTicketFacade,
  createParkTicketSchemaContributor,
  migrateLegacyParkTicketEvents,
  PARK_CORE_SCHEMA_CONTRIBUTOR,
  PARK_STATISTICS_SCHEMA_CONTRIBUTOR,
  type ParkInviteView,
  type ParkDataStatisticsAssignmentView,
  type ParkDataStatisticsTaskView,
  type ParkServiceSpecialistView,
  type ParkServiceView,
  type ParkTenantProfileView,
  type ParkView,
} from '../modules/park_services/index.js';
import path from 'path';
import os from 'os';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createAuditLogFacade,
  createAuditLogSchemaContributor,
  createCreditsFacade,
  createCreditsSchemaContributor,
  createDeploymentSettingsRepository,
  exportDeploymentDiagnostics as exportDeploymentDiagnosticsFromRepository,
  getDeploymentId as getDeploymentIdFromRepository,
  getDeploymentLicense as getDeploymentLicenseFromRepository,
  getMachineFingerprint as getMachineFingerprintFromRepository,
  getModuleUpdateManifestFromStore,
  getPrivateDeploymentStatus as getPrivateDeploymentStatusFromRepository,
  getTelemetryQueueSummary as getTelemetryQueueSummaryFromRepository,
  getTelemetrySettings as getTelemetrySettingsFromRepository,
  importDeploymentLicense as importDeploymentLicenseIntoRepository,
  isLicenseRestricted as isLicenseRestrictedInRepository,
  isLicenseUsableForOrganizationFeature as isLicenseUsableForOrganizationFeatureInRepository,
  PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR,
  recordTelemetryEvent as recordTelemetryEventInRepository,
  updateModuleUpdateDescriptorInStore,
  updateTelemetrySettings as updateTelemetrySettingsInRepository,
  type ModuleUpdateDescriptor,
  type ModuleUpdateManifest,
  type ModuleUpdateRollout,
  type DeploymentLicenseView,
  type DeploymentTelemetrySettings,
  type PrivateDeploymentStatus,
} from '../modules/commercial_control/index.js';
import {
  backfillEnterpriseAccountEmployees,
  backfillLegacyOrganizationStructure,
  createAccountDirectoryFacade,
  createAccountAuthSchemaContributor,
  createAccountLifecycleFacade,
  createAccountRegistrationFacade,
  createAssignmentIdentityFacade,
  createAuthSessionFacade,
  createDepartmentInviteFacade,
  createEnterpriseInviteSchemaContributor,
  createMemberDirectoryFacade,
  createMemberSchemaContributor,
  createSmsChallengeFacade,
  createOrganizationDirectoryFacade,
  createOrganizationFeatureFacade,
  createOrganizationInviteFacade,
  createOrganizationProvisioningFacade,
  createOrganizationStructureFacade,
  IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR,
  IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR,
  listAccountTagsInRepository,
  listOrganizationAccountTagsInRepository,
  normalizeAccountTags,
  normalizeOrganizationSlug,
  replaceMigratedAccountTagsInRepository,
  toOrganizationDirectoryView,
  assertAccountPassword as assertIdentityAccountPassword,
  hashIdentitySecret,
  identitySecretMatches,
  isAcceptableAccountPassword as isAcceptableIdentityAccountPassword,
  migrateLegacyAuthSessions,
  type EmployeeRecord,
  type OrganizationDepartmentView as IdentityOrganizationDepartmentView,
  type OrganizationDirectoryRow,
  type OrganizationDirectoryView,
  type OrganizationInviteView,
  type OrganizationFeatures as IdentityOrganizationFeatures,
  type OrganizationPositionRoleMapping as IdentityOrganizationPositionRoleMapping,
  type OrganizationPositionView as IdentityOrganizationPositionView,
  type SmsChallengeIssueResult as IdentitySmsChallengeIssueResult,
  type SmsChallengeVerifyResult as IdentitySmsChallengeVerifyResult,
  type SmsRegistrationVerifyResult as IdentitySmsRegistrationVerifyResult,
} from '../modules/identity_organization/index.js';
export type {
  AuditLogRecord,
  CreditBalance,
  CreditTransaction,
  ModuleUpdateDescriptor,
  ModuleUpdateManifest,
  ModuleUpdateRollout,
  DeploymentLicenseStatus,
  DeploymentLicenseView,
  DeploymentTelemetrySettings,
  PrivateDeploymentStatus,
  RedeemCodeInfo,
} from '../modules/commercial_control/index.js';
export {
  CREDITS_TABLES_SQL,
  CreditsRequestError,
} from '../modules/commercial_control/index.js';
export type {
  AssignmentIdentity,
  AssignmentIdentityInput,
  DepartmentInviteValidationResult,
  OrganizationInviteInspection,
  OrganizationInviteIssueInput,
  OrganizationInviteResolution,
  OrganizationInviteStatus,
  OrganizationInviteView,
} from '../modules/identity_organization/index.js';
export type {
  AtoaInboxMessageView,
  DirectMessageAttachmentDownload,
  DirectMessageAttachmentInput,
  DirectMessageAttachmentView,
  DirectMessageView,
  UnreadDirectMessageNotification,
} from '../modules/collaboration/index.js';
export type {
  AddEnterpriseKnowledgeInput,
  EnterpriseKnowledgeEntryView,
} from '../modules/enterprise_knowledge/index.js';
export {
  ACCOUNT_SYNC_SCOPES,
  AccountSyncConflictError,
} from '../modules/personal_intelligence/index.js';
export type {
  AccountSyncFile,
  AccountSyncPayload,
  AccountSyncScope,
  AccountSyncSnapshotView,
} from '../modules/personal_intelligence/index.js';
export type {
  ParkDataStatisticsAssignmentStatus,
  ParkDataStatisticsAssignmentView,
  ParkDataStatisticsTaskView,
  ParkInviteView,
  ParkServiceStatisticsView,
  ParkServiceSpecialistView,
  ParkServiceView,
  ParkServiceUsageCount,
  ParkTenantProfileView,
  ParkTenantServiceStatistics,
  ParkView,
  TicketHistoryAction,
  TicketHistoryEntry,
  TicketView,
} from '../modules/park_services/index.js';

const DATA_DIR =
  process.env.OTTO_ENTERPRISE_DIR ||
  path.join(os.homedir(), '.otto-enterprise');
const DB_PATH = path.join(DATA_DIR, 'data.db');
const ACCOUNT_SYNC_KEY_PATH = path.join(DATA_DIR, 'account-sync.key');
const accountSyncKeyProvider = createFileEncryptionKeyProvider({
  keyPath: ACCOUNT_SYNC_KEY_PATH,
  keyBytes: 32,
  invalidKeyMessage: 'account sync encryption key is invalid',
});

export const DEFAULT_ORGANIZATION_ID = 'org_default';
export const ENTERPRISE_SCHEMA_VERSION = 13;
export const ORGANIZATION_INVITE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const ORGANIZATION_INVITE_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const INVITE_CODE_RAW_LENGTH = 12;

function initSchema(d: Database): void {
  applyDatabaseSchemaContributors(d, [
    IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR,
    createAccountAuthSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
    createEnterpriseInviteSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
    PARK_CORE_SCHEMA_CONTRIBUTOR,
    createParkPublicationSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
    PARK_STATISTICS_SCHEMA_CONTRIBUTOR,
    createParkTicketSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
    PARK_RESOURCE_SCHEMA_CONTRIBUTOR,
    createCreditsSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
    MODEL_GATEWAY_SCHEMA_CONTRIBUTOR,
    COLLABORATION_SCHEMA_CONTRIBUTOR,
    createEnterpriseKnowledgeSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
    IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR,
    createMemberSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
    createWorklogSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
    PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR,
    PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR,
    createAuditLogSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
  ]);

  d.prepare(
    `INSERT OR IGNORE INTO organizations (id, name, slug, invite_secret)
     VALUES (?, ?, ?, ?)`,
  ).run(
    DEFAULT_ORGANIZATION_ID,
    process.env.OTTO_DEFAULT_ORGANIZATION_NAME?.trim() || '默认企业',
    'default',
    randomBytes(32).toString('hex'),
  );

  // B2B v2：旧库所有既有数据归入默认企业，密码、标签和会话继续有效。
  const ensureOrganizationColumn = (table: string): void => {
    const columns = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'organization_id')) {
      d.exec(
        `ALTER TABLE ${table} ADD COLUMN organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}'`,
      );
    }
  };
  ensureOrganizationColumn('account_presence');
  backfillEnterpriseAccountEmployees(d);
  backfillLegacyOrganizationStructure(d);
  d.exec(`
    PRAGMA user_version = ${ENTERPRISE_SCHEMA_VERSION};
  `);
}

const databaseLifecycle = createEnterpriseDatabaseLifecycle({
  dataDirectory: DATA_DIR,
  databasePath: DB_PATH,
  legacyBackupPath: `${DB_PATH}.pre-b2b-v2.bak`,
  schemaVersion: ENTERPRISE_SCHEMA_VERSION,
  beforeForeignKeys(database) {
    migrateLegacyAuthSessions(database, DEFAULT_ORGANIZATION_ID);
    migrateLegacyParkTicketEvents(database);
  },
  initializeSchema: initSchema,
  onClose: () => accountSyncKeyProvider.clear(),
});

/** 释放当前企业数据库连接；服务关闭或隔离测试清理时调用。 */
export const closeEnterpriseDatabase = databaseLifecycle.close;

export const getDB = databaseLifecycle.getDatabase;

/** 执行真实读查询，供 HTTP readiness 判断数据库与 schema 是否可用。 */
export const getDatabaseReadiness = databaseLifecycle.getReadiness;

// ============================================================
// Organizations and time-boxed registration invites
// ============================================================

const auditLog = createAuditLogFacade({
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
});

export const { getAuditLogs, logAudit } = auditLog;

const credits = createCreditsFacade({
  db: getDB,
  creditTokenRate: () => process.env.OTTO_CREDIT_TOKEN_RATE,
});

export const {
  checkAndReserveCredits,
  createRedeemCodes,
  deductCredits,
  getCreditBalance,
  listCreditTransactions,
  listRedeemCodes,
  redeemCode,
  revokeRedeemCode,
  topUpCredits,
} = credits;

export type OrganizationView = OrganizationDirectoryView;

const organizationDirectoryStore = { db: getDB };

export const {
  getOrganization,
  listOrganizations,
  getEnterpriseOrganization,
  listEnterpriseOrganizations,
} = createOrganizationDirectoryFacade(organizationDirectoryStore);

const departmentInvites = createDepartmentInviteFacade({
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  getOrganization,
  logAudit,
});

export const { createInviteCode, validateInviteCode } = departmentInvites;

export type OrganizationPositionRoleMapping =
  IdentityOrganizationPositionRoleMapping;
export type OrganizationPositionView = IdentityOrganizationPositionView;
export type OrganizationDepartmentView = IdentityOrganizationDepartmentView;

const organizationStructureStore = {
  db: getDB,
  logAudit: (
    event: string,
    employeeId: string | null,
    detail: string,
  organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
};

export const {
  listOrganizationStructure,
  createOrganizationDepartment,
  updateOrganizationDepartment,
  deleteOrganizationDepartment,
  createOrganizationPosition,
  updateOrganizationPosition,
  deleteOrganizationPosition,
} = createOrganizationStructureFacade(organizationStructureStore);

export type OrganizationFeatures = IdentityOrganizationFeatures;

const organizationFeatureConfiguration = createOrganizationFeatureFacade({
  db: getDB,
  audit: (
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
});

const deploymentSettings = createDeploymentSettingsRepository(getDB);

const deploymentStore = {
  db: getDB,
  ...deploymentSettings,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  licenseEnforcementEnabled: () => process.env.OTTO_LICENSE_ENFORCE === 'true',
  licenseSigningSecret: () => process.env.OTTO_LICENSE_SIGNING_SECRET || '',
  telemetryEndpoint: () => process.env.OTTO_TELEMETRY_ENDPOINT || null,
  databaseReadiness: getDatabaseReadiness,
  audit: (
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
};

export function getModuleUpdateManifest(): ModuleUpdateManifest {
  return getModuleUpdateManifestFromStore(moduleUpdateStore);
}

export function updateModuleUpdateDescriptor(input: {
  module: string;
  version?: string;
  rollout?: ModuleUpdateRollout;
  notes?: string | null;
  minAppVersion?: string | null;
  manifestUrl?: string | null;
  sha256?: string | null;
  publishedAt?: string | null;
  actorAccountId?: string | null;
  organizationId?: string;
}): ModuleUpdateDescriptor {
  return updateModuleUpdateDescriptorInStore(moduleUpdateStore, {
    ...input,
    organizationId: input.organizationId ?? DEFAULT_ORGANIZATION_ID,
  });
}

const moduleUpdateStore = {
  ...deploymentSettings,
  deploymentId: getDeploymentId,
  audit: (input: {
    event: string;
    employeeId: string | null;
    message: string;
    organizationId: string;
  }) =>
    logAudit(
      input.event,
      input.employeeId,
      input.message,
      input.organizationId,
    ),
};

export function getDeploymentId(): string {
  return getDeploymentIdFromRepository(deploymentStore);
}

export function getMachineFingerprint(): string {
  return getMachineFingerprintFromRepository();
}

export function getDeploymentLicense(): DeploymentLicenseView {
  return getDeploymentLicenseFromRepository(deploymentStore);
}

export function importDeploymentLicense(raw: unknown): DeploymentLicenseView {
  return importDeploymentLicenseIntoRepository(deploymentStore, raw);
}

export function getTelemetrySettings(): DeploymentTelemetrySettings {
  return getTelemetrySettingsFromRepository(deploymentStore);
}

export function updateTelemetrySettings(
  patch: Partial<DeploymentTelemetrySettings>,
): DeploymentTelemetrySettings {
  return updateTelemetrySettingsInRepository(deploymentStore, patch);
}

export function recordTelemetryEvent(input: {
  organizationId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}): void {
  recordTelemetryEventInRepository(deploymentStore, input);
}

export function getTelemetryQueueSummary(): {
  queued: number;
  failed: number;
  sent: number;
  lastQueuedAt: string | null;
} {
  return getTelemetryQueueSummaryFromRepository(deploymentStore);
}

export function getPrivateDeploymentStatus(): PrivateDeploymentStatus {
  return getPrivateDeploymentStatusFromRepository(deploymentStore);
}

export function exportDeploymentDiagnostics(
  input: { includeRedactedSamples?: boolean } = {},
): Record<string, unknown> {
  return exportDeploymentDiagnosticsFromRepository(deploymentStore, input);
}

export function isLicenseUsableForOrganizationFeature(
  feature: keyof OrganizationFeatures,
): boolean {
  return isLicenseUsableForOrganizationFeatureInRepository(
    deploymentStore,
    feature,
  );
}

export function isLicenseRestricted(): boolean {
  return isLicenseRestrictedInRepository(deploymentStore);
}

const organizationFeatureAccess = createOrganizationFeatureAccessFacade({
  configuration: organizationFeatureConfiguration,
  isLicenseUsable: isLicenseUsableForOrganizationFeature,
});

export const {
  getOrganizationFeatures,
  updateOrganizationFeatures,
  isOrganizationFeatureEnabled,
  requireOrganizationFeature,
} = organizationFeatureAccess;

function normalizeOptionalText(
  value: string | null | undefined,
  label: string,
  maxLength = 80,
): string | null {
  const clean = value?.trim() || null;
  if (clean && clean.length > maxLength)
    throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return clean;
}

const assignmentIdentities = createAssignmentIdentityFacade();
export const { resolveAssignmentIdentity } = assignmentIdentities;

const memberDirectoryStore = {
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  organizationExists: (organizationId: string) =>
    getOrganization(organizationId) !== null,
  resolveAssignmentIdentity,
  audit: (
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
};

export const { createEmployee, getEmployee, listEmployees, offboardEmployee } =
  createMemberDirectoryFacade(memberDirectoryStore);

const organizationInviteStore = {
  db: getDB,
  inviteValidityMs: ORGANIZATION_INVITE_VALIDITY_MS,
  inviteAlphabet: ORGANIZATION_INVITE_ALPHABET,
  inviteCodeRawLength: INVITE_CODE_RAW_LENGTH,
  toOrganizationView: toOrganizationDirectoryView,
  resolveAssignmentIdentity,
  normalizeOptionalText,
  logAudit,
};

export const {
  normalizeOrganizationInviteCode,
  inspectOrganizationInvite,
  issueOrganizationInvite,
  getOrganizationInvite,
  resolveOrganizationInviteWithDefaults,
  resolveOrganizationInvite,
} = createOrganizationInviteFacade(organizationInviteStore);

// ============================================================
// Preset accounts, tags and sessions
// ============================================================

export interface AccountView {
  id: string;
  organizationId: string;
  organizationName: string;
  accountType: 'personal' | 'enterprise';
  employeeId: string | null;
  username: string;
  phone: string | null;
  feishuOpenId: string | null;
  name: string;
  role: string | null;
  department: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  status: 'active' | 'disabled';
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AccountRow {
  id: string;
  organization_id: string;
  account_type: 'personal' | 'enterprise' | null;
  employee_id: string | null;
  username: string;
  phone: string | null;
  feishu_open_id: string | null;
  password_hash: string;
  name: string;
  role: string | null;
  department: string | null;
  department_id: string | null;
  position_id: string | null;
  position_title: string | null;
  avatar_url: string | null;
  is_admin: number;
  status: 'active' | 'disabled';
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeUsername(username: string): string {
  return username.trim().toLocaleLowerCase('en-US');
}

/** 中国大陆手机号统一保存为 E.164；展示和下发短信时再去掉 +86。 */
export function normalizePhone(phone: string): string {
  let digits = phone.trim().replace(/[^\d]/g, '');
  if (digits.startsWith('0086')) digits = digits.slice(4);
  else if (digits.startsWith('86') && digits.length === 13)
    digits = digits.slice(2);
  if (!/^1[3-9]\d{9}$/.test(digits)) throw new Error('手机号格式不正确');
  return `+86${digits}`;
}

function normalizeOptionalPhone(
  phone: string | null | undefined,
): string | null {
  if (phone == null || !phone.trim()) return null;
  return normalizePhone(phone);
}

function normalizeOptionalFeishuOpenId(
  value: string | null | undefined,
): string | null {
  if (value == null || !value.trim()) return null;
  const openId = value.trim();
  if (!/^ou_[A-Za-z0-9_-]+$/.test(openId))
    throw new Error('飞书 open_id 格式不正确');
  return openId;
}

function normalizeOptionalAvatarUrl(
  value: string | null | undefined,
): string | null {
  if (value == null || !value.trim()) return null;
  const avatarUrl = value.trim();
  if (/^https:\/\//i.test(avatarUrl)) {
    if (avatarUrl.length > 2_000)
      throw new Error('头像地址不能超过 2000 个字符');
    try {
      if (new URL(avatarUrl).protocol !== 'https:') throw new Error();
    } catch {
      throw new Error('头像地址格式不正确');
    }
    return avatarUrl;
  }
  const match =
    /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
      avatarUrl,
    );
  if (!match)
    throw new Error(
      '头像仅支持 HTTPS 或 PNG、JPEG、WebP、GIF 格式的 data:image',
    );
  if (
    avatarUrl.length > 700_000 ||
    Buffer.from(match[2]!, 'base64').byteLength > 512 * 1024
  ) {
    throw new Error('头像数据不能超过 512KB');
  }
  return avatarUrl;
}

export const normalizeTags = normalizeAccountTags;

const passwordHash = hashIdentitySecret;
const passwordMatches = identitySecretMatches;
const assertAccountPassword = assertIdentityAccountPassword;
export const isAcceptableAccountPassword =
  isAcceptableIdentityAccountPassword;

const accountTagStore = { db: getDB };

export function toAccountView(row: AccountRow): AccountView {
  const organization = getOrganization(row.organization_id);
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: organization?.name || '未知企业',
    accountType: row.account_type === 'personal' ? 'personal' : 'enterprise',
    employeeId: row.employee_id,
    username: row.username,
    phone: row.phone,
    feishuOpenId: row.feishu_open_id,
    name: row.name,
    role: row.role,
    department: row.department,
    departmentId: row.department_id,
    positionId: row.position_id,
    positionTitle: row.position_title,
    avatarUrl: row.avatar_url,
    isAdmin: row.is_admin === 1,
    status: row.status,
    tags: listAccountTagsInRepository(
      accountTagStore,
      row.id,
      row.organization_id,
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const accountDirectoryStore = {
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  normalizeIdentifier: normalizeUsername,
  normalizePhone,
  passwordMatches,
  isOrganizationActive: (organizationId: string) =>
    getOrganization(organizationId)?.status === 'active',
  toAccountView,
};

export const {
  getAccount,
  listAccounts,
  authenticateAccount,
  findAccountByPhone,
  findActiveAccountByPhone,
  listFeishuAccountBindings,
} = createAccountDirectoryFacade<AccountView, AccountRow>(accountDirectoryStore);

const accountSync = createAccountSyncFacade({
  db: getDB,
  keyProvider: accountSyncKeyProvider,
  resolveActiveIdentity(accountId: string) {
    const account = getAccount(accountId);
    if (account?.status !== 'active') return null;
    const organization = getOrganization(account.organizationId);
    if (organization?.status !== 'active') return null;
    return {
      accountId: account.id,
      organizationId: account.organizationId,
    };
  },
});

export const { listAccountSyncSnapshots, putAccountSyncSnapshot } = accountSync;

const accountLifecycleStore = {
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  organizationExists: (organizationId: string) =>
    Boolean(getOrganization(organizationId)),
  normalizeUsername,
  normalizeOptionalPhone,
  normalizeOptionalFeishuOpenId,
  normalizeOptionalAvatarUrl,
  assertPassword: assertAccountPassword,
  hashPassword: passwordHash,
  createId: (prefix: 'acc' | 'emp') => `${prefix}_${randomUUID()}`,
  createDeletionPasswordHash: () =>
    passwordHash(randomBytes(32).toString('base64url')),
  resolveAssignment(
    database: Database,
    organizationId: string,
    input: {
      department?: string | null;
      departmentId?: string | null;
      positionId?: string | null;
      positionTitle?: string | null;
    },
  ) {
    const assignment = resolveAssignmentIdentity(
      database,
      organizationId,
      input,
    );
    const positionMapping = assignment.positionId
      ? (database
          .prepare(
            `SELECT role_mapping FROM organization_positions
             WHERE id = ? AND organization_id = ?`,
          )
          .get(assignment.positionId, organizationId) as
          | { role_mapping: OrganizationPositionRoleMapping }
          | undefined)
      : undefined;
    return {
      ...assignment,
      roleMapping: positionMapping?.role_mapping ?? null,
    };
  },
  createEmployee,
  getAccount,
  logAudit,
};

export const { createAccount, updateAccount, deleteAccount } =
  createAccountLifecycleFacade<AccountView>(accountLifecycleStore);

const organizationProvisioningStore = {
  db: getDB,
  now: Date.now,
  createOrganizationId: () => `org_${randomUUID()}`,
  createInviteSecret: () => randomBytes(32).toString('hex'),
  createDefaultSlugSuffix: () => randomBytes(5).toString('hex'),
  getOrganization,
  createAccount,
  issueOrganizationInvite,
  logAudit,
};

/** 企业、首位管理员和首个 7 天邀请要么全部成功，要么全部回滚。 */
export const { createOrganization, provisionOrganization } =
  createOrganizationProvisioningFacade<
    OrganizationView,
    AccountView,
    OrganizationInviteView
  >(organizationProvisioningStore);

const accountRegistrationStore = {
  db: getDB,
  now: Date.now,
  normalizePhone,
  findAccountByPhone,
  createId: (_prefix: 'emp') => `emp_${randomUUID()}`,
  createUsernameSuffix: () => randomBytes(4).toString('hex'),
  createPersonalSlugSuffix: () => randomBytes(8).toString('hex'),
  resolveAssignmentIdentity,
  createEmployee(input: {
    id: string;
    organizationId: string;
    name: string;
    role?: string;
    department?: string;
    departmentId?: string;
    positionId?: string;
    positionTitle?: string;
    inviteCode?: string;
  }) {
    const { inviteCode, ...employee } = input;
    return createEmployee({
      ...employee,
      invite_code: inviteCode,
    });
  },
  createAccount,
  createOrganization,
  getAccount,
  resolveOrganizationInviteWithDefaults,
  normalizeOrganizationInviteCode,
  replaceMigratedAccountTags(
    accountId: string,
    organizationId: string,
    tags: string[],
  ) {
    replaceMigratedAccountTagsInRepository(
      accountTagStore,
      accountId,
      organizationId,
      tags,
    );
  },
  logAudit,
};

export const {
  createSelfRegisteredAccount,
  createPersonalRegisteredAccount,
  joinOrganizationWithInvite,
} = createAccountRegistrationFacade<AccountView, OrganizationView>(
  accountRegistrationStore,
);

const directMessageStore = {
  db: getDB,
  createId: randomUUID,
  getActiveAccountInOrganization: (
    accountId: string,
    organizationId: string,
  ) => {
    const account = getAccount(accountId, organizationId);
    return account?.status === 'active'
      ? { id: account.id, name: account.name }
      : null;
  },
};

export const {
  getDirectMessageAttachment,
  listDirectMessages,
  listPendingAtoaRequests,
  listUnreadDirectMessageNotifications,
  markAtoaRequestReadFromResponse,
  sendDirectMessage,
} = createDirectMessageFacade(directMessageStore);

export type AccountPresenceView = CollaborationAccountPresenceView;

const accountPresenceStore = {
  db: getDB,
  now: Date.now,
  isActiveAccountInOrganization: (accountId: string, organizationId: string) =>
    getAccount(accountId, organizationId)?.status === 'active',
};

export const { touchAccountPresence, listAccountPresence } =
  createAccountPresenceFacade(accountPresenceStore);

const feishuAutoReply = createFeishuAutoReplyFacade({
  listAccountBindings: listFeishuAccountBindings,
  isOrganizationFeatureEnabled: (organizationId: string) =>
    isOrganizationFeatureEnabled(organizationId, 'feishu_auto_reply'),
});

export const { isFeishuAutoReplyEnabledForOpenId } = feishuAutoReply;

const authSessionStore = {
  db: getDB,
  now: Date.now,
  getAccount,
  isOrganizationActive: (organizationId: string) =>
    getOrganization(organizationId)?.status === 'active',
  toAccountView,
};

export const {
  createAuthSession,
  getAccountBySession,
  revokeAuthSession,
} = createAuthSessionFacade<AccountView, AccountRow>(authSessionStore);

const smsChallengeStore = {
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  getAccount,
  organizationExists: (organizationId: string) =>
    Boolean(getOrganization(organizationId)),
  normalizePhone,
  hashSecret: hashIdentitySecret,
  secretMatches: identitySecretMatches,
  createChallengeId: (kind: 'login' | 'registration') =>
    `${kind === 'login' ? 'sms' : 'smsreg'}_${randomUUID()}`,
  audit: (
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
};

export type SmsChallengeIssueResult = IdentitySmsChallengeIssueResult;
export type SmsRegistrationVerifyResult = IdentitySmsRegistrationVerifyResult;
export type SmsChallengeVerifyResult =
  IdentitySmsChallengeVerifyResult<AccountView>;

export const {
  createSmsLoginChallenge,
  discardSmsLoginChallenge,
  verifySmsLoginChallenge,
  createSmsRegistrationChallenge,
  discardSmsRegistrationChallenge,
  verifySmsRegistrationChallenge,
} = createSmsChallengeFacade<AccountView>(smsChallengeStore);

// ============================================================
// Park tenants, organization membership and service specialists
// ============================================================

const DEFAULT_PARK_SERVICES = [
  ['renovation', '装修管理'],
  ['parking', '停车办理'],
  ['network-phone', '网络与固话'],
  ['meeting-room', '会议室预约'],
  ['electric-card', '电卡服务'],
  ['repair', '物业报修'],
  ['vehicle-visit', '车辆与访客'],
  ['announcement', '园区公告'],
  ['satisfaction', '满意度调查'],
] as const;

export const PARK_SERVICE_IDS = new Set<string>(
  DEFAULT_PARK_SERVICES.map(([serviceId]) => serviceId),
);

const parkLifecycleStore = {
  db: getDB,
  getAccount,
  getOrganization: getEnterpriseOrganization,
  getActiveOrganizationAdmin: (organizationId: string) =>
    listAccounts(organizationId).find(
      (account) => account.isAdmin && account.status === 'active',
    ) ?? null,
  normalizeOptionalText,
  normalizeSlug: normalizeOrganizationSlug,
  createParkId: () => `park_${randomUUID()}`,
  createDefaultSlug: () => `park-${randomBytes(5).toString('hex')}`,
  createInviteSecret: () => randomBytes(32).toString('hex'),
  defaultServices: DEFAULT_PARK_SERVICES.map(([id, name]) => ({ id, name })),
};
const parkLifecycle = createParkLifecycleFacade(parkLifecycleStore);

const parkServiceStore = {
  db: getDB,
  getAccount,
  getPark,
  normalizeOptionalText,
};
const parkServiceConfiguration =
  createParkServiceConfigurationFacade(parkServiceStore);

export function listParkServices(parkId: string): ParkServiceView[] {
  return parkServiceConfiguration.listServices(parkId);
}

export function updateParkService(input: {
  parkId: string;
  actorAccountId: string;
  serviceId: string;
  name?: string;
  enabled?: boolean;
  config?: Record<string, string>;
}): ParkServiceView {
  return parkServiceConfiguration.updateService(input);
}

export function getPark(id: string): ParkView | null {
  return parkLifecycle.getPark(id);
}

export function getParkForOrganization(
  organizationId: string,
): ParkView | null {
  return parkLifecycle.getParkForOrganization(organizationId);
}

export function listParkTenantOrganizations(
  parkId: string,
): OrganizationView[] {
  const park = getPark(parkId);
  if (!park) throw new Error('Park not found');
  return (
    getDB()
      .prepare(
        `SELECT o.*, profile.address AS park_address, profile.room_number AS park_room_number
         FROM organizations o
         LEFT JOIN park_tenant_profiles profile ON profile.organization_id = o.id AND profile.park_id = o.park_id
         WHERE o.park_id = ? AND o.id <> ?
         ORDER BY o.name COLLATE NOCASE, o.slug`,
      )
      .all(park.id, park.adminOrganizationId) as OrganizationDirectoryRow[]
  ).map(toOrganizationDirectoryView);
}

const parkMembershipStore = {
  db: getDB,
  getAccount,
  getPark,
  getParkForOrganization,
  createInviteId: () => `park_invite_${randomUUID()}`,
  createInviteNonce: () => randomBytes(20).toString('hex'),
  inviteValidityMs: ORGANIZATION_INVITE_VALIDITY_MS,
  inviteAlphabet: ORGANIZATION_INVITE_ALPHABET,
  inviteCodeRawLength: INVITE_CODE_RAW_LENGTH,
  normalizeInviteCode: normalizeOrganizationInviteCode,
  normalizeOptionalText,
};
const parkMembership = createParkMembershipFacade(parkMembershipStore);

const parkPublicationStore = {
  db: getDB,
  getAccount,
  getParkForOrganization,
  createPublicationId: () => `park_publication_${randomUUID()}`,
  audit: logAudit,
};

export const {
  createParkPublication,
  listParkAnnouncementResults,
  listParkPublications,
  listParkSurveyResults,
  markParkPublicationRead,
  submitParkSurvey,
} = createParkPublicationFacade(parkPublicationStore);

export function getParkTenantProfile(
  organizationId: string,
): ParkTenantProfileView | null {
  return parkMembership.getTenantProfile(organizationId);
}

export function updateParkTenantProfile(input: {
  organizationId: string;
  actorAccountId: string;
  address: string;
  roomNumber: string;
}): ParkTenantProfileView {
  return parkMembership.updateTenantProfile(input);
}

const parkStatisticsStore = {
  db: getDB,
  getAccount,
  getPark,
  getParkForOrganization,
  getOrganizationFeatures,
  listAccounts,
  listParkServices,
  listParkTenantOrganizations,
  createTaskId: () => `park_statistics_${randomUUID()}`,
  createAssignmentId: () => `park_statistics_assignment_${randomUUID()}`,
  nowISO: () => new Date().toISOString(),
  audit: (
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
};
const parkStatistics = createParkStatisticsFacade(parkStatisticsStore);
export const getParkServiceStatistics =
  parkStatistics.getParkServiceStatistics;

export function createParkDataStatisticsTask(input: {
  createdByAccountId: string;
  title: string;
  description: string;
  deadline: string;
  fields?: string[];
  templateName?: string | null;
  templateData?: string | null;
  organizationIds?: string[];
}): { task: ParkDataStatisticsTaskView; recipientCount: number } {
  return parkStatistics.createParkDataStatisticsTask(input);
}

export function listParkDataStatisticsTasks(
  accountId: string,
): ParkDataStatisticsTaskView[] {
  return parkStatistics.listParkDataStatisticsTasks(accountId);
}

export function markParkDataStatisticsRead(
  taskId: string,
  accountId: string,
): ParkDataStatisticsAssignmentView {
  return parkStatistics.markParkDataStatisticsRead(taskId, accountId);
}

export function getParkDataStatisticsTemplate(
  taskId: string,
  accountId: string,
): {
  name: string;
  data: string;
} {
  return parkStatistics.getParkDataStatisticsTemplate(taskId, accountId);
}

export function delegateParkDataStatistics(
  taskId: string,
  accountId: string,
  assigneeAccountId: string,
): ParkDataStatisticsAssignmentView {
  return parkStatistics.delegateParkDataStatistics(
    taskId,
    accountId,
    assigneeAccountId,
  );
}

export function submitParkDataStatisticsDraft(
  taskId: string,
  accountId: string,
  responseData: Record<string, string>,
): ParkDataStatisticsAssignmentView {
  return parkStatistics.submitParkDataStatisticsDraft(
    taskId,
    accountId,
    responseData,
  );
}

export function reviewParkDataStatistics(
  taskId: string,
  accountId: string,
  approved: boolean,
  reason?: string,
): ParkDataStatisticsAssignmentView {
  return parkStatistics.reviewParkDataStatistics(
    taskId,
    accountId,
    approved,
    reason,
  );
}

export function remindParkDataStatistics(
  taskId: string,
  adminAccountId: string,
): ParkDataStatisticsTaskView {
  return parkStatistics.remindParkDataStatistics(taskId, adminAccountId);
}

export function returnParkDataStatistics(
  taskId: string,
  adminAccountId: string,
  organizationId: string,
  reason: string,
): ParkDataStatisticsAssignmentView {
  return parkStatistics.returnParkDataStatistics(
    taskId,
    adminAccountId,
    organizationId,
    reason,
  );
}
export function createParkAsPlatform(input: {
  adminOrganizationId: string;
  name?: string;
  slug?: string;
  brandName?: string;
}): ParkView {
  return parkLifecycle.createParkAsPlatform(input);
}

export function updateParkAsPlatform(input: {
  adminOrganizationId: string;
  name?: string;
  brandName?: string;
}): ParkView {
  return parkLifecycle.updateParkAsPlatform(input);
}

export function createPark(input: {
  adminOrganizationId: string;
  actorAccountId: string;
  name: string;
  slug?: string;
  brandName?: string;
}): ParkView {
  return parkLifecycle.createPark(input);
}

export function issueParkInvite(input: {
  parkId: string;
  actorAccountId: string;
  maxUses?: number | null;
  now?: number;
}): ParkInviteView {
  return parkMembership.issueInvite(input);
}

export function joinOrganizationToPark(input: {
  organizationId: string;
  actorAccountId: string;
  code: string;
  address: string;
  roomNumber: string;
  now?: number;
}): ParkView {
  return parkMembership.joinOrganization(input);
}

export function listParkServiceSpecialists(
  parkId: string,
): ParkServiceSpecialistView[] {
  return parkServiceConfiguration.listSpecialists(parkId);
}

export function setParkServiceSpecialist(input: {
  parkId: string;
  actorAccountId: string;
  serviceId: string;
  accountId: string;
}): ParkServiceSpecialistView {
  return parkServiceConfiguration.setSpecialist(input);
}

export function removeParkServiceSpecialist(input: {
  parkId: string;
  actorAccountId: string;
  serviceId: string;
  accountId: string;
}): void {
  parkServiceConfiguration.removeSpecialist(input);
}

const parkTicketStore = {
  db: getDB,
  getAccount,
  isOrganizationActive: (organizationId: string) =>
    getOrganization(organizationId)?.status === 'active',
  getOrganizationFeatures,
  getPark,
  getParkForOrganization,
  listParkServices,
  listParkServiceSpecialists,
  listActiveOrganizationAdmins: (organizationId: string) =>
    listAccounts(organizationId).filter(
      (account) => account.isAdmin && account.status === 'active',
    ),
  listActiveAccountsByDepartment: (
    organizationId: string,
    department: string,
    excludeAccountId: string,
  ) => listAccounts(organizationId).filter(
    (account) => account.status === 'active'
      && account.department === department
      && account.id !== excludeAccountId,
  ),
  listActiveAccountsByTags: (organizationId: string, tags: string[]) =>
    listAccounts(organizationId).filter(
      (account) => account.status === 'active'
        && tags.every((tag) => account.tags.includes(tag)),
    ),
  normalizeTags,
  isParkServiceId: (serviceId: string) => PARK_SERVICE_IDS.has(serviceId),
  createTicketId: () => `ticket_${randomUUID()}`,
  createTicketEventId: () => `ticket_event_${randomUUID()}`,
  createTicketNotificationId: () => `ticket_notice_${randomUUID()}`,
  audit: logAudit,
};
const parkTickets = createParkTicketFacade<AccountView>(parkTicketStore);

export const {
  createTicket,
  getTicketCreatorForAccount,
  getTicketForAccount,
  getTicketNotificationRecipients,
  getTicketTransferredNotificationRecipients,
  isTicketFeatureEnabledForAccount,
  listTicketInbox,
  listTicketsForAccount,
  markTicketRead,
  normalizeParkServiceFormData,
  recordTicketNotification,
  updateTicket,
} = parkTickets;

const parkResourceStore = {
  db: getDB,
  createMeetingRoomId: () => `park_room_${randomUUID()}`,
  createMeetingBookingId: () => `park_booking_${randomUUID()}`,
};
const parkResources = createParkResourceFacade(parkResourceStore);

export const {
  createParkMeetingRoom,
  deleteParkMeetingRoom,
  getParkSettings,
  listParkMeetingRooms,
  listParkMeetingSlots,
  reserveParkMeetingPeriod,
  reserveParkMeetingSlot,
  setParkMeetingSlotAvailability,
  updateParkMeetingRoom,
  updateParkSettings,
} = parkResources;

export {
  PARK_MEETING_CLOSE_MINUTES,
  PARK_MEETING_OPEN_MINUTES,
  PARK_MEETING_SLOT_MINUTES,
  PARK_MEETING_TIME_SLOTS,
} from '../modules/park_services/index.js';
export type {
  ParkMeetingRoomView,
  ParkMeetingSlotView,
  ParkSettingsView,
} from '../modules/park_services/index.js';

export type {
  ParkAnnouncementResultView,
  ParkPublicationView,
  ParkSurveyResultView,
} from '../modules/park_services/index.js';

// ============================================================
// Provider-reported Token usage (client_reported, idempotent)
// ============================================================

const modelUsage = createModelUsageFacade({
  db: getDB,
  getAccount,
  getOrganization,
  listOrganizationAccounts: listAccounts,
  createUsageId: () => `usage_${randomUUID()}`,
});

export const { getOrganizationUsageSummary, recordTokenUsage } = modelUsage;
export type {
  AccountTokenUsageView,
  OrganizationUsageSummary,
} from '../modules/model_gateway/index.js';

// ============================================================
// Task logging and reports
// ============================================================
const worklogs = createWorklogFacade<EmployeeRecord, OrganizationView>({
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  getOrganization,
  getEmployee,
  listActiveEmployees: listEmployees,
  audit: logAudit,
});

export const { getReport, getTaskHistory, logTask } = worklogs;
export { ESTIMATE, normalizeCostCNY, normalizeTokens };
export type {
  LogWorkTaskInput,
  WorklogRecord,
  WorklogReport,
} from '../modules/personal_intelligence/index.js';

// ============================================================
// Knowledge operations
// ============================================================
const enterpriseKnowledgeStore = {
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  organizationExists: (organizationId: string) =>
    Boolean(getOrganization(organizationId)),
};

export const {
  addKnowledge,
  getKnowledge,
  getMemberKnowledge,
  searchKnowledge,
} = createEnterpriseKnowledgeFacade(enterpriseKnowledgeStore);

// ============================================================
// Invite codes
// ============================================================
// ============================================================
// Export all (for backup)
// ============================================================
export function exportAll(organizationId = DEFAULT_ORGANIZATION_ID) {
  return {
    // Full backup must include offboarded employees too, otherwise every
    // offboarding silently erases historical employee records from the
    // export — contradicting the "export ALL data" guarantee.
    employees: getDB()
      .prepare(
        'SELECT * FROM employees WHERE organization_id = ? ORDER BY onboarded_at',
      )
      .all(organizationId),
    taskLogs: getDB()
      .prepare(
        `SELECT * FROM task_logs WHERE organization_id = ?
       ORDER BY created_at DESC LIMIT 1000`,
      )
      .all(organizationId),
    knowledge: getKnowledge(undefined, undefined, organizationId),
    inviteCodes: getDB()
      .prepare('SELECT * FROM invite_codes WHERE organization_id = ?')
      .all(organizationId),
    auditLogs: getAuditLogs(200, organizationId),
    // 账号导出不包含 password_hash / session token 摘要；备份可迁移组织信息，
    // 但不能把登录凭证扩散到普通数据导出文件。
    accounts: listAccounts(organizationId),
    accountTags: listOrganizationAccountTagsInRepository(
      accountTagStore,
      organizationId,
    ),
    tickets: getDB()
      .prepare(
        `SELECT * FROM it_tickets WHERE organization_id = ? ORDER BY created_at DESC`,
      )
      .all(organizationId),
    ticketDeliveries: getDB()
      .prepare(
        `SELECT * FROM ticket_deliveries WHERE organization_id = ? ORDER BY delivered_at DESC`,
      )
      .all(organizationId),
  };
}
