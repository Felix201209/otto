/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业账号 API 客户端。只运行在 Electron main 进程：renderer 不直接请求
 * 企业服务器，也永远拿不到会话令牌。
 */

import {
  enterpriseE2eeDeviceVerification,
  type EnterpriseE2eeDeviceVerification,
  type EnterpriseE2eeCrypto,
  type EnterpriseE2eeDeviceBundle,
  type EnterpriseE2eeWireMessage,
} from './enterprise-e2ee.js';

export interface EnterpriseAccount {
  id: string;
  organizationId: string;
  organizationName: string;
  accountType?: 'personal' | 'enterprise';
  employeeId: string | null;
  username: string;
  phone: string | null;
  feishuOpenId?: string | null;
  name: string;
  role: string | null;
  department: string | null;
  departmentId?: string | null;
  positionId: string | null;
  positionTitle: string | null;
  avatarUrl?: string | null;
  isAdmin: boolean;
  status: 'active' | 'disabled';
  tags: string[];
  createdAt: string;
  updatedAt: string;
  usage?: EnterpriseAccountUsage;
}

export interface EnterpriseAccountUsage {
  accountId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  lastUsedAt: string | null;
}

export interface AccountCreateInput {
  username: string;
  password: string;
  name: string;
  phone?: string | null;
  feishuOpenId?: string | null;
  role?: string | null;
  department?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  avatarUrl?: string | null;
  tags?: string[];
  isAdmin?: boolean;
}

export interface AccountUpdateInput {
  username?: string;
  password?: string;
  name?: string;
  phone?: string | null;
  feishuOpenId?: string | null;
  role?: string | null;
  department?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  avatarUrl?: string | null;
  tags?: string[];
  isAdmin?: boolean;
  status?: 'active' | 'disabled';
}

interface StoredSession {
  serverUrl: string;
  token: string | null;
}

export interface SmsChallenge {
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
  message: string;
  registrationMode?: 'personal' | 'enterprise';
  organization: { id: string; name: string } | null;
}

export interface SmsLoginChallenge {
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
  message: string;
}

