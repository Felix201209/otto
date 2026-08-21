/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Legacy synchronous enterprise repositories. Local/offline mode uses
 * SQLite/SQLCipher; clustered PostgreSQL mode is rejected here until each
 * route repository has moved to its asynchronous contract.
 * 存储层通过 data_platform 使用 Node 内置 node:sqlite，无原生依赖。
 */

import {
  applyDatabaseSchemaContributors,
  createDataProtectionService,
  createEncryptedFieldCipher,
  createEncryptedObjectStore,
  createDataPlatformComposition,
  createFileEncryptionKeyProvider,
  createSqlCipherFileRuntime,
  describeEnterpriseServiceTopology,
  parseSqlCipherRuntimeMode,
  requireLocalSqliteTopology,
  resolveEnterpriseServiceTopology,
  Database,
} from '../modules/data_platform/index.js';
import { createAuthorizationComposition } from '../modules/authorization/index.js';
import {
  createDataGovernanceComposition,
  DATA_GOVERNANCE_SCHEMA_CONTRIBUTOR,
} from '../modules/data_governance/index.js';
import {
  COLLABORATION_SCHEMA_CONTRIBUTOR,
  createCollaborationComposition,
  type AccountPresenceView as CollaborationAccountPresenceView,
} from '../modules/collaboration/index.js';
import {
  createEnterpriseKnowledgeComposition,
  createEnterpriseKnowledgeSchemaContributor,
} from '../modules/enterprise_knowledge/index.js';
import {
  createEnterpriseSkillMarketplaceComposition,
  ENTERPRISE_SKILL_MARKET_SCHEMA_CONTRIBUTOR,
} from '../modules/enterprise_skill_market/index.js';
import { createIntegrationAdaptersComposition } from '../modules/integration_adapters/index.js';
import {
  createFederationComposition,
  FEDERATION_GATEWAY_SCHEMA_CONTRIBUTOR,
} from '../modules/federation_gateway/index.js';
import {
  createMeshRendezvousComposition,
  MESH_RENDEZVOUS_SCHEMA_CONTRIBUTOR,
} from '../modules/mesh_rendezvous/index.js';
import {
  createModelGatewayComposition,
  MODEL_GATEWAY_SCHEMA_CONTRIBUTOR,
} from '../modules/model_gateway/index.js';
import {
  createPersonalIntelligenceComposition,
  createWorklogSchemaContributor,
  ESTIMATE,
  normalizeCostCNY,
  normalizeTokens,
  PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR,
} from '../modules/personal_intelligence/index.js';
import {
  createParkPublicationSchemaContributor,
  PARK_RESOURCE_SCHEMA_CONTRIBUTOR,
  createParkServicesComposition,
  createParkTicketSchemaContributor,
  createTicketEscalationSchemaContributor,
  listParkTicketsForBackup,
  listTicketDeliveriesForBackup,
  migrateLegacyParkTicketEvents,
  PARK_CORE_SCHEMA_CONTRIBUTOR,
  PARK_STATISTICS_SCHEMA_CONTRIBUTOR,
} from '../modules/park_services/index.js';
import path from 'path';
import os from 'os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createAuditLogSchemaContributor,
  createCommercialControlComposition,
  createCreditsSchemaContributor,
  parsePublicKeyList,
  PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR,
} from '../modules/commercial_control/index.js';
import {
  backfillEnterpriseAccountEmployees,
  backfillLegacyOrganizationStructure,
  createAccountAccessComposition,
  createAccountAuthSchemaContributor,
  createAccountMutationComposition,
  createEnterpriseInviteSchemaContributor,
  createMemberSchemaContributor,
  createOrganizationWorkforceComposition,
  IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR,
  IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR,
  getOrganizationPositionRoleMappingFromRepository,
  listAccountTagsInRepository,
  listDepartmentInvitesForBackup,
  listEmployeesForBackup,
  listOrganizationAccountTagsInRepository,
  migrateLegacyEnterpriseTenant,
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
  E2eeAttachmentCiphertextInput,
  E2eeMessageEnvelope,
  UnreadDirectMessageNotification,
} from '../modules/collaboration/index.js';
export type {
  AddEnterpriseKnowledgeInput,
  EnterpriseKnowledgeEntryView,
} from '../modules/enterprise_knowledge/index.js';
export type {
  EnterpriseSkillActor,
  EnterpriseSkillInstallView,
  EnterpriseSkillLeaderboard,
  EnterpriseSkillStatus,
  EnterpriseSkillView,
  EnterpriseSkillVisibility,
} from '../modules/enterprise_skill_market/index.js';
export {
  ACCOUNT_SYNC_SCOPES,
  AccountSyncConflictError,
} from '../modules/personal_intelligence/index.js';
export type {
  DataGovernanceAccount,
  PrivacyDeletionReceipt,
} from '../modules/data_governance/index.js';
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
export type {
  FederationDirectoryEntry,
  FederationInboxMessageView,
  FederationMessageType,
  FederationProvisioningManifest,
  FederationQueueInput,
  FederationRoutingMetadata,
} from '../modules/federation_gateway/index.js';
export { PARK_SERVICE_IDS } from '../modules/park_services/index.js';

