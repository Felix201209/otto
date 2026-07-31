/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Preload（CJS, contextIsolation 下的安全桥）。
 *
 * 暴露 `window.otto`：renderer 经它收发 server 帧 + 调 host-only 命令。
 * 这是替代 webview `acquireVsCodeApi()` / `window.vscode.postMessage` 的落点
 * （交付文档 [WEBVIEW] §5「必须替换」第 1、3 条）。
 *
 * 设计：preload 自己持有 WS 连接（renderer sandbox 不直接开 socket），
 * 把 ServerToClient 帧经回调转发给 renderer，把 ClientToServer 帧经 send() 发出。
 * renderer 侧只需把 `multiSessionMessageService` 的传输底换成 `window.otto`，
 * 保持 `{ type, payload }` 信封不变即可零改组件。
 *
 * 健壮性（Issue #4 收尾）：
 *   - 连接前 send() 进入队列，连上后 flush（renderer 不必等握手）。
 *   - 断线后指数退避自动重连；端点变更（main 推送）触发重连到新端点。
 *   - 连接状态变化经 onConnectionChange 通知 renderer 做 UI 指示。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ClientToServer,
  FeishuConfigPublic,
  FeishuConfigSaveRequest,
  HealthInfo,
  ServerEndpoint,
  ServerToClient,
} from 'otto-server';
import {
  serverEndpointChanged,
  serverWebSocketUrl,
} from './server-endpoint.js';
import {
  authorizeOutboundFileReferences,
  hasOutboundPathReference,
  sendAuthorizedFileFrame,
} from './outbound-file-authorization.js';

/**
 * 飞书守护状态（main 从 server /health 透传；renderer 徽标据此渲染）。
 * 即 HealthInfo 里的 feishu 字段：enabled/connected + 守护详情 status。
 */
export type FeishuStatusDetail = HealthInfo['feishu'];

/** 飞书凭证配置操作的统一返回：config 为脱敏视图（绝无 appSecret）。 */
export interface FeishuConfigResult {
  ok: boolean;
  config: FeishuConfigPublic | null;
  error: string | null;
}
export type { FeishuConfigPublic, FeishuConfigSaveRequest };

/**
 * 园区服务插件的企业定制配置（~/.otto-user/park-services.json）。
 * 仅供旧版 preload 兼容；新版企业账号以服务端园区配置为准。
 */
export interface ParkServicesConfig {
  /** 品牌全称：入口悬浮钮 tooltip 与对话框标题（如「XX智慧园区服务」）。 */
  brandName?: string;
  /** 园区简称：注入请求模板里的园区称呼（如「XX园区」）。 */
  parkName?: string;
  /** 完全覆盖兼容服务清单（图标由内置轮换分配）。 */
  services?: Array<{ name: string; desc: string; prompt: string }>;
}

// ── 软件更新的跨进程形状 ──
// 与 src/main/update-core.ts / update-service.ts 里的定义结构一致的副本。
// main 的 tsconfig rootDir 限制两边不能互相 import（同 IPC 常量表的既有做法：
// 两处各持一份、改动时同步）；renderer 一律从本文件 import type。

/** 单个平台的安装包资产（latest.json 的 assets[platformKey]）。 */
export interface UpdateAssetInfo {
  name: string;
  url: string;
  size: number;
  /** 64 位十六进制；下载后 main 强制校验，不匹配删文件报错。 */
  sha256: string;
}

/** 检查更新三态：有新版 / 已是最新 / 检查失败——失败绝不冒充最新。 */
export type UpdateCheckResult =
  | {
      status: 'update-available';
      currentVersion: string;
      version: string;
      notes: string;
      publishedAt: string | null;
      /** 本平台资产；清单没有本平台包（或兜底源拿不到 sha256）时为 null。 */
      asset: UpdateAssetInfo | null;
      /** 资产缺失时引导用户浏览器手动下载的发布页。 */
      releasePageUrl: string;
    }
  | {
      status: 'up-to-date';
      currentVersion: string;
      latestVersion: string | null;
    }
  | { status: 'check-failed'; currentVersion: string; message: string };

/** 下载进度（main 经 IPC.updateProgress 节流推送）。 */
export interface UpdateProgressInfo {
  percent: number;
  transferred: number;
  total: number;
}

/** 下载结果（结构化；reused=同名文件 sha256 已匹配、直接复用跳过下载）。 */
export type UpdateDownloadResult =
  | { ok: true; filePath: string; reused: boolean }
  | { ok: false; cancelled?: boolean; error: string };

/** 安装结果（message 为按平台给的下一步指引，如「装完请重启 Otto」）。 */
export interface UpdateInstallResult {
  ok: boolean;
  message: string;
}

export type IncrementalUpdateKind = 'patch' | 'kernel' | 'component';
export interface IncrementalUpdateAvailableArtifact {
  id: string;
  kind: IncrementalUpdateKind;
  version: string;
  target: string;
  restart: 'none' | 'renderer' | 'server' | 'app';
  rollbackSupported: boolean;
}
export type IncrementalUpdateCheckResult =
  | {
      status: 'available';
      appVersion: string;
      sourceCommit: string;
      publishedAt: string;
      artifacts: IncrementalUpdateAvailableArtifact[];
    }
  | { status: 'up-to-date'; appVersion: string }
  | { status: 'check-failed'; appVersion: string; message: string };

export interface DesktopRuntimeDiagnostic {
  contractVersion: 1;
  server: {
    status: 'ready' | 'starting' | 'unavailable';
    ownership?: 'discovered' | 'detached' | 'embedded';
    message?: string;
  };
  nativeCore: {
    mode: 'auto' | 'required' | 'off';
    status: 'disabled' | 'not_probed' | 'configured';
    message: string;
  };
}
export type IncrementalUpdateApplyResult =
  | {
      ok: true;
      kind: 'kernel';
      id: string;
      version: string;
      target: string;
      restart: 'none' | 'renderer' | 'server' | 'app';
      artifactPath: string;
      modulePath: string;
      binPath: string;
    }
  | {
      ok: true;
      kind: 'patch';
      id: string;
      version: string;
      target: string;
      restart: 'none' | 'renderer' | 'server' | 'app';
      artifactPath: string;
      runtimeApplied: boolean;
    }
  | {
      ok: true;
      kind: 'component';
      id: string;
      version: string;
      target: string;
      restart: 'none' | 'renderer' | 'server' | 'app';
      artifactPath: string;
    }
  | { ok: false; unsupported?: boolean; cancelled?: boolean; error: string };

export type AsrProvider = 'volcengine' | 'openai';
export interface VoicePublicConfig {
  enabled: boolean;
  asrProvider: AsrProvider;
  asrEndpoint: string;
  asrModel: string;
  volcResourceId: string;
  polishEnabled: boolean;
  polishEndpoint: string;
  polishModel: string;
  polishPrompt: string;
  hasAsrApiKey: boolean;
  hasVolcCredentials: boolean;
  hasPolishApiKey: boolean;
}
export interface VoiceConfigInput extends Omit<
  VoicePublicConfig,
  'hasAsrApiKey' | 'hasVolcCredentials' | 'hasPolishApiKey'
> {
  asrApiKey?: string;
  volcAppKey?: string;
  volcAccessKey?: string;
  polishApiKey?: string;
}
export interface VoiceResult {
  text: string;
  rawText: string;
  polished: boolean;
}

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