export interface TokenUsageRecordInput {
  sessionId: string;
  messageId: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface EnterpriseKnowledgeRecordInput {
  sourceId: string;
  title?: string;
  category: string;
  content: string;
  confidence: number;
  sourceType?:
    | 'manual'
    | 'auto_capture'
    | 'work_result'
    | 'task_log'
    | 'document'
    | 'offboarding';
  sourceLabel?: string;
  sourceSessionId?: string;
  sourceFingerprint?: string;
  tags?: string[];
  verified?: boolean;
  impactScore?: number;
  significanceSignals?: string[];
  observedAt?: string;
}

export interface EnterpriseKnowledgeRecordResult {
  status: 'added' | 'exists' | 'observed' | 'duplicate' | 'promoted';
  added: boolean;
  outcome?:
    'added' | 'updated' | 'unchanged' | 'observed' | 'duplicate' | 'promoted';
  reviewStatus?: EnterpriseKnowledgeItem['status'];
  knowledgeId?: number;
  retention?: {
    promoted: boolean;
    reason:
      | 'incubating'
      | 'long_term_recurrence'
      | 'cross_member_corroboration'
      | 'high_impact_verified';
    evidenceCount: number;
    distinctSessionCount: number;
    distinctContributorCount: number;
    spanDays: number;
    impactScore: number;
  };
}

export interface EnterpriseKnowledgeItem {
  id: string;
  organizationId: string;
  sourceId: string | null;
  title: string;
  department: string | null;
  category: string;
  content: string;
  contributor: string | null;
  confidence: number;
  sourceType:
    | 'manual'
    | 'auto_capture'
    | 'work_result'
    | 'task_log'
    | 'document'
    | 'offboarding';
  sourceLabel: string | null;
  status: 'pending_review' | 'active' | 'archived';
  version: number;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  evidenceCount?: number;
  distinctSessionCount?: number;
  distinctContributorCount?: number;
  firstObservedAt?: string | null;
  lastObservedAt?: string | null;
}

export interface EnterpriseKnowledgeRevision {
  id: string;
  knowledgeId: string;
  version: number;
  title: string;
  category: string;
  content: string;
  status: EnterpriseKnowledgeItem['status'];
  changedBy: string | null;
  changeNote: string | null;
  createdAt: string;
}

export type EnterpriseSkillVisibility = 'department' | 'company';
export type EnterpriseSkillStatus = 'pending_review' | 'active' | 'archived';
export type EnterpriseSkillScope = 'department' | 'company' | 'mine' | 'review';
export type EnterpriseSkillSort =
  'recommended' | 'rating' | 'installs' | 'usage' | 'newest';

export interface EnterpriseSkillMarketItem {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description: string;
  department: string | null;
  visibility: EnterpriseSkillVisibility;
  status: EnterpriseSkillStatus;
  authorAccountId: string | null;
  authorName: string;
  contentHash: string;
  version: number;
  installCount: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  rating: number;
  ratingCount: number;
  installedVersion: number | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnterpriseSkillLeaderboard {
  skills: Array<
    EnterpriseSkillMarketItem & {
      rank: number;
      score: number;
      successRate: number;
    }
  >;
  contributors: Array<{
    rank: number;
    accountId: string | null;
    name: string;
    skillCount: number;
    installCount: number;
    usageCount: number;
    score: number;
  }>;
  generatedAt: string;
}

interface EnterpriseKnowledgeRow {
  id: string | number;
  organization_id?: string;
  organizationId?: string;
  source_id?: string | null;
  sourceId?: string | null;
  title?: string;
  department?: string | null;
  category: string;
  content: string;
  contributor?: string | null;
  confidence?: number;
  source_type?: EnterpriseKnowledgeItem['sourceType'];
  sourceType?: EnterpriseKnowledgeItem['sourceType'];
  source_label?: string | null;
  sourceLabel?: string | null;
  status?: EnterpriseKnowledgeItem['status'];
  version?: number;
  reviewed_by?: string | null;
  reviewedBy?: string | null;
  reviewed_at?: string | null;
  reviewedAt?: string | null;
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
  evidence_count?: number;
  evidenceCount?: number;
  distinct_session_count?: number;
  distinctSessionCount?: number;
  distinct_contributor_count?: number;
  distinctContributorCount?: number;
  first_observed_at?: string | null;
  firstObservedAt?: string | null;
  last_observed_at?: string | null;
  lastObservedAt?: string | null;
}

interface EnterpriseKnowledgeRevisionRow {
  id: string | number;
  knowledge_id?: string | number;
  knowledgeId?: string | number;
  version?: number;
  title?: string;
  category: string;
  content: string;
  status?: EnterpriseKnowledgeItem['status'];
  changed_by?: string | null;
  changedBy?: string | null;
  change_note?: string | null;
  changeNote?: string | null;
  created_at?: string;
  createdAt?: string;
}

function mapEnterpriseKnowledgeItem(
  item: EnterpriseKnowledgeRow,
): EnterpriseKnowledgeItem {
  return {
    id: String(item.id),
    organizationId: item.organizationId || item.organization_id || '',
    sourceId: item.sourceId ?? item.source_id ?? null,
    title: item.title?.trim() || item.category,
    department: item.department ?? null,
    category: item.category,
    content: item.content,
    contributor: item.contributor ?? null,
    confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
    sourceType: item.sourceType || item.source_type || 'manual',
    sourceLabel: item.sourceLabel ?? item.source_label ?? null,
    status: item.status || 'active',
    version: typeof item.version === 'number' ? item.version : 1,
    reviewedBy: item.reviewedBy ?? item.reviewed_by ?? null,
    reviewedAt: item.reviewedAt ?? item.reviewed_at ?? null,
    createdAt: item.createdAt || item.created_at || '',
    updatedAt:
      item.updatedAt ||
      item.updated_at ||
      item.createdAt ||
      item.created_at ||
      '',
    ...((item.evidenceCount ?? item.evidence_count) !== undefined
      ? { evidenceCount: item.evidenceCount ?? item.evidence_count }
      : {}),
    ...((item.distinctSessionCount ?? item.distinct_session_count) !== undefined
      ? {
          distinctSessionCount:
            item.distinctSessionCount ?? item.distinct_session_count,
        }
      : {}),
    ...((item.distinctContributorCount ?? item.distinct_contributor_count) !==
    undefined
      ? {
          distinctContributorCount:
            item.distinctContributorCount ?? item.distinct_contributor_count,
        }
      : {}),
    ...((item.firstObservedAt ?? item.first_observed_at) !== undefined
      ? { firstObservedAt: item.firstObservedAt ?? item.first_observed_at }
      : {}),
    ...((item.lastObservedAt ?? item.last_observed_at) !== undefined
      ? { lastObservedAt: item.lastObservedAt ?? item.last_observed_at }
      : {}),
  };
}

export interface EnterpriseOrganizationInvite {
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

export interface EnterpriseOrganizationInviteContext {
  organization: { id: string; name: string };
  invite: EnterpriseOrganizationInvite | null;
}

export interface EnterpriseOrganizationFeatures {
  enterprise_tree: boolean;
  park_service: boolean;
  feishu_auto_reply: boolean;
  direct_messages: boolean;
  atoa: boolean;
  knowledge: boolean;
  skill_market: boolean;
}

export type EnterpriseModuleUpdateRollout =
  'off' | 'canary' | 'stable' | 'required';

export interface EnterpriseModuleUpdateDescriptor {
  module: string;
  version: string;
  rollout: EnterpriseModuleUpdateRollout;
  notes: string;
  minAppVersion: string | null;
  manifestUrl: string | null;
  sha256: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface EnterpriseModuleUpdateManifest {
  format: 'otto-module-updates-v1';
  deploymentId: string;
  generatedAt: string;
  modules: EnterpriseModuleUpdateDescriptor[];
  catalog: Array<{ module: string; features: string[] }>;
}

export type EnterprisePositionRoleMapping =
  'member' | 'department_admin' | 'enterprise_admin';

export interface EnterpriseOrganizationPosition {
  id: string;
  organizationId: string;
  departmentId: string;
  title: string;
  roleMapping: EnterprisePositionRoleMapping;
  createdAt: string;
  updatedAt: string;
}

export interface EnterpriseOrganizationDepartment {
  id: string;
  organizationId: string;
  name: string;
  memberCount: number;
  positions: EnterpriseOrganizationPosition[];
  createdAt: string;
  updatedAt: string;
}

export interface EnterpriseParkTenantOrganization {
  id: string;
  name: string;
  slug: string;
  parkId?: string | null;
  parkAddress?: string | null;
  parkRoomNumber?: string | null;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface EnterpriseParkServiceUsageCount {
  serviceId: string;
  name: string;
  count: number;
  amountCny: number;
  recurringMonthlyCny: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
}

export interface EnterpriseParkTenantStatistics {
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
  services: EnterpriseParkServiceUsageCount[];
}

export interface EnterpriseParkStatistics {
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
  services: EnterpriseParkServiceUsageCount[];
  organizations: EnterpriseParkTenantStatistics[];
}

export interface EnterpriseParkService {
  parkId: string;
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  updatedAt: string;
}

export interface EnterprisePark {
  id: string;
  name: string;
  slug: string;
  brandName: string;
  adminOrganizationId: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  isAdminOrganization?: boolean;
  services?: EnterpriseParkService[];
  tenantAddress?: string | null;
  tenantRoomNumber?: string | null;
}

export interface EnterpriseParkTenantProfile {
  organizationId: string;
  parkId: string;
  address: string;
  roomNumber: string;
  updatedAt: string;
}

export interface EnterpriseParkInvite {
  id: string;
  parkId: string;
  code: string;
  status: 'active' | 'expired' | 'revoked';
  usedCount: number;
  maxUses: number | null;
  issuedAt: string;
  expiresAt: string;
}

export interface EnterpriseParkSpecialist {
  parkId: string;
  serviceId: string;
  accountId: string;
  name: string;
}

export interface EnterpriseOrganizationView {
  organization: {
    id: string;
    name: string;
    status: 'active' | 'disabled';
    parkId?: string | null;
    createdAt: string;
  } | null;
  members: Array<{
    id: string;
    username: string;
    name: string;
    role: string | null;
    department: string | null;
    departmentId?: string | null;
    positionId?: string | null;
    positionTitle?: string | null;
    avatarUrl?: string | null;
    isAdmin: boolean;
    status: 'active' | 'disabled';
    ottoOnline?: boolean;
    ottoLastSeenAt?: string | null;
  }>;
  employeeCount: number;
  structure?: EnterpriseOrganizationDepartment[];
  features?: EnterpriseOrganizationFeatures;
  park?: EnterprisePark | null;
}

export interface EnterpriseDirectMessageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface EnterpriseDirectMessageAttachmentUpload {
  fileName: string;
  mimeType: string;
  size: number;
  data: string;
}

export interface EnterpriseDirectMessageAttachmentDownload extends EnterpriseDirectMessageAttachment {
  data: string;
}

export interface EnterpriseDirectMessage {
  id: string;
  senderAccountId: string;
  recipientAccountId: string;
  content: string;
  createdAt: string;
  readAt: string | null;
  attachments?: EnterpriseDirectMessageAttachment[];
  e2ee?: true;
  contentType?: 'message' | 'atoa_request' | 'atoa_response';
  inReplyToMessageId?: string | null;
}

export interface EnterpriseUnreadMessageNotification {
  id: string;
  source: 'enterprise';
  title: string;
  senderAccountId: string;
  senderName: string;
  preview: string;
  createdAt: string;
}

export interface EnterpriseAtoaInboxMessage extends EnterpriseDirectMessage {
  peerAccountId: string;
  /** 由企业服务端按 peerAccountId 查询并回传，不能来自消息正文。 */
  peer: {
    id: string;
    username: string;
    name: string;
    department: string | null;
    positionTitle: string | null;
    role: string | null;
  };
}

export interface EnterpriseRepairTicketHistoryEntry {
  id: string;
  action:
    'created' | 'accept' | 'respond' | 'transfer' | 'complete' | 'confirm';
  statusBefore: string | null;
  statusAfter: string;
  responseType: string | null;
  responseText: string | null;
  createdAt: string;
  actor: { id: string; name: string } | null;
}

export interface EnterpriseRepairTicket {
  id: string;
  applicationNumber?: string | null;
  serviceId: string;
  title: string;
  description: string;
  formData: Record<string, string>;
  targetTags: string[];
  status: string;
  category: string | null;
  location: string | null;
  urgency: string | null;
  contact: string | null;
  contactPhone: string | null;
  responseType: string | null;
  responseText: string | null;
  responseAt: string | null;
  createdAt: string;
  updatedAt: string;
  creator: Pick<EnterpriseAccount, 'id' | 'name' | 'username'>;
  recipientCount: number;
  recipients: Array<Pick<EnterpriseAccount, 'id' | 'name'>>;
  deliveryStatus?: string;
  readAt?: string | null;
  creatorUpdateAt?: string | null;
  creatorUpdateReadAt?: string | null;
  isCreator?: boolean;
  isRecipient?: boolean;
  history?: EnterpriseRepairTicketHistoryEntry[];
  notifications: Array<{
    channel: 'otto' | 'sms' | 'feishu';
    event: string;
    status: 'sent' | 'failed' | 'skipped';
    detail: string | null;
    createdAt: string;
  }>;
}

export interface EnterpriseParkPublication {
  id: string;
  kind: 'announcement' | 'satisfaction';
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  submittedAt: string | null;
  responseData: Record<string, string> | null;
  recipientCount: number;
  readCount: number;
}

export interface EnterpriseParkAnnouncementResult {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  recipientCount: number;
  readCount: number;
}

export interface EnterpriseParkSurveyResult {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  recipientCount: number;
  submittedCount: number;
  responses: Array<{
    accountId: string;
    accountName: string;
    submittedAt: string;
    responseData: Record<string, string>;
  }>;
}

export interface EnterpriseParkResources {
  settings: {
    parkingTotal: number;
    parkingNote: string | null;
    updatedAt: string;
  };
  meetingRooms: Array<{
    id: string;
    name: string;
    location: string;
    capacity: number;
    priceHalfDay: number;
    equipment: string[];
    imageUrl: string | null;
    openingHours: string | null;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  meetingSlots: Array<{
    id: string;
    roomId: string;
    date: string;
    slotKey: string;
    label: string;
    status: 'available' | 'booked' | 'closed';
    updatedAt: string;
  }>;
}

export type EnterpriseAccountSyncScope =
  'personal_memory' | 'worklog' | 'auto_skills';

export interface EnterpriseAccountSyncFile {
  path: string;
  content: string;
  modifiedAtMs: number;
  sha256: string;
}

export interface EnterpriseAccountSyncPayload {
  schemaVersion: 1;
  generatedAt: string;
  files: EnterpriseAccountSyncFile[];
  truncated?: boolean;
}

export interface EnterpriseAccountSyncSnapshot {
  scope: EnterpriseAccountSyncScope;
  version: number;
  payload: EnterpriseAccountSyncPayload;
  payloadHash: string;
  deviceId: string | null;
  updatedAtMs: number;
}
export interface EnterpriseSessionResult {
  serverUrl: string;
  account: EnterpriseAccount | null;
  /** 恢复 token 时服务暂不可达；保留地址/token，让同页重试而不是锁死登录。 */
  connectionError?: string;
}

export interface EnterpriseDataGovernanceProfile {
  controller: { name: string; privacyContact: string; configured: boolean };
  residency: {
    mode: string;
    region: string;
    crossBorderEnabled: boolean;
    localizationReady: boolean;
  };
  security: {
    publicTransport: string;
    database: string;
    encryptedData: string[];
    hashedData: string[];
    plaintextData: string[];
  };
  retention: {
    securityAuditMinimumDays: number;
    encryptedBackupDefaultDays: number;
    healthTelemetryDefaultDays: number;
  };
  readiness: { configured: boolean; warnings: string[] };
  documents: Array<{
    id: 'terms' | 'privacy';
    title: string;
    version: string;
    effectiveAt: string;
    required: true;
    summary: string[];
    sourceUrls: string[];
    hash: string;
    accepted: boolean;
    acceptedAt: number | null;
  }>;
  processingActivities: Array<{
    id: string;
    category: string;
    purpose: string;
    sensitivity: 'ordinary' | 'sensitive' | 'security';
    storage: 'user_device' | 'enterprise_server' | 'configured_provider';
    atRest: string;
    transport: string;
    retention: string;
    deletion: string;
    recipients: string[];
    crossBorder: boolean;
  }>;
  rights: string[];
  currentConsentComplete: boolean;
  authorization: {
    deploymentId: string;
    license: {
      status: string;
      plan: string;
      expiresAt: string;
      seatLimit: number;
      activeSeatCount: number;
      modules: string[];
      offline: boolean;
      enforce: boolean;
    };
    telemetry: { enabled: boolean; contentMode: string };
    dataBoundary: Record<string, unknown>;
  };
}

export interface EnterprisePrivacyDeletionReceipt {
  requestId: string;
  accountId: string;
  organizationId: string;
  completedAt: string;
  deleted: string[];
  anonymized: string[];
  retained: Array<{ category: string; reason: string; restriction: string }>;
  backupExpiry: string;
}

interface EnterpriseServerHealth {
  status?: unknown;
  apiVersion?: unknown;
  capabilities?: unknown;
}

interface EnterpriseRequestBehavior {
  omitAuthorization?: boolean;
  preserveSessionOnUnauthorized?: boolean;
  serverUrl?: string;
  authorizationToken?: string | null;
  timeoutMs?: number;
}

const ENTERPRISE_SERVER_UPGRADE_ERROR =
  '企业服务器版本过旧或功能不完整，请联系管理员升级后重试';
const ENTERPRISE_AUTH_SUPERSEDED_ERROR = '认证操作已被新的请求替代，请重试';

class EnterpriseRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * 加入企业是不可重复提交。POST 的响应丢失且 `/auth/me` 也不可用时，调用方
 * 无法安全判断账号仍为个人还是已经入企，必须清掉本地会话并要求重新登录。
 */
export class EnterpriseJoinStateUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnterpriseJoinStateUncertainError';
  }
}

function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('服务器地址格式不正确');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    throw new Error('服务器地址必须使用 http(s)，且不能包含账号密码');
  }
  if (url.search || url.hash)
    throw new Error('服务器地址不能包含查询参数或片段');
  const isLocalDevelopment =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !isLocalDevelopment) {
    throw new Error('公网企业服务器必须使用 HTTPS');
  }
  const pathPrefix =
    url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathPrefix}`;
}

function e2eeProtocolMetadata(content: string): {
  contentType: 'message' | 'atoa_request' | 'atoa_response';
  inReplyToMessageId: string | null;
} {
  if (content.startsWith('OTTO_ATOA_REQUEST ')) {
    return { contentType: 'atoa_request', inReplyToMessageId: null };
  }
  if (content.startsWith('OTTO_ATOA_RESPONSE ')) {
    try {
      const parsed = JSON.parse(
        content.slice('OTTO_ATOA_RESPONSE '.length),
      ) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).requestId === 'string'
      ) {
        return {
          contentType: 'atoa_response',
          inReplyToMessageId: (parsed as Record<string, string>).requestId,
        };
      }
    } catch {
      // Invalid A2A content remains an ordinary private message.
    }
  }
  return { contentType: 'message', inReplyToMessageId: null };
}

export class EnterpriseClient {
  private serverUrl = '';
  private token: string | null = null;
  private currentAccount: EnterpriseAccount | null = null;
  private compatibleServerUrl = '';
  private compatibleCapabilities = new Set<string>();
  private authOperationGeneration = 0;
  private pendingRegistrationMode: 'personal' | 'enterprise' | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onSessionInvalidated: () => void = () => undefined,
    private readonly e2ee?: EnterpriseE2eeCrypto,
  ) {}

  restore(session: StoredSession): void {
    this.authOperationGeneration += 1;
    this.setServerUrl(
      session.serverUrl ? normalizeServerUrl(session.serverUrl) : '',
    );
    this.token = session.token;
    this.currentAccount = null;
  }

  snapshot(): StoredSession {
    return { serverUrl: this.serverUrl, token: this.token };
  }

  /**
   * 仅供 Electron main 将中心服务已验证的当前账号同步给本机控制面。
   * 返回深拷贝，调用方无法通过引用修改客户端内部认证状态。
   */
  authenticatedAccountSnapshot(): EnterpriseAccount | null {
    return this.currentAccount
      ? (JSON.parse(JSON.stringify(this.currentAccount)) as EnterpriseAccount)
      : null;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    behavior: EnterpriseRequestBehavior = {},
  ): Promise<T> {
    const requestServerUrl = behavior.serverUrl ?? this.serverUrl;
    const hasExplicitAuthorization = Object.prototype.hasOwnProperty.call(
      behavior,
      'authorizationToken',
    );
    const requestToken = hasExplicitAuthorization
      ? (behavior.authorizationToken ?? null)
      : this.token;
    if (!requestServerUrl) throw new Error('请先填写企业服务器地址');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      behavior.timeoutMs ?? 10_000,
    );
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(requestToken && !behavior.omitAuthorization
          ? { authorization: `Bearer ${requestToken}` }
          : {}),
        ...(init.headers as Record<string, string> | undefined),
      };
      const response = await this.fetchImpl(`${requestServerUrl}${path}`, {
        ...init,
        method: init.method ?? 'GET',
        headers,
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      } & T;
      if (!response.ok) {
        if (
          response.status === 401 &&
          !behavior.preserveSessionOnUnauthorized &&
          requestServerUrl === this.serverUrl &&
          requestToken !== null &&
          requestToken === this.token
        ) {
          this.invalidateSession();
        }
        throw new EnterpriseRequestError(
          body.error || `服务器返回 ${response.status}`,
          response.status,
        );
      }
      return body;
    } catch (error) {
      if (error instanceof EnterpriseRequestError) throw error;
      if (error instanceof Error && error.name === 'AbortError')
        throw new Error('连接企业服务器超时');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`无法连接企业服务器：${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async loginWithPassword(
    serverUrl: string,
    identifier: string,
    password: string,
  ): Promise<{
    account: EnterpriseAccount;
    expiresAt: string;
  }> {
    const targetServerUrl = normalizeServerUrl(serverUrl);
    const generation = this.beginAuthOperation(targetServerUrl);
    await this.assertCompatibleServer(targetServerUrl, ['password_auth']);
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    const result = await this.request<{
      account: EnterpriseAccount;
      token: string;
      expiresAt: string;
    }>(
      '/enterprise/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ identifier, password }),
      },
      {
        serverUrl: targetServerUrl,
        authorizationToken: null,
      },
    );
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    this.token = result.token;
    this.currentAccount = result.account;
    this.pendingRegistrationMode = null;
    return { account: result.account, expiresAt: result.expiresAt };
  }

