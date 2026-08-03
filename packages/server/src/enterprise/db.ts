/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise SQLite database - all data stored on admin/owner device.
 * Zero cloud dependency. All data is local.
 * ε­ε‚¨ε±‚ι€θΏ‡ data_platform δ½Ώη”¨ Node ε†…η½® node:sqliteοΌζ— εη”δΎθµ–γ€‚
 */

import {
  applyDatabaseSchemaContributors,
  createDataProtectionService,
  createEncryptedFieldCipher,
  createEncryptedObjectStore,
  createDataPlatformComposition,
  createFileEncryptionKeyProvider,
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
export const ENTERPRISE_SCHEMA_VERSION = 19;
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
    createAuditLogSchemaContributor({
      defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    }),
  ]);

  migrateLegacyEnterpriseTenant(d, {
    defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
    defaultOrganizationName:
      process.env.OTTO_DEFAULT_ORGANIZATION_NAME?.trim() || 'ι»θ®¤δΌδΈ',
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
  retentionDays: Number(process.env.OTTO_BACKUP_RETENTION_DAYS || 30),
  minimumRetained: Number(process.env.OTTO_BACKUP_MINIMUM_RETAINED || 3),
  minimumFreeBytes:
    Number(process.env.OTTO_DISK_MIN_FREE_MB || 2048) * 1024 * 1024,
  appVersion: () => process.env.OTTO_APP_VERSION?.trim() || 'development',
  buildCommit: () => process.env.OTTO_BUILD_COMMIT?.trim() || 'unknown',
});

/** ι‡ζ”Ύε½“ε‰δΌδΈζ•°ζ®εΊ“θΏζ¥οΌ›ζε΅ε…³ι—­ζ–ι”η¦»ζµ‹θ―•ζΈ…η†ζ—¶θ°ƒη”¨γ€‚ */
export function closeEnterpriseDatabase(): void {
  try {
    dataPlatform.closeDatabase();
  } finally {
    attachmentStorageKeyProvider.clear();
    fieldEncryptionKeyProvider.clear();
  }
}

export const getDB = dataPlatform.getDatabase;