export interface EnterpriseAccountCreateInput {
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

export interface EnterpriseAccountUpdateInput {
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

export interface EnterpriseSmsChallenge {
  serverUrl: string;
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
  message: string;
  registrationMode?: 'personal' | 'enterprise';
  organization: { id: string; name: string } | null;
}

export interface EnterpriseSmsLoginChallenge {
  serverUrl: string;
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
  message: string;
}

export interface EnterpriseRegistrationIntent {
  inviteCode: string;
  /** 企业服务器地址（从邀请链接的 server 参数提取） */
  serverUrl?: string;
}

export interface EnterpriseSessionState {
  serverUrl: string;
  account: EnterpriseAccount | null;
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

export interface EnterpriseTokenUsageInput {
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
  title?: string;
  department: string | null;
  category: string;
  content: string;
  contributor: string | null;
  confidence: number;
  sourceType?:
    | 'manual'
    | 'auto_capture'
    | 'work_result'
    | 'task_log'
    | 'document'
    | 'offboarding';
  sourceLabel?: string | null;
  status?: 'pending_review' | 'active' | 'archived';
  version?: number;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
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
  status: NonNullable<EnterpriseKnowledgeItem['status']>;
  changedBy: string | null;
  changeNote: string | null;
  createdAt: string;
}

export type EnterpriseSkillVisibility = 'department' | 'company';
export type EnterpriseSkillStatus = 'pending_review' | 'active' | 'archived';
export type EnterpriseSkillScope = 'department' | 'company' | 'mine' | 'review';
export type EnterpriseSkillSort =
  'recommended' | 'rating' | 'installs' | 'usage' | 'newest';

export interface LocalSkillShareCandidate {
  name: string;
  description: string;
  kind: 'auto' | 'personal';
}

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

export interface EnterpriseParkService {
  parkId: string;
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
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

export interface EnterpriseE2eeDevice {
  accountId: string;
  deviceId: string;
  deviceName: string;
  identitySigningPublicKey: string;
  deviceExchangePublicKey: string;
  keyFingerprint: string;
  approvalState: 'pending' | 'approved';
  approvedByDeviceId: string | null;
  approvedAt: string | null;
  isCurrentDevice?: boolean;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface EnterpriseE2eeDeviceVerification {
  safetyNumber: string;
  qrPayload: string;
  deviceFingerprints: [string, string];
}

export type EnterpriseE2eeKeyTransparencyEvent =
  | 'bootstrap_approved'
  | 'registered_pending'
  | 'approved'
  | 'revoked';

export interface EnterpriseE2eeKeyTransparencyEntry {
  sequence: number;
  accountId: string;
  deviceId: string;
  event: EnterpriseE2eeKeyTransparencyEvent;
  keyFingerprint: string;
  actorDeviceId: string | null;
  previousHash: string;
  entryHash: string;
  createdAt: string;
}

export interface EnterpriseE2eeKeyTransparencyView {
  accountId: string;
  headSequence: number;
  headHash: string;
  entries: EnterpriseE2eeKeyTransparencyEntry[];
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
  /** 由企业服务端按 peerAccountId 查询的可信身份，不解析消息正文中的自报字段。 */
  peer: {
    id: string;
    username: string;
    name: string;
    department: string | null;
    positionTitle: string | null;
    role: string | null;
  };
}

export interface EnterpriseRepairNotification {
  channel: 'otto' | 'sms' | 'feishu';
  event: string;
  status: 'sent' | 'failed' | 'skipped';
  detail: string | null;
  createdAt: string;
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
  status: '待派单' | '待接单' | '维修中' | '待验收' | '已完成' | string;
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
  notifications: EnterpriseRepairNotification[];
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

export interface AutoGeneratedAgentProfile {
  id: string;
  name: string;
  tagline: string;
  scope: string;
  department: string | null;
  skills: string[];
  systemPrompt: string;
}

// ── IPC channel 名（与 main 对齐）──
const IPC = {
  getEndpoint: 'otto:get-endpoint',
  runtimeDiagnostic: 'otto:runtime-diagnostic',
  endpointChanged: 'otto:endpoint-changed',
  openExternal: 'otto:open-external',
  openPath: 'otto:open-path',
  inspectLocalPath: 'otto:inspect-local-path',
  activateLocalPath: 'otto:activate-local-path',
  selectFiles: 'otto:select-files',
  grantBrowserFile: 'otto:grant-browser-file',
  authorizeMessageFiles: 'otto:authorize-message-files',
  readFilePath: 'otto:read-file-path',
  extractEditableDocument: 'otto:extract-editable-document',
  exportEditedDocument: 'otto:export-edited-document',
  openVideoEditor: 'otto:open-video-editor',
  saveTextFile: 'otto:save-text-file',
  menu: 'otto:menu',
  setLocalTestUrl: 'otto:set-local-test-url',
  appVersion: 'otto:app-version',
  updateCheck: 'otto:update-check',
  updateDownload: 'otto:update-download',
  updateCancel: 'otto:update-cancel',
  updateInstall: 'otto:update-install',
  updateProgress: 'otto:update-progress',
  incrementalUpdateCheck: 'otto:incremental-update-check',
  incrementalUpdateApply: 'otto:incremental-update-apply',
  notificationUnreadChanged: 'otto:notification-unread-changed',
  notificationMarkRead: 'otto:notification-mark-read',
  notificationGetUnread: 'otto:notification-get-unread',
  notificationShow: 'otto:notification-show',
  notificationCheckPermission: 'otto:notification-check-permission',
  notificationSessionOpen: 'otto:notification-session-open',
  voiceGetConfig: 'otto:voice-get-config',
  voiceSaveConfig: 'otto:voice-save-config',
  voiceTranscribe: 'otto:voice-transcribe',
  autoGeneratedAgentProfiles: 'otto:auto-generated-agent-profiles',
  enterpriseSession: 'otto:enterprise-session',
  enterprisePasswordLogin: 'otto:enterprise-password-login',
  enterpriseSmsLoginRequest: 'otto:enterprise-sms-login-request',
  enterpriseSmsLoginVerify: 'otto:enterprise-sms-login-verify',
  enterpriseRegistrationRequest: 'otto:enterprise-registration-request',
  enterpriseRegistrationIntent: 'otto:enterprise-registration-intent',
  enterpriseRegistrationIntentOpened:
    'otto:enterprise-registration-intent-opened',
  enterpriseSessionInvalidated: 'otto:enterprise-session-invalidated',
  enterpriseAccountUpdated: 'otto:enterprise-account-updated',
  enterpriseRegister: 'otto:enterprise-register',
  enterpriseJoinOrganization: 'otto:enterprise-join-organization',
  enterpriseLogout: 'otto:enterprise-logout',
  enterpriseAccounts: 'otto:enterprise-accounts',
  enterpriseAccountCreate: 'otto:enterprise-account-create',
  enterpriseAccountUpdate: 'otto:enterprise-account-update',
  enterpriseAccountDelete: 'otto:enterprise-account-delete',
  enterpriseDataGovernanceGet: 'otto:enterprise-data-governance-get',
  enterpriseLegalAccept: 'otto:enterprise-legal-accept',
  enterprisePrivacyExport: 'otto:enterprise-privacy-export',
  enterprisePrivacyDelete: 'otto:enterprise-privacy-delete',
  enterprisePair: 'otto:enterprise-pair',
  enterpriseUsageRecord: 'otto:enterprise-usage-record',
  enterpriseKnowledgeRecord: 'otto:enterprise-knowledge-record',
  enterpriseKnowledgeList: 'otto:enterprise-knowledge-list',
  enterpriseKnowledgeReview: 'otto:enterprise-knowledge-review',
  enterpriseKnowledgeRevise: 'otto:enterprise-knowledge-revise',
  enterpriseKnowledgeRevisions: 'otto:enterprise-knowledge-revisions',
  enterpriseOrganizationView: 'otto:enterprise-organization-view',
  enterprisePresenceHeartbeat: 'otto:enterprise-presence-heartbeat',
  enterpriseOrganizationFeaturesGet:
    'otto:enterprise-organization-features-get',
  enterpriseOrganizationFeaturesUpdate:
    'otto:enterprise-organization-features-update',
  enterpriseOrganizationDepartments: 'otto:enterprise-organization-departments',
  enterpriseOrganizationDepartmentCreate:
    'otto:enterprise-organization-department-create',
  enterpriseOrganizationDepartmentUpdate:
    'otto:enterprise-organization-department-update',
  enterpriseOrganizationDepartmentDelete:
    'otto:enterprise-organization-department-delete',
  enterpriseOrganizationPositionCreate:
    'otto:enterprise-organization-position-create',
  enterpriseOrganizationPositionUpdate:
    'otto:enterprise-organization-position-update',
  enterpriseOrganizationPositionDelete:
    'otto:enterprise-organization-position-delete',
  enterpriseMessagesList: 'otto:enterprise-messages-list',
  enterpriseMessagesUnread: 'otto:enterprise-messages-unread',
  enterpriseMessageSend: 'otto:enterprise-message-send',
  enterpriseMessageAttachmentRead: 'otto:enterprise-message-attachment-read',
  enterpriseE2eeDevicesList: 'otto:enterprise-e2ee-devices-list',
  enterpriseE2eeKeyTransparency: 'otto:enterprise-e2ee-key-transparency',
  enterpriseE2eeDeviceApprove: 'otto:enterprise-e2ee-device-approve',
  enterpriseE2eeDeviceVerification: 'otto:enterprise-e2ee-device-verification',
  enterpriseE2eeDeviceRevoke: 'otto:enterprise-e2ee-device-revoke',
  enterpriseE2eeRecoveryExport: 'otto:enterprise-e2ee-recovery-export',
  enterpriseE2eeRecoveryImport: 'otto:enterprise-e2ee-recovery-import',
  enterpriseAtoaInbox: 'otto:enterprise-atoa-inbox',
  enterpriseParkServicePush: 'otto:enterprise-park-service-push',
  enterpriseParkView: 'otto:enterprise-park-view',
  enterpriseParkRegister: 'otto:enterprise-park-register',
  enterpriseParkJoin: 'otto:enterprise-park-join',
  enterpriseParkProfileUpdate: 'otto:enterprise-park-profile-update',
  enterpriseParkInviteIssue: 'otto:enterprise-park-invite-issue',
  enterpriseParkTenants: 'otto:enterprise-park-tenants',
  enterpriseParkStatistics: 'otto:enterprise-park-statistics',
  enterpriseParkSpecialists: 'otto:enterprise-park-specialists',
  enterpriseParkSpecialistSet: 'otto:enterprise-park-specialist-set',
  enterpriseParkSpecialistRemove: 'otto:enterprise-park-specialist-remove',
  enterpriseParkServices: 'otto:enterprise-park-services',
  enterpriseParkServiceUpdate: 'otto:enterprise-park-service-update',
  enterpriseParkPublications: 'otto:enterprise-park-publications',
  enterpriseParkAnnouncementResults:
    'otto:enterprise-park-announcement-results',
  enterpriseParkSurveyResults: 'otto:enterprise-park-survey-results',
  enterpriseParkPublicationRead: 'otto:enterprise-park-publication-read',
  enterpriseParkSurveySubmit: 'otto:enterprise-park-survey-submit',
  enterpriseParkResources: 'otto:enterprise-park-resources',
  enterpriseOrganizationInviteGet: 'otto:enterprise-organization-invite-get',
  enterpriseOrganizationInviteIssue:
    'otto:enterprise-organization-invite-issue',
  enterpriseTicketInbox: 'otto:enterprise-ticket-inbox',
  enterpriseTicketList: 'otto:enterprise-ticket-list',
  enterpriseTicketSubmit: 'otto:enterprise-ticket-submit',
  enterpriseTicketRead: 'otto:enterprise-ticket-read',
  enterpriseTicketAction: 'otto:enterprise-ticket-action',
  feishuStart: 'otto:feishu-start',
  feishuStop: 'otto:feishu-stop',
  feishuStatus: 'otto:feishu-status',
  feishuGetConfig: 'otto:feishu-get-config',
  feishuSaveConfig: 'otto:feishu-save-config',
  feishuClearConfig: 'otto:feishu-clear-config',
  parkConfig: 'otto:park-config',
  themeGet: 'otto:theme-get',
  themeSet: 'otto:theme-set',
  skillLeaderboard: 'otto:skill-leaderboard',
  workLogToday: 'otto:worklog-today',
  workLogRecent: 'otto:worklog-recent',
  workLogReport: 'otto:worklog-report',
  skillShareList: 'otto:skill-share-list',
  skillMarketplace: 'otto:skill-marketplace',
  enterpriseSkillLocalList: 'otto:enterprise-skill-local-list',
  enterpriseSkillList: 'otto:enterprise-skill-list',
  enterpriseSkillSubmit: 'otto:enterprise-skill-submit',
  enterpriseSkillReview: 'otto:enterprise-skill-review',
  enterpriseSkillInstall: 'otto:enterprise-skill-install',
  enterpriseSkillRate: 'otto:enterprise-skill-rate',
  enterpriseSkillLeaderboard: 'otto:enterprise-skill-leaderboard',
  parkNativeNotify: 'otto:park-native-notify',
  writeClipboard: 'otto:write-clipboard',
} as const;

/** renderer 注册的入站帧回调。 */
type FrameHandler = (frame: ServerToClient) => void;
type ExternalInboundNotificationFrame = {
  type: 'external_inbound_notification';
  payload: {
    messageId: string;
    sessionId: string;
    source: string;
    sender?: string;
    preview: string;
  };
};
/** 连接状态变化回调。 */
type ConnectionHandler = (connected: boolean) => void;
/** 应用菜单动作回调（'new-chat' | 'open-settings'）。 */
type MenuHandler = (action: string) => void;

/** preload 暴露给 renderer 的 API 形状（renderer 据此声明 window.otto 类型）。 */
export interface OttoBridge {
  /** 连接到本地 server（解析端点后建 WS）。返回是否连上。 */
  connect(): Promise<boolean>;
  /** 主动断开（不自动重连，直到下次 connect()）。 */
  disconnect(): void;
  /** 发一帧到 server。未连接时入队，连上后按序 flush。 */
  send(frame: ClientToServer): void;
  /** 订阅 server 入站帧，返回取消函数。 */
  onFrame(handler: FrameHandler): () => void;
  /** 订阅连接状态变化，返回取消函数。立即以当前状态回调一次。 */
  onConnectionChange(handler: ConnectionHandler): () => void;
  /** 连接状态。 */
  isConnected(): boolean;
  /**
   * 订阅应用菜单动作（main 经 IPC.menu 下发）：'new-chat' | 'open-settings'。
   * 返回取消订阅函数。
   */
  onMenu(handler: MenuHandler): () => void;
  /** host-only 命令：用系统浏览器打开外链。 */
  openExternal(url: string): Promise<void>;
  /** host-only 命令：用系统默认程序打开本地路径。 */
  openPath(path: string): Promise<void>;
  /** 检查回答中出现的本地绝对路径；主进程仅返回当前用户目录内的真实文件。 */
  inspectLocalPath(path: string): Promise<{
    exists: boolean;
    kind: 'file' | 'directory' | 'missing';
    canOpen: boolean;
  }>;
  /** 安全打开回答里的输出文件，或在系统文件管理器中定位。 */
  activateLocalPath(
    path: string,
    action: 'open' | 'reveal',
  ): Promise<{ ok: boolean; error?: string }>;
  /**
   * 原生文件选择器：打开系统文件对话框，返回完整路径数组。
   * 用户主动授权选择，不受浏览器沙箱限制。
   */
  selectFiles(): Promise<string[]>;
  /**
   * Electron 32+ 不再提供 File.path；通过 webUtils 恢复用户拖入/浏览器选择文件的
   * 真实本地路径。只接受浏览器 File 对象，不能用任意字符串伪造路径。
   */
  getPathForFile(file: File): string;
  /**
   * 拖拽/隐藏 input 附件的可信授权入口。路径仅由 preload 的
   * webUtils.getPathForFile(File) 提取，renderer 不能传入裸路径。
   */
  authorizeFileForAttachment(file: File): Promise<string>;
  /**
   * 读取指定路径的文件，返回 Base64 + 元数据。
   * 仅限本进程中经原生选择器明确授权的文件；可位于任意已挂载磁盘。
   */
  readFilePath(filePath: string): Promise<{
    filePath: string;
    fileName: string;
    size: number;
    mimeType: string;
    data: string;
  }>;
  /** 提取 PDF/Word/文本为右侧可编辑 Markdown。 */
  extractEditableDocument(filePath: string): Promise<{
    filePath: string;
    fileName: string;
    sourceFormat: 'text' | 'markdown' | 'docx' | 'pdf';
    editableFormat: 'markdown';
    content: string;
    readonly: boolean;
    message: string;
  }>;
  /** 将右侧编辑稿导出回目标格式。取消保存时返回 null。 */
  exportEditedDocument(
    sourcePath: string,
    suggestedFileName: string,
    content: string,
  ): Promise<{
    ok: boolean;
    path: string;
    format: 'text' | 'markdown' | 'docx' | 'pdf';
    message: string;
  } | null>;
  /** 打开内置视频编辑器窗口。 */
  openVideoEditor(): Promise<{ ok: boolean; error?: string }>;
  /**
   * host-only 命令：原生保存对话框 + 写文本文件（导出会话用）。
   * 返回实际写入路径；用户取消对话框时返回 null。
   */
  saveTextFile(
    suggestedFileName: string,
    content: string,
  ): Promise<string | null>;
  feishuStart(): Promise<{ text: string; pid?: number }>;
  feishuStop(): Promise<{ text: string }>;
  /**
   * 飞书守护状态查询（main 真查 server /health）。
   * text 为人话说明；running=守护是否在跑；feishu 为结构化守护详情
   * （connected / 重连第 N 次 / 下次重试时间 / 锁冲突持有者 pid），
   * server 未就绪时缺省。
   */
  feishuStatus(): Promise<{
    text: string;
    running: boolean;
    feishu?: FeishuStatusDetail;
  }>;
  /**
   * 飞书凭证配置（「飞书接入」面板）。config 是脱敏视图：
   * 只有 appId / domain / 授权人等元信息，appSecret 永不回传。
   */
  feishuGetConfig(): Promise<FeishuConfigResult>;
  /** 保存凭证并让守护立即用上（server 侧 stop→start 重读凭证）。 */
  feishuSaveConfig(body: FeishuConfigSaveRequest): Promise<FeishuConfigResult>;
  /** 停守护 + 清除凭证（对应 CLI /feishu logout）。 */
  feishuClearConfig(): Promise<FeishuConfigResult>;
  /** 园区服务企业定制配置；无配置文件时 null（用内置默认）。 */
  parkConfig(): Promise<ParkServicesConfig | null>;
  /** 当前外观主题（'system' 跟随系统 / 'light' / 'dark'）。 */
  themeGet(): Promise<'system' | 'light' | 'dark'>;
  /** 设置外观主题并持久化；返回生效值。 */
  themeSet(
    v: 'system' | 'light' | 'dark',
  ): Promise<'system' | 'light' | 'dark'>;
  /** Skill 排行榜 + 贡献明星榜（krx 企业面板；数据读 .otto/org/skill-shares.json）。 */
  skillLeaderboard(teamId?: string): Promise<{
    leaderboard: string;
    starBoard: string;
    tabs: Array<{ id: string; label: string; icon: string }>;
  }>;
  /** 今日工作日志汇总。 */
  workLogToday(): Promise<{
    summary: string;
    date: string;
    totalActions: number;
    workResults: number;
  }>;
  /** 近 N 天逐日日志明细（日历 hover 视图）。 */
  workLogRecent(days?: number): Promise<
    Array<{
      date: string;
      entries: Array<{
        time: string;
        category: string;
        action: string;
        success: boolean;
        details?: string;
        entryType: 'tool' | 'work_result';
        taskTitle?: string;
      }>;
    }>
  >;
  /** 汇总今日成果、保存 Markdown 报告并返回实际路径。 */
  workLogReport(): Promise<{
    ok: boolean;
    date: string;
    title: string;
    markdown: string;
    html?: string;
    path: string;
    message: string;
  }>;
  /** 一键生成脱敏诊断包并保存到桌面。 */
  createDiagnosticBundle(): Promise<{
    ok: boolean;
    path: string;
    fileCount: number;
    message: string;
  }>;
  runtimeDiagnostic(): Promise<DesktopRuntimeDiagnostic>;
  /** 部门共享 Skill 列表。 */
  skillShareList(teamId?: string): Promise<{ text: string }>;
  /** 公司 Skill 市场。 */
  skillMarketplace(): Promise<{ text: string }>;
  enterpriseSkillLocalList(): Promise<LocalSkillShareCandidate[]>;
  enterpriseSkillList(input?: {
    scope?: EnterpriseSkillScope;
    query?: string;
    sort?: EnterpriseSkillSort;
  }): Promise<EnterpriseSkillMarketItem[]>;
  enterpriseSkillSubmit(input: {
    localSkillName: string;
    visibility: EnterpriseSkillVisibility;
  }): Promise<{
    outcome: 'submitted' | 'exists';
    skill: EnterpriseSkillMarketItem;
  }>;
  enterpriseSkillReview(
    id: string,
    action: 'approve' | 'archive',
    visibility?: EnterpriseSkillVisibility,
  ): Promise<EnterpriseSkillMarketItem>;
  enterpriseSkillInstall(id: string): Promise<{
    skill: EnterpriseSkillMarketItem;
    installedPath: string;
  }>;
  enterpriseSkillRate(
    id: string,
    score: number,
  ): Promise<EnterpriseSkillMarketItem>;
  enterpriseSkillLeaderboard(): Promise<EnterpriseSkillLeaderboard>;
  /**
   * 本地测试模式：把 customProxyServerUrl 设为指定地址（不空）或清除（空字符串）。
   * main 进程需要把该 URL 注入到 server manager（如设置 OTTO_SERVER_URL env）。
   * 返回是否应用成功。
   */
  setLocalTestUrl?(url: string): Promise<void>;
  /** 当前 app 版本号（main 的 app.getVersion()）。 */
  appVersion(): Promise<string>;
  /**
   * 检查软件更新（main 拉 latest.json，兜底 GitHub API）。
   * 三态结果：有新版 / 已是最新 / 检查失败——失败绝不冒充最新。
   */
  updateCheck(): Promise<UpdateCheckResult>;
  /**
   * 通知：弹OS原生通知
   */
  notificationShow(payload: {
    sessionId: string;
    source: string;
    sender?: string;
    title?: string;
    preview: string;
    messageId?: string;
    persistent?: boolean;
  }): Promise<void>;
  /** 通知：标记会话已读 */
  notificationMarkRead(sessionId: string): Promise<void>;
  /** 通知：读取 main 进程当前未读快照（renderer 重载后恢复闪烁点）。 */
  notificationGetUnread(): Promise<string[]>;
  /** 通知：检查权限 */
  notificationCheckPermission(): Promise<boolean>;
  /** 通知：订阅未读变更（从主进程推送） */
  onNotificationUnreadChanged(cb: (unread: string[]) => void): () => void;
  /** 通知：点击通知跳转会话 */
  onNotificationSessionOpen(cb: (sessionId: string) => void): () => void;
  /**
   * 下载最近一次检查到的新版安装包（main 只信自己缓存的检查结果，
   * renderer 不传 URL）。下载完成 main 已做 sha256 校验，失败会删文件报错。
   */
  updateDownload(): Promise<UpdateDownloadResult>;
  /** 取消进行中的下载（无任务时安全空操作）。 */
  updateCancel(): Promise<void>;
  /** 打开已校验的安装包（win 拉起 NSIS / mac 打开 dmg），message 给下一步指引。 */
  updateInstall(): Promise<UpdateInstallResult>;
  /** 订阅下载进度（main 节流推送），返回取消订阅函数。 */
  onUpdateProgress(handler: (progress: UpdateProgressInfo) => void): () => void;
  /** 检查补丁 / 内核 / 组件增量更新。 */
  incrementalUpdateCheck(input?: {
    manifestUrl?: string;
  }): Promise<IncrementalUpdateCheckResult>;
  /** 应用最近一次检查到的增量更新；当前仅 component 有执行器。 */
  incrementalUpdateApply(input: {
    kind: IncrementalUpdateKind;
    id: string;
  }): Promise<IncrementalUpdateApplyResult>;
  voiceGetConfig(): Promise<VoicePublicConfig>;
  voiceSaveConfig(config: VoiceConfigInput): Promise<VoicePublicConfig>;
  voiceTranscribe(bytes: Uint8Array, mimeType: string): Promise<VoiceResult>;
  autoGeneratedAgentProfiles(): Promise<AutoGeneratedAgentProfile[]>;
  enterpriseSession(): Promise<EnterpriseSessionState>;
  enterprisePasswordLogin(input: {
    serverUrl: string;
    identifier: string;
    password: string;
  }): Promise<{
    serverUrl: string;
    account: EnterpriseAccount;
    expiresAt: string;
  }>;
  enterpriseSmsLoginRequest(input: {
    serverUrl: string;
    phone: string;
  }): Promise<EnterpriseSmsLoginChallenge>;
  enterpriseSmsLoginVerify(input: {
    challengeId: string;
    code: string;
  }): Promise<{
    serverUrl: string;
    account: EnterpriseAccount;
    expiresAt: string;
  }>;
  enterpriseRegistrationRequest(input: {
    serverUrl: string;
    phone: string;
    inviteCode?: string;
  }): Promise<EnterpriseSmsChallenge>;
  enterpriseRegistrationIntent(): Promise<EnterpriseRegistrationIntent | null>;
  onEnterpriseRegistrationIntent(
    handler: (intent: EnterpriseRegistrationIntent) => void,
  ): () => void;
  onEnterpriseSessionInvalidated(handler: () => void): () => void;
  onEnterpriseAccountUpdated(
    handler: (account: EnterpriseAccount) => void,
  ): () => void;
  enterpriseRegister(input: {
    challengeId: string;
    code: string;
    name: string;
    password: string;
    legalConsent: true;
  }): Promise<{
    serverUrl: string;
    account: EnterpriseAccount;
    expiresAt: string;
  }>;
  enterpriseJoinOrganization(input: {
    inviteCode: string;
  }): Promise<{ serverUrl: string; account: EnterpriseAccount }>;
  enterpriseLogout(): Promise<void>;
  /** 接入企业：提交配对令牌，完成本地 Otto 与企业服务器的连接。 */
  enterprisePair(token: string): Promise<{
    ok: boolean;
    message: string;
    enterpriseUrl?: string;
  }>;
  enterpriseAccounts(): Promise<EnterpriseAccount[]>;
  enterpriseAccountCreate(
    input: EnterpriseAccountCreateInput,
  ): Promise<EnterpriseAccount>;
  enterpriseAccountUpdate(
    id: string,
    input: EnterpriseAccountUpdateInput,
  ): Promise<EnterpriseAccount>;
  enterpriseAccountDelete(id: string): Promise<{ id: string; deleted: true }>;
  enterpriseDataGovernanceGet(): Promise<EnterpriseDataGovernanceProfile>;
  enterpriseLegalAccept(): Promise<EnterpriseDataGovernanceProfile>;
  enterprisePrivacyExport(): Promise<{ ok: true; path: string } | null>;
  enterprisePrivacyDelete(input: {
    password: string;
    confirmation: string;
  }): Promise<EnterprisePrivacyDeletionReceipt>;
  enterpriseUsageRecord(input: EnterpriseTokenUsageInput): Promise<{
    recorded: boolean;
    source: 'client_reported';
  }>;
  enterpriseKnowledgeRecord(
    input: EnterpriseKnowledgeRecordInput,
  ): Promise<EnterpriseKnowledgeRecordResult>;
  enterpriseKnowledgeList(input?: {
    query?: string;
    department?: string;
    includeReview?: boolean;
    status?: EnterpriseKnowledgeItem['status'];
  }): Promise<EnterpriseKnowledgeItem[]>;
  enterpriseKnowledgeReview(
    id: string,
    action: 'approve' | 'archive',
    note?: string,
  ): Promise<EnterpriseKnowledgeItem>;
  enterpriseKnowledgeRevise(
    id: string,
    input: {
      title: string;
      category: string;
      content: string;
      confidence?: number;
      changeNote?: string;
    },
  ): Promise<EnterpriseKnowledgeItem>;
  enterpriseKnowledgeRevisions(
    id: string,
  ): Promise<EnterpriseKnowledgeRevision[]>;
  enterpriseOrganizationView(): Promise<EnterpriseOrganizationView>;
  enterprisePresenceHeartbeat(): Promise<void>;
  enterpriseOrganizationFeaturesGet(): Promise<EnterpriseOrganizationFeatures>;
  enterpriseOrganizationFeaturesUpdate(
    patch: Partial<EnterpriseOrganizationFeatures>,
  ): Promise<EnterpriseOrganizationFeatures>;
  enterpriseOrganizationDepartments(): Promise<
    EnterpriseOrganizationDepartment[]
  >;
  enterpriseOrganizationDepartmentCreate(
    name: string,
  ): Promise<EnterpriseOrganizationDepartment>;
  enterpriseOrganizationDepartmentUpdate(
    id: string,
    name: string,
  ): Promise<EnterpriseOrganizationDepartment>;
  enterpriseOrganizationDepartmentDelete(id: string): Promise<boolean>;
  enterpriseOrganizationPositionCreate(input: {
    departmentId: string;
    title: string;
    roleMapping: EnterprisePositionRoleMapping;
  }): Promise<EnterpriseOrganizationPosition>;
  enterpriseOrganizationPositionUpdate(
    id: string,
    input: {
      title?: string;
      roleMapping?: EnterprisePositionRoleMapping;
    },
  ): Promise<EnterpriseOrganizationPosition>;
  enterpriseOrganizationPositionDelete(id: string): Promise<boolean>;
  enterpriseMessagesList(
    peerAccountId: string,
  ): Promise<EnterpriseDirectMessage[]>;
  enterpriseMessagesUnread(): Promise<EnterpriseUnreadMessageNotification[]>;
  enterpriseMessageSend(
    peerAccountId: string,
    content: string,
    attachments?: EnterpriseDirectMessageAttachmentUpload[],
  ): Promise<EnterpriseDirectMessage>;
  enterpriseMessageAttachmentRead(
    attachmentId: string,
  ): Promise<EnterpriseDirectMessageAttachmentDownload>;
  enterpriseE2eeDevicesList(): Promise<EnterpriseE2eeDevice[]>;
  enterpriseE2eeKeyTransparency(): Promise<EnterpriseE2eeKeyTransparencyView>;
  enterpriseE2eeDeviceApprove(deviceId: string): Promise<EnterpriseE2eeDevice>;
  enterpriseE2eeDeviceVerification(
    deviceId: string,
  ): Promise<EnterpriseE2eeDeviceVerification>;
  enterpriseE2eeDeviceRevoke(deviceId: string): Promise<void>;
  enterpriseE2eeRecoveryExport(passphrase: string): Promise<string>;
  enterpriseE2eeRecoveryImport(
    bundle: string,
    passphrase: string,
  ): Promise<void>;
  enterpriseAtoaInbox(): Promise<EnterpriseAtoaInboxMessage[]>;
  enterpriseParkServicePush(input: {
    recipientAccountId: string;
    serviceId: string;
    note?: string | null;
  }): Promise<{
    message?: EnterpriseDirectMessage;
    publication?: EnterpriseParkPublication;
    recipientCount?: number;
  }>;
  enterpriseParkView(): Promise<EnterprisePark | null>;
  enterpriseParkRegister(input: {
    name: string;
    slug?: string;
    brandName?: string;
  }): Promise<EnterprisePark>;
  enterpriseParkJoin(input: {
    inviteCode: string;
    address: string;
    roomNumber: string;
  }): Promise<EnterprisePark>;
  enterpriseParkProfileUpdate(input: {
    address: string;
    roomNumber: string;
  }): Promise<EnterpriseParkTenantProfile>;
  enterpriseParkInviteIssue(
    maxUses?: number | null,
  ): Promise<EnterpriseParkInvite>;
  enterpriseParkTenants(): Promise<EnterpriseParkTenantOrganization[]>;
  enterpriseParkStatistics(): Promise<EnterpriseParkStatistics>;
  enterpriseParkSpecialists(): Promise<EnterpriseParkSpecialist[]>;
  enterpriseParkSpecialistSet(
    serviceId: string,
    accountId: string,
  ): Promise<EnterpriseParkSpecialist>;
  enterpriseParkSpecialistRemove(
    serviceId: string,
    accountId: string,
  ): Promise<boolean>;
  enterpriseParkServices(): Promise<EnterpriseParkService[]>;
  enterpriseParkServiceUpdate(input: {
    serviceId: string;
    name?: string;
    enabled?: boolean;
    config?: Record<string, string>;
  }): Promise<EnterpriseParkService>;
  enterpriseParkPublications(): Promise<EnterpriseParkPublication[]>;
  enterpriseParkAnnouncementResults(): Promise<
    EnterpriseParkAnnouncementResult[]
  >;
  enterpriseParkSurveyResults(): Promise<EnterpriseParkSurveyResult[]>;
  enterpriseParkPublicationRead(id: string): Promise<EnterpriseParkPublication>;
  enterpriseParkSurveySubmit(
    id: string,
    responseData: Record<string, string>,
  ): Promise<EnterpriseParkPublication>;
  enterpriseParkResources(): Promise<EnterpriseParkResources>;
  enterpriseOrganizationInviteGet(): Promise<EnterpriseOrganizationInviteContext>;
  enterpriseOrganizationInviteIssue(input?: {
    defaultDepartment?: string | null;
    departmentId?: string | null;
    positionId?: string | null;
    positionTitle?: string | null;
    defaultRole?: string | null;
    maxUses?: number | null;
  }): Promise<
    EnterpriseOrganizationInviteContext & {
      invite: EnterpriseOrganizationInvite;
    }
  >;
  enterpriseTicketInbox(): Promise<EnterpriseRepairTicket[]>;
  enterpriseTicketList(): Promise<EnterpriseRepairTicket[]>;
  enterpriseTicketSubmit(input: {
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
  }): Promise<EnterpriseRepairTicket>;
  enterpriseTicketRead(id: string): Promise<EnterpriseRepairTicket>;
  enterpriseTicketAction(
    id: string,
    input: {
      action:
        'respond' | 'accept' | 'complete' | 'confirm' | 'respond_and_transfer';
      responseType?: string;
      responseText?: string;
      transferDepartment?: string;
      transferNote?: string;
    },
  ): Promise<EnterpriseRepairTicket>;
  parkNativeNotify(title: string, body: string): Promise<boolean>;
  /** 将文本写入系统剪贴板（通过 IPC 调用 main 进程 clipboard 模块，不受 renderer 权限限制）。 */
  writeClipboard(text: string): Promise<boolean>;
}

// ── 退避参数 ──
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

let ws: WebSocket | undefined;
let currentEndpoint: ServerEndpoint | null = null;
/** 是否处于「期望连接」状态：true 时断线自动重连；disconnect() 置 false。 */
let wantConnected = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

const frameHandlers = new Set<FrameHandler>();
const connectionHandlers = new Set<ConnectionHandler>();
/** 连接前积压的出站帧，连上后按序 flush。 */
const sendQueue: ClientToServer[] = [];

function notifyConnection(connected: boolean): void {
  for (const h of connectionHandlers) {
    try {
      h(connected);
    } catch {
      // 单个 handler 抛错不影响其余。
    }
  }
}

function dispatchFrame(frame: ServerToClient): void {
  if ((frame as { type: string }).type === 'external_inbound_notification') {
    const notificationFrame =
      frame as unknown as ExternalInboundNotificationFrame;
    void ipcRenderer
      .invoke(IPC.notificationShow, notificationFrame.payload)
      .catch(() => undefined);
    // 不经 renderer React 生命周期：窗口隐藏、切在其它会话或 UI 重载时，
    // preload 仍会把全局入站帧直接交给 main NotificationService。
    return;
  }
  if ((frame as { type: string }).type === 'incremental_update_available') {
    const updateFrame = frame as { payload?: { manifestUrl?: unknown } };
    const manifestUrl = updateFrame.payload?.manifestUrl;
    if (typeof manifestUrl === 'string' && manifestUrl.trim()) {
      void ipcRenderer
        .invoke(IPC.incrementalUpdateCheck, { manifestUrl })
        .catch(() => undefined);
    }
  }
  for (const h of frameHandlers) {
    try {
      h(frame);
    } catch {
      // 单个 handler 抛错不影响其余。
    }
  }
}

async function getEndpoint(): Promise<ServerEndpoint | null> {
  return (await ipcRenderer.invoke(IPC.getEndpoint)) as ServerEndpoint | null;
}

/** flush 连接前积压的帧。 */
function flushQueue(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (sendQueue.length > 0) {
    const frame = sendQueue.shift()!;
    if (hasOutboundPathReference(frame)) {
      // 防御旧队列/未来回归：路径引用必须针对当前连接重新走 main 授权，绝不
      // 在重连、登出或账号切换后复用队列里的裸 realpath。
      if (frame.type === 'send_user_message') {
        dispatchFrame({
          type: 'error',
          payload: {
            sessionId: frame.payload.sessionId,
            code: 'file_access_denied',
            message: '连接已变化，附件授权已失效，请重新发送',
          },
        });
      }
      continue;
    }
    ws.send(JSON.stringify(frame));
  }
}

/** 安排一次退避重连（仅在 wantConnected 时）。 */
function scheduleReconnect(): void {
  if (!wantConnected || reconnectTimer) return;
  const wait = Math.min(
    RECONNECT_BASE_MS * 2 ** reconnectAttempt,
    RECONNECT_MAX_MS,
  );
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void openSocket();
  }, wait);
}

/** 实际建立 WS 连接（解析端点 → new WebSocket → 绑事件）。 */
function openSocket(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    void (async () => {
      const ep = currentEndpoint ?? (await getEndpoint());
      currentEndpoint = ep;
      if (!ep) {
        // 没端点，安排重试（端点变更会即时触发，不必密集轮询）。
        scheduleReconnect();
        resolve(false);
        return;
      }
      try {
        const socket = new WebSocket(serverWebSocketUrl(ep));
        ws = socket;

        socket.addEventListener('open', () => {
          reconnectAttempt = 0;
          // 握手帧（welcome 由 server 回）。
          socket.send(
            JSON.stringify({
              type: 'hello',
              payload: {
                protocolVersion: ep.protocolVersion,
                clientKind: 'desktop',
              },
            } satisfies ClientToServer),
          );
          flushQueue();
          notifyConnection(true);
          resolve(true);
        });

        socket.addEventListener('message', (e: MessageEvent) => {
          let frame: ServerToClient;
          try {
            frame = JSON.parse(String(e.data)) as ServerToClient;
          } catch {
            return;
          }
          dispatchFrame(frame);
        });

        socket.addEventListener('close', () => {
          if (ws === socket) ws = undefined;
          notifyConnection(false);
          scheduleReconnect();
        });

        socket.addEventListener('error', () => {
          // error 后通常紧跟 close；resolve(false) 表示本次未连上。
          resolve(false);
        });
      } catch {
        scheduleReconnect();
        resolve(false);
      }
    })();
  });
}

const bridge: OttoBridge = {
  async connect(): Promise<boolean> {
    wantConnected = true;
    if (ws && ws.readyState === WebSocket.OPEN) return true;
    return openSocket();
  },

  disconnect(): void {
    wantConnected = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        // 忽略关闭异常。
      }
      ws = undefined;
    }
    notifyConnection(false);
  },