  async requestLoginCode(
    serverUrl: string,
    phone: string,
  ): Promise<SmsLoginChallenge> {
    const targetServerUrl = normalizeServerUrl(serverUrl);
    const generation = this.beginAuthOperation(targetServerUrl);
    await this.assertCompatibleServer(targetServerUrl, ['sms_login']);
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    const challenge = await this.request<SmsLoginChallenge>(
      '/enterprise/auth/sms/request',
      {
        method: 'POST',
        body: JSON.stringify({ phone }),
      },
      {
        serverUrl: targetServerUrl,
        authorizationToken: null,
      },
    );
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    return challenge;
  }

  async loginWithSms(input: {
    challengeId: string;
    code: string;
  }): Promise<{ account: EnterpriseAccount; expiresAt: string }> {
    const targetServerUrl = this.serverUrl;
    if (!targetServerUrl) throw new Error('请先填写企业服务器地址');
    const generation = this.beginAuthOperation(targetServerUrl);
    await this.assertCompatibleServer(targetServerUrl, ['sms_login']);
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    const result = await this.request<{
      account: EnterpriseAccount;
      token: string;
      expiresAt: string;
    }>(
      '/enterprise/auth/sms/verify',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      {
        serverUrl: targetServerUrl,
        authorizationToken: null,
      },
    );
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    this.token = result.token;
    this.currentAccount = result.account;
    this.pendingRegistrationMode = null;
    return { account: result.account, expiresAt: result.expiresAt };
  }