const DATA_DIR =
  process.env.OTTO_ENTERPRISE_DIR ||
  path.join(os.homedir(), '.otto-enterprise');
const DB_PATH = path.join(DATA_DIR, 'data.db');
const ENTERPRISE_SERVICE_TOPOLOGY = resolveEnterpriseServiceTopology({
  environment: process.env,
  sqliteDatabasePath: DB_PATH,
});
requireLocalSqliteTopology(ENTERPRISE_SERVICE_TOPOLOGY.database);
const DATABASE_ENCRYPTION_MODE = parseSqlCipherRuntimeMode();
const SQLCIPHER_RUNTIME =
  DATABASE_ENCRYPTION_MODE === 'required'
    ? createSqlCipherFileRuntime({ dataDirectory: DATA_DIR })
    : null;
const ACCOUNT_SYNC_EXTERNAL_KEY_PATH =
  process.env.OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE?.trim() || null;
const ACCOUNT_SYNC_KEY_PATH =
  ACCOUNT_SYNC_EXTERNAL_KEY_PATH || path.join(DATA_DIR, 'account-sync.key');
const ATTACHMENT_STORAGE_DIR =
  process.env.OTTO_ATTACHMENT_STORAGE_DIR || path.join(DATA_DIR, 'attachments');
const ATTACHMENT_EXTERNAL_KEY_PATH =
  process.env.OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE?.trim() || null;
const ATTACHMENT_STORAGE_KEY_PATH =
  ATTACHMENT_EXTERNAL_KEY_PATH || path.join(DATA_DIR, 'attachment-storage.key');
const FIELD_EXTERNAL_KEY_PATH =
  process.env.OTTO_FIELD_ENCRYPTION_KEY_FILE?.trim() || null;
const FIELD_ENCRYPTION_KEY_PATH =
  FIELD_EXTERNAL_KEY_PATH || path.join(DATA_DIR, 'field-encryption.key');
const BACKUP_STORAGE_DIR =
  process.env.OTTO_BACKUP_DIR || path.join(DATA_DIR, 'backups');
const PRIVACY_DELETION_LEDGER_PATH = path.join(
  DATA_DIR,
  'privacy-deletions.jsonl',
);
const PRIVACY_DELETION_LEDGER_KEY_PATH = path.join(
  DATA_DIR,
  'privacy-deletions.key',
);

export const DEFAULT_ORGANIZATION_ID = 'org_default';
export const ENTERPRISE_SCHEMA_VERSION = 22;
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
    createTicketEscalationSchemaContributor({
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
    ENTERPRISE_SKILL_MARKET_SCHEMA_CONTRIBUTOR,
    IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR,
    createMemberSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
    createWorklogSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
    PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR,
    DATA_GOVERNANCE_SCHEMA_CONTRIBUTOR,
    PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR,
    FEDERATION_GATEWAY_SCHEMA_CONTRIBUTOR,
    MESH_RENDEZVOUS_SCHEMA_CONTRIBUTOR,
    createAuditLogSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
  ]);

  migrateLegacyEnterpriseTenant(d, {
    defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    defaultOrganizationName:
      process.env.OTTO_DEFAULT_ORGANIZATION_NAME?.trim() || '默认企业',
    inviteSecret: randomBytes(32).toString('hex'),
  });
  backfillEnterpriseAccountEmployees(d);
  backfillLegacyOrganizationStructure(d);
}

