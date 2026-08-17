/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业账号 API 客户端。只运行在 Electron main 进程：renderer 不直接请求
 * 企业服务器，也永远拿不到会话令牌。
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MlsKeyPackage } from '@otto/native';

import {
  buildAtoaResponse,
  buildFederationAtoaDecision,
  deterministicFederationAtoaMessageId,
  federationAtoaScope,
  parseAtoaRequest,
  parseFederationAtoaDecision,
  type AtoaContextSource,
  type AtoaRequestPayload,
  type FederationAtoaApprovedDecision,
} from './federation-atoa-protocol.js';
import { deriveFederationAtoaTasks } from './federation-atoa-tasks.js';

import {
  ENTERPRISE_FEDERATION_E2EE_SCOPE,
  enterpriseE2eeDeviceVerification,
  enterpriseFederationContactVerification,
  enterpriseFederationIdentityCardDevices,
  enterpriseFederationIdentityKeyFingerprint,
  type EnterpriseE2eeDeviceVerification,
  type EnterpriseE2eeCrypto,
  type EnterpriseE2eeDeviceBundle,
  type EnterpriseE2eePreparedExternalAttachment,
  type EnterpriseE2eeKeyTransparencyView,
  type EnterpriseE2eeWireMessage,
  type EnterpriseFederationContactTrust,
  type EnterpriseFederationIdentityCard,
} from './enterprise-e2ee.js';
import {
  ENTERPRISE_MLS_CIPHERSUITE,
  enterpriseMlsDirectConversationId,
  parseEnterpriseMlsInboundConversationHeadPage,
  parseEnterpriseMlsInboundConversationPeerPage,
  parseEnterpriseMlsAttachmentSession,
  parseEnterpriseMlsKeyPackageInventory,
  parseEnterpriseMlsPublishedKeyPackage,
  parseEnterpriseMlsTransportEvent,
  type EnterpriseMlsAppendTransportEventInput,
  type EnterpriseMlsAttachmentSession,
  type EnterpriseMlsInboundConversationHead,
  type EnterpriseMlsKeyPackageInventory,
  type EnterpriseMlsPublishedKeyPackage,
  type EnterpriseMlsTransportEvent,
} from './enterprise-mls.js';
import {
  validateEnterpriseMlsAttachmentManifest,
  type EnterpriseMlsAttachmentManifest,
} from './enterprise-mls-attachments.js';

export type {
  EnterpriseE2eeKeyTransparencyEntry,
  EnterpriseE2eeKeyTransparencyEvent,
  EnterpriseE2eeKeyTransparencyView,
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
  legalDocuments: EnterpriseLegalDocumentReference[];
}

export interface EnterpriseLegalDocumentReference {
  id: 'terms' | 'privacy';
  version: string;
  hash: string;
}