/** ζ‰§θ΅ηε®θ―»ζ¥θ―ΆοΌδΎ› HTTP readiness ε¤ζ–­ζ•°ζ®εΊ“δΈ schema ζ―ε¦ε―η”¨γ€‚ */
export const getDatabaseReadiness = dataPlatform.getReadiness;

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
      process.env.OTTO_LICENSΧy¶‰ΛkΊwµηM¥Ρ¥½Ή%θΝΡΙ¥ΉπΉΥ±°μ(€Α½Ν¥Ρ¥½ΉQ¥Ρ±”θΝΡΙ¥ΉπΉΥ±°μ(€…Ω…Ρ…ΙUΙ°θΝΡΙ¥ΉπΉΥ±°μ(€¥Ν‘µ¥Έθ‰½½±•…Έμ(€ΝΡ…ΡΥΜθ€…Ρ¥Ω”π€‘¥Ν…‰±•μ(€Ρ…ΜθΝΡΙ¥Ήmtμ(€Ι•…Ρ•‘ΠθΝΡΙ¥Ήμ(€ΥΑ‘…Ρ•‘ΠθΝΡΙ¥Ήμ)τ()•αΑ½ΙΠ¥ΉΡ•Ι™…”½ΥΉΡI½άμ(€¥θΝΡΙ¥Ήμ(€½Ι…Ή¥ι…Ρ¥½Ή}¥θΝΡΙ¥Ήμ(€…½ΥΉΡ}ΡεΑ”θ€Α•ΙΝ½Ή…°π€•ΉΡ•ΙΑΙ¥Ν”πΉΥ±°μ(€•µΑ±½ε••}¥θΝΡΙ¥ΉπΉΥ±°μ(€ΥΝ•ΙΉ…µ”θΝΡΙ¥Ήμ(€Α΅½Ή”θΝΡΙ¥ΉπΉΥ±°μ(€™•¥Ν΅Υ}½Α•Ή}¥θΝΡΙ¥ΉπΉΥ±°μ(€Α…ΝΝέ½Ι‘}΅…Ν θΝΡΙ¥Ήμ(€Ή…µ”θΝΡΙ¥Ήμ(€Ι½±”θΝΡΙ¥ΉπΉΥ±°μ(€‘•Α…ΙΡµ•ΉΠθΝΡΙ¥ΉπΉΥ±°μ(€‘•Α…ΙΡµ•ΉΡ}¥θΝΡΙ¥ΉπΉΥ±°μ(€Α½Ν¥Ρ¥½Ή}¥θΝΡΙ¥ΉπΉΥ±°μ(€Α½Ν¥Ρ¥½Ή}Ρ¥Ρ±”θΝΡΙ¥ΉπΉΥ±°μ(€…Ω…Ρ…Ι}ΥΙ°θΝΡΙ¥ΉπΉΥ±°μ(€¥Ν}…‘µ¥ΈθΉΥµ‰•Θμ(€ΝΡ…ΡΥΜθ€…Ρ¥Ω”π€‘¥Ν…‰±•μ(€‘•±•Ρ•‘}…ΠθΝΡΙ¥ΉπΉΥ±°μ(€Ι•…Ρ•‘}…ΠθΝΡΙ¥Ήμ(€ΥΑ‘…Ρ•‘}…ΠθΝΡΙ¥Ήμ)τ()™ΥΉΡ¥½ΈΉ½Ιµ…±¥ι•UΝ•ΙΉ…µ”΅ΥΝ•ΙΉ…µ”θΝΡΙ¥Ή¤θΝΡΙ¥Ήμ(€Ι•ΡΥΙΈΥΝ•ΙΉ…µ”ΉΡΙ¥΄ ¤ΉΡ½1½…±•1½έ•Ι…Ν” •ΈµUL¤μ)τ((Ό¨¨ƒ’β·–nχ–’¦f&/rλ–>ίξ’β’ώw–¶c’βθΈΔΨΣΎςo–ΖW’λ–J3’β/–>G~·’ώ‡^Ϋ–7–:ο:$€¬ΰΫ€¨Ό)•αΑ½ΙΠ™ΥΉΡ¥½ΈΉ½Ιµ…±¥ι•A΅½Ή”΅Α΅½Ή”θΝΡΙ¥Ή¤θΝΡΙ¥Ήμ(€±•Π‘¥¥ΡΜ€τΑ΅½Ή”ΉΡΙ¥΄ ¤ΉΙ•Α±…” ½myq‘t½°€¤μ(€¥€΅‘¥¥ΡΜΉΝΡ…ΙΡΝ]¥Ρ  ΐΐΰΨ¤¤‘¥¥ΡΜ€τ‘¥¥ΡΜΉΝ±¥” Π¤μ(€•±Ν”¥€΅‘¥¥ΡΜΉΝΡ…ΙΡΝ]¥Ρ  ΰΨ¤€‘¥¥ΡΜΉ±•ΉΡ €τττ€ΔΜ¤(€€€‘¥¥ΡΜ€τ‘¥¥ΡΜΉΝ±¥” Θ¤μ(€¥€ „½xΕlΜ΄εuq‘μετΌΉΡ•ΝΠ΅‘¥¥ΡΜ¤¤Ρ΅Ι½άΉ•άΙΙ½Θ &/rλ–>ί‚σ–ς?’β7¶†Έ¤μ(€Ι•ΡΥΙΈ€¬ΰΨ‘ν‘¥¥ΡΝυ€μ)τ()™ΥΉΡ¥½ΈΉ½Ιµ…±¥ι•=ΑΡ¥½Ή…±A΅½Ή” (€Α΅½Ή”θΝΡΙ¥ΉπΉΥ±°πΥΉ‘•™¥Ή•°(¤θΝΡΙ¥ΉπΉΥ±°μ(€¥€΅Α΅½Ή”€ττΉΥ±°ρπ€…Α΅½Ή”ΉΡΙ¥΄ ¤¤Ι•ΡΥΙΈΉΥ±°μ(€Ι•ΡΥΙΈΉ½Ιµ…±¥ι•A΅½Ή”΅Α΅½Ή”¤μ)τ()™ΥΉΡ¥½ΈΉ½Ιµ…±¥ι•=ΑΡ¥½Ή…±•¥Ν΅Υ=Α•Ή% (€Ω…±Υ”θΝΡΙ¥ΉπΉΥ±°πΥΉ‘•™¥Ή•°(¤θΝΡΙ¥ΉπΉΥ±°μ(€¥€΅Ω…±Υ”€ττΉΥ±°ρπ€…Ω…±Υ”ΉΡΙ¥΄ ¤¤Ι•ΡΥΙΈΉΥ±°μ(€½ΉΝΠ½Α•Ή%€τΩ…±Υ”ΉΡΙ¥΄ ¤μ(€¥€ „½y½Υ}mµi„µθΐ΄ε|µt¬ΌΉΡ•ΝΠ΅½Α•Ή%¤¤(€€€Ρ΅Ι½άΉ•άΙΙ½Θ ¦{’ζ½Α•Ή}¥ƒ‚σ–ς?’β7¶†Έ¤μ(€Ι•ΡΥΙΈ½Α•Ή%μ)τ()™ΥΉΡ¥½ΈΉ½Ιµ…±¥ι•=ΑΡ¥½Ή…±Ω…Ρ…ΙUΙ° (€Ω…±Υ”θΝΡΙ¥ΉπΉΥ±°πΥΉ‘•™¥Ή•°(¤θΝΡΙ¥ΉπΉΥ±°μ(€¥€΅Ω…±Υ”€ττΉΥ±°ρπ€…Ω…±Υ”ΉΡΙ¥΄ ¤¤Ι•ΡΥΙΈΉΥ±°μ(€½ΉΝΠ…Ω…Ρ…ΙUΙ°€τΩ…±Υ”ΉΡΙ¥΄ ¤μ(€¥€ ½y΅ΡΡΑΜιp½pΌ½¤ΉΡ•ΝΠ΅…Ω…Ρ…ΙUΙ°¤¤μ(€€€¥€΅…Ω…Ρ…ΙUΙ°Ή±•ΉΡ €ψ€Ι|ΐΐΐ¤(€€€€€Ρ΅Ι½άΉ•άΙΙ½Θ –’Σ–?–rΓ–v’β7ΆχΆΪΆώ€Θΐΐΐƒ’β«–¶_²¤μ(€€€ΡΙδμ(€€€€€¥€΅Ή•άUI0΅…Ω…Ρ…ΙUΙ°¤ΉΑΙ½Ρ½½°€„ττ€΅ΡΡΑΜθ¤Ρ΅Ι½άΉ•άΙΙ½Θ ¤μ(€€€τ…Ρ μ(€€€€€Ρ΅Ι½άΉ•άΙΙ½Θ –’Σ–?–rΓ–v‚σ–ς?’β7¶†Έ¤μ(€€€τ(€€€Ι•ΡΥΙΈ…Ω…Ρ…ΙUΙ°μ(€τ(€½ΉΝΠµ…Ρ €τ(€€€€½y‘…Ρ„ι¥µ…•pΌ΅ΑΉρ©Α•ρέ•‰Αρ¥¤ν‰…Ν”ΨΠ°΅mµi„µθΐ΄δ¬½t¬υμΐ°Ιτ¤½¤Ή•α• (€€€€€…Ω…Ρ…ΙUΙ°°(€€€€¤μ(€¥€ …µ…Ρ ¤(€€€Ρ΅Ι½άΉ•άΙΙ½Θ (€€€€€€–’Σ–?’ξRΏ2!QQALƒ"XA9)A]•‰C%ƒ‚σ–ς?j‘…Ρ„ι¥µ…”°(€€€€¤μ(€¥€ (€€€…Ω…Ρ…ΙUΙ°Ή±•ΉΡ €ψ€άΐΑ|ΐΐΐρπ(€€€	Υ™™•ΘΉ™Ι½΄΅µ…Ρ΅lΙt„°€‰…Ν”ΨΠ¤Ή‰εΡ•1•ΉΡ €ψ€ΤΔΘ€¨€ΔΐΘΠ(€€¤μ(€€€Ρ΅Ι½άΉ•άΙΙ½Θ –’Σ–?VΓ6»’β7ΆχΆΪΆώ€ΤΔΙ-¤μ(€τ(€Ι•ΡΥΙΈ…Ω…Ρ…ΙUΙ°μ)τ()•αΑ½ΙΠ½ΉΝΠΉ½Ιµ…±¥ι•Q…Μ€τΉ½Ιµ…±¥ι•½ΥΉΡQ…Μμ()½ΉΝΠΑ…ΝΝέ½Ι‘!…Ν €τ΅…Ν΅%‘•ΉΡ¥ΡεM•Ι•Πμ)½ΉΝΠΑ…ΝΝέ½Ι‘5…Ρ΅•Μ€τ¥‘•ΉΡ¥ΡεM•Ι•Ρ5…Ρ΅•Μμ)½ΉΝΠ…ΝΝ•ΙΡ½ΥΉΡA…ΝΝέ½Ι€τ…ΝΝ•ΙΡ%‘•ΉΡ¥Ρε½ΥΉΡA…ΝΝέ½Ιμ)•αΑ½ΙΠ½ΉΝΠ¥Ν•ΑΡ…‰±•½ΥΉΡA…ΝΝέ½Ι€τ(€¥Ν•ΑΡ…‰±•%‘•ΉΡ¥Ρε½ΥΉΡA…ΝΝέ½Ιμ()½ΉΝΠ…½ΥΉΡQ…MΡ½Ι”€τμ‘θ•Ρτμ()•αΑ½ΙΠ™ΥΉΡ¥½ΈΡ½½ΥΉΡY¥•ά΅Ι½άθ½ΥΉΡI½ά¤θ½ΥΉΡY¥•άμ(€½ΉΝΠ½Ι…Ή¥ι…Ρ¥½Έ€τ•Ρ=Ι…Ή¥ι…Ρ¥½Έ΅Ι½άΉ½Ι…Ή¥ι…Ρ¥½Ή}¥¤μ(€Ι•ΡΥΙΈμ(€€€¥θΙ½άΉ¥°(€€€½Ι…Ή¥ι…Ρ¥½Ή%θΙ½άΉ½Ι…Ή¥ι…Ρ¥½Ή}¥°(€€€½Ι…Ή¥ι…Ρ¥½Ή9…µ”θ½Ι…Ή¥ι…Ρ¥½ΈόΉΉ…µ”ρπ€r«~—’ς’βh°(€€€…½ΥΉΡQεΑ”θΙ½άΉ…½ΥΉΡ}ΡεΑ”€τττ€Α•ΙΝ½Ή…°€ό€Α•ΙΝ½Ή…°€θ€•ΉΡ•ΙΑΙ¥Ν”°(€€€•µΑ±½ε••%θΙ½άΉ•µΑ±½ε••}¥°(€€€ΥΝ•ΙΉ…µ”θΙ½άΉΥΝ•ΙΉ…µ”°(€€€Α΅½Ή”θΙ½άΉΑ΅½Ή”°(€€€™•¥Ν΅Υ=Α•Ή%θΙ½άΉ™•¥Ν΅Υ}½Α•Ή}¥°(€€€Ή…µ”θΙ½άΉΉ…µ”°(€€€Ι½±”θΙ½άΉΙ½±”°(€€€‘•Α…ΙΡµ•ΉΠθΙ½άΉ‘•Α…ΙΡµ•ΉΠ°(€€€‘•Α…ΙΡµ•ΉΡ%θΙ½άΉ‘•Α…ΙΡµ•ΉΡ}¥°(€€€Α½Ν¥Ρ¥½Ή%θΙ½άΉΑ½Ν¥Ρ¥½Ή}¥°(€€€Α½Ν¥Ρ¥½ΉQ¥Ρ±”θΙ½άΉΑ½Ν¥Ρ¥½Ή}Ρ¥Ρ±”°(€€€…Ω…Ρ…ΙUΙ°θΙ½άΉ…Ω…Ρ…Ι}ΥΙ°°(€€€¥Ν‘µ¥ΈθΙ½άΉ¥Ν}…‘µ¥Έ€τττ€Δ°(€€€ΝΡ…ΡΥΜθΙ½άΉΝΡ…ΡΥΜ°(€€€Ρ…Μθ±¥ΝΡ½ΥΉΡQ…Ν%ΉI•Α½Ν¥Ρ½Ιδ (€€€€€…½ΥΉΡQ…MΡ½Ι”°(€€€€€Ι½άΉ¥°(€€€€€Ι½άΉ½Ι…Ή¥ι…Ρ¥½Ή}¥°(€€€€¤°(€€€Ι•…Ρ•‘ΠθΙ½άΉΙ•…Ρ•‘}…Π°(€€€ΥΑ‘…Ρ•‘ΠθΙ½άΉΥΑ‘…Ρ•‘}…Π°(€τμ)τ()•αΑ½ΙΠ½ΉΝΠμ(€•Ρ½ΥΉΠ°(€±¥ΝΡ½ΥΉΡΜ°(€…ΥΡ΅•ΉΡ¥…Ρ•½ΥΉΠ°(€™¥Ή‘½ΥΉΡ	εA΅½Ή”°(€™¥Ή‘Ρ¥Ω•½ΥΉΡ	εA΅½Ή”°(€±¥ΝΡ•¥Ν΅Υ½ΥΉΡ	¥Ή‘¥ΉΜ°(€Ι•…Ρ•ΥΡ΅M•ΝΝ¥½Έ°(€•Ρ½ΥΉΡ	εM•ΝΝ¥½Έ°(€Ι•Ω½­•ΥΡ΅M•ΝΝ¥½Έ°(€Ι•…Ρ•MµΝ1½¥Ή΅…±±•Ή”°(€‘¥Ν…Ι‘MµΝ1½¥Ή΅…±±•Ή”°(€Ω•Ι¥™εMµΝ1½¥Ή΅…±±•Ή”°(€Ι•…Ρ•MµΝI•¥ΝΡΙ…Ρ¥½Ή΅…±±•Ή”°(€‘¥Ν…Ι‘MµΝI•¥ΝΡΙ…Ρ¥½Ή΅…±±•Ή”°(€Ω•Ι¥™εMµΝI•¥ΝΡΙ…Ρ¥½Ή΅…±±•Ή”°)τ€τΙ•…Ρ•½ΥΉΡ•ΝΝ½µΑ½Ν¥Ρ¥½Έρ½ΥΉΡY¥•ά°½ΥΉΡI½άψ΅μ(€‘θ•Ρ°(€‘•™…Υ±Ρ=Ι…Ή¥ι…Ρ¥½Ή%θU1Q}=I9%iQ%=9}%°(€Ή½άθ…Ρ”ΉΉ½ά°(€Ή½Ιµ…±¥ι•%‘•ΉΡ¥™¥•ΘθΉ½Ιµ…±¥ι•UΝ•ΙΉ…µ”°(€Ή½Ιµ…±¥ι•A΅½Ή”°(€Α…ΝΝέ½Ι‘5…Ρ΅•Μ°(€¥Ν=Ι…Ή¥ι…Ρ¥½ΉΡ¥Ω”θ€΅½Ι…Ή¥ι…Ρ¥½Ή%θΝΡΙ¥Ή¤€τψ(€€€•Ρ=Ι…Ή¥ι…Ρ¥½Έ΅½Ι…Ή¥ι…Ρ¥½Ή%¤όΉΝΡ…ΡΥΜ€τττ€…Ρ¥Ω”°(€½Ι…Ή¥ι…Ρ¥½Ήα¥ΝΡΜθ€΅½Ι…Ή¥ι…Ρ¥½Ή%θΝΡΙ¥Ή¤€τψ(€€€	½½±•…Έ΅•Ρ=Ι…Ή¥ι…Ρ¥½Έ΅½Ι…Ή¥ι…Ρ¥½Ή%¤¤°(€Ρ½½ΥΉΡY¥•ά°(€΅…Ν΅M•Ι•Πθ΅…Ν΅%‘•ΉΡ¥ΡεM•Ι•Π°(€Ν•Ι•Ρ5…Ρ΅•Μθ¥‘•ΉΡ¥ΡεM•Ι•Ρ5…Ρ΅•Μ°(€Ι•…Ρ•΅…±±•Ή•%θ€΅­¥Ήθ€±½¥Έπ€Ι•¥ΝΡΙ…Ρ¥½Έ¤€τψ(€€€€‘ν­¥Ή€τττ€±½¥Έ€ό€ΝµΜ€θ€ΝµΝΙ•υ|‘νΙ…Ή‘½µUU% ¥υ€°(€…Υ‘¥Πθ±½Υ‘¥Π°)τ¤μ()½ΉΝΠΑ•ΙΝ½Ή…±%ΉΡ•±±¥•Ή”€τΙ•…Ρ•A•ΙΝ½Ή…±%ΉΡ•±±¥•Ή•½µΑ½Ν¥Ρ¥½Έπ(€½ΥΉΡY¥•ά°(€µΑ±½ε••I•½Ι°(€=Ι…Ή¥ι…Ρ¥½ΉY¥•ά(ψ΅μ(€‘θ•Ρ°(€‘•™…Υ±Ρ=Ι…Ή¥ι…Ρ¥½Ή%θU1Q}=I9%iQ%=9}%°(€­•εAΙ½Ω¥‘•Θθ…½ΥΉΡMεΉ-•εAΙ½Ω¥‘•Θ°(€•Ρ½ΥΉΠ°(€•Ρ=Ι…Ή¥ι…Ρ¥½Έ°(€•ΡµΑ±½ε•”°(€±¥ΝΡΡ¥Ω•µΑ±½ε••Μθ±¥ΝΡµΑ±½ε••Μ°(€…Υ‘¥Πθ±½Υ‘¥Π°)τ¤μ()•αΑ½ΙΠ½ΉΝΠμ(€±¥ΝΡ½ΥΉΡMεΉMΉ…ΑΝ΅½ΡΜ°(€ΑΥΡ½ΥΉΡMεΉMΉ…ΑΝ΅½Π°(€•ΡI•Α½ΙΠ°(€•ΡQ…Ν­!¥ΝΡ½Ιδ°(€±½Q…Ν¬°)τ€τΑ•ΙΝ½Ή…±%ΉΡ•±±¥•Ή”μ)½ΉΝΠ±¥ΝΡ]½Ι­±½Ν½Ι	…­Υΐ€τΑ•ΙΝ½Ή…±%ΉΡ•±±¥•Ή”Ή±¥ΝΡ]½Ι­±½Ν½Ι	…­Υΐμ((Ό¨¨ƒ’ς’βk¦[’φ7Ί‡B–Fc–J3¦[’β¨€άƒ–’§¦
ΆΎίΆ’ζ#–£¦£"C–*Ύς3Ά’ζ#–£¦£–n{ξk€¨Ό)•αΑ½ΙΠ½ΉΝΠμ(€Ι•…Ρ•½ΥΉΠ°(€ΥΑ‘…Ρ•½ΥΉΠ°(€‘•±•Ρ•½ΥΉΠ°(€Ι•…Ρ•=Ι…Ή¥ι…Ρ¥½Έ°(€ΑΙ½Ω¥Ν¥½Ή=Ι…Ή¥ι…Ρ¥½Έ°(€Ι•…Ρ•M•±™I•¥ΝΡ•Ι•‘½ΥΉΠ°(€Ι•…Ρ•A•ΙΝ½Ή…±I•¥ΝΡ•Ι•‘½ΥΉΠ°(€©½¥Ή=Ι…Ή¥ι…Ρ¥½Ή]¥Ρ΅%ΉΩ¥Ρ”°)τ€τΙ•…Ρ•½ΥΉΡ5ΥΡ…Ρ¥½Ή½µΑ½Ν¥Ρ¥½Έπ(€½ΥΉΡY¥•ά°(€=Ι…Ή¥ι…Ρ¥½ΉY¥•ά°(€=Ι…Ή¥ι…Ρ¥½Ή%ΉΩ¥Ρ•Y¥•ά(ψ΅μ(€‘θ•Ρ°(€‘•™…Υ±Ρ=Ι…Ή¥ι…Ρ¥½Ή%θU1Q}=I9%iQ%=9}%°(€Ή½άθ…Ρ”ΉΉ½ά°(€½Ι…Ή¥ι…Ρ¥½Ήα¥ΝΡΜθ€΅½Ι…Ή¥ι…Ρ¥½Ή%θΝΡΙ¥Ή¤€τψ(€€€	½½±•…Έ΅•Ρ=Ι…Ή¥ι…Ρ¥½Έ΅½Ι…Ή¥ι…Ρ¥½Ή%¤¤°(€Ή½Ιµ…±¥ι•UΝ•ΙΉ…µ”°(€Ή½Ιµ…±¥ι•A΅½Ή”°(€Ή½Ιµ…±¥ι•=ΑΡ¥½Ή…±A΅½Ή”°(€Ή½Ιµ…±¥ι•=ΑΡ¥½Ή…±•¥Ν΅Υ=Α•Ή%°(€Ή½Ιµ…±¥ι•=ΑΡ¥½Ή…±Ω…Ρ…ΙUΙ°°(€…ΝΝ•ΙΡA…ΝΝέ½Ιθ…ΝΝ•ΙΡ½ΥΉΡA…ΝΝέ½Ι°(€΅…Ν΅A…ΝΝέ½ΙθΑ…ΝΝέ½Ι‘!…Ν °(€Ι•…Ρ•½ΥΉΡΉΡ¥Ρε%θ€΅ΑΙ•™¥ΰθ€…π€•µΐ¤€τψ(€€€€‘νΑΙ•™¥αυ|‘νΙ…Ή‘½µUU% ¥υ€°(€Ι•…Ρ••±•Ρ¥½ΉA…ΝΝέ½Ι‘!…Ν θ€ ¤€τψ(€€€Α…ΝΝέ½Ι‘!…Ν ΅Ι…Ή‘½µ	εΡ•Μ ΜΘ¤ΉΡ½MΡΙ¥Ή ‰…Ν”ΨΡΥΙ°¤¤°(€Ι•…Ρ•=Ι…Ή¥ι…Ρ¥½Ή%θ€ ¤€τψ½Ι|‘νΙ…Ή‘½µUU% ¥υ€°(€Ι•…Ρ•%ΉΩ¥Ρ•M•Ι•Πθ€ ¤€τψΙ…Ή‘½µ	εΡ•Μ ΜΘ¤ΉΡ½MΡΙ¥Ή ΅•ΰ¤°(€Ι•…Ρ••™…Υ±ΡM±ΥMΥ™™¥ΰθ€ ¤€τψΙ…Ή‘½µ	εΡ•Μ Τ¤ΉΡ½MΡΙ¥Ή ΅•ΰ¤°(€Ι•…Ρ•UΝ•ΙΉ…µ•MΥ™™¥ΰθ€ ¤€τψΙ…Ή‘½µ	εΡ•Μ Π¤ΉΡ½MΡΙ¥Ή ΅•ΰ¤°(€Ι•…Ρ•A•ΙΝ½Ή…±M±ΥMΥ™™¥ΰθ€ ¤€τψΙ…Ή‘½µ	εΡ•Μ ΰ¤ΉΡ½MΡΙ¥Ή ΅•ΰ¤°(€Ι•Ν½±Ω•ΝΝ¥Ήµ•ΉΡ%‘•ΉΡ¥Ρδ°(€•ΡA½Ν¥Ρ¥½ΉI½±•5…ΑΑ¥Ήθ•Ρ=Ι…Ή¥ι…Ρ¥½ΉA½Ν¥Ρ¥½ΉI½±•5…ΑΑ¥ΉΙ½µI•Α½Ν¥Ρ½Ιδ°(€Ι•…Ρ•µΑ±½ε•”΅¥ΉΑΥΠ¤μ(€€€½ΉΝΠμ¥ΉΩ¥Ρ•½‘”°€ΈΈΉ•µΑ±½ε•”τ€τ¥ΉΑΥΠμ(€€€Ι•ΡΥΙΈΙ•…Ρ•µΑ±½ε•”΅μ(€€€€€€ΈΈΉ•µΑ±½ε•”°(€€€€€¥ΉΩ¥Ρ•}½‘”θ¥ΉΩ¥Ρ•½‘”°(€€€τ¤μ(€τ°(€•Ρ½ΥΉΠ°(€™¥Ή‘½ΥΉΡ	εA΅½Ή”°(€•Ρ=Ι…Ή¥ι…Ρ¥½Έ°(€¥ΝΝΥ•=Ι…Ή¥ι…Ρ¥½Ή%ΉΩ¥Ρ”°(€Ι•Ν½±Ω•=Ι…Ή¥ι…Ρ¥½Ή%ΉΩ¥Ρ•]¥Ρ΅•™…Υ±ΡΜ°(€Ή½Ιµ…±¥ι•=Ι…Ή¥ι…Ρ¥½Ή%ΉΩ¥Ρ•½‘”°(€Ι•Α±…•5¥Ι…Ρ•‘½ΥΉΡQ…Μ΅…½ΥΉΡ%°½Ι…Ή¥ι…Ρ¥½Ή%°Ρ…Μ¤μ(€€€Ι•Α±…•5¥Ι…Ρ•‘½ΥΉΡQ…Ν%ΉI•Α½Ν¥Ρ½Ιδ (€€€€€…½ΥΉΡQ…MΡ½Ι”°(€€€€€…½ΥΉΡ%°(€€€€€½Ι…Ή¥ι…Ρ¥½Ή%°(€€€€€Ρ…Μ°(€€€€¤μ(€τ°(€…Υ‘¥Πθ±½Υ‘¥Π°)τ¤μ()•αΑ½ΙΠ½ΉΝΠμ(€•ΉΝΥΙ•¥Ι•Ρ5•ΝΝ…•½ΉΡ•ΉΡΉΙεΑΡ•°(€•Ρ¥Ι•Ρ5•ΝΝ…•ΡΡ…΅µ•ΉΠ°(€±¥ΝΡ¥Ι•Ρ5•ΝΝ…•Μ°(€±¥ΝΡA•Ή‘¥ΉΡ½…I•ΕΥ•ΝΡΜ°(€±¥ΝΡUΉΙ•…‘¥Ι•Ρ5•ΝΝ…•9½Ρ¥™¥…Ρ¥½ΉΜ°(€µ…Ι­Ρ½…I•ΕΥ•ΝΡI•…‘Ι½µI•ΝΑ½ΉΝ”°(€Ν•Ή‘¥Ι•Ρ5•ΝΝ…”°(€Ρ½Υ΅½ΥΉΡAΙ•Ν•Ή”°(€±¥ΝΡ½ΥΉΡAΙ•Ν•Ή”°)τ€τΙ•…Ρ•½±±…‰½Ι…Ρ¥½Ή½µΑ½Ν¥Ρ¥½Έρ½ΥΉΡY¥•άψ΅μ(€‘θ•Ρ°(€Ή½άθ…Ρ”ΉΉ½ά°(€Ι•…Ρ•%θΙ…Ή‘½µUU%°(€™¥•±‘¥Α΅•Θ°(€…ΡΡ…΅µ•ΉΡ=‰©•ΡMΡ½Ι”°(€•Ρ½ΥΉΠ°)τ¤μ()•αΑ½ΙΠ½ΉΝΠμ(€•Ρ…Ρ…½Ω•ΙΉ…Ή•AΙ½™¥±”°(€Ι•½Ι‘ΥΙΙ•ΉΡ1•…±½ΉΝ•ΉΠ°(€•αΑ½ΙΡ½ΥΉΡ…Ρ„°(€‘•±•Ρ•=έΉ½ΥΉΡ…Ρ„°(€Ι•…ΑΑ±εAΙ¥Ω…ε•±•Ρ¥½ΉQ½µ‰ΝΡ½Ή•Μ°)τ€τΙ•…Ρ•…Ρ…½Ω•ΙΉ…Ή•½µΑ½Ν¥Ρ¥½Έ΅μ(€‘θ•Ρ°(€±•‘•ΙA…Ρ θAI%Ye}1Q%=9}1I}AQ °(€±•‘•Ι-•εA…Ρ θAI%Ye}1Q%=9}1I}-e}AQ °(€™¥•±‘¥Α΅•Θ°(€…ΡΡ…΅µ•ΉΡ=‰©•ΡMΡ½Ι”°(€Ι•…Ρ••±•Ρ¥½ΉA…ΝΝέ½Ι‘!…Ν θΑ…ΝΝέ½Ι‘!…Ν °)τ¤μ((ΌΌQ΅”±•‘•Θ±¥Ω•Μ½ΥΡΝ¥‘”‘…Ρ„Ή‘ΈI•ΝΡ½Ι¥Ή…Έ½±‘•Θ•ΉΙεΑΡ•‰…­Υΐ…ΉΉ½Π(ΌΌΙ•ΝΥΙΙ•Π…Έ…½ΥΉΠέ΅½Ν”‘•±•Ρ¥½Έέ…Μ…±Ι•…‘δ½µΑ±•Ρ•Έ)Ι•…ΑΑ±εAΙ¥Ω…ε•±•Ρ¥½ΉQ½µ‰ΝΡ½Ή•Μ ¤μ()•αΑ½ΙΠΡεΑ”½ΥΉΡAΙ•Ν•Ή•Y¥•ά€τ½±±…‰½Ι…Ρ¥½Ή½ΥΉΡAΙ•Ν•Ή•Y¥•άμ()½ΉΝΠ¥ΉΡ•Ι…Ρ¥½Ή‘…ΑΡ•ΙΜ€τΙ•…Ρ•%ΉΡ•Ι…Ρ¥½Ή‘…ΑΡ•ΙΝ½µΑ½Ν¥Ρ¥½Έ΅μ(€±¥ΝΡ•¥Ν΅Υ½ΥΉΡ	¥Ή‘¥ΉΜ°(€¥Ν1¥•ΉΝ•UΝ…‰±•½Ι=Ι…Ή¥ι…Ρ¥½Ή•…ΡΥΙ”°(€¥Ν=Ι…Ή¥ι…Ρ¥½Ή•…ΡΥΙ•Ή…‰±•°)τ¤μ()•αΑ½ΙΠ½ΉΝΠμ¥Ν•¥Ν΅ΥΥΡ½I•Α±εΉ…‰±•‘½Ι=Α•Ή%τ€τ¥ΉΡ•Ι…Ρ¥½Ή‘…ΑΡ•ΙΜμ()•αΑ½ΙΠΡεΑ”MµΝ΅…±±•Ή•%ΝΝΥ•I•ΝΥ±Π€τ%‘•ΉΡ¥ΡεMµΝ΅…±±•Ή•%ΝΝΥ•I•ΝΥ±Πμ)•αΑ½ΙΠΡεΑ”MµΝI•¥ΝΡΙ…Ρ¥½ΉY•Ι¥™εI•ΝΥ±Π€τ%‘•ΉΡ¥ΡεMµΝI•¥ΝΡΙ…Ρ¥½ΉY•Ι¥™εI•ΝΥ±Πμ)•αΑ½ΙΠΡεΑ”MµΝ΅…±±•Ή•Y•Ι¥™εI•ΝΥ±Π€τ(€%‘•ΉΡ¥ΡεMµΝ΅…±±•Ή•Y•Ι¥™εI•ΝΥ±Πρ½ΥΉΡY¥•άψμ((ΌΌ€ττττττττττττττττττττττττττττττττττττττττττττττττττττττττττττ(ΌΌA…Ι¬Ρ•Ή…ΉΡΜ°½Ι…Ή¥ι…Ρ¥½Έµ•µ‰•ΙΝ΅¥ΐ…ΉΝ•ΙΩ¥”ΝΑ•¥…±¥ΝΡΜ(ΌΌ€ττττττττττττττττττττττττττττττττττττττττττττττττττττττττττττ()•αΑ½ΙΠ½ΉΝΠμ(€Ι•…Ρ•A…Ι¬°(€Ι•…Ρ•A…Ι­ΝA±…Ρ™½Ι΄°(€Ι•…Ρ•A…Ι­5••Ρ¥ΉI½½΄°(€Ι•…Ρ•A…Ι­…Ρ…MΡ…Ρ¥ΝΡ¥ΝQ…Ν¬°(€Ι•…Ρ•A…Ι­AΥ‰±¥…Ρ¥½Έ°(€Ι•…Ρ•Q¥­•Π°(€Ι•…Ρ•Q¥­•Ρ]¥Ρ΅5••Ρ¥ΉI•Ν•ΙΩ…Ρ¥½Έ°(€‘•±•Ρ•A…Ι­5••Ρ¥ΉI½½΄°(€‘•±•…Ρ•A…Ι­…Ρ…MΡ…Ρ¥ΝΡ¥Μ°(€•ΡA…Ι¬°(€•ΡA…Ι­…Ρ…MΡ…Ρ¥ΝΡ¥ΝQ•µΑ±…Ρ”°(€•ΡA…Ι­½Ι=Ι…Ή¥ι…Ρ¥½Έ°(€•ΡA…Ι­M•ΙΩ¥•MΡ…Ρ¥ΝΡ¥Μ°(€•ΡA…Ι­M•ΡΡ¥ΉΜ°(€•ΡA…Ι­Q•Ή…ΉΡAΙ½™¥±”°(€•ΡQ¥­•ΡΙ•…Ρ½Ι½Ι½ΥΉΠ°(€•ΡQ¥­•Ρ½Ι½ΥΉΠ°(€•ΡQ¥­•Ρ9½Ρ¥™¥…Ρ¥½ΉI•¥Α¥•ΉΡΜ°(€•ΡQ¥­•ΡQΙ…ΉΝ™•ΙΙ•‘9½Ρ¥™¥…Ρ¥½ΉI•¥Α¥•ΉΡΜ°(€¥ΝQ¥­•Ρ•…ΡΥΙ•Ή…‰±•‘½Ι½ΥΉΠ°(€¥ΝΝΥ•A…Ι­%ΉΩ¥Ρ”°(€©½¥Ή=Ι…Ή¥ι…Ρ¥½ΉQ½A…Ι¬°(€±¥ΝΡA…Ι­ΉΉ½ΥΉ•µ•ΉΡI•ΝΥ±ΡΜ°(€±¥ΝΡA…Ι­…Ρ…MΡ…Ρ¥ΝΡ¥ΝQ…Ν­Μ°(€±¥ΝΡA…Ι­5••Ρ¥ΉI½½µΜ°(€±¥ΝΡA…Ι­5••Ρ¥ΉM±½ΡΜ°(€±¥ΝΡA…Ι­AΥ‰±¥…Ρ¥½ΉΜ°(€±¥ΝΡA…Ι­M•ΙΩ¥•Μ°(€±¥ΝΡA…Ι­M•ΙΩ¥•MΑ•¥…±¥ΝΡΜ°(€±¥ΝΡA…Ι­MΥΙΩ•εI•ΝΥ±ΡΜ°(€±¥ΝΡA…Ι­Q•Ή…ΉΡ=Ι…Ή¥ι…Ρ¥½ΉΜ°(€±¥ΝΡQ¥­•Ρ%Ή‰½ΰ°(€±¥ΝΡQ¥­•ΡΝ½Ι½ΥΉΠ°(€µ…Ι­A…Ι­…Ρ…MΡ…Ρ¥ΝΡ¥ΝI•…°(€µ…Ι­A…Ι­AΥ‰±¥…Ρ¥½ΉI•…°(€µ…Ι­Q¥­•ΡI•…°(€Ή½Ιµ…±¥ι•A…Ι­M•ΙΩ¥•½Ιµ…Ρ„°(€Ι•½Ι‘Q¥­•Ρ9½Ρ¥™¥…Ρ¥½Έ°(€Ι•µ¥Ή‘A…Ι­…Ρ…MΡ…Ρ¥ΝΡ¥Μ°(€Ι•µ½Ω•A…Ι­M•ΙΩ¥•MΑ•¥…±¥ΝΠ°(€Ι•Ν•ΙΩ•A…Ι­5••Ρ¥ΉA•Ι¥½°(€Ι•Ν•ΙΩ•A…Ι­5••Ρ¥ΉM±½Π°(€Ι•ΡΥΙΉA…Ι­…Ρ…MΡ…Ρ¥ΝΡ¥Μ°(€Ι•Ω¥•έA…Ι­…Ρ…MΡ…Ρ¥ΝΡ¥Μ°(€Ν•ΡA…Ι­5••Ρ¥ΉM±½ΡΩ…¥±…‰¥±¥Ρδ°(€Ν•ΡA…Ι­M•ΙΩ¥•MΑ•¥…±¥ΝΠ°(€ΝΥ‰µ¥ΡA…Ι­…Ρ…MΡ…Ρ¥ΝΡ¥ΝΙ…™Π°(€ΝΥ‰µ¥ΡA…Ι­MΥΙΩ•δ°(€ΥΑ‘…Ρ•A…Ι­ΝA±…Ρ™½Ι΄°(€ΥΑ‘…Ρ•A…Ι­5••Ρ¥ΉI½½΄°(€ΥΑ‘…Ρ•A…Ι­M•ΙΩ¥”°(€ΥΑ‘…Ρ•A…Ι­M•ΡΡ¥ΉΜ°(€ΥΑ‘…Ρ•A…Ι­Q•Ή…ΉΡAΙ½™¥±”°(€ΥΑ‘…Ρ•Q¥­•Π°)τ€τΙ•…Ρ•A…Ι­M•ΙΩ¥•Ν½µΑ½Ν¥Ρ¥½Έρ½ΥΉΡY¥•ά°=Ι…Ή¥ι…Ρ¥½ΉY¥•άψ΅μ(€‘θ•Ρ°(€•Ρ½ΥΉΠ°(€•Ρ=Ι…Ή¥ι…Ρ¥½Έθ•ΡΉΡ•ΙΑΙ¥Ν•=Ι…Ή¥ι…Ρ¥½Έ°(€¥Ν=Ι…Ή¥ι…Ρ¥½ΉΡ¥Ω”θ€΅½Ι…Ή¥ι…Ρ¥½Ή%¤€τψ(€€€•Ρ=Ι…Ή¥ι…Ρ¥½Έ΅½Ι…Ή¥ι…Ρ¥½Ή%¤όΉΝΡ…ΡΥΜ€τττ€…Ρ¥Ω”°(€±¥ΝΡ½ΥΉΡΜ°(€•Ρ=Ι…Ή¥ι…Ρ¥½Ή•…ΡΥΙ•Μ°(€Ρ½=Ι…Ή¥ι…Ρ¥½ΉY¥•άθΡ½=Ι…Ή¥ι…Ρ¥½Ή¥Ι•Ρ½ΙεY¥•ά°(€Ή½Ιµ…±¥ι•=ΑΡ¥½Ή…±Q•αΠ°(€Ή½Ιµ…±¥ι•M±ΥθΉ½Ιµ…±¥ι•=Ι…Ή¥ι…Ρ¥½ΉM±Υ°(€Ή½Ιµ…±¥ι•%ΉΩ¥Ρ•½‘”θΉ½Ιµ…±¥ι•=Ι…Ή¥ι…Ρ¥½Ή%ΉΩ¥Ρ•½‘”°(€Ή½Ιµ…±¥ι•Q…Μ°(€Ι•…Ρ•UΥ¥θΙ…Ή‘½µUU%°(€Ι•…Ρ•I…Ή‘½µ!•ΰθ€΅‰εΡ•1•ΉΡ ¤€τψΙ…Ή‘½µ	εΡ•Μ΅‰εΡ•1•ΉΡ ¤ΉΡ½MΡΙ¥Ή ΅•ΰ¤°(€¥ΉΩ¥Ρ•Y…±¥‘¥Ρε5Μθ=I9%iQ%=9}%9Y%Q}Y1%%Qe}5L°(€¥ΉΩ¥Ρ•±Α΅…‰•Πθ=I9%iQ%=9}%9Y%Q}1A!	P°(€¥ΉΩ¥Ρ•½‘•I…έ1•ΉΡ θ%9Y%Q}=}I]}19Q °(€…Υ‘¥Πθ±½Υ‘¥Π°)τ¤μ()•αΑ½ΙΠμ(€AI-}5Q%9}1=M}5%9UQL°(€AI-}5Q%9}=A9}5%9UQL°(€AI-}5Q%9}M1=Q}5%9UQL°(€AI-}5Q%9}Q%5}M1=QL°)τ™Ι½΄€ΈΈ½µ½‘Υ±•Μ½Α…Ι­}Ν•ΙΩ¥•Μ½¥Ή‘•ΰΉ©Μμ)•αΑ½ΙΠΡεΑ”μ(€A…Ι­5••Ρ¥ΉI½½µY¥•ά°(€A…Ι­5••Ρ¥ΉM±½ΡY¥•ά°(€A…Ι­M•ΡΡ¥ΉΝY¥•ά°)τ™Ι½΄€ΈΈ½µ½‘Υ±•Μ½Α…Ι­}Ν•ΙΩ¥•Μ½¥Ή‘•ΰΉ©Μμ()•αΑ½ΙΠΡεΑ”μ(€A…Ι­ΉΉ½ΥΉ•µ•ΉΡI•ΝΥ±ΡY¥•ά°(€A…Ι­AΥ‰±¥…Ρ¥½ΉY¥•ά°(€A…Ι­MΥΙΩ•εI•ΝΥ±ΡY¥•ά°)τ™Ι½΄€ΈΈ½µ½‘Υ±•Μ½Α…Ι­}Ν•ΙΩ¥•Μ½¥Ή‘•ΰΉ©Μμ((ΌΌ€ττττττττττττττττττττττττττττττττττττττττττττττττττττττττττττ(ΌΌAΙ½Ω¥‘•ΘµΙ•Α½ΙΡ•Q½­•ΈΥΝ…”€΅±¥•ΉΡ}Ι•Α½ΙΡ•°¥‘•µΑ½Ρ•ΉΠ¤(ΌΌ€ττττττττττττττττττττττττττττττττττττττττττττττττττττττττττττ()½ΉΝΠµ½‘•±…Ρ•έ…δ€τΙ•…Ρ•5½‘•±…Ρ•έ…ε½µΑ½Ν¥Ρ¥½Έ΅μ(€‘θ•Ρ°(€•Ρ½ΥΉΠ°(€•Ρ=Ι…Ή¥ι…Ρ¥½Έ°(€±¥ΝΡ=Ι…Ή¥ι…Ρ¥½Ή½ΥΉΡΜθ±¥ΝΡ½ΥΉΡΜ°(€Ι•…Ρ•%θΙ…Ή‘½µUU%°(€½ΉI•½Ι‘•‘UΝ…”΅¥ΉΑΥΠ¤μ(€€€¥€΅¥ΉΑΥΠΉΡ½Ρ…±Q½­•ΉΜ€π€Δ¤Ι•ΡΥΙΈμ(€€€½ΉΝΠ‘¥•ΝΠ€τΙ•…Ρ•!…Ν  Ν΅„ΘΤΨ¤(€€€€€€ΉΥΑ‘…Ρ” (€€€€€€€m•Ρ•Α±½εµ•ΉΡ% ¤°¥ΉΑΥΠΉ½Ι…Ή¥ι…Ρ¥½Ή%°¥ΉΑΥΠΉµ•ΝΝ…•%‘tΉ©½¥Έ pΐ¤°(€€€€€€€€ΥΡΰ°(€€€€€€¤(€€€€€€Ή‘¥•ΝΠ ΅•ΰ¤μ(€€€ΕΥ•Υ•	¥±±¥ΉUΝ…”΅μ(€€€€€½Ι…Ή¥ι…Ρ¥½Ή%θ¥ΉΑΥΠΉ½Ι…Ή¥ι…Ρ¥½Ή%°(€€€€€µ½‘Υ±”θ€µ½‘•±}…Ρ•έ…δ°(€€€€€ΥΉ¥ΡΜθ¥ΉΑΥΠΉΡ½Ρ…±Q½­•ΉΜ°(€€€€€µ½‘•°θ¥ΉΑΥΠΉµ½‘•°°(€€€€€Ι•™•Ι•Ή•%θΥΝ…•|‘ν‘¥•ΝΠΉΝ±¥” ΐ°€ΜΘ¥υ€°(€€€€€¥‘•µΑ½Ρ•Ήε-•δθΥΝ…”θ‘ν‘¥•ΝΡυ€°(€€€τ¤μ(€τ°)τ¤μ()•αΑ½ΙΠ½ΉΝΠμ•Ρ=Ι…Ή¥ι…Ρ¥½ΉUΝ…•MΥµµ…Ιδ°Ι•½Ι‘Q½­•ΉUΝ…”τ€τµ½‘•±…Ρ•έ…δμ)•αΑ½ΙΠΡεΑ”μ(€½ΥΉΡQ½­•ΉUΝ…•Y¥•ά°(€=Ι…Ή¥ι…Ρ¥½ΉUΝ…•MΥµµ…Ιδ°)τ™Ι½΄€ΈΈ½µ½‘Υ±•Μ½µ½‘•±}…Ρ•έ…δ½¥Ή‘•ΰΉ©Μμ()•αΑ½ΙΠμMQ%5Q°Ή½Ιµ…±¥ι•½ΝΡ9d°Ή½Ιµ…±¥ι•Q½­•ΉΜτμ)•αΑ½ΙΠΡεΑ”μ(€1½]½Ι­Q…Ν­%ΉΑΥΠ°(€]½Ι­±½I•½Ι°(€]½Ι­±½I•Α½ΙΠ°)τ™Ι½΄€ΈΈ½µ½‘Υ±•Μ½Α•ΙΝ½Ή…±}¥ΉΡ•±±¥•Ή”½¥Ή‘•ΰΉ©Μμ((ΌΌ€ττττττττττττττττττττττττττττττττττττττττττττττττττττττττττττ(ΌΌ-Ή½έ±•‘”½Α•Ι…Ρ¥½ΉΜ(ΌΌ€ττττττττττττττττττττττττττττττττττττττττττττττττττττττττττττ)•αΑ½ΙΠ½ΉΝΠμ(€½‰Ν•ΙΩ•-Ή½έ±•‘”°(€…‘‘-Ή½έ±•‘”°(€•Ρ-Ή½έ±•‘”°(€•Ρ-Ή½έ±•‘•½Ι‘µ¥Ή¥ΝΡΙ…Ρ¥½Έ°(€•Ρ-Ή½έ±•‘•½Ι	…­Υΐ°(€•Ρ-Ή½έ±•‘•I•Ω¥Ν¥½ΉΜ°(€•Ρ5•µ‰•Ι-Ή½έ±•‘”°(€Ι•Ω¥•έ-Ή½έ±•‘”°(€Ι•Ω¥Ν•-Ή½έ±•‘”°(€Ν…Ω•-Ή½έ±•‘”°(€Ν•…Ι΅-Ή½έ±•‘”°)τ€τΙ•…Ρ•ΉΡ•ΙΑΙ¥Ν•-Ή½έ±•‘•½µΑ½Ν¥Ρ¥½Έ΅μ(€‘θ•Ρ°(€‘•™…Υ±Ρ=Ι…Ή¥ι…Ρ¥½Ή%θU1Q}=I9%iQ%=9}%°(€•Ρ=Ι…Ή¥ι…Ρ¥½Έ°)τ¤μ((ΌΌ€ττττττττττττττττττττττττττττττττττττττττττττττττττττττττττττ(ΌΌ%ΉΩ¥Ρ”½‘•Μ(ΌΌ€ττττττττττττττττττττττττττττττττττττττττττττττττττττττττττττ(ΌΌ€ττττττττττττττττττττττττττττττττττττττττττττττττττττττττττττ(ΌΌαΑ½ΙΠ…±°€΅™½Θ‰…­Υΐ¤(ΌΌ€ττττττττττττττττττττττττττττττττττττττττττττττττττττττττττττ)½ΉΝΠ‰…­ΥΑ…Ρ…‰…Ν•MΡ½Ι”€τμ‘θ•Ρτμ()½ΉΝΠ•ΉΡ•ΙΑΙ¥Ν•	…­Υΐ€τ‘…Ρ…A±…Ρ™½Ι΄ΉΙ•…Ρ•	…­Υΐ΅μ(€‘•™…Υ±Ρ=Ι…Ή¥ι…Ρ¥½Ή%θU1Q}=I9%iQ%=9}%°(€±¥ΝΡµΑ±½ε••Μθ€΅½Ι…Ή¥ι…Ρ¥½Ή%¤€τψ(€€€±¥ΝΡµΑ±½ε••Ν½Ι	…­Υΐ΅‰…­ΥΑ…Ρ…‰…Ν•MΡ½Ι”°½Ι…Ή¥ι…Ρ¥½Ή%¤°(€±¥ΝΡQ…Ν­1½Μθ€΅½Ι…Ή¥ι…Ρ¥½Ή%¤€τψ(€€€±¥ΝΡ]½Ι­±½Ν½Ι	…­Υΐ΅½Ι…Ή¥ι…Ρ¥½Ή%¤°(€±¥ΝΡ-Ή½έ±•‘”θ€΅½Ι…Ή¥ι…Ρ¥½Ή%¤€τψ(€€€•Ρ-Ή½έ±•‘•½Ι	…­Υΐ΅½Ι…Ή¥ι…Ρ¥½Ή%¤°(€±¥ΝΡ%ΉΩ¥Ρ•½‘•Μθ€΅½Ι…Ή¥ι…Ρ¥½Ή%¤€τψ(€€€±¥ΝΡ•Α…ΙΡµ•ΉΡ%ΉΩ¥Ρ•Ν½Ι	…­Υΐ΅‰…­ΥΑ…Ρ…‰…Ν•MΡ½Ι”°½Ι…Ή¥ι…Ρ¥½Ή%¤°(€±¥ΝΡΥ‘¥Ρ1½Μθ€΅½Ι…Ή¥ι…Ρ¥½Ή%¤€τψ•ΡΥ‘¥Ρ1½Μ Θΐΐ°½Ι…Ή¥ι…Ρ¥½Ή%¤°(€€ΌΌ½ΥΉΠΙ•Α½Ν¥Ρ½Ι¥•Μ‘•±¥‰•Ι…Ρ•±δ½µ¥ΠΑ…ΝΝέ½Ι΅…Ν΅•Μ…ΉΝ•ΝΝ¥½ΈΡ½­•ΉΜΈ(€±¥ΝΡ½ΥΉΡΜ°(€±¥ΝΡ½ΥΉΡQ…Μθ€΅½Ι…Ή¥ι…Ρ¥½Ή%¤€τψ(€€€±¥ΝΡ=Ι…Ή¥ι…Ρ¥½Ή½ΥΉΡQ…Ν%ΉI•Α½Ν¥Ρ½Ιδ΅…½ΥΉΡQ…MΡ½Ι”°½Ι…Ή¥ι…Ρ¥½Ή%¤°(€±¥ΝΡQ¥­•ΡΜθ€΅½Ι…Ή¥ι…Ρ¥½Ή%¤€τψ(€€€±¥ΝΡA…Ι­Q¥­•ΡΝ½Ι	…­Υΐ΅‰…­ΥΑ…Ρ…‰…Ν•MΡ½Ι”°½Ι…Ή¥ι…Ρ¥½Ή%¤°(€±¥ΝΡQ¥­•Ρ•±¥Ω•Ι¥•Μθ€΅½Ι…Ή¥ι…Ρ¥½Ή%¤€τψ(€€€±¥ΝΡQ¥­•Ρ•±¥Ω•Ι¥•Ν½Ι	…­Υΐ΅‰…­ΥΑ…Ρ…‰…Ν•MΡ½Ι”°½Ι…Ή¥ι…Ρ¥½Ή%¤°)τ¤μ()•αΑ½ΙΠ½ΉΝΠμ•αΑ½ΙΡ±°τ€τ•ΉΡ•ΙΑΙ¥Ν•	…­Υΐμ(