  send(frame: ClientToServer): void {
    const sendOrQueue = (authorized: ClientToServer): void => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(authorized));
      } else {
        // 连接前（或重连中）排队，open 后 flush —— 对齐 webview
        // multiSessionMessageService 的 ready 前排队行为。
        sendQueue.push(authorized);
      }
    };
    if (frame.type !== 'send_user_message') {
      sendOrQueue(frame);
      return;
    }
    if (!hasOutboundPathReference(frame)) {
      sendOrQueue(frame);
      return;
    }
    void authorizeOutboundFileReferences(
      frame,
      (filePaths) =>
        ipcRenderer.invoke(IPC.authorizeMessageFiles, filePaths) as Promise<
          string[]
        >,
    )
      .then((authorized) => {
        sendAuthorizedFileFrame(
          authorized,
          Boolean(ws && ws.readyState === WebSocket.OPEN),
          (readyFrame) => ws!.send(JSON.stringify(readyFrame)),
        );
      })
      .catch((error: unknown) => {
        dispatchFrame({
          type: 'error',
          payload: {
            sessionId: frame.payload.sessionId,
            code: 'file_access_denied',
            message:
              error instanceof Error
                ? error.message
                : '附件未获得授权，消息未发送',
          },
        });
      });
  },

  onFrame(handler: FrameHandler): () => void {
    frameHandlers.add(handler);
    return () => frameHandlers.delete(handler);
  },

  onConnectionChange(handler: ConnectionHandler): () => void {
    connectionHandlers.add(handler);
    // 立即以当前状态回调一次，便于 UI 初始化。
    try {
      handler(bridge.isConnected());
    } catch {
      // 忽略初始回调异常。
    }
    return () => connectionHandlers.delete(handler);
  },

  isConnected(): boolean {
    return !!ws && ws.readyState === WebSocket.OPEN;
  },

  onMenu(handler: MenuHandler): () => void {
    // 仿 endpointChanged 订阅：_e 由 Electron 推断（IpcRendererEvent），action 显式为 string。
    const listener = (_e: Electron.IpcRendererEvent, action: string): void =>
      handler(action);
    ipcRenderer.on(IPC.menu, listener);
    return () => {
      ipcRenderer.removeListener(IPC.menu, listener);
    };
  },

  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>;
  },

  openPath(path: string): Promise<void> {
    return ipcRenderer.invoke(IPC.openPath, path) as Promise<void>;
  },

  inspectLocalPath(path: string): Promise<{
    exists: boolean;
    kind: 'file' | 'directory' | 'missing';
    canOpen: boolean;
  }> {
    return ipcRenderer.invoke(IPC.inspectLocalPath, path) as Promise<{
      exists: boolean;
      kind: 'file' | 'directory' | 'missing';
      canOpen: boolean;
    }>;
  },

  activateLocalPath(
    path: string,
    action: 'open' | 'reveal',
  ): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(IPC.activateLocalPath, path, action) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  },

  selectFiles(): Promise<string[]> {
    return ipcRenderer.invoke(IPC.selectFiles) as Promise<string[]>;
  },

  getPathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  async authorizeFileForAttachment(file: File): Promise<string> {
    let filePath = '';
    try {
      filePath = webUtils.getPathForFile(file);
    } catch {
      filePath = '';
    }
    if (!filePath) throw new Error('无法获取所选文件的真实路径');
    return ipcRenderer.invoke(
      IPC.grantBrowserFile,
      filePath,
    ) as Promise<string>;
  },

  readFilePath(filePath: string): Promise<{
    filePath: string;
    fileName: string;
    size: number;
    mimeType: string;
    data: string;
  }> {
    return ipcRenderer.invoke(IPC.readFilePath, filePath) as Promise<{
      filePath: string;
      fileName: string;
      size: number;
      mimeType: string;
      data: string;
    }>;
  },
  extractEditableDocument(filePath: string): Promise<{
    filePath: string;
    fileName: string;
    sourceFormat: 'text' | 'markdown' | 'docx' | 'pdf';
    editableFormat: 'markdown';
    content: string;
    readonly: boolean;
    message: string;
  }> {
    return ipcRenderer.invoke(
      IPC.extractEditableDocument,
      filePath,
    ) as Promise<{
      filePath: string;
      fileName: string;
      sourceFormat: 'text' | 'markdown' | 'docx' | 'pdf';
      editableFormat: 'markdown';
      content: string;
      readonly: boolean;
      message: string;
    }>;
  },

  exportEditedDocument(
    sourcePath: string,
    suggestedFileName: string,
    content: string,
  ): Promise<{
    ok: boolean;
    path: string;
    format: 'text' | 'markdown' | 'docx' | 'pdf';
    message: string;
  } | null> {
    return ipcRenderer.invoke(
      IPC.exportEditedDocument,
      sourcePath,
      suggestedFileName,
      content,
    ) as Promise<{
      ok: boolean;
      path: string;
      format: 'text' | 'markdown' | 'docx' | 'pdf';
      message: string;
    } | null>;
  },

  openVideoEditor(): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(IPC.openVideoEditor) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  },

  saveTextFile(
    suggestedFileName: string,
    content: string,
  ): Promise<string | null> {
    return ipcRenderer.invoke(
      IPC.saveTextFile,
      suggestedFileName,
      content,
    ) as Promise<string | null>;
  },
  feishuStart(): Promise<{ text: string; pid?: number }> {
    return ipcRenderer.invoke('otto:feishu-start') as Promise<{
      text: string;
      pid?: number;
    }>;
  },
  feishuStop(): Promise<{ text: string }> {
    return ipcRenderer.invoke('otto:feishu-stop') as Promise<{ text: string }>;
  },
  feishuStatus(): Promise<{
    text: string;
    running: boolean;
    feishu?: FeishuStatusDetail;
  }> {
    return ipcRenderer.invoke('otto:feishu-status') as Promise<{
      text: string;
      running: boolean;
      feishu?: FeishuStatusDetail;
    }>;
  },
  feishuGetConfig(): Promise<FeishuConfigResult> {
    return ipcRenderer.invoke(
      'otto:feishu-get-config',
    ) as Promise<FeishuConfigResult>;
  },
  feishuSaveConfig(body: FeishuConfigSaveRequest): Promise<FeishuConfigResult> {
    return ipcRenderer.invoke(
      'otto:feishu-save-config',
      body,
    ) as Promise<FeishuConfigResult>;
  },
  feishuClearConfig(): Promise<FeishuConfigResult> {
    return ipcRenderer.invoke(
      'otto:feishu-clear-config',
    ) as Promise<FeishuConfigResult>;
  },
  parkConfig(): Promise<ParkServicesConfig | null> {
    return ipcRenderer.invoke(
      'otto:park-config',
    ) as Promise<ParkServicesConfig | null>;
  },
  themeGet(): Promise<'system' | 'light' | 'dark'> {
    return ipcRenderer.invoke('otto:theme-get') as Promise<
      'system' | 'light' | 'dark'
    >;
  },
  themeSet(
    v: 'system' | 'light' | 'dark',
  ): Promise<'system' | 'light' | 'dark'> {
    return ipcRenderer.invoke('otto:theme-set', v) as Promise<
      'system' | 'light' | 'dark'
    >;
  },
  skillLeaderboard(teamId?: string): Promise<{
    leaderboard: string;
    starBoard: string;
    tabs: Array<{ id: string; label: string; icon: string }>;
  }> {
    return ipcRenderer.invoke('otto:skill-leaderboard', teamId) as Promise<{
      leaderboard: string;
      starBoard: string;
      tabs: Array<{ id: string; label: string; icon: string }>;
    }>;
  },
  workLogToday(): Promise<{
    summary: string;
    date: string;
    totalActions: number;
    workResults: number;
  }> {
    return ipcRenderer.invoke('otto:worklog-today') as Promise<{
      summary: string;
      date: string;
      totalActions: number;
      workResults: number;
    }>;
  },
  workLogRecent(days?: number): Promise<
    Array<{
      date: string;
      entries: Array<{
        time: string;
        category: string;
        action: string;
        success: boolean;
        details?: string;
        entryType: 'tool' | 'work_result';
        taskTitle?: string;
      }>;
    }>
  > {
    return ipcRenderer.invoke('otto:worklog-recent', days) as Promise<
      Array<{
        date: string;
        entries: Array<{
          time: string;
          category: string;
          action: string;
          success: boolean;
          details?: string;
          entryType: 'tool' | 'work_result';
          taskTitle?: string;
        }>;
      }>
    >;
  },
  workLogReport(): Promise<{
    ok: boolean;
    date: string;
    title: string;
    markdown: string;
    html?: string;
    path: string;
    message: string;
  }> {
    return ipcRenderer.invoke('otto:worklog-report') as Promise<{
      ok: boolean;
      date: string;
      title: string;
      markdown: string;
      html?: string;
      path: string;
      message: string;
    }>;
  },
  createDiagnosticBundle(): Promise<{
    ok: boolean;
    path: string;
    fileCount: number;
    message: string;
  }> {
    return ipcRenderer.invoke('otto:create-diagnostic-bundle') as Promise<{
      ok: boolean;
      path: string;
      fileCount: number;
      message: string;
    }>;
  },
  runtimeDiagnostic(): Promise<DesktopRuntimeDiagnostic> {
    return ipcRenderer.invoke(IPC.runtimeDiagnostic) as Promise<DesktopRuntimeDiagnostic>;
  },
  skillShareList(teamId?: string): Promise<{ text: string }> {
    return ipcRenderer.invoke('otto:skill-share-list', teamId) as Promise<{
      text: string;
    }>;
  },
  skillMarketplace(): Promise<{ text: string }> {
    return ipcRenderer.invoke('otto:skill-marketplace') as Promise<{
      text: string;
    }>;
  },
  enterpriseSkillLocalList() {
    return ipcRenderer.invoke(IPC.enterpriseSkillLocalList) as Promise<
      LocalSkillShareCandidate[]
    >;
  },
  enterpriseSkillList(input = {}) {
    return ipcRenderer.invoke(IPC.enterpriseSkillList, input) as Promise<
      EnterpriseSkillMarketItem[]
    >;
  },
  enterpriseSkillSubmit(input) {
    return ipcRenderer.invoke(IPC.enterpriseSkillSubmit, input) as Promise<{
      outcome: 'submitted' | 'exists';
      skill: EnterpriseSkillMarketItem;
    }>;
  },
  enterpriseSkillReview(id, action, visibility) {
    return ipcRenderer.invoke(IPC.enterpriseSkillReview, {
      id,
      action,
      visibility,
    }) as Promise<EnterpriseSkillMarketItem>;
  },
  enterpriseSkillInstall(id) {
    return ipcRenderer.invoke(IPC.enterpriseSkillInstall, { id }) as Promise<{
      skill: EnterpriseSkillMarketItem;
      installedPath: string;
    }>;
  },
  enterpriseSkillRate(id, score) {
    return ipcRenderer.invoke(IPC.enterpriseSkillRate, {
      id,
      score,
    }) as Promise<EnterpriseSkillMarketItem>;
  },
  enterpriseSkillLeaderboard() {
    return ipcRenderer.invoke(
      IPC.enterpriseSkillLeaderboard,
    ) as Promise<EnterpriseSkillLeaderboard>;
  },
  setLocalTestUrl(url: string): Promise<void> {
    return ipcRenderer.invoke(IPC.setLocalTestUrl, url) as Promise<void>;
  },
  appVersion(): Promise<string> {
    return ipcRenderer.invoke(IPC.appVersion) as Promise<string>;
  },
  updateCheck(): Promise<UpdateCheckResult> {
    return ipcRenderer.invoke(IPC.updateCheck) as Promise<UpdateCheckResult>;
  },
  updateDownload(): Promise<UpdateDownloadResult> {
    return ipcRenderer.invoke(
      IPC.updateDownload,
    ) as Promise<UpdateDownloadResult>;
  },
  updateCancel(): Promise<void> {
    return ipcRenderer.invoke(IPC.updateCancel) as Promise<void>;
  },
  updateInstall(): Promise<UpdateInstallResult> {
    return ipcRenderer.invoke(
      IPC.updateInstall,
    ) as Promise<UpdateInstallResult>;
  },
  incrementalUpdateCheck(input?: {
    manifestUrl?: string;
  }): Promise<IncrementalUpdateCheckResult> {
    return ipcRenderer.invoke(
      IPC.incrementalUpdateCheck,
      input,
    ) as Promise<IncrementalUpdateCheckResult>;
  },
  incrementalUpdateApply(input: {
    kind: IncrementalUpdateKind;
    id: string;
  }): Promise<IncrementalUpdateApplyResult> {
    return ipcRenderer.invoke(
      IPC.incrementalUpdateApply,
      input,
    ) as Promise<IncrementalUpdateApplyResult>;
  },
  onUpdateProgress(
    handler: (progress: UpdateProgressInfo) => void,
  ): () => void {
    // 仿 onMenu 订阅：进度帧由 main 的 UpdateService 节流推送。
    const listener = (
      _e: Electron.IpcRendererEvent,
      progress: UpdateProgressInfo,
    ): void => handler(progress);
    ipcRenderer.on(IPC.updateProgress, listener);
    return () => {
      ipcRenderer.removeListener(IPC.updateProgress, listener);
    };
  },
  notificationShow(payload: {
    sessionId: string;
    source: string;
    sender?: string;
    title?: string;
    preview: string;
    messageId?: string;
    persistent?: boolean;
  }): Promise<void> {
    return ipcRenderer.invoke(IPC.notificationShow, payload) as Promise<void>;
  },
  notificationMarkRead(sessionId: string): Promise<void> {
    return ipcRenderer.invoke(
      IPC.notificationMarkRead,
      sessionId,
    ) as Promise<void>;
  },
  notificationGetUnread(): Promise<string[]> {
    return ipcRenderer.invoke(IPC.notificationGetUnread) as Promise<string[]>;
  },
  notificationCheckPermission(): Promise<boolean> {
    return ipcRenderer.invoke(
      IPC.notificationCheckPermission,
    ) as Promise<boolean>;
  },
  onNotificationUnreadChanged(cb: (unread: string[]) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, unread: string[]): void =>
      cb(unread);
    ipcRenderer.on(IPC.notificationUnreadChanged, listener);
    return () =>
      ipcRenderer.removeListener(IPC.notificationUnreadChanged, listener);
  },
  onNotificationSessionOpen(cb: (sessionId: string) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, sessionId: string): void =>
      cb(sessionId);
    ipcRenderer.on(IPC.notificationSessionOpen, listener);
    return () =>
      ipcRenderer.removeListener(IPC.notificationSessionOpen, listener);
  },
  voiceGetConfig(): Promise<VoicePublicConfig> {
    return ipcRenderer.invoke(IPC.voiceGetConfig) as Promise<VoicePublicConfig>;
  },
  voiceSaveConfig(config: VoiceConfigInput): Promise<VoicePublicConfig> {
    return ipcRenderer.invoke(
      IPC.voiceSaveConfig,
      config,
    ) as Promise<VoicePublicConfig>;
  },
  voiceTranscribe(bytes: Uint8Array, mimeType: string): Promise<VoiceResult> {
    return ipcRenderer.invoke(
      IPC.voiceTranscribe,
      bytes,
      mimeType,
    ) as Promise<VoiceResult>;
  },
  autoGeneratedAgentProfiles(): Promise<AutoGeneratedAgentProfile[]> {
    return ipcRenderer.invoke(IPC.autoGeneratedAgentProfiles) as Promise<
      AutoGeneratedAgentProfile[]
    >;
  },
  enterpriseSession(): Promise<EnterpriseSessionState> {
    return ipcRenderer.invoke(
      IPC.enterpriseSession,
    ) as Promise<EnterpriseSessionState>;
  },
  enterprisePasswordLogin(input: {
    serverUrl: string;
    identifier: string;
    password: string;
  }): Promise<{
    serverUrl: string;
    account: EnterpriseAccount;
    expiresAt: string;
  }> {
    return ipcRenderer.invoke(IPC.enterprisePasswordLogin, input) as Promise<{
      serverUrl: string;
      account: EnterpriseAccount;
      expiresAt: string;
    }>;
  },
  enterpriseSmsLoginRequest(input: {
    serverUrl: string;
    phone: string;
  }): Promise<EnterpriseSmsLoginChallenge> {
    return ipcRenderer.invoke(
      IPC.enterpriseSmsLoginRequest,
      input,
    ) as Promise<EnterpriseSmsLoginChallenge>;
  },
  enterpriseSmsLoginVerify(input: {
    challengeId: string;
    code: string;
  }): Promise<{
    serverUrl: string;
    account: EnterpriseAccount;
    expiresAt: string;
  }> {
    return ipcRenderer.invoke(IPC.enterpriseSmsLoginVerify, input) as Promise<{
      serverUrl: string;
      account: EnterpriseAccount;
      expiresAt: string;
    }>;
  },
  enterpriseRegistrationRequest(input: {
    serverUrl: string;
    phone: string;
    inviteCode?: string;
  }): Promise<EnterpriseSmsChallenge> {
    return ipcRenderer.invoke(
      IPC.enterpriseRegistrationRequest,
      input,
    ) as Promise<EnterpriseSmsChallenge>;
  },
  enterpriseRegistrationIntent(): Promise<EnterpriseRegistrationIntent | null> {
    return ipcRenderer.invoke(
      IPC.enterpriseRegistrationIntent,
    ) as Promise<EnterpriseRegistrationIntent | null>;
  },
  onEnterpriseRegistrationIntent(
    handler: (intent: EnterpriseRegistrationIntent) => void,
  ): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      intent: EnterpriseRegistrationIntent,
    ): void => handler(intent);
    ipcRenderer.on(IPC.enterpriseRegistrationIntentOpened, listener);
    return () =>
      ipcRenderer.removeListener(
        IPC.enterpriseRegistrationIntentOpened,
        listener,
      );
  },
  onEnterpriseSessionInvalidated(handler: () => void): () => void {
    const listener = (): void => handler();
    ipcRenderer.on(IPC.enterpriseSessionInvalidated, listener);
    return () =>
      ipcRenderer.removeListener(IPC.enterpriseSessionInvalidated, listener);
  },
  onEnterpriseAccountUpdated(
    handler: (account: EnterpriseAccount) => void,
  ): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      account: EnterpriseAccount,
    ): void => {
      handler(account);
    };
    ipcRenderer.on(IPC.enterpriseAccountUpdated, listener);
    return () =>
      ipcRenderer.removeListener(IPC.enterpriseAccountUpdated, listener);
  },
  enterpriseRegister(input: {
    challengeId: string;
    code: string;
    name: string;
    password: string;
    legalConsent: true;
  }): Promise<{
    serverUrl: string;
    account: EnterpriseAccount;
    expiresAt: string;
  }> {
    return ipcRenderer.invoke(IPC.enterpriseRegister, input) as Promise<{
      serverUrl: string;
      account: EnterpriseAccount;
      expiresAt: string;
    }>;
  },
  enterpriseJoinOrganization(input: {
    inviteCode: string;
  }): Promise<{ serverUrl: string; account: EnterpriseAccount }> {
    return ipcRenderer.invoke(
      IPC.enterpriseJoinOrganization,
      input,
    ) as Promise<{
      serverUrl: string;
      account: EnterpriseAccount;
    }>;
  },
  enterpriseLogout(): Promise<void> {
    return ipcRenderer.invoke(IPC.enterpriseLogout) as Promise<void>;
  },
  enterprisePair(token: string) {
    return ipcRenderer.invoke(IPC.enterprisePair, token) as Promise<{
      ok: boolean;
      message: string;
      enterpriseUrl?: string;
    }>;
  },
  enterpriseAccounts(): Promise<EnterpriseAccount[]> {
    return ipcRenderer.invoke(IPC.enterpriseAccounts) as Promise<
      EnterpriseAccount[]
    >;
  },
  enterpriseAccountCreate(
    input: EnterpriseAccountCreateInput,
  ): Promise<EnterpriseAccount> {
    return ipcRenderer.invoke(
      IPC.enterpriseAccountCreate,
      input,
    ) as Promise<EnterpriseAccount>;
  },
  enterpriseAccountUpdate(
    id: string,
    input: EnterpriseAccountUpdateInput,
  ): Promise<EnterpriseAccount> {
    return ipcRenderer.invoke(
      IPC.enterpriseAccountUpdate,
      id,
      input,
    ) as Promise<EnterpriseAccount>;
  },
  enterpriseAccountDelete(id: string): Promise<{ id: string; deleted: true }> {
    return ipcRenderer.invoke(IPC.enterpriseAccountDelete, id) as Promise<{
      id: string;
      deleted: true;
    }>;
  },
  enterpriseDataGovernanceGet(): Promise<EnterpriseDataGovernanceProfile> {
    return ipcRenderer.invoke(
      IPC.enterpriseDataGovernanceGet,
    ) as Promise<EnterpriseDataGovernanceProfile>;
  },
  enterpriseLegalAccept(): Promise<EnterpriseDataGovernanceProfile> {
    return ipcRenderer.invoke(
      IPC.enterpriseLegalAccept,
    ) as Promise<EnterpriseDataGovernanceProfile>;
  },
  enterprisePrivacyExport(): Promise<{ ok: true; path: string } | null> {
    return ipcRenderer.invoke(IPC.enterprisePrivacyExport) as Promise<{
      ok: true;
      path: string;
    } | null>;
  },
  enterprisePrivacyDelete(input: {
    password: string;
    confirmation: string;
  }): Promise<EnterprisePrivacyDeletionReceipt> {
    return ipcRenderer.invoke(
      IPC.enterprisePrivacyDelete,
      input,
    ) as Promise<EnterprisePrivacyDeletionReceipt>;
  },
  enterpriseUsageRecord(input: EnterpriseTokenUsageInput): Promise<{
    recorded: boolean;
    source: 'client_reported';
  }> {
    return ipcRenderer.invoke(IPC.enterpriseUsageRecord, input) as Promise<{
      recorded: boolean;
      source: 'client_reported';
    }>;
  },
  enterpriseKnowledgeRecord(
    input: EnterpriseKnowledgeRecordInput,
  ): Promise<EnterpriseKnowledgeRecordResult> {
    return ipcRenderer.invoke(
      IPC.enterpriseKnowledgeRecord,
      input,
    ) as Promise<EnterpriseKnowledgeRecordResult>;
  },
  enterpriseKnowledgeList(input?: {
    query?: string;
    department?: string;
    includeReview?: boolean;
    status?: EnterpriseKnowledgeItem['status'];
  }): Promise<EnterpriseKnowledgeItem[]> {
    return ipcRenderer.invoke(
      IPC.enterpriseKnowledgeList,
      input ?? {},
    ) as Promise<EnterpriseKnowledgeItem[]>;
  },
  enterpriseKnowledgeReview(
    id: string,
    action: 'approve' | 'archive',
    note?: string,
  ): Promise<EnterpriseKnowledgeItem> {
    return ipcRenderer.invoke(IPC.enterpriseKnowledgeReview, {
      id,
      action,
      note,
    }) as Promise<EnterpriseKnowledgeItem>;
  },
  enterpriseKnowledgeRevise(id, input) {
    return ipcRenderer.invoke(IPC.enterpriseKnowledgeRevise, {
      id,
      input,
    }) as Promise<EnterpriseKnowledgeItem>;
  },
  enterpriseKnowledgeRevisions(id) {
    return ipcRenderer.invoke(IPC.enterpriseKnowledgeRevisions, {
      id,
    }) as Promise<EnterpriseKnowledgeRevision[]>;
  },
  enterpriseOrganizationView(): Promise<EnterpriseOrganizationView> {
    return ipcRenderer.invoke(
      IPC.enterpriseOrganizationView,
    ) as Promise<EnterpriseOrganizationView>;
  },
  enterprisePresenceHeartbeat(): Promise<void> {
    return ipcRenderer.invoke(IPC.enterprisePresenceHeartbeat) as Promise<void>;
  },
  enterpriseOrganizationFeaturesGet(): Promise<EnterpriseOrganizationFeatures> {
    return ipcRenderer.invoke(
      IPC.enterpriseOrganizationFeaturesGet,
    ) as Promise<EnterpriseOrganizationFeatures>;
  },
  enterpriseOrganizationFeaturesUpdate(
    patch: Partial<EnterpriseOrganizationFeatures>,
  ): Promise<EnterpriseOrganizationFeatures> {
    return ipcRenderer.invoke(
      IPC.enterpriseOrganizationFeaturesUpdate,
      patch,
    ) as Promise<EnterpriseOrganizationFeatures>;
  },
  enterpriseOrganizationDepartments(): Promise<
    EnterpriseOrganizationDepartment[]
  > {
    return ipcRenderer.invoke(IPC.enterpriseOrganizationDepartments) as Promise<
      EnterpriseOrganizationDepartment[]
    >;
  },
  enterpriseOrganizationDepartmentCreate(
    name: string,
  ): Promise<EnterpriseOrganizationDepartment> {
    return ipcRenderer.invoke(
      IPC.enterpriseOrganizationDepartmentCreate,
      name,
    ) as Promise<EnterpriseOrganizationDepartment>;
  },
  enterpriseOrganizationDepartmentUpdate(
    id: string,
    name: string,
  ): Promise<EnterpriseOrganizationDepartment> {
    return ipcRenderer.invoke(
      IPC.enterpriseOrganizationDepartmentUpdate,
      id,
      name,
    ) as Promise<EnterpriseOrganizationDepartment>;
  },
  enterpriseOrganizationDepartmentDelete(id: string): Promise<boolean> {
    return ipcRenderer.invoke(
      IPC.enterpriseOrganizationDepartmentDelete,
      id,
    ) as Promise<boolean>;
  },
  enterpriseOrganizationPositionCreate(input: {
    departmentId: string;
    title: string;
    roleMapping: EnterprisePositionRoleMapping;
  }): Promise<EnterpriseOrganizationPosition> {
    return ipcRenderer.invoke(
      IPC.enterpriseOrganizationPositionCreate,
      input,
    ) as Promise<EnterpriseOrganizationPosition>;
  },
  enterpriseOrganizationPositionUpdate(
    id: string,
    input: {
      title?: string;
      roleMapping?: EnterprisePositionRoleMapping;
    },
  ): Promise<EnterpriseOrganizationPosition> {
    return ipcRenderer.invoke(
      IPC.enterpriseOrganizationPositionUpdate,
      id,
      input,
    ) as Promise<EnterpriseOrganizationPosition>;
  },
  enterpriseOrganizationPositionDelete(id: string): Promise<boolean> {
    return ipcRenderer.invoke(
      IPC.enterpriseOrganizationPositionDelete,
      id,
    ) as Promise<boolean>;
  },
  enterpriseMessagesList(
    peerAccountId: string,
  ): Promise<EnterpriseDirectMessage[]> {
    return ipcRenderer.invoke(
      IPC.enterpriseMessagesList,
      peerAccountId,
    ) as Promise<EnterpriseDirectMessage[]>;
  },
  enterpriseMessagesUnread(): Promise<EnterpriseUnreadMessageNotification[]> {
    return ipcRenderer.invoke(IPC.enterpriseMessagesUnread) as Promise<
      EnterpriseUnreadMessageNotification[]
    >;
  },
  enterpriseMessageSend(
    peerAccountId: string,
    content: string,
    attachments: EnterpriseDirectMessageAttachmentUpload[] = [],
  ): Promise<EnterpriseDirectMessage> {
    return ipcRenderer.invoke(
      IPC.enterpriseMessageSend,
      peerAccountId,
      content,
      attachments,
    ) as Promise<EnterpriseDirectMessage>;
  },
  enterpriseMessageAttachmentRead(
    attachmentId: string,
  ): Promise<EnterpriseDirectMessageAttachmentDownload> {
    return ipcRenderer.invoke(
      IPC.enterpriseMessageAttachmentRead,
      attachmentId,
    ) as Promise<EnterpriseDirectMessageAttachmentDownload>;
  },
  enterpriseE2eeDevicesList(): Promise<EnterpriseE2eeDevice[]> {
    return ipcRenderer.invoke(IPC.enterpriseE2eeDevicesList) as Promise<
      EnterpriseE2eeDevice[]
    >;
  },
  enterpriseE2eeKeyTransparency(): Promise<EnterpriseE2eeKeyTransparencyView> {
    return ipcRenderer.invoke(
      IPC.enterpriseE2eeKeyTransparency,
    ) as Promise<EnterpriseE2eeKeyTransparencyView>;
  },
  enterpriseE2eeDeviceApprove(deviceId: string): Promise<EnterpriseE2eeDevice> {
    return ipcRenderer.invoke(
      IPC.enterpriseE2eeDeviceApprove,
      deviceId,
    ) as Promise<EnterpriseE2eeDevice>;
  },
  enterpriseE2eeDeviceVerification(
    deviceId: string,
  ): Promise<EnterpriseE2eeDeviceVerification> {
    return ipcRenderer.invoke(
      IPC.enterpriseE2eeDeviceVerification,
      deviceId,
    ) as Promise<EnterpriseE2eeDeviceVerification>;
  },
  enterpriseE2eeDeviceRevoke(deviceId: string): Promise<void> {
    return ipcRenderer.invoke(
      IPC.enterpriseE2eeDeviceRevoke,
      deviceId,
    ) as Promise<void>;
  },
  enterpriseE2eeRecoveryExport(passphrase: string): Promise<string> {
    return ipcRenderer.invoke(
      IPC.enterpriseE2eeRecoveryExport,
      passphrase,
    ) as Promise<string>;
  },
  enterpriseE2eeRecoveryImport(
    bundle: string,
    passphrase: string,
  ): Promise<void> {
    return ipcRenderer.invoke(
      IPC.enterpriseE2eeRecoveryImport,
      bundle,
      passphrase,
    ) as Promise<void>;
  },
  enterpriseAtoaInbox(): Promise<EnterpriseAtoaInboxMessage[]> {
    return ipcRenderer.invoke(IPC.enterpriseAtoaInbox) as Promise<
      EnterpriseAtoaInboxMessage[]
    >;
  },
  enterpriseParkServicePush(input: {
    recipientAccountId: string;
    serviceId: string;
    note?: string | null;
  }): Promise<{
    message?: EnterpriseDirectMessage;
    publication?: EnterpriseParkPublication;
    recipientCount?: number;
  }> {
    return ipcRenderer.invoke(IPC.enterpriseParkServicePush, input) as Promise<{
      message?: EnterpriseDirectMessage;
      publication?: EnterpriseParkPublication;
      recipientCount?: number;
    }>;
  },
  enterpriseParkView(): Promise<EnterprisePark | null> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkView,
    ) as Promise<EnterprisePark | null>;
  },
  enterpriseParkRegister(input: {
    name: string;
    slug?: string;
    brandName?: string;
  }): Promise<EnterprisePark> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkRegister,
      input,
    ) as Promise<EnterprisePark>;
  },
  enterpriseParkJoin(input: {
    inviteCode: string;
    address: string;
    roomNumber: string;
  }): Promise<EnterprisePark> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkJoin,
      input,
    ) as Promise<EnterprisePark>;
  },
  enterpriseParkProfileUpdate(input: {
    address: string;
    roomNumber: string;
  }): Promise<EnterpriseParkTenantProfile> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkProfileUpdate,
      input,
    ) as Promise<EnterpriseParkTenantProfile>;
  },
  enterpriseParkInviteIssue(
    maxUses?: number | null,
  ): Promise<EnterpriseParkInvite> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkInviteIssue,
      maxUses ?? null,
    ) as Promise<EnterpriseParkInvite>;
  },
  enterpriseParkTenants(): Promise<EnterpriseParkTenantOrganization[]> {
    return ipcRenderer.invoke(IPC.enterpriseParkTenants) as Promise<
      EnterpriseParkTenantOrganization[]
    >;
  },
  enterpriseParkStatistics(): Promise<EnterpriseParkStatistics> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkStatistics,
    ) as Promise<EnterpriseParkStatistics>;
  },
  enterpriseParkSpecialists(): Promise<EnterpriseParkSpecialist[]> {
    return ipcRenderer.invoke(IPC.enterpriseParkSpecialists) as Promise<
      EnterpriseParkSpecialist[]
    >;
  },
  enterpriseParkSpecialistSet(
    serviceId: string,
    accountId: string,
  ): Promise<EnterpriseParkSpecialist> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkSpecialistSet,
      serviceId,
      accountId,
    ) as Promise<EnterpriseParkSpecialist>;
  },
  enterpriseParkSpecialistRemove(
    serviceId: string,
    accountId: string,
  ): Promise<boolean> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkSpecialistRemove,
      serviceId,
      accountId,
    ) as Promise<boolean>;
  },
  enterpriseParkServices(): Promise<EnterpriseParkService[]> {
    return ipcRenderer.invoke(IPC.enterpriseParkServices) as Promise<
      EnterpriseParkService[]
    >;
  },
  enterpriseParkServiceUpdate(input: {
    serviceId: string;
    name?: string;
    enabled?: boolean;
    config?: Record<string, string>;
  }): Promise<EnterpriseParkService> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkServiceUpdate,
      input,
    ) as Promise<EnterpriseParkService>;
  },
  enterpriseParkPublications(): Promise<EnterpriseParkPublication[]> {
    return ipcRenderer.invoke(IPC.enterpriseParkPublications) as Promise<
      EnterpriseParkPublication[]
    >;
  },
  enterpriseParkAnnouncementResults(): Promise<
    EnterpriseParkAnnouncementResult[]
  > {
    return ipcRenderer.invoke(IPC.enterpriseParkAnnouncementResults) as Promise<
      EnterpriseParkAnnouncementResult[]
    >;
  },
  enterpriseParkSurveyResults(): Promise<EnterpriseParkSurveyResult[]> {
    return ipcRenderer.invoke(IPC.enterpriseParkSurveyResults) as Promise<
      EnterpriseParkSurveyResult[]
    >;
  },
  enterpriseParkPublicationRead(
    id: string,
  ): Promise<EnterpriseParkPublication> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkPublicationRead,
      id,
    ) as Promise<EnterpriseParkPublication>;
  },
  enterpriseParkSurveySubmit(
    id: string,
    responseData: Record<string, string>,
  ): Promise<EnterpriseParkPublication> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkSurveySubmit,
      id,
      responseData,
    ) as Promise<EnterpriseParkPublication>;
  },
  enterpriseParkResources(): Promise<EnterpriseParkResources> {
    return ipcRenderer.invoke(
      IPC.enterpriseParkResources,
    ) as Promise<EnterpriseParkResources>;
  },
  enterpriseOrganizationInviteGet(): Promise<EnterpriseOrganizationInviteContext> {
    return ipcRenderer.invoke(
      IPC.enterpriseOrganizationInviteGet,
    ) as Promise<EnterpriseOrganizationInviteContext>;
  },
  enterpriseOrganizationInviteIssue(input?: {
    defaultDepartment?: string | null;
    departmentId?: string | null;
    positionId?: string | null;
    positionTitle?: string | null;
    defaultRole?: string | null;
    maxUses?: number | null;
  }): Promise<
    EnterpriseOrganizationInviteContext & {
      invite: EnterpriseOrganizationInvite;
    }
  > {
    return ipcRenderer.invoke(
      IPC.enterpriseOrganizationInviteIssue,
      input ?? {},
    ) as Promise<
      EnterpriseOrganizationInviteContext & {
        invite: EnterpriseOrganizationInvite;
      }
    >;
  },
  enterpriseTicketInbox(): Promise<EnterpriseRepairTicket[]> {
    return ipcRenderer.invoke(IPC.enterpriseTicketInbox) as Promise<
      EnterpriseRepairTicket[]
    >;
  },
  enterpriseTicketList(): Promise<EnterpriseRepairTicket[]> {
    return ipcRenderer.invoke(IPC.enterpriseTicketList) as Promise<
      EnterpriseRepairTicket[]
    >;
  },
  enterpriseTicketSubmit(input: {
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
    return ipcRenderer.invoke(
      IPC.enterpriseTicketSubmit,
      input,
    ) as Promise<EnterpriseRepairTicket>;
  },
  enterpriseTicketRead(id: string): Promise<EnterpriseRepairTicket> {
    return ipcRenderer.invoke(
      IPC.enterpriseTicketRead,
      id,
    ) as Promise<EnterpriseRepairTicket>;
  },
  enterpriseTicketAction(
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
    return ipcRenderer.invoke(
      IPC.enterpriseTicketAction,
      id,
      input,
    ) as Promise<EnterpriseRepairTicket>;
  },
  parkNativeNotify(title: string, body: string): Promise<boolean> {
    return ipcRenderer.invoke(
      IPC.parkNativeNotify,
      title,
      body,
    ) as Promise<boolean>;
  },
  writeClipboard(text: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC.writeClipboard, text) as Promise<boolean>;
  },
};

// 端点变更（main 在发现/拉起 server 后推送）：更新缓存，若期望连接则重连到新端点。
ipcRenderer.on(IPC.endpointChanged, (_e, ep: ServerEndpoint | null) => {
  const changed = serverEndpointChanged(currentEndpoint, ep);
  currentEndpoint = ep;
  if (wantConnected && changed) {
    // 重连到新端点：关旧连接，立即重连（清退避计数）。
    reconnectAttempt = 0;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      ws = undefined;
    }
    void openSocket();
  }
});

contextBridge.exposeInMainWorld('otto', bridge);