export interface EnterpriseLegalDocumentSection {
  id: string;
  title: string;
  paragraphs: string[];
  items?: string[];
  important?: boolean;
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

export interface ManagedModelGatewayAccess {
  baseUrl: string;
  accessToken: string;
  expiresAt: string;
  allowedModels: string[];
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

export interface EnterpriseUpdateManifestReference {
  url: string;
  sha256: string;
}

export interface EnterpriseResolvedUpdatePolicy {
  version: 1;
  deploymentId: string;
  distributionId: string;
  currentVersion: string;
  decision: 'update' | 'none';
  reason:
    'update_available' | 'up_to_date' | 'outside_rollout' | 'no_active_release';
  release: {
    id: string;
    version: string;
    sourceCommit: string;
    channel: 'canary' | 'stable' | 'required';
    mandatory: boolean;
    rolloutPercent: number;
    notes: string;
    fullManifest: EnterpriseUpdateManifestReference | null;
    incrementalManifest: EnterpriseUpdateManifestReference | null;
    publishedAt: string;
  } | null;
  issuedAtMs: number;
  expiresAtMs: number;
}

export type EnterpriseUpdatePolicyResult =
  | {
      status: 'resolved';
      policy: EnterpriseResolvedUpdatePolicy;
      verifiedKeyId: string;
    }
  | {
      status: 'not_configured';
      reason: 'online_license_required' | 'verification_key_missing';
    }
  | { status: 'unavailable'; error: string };

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
  data?: string;
  sourcePath?: string;
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
  e2eeProtocol?: 'device-envelope-v1' | 'mls10-openmls-0.8';
  contentType?: 'message' | 'atoa_request' | 'atoa_response';
  inReplyToMessageId?: string | null;
}

export interface EnterpriseFederationContact {
  id: string;
  identity: string;
  remoteDeploymentId: string;
  remotePrincipalId: string;
  displayName: string;
  deploymentDisplayName: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  unreadCount: number;
  trustState: 'missing' | 'unverified' | 'verified';
  keyFingerprint: string | null;
}

export interface EnterpriseFederatedDirectMessage extends EnterpriseDirectMessage {
  federated: true;
  contactId: string;
  federationMessageType: 'chat.message' | 'a2a.request' | 'a2a.response';
  federationA2aGrantId?: string;
  federationA2aScope?: string;
  direction: 'inbound' | 'outbound';
  deliveryStatus: 'queued' | 'sent' | 'failed' | 'expired' | 'received';
  trustState: 'unverified' | 'verified';
}

type EnterpriseFederationWireContact = Omit<
  EnterpriseFederationContact,
  'trustState' | 'keyFingerprint'
>;

interface EnterpriseFederationWireMessage {
  cursor: number;
  messageId: string;
  contactId: string;
  direction: 'inbound' | 'outbound';
  type: 'chat.message' | 'a2a.request' | 'a2a.response';
  ciphertext: string;
  issuedAt: string;
  receivedAt: string;
  deliveryStatus: 'queued' | 'sent' | 'failed' | 'expired' | 'received';
  readAt: string | null;
  routing: {
    conversationId: string;
    senderPrincipalId: string;
    recipientPrincipalId: string;
    inReplyTo?: string;
    a2aGrantId?: string;
    a2aScope?: string;
    attachmentIds?: string[];
  };
}

export type EnterpriseFederationAtoaTask =
  | {
      kind: 'proposal';
      contact: EnterpriseFederationContact;
      message: EnterpriseFederatedDirectMessage;
      request: AtoaRequestPayload;
    }
  | {
      kind: 'grant';
      contact: EnterpriseFederationContact;
      message: EnterpriseFederatedDirectMessage;
      decision: FederationAtoaApprovedDecision;
    }
  | {
      kind: 'request';
      contact: EnterpriseFederationContact;
      message: EnterpriseFederatedDirectMessage;
      request: AtoaRequestPayload;
      grantedSources: AtoaContextSource[];
      needsCurrentChatSelection: boolean;
    };

interface EnterpriseFederationEncryptedPayload {
  v: 1;
  senderCard: EnterpriseFederationIdentityCard;
  message: EnterpriseE2eeWireMessage;
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
    sections: EnterpriseLegalDocumentSection[];
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

const FEDERATION_CONTACT_CODE_PREFIX = 'OTTO_FEDERATION_CONTACT_V1:';

function federationConversationId(input: {
  localDeploymentId: string;
  localPrincipalId: string;
  remoteDeploymentId: string;
  remotePrincipalId: string;
}): string {
  const participants = [
    `${input.localDeploymentId}:${input.localPrincipalId}`,
    `${input.remoteDeploymentId}:${input.remotePrincipalId}`,
  ].sort();
  return `fconversation_${createHash('sha256')
    .update('otto:federation-conversation:v1\0')
    .update(participants.join('\0'))
    .digest('hex')
    .slice(0, 40)}`;
}

function parseFederationContactCode(value: string): EnterpriseFederationIdentityCard {
  const encoded = value.trim().startsWith(FEDERATION_CONTACT_CODE_PREFIX)
    ? value.trim().slice(FEDERATION_CONTACT_CODE_PREFIX.length)
    : value.trim();
  try {
    const card = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as
      EnterpriseFederationIdentityCard;
    if (!card || typeof card !== 'object') throw new Error('invalid card');
    return card;
  } catch {
    throw new Error('联邦联系码无效，请让对方重新生成');
  }
}

function parseFederationEncryptedPayload(
  ciphertext: string,
): EnterpriseFederationEncryptedPayload {
  try {
    const payload = JSON.parse(
      Buffer.from(ciphertext, 'base64url').toString('utf8'),
    ) as EnterpriseFederationEncryptedPayload;
    if (
      payload?.v !== 1 ||
      !payload.senderCard ||
      !payload.message ||
      payload.message.protocolVersion !== 1 ||
      !Array.isArray(payload.message.attachments) ||
      payload.message.attachments.length > 6
    ) {
      throw new Error('invalid payload');
    }
    return payload;
  } catch {
    throw new Error('联邦私聊密文格式无效');
  }
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

function parseAtoaMessage(content: string): {
  kind: 'request';
  payload: AtoaRequestPayload;
} | null {
  const payload = parseAtoaRequest(content);
  return payload ? { kind: 'request', payload } : null;
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

  supportsMlsPrivateMessages(): boolean {
    return (
      this.token !== null &&
      this.compatibleServerUrl === this.serverUrl &&
      this.compatibleCapabilities.has('e2ee_mls_v1')
    );
  }

  supportsMlsTransportFoundation(): boolean {
    return (
      this.token !== null &&
      this.compatibleServerUrl === this.serverUrl &&
      this.compatibleCapabilities.has('e2ee_mls_transport_v1')
    );
  }

  private refuseMlsProtocolDowngrade(): void {
    if (this.supportsMlsPrivateMessages()) {
      throw new Error(
        'MLS private-message transport is not active; refusing protocol downgrade',
      );
    }
  }

  async publishMlsKeyPackage(
    deviceId: string,
    keyPackage: MlsKeyPackage,
  ): Promise<EnterpriseMlsPublishedKeyPackage> {
    const account = await this.requireMlsTransportAccount();
    if (
      keyPackage.protocol !== 'mls10-openmls-0.8' ||
      keyPackage.ciphersuite !== ENTERPRISE_MLS_CIPHERSUITE ||
      !/^[0-9a-f]{64}$/.test(keyPackage.reference)
    ) {
      throw new Error('local MLS KeyPackage is invalid');
    }
    const published = parseEnterpriseMlsPublishedKeyPackage(
      (
        await this.request<{ keyPackage: unknown }>(
          '/enterprise/e2ee/mls/key-packages',
          {
            method: 'POST',
            body: JSON.stringify({
              deviceId,
              ciphersuite: keyPackage.ciphersuite,
              keyPackageReference: keyPackage.reference,
              keyPackage: keyPackage.key_package,
            }),
          },
        )
      ).keyPackage,
    );
    if (
      published.accountId !== account.id ||
      published.deviceId !== deviceId ||
      published.reference !== keyPackage.reference ||
      published.keyPackage !== keyPackage.key_package ||
      published.claimedAt !== null
    ) {
      throw new Error(
        'enterprise MLS KeyPackage publication binding is invalid',
      );
    }
    return published;
  }

  async listMlsKeyPackageInventory(
    deviceId: string,
  ): Promise<EnterpriseMlsKeyPackageInventory> {
    await this.requireMlsTransportAccount();
    const response = await this.request<unknown>(
      `/enterprise/e2ee/mls/key-packages/inventory?deviceId=${encodeURIComponent(deviceId)}`,
    );
    return parseEnterpriseMlsKeyPackageInventory(response, deviceId);
  }

  async retireMlsKeyPackage(
    deviceId: string,
    reference: string,
  ): Promise<void> {
    await this.requireMlsTransportAccount();
    if (!/^[0-9a-f]{64}$/.test(reference)) {
      throw new Error('MLS KeyPackage reference is invalid');
    }
    const response = await this.request<{
      deviceId?: unknown;
      reference?: unknown;
      retired?: unknown;
    }>(
      `/enterprise/e2ee/mls/key-packages/${reference}?deviceId=${encodeURIComponent(deviceId)}`,
      { method: 'DELETE' },
    );
    if (
      response.deviceId !== deviceId ||
      response.reference !== reference ||
      response.retired !== true
    ) {
      throw new Error(
        'enterprise MLS KeyPackage retirement binding is invalid',
      );
    }
  }

  async claimMlsKeyPackage(
    requesterDeviceId: string,
    recipientAccountId: string,
    recipientDeviceId?: string,
    conversationPeerAccountId: string = recipientAccountId,
  ): Promise<EnterpriseMlsPublishedKeyPackage | null> {
    const account = await this.requireMlsTransportAccount();
    enterpriseMlsDirectConversationId({
      organizationId: account.organizationId,
      accountId: account.id,
      peerAccountId: conversationPeerAccountId,
    });
    try {
      const claimed = parseEnterpriseMlsPublishedKeyPackage(
        (
          await this.request<{ keyPackage: unknown }>(
            '/enterprise/e2ee/mls/key-packages/claim',
            {
              method: 'POST',
              body: JSON.stringify({
                requesterDeviceId,
                recipientAccountId,
                recipientDeviceId,
                conversationPeerAccountId,
              }),
            },
          )
        ).keyPackage,
      );
      if (
        claimed.accountId !== recipientAccountId ||
        (recipientDeviceId && claimed.deviceId !== recipientDeviceId) ||
        !claimed.claimedAt
      ) {
        throw new Error('enterprise MLS KeyPackage claim binding is invalid');
      }
      return claimed;
    } catch (error) {
      if (error instanceof EnterpriseRequestError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async listApprovedMlsDeviceIds(accountId: string): Promise<string[]> {
    await this.requireMlsTransportAccount();
    const devices = await this.verifiedE2eeDeviceDirectory([accountId], {
      includePending: false,
      includeRevoked: false,
    });
    const deviceIds = devices
      .filter(
        (device) =>
          device.accountId === accountId &&
          device.approvalState === 'approved' &&
          !device.revokedAt,
      )
      .map((device) => device.deviceId)
      .sort();
    if (
      deviceIds.length === 0 ||
      new Set(deviceIds).size !== deviceIds.length
    ) {
      throw new Error('enterprise MLS approved device directory is invalid');
    }
    return deviceIds;
  }

  async appendMlsTransportEvent(
    peerAccountId: string,
    input: EnterpriseMlsAppendTransportEventInput,
  ): Promise<EnterpriseMlsTransportEvent> {
    const account = await this.requireMlsTransportAccount();
    const conversationId = enterpriseMlsDirectConversationId({
      organizationId: account.organizationId,
      accountId: account.id,
      peerAccountId,
    });
    const event = parseEnterpriseMlsTransportEvent(
      (
        await this.request<{ event: unknown }>(
          `/enterprise/e2ee/mls/conversations/${encodeURIComponent(peerAccountId)}/events`,
          { method: 'POST', body: JSON.stringify(input) },
          { timeoutMs: 30_000 },
        )
      ).event,
    );
    if (
      event.conversationId !== conversationId ||
      event.senderAccountId !== account.id ||
      event.senderDeviceId !== input.senderDeviceId ||
      event.eventId !== input.eventId ||
      event.eventType !== input.eventType ||
      event.epoch !== input.epoch ||
      event.groupId !== input.groupId ||
      event.payload !== input.payload ||
      event.recipientAccountId !==
        (input.eventType === 'welcome'
          ? (input.recipientAccountId ?? peerAccountId)
          : null) ||
      event.recipientDeviceId !== (input.recipientDeviceId ?? null) ||
      event.keyPackageReference !== (input.keyPackageReference ?? null) ||
      (event.resetFromGroupId ?? null) !== (input.resetFromGroupId ?? null)
    ) {
      throw new Error('enterprise MLS transport event binding is invalid');
    }
    return event;
  }

  async listMlsTransportEvents(
    peerAccountId: string,
    afterSequence = 0,
    limit = 100,
  ): Promise<EnterpriseMlsTransportEvent[]> {
    const account = await this.requireMlsTransportAccount();
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new Error('MLS event cursor or limit is invalid');
    }
    const conversationId = enterpriseMlsDirectConversationId({
      organizationId: account.organizationId,
      accountId: account.id,
      peerAccountId,
    });
    const response = await this.request<{ events: unknown }>(
      `/enterprise/e2ee/mls/conversations/${encodeURIComponent(peerAccountId)}/events?afterSequence=${afterSequence}&limit=${limit}`,
    );
    if (!Array.isArray(response.events)) {
      throw new Error('enterprise MLS transport event list is invalid');
    }
    let previousSequence = afterSequence;
    return response.events.map((value) => {
      const event = parseEnterpriseMlsTransportEvent(value);
      const expectedRecipient =
        event.senderAccountId === account.id ? peerAccountId : account.id;
      if (
        event.conversationId !== conversationId ||
        ![account.id, peerAccountId].includes(event.senderAccountId) ||
        event.sequence <= previousSequence ||
        (event.eventType === 'welcome' &&
          event.recipientAccountId !== expectedRecipient)
      ) {
        throw new Error(
          'enterprise MLS transport event list binding is invalid',
        );
      }
      previousSequence = event.sequence;
      return event;
    });
  }

  async listMlsInboundConversationPeers(deviceId: string): Promise<string[]> {
    const account = await this.requireMlsTransportAccount();
    const pageLimit = 500;
    const maximumPeers = 1_000;
    const peerAccountIds: string[] = [];
    let afterPeerAccountId = '';
    while (peerAccountIds.length < maximumPeers) {
      const query = new URLSearchParams({
        deviceId,
        limit: String(pageLimit),
      });
      if (afterPeerAccountId) {
        query.set('afterPeerAccountId', afterPeerAccountId);
      }
      const response = await this.request<{ peerAccountIds: unknown }>(
        `/enterprise/e2ee/mls/inbound-conversations?${query.toString()}`,
      );
      const page = parseEnterpriseMlsInboundConversationPeerPage(
        response.peerAccountIds,
        afterPeerAccountId,
      );
      if (page.some((peerAccountId) => peerAccountId === account.id)) {
        throw new Error(
          'enterprise MLS inbound conversation binding is invalid',
        );
      }
      peerAccountIds.push(...page);
      if (page.length < pageLimit) return peerAccountIds;
      afterPeerAccountId = page.at(-1)!;
    }
    const overflowQuery = new URLSearchParams({
      deviceId,
      afterPeerAccountId,
      limit: '1',
    });
    const overflow = await this.request<{ peerAccountIds: unknown }>(
      `/enterprise/e2ee/mls/inbound-conversations?${overflowQuery.toString()}`,
    );
    if (
      parseEnterpriseMlsInboundConversationPeerPage(
        overflow.peerAccountIds,
        afterPeerAccountId,
      ).length > 0
    ) {
      throw new Error('enterprise MLS inbound conversation limit exceeded');
    }
    return peerAccountIds;
  }

  async listMlsInboundConversationHeads(
    deviceId: string,
  ): Promise<EnterpriseMlsInboundConversationHead[] | null> {
    const account = await this.requireMlsTransportAccount();
    const pageLimit = 500;
    const maximumPeers = 1_000;
    const conversationHeads: EnterpriseMlsInboundConversationHead[] = [];
    let afterPeerAccountId = '';
    while (conversationHeads.length < maximumPeers) {
      const query = new URLSearchParams({
        deviceId,
        limit: String(pageLimit),
        includeHeads: '1',
      });
      if (afterPeerAccountId) {
        query.set('afterPeerAccountId', afterPeerAccountId);
      }
      const response = await this.request<{
        conversationHeads?: unknown;
        peerAccountIds?: unknown;
      }>(
        `/enterprise/e2ee/mls/inbound-conversations?${query.toString()}`,
      );
      if (
        !Object.prototype.hasOwnProperty.call(response, 'conversationHeads')
      ) {
        const legacyPeers = parseEnterpriseMlsInboundConversationPeerPage(
          response.peerAccountIds,
          afterPeerAccountId,
        );
        if (legacyPeers.some((peerAccountId) => peerAccountId === account.id)) {
          throw new Error(
            'enterprise MLS inbound conversation binding is invalid',
          );
        }
        return null;
      }
      const page = parseEnterpriseMlsInboundConversationHeadPage(
        response.conversationHeads,
        afterPeerAccountId,
      );
      if (page.some((head) => head.peerAccountId === account.id)) {
        throw new Error(
          'enterprise MLS inbound conversation binding is invalid',
        );
      }
      conversationHeads.push(...page);
      if (page.length < pageLimit) return conversationHeads;
      afterPeerAccountId = page.at(-1)!.peerAccountId;
    }
    const overflowQuery = new URLSearchParams({
      deviceId,
      afterPeerAccountId,
      limit: '1',
      includeHeads: '1',
    });
    const overflow = await this.request<{ conversationHeads: unknown }>(
      `/enterprise/e2ee/mls/inbound-conversations?${overflowQuery.toString()}`,
    );
    if (
      parseEnterpriseMlsInboundConversationHeadPage(
        overflow.conversationHeads,
        afterPeerAccountId,
      ).length > 0
    ) {
      throw new Error('enterprise MLS inbound conversation limit exceeded');
    }
    return conversationHeads;
  }

  async getMlsAttachmentSession(
    peerAccountId: string,
    deviceId: string,
  ): Promise<EnterpriseMlsAttachmentSession> {
    const account = await this.requireMlsTransportAccount();
    const conversationId = enterpriseMlsDirectConversationId({
      organizationId: account.organizationId,
      accountId: account.id,
      peerAccountId,
    });
    const response = await this.request<{ session: unknown }>(
      `/enterprise/e2ee/mls/conversations/${encodeURIComponent(peerAccountId)}/attachment-session?deviceId=${encodeURIComponent(deviceId)}`,
    );
    const session = parseEnterpriseMlsAttachmentSession(response.session);
    if (
      session.conversationId !== conversationId ||
      !session.participantAccountIds.includes(account.id) ||
      !session.participantAccountIds.includes(peerAccountId) ||
      !session.authorizedDevices.some(
        (device) =>
          device.accountId === account.id && device.deviceId === deviceId,
      )
    ) {
      throw new Error('enterprise MLS attachment session binding is invalid');
    }
    return session;
  }

  async uploadMlsAttachmentObject(input: {
    peerAccountId: string;
    deviceId: string;
    manifest: EnterpriseMlsAttachmentManifest;
    ciphertextPath: string;
    authorizedDevices: Array<{ accountId: string; deviceId: string }>;
  }): Promise<EnterpriseMlsAttachmentManifest['object']> {
    await this.requireMlsTransportAccount();
    await this.assertCompatibleServer(this.serverUrl, [
      'e2ee_mls_transport_v1',
      'e2ee_attachment_objects_v1',
      's3_multipart_uploads_v1',
    ]);
    const manifest = validateEnterpriseMlsAttachmentManifest(input.manifest);
    const metadata = await fs.promises.lstat(input.ciphertextPath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size !== manifest.ciphertextBytes
    ) {
      throw new Error('MLS attachment ciphertext size changed before upload');
    }
    type UploadedPart = {
      partNumber: number;
      eTag: string;
      ciphertextBytes: number;
      ciphertextSha256: string;
    };
    const mlsRequestIdentity = {
      peerAccountId: input.peerAccountId,
      deviceId: input.deviceId,
    };
    let existingParts: UploadedPart[] = [];
    try {
      const resumed = await this.request<{
        upload: {
          state?: 'available';
          attachmentId: string;
          ciphertextBytes: number;
          ciphertextSha256: string;
          parts: UploadedPart[];
        };
      }>(
        `/enterprise/attachments/${encodeURIComponent(manifest.id)}/resume?${new URLSearchParams(mlsRequestIdentity).toString()}`,
      );
      if (
        resumed.upload.attachmentId !== manifest.id ||
        resumed.upload.ciphertextBytes !== manifest.ciphertextBytes ||
        resumed.upload.ciphertextSha256 !== manifest.ciphertextSha256 ||
        !Array.isArray(resumed.upload.parts)
      ) {
        throw new Error('MLS attachment resume metadata is invalid');
      }
      if (resumed.upload.state === 'available') {
        return manifest.object;
      }
      existingParts = resumed.upload.parts;
    } catch (error) {
      if (!(error instanceof EnterpriseRequestError) || error.status !== 404) {
        throw error;
      }
      const initialized = await this.request<{
        upload: { attachmentId: string };
      }>('/enterprise/attachments/uploads', {
        method: 'POST',
        body: JSON.stringify({
          ...mlsRequestIdentity,
          attachmentId: manifest.id,
          ciphertextBytes: manifest.ciphertextBytes,
          ciphertextSha256: manifest.ciphertextSha256,
          mlsBinding: manifest.binding,
          authorizedDevices: input.authorizedDevices,
        }),
      });
      if (initialized.upload.attachmentId !== manifest.id) {
        throw new Error('MLS attachment upload initialization is invalid');
      }
    }
    const partBytes = 5 * 1024 * 1024;
    const partCount = Math.ceil(manifest.ciphertextBytes / partBytes);
    const persisted = new Map(
      existingParts.map((part) => [part.partNumber, part]),
    );
    if (
      existingParts.length > partCount ||
      persisted.size !== existingParts.length ||
      existingParts.some(
        (part) =>
          !Number.isSafeInteger(part.partNumber) ||
          part.partNumber < 1 ||
          part.partNumber > partCount ||
          typeof part.eTag !== 'string' ||
          !part.eTag ||
          part.eTag.length > 512 ||
          !Number.isSafeInteger(part.ciphertextBytes) ||
          part.ciphertextBytes < 1 ||
          !/^[0-9a-f]{64}$/.test(part.ciphertextSha256),
      )
    ) {
      throw new Error('MLS attachment resume parts are invalid');
    }
    const completed: UploadedPart[] = [];
    const overallDigest = createHash('sha256');
    const file = await fs.promises.open(input.ciphertextPath, 'r');
    try {
      for (let index = 0; index < partCount; index += 1) {
        const partNumber = index + 1;
        const length = Math.min(
          partBytes,
          manifest.ciphertextBytes - index * partBytes,
        );
        const chunk = Buffer.allocUnsafe(length);
        let offset = 0;
        try {
          while (offset < length) {
            const result = await file.read(
              chunk,
              offset,
              length - offset,
              index * partBytes + offset,
            );
            if (result.bytesRead === 0) {
              throw new Error('MLS attachment ciphertext ended unexpectedly');
            }
            offset += result.bytesRead;
          }
          overallDigest.update(chunk);
          const checksum = createHash('sha256').update(chunk).digest('hex');
          const previous = persisted.get(partNumber);
          if (
            previous &&
            previous.ciphertextBytes === length &&
            previous.ciphertextSha256 === checksum &&
            previous.eTag
          ) {
            completed.push(previous);
            continue;
          }
          const presigned = await this.request<{
            request: {
              method: 'PUT';
              url: string;
              expiresInSeconds: number;
              requiredHeaders: Record<string, string>;
            };
          }>(
            `/enterprise/attachments/${encodeURIComponent(manifest.id)}/parts/${partNumber}/presign`,
            {
              method: 'POST',
              body: JSON.stringify({
                ...mlsRequestIdentity,
                ciphertextBytes: length,
                ciphertextSha256: checksum,
              }),
            },
          );
          if (
            presigned.request.method !== 'PUT' ||
            !presigned.request.url ||
            !presigned.request.requiredHeaders
          ) {
            throw new Error('MLS attachment presigned upload is invalid');
          }
          const uploaded = await this.fetchImpl(presigned.request.url, {
            method: 'PUT',
            headers: presigned.request.requiredHeaders,
            body: chunk,
          });
          if (!uploaded.ok) {
            throw new Error(
              `MLS attachment part upload failed: ${uploaded.status}`,
            );
          }
          const eTag = uploaded.headers.get('etag')?.trim() ?? '';
          if (!eTag || eTag.length > 512) {
            throw new Error('MLS attachment upload ETag is invalid');
          }
          const part = {
            partNumber,
            eTag,
            ciphertextBytes: length,
            ciphertextSha256: checksum,
          };
          await this.request(
            `/enterprise/attachments/${encodeURIComponent(manifest.id)}/parts`,
            {
              method: 'POST',
              body: JSON.stringify({ ...mlsRequestIdentity, ...part }),
            },
          );
          completed.push(part);
        } finally {
          chunk.fill(0);
        }
      }
    } finally {
      await file.close();
    }
    if (overallDigest.digest('hex') !== manifest.ciphertextSha256) {
      throw new Error('MLS attachment ciphertext checksum changed before upload');
    }
    const finalized = await this.request<{
      attachment: {
        id: string;
        ciphertextBytes: number;
        ciphertextSha256: string;
      };
    }>(
      `/enterprise/attachments/${encodeURIComponent(manifest.id)}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({ ...mlsRequestIdentity, parts: completed }),
      },
      { timeoutMs: 60_000 },
    );
    if (
      finalized.attachment.id !== manifest.object.id ||
      finalized.attachment.ciphertextBytes !== manifest.object.ciphertextBytes ||
      finalized.attachment.ciphertextSha256 !==
        manifest.object.ciphertextSha256
    ) {
      throw new Error('MLS attachment completion metadata is invalid');
    }
    return manifest.object;
  }

  async downloadMlsAttachmentObject(input: {
    peerAccountId: string;
    deviceId: string;
    manifest: EnterpriseMlsAttachmentManifest;
    ciphertextPath: string;
  }): Promise<EnterpriseMlsAttachmentManifest['object']> {
    await this.requireMlsTransportAccount();
    await this.assertCompatibleServer(this.serverUrl, [
      'e2ee_mls_transport_v1',
      'e2ee_attachment_objects_v1',
    ]);
    const manifest = validateEnterpriseMlsAttachmentManifest(input.manifest);
    const query = new URLSearchParams({
      peerAccountId: input.peerAccountId,
      deviceId: input.deviceId,
    });
    const response = await this.request<{
      attachment: {
        kind: 'presigned' | 'ciphertext';
        ciphertextBytes: number;
        ciphertextSha256: string;
        encryption: string;
        ciphertext?: string;
        request?: {
          method: 'GET';
          url: string;
          expiresInSeconds: number;
          requiredHeaders: Record<string, string>;
        };
      };
    }>(
      `/enterprise/attachments/${encodeURIComponent(manifest.id)}/download?${query.toString()}`,
      {},
      { timeoutMs: 60_000 },
    );
    const attachment = response.attachment;
    if (
      attachment.encryption !== 'mls-client-v1' ||
      attachment.ciphertextBytes !== manifest.object.ciphertextBytes ||
      attachment.ciphertextSha256 !== manifest.object.ciphertextSha256
    ) {
      throw new Error('MLS attachment download metadata is invalid');
    }
    await fs.promises.mkdir(path.dirname(input.ciphertextPath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${input.ciphertextPath}.${randomUUID()}.tmp`;
    const digest = createHash('sha256');
    let written = 0;
    let target: fs.promises.FileHandle | null = null;
    const writeChunk = async (chunk: Buffer): Promise<void> => {
      written += chunk.length;
      if (written > manifest.ciphertextBytes) {
        throw new Error('MLS attachment download exceeds manifest size');
      }
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await target!.write(
          chunk,
          offset,
          chunk.length - offset,
        );
        if (result.bytesWritten === 0) {
          throw new Error('MLS attachment download write made no progress');
        }
        offset += result.bytesWritten;
      }
    };
    try {
      target = await fs.promises.open(temporary, 'wx', 0o600);
      if (attachment.kind === 'presigned') {
        if (
          attachment.request?.method !== 'GET' ||
          !attachment.request.url ||
          !attachment.request.requiredHeaders
        ) {
          throw new Error('MLS attachment presigned download is invalid');
        }
        const downloaded = await this.fetchImpl(attachment.request.url, {
          method: 'GET',
          headers: attachment.request.requiredHeaders,
        });
        if (!downloaded.ok || !downloaded.body) {
          throw new Error(
            `MLS attachment object download failed: ${downloaded.status}`,
          );
        }
        const reader = downloaded.body.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = Buffer.from(next.value);
            try {
              await writeChunk(chunk);
            } finally {
              chunk.fill(0);
            }
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        if (typeof attachment.ciphertext !== 'string') {
          throw new Error('MLS attachment ciphertext is unavailable');
        }
        const chunk = Buffer.from(attachment.ciphertext, 'base64');
        try {
          if (chunk.toString('base64') !== attachment.ciphertext) {
            throw new Error('MLS attachment ciphertext encoding is invalid');
          }
          await writeChunk(chunk);
        } finally {
          chunk.fill(0);
        }
      }
      if (
        written !== manifest.ciphertextBytes ||
        digest.digest('hex') !== manifest.ciphertextSha256
      ) {
        throw new Error('MLS attachment download integrity check failed');
      }
      await target.sync();
      await target.close();
      target = null;
      await fs.promises.rename(temporary, input.ciphertextPath);
      await fs.promises.chmod(input.ciphertextPath, 0o600).catch(() => undefined);
      return manifest.object;
    } catch (error) {
      await target?.close().catch(() => undefined);
      target = null;
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async requireMlsTransportAccount(): Promise<EnterpriseAccount> {
    if (!this.token) {
      throw new Error('enterprise session has expired; please sign in again');
    }
    await this.assertCompatibleServer(this.serverUrl, [
      'e2ee_mls_transport_v1',
    ]);
    if (!this.currentAccount) {
      throw new Error('enterprise account identity is unavailable');
    }
    return this.currentAccount;
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

  /**
   * 取得绑定当前企业账号的短期 Edge 凭据。Control 与企业服务器只参与换取
   * 凭据，不接收聊天正文；企业登录 token 不会离开 Electron main。
   */
  async getManagedModelGatewayAccess(): Promise<ManagedModelGatewayAccess> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'managed_model_gateway_v1',
    ]);
    const response = await this.request<{
      gateway?: Partial<ManagedModelGatewayAccess>;
    }>('/enterprise/model-gateway/access-token', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const gateway = response.gateway;
    const expiresAtMs = Date.parse(gateway?.expiresAt ?? '');
    if (
      typeof gateway?.baseUrl !== 'string' ||
      typeof gateway.accessToken !== 'string' ||
      gateway.accessToken.length < 32 ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= Date.now() ||
      !Array.isArray(gateway.allowedModels) ||
      gateway.allowedModels.length < 1 ||
      gateway.allowedModels.some(
        (model) => typeof model !== 'string' || !model.startsWith('otto:'),
      )
    ) {
      throw new Error('企业模型网关返回了无效的短期凭据');
    }
    let endpoint: URL;
    try {
      endpoint = new URL(gateway.baseUrl);
    } catch {
      throw new Error('企业模型网关地址无效');
    }
    const loopback =
      endpoint.protocol === 'http:' &&
      ['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname);
    if (
      (endpoint.protocol !== 'https:' && !loopback) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !/^\/v1\/?$/u.test(endpoint.pathname)
    ) {
      throw new Error('企业模型网关地址不符合安全要求');
    }
    return {
      baseUrl: `${endpoint.origin}/v1`,
      accessToken: gateway.accessToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
      allowedModels: [...new Set(gateway.allowedModels)],
    };
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
        ...((init.method ?? 'GET').toUpperCase() === 'GET'
          ? {}
          : { 'x-otto-idempotency-key': `desktop:${randomUUID()}` }),
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
    legalDocuments: EnterpriseLegalDocumentReference[];
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

  async acceptCurrentLegalDocuments(
    documents: EnterpriseLegalDocumentReference[],
  ): Promise<EnterpriseDataGovernanceProfile> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/privacy/accept', {
      method: 'POST',
      body: JSON.stringify({ accepted: true, documents }),
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
  async getOrganizationView(
    organizationId?: string,
  ): Promise<EnterpriseOrganizationView> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    const query = organizationId
      ? `?organizationId=${encodeURIComponent(organizationId)}`
      : '';
    return this.request(`/enterprise/organization/view${query}`);
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

  async getDeploymentUpdatePolicy(input: {
    distributionId: string;
    currentVersion: string;
  }): Promise<EnterpriseUpdatePolicyResult> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'signed_update_policy_v1',
    ]);
    return this.request('/enterprise/deployment/update-policy', {
      method: 'POST',
      body: JSON.stringify(input),
    });
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
    const registered = crypto.verifyLocalDeviceRegistration(
      local,
      response.device,
    );
    if (registered.revokedAt) {
      throw new Error(
        'this E2EE device was revoked; recover or create a new trusted device',
      );
    }
    return registered;
  }

  private async getAndPinE2eeKeyTransparency(
    accountId: string,
  ): Promise<EnterpriseE2eeKeyTransparencyView> {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const query = new URLSearchParams({ accountId });
    const view = (
      await this.request<{
        transparency: EnterpriseE2eeKeyTransparencyView;
      }>(`/enterprise/e2ee/key-transparency?${query.toString()}`)
    ).transparency;
    return crypto.verifyAndPinKeyTransparency({
      serverScope,
      organizationId: account.organizationId,
      view,
    });
  }

  private async verifiedE2eeDeviceDirectory(
    accountIds: string[],
    options: { includePending: boolean; includeRevoked: boolean },
  ): Promise<EnterpriseE2eeDeviceBundle[]> {
    const { crypto, account } = this.requireE2eeContext();
    await this.registerLocalE2eeDevice();
    const uniqueAccountIds = [...new Set(accountIds)];
    const transparency = await Promise.all(
      uniqueAccountIds.map((accountId) =>
        this.getAndPinE2eeKeyTransparency(accountId),
      ),
    );
    const query = new URLSearchParams();
    for (const accountId of uniqueAccountIds)
      query.append('accountId', accountId);
    query.set('includeRevoked', String(options.includeRevoked));
    query.set('includePending', String(options.includePending));
    const devices = (
      await this.request<{ devices: EnterpriseE2eeDeviceBundle[] }>(
        `/enterprise/e2ee/devices?${query.toString()}`,
      )
    ).devices;
    return crypto.verifyDeviceDirectory({
      organizationId: account.organizationId,
      devices,
      transparency,
      ...options,
    });
  }

  async ensureE2eeDeviceReady(): Promise<EnterpriseE2eeDeviceBundle> {
    if (!this.token)
      throw new Error('enterprise session has expired; please sign in again');
    await this.assertCompatibleServer(this.serverUrl, [
      'e2ee_private_messages_v1',
    ]);
    const device = await this.registerLocalE2eeDevice();
    await this.getAndPinE2eeKeyTransparency(device.accountId);
    return device;
  }

  private async e2eeDevicesForConversation(
    peerAccountId: string,
  ): Promise<EnterpriseE2eeDeviceBundle[]> {
    const { account } = this.requireE2eeContext();
    return this.verifiedE2eeDeviceDirectory([account.id, peerAccountId], {
      includePending: false,
      includeRevoked: false,
    });
  }

  private decryptE2eeMessage(
    message: EnterpriseE2eeWireMessage,
    trustedDevices: EnterpriseE2eeDeviceBundle[],
  ): EnterpriseDirectMessage {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const senderDevice = trustedDevices.find(
      (device) =>
        device.accountId === message.senderAccountId &&
        device.deviceId === message.senderDeviceId,
    );
    if (
      !senderDevice ||
      senderDevice.approvalState !== 'approved' ||
      senderDevice.identitySigningPublicKey !==
        message.senderIdentitySigningPublicKey
    ) {
      throw new Error(
        'E2EE message sender key is not trusted by the pinned directory',
      );
    }
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
    const devices = await this.verifiedE2eeDeviceDirectory([account.id], {
      includeRevoked,
      includePending: true,
    });
    const localDeviceId = this.requireE2eeContext().crypto.localDevice(
      this.serverUrl,
      account.id,
    ).deviceId;
    return devices.map((device) => ({
      ...device,
      isCurrentDevice: device.deviceId === localDeviceId,
    }));
  }

  async getOwnE2eeKeyTransparency(): Promise<EnterpriseE2eeKeyTransparencyView> {
    if (!this.token)
      throw new Error('enterprise session has expired; please sign in again');
    await this.assertCompatibleServer(this.serverUrl, [
      'e2ee_private_messages_v1',
      'e2ee_device_trust_v1',
    ]);
    const { account } = this.requireE2eeContext();
    await this.registerLocalE2eeDevice();
    return this.getAndPinE2eeKeyTransparency(account.id);
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
    const approved = (
      await this.request<{ device: EnterpriseE2eeDeviceBundle }>(
        `/enterprise/e2ee/devices/${encodeURIComponent(deviceId)}/approve`,
        {
          method: 'POST',
          body: JSON.stringify(approval),
        },
      )
    ).device;
    await this.getAndPinE2eeKeyTransparency(account.id);
    return approved;
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
    await this.getAndPinE2eeKeyTransparency(account.id);
  }

  private async federationIdentity(): Promise<{
    deploymentId: string;
    principalId: string;
  }> {
    await this.assertCompatibleServer(this.serverUrl, [
      'federation_chat_v1',
      'e2ee_private_messages_v1',
    ]);
    const identity = (
      await this.request<{
        identity: {
          deploymentId: string;
          principalId: string;
          capabilities: string[];
        };
      }>('/enterprise/federation/identity')
    ).identity;
    const account = this.requireE2eeContext().account;
    if (
      !identity ||
      typeof identity.deploymentId !== 'string' ||
      identity.principalId !== account.id ||
      !identity.capabilities?.includes('chat.e2ee')
    ) {
      throw new Error('联邦身份与当前登录账号不匹配');
    }
    return identity;
  }

  private async localFederationIdentityCard(): Promise<
    EnterpriseFederationIdentityCard
  > {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const identity = await this.federationIdentity();
    const devices = await this.verifiedE2eeDeviceDirectory([account.id], {
      includePending: false,
      includeRevoked: true,
    });
    const transparency = await this.getAndPinE2eeKeyTransparency(account.id);
    const identityEntry = transparency.entries.find(
      (entry) => entry.event === 'bootstrap_approved',
    );
    const identityDevice = devices.find(
      (device) => device.deviceId === identityEntry?.deviceId,
    );
    const activeDevices = devices.filter((device) => device.revokedAt === null);
    if (!identityDevice || activeDevices.length === 0) {
      throw new Error(
        'federation E2EE identity directory has no trusted root or active device',
      );
    }
    return crypto.createFederationIdentityCard({
      ...identity,
      displayName: account.name,
      devices: activeDevices,
      identityDevice,
      directorySequence: transparency.headSequence,
      directoryHash: transparency.headHash,
      keyring: { serverScope, accountId: account.id },
    });
  }

  async exportFederationContactCode(): Promise<string> {
    const card = await this.localFederationIdentityCard();
    return FEDERATION_CONTACT_CODE_PREFIX + Buffer.from(
      JSON.stringify(card),
      'utf8',
    ).toString('base64url');
  }

  async saveFederationContactCode(
    code: string,
  ): Promise<EnterpriseFederationContact> {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const card = crypto.verifyFederationIdentityCard(
      parseFederationContactCode(code),
    );
    const localIdentity = await this.federationIdentity();
    if (
      card.deploymentId === localIdentity.deploymentId &&
      card.principalId === localIdentity.principalId
    ) {
      throw new Error('不能把自己的联邦联系码添加为联系人');
    }
    const existing = (await this.listFederationContacts()).find(
      (contact) => contact.identity === `${card.deploymentId}:${card.principalId}`,
    );
    if (existing) {
      crypto.pinFederationContact({
        localServerScope: serverScope,
        localAccountId: account.id,
        contactId: existing.id,
        card,
      });
    }
    const contact = (
      await this.request<{ contact: EnterpriseFederationWireContact }>(
        '/enterprise/federation/contacts',
        {
          method: 'POST',
          body: JSON.stringify({
            remoteDeploymentId: card.deploymentId,
            remotePrincipalId: card.principalId,
            displayName: card.displayName,
          }),
        },
      )
    ).contact;
    const trust = existing
      ? crypto.federationContactTrust({
          localServerScope: serverScope,
          localAccountId: account.id,
          contactId: contact.id,
        })!
      : crypto.pinFederationContact({
          localServerScope: serverScope,
          localAccountId: account.id,
          contactId: contact.id,
          card,
        });
    return {
      ...contact,
      trustState: trust.verifiedAt ? 'verified' : 'unverified',
      keyFingerprint: enterpriseFederationIdentityKeyFingerprint(trust.card),
    };
  }

  async listFederationContacts(): Promise<EnterpriseFederationContact[]> {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    await this.federationIdentity();
    const contacts = (
      await this.request<{ contacts: EnterpriseFederationWireContact[] }>(
        '/enterprise/federation/contacts',
      )
    ).contacts;
    return contacts.map((contact) => {
      const trust = crypto.federationContactTrust({
        localServerScope: serverScope,
        localAccountId: account.id,
        contactId: contact.id,
      });
      return {
        ...contact,
        trustState: trust
          ? trust.verifiedAt ? 'verified' : 'unverified'
          : 'missing',
        keyFingerprint: trust
          ? enterpriseFederationIdentityKeyFingerprint(trust.card)
          : null,
      };
    });
  }

  async removeFederationContact(contactId: string): Promise<void> {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    await this.request(
      `/enterprise/federation/contacts/${encodeURIComponent(contactId)}`,
      { method: 'DELETE' },
    );
    crypto.removeFederationContact({
      localServerScope: serverScope,
      localAccountId: account.id,
      contactId,
    });
  }

  async federationContactVerification(
    contactId: string,
  ): Promise<EnterpriseE2eeDeviceVerification & {
    verifiedAt: string | null;
  }> {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const trust = crypto.federationContactTrust({
      localServerScope: serverScope,
      localAccountId: account.id,
      contactId,
    });
    if (!trust) throw new Error('请先导入对方的联邦联系码');
    const localCard = await this.localFederationIdentityCard();
    return {
      ...enterpriseFederationContactVerification(localCard, trust.card),
      verifiedAt: trust.verifiedAt,
    };
  }

  async verifyFederationContact(
    contactId: string,
  ): Promise<EnterpriseE2eeDeviceVerification & {
    verifiedAt: string | null;
  }> {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    crypto.verifyFederationContact({
      localServerScope: serverScope,
      localAccountId: account.id,
      contactId,
    });
    return this.federationContactVerification(contactId);
  }

  async listFederationMessages(
    contactId: string,
    options: { markRead?: boolean } = {},
  ): Promise<EnterpriseFederatedDirectMessage[]> {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const identity = await this.federationIdentity();
    const contact = (await this.listFederationContacts())
      .find((item) => item.id === contactId);
    if (!contact) throw new Error('联邦联系人不存在');
    const localGlobalId = `${identity.deploymentId}:${identity.principalId}`;
    const remoteGlobalId = contact.identity;
    const conversationId = federationConversationId({
      localDeploymentId: identity.deploymentId,
      localPrincipalId: identity.principalId,
      remoteDeploymentId: contact.remoteDeploymentId,
      remotePrincipalId: contact.remotePrincipalId,
    });
    const wireMessages = (
      await this.request<{ messages: EnterpriseFederationWireMessage[] }>(
        `/enterprise/federation/conversations/${encodeURIComponent(contactId)}/messages`,
      )
    ).messages;
    const decrypted: EnterpriseFederatedDirectMessage[] = [];
    for (const raw of wireMessages) {
      const payload = parseFederationEncryptedPayload(raw.ciphertext);
      const senderCard = crypto.verifyFederationIdentityCard(payload.senderCard);
      const expectedSender = raw.direction === 'inbound'
        ? remoteGlobalId
        : localGlobalId;
      if (
        `${senderCard.deploymentId}:${senderCard.principalId}` !== expectedSender ||
        raw.routing.conversationId !== conversationId ||
        payload.message.id !== raw.messageId ||
        payload.message.senderAccountId !== expectedSender ||
        payload.message.recipientAccountId !== (
          raw.direction === 'inbound' ? localGlobalId : remoteGlobalId
        ) ||
        payload.message.senderDeviceId !== senderCard.device.deviceId ||
        payload.message.senderIdentitySigningPublicKey !==
          senderCard.device.identitySigningPublicKey
      ) {
        throw new Error('联邦私聊消息的身份或会话绑定无效');
      }
      let trust: EnterpriseFederationContactTrust;
      if (raw.direction === 'inbound') {
        trust = crypto.pinFederationContact({
          localServerScope: serverScope,
          localAccountId: account.id,
          contactId,
          card: senderCard,
        });
      } else {
        const ownCard = await this.localFederationIdentityCard();
        if (
          enterpriseFederationIdentityKeyFingerprint(ownCard) !==
          enterpriseFederationIdentityKeyFingerprint(senderCard)
        ) {
          throw new Error('本机联邦发送身份已变化，请重置安全会话');
        }
        const pinnedTrust = crypto.federationContactTrust({
          localServerScope: serverScope,
          localAccountId: account.id,
          contactId,
        });
        if (!pinnedTrust) {
          throw new Error('联邦联系人信任记录不存在，请重新导入联系码');
        }
        trust = pinnedTrust;
      }
      const plain = crypto.decryptMessage({
        serverScope: ENTERPRISE_FEDERATION_E2EE_SCOPE,
        organizationId: conversationId,
        accountId: localGlobalId,
        keyring: { serverScope, accountId: account.id },
        message: payload.message,
      });
      decrypted.push({
        id: plain.id,
        senderAccountId: raw.direction === 'inbound' ? contact.identity : account.id,
        recipientAccountId: raw.direction === 'inbound' ? account.id : contact.identity,
        content: plain.content,
        createdAt: plain.createdAt,
        readAt: raw.readAt,
        attachments: plain.attachments,
        e2ee: true,
        e2eeProtocol: 'device-envelope-v1',
        contentType: plain.contentType,
        inReplyToMessageId: plain.inReplyToMessageId,
        federated: true,
        contactId,
        federationMessageType: raw.type,
        federationA2aGrantId: raw.routing.a2aGrantId,
        federationA2aScope: raw.routing.a2aScope,
        direction: raw.direction,
        deliveryStatus: raw.deliveryStatus,
        trustState: trust.verifiedAt ? 'verified' : 'unverified',
      });
      if (
        options.markRead !== false &&
        raw.direction === 'inbound' && raw.readAt === null
      ) {
        await this.request(
          `/enterprise/federation/conversations/${encodeURIComponent(contactId)}` +
            `/messages/${encodeURIComponent(raw.messageId)}/read`,
          { method: 'POST' },
        );
      }
    }
    return decrypted;
  }

  async sendFederationMessage(
    contactId: string,
    content: string,
    attachments: EnterpriseDirectMessageAttachmentUpload[] = [],
    options: {
      type?: 'chat.message' | 'a2a.request' | 'a2a.response';
      messageId?: string;
      inReplyTo?: string;
      a2aGrantId?: string;
      a2aScope?: string;
    } = {},
  ): Promise<EnterpriseFederatedDirectMessage> {
    if (!content.trim() && attachments.length === 0) {
      throw new Error('请输入消息或添加附件');
    }
    if (attachments.length > 6) throw new Error('每条消息最多发送 6 个附件');
    const federationMessageType = options.type ?? 'chat.message';
    if (federationMessageType !== 'chat.message' && attachments.length > 0) {
      throw new Error('A2A 请求和回复不能携带附件');
    }
    if (
      federationMessageType === 'a2a.request' &&
      (!options.a2aGrantId || !options.a2aScope)
    ) {
      throw new Error('A2A 请求缺少一次性授权');
    }
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const identity = await this.federationIdentity();
    const contact = (await this.listFederationContacts())
      .find((item) => item.id === contactId);
    if (!contact) throw new Error('联邦联系人不存在');
    const trust = crypto.federationContactTrust({
      localServerScope: serverScope,
      localAccountId: account.id,
      contactId,
    });
    if (!trust) throw new Error('请先导入对方的联邦联系码');
    const localGlobalId = `${identity.deploymentId}:${identity.principalId}`;
    const conversationId = federationConversationId({
      localDeploymentId: identity.deploymentId,
      localPrincipalId: identity.principalId,
      remoteDeploymentId: contact.remoteDeploymentId,
      remotePrincipalId: contact.remotePrincipalId,
    });
    const senderCard = await this.localFederationIdentityCard();
    const protocol = e2eeProtocolMetadata(content);
    const messageId = options.messageId ?? randomUUID();
    const temporaryDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'otto-federation-attachment-'),
    );
    try {
      const prepared: EnterpriseE2eePreparedExternalAttachment[] = [];
      for (const [index, attachment] of attachments.entries()) {
        let sourcePath = attachment.sourcePath;
        if (!sourcePath && attachment.data) {
          sourcePath = path.join(temporaryDirectory, `plain-${index}`);
          const body = Buffer.from(attachment.data, 'base64');
          if (body.length !== attachment.size) {
            throw new Error('附件内容与声明大小不一致');
          }
          await fs.promises.writeFile(sourcePath, body, { flag: 'wx' });
        }
        if (!sourcePath) throw new Error('附件源文件不可用');
        prepared.push(await crypto.encryptExternalAttachmentFile({
          messageId,
          sourcePath,
          ciphertextPath: path.join(temporaryDirectory, `cipher-${index}.bin`),
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          size: attachment.size,
        }));
      }
      const encrypted = crypto.encryptMessage({
        serverScope: ENTERPRISE_FEDERATION_E2EE_SCOPE,
        organizationId: conversationId,
        senderAccountId: localGlobalId,
        recipientAccountId: contact.identity,
        content,
        contentType: protocol.contentType,
        inReplyToMessageId: options.inReplyTo ?? protocol.inReplyToMessageId,
        devices: [
          ...enterpriseFederationIdentityCardDevices(senderCard),
          ...enterpriseFederationIdentityCardDevices(trust.card),
        ],
        keyring: { serverScope, accountId: account.id },
        externalAttachments: prepared,
        messageId,
      });
      for (const item of prepared) {
        const response = await this.request<{
          upload: {
            method: 'PUT';
            url: string;
            headers: Record<string, string>;
          } | null;
        }>(
          `/enterprise/federation/conversations/${encodeURIComponent(contactId)}` +
            '/attachments/uploads',
          {
            method: 'POST',
            body: JSON.stringify({
              attachmentId: item.metadata.id,
              ciphertextBytes: item.metadata.ciphertextSize,
              ciphertextSha256: item.metadata.ciphertextSha256,
            }),
          },
        );
        if (response.upload) {
          const uploaded = await this.fetchImpl(response.upload.url, {
            method: response.upload.method,
            headers: response.upload.headers,
            body: fs.createReadStream(item.ciphertextPath) as never,
            duplex: 'half',
          } as RequestInit & { duplex: 'half' });
          if (!uploaded.ok) {
            throw new Error(`联邦附件上传失败（HTTP ${uploaded.status}）`);
          }
        }
        await this.request(
          `/enterprise/federation/conversations/${encodeURIComponent(contactId)}` +
            `/attachments/${encodeURIComponent(item.metadata.id)}/complete`,
          { method: 'POST' },
        );
      }
      const createdAt = new Date().toISOString();
      const message: EnterpriseE2eeWireMessage = {
        id: encrypted.messageId,
        senderAccountId: localGlobalId,
        recipientAccountId: contact.identity,
        senderDeviceId: encrypted.senderDeviceId,
        senderIdentitySigningPublicKey: senderCard.device.identitySigningPublicKey,
        protocolVersion: encrypted.protocolVersion,
        contentType: encrypted.contentType,
        inReplyToMessageId: encrypted.inReplyToMessageId,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        signature: encrypted.signature,
        envelopes: encrypted.envelopes,
        createdAt,
        readAt: null,
        attachments: prepared.map((item) => ({
          id: item.metadata.id,
          ciphertextSize: item.metadata.ciphertextSize,
          nonce: item.metadata.nonce,
        })),
      };
      const opaque = Buffer.from(JSON.stringify({
        v: 1,
        senderCard,
        message,
      } satisfies EnterpriseFederationEncryptedPayload), 'utf8').toString('base64url');
      await this.request(
        `/enterprise/federation/conversations/${encodeURIComponent(contactId)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            messageId: encrypted.messageId,
            ciphertext: opaque,
            type: federationMessageType,
            inReplyTo: options.inReplyTo ?? encrypted.inReplyToMessageId,
            a2aGrantId: options.a2aGrantId,
            a2aScope: options.a2aScope,
            attachmentIds: prepared.map((item) => item.metadata.id),
          }),
        },
      );
      const plain = crypto.decryptMessage({
        serverScope: ENTERPRISE_FEDERATION_E2EE_SCOPE,
        organizationId: conversationId,
        accountId: localGlobalId,
        keyring: { serverScope, accountId: account.id },
        message,
      });
      return {
        id: plain.id,
        senderAccountId: account.id,
        recipientAccountId: contact.identity,
        content: plain.content,
        createdAt: plain.createdAt,
        readAt: null,
        attachments: plain.attachments,
        e2ee: true,
        e2eeProtocol: 'device-envelope-v1',
        contentType: plain.contentType,
        inReplyToMessageId: plain.inReplyToMessageId,
        federated: true,
        contactId,
        federationMessageType,
        federationA2aGrantId: options.a2aGrantId,
        federationA2aScope: options.a2aScope,
        direction: 'outbound',
        deliveryStatus: 'queued',
        trustState: trust.verifiedAt ? 'verified' : 'unverified',
      };
    } finally {
      await fs.promises.rm(temporaryDirectory, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }

  private async markFederationMessageRead(
    contactId: string,
    messageId: string,
  ): Promise<void> {
    await this.request(
      `/enterprise/federation/conversations/${encodeURIComponent(contactId)}` +
        `/messages/${encodeURIComponent(messageId)}/read`,
      { method: 'POST' },
    );
  }

  async listFederationAtoaTasks(): Promise<EnterpriseFederationAtoaTask[]> {
    const tasks: EnterpriseFederationAtoaTask[] = [];
    const contacts = await this.listFederationContacts();
    for (const contact of contacts) {
      if (contact.trustState !== 'verified') continue;
      const messages = await this.listFederationMessages(contact.id, {
        markRead: false,
      });
      tasks.push(...deriveFederationAtoaTasks({ contact, messages }));
    }
    return tasks;
  }

  async approveFederationAtoaProposal(input: {
    contactId: string;
    messageId: string;
    grantedSources: AtoaContextSource[];
  }): Promise<EnterpriseFederatedDirectMessage> {
    const contact = (await this.listFederationContacts()).find(
      (item) => item.id === input.contactId,
    );
    if (!contact || contact.trustState !== 'verified') {
      throw new Error('请先核验跨服务器联系人身份');
    }
    const messages = await this.listFederationMessages(input.contactId, {
      markRead: false,
    });
    const proposal = messages.find((message) =>
      message.id === input.messageId &&
      message.direction === 'inbound' &&
      message.federationMessageType === 'chat.message');
    const parsed = proposal ? parseAtoaMessage(proposal.content) : null;
    if (!proposal || parsed?.kind !== 'request') {
      throw new Error('跨服务器 A2A 请求不存在或已失效');
    }
    const existing = messages.find((message) => {
      const decision = parseFederationAtoaDecision(message.content);
      return message.direction === 'outbound' &&
        decision?.requestMessageId === proposal.id;
    });
    if (existing) return existing;

    const grantedSources = [
      ...new Set(input.grantedSources),
    ].filter((source): source is AtoaContextSource =>
      source === 'current_chat' ||
      source === 'enterprise_knowledge' ||
      source === 'work_logs' ||
      source === 'schedules');
    if (grantedSources.length === 0) {
      throw new Error('请至少选择一项本次允许读取的资料');
    }
    const scope = federationAtoaScope(proposal.id, proposal.content);
    const response = await this.request<{
      grant: { id: string; expiresAt: string };
    }>(
      `/enterprise/federation/conversations/${encodeURIComponent(input.contactId)}` +
        '/a2a/grants',
      {
        method: 'POST',
        body: JSON.stringify({
          scopes: [scope],
          expiresInMs: 10 * 60_000,
        }),
      },
    );
    const decisionContent = buildFederationAtoaDecision({
      status: 'approved',
      requestId: parsed.payload.id,
      requestMessageId: proposal.id,
      grantId: response.grant.id,
      scope,
      expiresAt: response.grant.expiresAt,
      grantedSources,
    });
    const decision = await this.sendFederationMessage(
      input.contactId,
      decisionContent,
      [],
      {
        messageId: `fa2a_decision_${createHash('sha256')
          .update(proposal.id, 'utf8')
          .digest('hex')
          .slice(0, 40)}`,
        inReplyTo: proposal.id,
      },
    );
    await this.markFederationMessageRead(input.contactId, proposal.id);
    return decision;
  }

  async denyFederationAtoaProposal(input: {
    contactId: string;
    messageId: string;
  }): Promise<EnterpriseFederatedDirectMessage> {
    const messages = await this.listFederationMessages(input.contactId, {
      markRead: false,
    });
    const proposal = messages.find((message) =>
      message.id === input.messageId &&
      message.direction === 'inbound' &&
      message.federationMessageType === 'chat.message');
    const parsed = proposal ? parseAtoaMessage(proposal.content) : null;
    if (!proposal || parsed?.kind !== 'request') {
      throw new Error('跨服务器 A2A 请求不存在或已失效');
    }
    const decision = await this.sendFederationMessage(
      input.contactId,
      buildFederationAtoaDecision({
        status: 'denied',
        requestId: parsed.payload.id,
        requestMessageId: proposal.id,
      }),
      [],
      {
        messageId: `fa2a_denied_${createHash('sha256')
          .update(proposal.id, 'utf8')
          .digest('hex')
          .slice(0, 40)}`,
        inReplyTo: proposal.id,
      },
    );
    await this.markFederationMessageRead(input.contactId, proposal.id);
    return decision;
  }

  async dispatchFederationAtoaGrant(input: {
    contactId: string;
    decisionMessageId: string;
  }): Promise<EnterpriseFederatedDirectMessage> {
    const messages = await this.listFederationMessages(input.contactId, {
      markRead: false,
    });
    const decisionMessage = messages.find((message) =>
      message.id === input.decisionMessageId &&
      message.direction === 'inbound');
    const decision = decisionMessage
      ? parseFederationAtoaDecision(decisionMessage.content)
      : null;
    if (!decisionMessage || decision?.status !== 'approved') {
      throw new Error('跨服务器 A2A 授权不存在或已失效');
    }
    if (Date.parse(decision.expiresAt) <= Date.now()) {
      throw new Error('跨服务器 A2A 一次性授权已过期');
    }
    const proposal = messages.find((message) =>
      message.id === decision.requestMessageId &&
      message.direction === 'outbound');
    const parsed = proposal ? parseAtoaMessage(proposal.content) : null;
    if (
      !proposal || parsed?.kind !== 'request' ||
      parsed.payload.id !== decision.requestId ||
      decision.scope !== federationAtoaScope(proposal.id, proposal.content)
    ) {
      throw new Error('A2A 授权与原始问题不匹配');
    }
    const message = await this.sendFederationMessage(
      input.contactId,
      proposal.content,
      [],
      {
        type: 'a2a.request',
        messageId: deterministicFederationAtoaMessageId(
          'request',
          `${decision.grantId}:${proposal.id}`,
        ),
        inReplyTo: proposal.id,
        a2aGrantId: decision.grantId,
        a2aScope: decision.scope,
      },
    );
    await this.markFederationMessageRead(input.contactId, decisionMessage.id);
    return message;
  }

  async respondFederationAtoaRequest(input: {
    contactId: string;
    requestMessageId: string;
    answer: string;
    grantedSources: AtoaContextSource[];
  }): Promise<EnterpriseFederatedDirectMessage> {
    const messages = await this.listFederationMessages(input.contactId, {
      markRead: false,
    });
    const request = messages.find((message) =>
      message.id === input.requestMessageId &&
      message.direction === 'inbound' &&
      message.federationMessageType === 'a2a.request');
    const parsed = request ? parseAtoaMessage(request.content) : null;
    if (!request || parsed?.kind !== 'request') {
      throw new Error('跨服务器 A2A 执行请求不存在');
    }
    const message = await this.sendFederationMessage(
      input.contactId,
      buildAtoaResponse({
        requestId: request.id,
        question: parsed.payload.question,
        answer: input.answer,
        mode: parsed.payload.mode,
        grantedSources: input.grantedSources,
      }),
      [],
      {
        type: 'a2a.response',
        messageId: deterministicFederationAtoaMessageId(
          'response',
          request.id,
        ),
        inReplyTo: request.id,
      },
    );
    await this.markFederationMessageRead(input.contactId, request.id);
    return message;
  }

  async saveFederationMessageAttachment(input: {
    contactId: string;
    messageId: string;
    attachmentId: string;
    destinationPath: string;
  }): Promise<EnterpriseDirectMessageAttachment & { path: string }> {
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const identity = await this.federationIdentity();
    const contact = (await this.listFederationContacts())
      .find((item) => item.id === input.contactId);
    if (!contact) throw new Error('联邦联系人不存在');
    const trust = crypto.federationContactTrust({
      localServerScope: serverScope,
      localAccountId: account.id,
      contactId: input.contactId,
    });
    if (!trust) throw new Error('联邦联系人信任记录不存在');
    const raw = (
      await this.request<{ messages: EnterpriseFederationWireMessage[] }>(
        `/enterprise/federation/conversations/${encodeURIComponent(input.contactId)}/messages`,
      )
    ).messages.find((message) => message.messageId === input.messageId);
    if (
      !raw || raw.direction !== 'inbound' ||
      !(raw.routing.attachmentIds ?? []).includes(input.attachmentId)
    ) {
      throw new Error('只允许下载当前会话收到的联邦附件');
    }
    const payload = parseFederationEncryptedPayload(raw.ciphertext);
    const senderCard = crypto.verifyFederationIdentityCard(payload.senderCard);
    if (
      `${senderCard.deploymentId}:${senderCard.principalId}` !== contact.identity ||
      enterpriseFederationIdentityKeyFingerprint(senderCard) !==
        enterpriseFederationIdentityKeyFingerprint(trust.card) ||
      payload.message.senderIdentitySigningPublicKey !==
        senderCard.device.identitySigningPublicKey
    ) {
      throw new Error('联邦附件发送方身份验证失败');
    }
    const conversationId = federationConversationId({
      localDeploymentId: identity.deploymentId,
      localPrincipalId: identity.principalId,
      remoteDeploymentId: contact.remoteDeploymentId,
      remotePrincipalId: contact.remotePrincipalId,
    });
    const metadata = crypto.federationAttachmentMetadata({
      serverScope: ENTERPRISE_FEDERATION_E2EE_SCOPE,
      organizationId: conversationId,
      accountId: `${identity.deploymentId}:${identity.principalId}`,
      keyring: { serverScope, accountId: account.id },
      message: payload.message,
      attachmentId: input.attachmentId,
    });
    const authorized = await this.request<{
      attachment: {
        id: string;
        senderDeploymentId: string;
        recipientDeploymentId: string;
        ciphertextBytes: number;
        ciphertextSha256: string;
      };
      download: {
        method: 'GET';
        url: string;
        headers: Record<string, string>;
      };
    }>(
      `/enterprise/federation/conversations/${encodeURIComponent(input.contactId)}` +
        `/attachments/${encodeURIComponent(input.attachmentId)}/download`,
      { method: 'POST' },
    );
    if (
      authorized.attachment.id !== input.attachmentId ||
      authorized.attachment.senderDeploymentId !== contact.remoteDeploymentId ||
      authorized.attachment.recipientDeploymentId !== identity.deploymentId ||
      authorized.attachment.ciphertextBytes !== metadata.ciphertextSize ||
      authorized.attachment.ciphertextSha256 !== metadata.ciphertextSha256
    ) {
      throw new Error('联邦附件授权元数据与加密消息不一致');
    }
    const temporaryDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'otto-federation-download-'),
    );
    try {
      const ciphertextPath = path.join(temporaryDirectory, 'ciphertext.bin');
      const plaintextPath = path.join(temporaryDirectory, 'plaintext.bin');
      const response = await this.fetchImpl(authorized.download.url, {
        method: authorized.download.method,
        headers: authorized.download.headers,
      });
      if (!response.ok || !response.body) {
        throw new Error(`联邦附件下载失败（HTTP ${response.status}）`);
      }
      const output = fs.createWriteStream(ciphertextPath, { flags: 'wx' });
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (!output.write(Buffer.from(chunk))) {
            await new Promise<void>((resolve) => output.once('drain', resolve));
          }
        }
        await new Promise<void>((resolve, reject) => {
          output.end(resolve);
          output.once('error', reject);
        });
      } catch (error) {
        output.destroy();
        throw error;
      }
      await crypto.decryptExternalAttachmentFile({
        messageId: input.messageId,
        ciphertextPath,
        destinationPath: plaintextPath,
        metadata,
      });
      await fs.promises.copyFile(plaintextPath, input.destinationPath);
      return {
        id: metadata.id,
        fileName: metadata.fileName,
        mimeType: metadata.mimeType,
        size: metadata.size,
        path: input.destinationPath,
      };
    } finally {
      await fs.promises.rm(temporaryDirectory, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
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
    this.refuseMlsProtocolDowngrade();
    const { account } = this.requireE2eeContext();
    const trustedDevices = await this.verifiedE2eeDeviceDirectory(
      [account.id, peerAccountId],
      { includePending: false, includeRevoked: true },
    );
    const messages = (
      await this.request<{ messages: EnterpriseE2eeWireMessage[] }>(
        '/enterprise/messages/' + encodeURIComponent(peerAccountId),
      )
    ).messages;
    return messages.map((message) =>
      this.decryptE2eeMessage(message, trustedDevices),
    );
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
    ]);
    this.refuseMlsProtocolDowngrade();
    const usesSharedAttachmentObjects =
      attachments.length > 0 &&
      this.compatibleCapabilities.has('e2ee_attachment_objects_v1');
    if (attachments.length > 0 && !usesSharedAttachmentObjects) {
      await this.assertCompatibleServer(this.serverUrl, [
        'direct_message_attachments_v1',
      ]);
    }
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const devices = await this.e2eeDevicesForConversation(peerAccountId);
    const protocol = e2eeProtocolMetadata(content);
    const legacyAttachments = await Promise.all(
      attachments.map(async (attachment) => {
        if (attachment.data) return { ...attachment, data: attachment.data };
        if (!attachment.sourcePath) {
          throw new Error('E2EE attachment content is unavailable');
        }
        const content = await fs.promises.readFile(attachment.sourcePath);
        if (content.length !== attachment.size) {
          content.fill(0);
          throw new Error('E2EE attachment size changed after selection');
        }
        const data = content.toString('base64');
        content.fill(0);
        return {
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          size: attachment.size,
          data,
        };
      }),
    );
    const encrypted = crypto.encryptMessage({
      serverScope,
      organizationId: account.organizationId,
      senderAccountId: account.id,
      recipientAccountId: peerAccountId,
      content,
      contentType: protocol.contentType,
      inReplyToMessageId: protocol.inReplyToMessageId,
      devices,
      attachments: legacyAttachments,
    });
    const attachmentReferences = usesSharedAttachmentObjects
      ? await Promise.all(
          encrypted.attachments.map(async (attachment) => {
            const ciphertext = Buffer.from(attachment.ciphertext, 'base64');
            const checksum = createHash('sha256')
              .update(ciphertext)
              .digest('hex');
            const uploaded = await this.request<{
              attachment: {
                id: string;
                ciphertextBytes: number;
                ciphertextSha256: string;
              };
            }>(
              '/enterprise/attachments/inline',
              {
                method: 'POST',
                body: JSON.stringify({
                  peerAccountId,
                  attachmentId: attachment.id,
                  ciphertext: attachment.ciphertext,
                  ciphertextSha256: checksum,
                }),
              },
              { timeoutMs: 60_000 },
            );
            if (
              uploaded.attachment.id !== attachment.id ||
              uploaded.attachment.ciphertextBytes !== ciphertext.length ||
              uploaded.attachment.ciphertextSha256 !== checksum
            ) {
              throw new Error('shared attachment upload metadata is invalid');
            }
            return {
              id: attachment.id,
              nonce: attachment.nonce,
              ciphertextBytes: ciphertext.length,
              ciphertextSha256: checksum,
            };
          }),
        )
      : [];
    const message = (
      await this.request<{ message: EnterpriseE2eeWireMessage }>(
        '/enterprise/messages/' + encodeURIComponent(peerAccountId),
        {
          method: 'POST',
          body: JSON.stringify(
            usesSharedAttachmentObjects
              ? {
                  ...encrypted,
                  attachments: [],
                  attachmentReferences,
                }
              : encrypted,
          ),
        },
        { timeoutMs: attachments.length > 0 ? 60_000 : 10_000 },
      )
    ).message;
    return this.decryptE2eeMessage(message, devices);
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
        attachment: {
          id: string;
          ciphertext?: string;
          nonce: string;
          ciphertextBytes?: number;
          ciphertextSha256?: string;
          download?: {
            method: 'GET';
            url: string;
            expiresInSeconds: number;
            requiredHeaders: Record<string, string>;
          };
        };
      };
    }>(
      '/enterprise/message-attachments/' + encodeURIComponent(attachmentId),
      {},
      { timeoutMs: 60_000 },
    );
    let attachmentCiphertext = download.attachment.attachment.ciphertext;
    const presigned = download.attachment.attachment.download;
    if (!attachmentCiphertext && presigned) {
      const response = await this.fetchImpl(presigned.url, {
        method: presigned.method,
        headers: presigned.requiredHeaders,
      });
      if (!response.ok) {
        throw new Error(
          `shared attachment download failed: ${response.status}`,
        );
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (
        bytes.length !== download.attachment.attachment.ciphertextBytes ||
        createHash('sha256').update(bytes).digest('hex') !==
          download.attachment.attachment.ciphertextSha256
      ) {
        throw new Error('shared attachment download integrity check failed');
      }
      attachmentCiphertext = bytes.toString('base64');
    }
    if (!attachmentCiphertext) {
      throw new Error('E2EE attachment ciphertext is unavailable');
    }
    const { crypto, account, serverScope } = this.requireE2eeContext();
    const peerAccountId =
      download.attachment.message.senderAccountId === account.id
        ? download.attachment.message.recipientAccountId
        : download.attachment.message.senderAccountId;
    const trustedDevices = await this.verifiedE2eeDeviceDirectory(
      [account.id, peerAccountId],
      { includePending: false, includeRevoked: true },
    );
    const senderDevice = trustedDevices.find(
      (device) =>
        device.accountId === download.attachment.message.senderAccountId &&
        device.deviceId === download.attachment.message.senderDeviceId,
    );
    if (
      !senderDevice ||
      senderDevice.approvalState !== 'approved' ||
      senderDevice.identitySigningPublicKey !==
        download.attachment.message.senderIdentitySigningPublicKey
    ) {
      throw new Error(
        'E2EE attachment sender key is not trusted by the pinned directory',
      );
    }
    return crypto.decryptAttachment({
      serverScope,
      organizationId: account.organizationId,
      accountId: account.id,
      message: download.attachment.message,
      attachment: {
        id: download.attachment.attachment.id,
        nonce: download.attachment.attachment.nonce,
        ciphertext: attachmentCiphertext,
      },
    });
  }
  async listAtoaInbox(): Promise<EnterpriseAtoaInboxMessage[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, [
      'atoa',
      'e2ee_private_messages_v1',
    ]);
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
    const { account } = this.requireE2eeContext();
    const trustedDevices = await this.verifiedE2eeDeviceDirectory(
      [account.id, ...requests.map((request) => request.peerAccountId)],
      { includePending: false, includeRevoked: true },
    );
    return requests.map((request) => ({
      ...this.decryptE2eeMessage(request, trustedDevices),
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