const dataPlatform = createDataPlatformComposition({
  encryptionKey: {
    keyPath: ACCOUNT_SYNC_KEY_PATH,
    keyBytes: 32,
    invalidKeyMessage: 'account sync encryption key is invalid',
    createIfMissing: !ACCOUNT_SYNC_EXTERNAL_KEY_PATH,
    managePermissions: !ACCOUNT_SYNC_EXTERNAL_KEY_PATH,
  },
  database: {
    dataDirectory: DATA_DIR,
    databasePath: DB_PATH,
    legacyBackupPath: `${DB_PATH}.pre-b2b-v2.bak`,
    schemaVersion: ENTERPRISE_SCHEMA_VERSION,
    beforeForeignKeys(database) {
      migrateLegacyAuthSessions(database, DEFAULT_ORGANIZATION_ID);
      migrateLegacyParkTicketEvents(database);
    },
    initializeSchema: initSchema,
  },
  ...(SQLCIPHER_RUNTIME
    ? {
        databaseEncryption: {
          keyProvider: SQLCIPHER_RUNTIME.keyProvider,
          driver: SQLCIPHER_RUNTIME.driver,
        },
      }
    : {}),
});
const accountSyncKeyProvider = dataPlatform.encryptionKeyProvider;
const attachmentStorageKeyProvider = createFileEncryptionKeyProvider({
  keyPath: ATTACHMENT_STORAGE_KEY_PATH,
  keyBytes: 32,
  invalidKeyMessage: 'attachment storage encryption key is invalid',
  createIfMissing: !ATTACHMENT_EXTERNAL_KEY_PATH,
  managePermissions: !ATTACHMENT_EXTERNAL_KEY_PATH,
});
const fieldEncryptionKeyProvider = createFileEncryptionKeyProvider({
  keyPath: FIELD_ENCRYPTION_KEY_PATH,
  keyBytes: 32,
  invalidKeyMessage: 'field encryption key is invalid',
  createIfMissing: !FIELD_EXTERNAL_KEY_PATH,
  managePermissions: !FIELD_EXTERNAL_KEY_PATH,
});
const fieldCipher = createEncryptedFieldCipher({
  keyProvider: fieldEncryptionKeyProvider,
});
const attachmentObjectStore = createEncryptedObjectStore({
  root: ATTACHMENT_STORAGE_DIR,
  keyProvider: attachmentStorageKeyProvider,
});
const dataProtection = createDataProtectionService({
  dataDirectory: DATA_DIR,
  databasePath: DB_PATH,
  schemaVersion: ENTERPRISE_SCHEMA_VERSION,
  accountSyncKeyPath: ACCOUNT_SYNC_KEY_PATH,
  attachmentKeyPath: ATTACHMENT_STORAGE_KEY_PATH,
  fieldEncryptionKeyPath: FIELD_ENCRYPTION_KEY_PATH,
  ...(SQLCIPHER_RUNTIME
    ? {
        databaseKeyRecoveryPath: SQLCIPHER_RUNTIME.keyPath,
        createDatabaseSnapshot: dataPlatform.createDatabaseSnapshot,
        openDatabaseSnapshot: dataPlatform.openDatabaseSnapshot,
      }
    : {}),
  attachmentDirectory: ATTACHMENT_STORAGE_DIR,
  privacyDeletionLedgerPath: PRIVACY_DELETION_LEDGER_PATH,
  privacyDeletionLedgerKeyPath: PRIVACY_DELETION_LEDGER_KEY_PATH,
  attachmentObjectStore,
  getDatabase: dataPlatform.getDatabase,
  backupDirectory: BACKUP_STORAGE_DIR,
  replicaDirectory: process.env.OTTO_BACKUP_REPLICA_DIR?.trim() || null,
  encryptionKey: process.env.OTTO_BACKUP_ENCRYPTION_KEY,
  encryptionKeyPath: process.env.OTTO_BACKUP_ENCRYPTION_KEY_FILE,
  intervalHours: Number(process.env.OTTO_BACKUP_INTERVAL_HOURS || 24),
  encryptionKeyRecoveryPath:
    process.env.OTTO_BACKUP_ENCRYPTION_KEY_RECOVERY_FILE,
  retentionDays: Number(process.env.OTTO_BACKUP_RETENTION_DAYS || 30),
  minimumRetained: Number(process.env.OTTO_BACKUP_MINIMUM_RETAINED || 3),
  minimumFreeBytes:
    Number(process.env.OTTO_DISK_MIN_FREE_MB || 2048) * 1024 * 1024,
  appVersion: () => process.env.OTTO_APP_VERSION?.trim() || 'development',
  buildCommit: () => process.env.OTTO_BUILD_COMMIT?.trim() || 'unknown',
});