  async requestRegistrationCode(
    serverUrl: string,
    phone: string,
    inviteCode = '',
  ): Promise<SmsChallenge> {
    const targetServerUrl = normalizeServerUrl(serverUrl);
    const generation = this.beginAuthOperation(targetServerUrl);
    await this.assertCompatibleServer(
      targetServerUrl,
      inviteCode.trim()
        ? ['sms_registration', 'organization_invites', 'position_invites']
        : ['sms_registration', 'personal_registration'],
    );
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    const challenge = await this.request<SmsChallenge>(
      '/enterprise/auth/register/sms/request',
      {
        method: 'POST',
        body: JSON.stringify({
          phone,
          ...(inviteCode.trim() ? { inviteCode } : {}),
        }),
      },
      {
        serverUrl: targetServerUrl,
        authorizationToken: null,
      },
    );
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    this.pendingRegistrationMode =
      challenge.registrationMode ??
      (inviteCode.trim() ? 'enterprise' : 'personal');
    return challenge;
  }

  async registerWithSms(input: {
    challengeId: string;
    code: string;
    name: string;
    password: string;
    legalConsent: true;
  }): Promise<{
    account: EnterpriseAccount;
    expiresAt: string;
  }> {
    const targetServerUrl = this.serverUrl;
    if (!targetServerUrl) throw new Error('请先填写企业服务器地址');
    const generation = this.beginAuthOperation(targetServerUrl);
    await this.assertCompatibleServer(
      targetServerUrl,
      this.pendingRegistrationMode === 'enterprise'
        ? ['sms_registration', 'organization_invites', 'position_invites']
        : ['sms_registration', 'personal_registration'],
    );
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    const result = await this.request<{
      account: EnterpriseAccount;
      token: string;
      expiresAt: string;
    }>(
      '/enterprise/auth/register/sms/verify',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      {
        serverUrl: targetServerUrl,
        authorizationToken: null,
      },
    );
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    this.token = result.token;
    this.currentAccount = result.account;
    this.pendingRegistrationMode = null;
    return { account: result.account, expiresAt: result.expiresAt };
  }

  async getSession(): Promise<EnterpriseSessionResult> {
    if (!this.serverUrl || !this.token)
      return { serverUrl: this.serverUrl, account: null };
    const targetServerUrl = this.serverUrl;
    const targetToken = this.token;
    const generation = this.authOperationGeneration;
    try {
      await this.assertCompatibleServer(targetServerUrl, ['password_auth']);
      if (
        !this.isSessionSnapshotCurrent(generation, targetServerUrl, targetToken)
      ) {
        return this.currentSessionResult();
      }
      const result = await this.request<{ account: EnterpriseAccount }>(
        '/enterprise/auth/me',
        {},
        {
          serverUrl: targetServerUrl,
          authorizationToken: targetToken,
          preserveSessionOnUnauthorized: true,
        },
      );
      if (
        !this.isSessionSnapshotCurrent(generation, targetServerUrl, targetToken)
      ) {
        return this.currentSessionResult();
      }
      this.currentAccount = result.account;
      return { serverUrl: targetServerUrl, account: result.account };
    } catch (error) {
      if (
        !this.isSessionSnapshotCurrent(generation, targetServerUrl, targetToken)
      ) {
        return this.currentSessionResult();
      }
      if (error instanceof EnterpriseRequestError && error.status === 401) {
        this.invalidateSession();
        return { serverUrl: targetServerUrl, account: null };
      }
      const connectionError =
        error instanceof Error ? error.message : String(error);
      return { serverUrl: targetServerUrl, account: null, connectionError };
    }
  }

  async logout(): Promise<void> {
    const targetServerUrl = this.serverUrl;
    const targetToken = this.token;
    this.authOperationGeneration += 1;
    this.token = null;
    this.currentAccount = null;
    if (!targetServerUrl || !targetToken) return;
    await this.request(
      '/enterprise/auth/logout',
      { method: 'POST' },
      {
        serverUrl: targetServerUrl,
        authorizationToken: targetToken,
        preserveSessionOnUnauthorized: true,
      },
    );
  }