/** 释放当前企业数据库连接；服务关闭或隔离测试清理时调用。 */
export function closeEnterpriseDatabase(): void {
  try {
    dataPlatform.closeDatabase();
  } finally {
    attachmentStorageKeyProvider.clear();
    fieldEncryptionKeyProvider.clear();
  }
}

export const getDB = dataPlatform.getDatabase;

/** Credential-free storage topology for diagnostics and readiness output. */
export function getEnterpriseServiceTopology() {
  return describeEnterpriseServiceTopology(ENTERPRISE_SERVICE_TOPOLOGY);
}

/**
 * Credential-free operations posture for the enterprise admin page. Planning
 * targets are reported as not connected until a real runtime adapter exists.
 */
export function getOperationsSecurityStatus() {
  let sqlCipher:
    | {
        state: 'active';
        keyVersion: number;
        migratedFromPlaintext: boolean;
      }
    | { state: 'disabled' | 'error' };
  if (!SQLCIPHER_RUNTIME) {
    sqlCipher = { state: 'disabled' };
  } else {
    try {
      const status = dataPlatform.getDatabaseEncryptionStatus();
      sqlCipher = {
        state: 'active',
        keyVersion: status.keyVersion,
        migratedFromPlaintext: status.migratedFromPlaintext,
      };
    } catch {
      sqlCipher = { state: 'error' };
    }
  }
  return {
    topology: getEnterpriseServiceTopology(),
    sqlCipher,
    keyManagement: {
      databaseKeyProvider: SQLCIPHER_RUNTIME
        ? ('offline-file' as const)
        : ('not-configured' as const),
      remoteProvider: 'not-connected' as const,
      automaticRotation: 'not-configured' as const,
      sseKms:
        ENTERPRISE_SERVICE_TOPOLOGY.attachments.backend === 's3' &&
        Boolean(ENTERPRISE_SERVICE_TOPOLOGY.attachments.kmsKeyId)
          ? ('configured' as const)
          : ('not-configured' as const),
    },
  };
}

/** 执行真实读查询，供 HTTP readiness 判断数据库与 schema 是否可用。 */
export const getDatabaseReadiness = dataPlatform.getReadiness;
export const getDatabaseEncryptionStatus =
  dataPlatform.getDatabaseEncryptionStatus;
export const rotateDatabaseEncryptionKey = dataPlatform.rotateDatabaseKey;

export const getDataProtectionStatus = dataProtection.getStatus;
export const runDataProtectionBackup = dataProtection.runBackup;
export const sweepOrphanAttachments = dataProtection.sweepOrphanAttachments;
export const startDataProtectionRuntime = dataProtection.start;

// ============================================================
// Organizations and time-boxed registration invites
// ============================================================

export const {
  getAuditLogs,
  logAudit,
  checkAndReserveCredits,
  createRedeemCodes,
  deductCredits,
  getCreditBalance,
  listCreditTransactions,
  listRedeemCodes,
  redeemCode,
  revokeRedeemCode,
  topUpCredits,
  getModuleUpdateManifest,
  updateModuleUpdateDescriptor,
  getDeploymentId,
  getMachineFingerprint,
  getDeploymentLicense,
  importDeploymentLicense,
  importDeploymentLicenseLease,
  refreshDeploymentLicenseLease,
  resolveDeploymentUpdatePolicy,
  getTelemetrySettings,
  updateTelemetrySettings,
  recordTelemetryEvent,
  getTelemetryQueueSummary,
  flushTelemetryQueue,
  queueBillingUsage,
  flushBillingUsageQueue,
  getBillingExecutionReceiptKey,
  authorizeBillingOperation,
  finalizeBillingOperation,
  flushBillingAdmissionQueue,
  ingestTelemetryBatch,
  ensureDeploymentLicenseSecretsEncrypted,
  getPrivateDeploymentStatus,
  exportDeploymentDiagnostics,
  isLicenseUsableForOrganizationFeature,
  isLicenseRestricted,
} = createCommercialControlComposition({
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  creditTokenRate: () => process.env.OTTO_CREDIT_TOKEN_RATE,
  licenseEnforcementEnabled: () =>
    process.env.OTTO_LICENSE_ENFORCE === 'true' ||
    (process.env.NODE_ENV === 'production' &&
      process.env.OTTO_LICENSE_ENFORCE !== 'false'),
  licenseVerificationPublicKeys: () =>
    parsePublicKeyList(
      process.env.OTTO_LICENSE_PUBLIC_KEYS ||
        process.env.OTTO_LICENSE_PUBLIC_KEY,
      process.env.OTTO_LICENSE_REVOKED_KEY_IDS,
    ),
  telemetryEndpoint: () => process.env.OTTO_TELEMETRY_ENDPOINT || null,
  telemetryIngestSecret: () => process.env.OTTO_TELEMETRY_INGEST_SECRET || '',
  telemetryRetentionDays: () =>
    Number(process.env.OTTO_TELEMETRY_RETENTION_DAYS || 90),
  fieldCipher,
  databaseReadiness: getDatabaseReadiness,
});

export const {
  getFederationStatus,
  getFederationProvisioningManifest,
  getFederationMemberIdentity,
  lookupFederationDeployment,
  saveFederationChatContact,
  listFederationChatContacts,
  removeFederationChatContact,
  createFederationChatAttachmentUpload,
  completeFederationChatAttachmentUpload,
  createFederationChatAttachmentDownload,
  queueFederationChatMessage,
  listFederationChatMessages,
  markFederationChatMessageRead,
  queueFederationMessage,
  listFederationInbox,
  consumeFederationInbox,
  createFederationContactA2aGrant,
  createFederationA2aGrant,
  revokeFederationA2aGrant,
  blockFederationDeployment,
  unblockFederationDeployment,
  listFederationBlocks,
  runFederationCycle,
  startFederationRuntime,
} = createFederationComposition({
  db: getDB,
  fieldCipher,
  deploymentId: getDeploymentId,
  dataDirectory: DATA_DIR,
  enabled: () => process.env.OTTO_FEDERATION_ENABLED === 'true',
  gatewayUrl: () => process.env.OTTO_FEDERATION_GATEWAY_URL?.trim() || null,
  publicOrigin: () => process.env.OTTO_ENTERPRISE_PUBLIC_URL?.trim() || null,
  displayName: () =>
    process.env.OTTO_FEDERATION_DISPLAY_NAME?.trim() ||
    process.env.OTTO_DEFAULT_ORGANIZATION_NAME?.trim() ||
    'Otto private deployment',
  signingKeyPath: () =>
    process.env.OTTO_FEDERATION_SIGNING_KEY_FILE?.trim() || null,
  pollIntervalMs: () =>
    Number(process.env.OTTO_FEDERATION_POLL_INTERVAL_MS || 10_000),
  allowInsecureLoopback:
    process.env.NODE_ENV === 'test' &&
    process.env.OTTO_FEDERATION_ALLOW_INSECURE_LOOPBACK === 'true',
});

export const {
  publishRendezvous,
  lookupRendezvous,
  listRendezvous,
  createRelaySession,
  putRelayChunk,
  takeRelayChunks,
  declareP2P,
  closeRelaySession,
  status,
} = createMeshRendezvousComposition({
  db: getDB,
  now: Date.now,
  signingKey: process.env.OTTO_MESH_SIGNING_KEY?.trim() || undefined,
});

export type OrganizationView = OrganizationDirectoryView;

export const {
  getOrganization,
  listOrganizations,
  getEnterpriseOrganization,
  listEnterpriseOrganizations,
  createInviteCode,
  validateInviteCode,
  listOrganizationStructure,
  createOrganizationDepartment,
  updateOrganizationDepartment,
  deleteOrganizationDepartment,
  createOrganizationPosition,
  updateOrganizationPosition,
  deleteOrganizationPosition,
  resolveAssignmentIdentity,
  createEmployee,
  getEmployee,
  listEmployees,
  updateEmployeeOnboardingProfile,
  offboardEmployee,
  normalizeOrganizationInviteCode,
  inspectOrganizationInvite,
  issueOrganizationInvite,
  getOrganizationInvite,
  resolveOrganizationInviteWithDefaults,
  resolveOrganizationInvite,
} = createOrganizationWorkforceComposition({
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  organizationInviteValidityMs: ORGANIZATION_INVITE_VALIDITY_MS,
  organizationInviteAlphabet: ORGANIZATION_INVITE_ALPHABET,
  organizationInviteCodeRawLength: INVITE_CODE_RAW_LENGTH,
  normalizeOptionalText,
  audit: logAudit,
});