  async joinOrganization(
    inviteCode: string,
  ): Promise<{ account: EnterpriseAccount }> {
    if (!this.token || !this.currentAccount)
      throw new Error('登录已失效，请重新登录');
    if (this.currentAccount.accountType !== 'personal') {
      throw new Error('当前账号已经属于企业');
    }
    const normalizedInviteCode = inviteCode.trim();
    if (
      !/^[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/.test(
        normalizedInviteCode,
      )
    ) {
      throw new Error('请输入有效的 12 位大小写敏感企业邀请码');
    }
    const requestGeneration = this.authOperationGeneration;
    const requestToken = this.token;
    const requestServerUrl = this.serverUrl;
    const personalAccountId = this.currentAccount.id;
    await this.assertCompatibleServer(this.serverUrl, [
      'personal_enterprise_upgrade',
    ]);
    let joinError: unknown;
    try {
      const result = await this.request<{ account: EnterpriseAccount }>(
        '/enterprise/auth/join-organization',
        {
          method: 'POST',
          body: JSON.stringify({ inviteCode: normalizedInviteCode }),
        },
        {
          serverUrl: requestServerUrl,
          authorizationToken: requestToken,
          preserveSessionOnUnauthorized: true,
        },
      );
      if (
        !this.isSessionSnapshotCurrent(
          requestGeneration,
          requestServerUrl,
          requestToken,
        )
      ) {
        throw new Error(ENTERPRISE_AUTH_SUPERSEDED_ERROR);
      }
      if (
        result?.account?.id === personalAccountId &&
        result.account.accountType === 'enterprise'
      ) {
        this.currentAccount = result.account;
        return result;
      }
      joinError = new EnterpriseJoinStateUncertainError(
        '企业服务器返回的升级身份不完整',
      );
    } catch (error) {
      if (
        !this.isSessionSnapshotCurrent(
          requestGeneration,
          requestServerUrl,
          requestToken,
        )
      ) {
        throw new Error(ENTERPRISE_AUTH_SUPERSEDED_ERROR);
      }
      joinError = error;
    }

    let reconciliation: { account: EnterpriseAccount };
    try {
      reconciliation = await this.request<{ account: EnterpriseAccount }>(
        '/enterprise/auth/me',
        {},
        {
          serverUrl: requestServerUrl,
          authorizationToken: requestToken,
          preserveSessionOnUnauthorized: true,
        },
      );
    } catch (error) {
      if (
        !this.isSessionSnapshotCurrent(
          requestGeneration,
          requestServerUrl,
          requestToken,
        )
      ) {
        throw new Error(ENTERPRISE_AUTH_SUPERSEDED_ERROR);
      }
      const joinMessage =
        joinError instanceof Error ? joinError.message : String(joinError);
      const reconciliationMessage =
        error instanceof Error ? error.message : String(error);
      throw new EnterpriseJoinStateUncertainError(
        `无法确认企业升级结果：${joinMessage}；身份对账失败：${reconciliationMessage}`,
      );
    }
    if (
      !this.isSessionSnapshotCurrent(
        requestGeneration,
        requestServerUrl,
        requestToken,
      )
    ) {
      throw new Error(ENTERPRISE_AUTH_SUPERSEDED_ERROR);
    }
    if (
      reconciliation.account?.id === personalAccountId &&
      reconciliation.account.accountType === 'enterprise'
    ) {
      this.currentAccount = reconciliation.account;
      return { account: reconciliation.account };
    }
    if (
      reconciliation.account?.id === personalAccountId &&
      reconciliation.account.accountType === 'personal'
    ) {
      throw joinError;
    }
    throw new EnterpriseJoinStateUncertainError(
      '身份对账返回了与当前会话不一致的账号',
    );
  }

  async listAccounts(): Promise<EnterpriseAccount[]> {
    return (
      await this.request<{ accounts: EnterpriseAccount[] }>(
        '/enterprise/accounts',
      )
    ).accounts;
  }

  async createAccount(input: AccountCreateInput): Promise<EnterpriseAccount> {
    return (
      await this.request<{ account: EnterpriseAccount }>(
        '/enterprise/accounts',
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      )
    ).account;
  }

  async updateAccount(
    id: string,
    input: AccountUpdateInput,
  ): Promise<EnterpriseAccount> {
    const previous = this.currentAccount;
    const requestGeneration = this.authOperationGeneration;
    const requestToken = this.token;
    const account = (
      await this.request<{ account: EnterpriseAccount }>(
        `/enterprise/accounts/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      )
    ).account;
    if (
      previous?.id === id &&
      requestGeneration === this.authOperationGeneration &&
      requestToken === this.token
    ) {
      const sessionWasRevoked =
        input.password !== undefined ||
        (input.status !== undefined && input.status !== previous.status) ||
        (input.isAdmin !== undefined && input.isAdmin !== previous.isAdmin) ||
        input.departmentId !== undefined ||
        input.positionId !== undefined;
      if (sessionWasRevoked) this.invalidateSession();
      else this.currentAccount = account;
    }
    return account;
  }

  async deleteAccount(id: string): Promise<{ id: string; deleted: true }> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, ['account_deletion']);
    return this.request(`/enterprise/accounts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async getDataGovernanceProfile(): Promise<EnterpriseDataGovernanceProfile> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, ['data_governance_v1']);
    return this.request('/enterprise/privacy');
  }

  async acceptCurrentLegalDocuments(): Promise<EnterpriseDataGovernanceProfile> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/privacy/accept', {
      method: 'POST',
      body: JSON.stringify({ accepted: true }),
    });
  }

  async exportMyAccountData(): Promise<Record<string, unknown>> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/privacy/export', { method: 'GET' });
  }

  async deleteMyAccount(input: {
    password: string;
    confirmation: string;
  }): Promise<EnterprisePrivacyDeletionReceipt> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    const result = await this.request<EnterprisePrivacyDeletionReceipt>(
      '/enterprise/privacy/account',
      { method: 'DELETE', body: JSON.stringify(input) },
    );
    this.invalidateSession();
    return result;
  }

  async recordTokenUsage(input: TokenUsageRecordInput): Promise<{
    recorded: boolean;
    source: 'client_reported';
  }> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/usage', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async recordKnowledge(
    input: EnterpriseKnowledgeRecordInput,
  ): Promise<EnterpriseKnowledgeRecordResult> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/knowledge', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async listKnowledge(
    input: {
      query?: string;
      department?: string;
      includeReview?: boolean;
      status?: EnterpriseKnowledgeItem['status'];
    } = {},
  ): Promise<EnterpriseKnowledgeItem[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    const params = new URLSearchParams();
    if (input.query?.trim()) params.set('q', input.query.trim());
    if (input.department?.trim())
      params.set('department', input.department.trim());
    if (input.includeReview) params.set('includeReview', 'true');
    if (input.status) params.set('status', input.status);
    const suffix = params.toString() ? `?${params}` : '';
    const response = await this.request<{
      knowledge: EnterpriseKnowledgeRow[];
    }>(`/enterprise/knowledge${suffix}`);
    return response.knowledge.map(mapEnterpriseKnowledgeItem);
  }

  async reviewKnowledge(
    id: string,
    action: 'approve' | 'archive',
    note?: string,
  ): Promise<EnterpriseKnowledgeItem> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    const response = await this.request<{ knowledge: EnterpriseKnowledgeRow }>(
      `/enterprise/knowledge/${encodeURIComponent(id)}/review`,
      {
        method: 'POST',
        body: JSON.stringify({
          action,
          ...(note?.trim() ? { note: note.trim() } : {}),
        }),
      },
    );
    return mapEnterpriseKnowledgeItem(response.knowledge);
  }

  async reviseKnowledge(
    id: string,
    input: {
      title: string;
      category: string;
      content: string;
      confidence?: number;
      changeNote?: string;
    },
  ): Promise<EnterpriseKnowledgeItem> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    const response = await this.request<{ knowledge: EnterpriseKnowledgeRow }>(
      `/enterprise/knowledge/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    );
    return mapEnterpriseKnowledgeItem(response.knowledge);
  }

  async listKnowledgeRevisions(
    id: string,
  ): Promise<EnterpriseKnowledgeRevision[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    const response = await this.request<{
      revisions: EnterpriseKnowledgeRevisionRow[];
    }>(`/enterprise/knowledge/${encodeURIComponent(id)}/revisions`);
    return response.revisions.map((item) => ({
      id: String(item.id),
      knowledgeId: String(item.knowledgeId ?? item.knowledge_id ?? id),
      version: typeof item.version === 'number' ? item.version : 1,
      title: item.title?.trim() || item.category,
      category: item.category,
      content: item.content,
      status: item.status || 'active',
      changedBy: item.changedBy ?? item.changed_by ?? null,
      changeNote: item.changeNote ?? item.change_note ?? null,
      createdAt: item.createdAt || item.created_at || '',
    }));
  }

  async listEnterpriseSkills(
    input: {
      scope?: EnterpriseSkillScope;
      query?: string;
      sort?: EnterpriseSkillSort;
    } = {},
  ): Promise<EnterpriseSkillMarketItem[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'enterprise_skill_market_v1',
    ]);
    const params = new URLSearchParams();
    if (input.scope) params.set('scope', input.scope);
    if (input.query?.trim()) params.set('q', input.query.trim());
    if (input.sort) params.set('sort', input.sort);
    const response = await this.request<{
      skills: EnterpriseSkillMarketItem[];
    }>(`/enterprise/skills${params.size > 0 ? `?${params}` : ''}`);
    return response.skills;
  }

  async submitEnterpriseSkill(input: {
    name: string;
    description: string;
    content: string;
    visibility: EnterpriseSkillVisibility;
  }): Promise<{
    outcome: 'submitted' | 'exists';
    skill: EnterpriseSkillMarketItem;
  }> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'enterprise_skill_market_v1',
    ]);
    return this.request('/enterprise/skills', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async reviewEnterpriseSkill(
    id: string,
    action: 'approve' | 'archive',
    visibility?: EnterpriseSkillVisibility,
  ): Promise<EnterpriseSkillMarketItem> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'enterprise_skill_market_v1',
    ]);
    const response = await this.request<{ skill: EnterpriseSkillMarketItem }>(
      `/enterprise/skills/${encodeURIComponent(id)}/review`,
      { method: 'POST', body: JSON.stringify({ action, visibility }) },
    );
    return response.skill;
  }

  async installEnterpriseSkill(
    id: string,
  ): Promise<EnterpriseSkillMarketItem & { content: string }> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'enterprise_skill_market_v1',
    ]);
    const response = await this.request<{
      skill: EnterpriseSkillMarketItem & { content: string };
    }>(`/enterprise/skills/${encodeURIComponent(id)}/install`, {
      method: 'POST',
      body: '{}',
    });
    return response.skill;
  }

  async rateEnterpriseSkill(
    id: string,
    score: number,
  ): Promise<EnterpriseSkillMarketItem> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'enterprise_skill_market_v1',
    ]);
    const response = await this.request<{ skill: EnterpriseSkillMarketItem }>(
      `/enterprise/skills/${encodeURIComponent(id)}/rating`,
      { method: 'POST', body: JSON.stringify({ score }) },
    );
    return response.skill;
  }

  async recordEnterpriseSkillUsage(
    id: string,
    success: boolean,
    eventId: string,
  ): Promise<EnterpriseSkillMarketItem> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'enterprise_skill_market_v1',
    ]);
    const response = await this.request<{ skill: EnterpriseSkillMarketItem }>(
      `/enterprise/skills/${encodeURIComponent(id)}/usage`,
      { method: 'POST', body: JSON.stringify({ success, eventId }) },
    );
    return response.skill;
  }

  async getEnterpriseSkillLeaderboard(): Promise<EnterpriseSkillLeaderboard> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'enterprise_skill_market_v1',
    ]);
    return this.request('/enterprise/skills/leaderboard');
  }

  async listAccountSyncSnapshots(): Promise<EnterpriseAccountSyncSnapshot[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, ['account_data_sync_v1']);
    const response = await this.request<{
      snapshots: EnterpriseAccountSyncSnapshot[];
    }>('/enterprise/account-sync', {}, { timeoutMs: 30_000 });
    return response.snapshots;
  }

  async putAccountSyncSnapshot(input: {
    scope: EnterpriseAccountSyncScope;
    expectedVersion: number;
    payload: EnterpriseAccountSyncPayload;
    deviceId?: string | null;
  }): Promise<EnterpriseAccountSyncSnapshot> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, ['account_data_sync_v1']);
    const response = await this.request<{
      snapshot: EnterpriseAccountSyncSnapshot;
    }>(
      '/enterprise/account-sync',
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
      { timeoutMs: 30_000 },
    );
    return response.snapshot;
  }
  async getOrganizationView(): Promise<EnterpriseOrganizationView> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/organization/view');
  }

  async heartbeatPresence(clientId = 'desktop'): Promise<void> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, ['account_presence_v1']);
    await this.request('/enterprise/presence/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ clientId }),
    });
  }

  async getOrganizationFeatures(): Promise<EnterpriseOrganizationFeatures> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'organization_feature_switches_v1',
    ]);
    return (
      await this.request<{ features: EnterpriseOrganizationFeatures }>(
        '/enterprise/organization/features',
      )
    ).features;
  }

  async getModuleUpdates(): Promise<EnterpriseModuleUpdateManifest> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'modular_update_push_v1',
    ]);
    return this.request('/enterprise/modules/updates/client');
  }

  async updateOrganizationFeatures(
    patch: Partial<EnterpriseOrganizationFeatures>,
  ): Promise<EnterpriseOrganizationFeatures> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'organization_feature_switches_v1',
    ]);
    return (
      await this.request<{ features: EnterpriseOrganizationFeatures }>(
        '/enterprise/organization/features',
        { method: 'PATCH', body: JSON.stringify(patch) },
      )
    ).features;
  }

  async listOrganizationDepartments(): Promise<
    EnterpriseOrganizationDepartment[]
  > {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'organization_structure_v1',
    ]);
    return (
      await this.request<{ structure: EnterpriseOrganizationDepartment[] }>(
        '/enterprise/organization/departments',
      )
    ).structure;
  }

  async createOrganizationDepartment(
    name: string,
  ): Promise<EnterpriseOrganizationDepartment> {
    return (
      await this.request<{ department: EnterpriseOrganizationDepartment }>(
        '/enterprise/organization/departments',
        { method: 'POST', body: JSON.stringify({ name }) },
      )
    ).department;
  }

  async updateOrganizationDepartment(
    id: string,
    name: string,
  ): Promise<EnterpriseOrganizationDepartment> {
    return (
      await this.request<{ department: EnterpriseOrganizationDepartment }>(
        `/enterprise/organization/departments/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify({ name }) },
      )
    ).department;
  }

  async deleteOrganizationDepartment(id: string): Promise<void> {
    await this.request(
      `/enterprise/organization/departments/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      },
    );
  }

  async createOrganizationPosition(input: {
    departmentId: string;
    title: string;
    roleMapping: EnterprisePositionRoleMapping;
  }): Promise<EnterpriseOrganizationPosition> {
    return (
      await this.request<{ position: EnterpriseOrganizationPosition }>(
        '/enterprise/organization/positions',
        { method: 'POST', body: JSON.stringify(input) },
      )
    ).position;
  }

  async updateOrganizationPosition(
    id: string,
    input: {
      title?: string;
      roleMapping?: EnterprisePositionRoleMapping;
    },
  ): Promise<EnterpriseOrganizationPosition> {
    return (
      await this.request<{ position: EnterpriseOrganizationPosition }>(
        `/enterprise/organization/positions/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      )
    ).position;
  }

  async deleteOrganizationPosition(id: string): Promise<void> {
    await this.request(
      `/enterprise/organization/positions/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      },
    );
  }

  async getParkView(): Promise<EnterprisePark | null> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return (
      await this.request<{ park: EnterprisePark | null }>(
        '/enterprise/park/view',
      )
    ).park;
  }

  async registerPark(input: {
    name: string;
    slug?: string;
    brandName?: string;
  }): Promise<EnterprisePark> {
    return (
      await this.request<{ park: EnterprisePark }>('/enterprise/park/manage', {
        method: 'POST',
        body: JSON.stringify(input),
      })
    ).park;
  }

  async joinPark(input: {
    inviteCode: string;
    address: string;
    roomNumber: string;
  }): Promise<EnterprisePark> {
    return (
      await this.request<{ park: EnterprisePark }>('/enterprise/park/join', {
        method: 'POST',
        body: JSON.stringify(input),
      })
    ).park;
  }

  async updateParkTenantProfile(input: {
    address: string;
    roomNumber: string;
  }): Promise<EnterpriseParkTenantProfile> {
    return (
      await this.request<{ profile: EnterpriseParkTenantProfile }>(
        '/enterprise/park/profile',
        {
          method: 'PATCH',
          body: JSON.stringify(input),
        },
      )
    ).profile;
  }

  async issueParkInvite(
    maxUses?: number | null,
  ): Promise<EnterpriseParkInvite> {
    return (
      await this.request<{ invite: EnterpriseParkInvite }>(
        '/enterprise/park/invite',
        {
          method: 'POST',
          body: JSON.stringify({ maxUses: maxUses ?? null }),
        },
      )
    ).invite;
  }

  async listParkTenantOrganizations(): Promise<
    EnterpriseParkTenantOrganization[]
  > {
    return (
      await this.request<{ organizations: EnterpriseParkTenantOrganization[] }>(
        '/enterprise/park/tenants',
      )
    ).organizations;
  }

  async getParkStatistics(): Promise<EnterpriseParkStatistics> {
    await this.assertCompatibleServer(this.serverUrl, [
      'park_service_statistics_v1',
    ]);
    return (
      await this.request<{ statistics: EnterpriseParkStatistics }>(
        '/enterprise/park/statistics',
      )
    ).statistics;
  }

  async listParkSpecialists(): Promise<EnterpriseParkSpecialist[]> {
    return (
      await this.request<{ specialists: EnterpriseParkSpecialist[] }>(
        '/enterprise/park/specialists',
      )
    ).specialists;
  }

  async setParkSpecialist(
    serviceId: string,
    accountId: string,
  ): Promise<EnterpriseParkSpecialist> {
    return (
      await this.request<{ specialist: EnterpriseParkSpecialist }>(
        '/enterprise/park/specialists',
        { method: 'POST', body: JSON.stringify({ serviceId, accountId }) },
      )
    ).specialist;
  }

  async removeParkSpecialist(
    serviceId: string,
    accountId: string,
  ): Promise<void> {
    await this.request('/enterprise/park/specialists', {
      method: 'DELETE',
      body: JSON.stringify({ serviceId, accountId }),
    });
  }

  async listParkServices(): Promise<EnterpriseParkService[]> {
    return (
      await this.request<{ services: EnterpriseParkService[] }>(
        '/enterprise/park/services',
      )
    ).services;
  }

  async updateParkService(input: {
    serviceId: string;
    name?: string;
    enabled?: boolean;
    config?: Record<string, string>;
  }): Promise<EnterpriseParkService> {
    return (
      await this.request<{ service: EnterpriseParkService }>(
        '/enterprise/park/services',
        { method: 'PATCH', body: JSON.stringify(input) },
      )
    ).service;
  }

  private requireE2eeContext(): {
    crypto: EnterpriseE2eeCrypto;
    account: EnterpriseAccount;
    serverScope: string;
  } {
    if (!this.e2ee) {
      throw new Error('private-chat E2EE is unavailable on this device');
    }
    if (!this.currentAccount || !this.serverUrl) {
      throw new Error('enterprise session has expired; please sign in again');
    }
    return {
      crypto: this.e2ee,
      account: this.currentAccount,
      serverScope: this.serverUrl,
    };
  }

  private async registerLocalE2eeDevice(): Promise<EnterpriseE2eeDeviceBundle> {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const local = crypto.localDevice(serverScope, account.id);
    const response = await this.request<{ device: EnterpriseE2eeDeviceBundle }>(
      '/enterprise/e2ee/devices',
      {
        method: 'POST',
        body: JSON.stringify({
          deviceId: local.deviceId,
          deviceName: local.deviceName,
          identitySigningPublicKey: local.identitySigningPublicKey,
          deviceExchangePublicKey: local.deviceExchangePublicKey,
        }),
      },
    );
    if (response.device.revokedAt) {
      throw new Error(
        'this E2EE device was revoked; recover or create a new trusted device',
      );
    }
    return response.device;
  }

  async ensureE2eeDeviceReady(): Promise<EnterpriseE2eeDeviceBundle> {
    if (!this.token)
      throw new Error('enterprise session has expired; please sign in again');
    await this.assertCompatibleServer(this.serverUrl, [
      'e2ee_private_messages_v1',
    ]);
    return this.registerLocalE2eeDevice();
  }

  private async e2eeDevicesForConversation(
    peerAccountId: string,
  ): Promise<EnterpriseE2eeDeviceBundle[]> {
    const { account } = this.requireE2eeContext();
    await this.registerLocalE2eeDevice();
    const query = new URLSearchParams();
    query.append('accountId', account.id);
    query.append('accountId', peerAccountId);
    return (
      await this.request<{ devices: EnterpriseE2eeDeviceBundle[] }>(
        `/enterprise/e2ee/devices?${query.toString()}`,
      )
    ).devices;
  }

  private decryptE2eeMessage(
    message: EnterpriseE2eeWireMessage,
  ): EnterpriseDirectMessage {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const decrypted = crypto.decryptMessage({
      serverScope,
      organizationId: account.organizationId,
      accountId: account.id,
      message,
    });
    return {
      id: decrypted.id,
      senderAccountId: decrypted.senderAccountId,
      recipientAccountId: decrypted.recipientAccountId,
      content: decrypted.content,
      createdAt: decrypted.createdAt,
      readAt: decrypted.readAt,
      attachments: decrypted.attachments,
      e2ee: true,
      contentType: decrypted.contentType,
      inReplyToMessageId: decrypted.inReplyToMessageId,
    };
  }

  async listOwnE2eeDevices(
    includeRevoked = true,
  ): Promise<EnterpriseE2eeDeviceBundle[]> {
    if (!this.token)
      throw new Error('enterprise session has expired; please sign in again');
    await this.assertCompatibleServer(this.serverUrl, [
      'e2ee_private_messages_v1',
      'e2ee_device_trust_v1',
    ]);
    const { account } = this.requireE2eeContext();
    await this.registerLocalE2eeDevice();
    const query = new URLSearchParams({
      accountId: account.id,
      includeRevoked: String(includeRevoked),
      includePending: 'true',
    });
    const devices = (
      await this.request<{ devices: EnterpriseE2eeDeviceBundle[] }>(
        `/enterprise/e2ee/devices?${query.toString()}`,
      )
    ).devices;
    const localDeviceId = this.requireE2eeContext().crypto.localDevice(
      this.serverUrl,
      account.id,
    ).deviceId;
    return devices.map((device) => ({
      ...device,
      isCurrentDevice: device.deviceId === localDeviceId,
    }));
  }

  async approveOwnE2eeDevice(
    deviceId: string,
  ): Promise<EnterpriseE2eeDeviceBundle> {
    if (!this.token)
      throw new Error('enterprise session has expired; please sign in again');
    await this.assertCompatibleServer(this.serverUrl, [
      'e2ee_private_messages_v1',
      'e2ee_device_trust_v1',
    ]);
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const devices = await this.listOwnE2eeDevices(true);
    const targetDevice = devices.find((device) => device.deviceId === deviceId);
    if (!targetDevice) throw new Error('E2EE device not found');
    const approval = crypto.signDeviceApproval({
      serverScope,
      organizationId: account.organizationId,
      accountId: account.id,
      targetDevice,
    });
    return (
      await this.request<{ device: EnterpriseE2eeDeviceBundle }>(
        `/enterprise/e2ee/devices/${encodeURIComponent(deviceId)}/approve`,
        {
          method: 'POST',
          body: JSON.stringify(approval),
        },
      )
    ).device;
  }

  async getOwnE2eeDeviceVerification(
    deviceId: string,
  ): Promise<EnterpriseE2eeDeviceVerification> {
    if (!this.token)
      throw new Error('enterprise session has expired; please sign in again');
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const devices = await this.listOwnE2eeDevices(true);
    const targetDevice = devices.find((device) => device.deviceId === deviceId);
    if (!targetDevice) throw new Error('E2EE device not found');
    return enterpriseE2eeDeviceVerification(
      crypto.localDevice(serverScope, account.id),
      targetDevice,
    );
  }

  async revokeOwnE2eeDevice(deviceId: string): Promise<void> {
    if (!this.token)
      throw new Error('enterprise session has expired; please sign in again');
    await this.assertCompatibleServer(this.serverUrl, [
      'e2ee_private_messages_v1',
    ]);
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const local = crypto.localDevice(serverScope, account.id);
    await this.request(
      `/enterprise/e2ee/devices/${encodeURIComponent(deviceId)}`,
      { method: 'DELETE' },
    );
    if (deviceId === local.deviceId) {
      crypto.rotateLocalDevice(serverScope, account.id);
      await this.registerLocalE2eeDevice();
    }
  }

  async listDirectMessages(
    peerAccountId: string,
  ): Promise<EnterpriseDirectMessage[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'direct_messages',
      'e2ee_private_messages_v1',
    ]);
    await this.registerLocalE2eeDevice();
    const messages = (
      await this.request<{ messages: EnterpriseE2eeWireMessage[] }>(
        '/enterprise/messages/' + encodeURIComponent(peerAccountId),
      )
    ).messages;
    return messages.map((message) => this.decryptE2eeMessage(message));
  }
  async listUnreadDirectMessageNotifications(): Promise<
    EnterpriseUnreadMessageNotification[]
  > {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'unread_message_notifications_v1',
    ]);
    try {
      return (
        await this.request<{
          notifications: EnterpriseUnreadMessageNotification[];
        }>('/enterprise/messages/unread')
      ).notifications;
    } catch (error) {
      // 管理员主动关闭企业消息是正常配置态；后台轮询不应弹错误或重试刷屏。
      if (error instanceof EnterpriseRequestError && error.status === 403)
        return [];
      throw error;
    }
  }

  async sendDirectMessage(
    peerAccountId: string,
    content: string,
    attachments: EnterpriseDirectMessageAttachmentUpload[] = [],
  ): Promise<EnterpriseDirectMessage> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'direct_messages',
      'e2ee_private_messages_v1',
      ...(attachments.length > 0 ? ['direct_message_attachments_v1'] : []),
    ]);
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const devices = await this.e2eeDevicesForConversation(peerAccountId);
    const protocol = e2eeProtocolMetadata(content);
    const encrypted = crypto.encryptMessage({
      serverScope,
      organizationId: account.organizationId,
      senderAccountId: account.id,
      recipientAccountId: peerAccountId,
      content,
      contentType: protocol.contentType,
      inReplyToMessageId: protocol.inReplyToMessageId,
      devices,
      attachments,
    });
    const message = (
      await this.request<{ message: EnterpriseE2eeWireMessage }>(
        '/enterprise/messages/' + encodeURIComponent(peerAccountId),
        {
          method: 'POST',
          body: JSON.stringify(encrypted),
        },
        { timeoutMs: attachments.length > 0 ? 60_000 : 10_000 },
      )
    ).message;
    return this.decryptE2eeMessage(message);
  }

  async getDirectMessageAttachment(
    attachmentId: string,
  ): Promise<EnterpriseDirectMessageAttachmentDownload> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'direct_message_attachments_v1',
      'e2ee_private_messages_v1',
    ]);
    const download = await this.request<{
      attachment: {
        message: EnterpriseE2eeWireMessage;
        attachment: { id: string; ciphertext: string; nonce: string };
      };
    }>(
      '/enterprise/message-attachments/' + encodeURIComponent(attachmentId),
      {},
      { timeoutMs: 60_000 },
    );
    const { crypto, account, serverScope } = this.requireE2eeContext();
    return crypto.decryptAttachment({
      serverScope,
      organizationId: account.organizationId,
      accountId: account.id,
      message: download.attachment.message,
      attachment: download.attachment.attachment,
    });
  }
  async listAtoaInbox(): Promise<EnterpriseAtoaInboxMessage[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'atoa',
      'e2ee_private_messages_v1',
    ]);
    await this.registerLocalE2eeDevice();
    const requests = (
      await this.request<{
        requests: Array<
          EnterpriseE2eeWireMessage & {
            peerAccountId: string;
            peer: EnterpriseAtoaInboxMessage['peer'];
          }
        >;
      }>('/enterprise/atoa/inbox')
    ).requests;
    return requests.map((request) => ({
      ...this.decryptE2eeMessage(request),
      peerAccountId: request.peerAccountId,
      peer: request.peer,
    }));
  }

  async pushParkService(input: {
    recipientAccountId: string;
    serviceId: string;
    note?: string | null;
  }): Promise<{
    message?: EnterpriseDirectMessage;
    publication?: EnterpriseParkPublication;
    recipientCount?: number;
  }> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/park-services/push', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async listParkPublications(): Promise<EnterpriseParkPublication[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return (
      await this.request<{ publications: EnterpriseParkPublication[] }>(
        '/enterprise/park-services/publications',
      )
    ).publications;
  }

  async listParkAnnouncementResults(): Promise<
    EnterpriseParkAnnouncementResult[]
  > {
    return (
      await this.request<{ announcements: EnterpriseParkAnnouncementResult[] }>(
        '/enterprise/park-services/announcement-results',
      )
    ).announcements;
  }

  async listParkSurveyResults(): Promise<EnterpriseParkSurveyResult[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return (
      await this.request<{ surveys: EnterpriseParkSurveyResult[] }>(
        '/enterprise/park-services/survey-results',
      )
    ).surveys;
  }

  async getParkResources(): Promise<EnterpriseParkResources> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/park-resources');
  }

  async readParkPublication(id: string): Promise<EnterpriseParkPublication> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return (
      await this.request<{ publication: EnterpriseParkPublication }>(
        `/enterprise/park-services/publications/${encodeURIComponent(id)}/read`,
        { method: 'POST' },
      )
    ).publication;
  }

  async submitParkSurvey(
    id: string,
    responseData: Record<string, string>,
  ): Promise<EnterpriseParkPublication> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return (
      await this.request<{ publication: EnterpriseParkPublication }>(
        `/enterprise/park-services/publications/${encodeURIComponent(id)}/submit`,
        { method: 'POST', body: JSON.stringify({ responseData }) },
      )
    ).publication;
  }

  async getOrganizationInvite(): Promise<EnterpriseOrganizationInviteContext> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'organization_invites',
      'position_invites',
    ]);
    return this.request('/enterprise/organization/invite');
  }

  async issueOrganizationInvite(
    input: {
      defaultDepartment?: string | null;
      departmentId?: string | null;
      positionId?: string | null;
      positionTitle?: string | null;
      defaultRole?: string | null;
      maxUses?: number | null;
    } = {},
  ): Promise<
    EnterpriseOrganizationInviteContext & {
      invite: EnterpriseOrganizationInvite;
    }
  > {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'organization_invites',
      'position_invites',
    ]);
    return this.request('/enterprise/organization/invite', {
      method: 'POST',
      body: JSON.stringify({
        defaultDepartment: input.defaultDepartment ?? null,
        departmentId: input.departmentId ?? null,
        positionId: input.positionId ?? null,
        positionTitle: input.positionTitle ?? null,
        defaultRole: input.defaultRole ?? null,
        maxUses: input.maxUses ?? null,
      }),
    });
  }

  async ticketInbox(): Promise<EnterpriseRepairTicket[]> {
    return (
      await this.request<{ tickets: EnterpriseRepairTicket[] }>(
        '/enterprise/tickets/inbox',
      )
    ).tickets;
  }

  async listTickets(): Promise<EnterpriseRepairTicket[]> {
    return (
      await this.request<{ tickets: EnterpriseRepairTicket[] }>(
        '/enterprise/tickets',
      )
    ).tickets;
  }

  async submitTicket(input: {
    serviceId?: string;
    title: string;
    description: string;
    targetTags?: string[];
    formData?: Record<string, string>;
    category?: string;
    location?: string;
    urgency?: string;
    contact?: string;
    contactPhone?: string;
  }): Promise<EnterpriseRepairTicket> {
    return (
      await this.request<{ ticket: EnterpriseRepairTicket }>(
        '/enterprise/tickets',
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      )
    ).ticket;
  }

  async readTicket(id: string): Promise<EnterpriseRepairTicket> {
    return (
      await this.request<{ ticket: EnterpriseRepairTicket }>(
        `/enterprise/tickets/${encodeURIComponent(id)}/read`,
        { method: 'POST' },
      )
    ).ticket;
  }

  async updateTicket(
    id: string,
    input: {
      action:
        'respond' | 'accept' | 'complete' | 'confirm' | 'respond_and_transfer';
      responseType?: string;
      responseText?: string;
      transferDepartment?: string;
      transferNote?: string;
    },
  ): Promise<EnterpriseRepairTicket> {
    return (
      await this.request<{ ticket: EnterpriseRepairTicket }>(
        `/enterprise/tickets/${encodeURIComponent(id)}/action`,
        { method: 'POST', body: JSON.stringify(input) },
      )
    ).ticket;
  }

  private setServerUrl(serverUrl: string): void {
    if (serverUrl !== this.serverUrl) {
      this.compatibleServerUrl = '';
      this.compatibleCapabilities.clear();
    }
    this.serverUrl = serverUrl;
  }

  private beginAuthOperation(serverUrl: string): number {
    this.authOperationGeneration += 1;
    this.setServerUrl(serverUrl);
    this.token = null;
    this.currentAccount = null;
    return this.authOperationGeneration;
  }

  private assertAuthOperationCurrent(
    generation: number,
    serverUrl: string,
  ): void {
    if (
      generation !== this.authOperationGeneration ||
      serverUrl !== this.serverUrl
    ) {
      throw new Error(ENTERPRISE_AUTH_SUPERSEDED_ERROR);
    }
  }

  private isSessionSnapshotCurrent(
    generation: number,
    serverUrl: string,
    token: string,
  ): boolean {
    return (
      generation === this.authOperationGeneration &&
      serverUrl === this.serverUrl &&
      token === this.token
    );
  }

  private currentSessionResult(): EnterpriseSessionResult {
    return {
      serverUrl: this.serverUrl,
      account: this.token ? this.currentAccount : null,
    };
  }

  private async assertCompatibleServer(
    serverUrl: string,
    requiredCapabilities: readonly string[],
  ): Promise<void> {
    if (
      this.compatibleServerUrl === serverUrl &&
      requiredCapabilities.every((capability) =>
        this.compatibleCapabilities.has(capability),
      )
    ) {
      return;
    }

    const health = await this.request<EnterpriseServerHealth>(
      '/enterprise/health',
      {},
      {
        omitAuthorization: true,
        preserveSessionOnUnauthorized: true,
        serverUrl,
        authorizationToken: null,
      },
    );
    const capabilities =
      Array.isArray(health.capabilities) &&
      health.capabilities.every((capability) => typeof capability === 'string')
        ? new Set(health.capabilities)
        : null;
    const isCompatible =
      health.status === 'ok' &&
      typeof health.apiVersion === 'number' &&
      health.apiVersion >= 2 &&
      capabilities !== null &&
      requiredCapabilities.every((capability) => capabilities.has(capability));
    if (!isCompatible) throw new Error(ENTERPRISE_SERVER_UPGRADE_ERROR);

    if (serverUrl === this.serverUrl) {
      this.compatibleServerUrl = serverUrl;
      this.compatibleCapabilities = capabilities;
    }
  }

  private invalidateSession(): void {
    const hadToken = Boolean(this.token);
    this.authOperationGeneration += 1;
    this.token = null;
    this.currentAccount = null;
    if (hadToken) this.onSessionInvalidated();
  }
}

export async function logoutAndPersistEnterpriseSession(
  client: Pick<EnterpriseClient, 'logout'>,
  persistSession: () => void,
): Promise<void> {
  try {
    await client.logout();
  } finally {
    persistSession();
  }
}