export type OrganizationPositionRoleMapping =
  IdentityOrganizationPositionRoleMapping;
export type OrganizationPositionView = IdentityOrganizationPositionView;
export type OrganizationDepartmentView = IdentityOrganizationDepartmentView;

export type OrganizationFeatures = IdentityOrganizationFeatures;

export const {
  getOrganizationFeatures,
  updateOrganizationFeatures,
  isOrganizationFeatureEnabled,
  requireOrganizationFeature,
} = createAuthorizationComposition({
  db: getDB,
  audit: logAudit,
  isLicenseUsable: isLicenseUsableForOrganizationFeature,
});

export const {
  getEnterpriseSkillLeaderboard,
  installEnterpriseSkill,
  listEnterpriseSkills,
  rateEnterpriseSkill,
  recordEnterpriseSkillUsage,
  reviewEnterpriseSkill,
  submitEnterpriseSkill,
} = createEnterpriseSkillMarketplaceComposition({
  db: getDB,
  fieldCipher,
  createId: randomUUID,
  organizationExists: (organizationId) =>
    Boolean(getOrganization(organizationId)),
});

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
export const isAcceptableAccountPassword = isAcceptableIdentityAccountPassword;

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

export const {
  getAccount,
  listAccounts,
  authenticateAccount,
  findAccountByPhone,
  findActiveAccountByPhone,
  listFeishuAccountBindings,
  createAuthSession,
  getAccountBySession,
  revokeAuthSession,
  createSmsLoginChallenge,
  discardSmsLoginChallenge,
  verifySmsLoginChallenge,
  createSmsRegistrationChallenge,
  discardSmsRegistrationChallenge,
  verifySmsRegistrationChallenge,
} = createAccountAccessComposition<AccountView, AccountRow>({
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  now: Date.now,
  normalizeIdentifier: normalizeUsername,
  normalizePhone,
  passwordMatches,
  isOrganizationActive: (organizationId: string) =>
    getOrganization(organizationId)?.status === 'active',
  organizationExists: (organizationId: string) =>
    Boolean(getOrganization(organizationId)),
  toAccountView,
  hashSecret: hashIdentitySecret,
  secretMatches: identitySecretMatches,
  createChallengeId: (kind: 'login' | 'registration') =>
    `${kind === 'login' ? 'sms' : 'smsreg'}_${randomUUID()}`,
  audit: logAudit,
});

const personalIntelligence = createPersonalIntelligenceComposition<
  AccountView,
  EmployeeRecord,
  OrganizationView
>({
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  keyProvider: accountSyncKeyProvider,
  getAccount,
  getOrganization,
  getEmployee,
  listActiveEmployees: listEmployees,
  audit: logAudit,
});

export const {
  listAccountSyncSnapshots,
  putAccountSyncSnapshot,
  getReport,
  getTaskHistory,
  logTask,
} = personalIntelligence;
const listWorklogsForBackup = personalIntelligence.listWorklogsForBackup;

/** 企业、首位管理员和首个 7 天邀请要么全部成功，要么全部回滚。 */
export const {
  createAccount,
  updateAccount,
  deleteAccount,
  createOrganization,
  provisionOrganization,
  createSelfRegisteredAccount,
  createPersonalRegisteredAccount,
  joinOrganizationWithInvite,
} = createAccountMutationComposition<
  AccountView,
  OrganizationView,
  OrganizationInviteView
>({
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  now: Date.now,
  organizationExists: (organizationId: string) =>
    Boolean(getOrganization(organizationId)),
  normalizeUsername,
  normalizePhone,
  normalizeOptionalPhone,
  normalizeOptionalFeishuOpenId,
  normalizeOptionalAvatarUrl,
  assertPassword: assertAccountPassword,
  hashPassword: passwordHash,
  createAccountEntityId: (prefix: 'acc' | 'emp') => `${prefix}_${randomUUID()}`,
  createDeletionPasswordHash: () =>
    passwordHash(randomBytes(32).toString('base64url')),
  createOrganizationId: () => `org_${randomUUID()}`,
  createInviteSecret: () => randomBytes(32).toString('hex'),
  createDefaultSlugSuffix: () => randomBytes(5).toString('hex'),
  createUsernameSuffix: () => randomBytes(4).toString('hex'),
  createPersonalSlugSuffix: () => randomBytes(8).toString('hex'),
  resolveAssignmentIdentity,
  getPositionRoleMapping: getOrganizationPositionRoleMappingFromRepository,
  createEmployee(input) {
    const { inviteCode, ...employee } = input;
    return createEmployee({
      ...employee,
      invite_code: inviteCode,
    });
  },
  getAccount,
  findAccountByPhone,
  getOrganization,
  issueOrganizationInvite,
  resolveOrganizationInviteWithDefaults,
  normalizeOrganizationInviteCode,
  replaceMigratedAccountTags(accountId, organizationId, tags) {
    replaceMigratedAccountTagsInRepository(
      accountTagStore,
      accountId,
      organizationId,
      tags,
    );
  },
  audit: logAudit,
});

export const {
  ensureDirectMessageContentEncrypted,
  getDirectMessageAttachment,
  listDirectMessages,
  getE2eeAttachment,
  approveE2eeDevice,
  listE2eeDevices,
  listE2eeKeyTransparency,
  publishMlsKeyPackage,
  listMlsKeyPackageInventory,
  retireMlsKeyPackage,
  claimMlsKeyPackage,
  appendMlsTransportEvent,
  listMlsTransportEvents,
  getMlsAttachmentSession,
  listMlsInboundConversationPeers,
  cleanupExpiredMlsResources,
  listE2eeDirectMessages,
  listPendingE2eeAtoaRequests,
  listUnreadE2eeNotifications,
  listPendingAtoaRequests,
  listUnreadDirectMessageNotifications,
  markAtoaRequestReadFromResponse,
  sendDirectMessage,
  registerE2eeDevice,
  revokeE2eeDevice,
  sendE2eeDirectMessage,
  touchAccountPresence,
  listAccountPresence,
} = createCollaborationComposition<AccountView>({
  db: getDB,
  now: Date.now,
  createId: randomUUID,
  fieldCipher,
  attachmentObjectStore,
  getAccount,
});

export const {
  getDataGovernanceProfile,
  recordCurrentLegalConsent,
  exportAccountData,
  deleteOwnAccountData,
  reapplyPrivacyDeletionTombstones,
} = createDataGovernanceComposition({
  db: getDB,
  ledgerPath: PRIVACY_DELETION_LEDGER_PATH,
  ledgerKeyPath: PRIVACY_DELETION_LEDGER_KEY_PATH,
  fieldCipher,
  attachmentObjectStore,
  createDeletionPasswordHash: passwordHash,
});

// The ledger lives outside data.db. Restoring an older encrypted backup cannot
// resurrect an account whose deletion was already completed.
reapplyPrivacyDeletionTombstones();

export type AccountPresenceView = CollaborationAccountPresenceView;

const integrationAdapters = createIntegrationAdaptersComposition({
  listFeishuAccountBindings,
  isLicenseUsableForOrganizationFeature,
  isOrganizationFeatureEnabled,
});

export const { isFeishuAutoReplyEnabledForOpenId } = integrationAdapters;

export type SmsChallengeIssueResult = IdentitySmsChallengeIssueResult;
export type SmsRegistrationVerifyResult = IdentitySmsRegistrationVerifyResult;
export type SmsChallengeVerifyResult =
  IdentitySmsChallengeVerifyResult<AccountView>;

// ============================================================
// Park tenants, organization membership and service specialists
// ============================================================

export const {
  cancelPendingTicketNotificationTasks,
  createPark,
  createParkAsPlatform,
  createParkMeetingRoom,
  createParkDataStatisticsTask,
  createParkPublication,
  createTicket,
  createTicketWithMeetingReservation,
  deleteParkMeetingRoom,
  delegateParkDataStatistics,
  getPark,
  getParkDataStatisticsTemplate,
  getParkForOrganization,
  getParkServiceStatistics,
  getParkSettings,
  getParkTenantProfile,
  getTicketCreatorForAccount,
  getTicketForAccount,
  getTicketNotificationRecipients,
  getTicketTransferredNotificationRecipients,
  isTicketFeatureEnabledForAccount,
  issueParkInvite,
  joinOrganizationToPark,
  listParkAnnouncementResults,
  listParkDataStatisticsTasks,
  listParkMeetingRooms,
  listParkMeetingSlots,
  listParkPublications,
  listParkServices,
  listParkServiceSpecialists,
  listParkSurveyResults,
  listParkTenantOrganizations,
  listTicketInbox,
  listTicketsForAccount,
  markParkDataStatisticsRead,
  markParkPublicationRead,
  markTicketRead,
  normalizeParkServiceFormData,
  processTicketNotificationTasks,
  recordTicketNotification,
  remindParkDataStatistics,
  removeParkServiceSpecialist,
  reserveParkMeetingPeriod,
  reserveParkMeetingSlot,
  returnParkDataStatistics,
  reviewParkDataStatistics,
  scheduleTicketNotificationTask,
  setParkMeetingSlotAvailability,
  setParkServiceSpecialist,
  submitParkDataStatisticsDraft,
  submitParkSurvey,
  updateParkAsPlatform,
  updateParkMeetingRoom,
  updateParkService,
  updateParkSettings,
  updateParkTenantProfile,
  updateTicket,
} = createParkServicesComposition<AccountView, OrganizationView>({
  db: getDB,
  getAccount,
  getOrganization: getEnterpriseOrganization,
  isOrganizationActive: (organizationId) =>
    getOrganization(organizationId)?.status === 'active',
  listAccounts,
  getOrganizationFeatures,
  toOrganizationView: toOrganizationDirectoryView,
  normalizeOptionalText,
  normalizeSlug: normalizeOrganizationSlug,
  normalizeInviteCode: normalizeOrganizationInviteCode,
  normalizeTags,
  createUuid: randomUUID,
  createRandomHex: (byteLength) => randomBytes(byteLength).toString('hex'),
  inviteValidityMs: ORGANIZATION_INVITE_VALIDITY_MS,
  inviteAlphabet: ORGANIZATION_INVITE_ALPHABET,
  inviteCodeRawLength: INVITE_CODE_RAW_LENGTH,
  audit: logAudit,
});

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

const modelGateway = createModelGatewayComposition({
  db: getDB,
  getAccount,
  getOrganization,
  listOrganizationAccounts: listAccounts,
  createId: randomUUID,
  onRecordedUsage(input) {
    if (input.totalTokens < 1) return;
    const digest = createHash('sha256')
      .update(
        [getDeploymentId(), input.organizationId, input.messageId].join('\0'),
        'utf8',
      )
      .digest('hex');
    queueBillingUsage({
      organizationId: input.organizationId,
      module: 'model_gateway',
      units: input.totalTokens,
      model: input.model,
      referenceId: `usage_${digest.slice(0, 32)}`,
      idempotencyKey: `usage:${digest}`,
    });
  },
});

export const { getOrganizationUsageSummary, recordTokenUsage } = modelGateway;
export type {
  AccountTokenUsageView,
  OrganizationUsageSummary,
} from '../modules/model_gateway/index.js';

export { ESTIMATE, normalizeCostCNY, normalizeTokens };
export type {
  LogWorkTaskInput,
  WorklogRecord,
  WorklogReport,
} from '../modules/personal_intelligence/index.js';

// ============================================================
// Knowledge operations
// ============================================================
export const {
  observeKnowledge,
  addKnowledge,
  getKnowledge,
  getKnowledgeForAdministration,
  getKnowledgeForBackup,
  getKnowledgeRevisions,
  getMemberKnowledge,
  reviewKnowledge,
  reviseKnowledge,
  saveKnowledge,
  searchKnowledge,
} = createEnterpriseKnowledgeComposition({
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  getOrganization,
});

// ============================================================
// Invite codes
// ============================================================
// ============================================================
// Export all (for backup)
// ============================================================
const backupDatabaseStore = { db: getDB };

const enterpriseBackup = dataPlatform.createBackup({
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  listEmployees: (organizationId) =>
    listEmployeesForBackup(backupDatabaseStore, organizationId),
  listTaskLogs: (organizationId) => listWorklogsForBackup(organizationId),
  listKnowledge: (organizationId) => getKnowledgeForBackup(organizationId),
  listInviteCodes: (organizationId) =>
    listDepartmentInvitesForBackup(backupDatabaseStore, organizationId),
  listAuditLogs: (organizationId) => getAuditLogs(200, organizationId),
  // Account repositories deliberately omit password hashes and session tokens.
  listAccounts,
  listAccountTags: (organizationId) =>
    listOrganizationAccountTagsInRepository(accountTagStore, organizationId),
  listTickets: (organizationId) =>
    listParkTicketsForBackup(backupDatabaseStore, organizationId),
  listTicketDeliveries: (organizationId) =>
    listTicketDeliveriesForBackup(backupDatabaseStore, organizationId),
});

export const { exportAll } = enterpriseBackup;
