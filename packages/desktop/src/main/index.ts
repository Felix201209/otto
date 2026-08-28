/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Electron 主进程（Issue #4 + #9）。
 *
 * 职责：
 *   1. 建主窗口（含图标占位），加载 renderer（dist/renderer/index.html）。
 *   2. 安全基线：禁 nodeIntegration、开 contextIsolation + sandbox、本地 CSP、
 *      导航/新窗口/权限/webview 全部按白名单收紧。
 *   3. 用 ServerManager 确保有可用 otto-server：发现已运行的就复用，否则
 *      同进程内嵌拉起（embedded-only；随 app 退出而停）。
 *   4. 把发现/拉起的 server 端点经 IPC（拉取 + 主动推送）交给 preload，
 *      供 renderer 建 WS 连接。
 *   5. 完整生命周期：单实例锁、activate、window-all-closed、before-quit、
 *      渲染进程崩溃 / 卡死处置。
 *
 * 注意：package.json 无 "type":"module" → main/preload 均编译为 CJS（Electron 标准，
 * 且 import.meta.url 在 CJS 输出下会被 tsc 直接拒绝/TS1470）。__dirname 用 CJS 原生
 * 全局变量，不需要（也不能用）ESM 的 fileURLToPath(import.meta.url) 重建。
 *
 * 注意：otto-server 是纯 ESM 包，本文件是 CJS：不能静态 `import {...} from 'otto-server'`
 * （会被编译成 require()，真机运行时抛 ERR_REQUIRE_ESM 崩溃）。DEFAULT_HOST/DEFAULT_PORT
 * 只是 CSP 兜底默认值的字面量，这里直接内联同样的值，避免为两个常量单独走一次
 * import()（server-manager.ts 已经承担了对 otto-server 真正需要的值的动态加载）。
 */

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  type NativeImage,
} from 'electron';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HealthInfo, ServerEndpoint } from 'otto-server';
import {
  CustomerModuleHostBroker,
  CustomerModuleRunner,
  parseCustomerModuleManifest,
  scanCustomerModuleWasm,
  validateCustomerModuleArchiveEntries,
  verifyCustomerModuleFileHashes,
} from 'otto-core';
import { WorkspaceDirectoryStore } from './workspace-directory-store.js';
import { MainWindowPresentationController } from './main-window-presentation.js';
import { askWindowCloseChoice } from './window-close-policy.js';

function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') return;
    throw error;
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

/** 脱敏后的飞书配置视图（不含 secret）。 */
interface FeishuConfigPublic {
  appId: string;
  appSecret: string;
  verificationToken: string | null;
  encryptKey: string | null;
}

/** 客户端保存飞书配置的请求体。 */
interface FeishuConfigSaveRequest {
  appId: string;
  appSecret: string;
  verificationToken?: string | null;
  encryptKey?: string | null;
}

/** 根据文件扩展名返回 MIME 类型（用于 readFilePath IPC）。 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx':
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.md': 'text/markdown',
    '.zip': 'application/zip',
    '.log': 'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}

import { ServerManager } from './server-manager.js';
import { resolveKernelUpdateRoot } from './incremental-kernel-store.js';
import { installAppMenu } from './menu.js';
import { UpdateService } from './update-service.js';
import { IncrementalUpdateService } from './incremental-update-service.js';
import {
  checkForUpdateUsingPolicy,
  resolveDesktopDistribution,
} from './update-policy-adapter.js';
import {
  EnterpriseNotificationIdentityBoundary,
  NotificationService,
  type NotificationPayload,
} from './notification-service.js';
import { FileAccessGrantStore } from './file-access-grants.js';
import {
  generateAndSaveWorkReport,
  localDateKey,
  readRecentWorkLogs,
  readWorkLogEntries,
  summarizeWorkLog,
} from './workLogData.js';
import {
  loadVoiceConfig,
  saveVoiceConfig,
  type VoiceConfigInput,
} from './voiceConfig.js';
import { transcribeAudio } from './voiceService.js';
import {
  EnterpriseSkillLibrary,
  type EnterpriseSkillScope,
} from './enterpriseSkillLibrary.js';
import {
  EnterpriseClient,
  EnterpriseJoinStateUncertainError,
  type AccountCreateInput,
  type AccountUpdateInput,
  type EnterpriseAccount,
  type EnterpriseDirectMessageAttachmentUpload,
  type EnterpriseUnreadMessageNotification,
  type EnterpriseLegalDocumentReference,
  type EnterprisePrivacyDeletionReceipt,
  type EnterpriseKnowledgeRecordInput,
  type EnterpriseModuleUpdateDescriptor,
  type EnterpriseOrganizationFeatures,
  type EnterprisePositionRoleMapping,
  type PersonalTokenUsageProfile,
} from './enterprise-client.js';
import {
  clearCustomerModuleData,
  exportCustomerModuleData,
  installCustomerModule,
  listInstalledCustomerModules,
  recoverCustomerModuleInstallReceipts,
  refreshCustomerModuleMarketStatus,
  runInstalledCustomerModule,
  setCustomerModuleEnabled,
  setCustomerModuleBackgroundEnabled,
  uninstallCustomerModule,
} from './customerModuleInstaller.js';
import { createDesktopCustomerModuleHost } from './customerModuleHostAdapter.js';
import { createCustomerModuleModelInvoke } from './customerModuleModelAdapter.js';
import {
  EnterpriseE2eeCrypto,
  EnterpriseE2eeKeyVault,
} from './enterprise-e2ee.js';
import {
  EnterpriseMlsInboundPollScheduler,
  EnterpriseMlsOutboxRetryScheduler,
  EnterpriseMlsSessionCoordinator,
  EnterpriseMlsSessionManager,
} from './enterprise-mls.js';
import {
  EnterpriseMlsPrivateMessageService,
  FileEnterpriseMlsMessageHistory,
} from './enterprise-mls-private-messages.js';
import {
  ENTERPRISE_TRAY_POPOVER_WIDTH,
  enterpriseTrayPopoverHeight,
  positionEnterpriseTrayPopover,
  renderEnterpriseTrayPopoverHtml,
  summarizeEnterpriseTrayContacts,
  type EnterpriseTrayContact,
} from './enterprise-tray-popover.js';

const ENTERPRISE_MESSAGE_ATTACHMENT_MAX_COUNT = 6;
const ENTERPRISE_MESSAGE_ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const ENTERPRISE_MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function normalizeEnterpriseMessageAttachments(
  value: unknown,
  limits: {
    maxFileBytes?: number;
    maxTotalBytes?: number;
  } = {},
): EnterpriseDirectMessageAttachmentUpload[] {
  const maxFileBytes = limits.maxFileBytes ??
    ENTERPRISE_MESSAGE_ATTACHMENT_MAX_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ??
    ENTERPRISE_MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES;
  if (value == null) return [];
  if (
    !Array.isArray(value) ||
    value.length > ENTERPRISE_MESSAGE_ATTACHMENT_MAX_COUNT
  ) {
    throw new Error('附件数量不正确');
  }
  let totalBytes = 0;
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('附件信息不正确');
    const candidate = item as Record<string, unknown>;
    const fileName =
      typeof candidate.fileName === 'string' ? candidate.fileName.trim() : '';
    const mimeType =
      typeof candidate.mimeType === 'string' ? candidate.mimeType.trim() : '';
    const size = Number(candidate.size);
    const data =
      typeof candidate.data === 'string' ? candidate.data.trim() : '';
    const sourcePath =
      typeof candidate.sourcePath === 'string'
        ? candidate.sourcePath.trim()
        : '';
    if (
      !fileName ||
      fileName.length > 260 ||
      !mimeType ||
      !Number.isInteger(size) ||
      size < 0 ||
      size > maxFileBytes ||
      (!data && !sourcePath) ||
      (data && sourcePath)
    ) {
      throw new Error(
        `附件信息不正确或单个附件超过 ${Math.round(maxFileBytes / 1024 / 1024)} MB`,
      );
    }
    if (sourcePath) {
      const granted = fileAccessGrants.resolve(
        sourcePath,
        maxFileBytes,
      );
      if (granted.size !== size) {
        throw new Error('附件在选择后发生变化，请重新选择');
      }
    } else {
      const buffer = Buffer.from(data, 'base64');
      if (buffer.length !== size || buffer.toString('base64') !== data) {
        throw new Error('附件内容不完整');
      }
    }
    totalBytes += size;
    if (totalBytes > maxTotalBytes) {
      throw new Error(
        `每条消息的附件总大小不能超过 ${Math.round(maxTotalBytes / 1024 / 1024)} MB`,
      );
    }
    return sourcePath
      ? { fileName, mimeType, size, sourcePath }
      : { fileName, mimeType, size, data };
  });
}

function normalizeEnterpriseAtoaSources(value: unknown): Array<
  'current_chat' | 'enterprise_knowledge' | 'work_logs' | 'schedules'
> {
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error('A2A 授权范围无效');
  }
  const allowed = [
    'current_chat',
    'enterprise_knowledge',
    'work_logs',
    'schedules',
  ] as const;
  const selected = new Set(value);
  if ([...selected].some((item) => typeof item !== 'string')) {
    throw new Error('A2A 授权范围无效');
  }
  return allowed.filter((source) => selected.has(source));
}

import { AccountDataSyncService } from './account-data-sync.js';
import { EnterpriseSkillUsageReporter } from './enterprise-skill-usage-reporter.js';
import {
  authenticateAndSyncEnterpriseAccount,
  clearInvalidatedEnterpriseIdentity,
  EnterpriseAuthOperationQueue,
  failClosedUncertainEnterpriseJoin,
  logoutAndClearEnterpriseIdentity,
  refreshEnterpriseIdentityLease,
  restoreAndSyncEnterpriseSession,
  syncJoinedEnterpriseAccount,
  syncVerifiedEnterpriseAccount,
} from './enterprise-auth-sync.js';
import {
  defaultEnterpriseServerUrl,
  migrateEnterpriseServerUrl,
} from './enterprise-server-url.js';
import {
  decodeEnterpriseSession,
  encodeEnterpriseSession,
} from './enterprise-session-store.js';
import { EnterpriseRegistrationIntentStore } from './enterprise-registration-intent.js';
import {
  createEnterpriseNetworkFetch,
  internalTestEnterpriseSession,
} from './enterprise-network-policy.js';
import { INTERNAL_TEST_ACCESS_ENABLED } from './internal-test-access.js';
import { resolveVideoEditorIndex } from './video-editor-resource.js';
import { buildRendererCsp } from './renderer-csp.js';

/** 与 packages/server/src/protocol.ts 的 DEFAULT_HOST/DEFAULT_PORT 保持一致的字面量
 * （仅用作 CSP 的兜底默认值；真实值在 ensureEndpoint() 拿到后覆盖）。 */
const CSP_FALLBACK_HOST = '127.0.0.1';
const CSP_FALLBACK_PORT = 7637;

/**
 * renderer 静态资源目录。与 createWindow 的 loadFile 用同一推导
 * （dist/main → dist/renderer），开发模式与 asar 打包内路径均成立；
 * 也是 isLocalAppUrl 白名单的锚点。
 */
const RENDERER_DIR = path.join(__dirname, '../renderer');

function worklogRootDir(): string {
  const explicit = process.env['OTTO_WORKLOG_DIR']?.trim();
  if (explicit) return explicit;
  const userDir = process.env['OTTO_USER_DIR']?.trim();
  if (userDir) return path.join(userDir, 'memory', 'worklog');
  return path.join(os.homedir(), '.otto-user', 'memory', 'worklog');
}

function userSkillsRootDir(): string {
  const userDir = process.env['OTTO_USER_DIR']?.trim();
  return path.join(userDir || path.join(os.homedir(), '.otto-user'), 'skills');
}

function localSkillDescription(content: string): string {
  const frontmatter = content.match(
    /^---\s*[\r\n]+[\s\S]*?^description:\s*["']?([^\r\n"']+)/mu,
  );
  if (frontmatter?.[1]?.trim()) return frontmatter[1].trim().slice(0, 1_000);
  const paragraph = content
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[#>*-]+\s*/u, '').trim())
    .find((line) => line && !line.startsWith('---') && !/^name:/iu.test(line));
  return (paragraph || '本地 Skill').slice(0, 1_000);
}

function safeLocalSkillName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Skill 名称格式不正确');
  const name = value.trim();
  if (
    !name ||
    name.length > 160 ||
    name === '.' ||
    name === '..' ||
    /[/\\\0]/u.test(name)
  ) {
    throw new Error('Skill 名称格式不正确');
  }
  return name;
}

async function localSkillFilePath(name: string): Promise<string> {
  const directory = path.join(userSkillsRootDir(), name);
  const filePath = path.join(directory, 'SKILL.md');
  const [directoryStat, fileStat] = await Promise.all([
    fs.promises.lstat(directory).catch(() => null),
    fs.promises.lstat(filePath).catch(() => null),
  ]);
  if (
    !directoryStat?.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    !fileStat?.isFile() ||
    fileStat.isSymbolicLink()
  ) {
    throw new Error('本地 Skill 不存在或路径不安全，请刷新后重试');
  }
  return filePath;
}

async function replaceFileFromTemp(
  tempPath: string,
  targetPath: string,
): Promise<void> {
  try {
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;
    await fs.promises.rm(targetPath, { force: true });
    await fs.promises.rename(tempPath, targetPath);
  }
}

async function localMarketplaceInstallVersions(): Promise<Map<string, number>> {
  const versions = new Map<string, number>();
  const entries = await fs.promises
    .readdir(userSkillsRootDir(), { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('market-')) continue;
    try {
      const metadataPath = path.join(
        userSkillsRootDir(),
        entry.name,
        '.otto-market.json',
      );
      const metadata = JSON.parse(
        await fs.promises.readFile(metadataPath, 'utf8'),
      ) as Record<string, unknown>;
      if (
        typeof metadata.skillId === 'string' &&
        typeof metadata.version === 'number' &&
        Number.isInteger(metadata.version) &&
        metadata.version > 0
      ) {
        versions.set(metadata.skillId, metadata.version);
      }
    } catch {
      // Invalid local provenance is treated as not installed on this device.
    }
  }
  return versions;
}

/** 渲染进程崩溃自动重载的退避：窗口期内超过上限就不再 reload，防白屏无限闪烁。 */
const CRASH_RELOAD_WINDOW_MS = 60_000;
const CRASH_RELOAD_MAX = 3;

/** 企业身份服务真实入口；公网默认由中心部署负责，本机仅显式 loopback 时内嵌。 */
const DEFAULT_ENTERPRISE_SERVER_URL = defaultEnterpriseServerUrl(
  process.env.OTTO_ENTERPRISE_SERVER_URL,
);
/** server 生命周期管理器（发现/拉起/探活/退出清理）。 */
const serverManager = new ServerManager({
  enterpriseServerUrl: DEFAULT_ENTERPRISE_SERVER_URL,
  kernelUpdateRoot: resolveKernelUpdateRoot(app.getPath('userData')),
  onHealthChange: (status) => {
    tracer.updateStatus(status);
  },
});
/** 桌面通知服务：OS 原生 toast + 未读闪烁点管理。 */
const notificationService = new NotificationService();
/** 原生文件选择授权账本：允许任意磁盘，但拒绝 renderer 凭空传入的路径。 */
const fileAccessGrants = new FileAccessGrantStore();
/** 用户明确选择过的真实工作目录；跨重启保留最近列表。 */
const workspaceDirectories = new WorkspaceDirectoryStore(
  path.join(app.getPath('userData'), 'workspace-directories.json'),
  os.homedir(),
);
/** 身份提交统一边界：跨账号、跨组织和失效退出时先清旧账号通知与文件授权。 */
const enterpriseNotificationIdentityBoundary =
  new EnterpriseNotificationIdentityBoundary(
    () => notificationService.clearAll(),
    () => fileAccessGrants.clear(),
  );
/** 当前 server 端点（发现的或拉起的）。renderer 经 IPC 取它建 WS。 */
let endpoint: ServerEndpoint | undefined;
let endpointEnsurePromise: Promise<void> | undefined;
let endpointRetryTimer: ReturnType<typeof setTimeout> | undefined;
let endpointRetryAttempt = 0;
/** 主窗口单例引用。 */
let mainWindow: BrowserWindow | undefined;
/** 每个主窗口的展示时序；避免 renderer 就绪前被第二实例强制显示。 */
const mainWindowPresentations = new WeakMap<
  BrowserWindow,
  MainWindowPresentationController
>();
/** 应用尚未 ready 时到达的第二实例聚焦请求。 */
let pendingMainWindowFocusRequest = false;
/** IPC、菜单和托盘初始化完成后，才允许外部事件创建主窗口。 */
let mainWindowCreationReady = false;
/** macOS 后台提醒句柄；窗口重新聚焦时主动取消。 */
let dockBounceId: number | undefined;
/** 系统托盘：保持引用，避免被 GC 后托盘图标消失。 */
let tray: Tray | undefined;
let trayRestarting = false;
let enterpriseTrayPopoverWindow: BrowserWindow | undefined;
let enterpriseTrayContacts: EnterpriseTrayContact[] = [];
/** 用户主动退出标记；关闭窗口时不退出，只有菜单/托盘退出才真正结束进程。 */
let isQuitting = false;
/** 视频编辑器窗口（OpenReel）。 */
let videoEditorWindow: BrowserWindow | undefined;

// ── IPC channel 名（与 preload 对齐）──
const IPC = {
  getEndpoint: 'otto:get-endpoint',
  runtimeDiagnostic: 'otto:runtime-diagnostic',
  endpointChanged: 'otto:endpoint-changed',
  openExternal: 'otto:open-external',
  openPath: 'otto:open-path',
  inspectLocalPath: 'otto:inspect-local-path',
  activateLocalPath: 'otto:activate-local-path',
  selectFiles: 'otto:select-files',
  selectFolders: 'otto:select-folders',
  selectWorkspaceDirectory: 'otto:select-workspace-directory',
  getWorkspaceDirectories: 'otto:get-workspace-directories',
  authorizeWorkspaceDirectory: 'otto:authorize-workspace-directory',
  grantBrowserFile: 'otto:grant-browser-file',
  authorizeMessageFiles: 'otto:authorize-message-files',
  readFilePath: 'otto:read-file-path',
  extractEditableDocument: 'otto:extract-editable-document',
  exportEditedDocument: 'otto:export-edited-document',
  readClipboardText: 'otto:read-clipboard-text',
  saveTextFile: 'otto:save-text-file',
  openVideoEditor: 'otto:open-video-editor',
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
  createDiagnosticBundle: 'otto:create-diagnostic-bundle',
  skillShareList: 'otto:skill-share-list',
  skillMarketplace: 'otto:skill-marketplace',
  enterpriseSkillLocalList: 'otto:enterprise-skill-local-list',
  enterpriseSkillList: 'otto:enterprise-skill-list',
  enterpriseSkillSubmit: 'otto:enterprise-skill-submit',
  enterpriseSkillReview: 'otto:enterprise-skill-review',
  enterpriseSkillInstall: 'otto:enterprise-skill-install',
  enterpriseSkillRate: 'otto:enterprise-skill-rate',
  enterpriseSkillLeaderboard: 'otto:enterprise-skill-leaderboard',
  customerModuleList: 'otto:customer-module-list',
  customerModuleSubmit: 'otto:customer-module-submit',
  customerModuleTest: 'otto:customer-module-test',
  customerModuleInstalledList: 'otto:customer-module-installed-list',
  customerModuleInstall: 'otto:customer-module-install',
  customerModuleSetEnabled: 'otto:customer-module-set-enabled',
  customerModuleSetBackgroundEnabled: 'otto:customer-module-set-background-enabled',
  customerModuleUninstall: 'otto:customer-module-uninstall',
  customerModuleClearData: 'otto:customer-module-clear-data',
  customerModuleExportData: 'otto:customer-module-export-data',
  customerModuleRun: 'otto:customer-module-run',
  customerModuleCancel: 'otto:customer-module-cancel',
  setLocalTestUrl: 'otto:set-local-test-url',
  appVersion: 'otto:app-version',
  updateCheck: 'otto:update-check',
  updateDownload: 'otto:update-download',
  updateCancel: 'otto:update-cancel',
  updateInstall: 'otto:update-install',
  updateProgress: 'otto:update-progress',
  incrementalUpdateCheck: 'otto:incremental-update-check',
  incrementalUpdateApply: 'otto:incremental-update-apply',
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
  enterpriseUsageProfile: 'otto:enterprise-usage-profile',
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
  enterpriseMessageSecurityReset: 'otto:enterprise-message-security-reset',
  enterpriseFederationContactCode: 'otto:enterprise-federation-contact-code',
  enterpriseFederationContactImport: 'otto:enterprise-federation-contact-import',
  enterpriseFederationContacts: 'otto:enterprise-federation-contacts',
  enterpriseFederationContactRemove: 'otto:enterprise-federation-contact-remove',
  enterpriseFederationMessagesList: 'otto:enterprise-federation-messages-list',
  enterpriseFederationMessageSend: 'otto:enterprise-federation-message-send',
  enterpriseFederationAttachmentSave: 'otto:enterprise-federation-attachment-save',
  enterpriseFederationAtoaTasks: 'otto:enterprise-federation-atoa-tasks',
  enterpriseFederationAtoaApprove: 'otto:enterprise-federation-atoa-approve',
  enterpriseFederationAtoaDeny: 'otto:enterprise-federation-atoa-deny',
  enterpriseFederationAtoaDispatch: 'otto:enterprise-federation-atoa-dispatch',
  enterpriseFederationAtoaRespond: 'otto:enterprise-federation-atoa-respond',
  enterpriseFederationContactVerification:
    'otto:enterprise-federation-contact-verification',
  enterpriseFederationContactVerify: 'otto:enterprise-federation-contact-verify',
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
  parkNativeNotify: 'otto:park-native-notify',
  writeClipboard: 'otto:write-clipboard',
  notificationShow: 'otto:notification-show',
  notificationMarkRead: 'otto:notification-mark-read',
  notificationGetUnread: 'otto:notification-get-unread',
  notificationUnreadChanged: 'otto:notification-unread-changed',
  notificationCheckPermission: 'otto:notification-check-permission',
  notificationSessionOpen: 'otto:notification-session-open',
} as const;

const customerModuleRunControllers = new Map<string, AbortController>();
const customerModuleModelInvoke = createCustomerModuleModelInvoke();

const enterpriseFetch = createEnterpriseNetworkFetch(
  fetch,
  INTERNAL_TEST_ACCESS_ENABLED,
);
const enterpriseAuthOperations = new EnterpriseAuthOperationQueue();
const accountDataSyncService = new AccountDataSyncService({
  protectMirror(plaintext) {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.encryptString(plaintext).toString('base64');
  },
  unprotectMirror(protectedValue) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('system secure storage is unavailable');
    }
    return safeStorage.decryptString(Buffer.from(protectedValue, 'base64'));
  },
});

type AuthenticatedEnterpriseAccount =
  import('./enterprise-identity.js').AuthenticatedEnterpriseAccountInput;

function accountDataSyncIdentity(account: {
  id: string;
}): { serverUrl: string; accountId: string } | null {
  if (process.env['OTTO_ACCOUNT_SYNC_DISABLED'] === '1') return null;
  const snapshot = enterpriseClient.snapshot();
  if (!snapshot.token || !snapshot.serverUrl) return null;
  return { serverUrl: snapshot.serverUrl, accountId: account.id };
}

function logAccountDataSyncFailure(error: unknown): void {
  console.warn(
    '[otto-desktop] Account memory/worklog/auto-skill sync failed:',
    error,
  );
}

async function flushEnterpriseAccountDataSync(
  timeoutMs: number,
): Promise<void> {
  const account = enterpriseClient.authenticatedAccountSnapshot();
  const identity = account ? accountDataSyncIdentity(account) : null;
  if (!identity) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([
    accountDataSyncService
      .sync(enterpriseClient, identity)
      .then(() => undefined)
      .catch(logAccountDataSyncFailure),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
}

async function synchronizeAuthenticatedEnterpriseAccount(
  account: AuthenticatedEnterpriseAccount | null,
): Promise<void> {
  await enterpriseNotificationIdentityBoundary.synchronize(account, (next) =>
    serverManager.setAuthenticatedEnterpriseAccount(next),
  );
  if (!account) {
    await enterpriseMlsOutboxRetry.stop();
    await enterpriseMlsInboundPoll.stop();
    await enterpriseMls.close();
    return;
  }
  let e2eeDevice: Awaited<
    ReturnType<EnterpriseClient['ensureE2eeDeviceReady']>
  > | null = null;
  try {
    e2eeDevice = await enterpriseClient.ensureE2eeDeviceReady();
  } catch (error) {
    await enterpriseMlsOutboxRetry.stop();
    await enterpriseMlsInboundPoll.stop();
    await enterpriseMls.close();
    console.warn('[otto-desktop] E2EE device registration failed:', error);
  }
  if (e2eeDevice) {
    if (enterpriseClient.supportsMlsTransportFoundation()) {
      await enterpriseMlsOutboxRetry.stop();
      await enterpriseMlsInboundPoll.stop();
      try {
        await enterpriseMls.activate({
          serverUrl: enterpriseClient.snapshot().serverUrl,
          organizationId: account.organizationId,
          accountId: account.id,
          deviceId: e2eeDevice.deviceId,
          approvalState: e2eeDevice.approvalState,
        });
        enterpriseMlsOutboxRetry.start();
        enterpriseMlsInboundPoll.start();
        try {
          await enterpriseMlsCoordinator.ensurePublishedKeyPackageInventory();
        } catch (error) {
          console.warn(
            '[otto-desktop] MLS KeyPackage inventory maintenance failed:',
            error,
          );
        }
      } catch (error) {
        await enterpriseMlsOutboxRetry.stop();
        await enterpriseMlsInboundPoll.stop();
        console.warn('[otto-desktop] MLS desktop session is blocked:', error);
      }
    } else {
      await enterpriseMlsOutboxRetry.stop();
      await enterpriseMlsInboundPoll.stop();
      await enterpriseMls.close();
    }
  } else {
    await enterpriseMlsOutboxRetry.stop();
    await enterpriseMlsInboundPoll.stop();
    await enterpriseMls.close();
  }
  const identity = accountDataSyncIdentity(account);
  if (!identity) return;
  try {
    await accountDataSyncService.activate(identity);
  } catch (error) {
    logAccountDataSyncFailure(error);
    return;
  }
  try {
    const summary = await accountDataSyncService.sync(
      enterpriseClient,
      identity,
    );
    if (summary.restoredFiles > 0 || summary.uploadedScopes.length > 0) {
      console.info(
        `[otto-desktop] Account data synchronized: restored ${summary.restoredFiles} file(s), uploaded ${summary.uploadedScopes.length} scope(s).`,
      );
    }
  } catch (error) {
    // Authentication stays available; the periodic identity refresh retries sync.
    logAccountDataSyncFailure(error);
  }
  void enterpriseSkillUsageReporter.poll();
}
function assertEnterpriseE2eeSecureStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，端到端加密私聊已安全停用');
  }
  if (
    process.platform === 'linux' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  ) {
    throw new Error(
      'Linux 系统密钥库未解锁，不能使用不安全的 basic_text 保存私聊密钥',
    );
  }
}

const enterpriseE2eeVault = new EnterpriseE2eeKeyVault({
  directory: path.join(app.getPath('userData'), 'enterprise-e2ee'),
  deviceName: () => `${os.hostname()} (${process.platform})`,
  protect(plaintext) {
    assertEnterpriseE2eeSecureStorage();
    return safeStorage.encryptString(plaintext).toString('base64');
  },
  unprotect(protectedValue) {
    assertEnterpriseE2eeSecureStorage();
    return safeStorage.decryptString(Buffer.from(protectedValue, 'base64'));
  },
});
const enterpriseE2ee = new EnterpriseE2eeCrypto(enterpriseE2eeVault);

function packagedOpenMlsBinaryPath(): string | undefined {
  if (!app.isPackaged) return undefined;
  return path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@otto',
    'native',
    'bin',
    process.platform === 'win32' ? 'otto-native.exe' : 'otto-native',
  );
}

const enterpriseMls = new EnterpriseMlsSessionManager({
  stateDirectory: path.join(app.getPath('userData'), 'enterprise-mls'),
  binaryPath: packagedOpenMlsBinaryPath(),
  secureStorage: {
    assertAvailable: assertEnterpriseE2eeSecureStorage,
    protect(plaintext) {
      assertEnterpriseE2eeSecureStorage();
      return safeStorage.encryptString(plaintext).toString('base64');
    },
    unprotect(protectedValue) {
      assertEnterpriseE2eeSecureStorage();
      return safeStorage.decryptString(Buffer.from(protectedValue, 'base64'));
    },
  },
});

const enterpriseClient = new EnterpriseClient(
  enterpriseFetch,
  () => {
    resetEnterpriseModuleUpdateState();
    // 任一受保护接口返回 401 都会走这里：立即持久化清 token，并通知 renderer
    // 退出过期管理员界面。错误登录时 token 本来为空，不会触发此回调。
    if (enterpriseSessionLoaded) {
      void enterpriseAuthOperations
        .run(() =>
          clearInvalidatedEnterpriseIdentity(
            synchronizeAuthenticatedEnterpriseAccount,
            saveEnterpriseSession,
          ),
        )
        .catch((error) => {
          console.warn('[otto-desktop] 清理失效企业会话或本机身份失败:', error);
        });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.enterpriseSessionInvalidated);
    }
  },
  enterpriseE2ee,
);
const enterpriseMlsCoordinator = new EnterpriseMlsSessionCoordinator(
  enterpriseMls,
  enterpriseClient,
);
const enterpriseMlsMessageHistory = new FileEnterpriseMlsMessageHistory({
  directory: path.join(app.getPath('userData'), 'enterprise-mls-messages'),
  secureStorage: {
    assertAvailable: assertEnterpriseE2eeSecureStorage,
    protect(plaintext) {
      assertEnterpriseE2eeSecureStorage();
      return safeStorage.encryptString(plaintext).toString('base64');
    },
    unprotect(protectedValue) {
      assertEnterpriseE2eeSecureStorage();
      return safeStorage.decryptString(Buffer.from(protectedValue, 'base64'));
    },
  },
});
const enterpriseMlsPrivateMessages = new EnterpriseMlsPrivateMessageService(
  enterpriseMlsCoordinator,
  enterpriseMlsMessageHistory,
  {
    attachmentDirectory: path.join(
      app.getPath('userData'),
      'enterprise-mls-attachment-outbox',
    ),
    attachmentTransport: {
      upload: (input) => enterpriseClient.uploadMlsAttachmentObject(input),
      download: (input) => enterpriseClient.downloadMlsAttachmentObject(input),
    },
  },
);
const enterpriseMlsOutboxRetry = new EnterpriseMlsOutboxRetryScheduler(
  enterpriseMlsCoordinator,
  {
    onError: (error) => {
      console.warn(
        '[otto-desktop] MLS ciphertext outbox retry failed:',
        error instanceof Error ? error.message : 'unknown failure',
      );
    },
  },
);
const enterpriseMlsInboundPoll = new EnterpriseMlsInboundPollScheduler(
  enterpriseMlsCoordinator,
  {
    onError: (error) => {
      console.warn(
        '[otto-desktop] MLS inbound polling failed:',
        error instanceof Error ? error.message : 'unknown failure',
      );
    },
  },
);
const enterpriseSkillUsageReporter = new EnterpriseSkillUsageReporter({
  skillsRoot: userSkillsRootDir,
  usageFile: () => path.join(worklogRootDir(), 'skill_usage.jsonl'),
  stateFile: () =>
    path.join(app.getPath('userData'), 'enterprise-skill-usage-state.json'),
  identity: () => {
    const account = enterpriseClient.authenticatedAccountSnapshot();
    const session = enterpriseClient.snapshot();
    return account && session.token
      ? { serverUrl: session.serverUrl, accountId: account.id }
      : null;
  },
  report: async (skillId, success, eventId) => {
    await enterpriseClient.recordEnterpriseSkillUsage(
      skillId,
      success,
      eventId,
    );
  },
});
const enterpriseRegistrationIntents = new EnterpriseRegistrationIntentStore();
let enterpriseSessionLoaded = false;
let enterpriseIntentRendererReady = false;
let enterpriseIdentityRefreshTimer: ReturnType<typeof setInterval> | undefined;
const ENTERPRISE_IDENTITY_REFRESH_INTERVAL_MS = 2 * 60_000;
let enterpriseModuleUpdateTimer: ReturnType<typeof setInterval> | undefined;
let enterpriseModuleUpdateFingerprint = '';
let enterpriseModuleUpdatePolling = false;
const ENTERPRISE_MODULE_UPDATE_POLL_INTERVAL_MS = 2 * 60_000;
let enterpriseSkillUsageTimer: ReturnType<typeof setInterval> | undefined;
const ENTERPRISE_SKILL_USAGE_POLL_INTERVAL_MS = 30_000;

function startEnterpriseSkillUsageReporting(): void {
  if (enterpriseSkillUsageTimer) return;
  enterpriseSkillUsageTimer = setInterval(() => {
    if (!isQuitting) void enterpriseSkillUsageReporter.poll();
  }, ENTERPRISE_SKILL_USAGE_POLL_INTERVAL_MS);
  enterpriseSkillUsageTimer.unref?.();
  void enterpriseSkillUsageReporter.poll();
}

function stopEnterpriseSkillUsageReporting(): void {
  if (!enterpriseSkillUsageTimer) return;
  clearInterval(enterpriseSkillUsageTimer);
  enterpriseSkillUsageTimer = undefined;
}

function acceptEnterpriseRegistrationUrl(input: string): boolean {
  if (!enterpriseRegistrationIntents.acceptUrl(input)) return false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (enterpriseIntentRendererReady) {
      const intent = enterpriseRegistrationIntents.take();
      if (intent)
        mainWindow.webContents.send(
          IPC.enterpriseRegistrationIntentOpened,
          intent,
        );
    }
  }
  return true;
}

function enterpriseSessionPath(): string {
  return path.join(app.getPath('userData'), 'enterprise-auth.json');
}

function canRestoreEncryptedEnterpriseSession(): boolean {
  if (process.env.OTTO_ENTERPRISE_RESTORE_KEYCHAIN_SESSION === '1') return true;
  return !(process.platform === 'darwin' && app.isPackaged);
}

function loadEnterpriseSession(): void {
  if (enterpriseSessionLoaded) return;
  enterpriseSessionLoaded = true;
  const internalTestSession = internalTestEnterpriseSession(
    DEFAULT_ENTERPRISE_SERVER_URL,
    INTERNAL_TEST_ACCESS_ENABLED,
  );
  if (internalTestSession) {
    enterpriseClient.restore(internalTestSession);
    return;
  }
  let restored = {
    serverUrl: DEFAULT_ENTERPRISE_SERVER_URL,
    token: null as string | null,
  };
  try {
    restored = decodeEnterpriseSession(
      fs.readFileSync(enterpriseSessionPath(), 'utf8'),
      DEFAULT_ENTERPRISE_SERVER_URL,
      (encryptedToken) => {
        if (!canRestoreEncryptedEnterpriseSession()) return '';
        if (!safeStorage.isEncryptionAvailable())
          throw new Error('系统安全存储不可用');
        return safeStorage.decryptString(Buffer.from(encryptedToken, 'base64'));
      },
      (serverUrl) =>
        migrateEnterpriseServerUrl(serverUrl, DEFAULT_ENTERPRISE_SERVER_URL),
    );
  } catch {
    // 首次启动、存储损坏或系统密钥链不可用时安全地保持未登录。
  }
  try {
    enterpriseClient.restore(restored);
  } catch {
    // v1.7.x 可能保存过公网 HTTP 地址。v1.8 起拒绝明文认证并清掉旧会话，
    // 回落到内置 HTTPS 入口，避免升级后启动失败或继续发送明文口令。
    enterpriseClient.restore({
      serverUrl: DEFAULT_ENTERPRISE_SERVER_URL,
      token: null,
    });
  }
}

function saveEnterpriseSession(): void {
  const snapshot = enterpriseClient.snapshot();
  const safeSnapshot =
    canRestoreEncryptedEnterpriseSession() &&
    safeStorage.isEncryptionAvailable()
      ? snapshot
      : { ...snapshot, token: null };
  fs.mkdirSync(path.dirname(enterpriseSessionPath()), { recursive: true });
  fs.writeFileSync(
    enterpriseSessionPath(),
    encodeEnterpriseSession(safeSnapshot, (token) =>
      safeStorage.encryptString(token).toString('base64'),
    ),
    { encoding: 'utf8', mode: 0o600 },
  );
}

function startEnterpriseIdentityRefresh(): void {
  if (enterpriseIdentityRefreshTimer) return;
  enterpriseIdentityRefreshTimer = setInterval(() => {
    if (isQuitting) return;
    loadEnterpriseSession();
    if (!enterpriseClient.snapshot().token) return;
    void enterpriseAuthOperations
      .run(async () => {
        if (!enterpriseClient.snapshot().token) return;
        const session = await enterpriseClient.getSession();
        const outcome = await refreshEnterpriseIdentityLease(
          session,
          enterpriseClient,
          synchronizeAuthenticatedEnterpriseAccount,
          saveEnterpriseSession,
        );
        if (outcome === 'refreshed' && session.account) {
          notifyEnterpriseAccountUpdated(session.account);
          enterpriseMlsOutboxRetry.wake();
          enterpriseMlsInboundPoll.wake();
        }
      })
      .catch((error) => {
        console.warn('[otto-desktop] 刷新企业身份短租约失败:', error);
      });
  }, ENTERPRISE_IDENTITY_REFRESH_INTERVAL_MS);
  enterpriseIdentityRefreshTimer.unref?.();
}

function notifyEnterpriseAccountUpdated(account: EnterpriseAccount): void {
  void checkEnterpriseModuleUpdates('identity');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.enterpriseAccountUpdated, account);
  }
}

function stopEnterpriseIdentityRefresh(): void {
  if (!enterpriseIdentityRefreshTimer) return;
  clearInterval(enterpriseIdentityRefreshTimer);
  enterpriseIdentityRefreshTimer = undefined;
}

/**
 * 软件更新服务（检查 / 下载 / 安装，逻辑见 update-service.ts）。
 * 进度经 IPC.updateProgress 推给当前主窗口；窗口可能重建，故传 getter。
 */
const updateService = new UpdateService(
  () => mainWindow?.webContents,
  IPC.updateProgress,
);
const incrementalUpdateService = new IncrementalUpdateService(
  () => mainWindow?.webContents,
);
const desktopDistributionId = resolveDesktopDistribution(
  process.env.OTTO_DISTRIBUTION_ID,
  app.getName(),
);

async function checkDesktopUpdate() {
  const session = enterpriseClient.snapshot();
  return checkForUpdateUsingPolicy({
    distributionId: desktopDistributionId,
    currentVersion: app.getVersion(),
    hasEnterpriseSession: Boolean(session.token),
    resolvePolicy: () =>
      enterpriseClient.getDeploymentUpdatePolicy({
        distributionId: desktopDistributionId,
        currentVersion: app.getVersion(),
      }),
    checkLegacy: () => updateService.checkForUpdate(),
    checkManagedFull: (reference) =>
      updateService.checkForUpdate({
        manifestUrl: reference.url,
        manifestSha256: reference.sha256,
        releasePageUrl: reference.url,
      }),
    checkIncremental: (reference) =>
      incrementalUpdateService.checkForUpdates(reference.url, reference.sha256),
  });
}

function moduleUpdateFingerprint(
  updates: EnterpriseModuleUpdateDescriptor[],
): string {
  return updates
    .filter((update) => update.rollout !== 'off' && Boolean(update.manifestUrl))
    .map((update) =>
      [
        update.module,
        update.version,
        update.rollout,
        update.manifestUrl ?? '',
        update.sha256 ?? '',
        update.updatedAt,
      ].join('\u0000'),
    )
    .sort()
    .join('\u0001');
}

function chooseEnterpriseModuleUpdate(
  updates: EnterpriseModuleUpdateDescriptor[],
): EnterpriseModuleUpdateDescriptor | null {
  const active = updates.filter(
    (update) => update.rollout !== 'off' && Boolean(update.manifestUrl),
  );
  return (
    active.find((update) => update.rollout === 'required') ??
    active.find((update) => update.rollout === 'stable') ??
    active.find((update) => update.rollout === 'canary') ??
    null
  );
}

async function checkEnterpriseModuleUpdates(
  reason: 'startup' | 'interval' | 'identity',
): Promise<void> {
  if (enterpriseModuleUpdatePolling) return;
  loadEnterpriseSession();
  if (!enterpriseClient.snapshot().token) return;
  enterpriseModuleUpdatePolling = true;
  try {
    const manifest = await enterpriseClient.getModuleUpdates();
    const fingerprint = moduleUpdateFingerprint(manifest.modules);
    if (!fingerprint || fingerprint === enterpriseModuleUpdateFingerprint)
      return;
    enterpriseModuleUpdateFingerprint = fingerprint;
    const target = chooseEnterpriseModuleUpdate(manifest.modules);
    if (!target?.manifestUrl) return;
    const result = await incrementalUpdateService.checkForUpdates(
      target.manifestUrl,
    );
    console.info('[otto-desktop] enterprise module update check', {
      reason,
      module: target.module,
      version: target.version,
      rollout: target.rollout,
      status: result.status,
    });
  } catch (error) {
    console.warn('[otto-desktop] 企业模块化更新检查失败:', error);
  } finally {
    enterpriseModuleUpdatePolling = false;
  }
}

function startEnterpriseModuleUpdatePolling(): void {
  if (enterpriseModuleUpdateTimer) return;
  enterpriseModuleUpdateTimer = setInterval(() => {
    if (isQuitting) return;
    void checkEnterpriseModuleUpdates('interval');
  }, ENTERPRISE_MODULE_UPDATE_POLL_INTERVAL_MS);
  enterpriseModuleUpdateTimer.unref?.();
  void checkEnterpriseModuleUpdates('startup');
}

function stopEnterpriseModuleUpdatePolling(): void {
  if (!enterpriseModuleUpdateTimer) return;
  clearInterval(enterpriseModuleUpdateTimer);
  enterpriseModuleUpdateTimer = undefined;
}

function resetEnterpriseModuleUpdateState(): void {
  enterpriseModuleUpdateFingerprint = '';
}

/**
 * 飞书状态/启停在桌面端的通路（诚实原则，全部真实）。
 *
 * 状态（feishuStatus）：桌面端连接的 server（内嵌或发现的）在 /health 里带出
 * 飞书守护详情（connected / 重连第 N 次 / 下次重试 / 锁被哪个 pid 持有），
 * 这里直接查询透传——绝不假报「已连接」；锁被别的进程（如 CLI daemon）拿着时
 * 如实说「另一进程持有」。
 *
 * 启停（feishuStart/feishuStop）：真调 server 的运行期端点
 * POST /feishu/start、POST /feishu/stop：
 *   - start：server 未启用（含运行期才配好凭证）→ 现场注册并启动守护；
 *     已在跑 → 幂等返回当前状态；无凭证 → server 诚实报错（ok:false），
 *     桌面端原样透传，不谎报「已启动」。
 *   - stop：有意停止，之后不自动重连，直到再次 start。
 * 每次操作后附最新真实状态文案。
 */

/** /health 单次查询超时（ms）。 */
const FEISHU_HEALTH_TIMEOUT_MS = 1500;
/** 启停端点超时（ms）：start 含 registerFeishu（不阻塞等建连），给宽一点。 */
const FEISHU_OP_TIMEOUT_MS = 5000;

/**
 * POST 一个 server 端点（无 body），解析 ApiResponse 信封。
 * 网络失败/超时/server 未就绪 → 返回 null（调用方给「未就绪」诚实文案）。
 */
function postServerEndpoint(
  routePath: string,
): Promise<{ ok: boolean; data: unknown; error: string | null } | null> {
  const ep = endpoint;
  if (!ep) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: ep.host,
        port: ep.port,
        path: routePath,
        method: 'POST',
        timeout: FEISHU_OP_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(
              JSON.parse(body) as {
                ok: boolean;
                data: unknown;
                error: string | null;
              },
            );
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * 请求 /feishu/config（GET/POST/DELETE），解析 ApiResponse 信封。
 * 网络失败/超时/server 未就绪 → null。POST body 里含 appSecret，
 * 只走回环 HTTP 到本机 server，不落任何日志。
 */
function requestFeishuConfig(
  method: 'GET' | 'POST' | 'DELETE',
  body?: FeishuConfigSaveRequest,
): Promise<{
  ok: boolean;
  data: FeishuConfigPublic | null;
  error: string | null;
} | null> {
  const ep = endpoint;
  if (!ep) return Promise.resolve(null);
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: ep.host,
        port: ep.port,
        path: '/feishu/config',
        method,
        timeout: FEISHU_OP_TIMEOUT_MS,
        ...(payload !== undefined
          ? {
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              },
            }
          : {}),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          try {
            resolve(
              JSON.parse(text) as {
                ok: boolean;
                data: FeishuConfigPublic | null;
                error: string | null;
              },
            );
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end(payload);
  });
}

/** 查询当前 server 的 /health（信封 {ok,data,error}），失败/未就绪返回 null。 */
function fetchServerHealth(): Promise<HealthInfo | null> {
  const ep = endpoint;
  if (!ep) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: ep.host,
        port: ep.port,
        path: '/health',
        timeout: FEISHU_HEALTH_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as {
              ok?: boolean;
              data?: HealthInfo | null;
            };
            resolve(parsed.ok && parsed.data ? parsed.data : null);
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/** 把 /health 的飞书守护状态渲染成给用户看的一句人话（状态必须诚实）。 */
function renderFeishuStatusText(feishu: HealthInfo['feishu']): string {
  const st = feishu.status;
  if (!feishu.enabled || !st) {
    return (
      '本地 server 未启用飞书网关（未检测到飞书凭证）。\n' +
      '到「设置与诊断 → 飞书接入」填写 App ID / App Secret 即可启用。'
    );
  }
  if (!st.configured) {
    return '飞书凭证缺失或损坏（~/.otto-user/feishu-credentials.json），网关未启动。';
  }
  if (st.connected) {
    return '飞书已连接（WS 长连接就绪，断线自动重连守护中）。';
  }
  if (st.lockHeldByOtherPid != null) {
    return (
      `飞书连接被另一进程持有（pid ${st.lockHeldByOtherPid}，可能是 otto feishu daemon）。\n` +
      '本进程未连接（避免同一消息被处理两遍），对方退出后将自动接管。'
    );
  }
  if (st.reconnecting) {
    const eta = st.nextRetryAt
      ? Math.max(0, Math.round((st.nextRetryAt - Date.now()) / 1000))
      : null;
    return (
      `飞书重连中（第 ${st.reconnectAttempts} 次${eta !== null ? `，约 ${eta}s 后重试` : ''}）` +
      `${st.lastDisconnectReason ? `：${st.lastDisconnectReason}` : ''}。`
    );
  }
  if (!st.running) {
    return '飞书守护未在运行。';
  }
  return `飞书离线${st.lastDisconnectReason ? `：${st.lastDisconnectReason}` : ''}。`;
}

// ────────────────────────────────────────────────────────────────────────
// 窗口
// ────────────────────────────────────────────────────────────────────────

/**
 * 加载窗口图标占位：dist/renderer/icon.png 存在则用，否则返回空 image
 * （Electron 在无图标时回退默认，不报错）。真正的品牌图标由 #8 打包时补。
 */
/** 主题选择的持久化文件（userData/theme.json）。 */
function themeFilePath(): string {
  return path.join(app.getPath('userData'), 'theme.json');
}

/** 读上次保存的主题选择；无文件/内容非法 → 'system'。 */
function loadSavedThemeSource(): 'system' | 'light' | 'dark' {
  try {
    const raw = JSON.parse(fs.readFileSync(themeFilePath(), 'utf8')) as {
      themeSource?: unknown;
    };
    if (raw.themeSource === 'light' || raw.themeSource === 'dark')
      return raw.themeSource;
  } catch {
    /* 首次启动无文件，走默认 */
  }
  return 'system';
}

function loadIcon(): NativeImage {
  const iconPaths = [
    // electron-builder 将它作为 extraResource 放在 app.asar 外，macOS/Windows 都可读。
    path.join(process.resourcesPath, 'app-icon.png'),
    path.join(RENDERER_DIR, 'icon.png'),
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(process.resourcesPath, 'build', 'icon.png'),
  ];
  for (const iconPath of iconPaths) {
    if (fs.existsSync(iconPath)) {
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) return image;
    }
  }
  // 内嵌后备图标（32x32 PNG）
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAPklEQVR42mNg+M8ABUwgauf/ZJEYASZQRLMAs6IRYAKRKIYB5iYwI+gYIkDUQs1DEBtBbqRhgAMDAAMEATRlPZEIvE5AAAAABJRU5ErkJggg==',
  );
}

function loadTrayIcon(): NativeImage {
  if (process.platform === 'darwin') {
    const template = loadIcon().resize({ width: 18, height: 18 });
    template.setTemplateImage(true);
    return template;
  }
  return loadIcon().resize({ width: 16, height: 16 });
}

function trayTooltip(unreadCount: number): string {
  if (unreadCount <= 0) return 'Otto';
  const lines: string[] = [`Otto · ${unreadCount} 条未读消息`];
  if (enterpriseTrayContacts.length > 0) {
    const contacts = enterpriseTrayContacts.slice(0, 4).map((item) => (
      `${item.name} ${item.count} 条：${item.preview}`
    ));
    lines.push(...contacts);
    if (enterpriseTrayContacts.length > contacts.length) {
      lines.push(`还有 ${enterpriseTrayContacts.length - contacts.length} 位联系人`);
    }
  }
  // 提示用户 hover 或点击可以查看详情
  lines.push('单击托盘图标查看未读详情');
  return lines.join('\n');
}

async function refreshEnterpriseTrayContacts(): Promise<void> {
  if (!enterpriseClient.snapshot().token) {
    enterpriseTrayContacts = [];
    updateUnreadIndicators(notificationService.getUnreadSessions());
    syncEnterpriseTrayPopover();
    return;
  }
  try {
    enterpriseTrayContacts = summarizeEnterpriseTrayContacts(
      await listEnterpriseUnreadMessageNotifications({ includeFederation: true }),
    );
  } catch {
    updateUnreadIndicators(notificationService.getUnreadSessions());
    return;
  }
  updateUnreadIndicators(notificationService.getUnreadSessions());
  syncEnterpriseTrayPopover();
}

async function listEnterpriseUnreadMessageNotifications(
  options: { includeFederation?: boolean } = {},
): Promise<
  Array<EnterpriseUnreadMessageNotification & { count?: number }>
> {
  const localMessages = !enterpriseClient.supportsMlsPrivateMessages()
    ? await enterpriseClient.listUnreadDirectMessageNotifications()
    : await Promise.all([
        enterpriseMlsPrivateMessages.listUnread(),
        enterpriseClient.getOrganizationView(),
      ]).then(([messages, organization]) => {
        const names = new Map(
          organization.members.map((member) => [member.id, member.name]),
        );
        return messages.map((message) => ({
          id: message.id,
          source: 'enterprise' as const,
          title: '端到端加密私聊',
          senderAccountId: message.senderAccountId,
          senderName: names.get(message.senderAccountId) ?? message.senderAccountId,
          preview: message.content.slice(0, 160),
          createdAt: message.createdAt,
        }));
      });
  if (!options.includeFederation) return localMessages;
  const federationContacts = await enterpriseClient
    .listFederationContacts()
    .catch(() => []);
  const federated = federationContacts
    .filter((contact) => contact.unreadCount > 0)
    .map((contact) => ({
      id: `federation:${contact.id}:${contact.lastMessageAt ?? ''}`,
      source: 'enterprise' as const,
      title: '端到端加密跨服务器私聊',
      senderAccountId: `federation:${contact.id}`,
      senderName: contact.displayName,
      preview: '收到一条端到端加密的跨服务器消息',
      createdAt: contact.lastMessageAt ?? new Date().toISOString(),
      count: contact.unreadCount,
    }));
  return [...localMessages, ...federated];
}

function totalTrayUnreadCount(unread: readonly string[]): number {
  const enterpriseSessionIds = new Set(
    enterpriseTrayContacts.map(
      (contact) => contact.accountId.startsWith('federation:')
        ? `enterprise:federation:${contact.accountId.slice('federation:'.length)}`
        : `enterprise:message:${contact.accountId}`,
    ),
  );
  const otherUnread = unread.filter(
    (sessionId) => !enterpriseSessionIds.has(sessionId),
  ).length;
  return (
    otherUnread +
    enterpriseTrayContacts.reduce((total, contact) => total + contact.count, 0)
  );
}

/** 同步系统级未读提示：macOS Dock/菜单栏、Windows 任务栏覆盖图标与托盘说明。 */
function updateUnreadIndicators(unread: readonly string[]): void {
  const count = totalTrayUnreadCount(unread);
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(trayTooltip(count));
    if (process.platform === 'darwin') {
      tray.setTitle(count > 0 || enterpriseTrayContacts.length > 0 ? ' •' : '');
    }
  }
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : '');
  }
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOverlayIcon(
      count > 0 ? loadIcon().resize({ width: 16, height: 16 }) : null,
      count > 0 ? `${count} 条未读消息` : '',
    );
  }
}

/** 主窗口没有呈现在用户眼前时，才需要系统级弹窗。 */
function shouldPresentSystemNotification(): boolean {
  return (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !mainWindow.isVisible() ||
    mainWindow.isMinimized() ||
    !mainWindow.isFocused()
  );
}

/** 后台来消息时提供不依赖通知中心权限的任务栏/Dock 提醒。 */
function requestBackgroundAttention(): void {
  if (!shouldPresentSystemNotification()) return;
  if (process.platform === 'darwin' && app.dock) {
    if (dockBounceId !== undefined) app.dock.cancelBounce(dockBounceId);
    dockBounceId = app.dock.bounce('informational');
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.flashFrame(true);
    } catch {
      /* platform may not support flashing */
    }
  }
}

/** 系统通知 API 不可用或发送失败时，Windows 再退化为托盘气泡。 */
function showFallbackNotification(payload: NotificationPayload): void {
  if (process.platform !== 'win32' || !tray || tray.isDestroyed()) return;
  try {
    tray.displayBalloon({
      title: payload.title || 'Otto 新消息',
      content: payload.preview,
      icon: loadIcon(),
      iconType: 'custom',
      noSound: true,
      respectQuietTime: false,
    });
  } catch {
    // 仍有任务栏闪烁、托盘未读说明和声音作为最终兜底。
  }
}

function clearBackgroundAttention(): void {
  if (dockBounceId !== undefined && process.platform === 'darwin' && app.dock) {
    app.dock.cancelBounce(dockBounceId);
    dockBounceId = undefined;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.flashFrame(false);
    } catch {
      /* ignore */
    }
  }
}

function hideEnterpriseTrayPopover(): void {
  if (
    enterpriseTrayPopoverWindow &&
    !enterpriseTrayPopoverWindow.isDestroyed()
  ) {
    enterpriseTrayPopoverWindow.hide();
  }
}

function openNotificationSession(sessionId: string): void {
  showMainWindow();
  const targetWindow = mainWindow;
  if (!targetWindow || targetWindow.isDestroyed()) return;
  const send = (): void => {
    if (!targetWindow.isDestroyed()) {
      targetWindow.webContents.send(IPC.notificationSessionOpen, sessionId);
    }
  };
  if (targetWindow.webContents.isLoading()) {
    targetWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function handleEnterpriseTrayNavigation(targetUrl: string): void {
  try {
    const target = new URL(targetUrl);
    if (target.protocol !== 'otto-tray:') return;
    if (target.hostname === 'open') {
      showMainWindow();
      return;
    }
    if (target.hostname === 'park') {
      openNotificationSession('park:service');
      return;
    }
    if (target.hostname !== 'message') return;
    const accountId = decodeURIComponent(target.pathname.replace(/^\/+/, ''));
    if (!accountId || accountId.length > 256) return;
    if (accountId.startsWith('federation:')) {
      const contactId = accountId.slice('federation:'.length);
      if (contactId) openNotificationSession(`enterprise:federation:${contactId}`);
      return;
    }
    openNotificationSession(`enterprise:message:${accountId}`);
  } catch (error) {
    void error;
  }
}

function ensureEnterpriseTrayPopoverWindow(): BrowserWindow {
  if (
    enterpriseTrayPopoverWindow &&
    !enterpriseTrayPopoverWindow.isDestroyed()
  ) {
    return enterpriseTrayPopoverWindow;
  }
  const window = new BrowserWindow({
    width: ENTERPRISE_TRAY_POPOVER_WIDTH,
    height: enterpriseTrayPopoverHeight(enterpriseTrayContacts.length),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false,
      spellcheck: false,
    },
  });
  enterpriseTrayPopoverWindow = window;
  window.setAlwaysOnTop(true, 'pop-up-menu');
  window.setMenuBarVisibility(false);
  window.on('blur', () => window.hide());
  window.on('closed', () => {
    if (enterpriseTrayPopoverWindow === window)
      enterpriseTrayPopoverWindow = undefined;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    event.preventDefault();
    handleEnterpriseTrayNavigation(targetUrl);
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.key !== 'Escape') return;
    event.preventDefault();
    window.hide();
  });
  return window;
}

function positionEnterpriseTrayPopoverWindow(window: BrowserWindow): void {
  if (!tray || tray.isDestroyed()) return;
  const trayBounds = tray.getBounds();
  const anchorPoint =
    trayBounds.width > 0 || trayBounds.height > 0
      ? {
          x: Math.round(trayBounds.x + trayBounds.width / 2),
          y: Math.round(trayBounds.y + trayBounds.height / 2),
        }
      : screen.getCursorScreenPoint();
  const workArea = screen.getDisplayNearestPoint(anchorPoint).workArea;
  const effectiveTrayBounds =
    trayBounds.width > 0 || trayBounds.height > 0
      ? trayBounds
      : {
          x: workArea.x + workArea.width - 24,
          y: workArea.y + workArea.height,
          width: 24,
          height: 0,
        };
  const position = positionEnterpriseTrayPopover(
    effectiveTrayBounds,
    workArea,
    window.getBounds(),
  );
  window.setPosition(position.x, position.y, false);
}

async function renderEnterpriseTrayPopover(show: boolean): Promise<void> {
  const window = ensureEnterpriseTrayPopoverWindow();
  window.setSize(
    ENTERPRISE_TRAY_POPOVER_WIDTH,
    enterpriseTrayPopoverHeight(enterpriseTrayContacts.length),
    false,
  );
  const html = renderEnterpriseTrayPopoverHtml(enterpriseTrayContacts);
  try {
    await window.loadURL(
      `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`,
    );
  } catch (error) {
    void error;
    return;
  }
  if (window.isDestroyed()) return;
  positionEnterpriseTrayPopoverWindow(window);
  if (show) {
    window.show();
    window.focus();
  }
}

function syncEnterpriseTrayPopover(): void {
  if (!enterpriseTrayPopoverWindow || enterpriseTrayPopoverWindow.isDestroyed())
    return;
  if (!enterpriseTrayPopoverWindow.isVisible()) return;
  if (enterpriseTrayContacts.length === 0) {
    enterpriseTrayPopoverWindow.hide();
    return;
  }
  void renderEnterpriseTrayPopover(false);
}

async function showEnterpriseTrayPopover(): Promise<void> {
  if (enterpriseTrayContacts.length === 0)
    await refreshEnterpriseTrayContacts();
  if (enterpriseTrayContacts.length === 0) {
    showMainWindow();
    return;
  }
  await renderEnterpriseTrayPopover(true);
}

async function toggleEnterpriseTrayPopover(): Promise<void> {
  if (enterpriseTrayPopoverWindow?.isVisible()) {
    enterpriseTrayPopoverWindow.hide();
    return;
  }
  await showEnterpriseTrayPopover();
}
function showMainWindow(): void {
  hideEnterpriseTrayPopover();
  clearBackgroundAttention();
  if (!app.isReady() || !mainWindowCreationReady) {
    pendingMainWindowFocusRequest = true;
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    mainWindow.webContents.once('did-finish-load', pushEndpointToRenderer);
  }
  const presentation = mainWindowPresentations.get(mainWindow);
  if (presentation) {
    presentation.requestShow({ focus: true });
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray(): void {
  if (tray) return;

  tracer.state.status = '正在启动…';

  tray = new Tray(loadTrayIcon());
  tray.setToolTip('Otto');
  updateUnreadIndicators(notificationService.getUnreadSessions());

  const updateMenu = (): void => {
    const status = tracer.getSummary();
    const restarting = trayRestarting;

    const enterpriseUnreadTotal = enterpriseTrayContacts.reduce(
      (total, contact) => total + contact.count,
      0,
    );
    const enterpriseContactItems: Electron.MenuItemConstructorOptions[] =
      enterpriseTrayContacts.length
        ? [
            { type: 'separator' },
            {
              label: `查看 ${enterpriseUnreadTotal} 条未读企业消息`,
              click: () => {
                void showEnterpriseTrayPopover();
              },
            },
          ]
        : [];

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: '打开 Otto',
        click: showMainWindow,
      },
      { type: 'separator' },
      {
        label: status,
        enabled: false,
      },
      ...enterpriseContactItems,
      {
        label: restarting ? '正在重启…' : '重启 Otto 服务',
        enabled: !restarting,
        click: async () => {
          trayRestarting = true;
          updateMenu();
          tracer.updateStatus('正在重启…');
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC.endpointChanged, null);
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
            endpoint = undefined;
            await ensureEndpoint();
          } catch {
            tracer.updateStatus('重启失败');
          } finally {
            trayRestarting = false;
            updateMenu();
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出 Otto',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ];
    tray!.setContextMenu(Menu.buildFromTemplate(template));
  };

  updateMenu();
  setInterval(() => {
    if (tray && !tray.isDestroyed()) updateMenu();
  }, 2000);
  void refreshEnterpriseTrayContacts();
  setInterval(() => {
    void refreshEnterpriseTrayContacts();
  }, 8000);

  tray.on('click', () => {
    void toggleEnterpriseTrayPopover();
  });
  tray.on('double-click', showMainWindow);
  tray.on('balloon-click', showMainWindow);
}

// ── 托盘状态追踪器 ──
const tracer: {
  state: { status: string };
  updateStatus(status: string): void;
  getSummary(): string;
} = {
  state: { status: '正在启动…' },
  updateStatus(status: string) {
    this.state.status = status;
  },
  getSummary() {
    return this.state.status;
  },
};

function createWindow(): BrowserWindow {
  enterpriseIntentRendererReady = false;
  let closePromptPending = false;
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Otto',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {}),
    // 初始底色跟随系统深浅：暗色 #181818 / 浅色 #ffffff。硬编码任一固定色会在
    // 系统主题与之相反时于内容就绪前（及窗口边缘）闪出错误底色。themeSource 已
    // 在 whenReady 里设为 'system'，故 shouldUseDarkColors 反映的即 OS 当前主题。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff',
    icon: loadIcon(),
    // 内容就绪再显示，避免白屏闪烁。
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      // ── 安全基线（Issue #4）──
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      // 禁用 renderer 直接走 Node 的 experimental features。
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });

  const presentation = new MainWindowPresentationController(win);
  mainWindowPresentations.set(win, presentation);
  let initialIndicatorsUpdated = false;
  const markWindowReady = (): void => {
    presentation.markReady();
    if (initialIndicatorsUpdated) return;
    initialIndicatorsUpdated = true;
    updateUnreadIndicators(notificationService.getUnreadSessions());
  };

  win.once('ready-to-show', markWindowReady);
  win.on('focus', clearBackgroundAttention);
  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    if (closePromptPending) return;
    closePromptPending = true;
    void askWindowCloseChoice({
      showMessageBox: (options) => dialog.showMessageBox(options),
    }).then((choice) => {
      if (choice === 'continue-background') {
        win.hide();
      } else if (choice === 'stop-and-quit') {
        isQuitting = true;
        app.quit();
      }
    }).catch((error) => {
      console.error('[otto-desktop] close choice dialog failed:', error);
    }).finally(() => {
      closePromptPending = false;
    });
  });

  hardenWebContents(win);
  win.webContents.once('did-finish-load', () => {
    // ready-to-show 在后台/遮挡启动时不保证及时触发。renderer 完成加载后作为
    // 安全兜底展示；控制器会合并两个信号，避免重复 show 或抢焦点。
    markWindowReady();
    void incrementalUpdateService
      .applyActiveRendererPatches()
      .catch((error) => {
        console.warn('[otto-desktop] apply renderer css patch failed:', error);
      });
  });

  void win.loadFile(path.join(RENDERER_DIR, 'index.html'));
  return win;
}

/** 创建内置视频编辑器窗口（OpenReel）。 */
function createVideoEditorWindow(): { ok: boolean; error?: string } {
  if (videoEditorWindow && !videoEditorWindow.isDestroyed()) {
    videoEditorWindow.show();
    videoEditorWindow.focus();
    return { ok: true };
  }

  const editorPath = resolveVideoEditorIndex({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleDir: __dirname,
  });
  if (app.isPackaged && !fs.existsSync(editorPath)) {
    return {
      ok: false,
      error: `Video editor is an optional external component and is not bundled in this build: ${editorPath}`,
    };
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Otto - Video Editor',
    icon: loadIcon(),
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  videoEditorWindow = win;

  if (fs.existsSync(editorPath)) {
    void win.loadFile(editorPath);
  } else {
    void win.loadURL('http://localhost:5174');
  }

  win.on('closed', () => {
    videoEditorWindow = undefined;
  });

  // External links open in system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  return { ok: true };
}

/** 收紧单个窗口 webContents 的导航 / 新窗口行为。 */
function hardenWebContents(win: BrowserWindow): void {
  // 外链统一走系统浏览器，不在 app 内开新窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 阻止 renderer 导航离开本地 app（防被劫持加载远程页）。
  win.webContents.on('will-navigate', (event, url) => {
    if (!isLocalAppUrl(url)) {
      event.preventDefault();
      if (isExternalUrl(url)) void shell.openExternal(url);
    }
  });

  // 渲染进程崩溃 / 卡死：记录并尝试恢复（重载）。带退避：60s 内最多重载
  // CRASH_RELOAD_MAX 次，超限视为必现崩溃，改为展示错误页，防白屏无限闪烁。
  let crashReloadTimes: number[] = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[otto-desktop] renderer 进程退出:', details.reason);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    crashReloadTimes = crashReloadTimes.filter(
      (t) => now - t < CRASH_RELOAD_WINDOW_MS,
    );
    if (crashReloadTimes.length < CRASH_RELOAD_MAX) {
      crashReloadTimes = [...crashReloadTimes, now];
      win.webContents.reload();
    } else {
      console.error(
        '[otto-desktop] renderer 短时间内反复崩溃，停止自动重载，改为展示错误页',
      );
      void win.webContents.loadURL(crashPageDataUrl());
    }
  });
  win.webContents.on('unresponsive', () => {
    console.warn('[otto-desktop] renderer 无响应');
  });
}

/**
 * 是否本地 app 资源：仅放行 renderer 目录内的 file:// URL。
 * 只判 file:// 前缀会放行任意本地文件，被劫持时可导航到磁盘上任何页面。
 */
function isLocalAppUrl(url: string): boolean {
  if (!url.startsWith('file://')) return false;
  try {
    const target = path.resolve(fileURLToPath(url));
    return (
      target === RENDERER_DIR || target.startsWith(RENDERER_DIR + path.sep)
    );
  } catch {
    // 非法 file URL（如带 host 段）→ 拒绝。
    return false;
  }
}

/** 反复崩溃后的兜底错误页（data: URL；朴素静态页，无脚本）。 */
function crashPageDataUrl(): string {
  const html =
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>Otto - 界面已停止响应</title></head>' +
    '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
    'min-height:100vh;background:#181818;color:#ddd;' +
    'font-family:system-ui,-apple-system,sans-serif">' +
    '<div style="max-width:32em;padding:2em;line-height:1.8">' +
    '<h1 style="font-size:1.3em;color:#fff">Otto 界面多次崩溃</h1>' +
    '<p>渲染进程在短时间内反复异常退出，已停止自动恢复以避免闪烁。</p>' +
    '<p>请退出并重新启动 Otto；若问题持续出现，请附终端日志反馈。</p>' +
    '</div></body></html>';
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** 是否可放行到系统浏览器的外链（仅 http/https）。 */
function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

// ────────────────────────────────────────────────────────────────────────
// 安全：CSP + 权限
// ────────────────────────────────────────────────────────────────────────

/** 本地 CSP：只允许自身资源 + 连本地 server WS/HTTP。 */
function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const host = endpoint?.host ?? CSP_FALLBACK_HOST;
    // 首个 renderer 响应头通常早于 ensureEndpoint() 完成；若用户通过环境变量指定
    // 内嵌 server 端口，CSP 也必须从第一帧就放行同一端口，否则 WS 会被浏览器拦截、
    // UI 永久显示“正在重连”，即使 server 实际已健康监听。
    const configuredPort = Number(process.env.OTTO_SERVER_PORT);
    const configuredStartPort =
      Number.isFinite(configuredPort) && configuredPort > 0
        ? configuredPort
        : CSP_FALLBACK_PORT;
    const ports = endpoint
      ? [endpoint.port]
      : Array.from({ length: 11 }, (_, index) => configuredStartPort + index);
    // HTTPS 只用于员工头像图片；脚本和网络请求仍严格限制在自身与本地 server。
    const csp = buildRendererCsp(host, ports);
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  // 仅放行本地 renderer 的音频录制；摄像头/地理位置等继续拒绝。
  session.defaultSession.setPermissionRequestHandler(
    (wc, perm, cb, details) => {
      const trusted = wc === mainWindow?.webContents;
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : [];
      const wantsAudio = perm === 'media' && mediaTypes?.includes('audio');
      const wantsVideo = perm === 'media' && mediaTypes?.includes('video');
      cb(Boolean(trusted && wantsAudio && !wantsVideo));
    },
  );
}

// ────────────────────────────────────────────────────────────────────────
// server 端点：发现/拉起 + 推送给 renderer
// ────────────────────────────────────────────────────────────────────────

/** 确保 server 可用并把端点缓存下来；失败不抛（renderer 显示「未连接」）。 */
function scheduleEndpointRetry(): void {
  if (isQuitting || endpointRetryTimer) return;
  const waitMs = Math.min(
    30_000,
    1_000 * 2 ** Math.min(endpointRetryAttempt, 5),
  );
  endpointRetryAttempt += 1;
  endpointRetryTimer = setTimeout(() => {
    endpointRetryTimer = undefined;
    void ensureEndpoint();
  }, waitMs);
  endpointRetryTimer.unref();
}

async function ensureEndpoint(): Promise<void> {
  if (endpointEnsurePromise) return endpointEnsurePromise;
  const operation = (async () => {
    try {
      tracer.updateStatus('正在连接服务…');
      const ensured = await serverManager.ensure();
      endpoint = ensured.endpoint;
      endpointRetryAttempt = 0;
      if (endpointRetryTimer) {
        clearTimeout(endpointRetryTimer);
        endpointRetryTimer = undefined;
      }
      tracer.updateStatus('服务运行中');
      console.log(
        `[otto-desktop] server ${ensured.ownership} @ http://${endpoint.host}:${endpoint.port}`,
      );
      pushEndpointToRenderer();
    } catch (e) {
      endpoint = undefined;
      tracer.updateStatus('服务启动失败，正在重试');
      pushEndpointToRenderer();
      scheduleEndpointRetry();
      console.error('[otto-desktop] server 启动失败:', e);
    }
  })();
  endpointEnsurePromise = operation;
  try {
    await operation;
  } finally {
    if (endpointEnsurePromise === operation) endpointEnsurePromise = undefined;
  }
}

/** 主动把最新端点推给 renderer（preload 据此触发 connect）。 */
function pushEndpointToRenderer(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.endpointChanged, endpoint ?? null);
  }
}

// ────────────────────────────────────────────────────────────────────────
// IPC
// ────────────────────────────────────────────────────────────────────────

function parseLegalDocumentReferences(
  value: unknown,
): EnterpriseLegalDocumentReference[] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('请重新打开并阅读当前用户协议和隐私规则');
  }
  const seen = new Set<string>();
  const references = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('协议版本信息格式不正确');
    }
    const record = entry as Record<string, unknown>;
    if (
      (record.id !== 'terms' && record.id !== 'privacy') ||
      typeof record.version !== 'string' ||
      typeof record.hash !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(record.hash) ||
      seen.has(record.id)
    ) {
      throw new Error('协议版本信息格式不正确');
    }
    const id = record.id as EnterpriseLegalDocumentReference['id'];
    seen.add(id);
    return {
      id,
      version: record.version as string,
      hash: record.hash as string,
    };
  });
  return references;
}

async function authenticatedSkillScope(): Promise<EnterpriseSkillScope | null> {
  loadEnterpriseSession();
  let account = enterpriseClient.authenticatedAccountSnapshot();
  if (!account && enterpriseClient.snapshot().token) {
    account = (await enterpriseClient.getSession()).account;
  }
  const teamId = account?.departmentId?.trim();
  return teamId ? { teamId } : null;
}

function registerIpc(): void {
  const enterpriseSkillLibrary = new EnterpriseSkillLibrary(
    path.join(process.cwd(), '.otto', 'org', 'skill-shares.json'),
  );
  ipcMain.handle(IPC.writeClipboard, (_e, text: unknown) => {
    if (typeof text !== 'string') return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle(IPC.readClipboardText, () => clipboard.readText());
  ipcMain.handle(IPC.autoGeneratedAgentProfiles, async () => {
    try {
      const { loadAutoGeneratedProfiles } = await import('otto-core');
      return loadAutoGeneratedProfiles();
    } catch (error) {
      console.warn('[otto-desktop] 自动 Skill 专家读取失败：', error);
      return [];
    }
  });
  ipcMain.handle(IPC.enterpriseRegistrationIntent, () => {
    enterpriseIntentRendererReady = true;
    return enterpriseRegistrationIntents.take();
  });
  ipcMain.handle(IPC.enterpriseSession, () =>
    enterpriseAuthOperations.run(async () => {
      loadEnterpriseSession();
      const before = enterpriseClient.snapshot().token;
      const result = await restoreAndSyncEnterpriseSession(
        await enterpriseClient.getSession(),
        enterpriseClient,
        synchronizeAuthenticatedEnterpriseAccount,
        saveEnterpriseSession,
      );
      if (before && !enterpriseClient.snapshot().token) saveEnterpriseSession();
      return result;
    }),
  );
  ipcMain.handle(IPC.enterprisePasswordLogin, async (_e, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('登录信息格式不正确');
    const body = input as Record<string, unknown>;
    const identifier =
      typeof body.identifier === 'string'
        ? body.identifier
        : typeof body.username === 'string'
          ? body.username
          : null;
    if (
      typeof body.serverUrl !== 'string' ||
      identifier === null ||
      typeof body.password !== 'string'
    ) {
      throw new Error('服务器地址、账号或手机号和密码均为必填项');
    }
    return enterpriseAuthOperations.run(async () => {
      const result = await authenticateAndSyncEnterpriseAccount(
        () =>
          enterpriseClient.loginWithPassword(
            body.serverUrl as string,
            identifier,
            body.password as string,
          ),
        enterpriseClient,
        synchronizeAuthenticatedEnterpriseAccount,
        saveEnterpriseSession,
      );
      return { ...result, serverUrl: enterpriseClient.snapshot().serverUrl };
    });
  });
  ipcMain.handle(IPC.enterpriseSmsLoginRequest, async (_e, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('登录信息格式不正确');
    const body = input as Record<string, unknown>;
    if (typeof body.serverUrl !== 'string' || typeof body.phone !== 'string') {
      throw new Error('服务器地址和手机号均为必填项');
    }
    return enterpriseAuthOperations.run(async () => {
      const result = await enterpriseClient.requestLoginCode(
        body.serverUrl as string,
        body.phone as string,
      );
      saveEnterpriseSession();
      return { ...result, serverUrl: enterpriseClient.snapshot().serverUrl };
    });
  });
  ipcMain.handle(IPC.enterpriseSmsLoginVerify, async (_e, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('登录信息格式不正确');
    const body = input as Record<string, unknown>;
    if (typeof body.challengeId !== 'string' || typeof body.code !== 'string') {
      throw new Error('验证码信息不完整');
    }
    return enterpriseAuthOperations.run(async () => {
      const result = await authenticateAndSyncEnterpriseAccount(
        () =>
          enterpriseClient.loginWithSms({
            challengeId: body.challengeId as string,
            code: body.code as string,
          }),
        enterpriseClient,
        synchronizeAuthenticatedEnterpriseAccount,
        saveEnterpriseSession,
      );
      return { ...result, serverUrl: enterpriseClient.snapshot().serverUrl };
    });
  });
  ipcMain.handle(
    IPC.enterpriseRegistrationRequest,
    async (_e, input: unknown) => {
      loadEnterpriseSession();
      if (!input || typeof input !== 'object')
        throw new Error('注册信息格式不正确');
      const body = input as Record<string, unknown>;
      if (
        typeof body.serverUrl !== 'string' ||
        typeof body.phone !== 'string' ||
        (body.inviteCode !== undefined && typeof body.inviteCode !== 'string')
      ) {
        throw new Error('服务器地址和手机号均为必填项');
      }
      return enterpriseAuthOperations.run(async () => {
        const result = await enterpriseClient.requestRegistrationCode(
          body.serverUrl as string,
          body.phone as string,
          typeof body.inviteCode === 'string' ? body.inviteCode : '',
        );
        saveEnterpriseSession();
        return { ...result, serverUrl: enterpriseClient.snapshot().serverUrl };
      });
    },
  );
  ipcMain.handle(IPC.enterpriseRegister, async (_e, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('注册信息格式不正确');
    const body = input as Record<string, unknown>;
    if (
      typeof body.challengeId !== 'string' ||
      typeof body.code !== 'string' ||
      typeof body.name !== 'string' ||
      typeof body.password !== 'string' ||
      body.legalConsent !== true
    ) {
      throw new Error('姓名、密码和验证码均为必填项');
    }
    const legalDocuments = parseLegalDocumentReferences(body.legalDocuments);
    return enterpriseAuthOperations.run(async () => {
      const result = await authenticateAndSyncEnterpriseAccount(
        () =>
          enterpriseClient.registerWithSms({
            challengeId: body.challengeId as string,
            code: body.code as string,
            name: body.name as string,
            password: body.password as string,
            legalConsent: true,
            legalDocuments,
          }),
        enterpriseClient,
        synchronizeAuthenticatedEnterpriseAccount,
        saveEnterpriseSession,
      );
      return { ...result, serverUrl: enterpriseClient.snapshot().serverUrl };
    });
  });
  ipcMain.handle(IPC.enterpriseJoinOrganization, async (_e, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('企业邀请码格式不正确');
    const body = input as Record<string, unknown>;
    if (typeof body.inviteCode !== 'string')
      throw new Error('企业邀请码为必填项');
    return enterpriseAuthOperations.run(async () => {
      let result;
      try {
        result = await enterpriseClient.joinOrganization(
          body.inviteCode as string,
        );
      } catch (error) {
        if (error instanceof EnterpriseJoinStateUncertainError) {
          return failClosedUncertainEnterpriseJoin(
            error,
            enterpriseClient,
            synchronizeAuthenticatedEnterpriseAccount,
            saveEnterpriseSession,
          );
        }
        throw error;
      }
      await syncJoinedEnterpriseAccount(
        result.account,
        enterpriseClient,
        synchronizeAuthenticatedEnterpriseAccount,
        saveEnterpriseSession,
      );
      saveEnterpriseSession();
      return { ...result, serverUrl: enterpriseClient.snapshot().serverUrl };
    });
  });
  ipcMain.handle(IPC.enterpriseLogout, async () => {
    await enterpriseAuthOperations.run(async () => {
      loadEnterpriseSession();
      await flushEnterpriseAccountDataSync(5_000);
      await logoutAndClearEnterpriseIdentity(
        enterpriseClient,
        synchronizeAuthenticatedEnterpriseAccount,
        saveEnterpriseSession,
      );
      fileAccessGrants.clear();
      notificationService.clearAll();
      resetEnterpriseModuleUpdateState();
    });
  });
  ipcMain.handle(IPC.enterprisePair, async (_e, token: unknown) => {
    if (typeof token !== 'string' || token.trim().length === 0) {
      return { ok: false, message: '令牌格式不正确' };
    }
    const trimmed = token.trim().toUpperCase();
    try {
      const serverUrl =
        enterpriseClient.snapshot().serverUrl || DEFAULT_ENTERPRISE_SERVER_URL;
      const res = await fetch(
        `${serverUrl}/enterprise/local-agent/pair/verify`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: trimmed }),
        },
      );
      if (!res.ok) {
        const errBody = await res
          .json()
          .catch(() => ({ error: 'server error' }));
        return {
          ok: false,
          message: (errBody as { error?: string }).error ?? '令牌无效或已过期',
        };
      }
      const data = (await res.json()) as {
        ok: boolean;
        data?: { instanceId?: string };
      };
      return {
        ok: true,
        message: '企业服务器接入成功！',
        enterpriseUrl: serverUrl,
        instanceId: data.data?.instanceId ?? '',
      };
    } catch (e) {
      return {
        ok: false,
        message: `无法连接企业服务器：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  });
  ipcMain.handle(IPC.enterpriseAccounts, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listAccounts();
  });
  ipcMain.handle(
    IPC.enterpriseAccountCreate,
    async (_e, input: AccountCreateInput) => {
      loadEnterpriseSession();
      return enterpriseClient.createAccount(input);
    },
  );
  ipcMain.handle(
    IPC.enterpriseAccountUpdate,
    (_e, id: unknown, input: AccountUpdateInput) =>
      enterpriseAuthOperations.run(async () => {
        loadEnterpriseSession();
        if (typeof id !== 'string' || !id) throw new Error('账号 ID 不正确');
        const currentBefore = enterpriseClient.authenticatedAccountSnapshot();
        const updated = await enterpriseClient.updateAccount(id, input);
        if (currentBefore?.id === id) {
          // 自改管理员权限/密码/状态会让中心服务撤销当前 session，此时快照为 null；
          // 不能把 PATCH 响应当作仍有效身份继续授权，必须 fail closed 清本机身份。
          await syncVerifiedEnterpriseAccount(
            enterpriseClient.authenticatedAccountSnapshot(),
            enterpriseClient,
            synchronizeAuthenticatedEnterpriseAccount,
            saveEnterpriseSession,
          );
          const current = enterpriseClient.authenticatedAccountSnapshot();
          if (current) notifyEnterpriseAccountUpdated(current);
        }
        return updated;
      }),
  );
  ipcMain.handle(IPC.enterpriseAccountDelete, async (_e, id: unknown) => {
    loadEnterpriseSession();
    if (typeof id !== 'string' || !id) throw new Error('账号 ID 不正确');
    return enterpriseClient.deleteAccount(id);
  });
  ipcMain.handle(IPC.enterpriseDataGovernanceGet, async () => {
    loadEnterpriseSession();
    return enterpriseClient.getDataGovernanceProfile();
  });
  ipcMain.handle(IPC.enterpriseLegalAccept, async (_event, input: unknown) => {
    loadEnterpriseSession();
    return enterpriseClient.acceptCurrentLegalDocuments(
      parseLegalDocumentReferences(input),
    );
  });
  ipcMain.handle(IPC.enterprisePrivacyExport, async () => {
    loadEnterpriseSession();
    const payload = await enterpriseClient.exportMyAccountData();
    const account = enterpriseClient.authenticatedAccountSnapshot();
    const suggested = `otto-personal-data-${account?.id ?? 'account'}-${new Date().toISOString().slice(0, 10)}.json`;
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: '导出我的 Otto 数据',
          defaultPath: path.join(app.getPath('documents'), suggested),
          filters: [{ name: 'JSON 数据文件', extensions: ['json'] }],
        })
      : await dialog.showSaveDialog({
          title: '导出我的 Otto 数据',
          defaultPath: path.join(app.getPath('documents'), suggested),
          filters: [{ name: 'JSON 数据文件', extensions: ['json'] }],
        });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(
      result.filePath,
      `${JSON.stringify(payload, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return { ok: true as const, path: result.filePath };
  });
  ipcMain.handle(
    IPC.enterprisePrivacyDelete,
    async (_event, input: unknown) => {
      loadEnterpriseSession();
      if (!input || typeof input !== 'object')
        throw new Error('注销信息格式不正确');
      const body = input as Record<string, unknown>;
      if (
        typeof body.password !== 'string' ||
        typeof body.confirmation !== 'string'
      ) {
        throw new Error('请输入登录密码和注销确认文字');
      }
      return enterpriseAuthOperations.run(
        async (): Promise<EnterprisePrivacyDeletionReceipt> => {
          const account = enterpriseClient.authenticatedAccountSnapshot();
          if (!account) throw new Error('登录已失效，请重新登录');
          const identity = accountDataSyncIdentity(account);
          const receipt = await enterpriseClient.deleteMyAccount({
            password: body.password as string,
            confirmation: body.confirmation as string,
          });
          if (identity) await accountDataSyncService.erase(identity);
          await synchronizeAuthenticatedEnterpriseAccount(null);
          saveEnterpriseSession();
          fileAccessGrants.clear();
          notificationService.clearAll();
          resetEnterpriseModuleUpdateState();
          return receipt;
        },
      );
    },
  );
  ipcMain.handle(IPC.enterpriseUsageRecord, async (_e, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('Token 用量格式不正确');
    const body = input as Record<string, unknown>;
    if (
      typeof body.sessionId !== 'string' ||
      typeof body.messageId !== 'string' ||
      typeof body.inputTokens !== 'number' ||
      typeof body.outputTokens !== 'number' ||
      typeof body.totalTokens !== 'number'
    ) {
      throw new Error('Token 用量字段不完整');
    }
    return enterpriseClient.recordTokenUsage({
      sessionId: body.sessionId,
      messageId: body.messageId,
      model: typeof body.model === 'string' ? body.model : null,
      inputTokens: body.inputTokens,
      outputTokens: body.outputTokens,
      totalTokens: body.totalTokens,
    });
  });
  ipcMain.handle(
    IPC.enterpriseUsageProfile,
    async (_event, periodDays: unknown): Promise<PersonalTokenUsageProfile> => {
      loadEnterpriseSession();
      const period = periodDays === undefined ? 30 : periodDays;
      if (
        typeof period !== 'number' ||
        !Number.isInteger(period) ||
        period < 1 ||
        period > 365
      ) {
        throw new Error('Token 统计周期必须是 1 到 365 天的整数');
      }
      return enterpriseClient.getPersonalTokenUsageProfile(period);
    },
  );
  ipcMain.handle(IPC.enterpriseKnowledgeRecord, async (_e, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('知识条目格式不正确');
    const body = input as Record<string, unknown>;
    if (
      typeof body.sourceId !== 'string' ||
      !body.sourceId ||
      typeof body.category !== 'string' ||
      !body.category ||
      typeof body.content !== 'string' ||
      !body.content
    ) {
      throw new Error('知识条目字段不完整');
    }
    const confidence =
      typeof body.confidence === 'number' && Number.isFinite(body.confidence)
        ? Math.min(1, Math.max(0, body.confidence))
        : 0.5;
    const record: EnterpriseKnowledgeRecordInput = {
      sourceId: body.sourceId,
      title: typeof body.title === 'string' ? body.title : undefined,
      category: body.category,
      content: body.content,
      confidence,
      sourceType:
        body.sourceType === 'manual' ||
        body.sourceType === 'auto_capture' ||
        body.sourceType === 'work_result' ||
        body.sourceType === 'task_log' ||
        body.sourceType === 'document' ||
        body.sourceType === 'offboarding'
          ? body.sourceType
          : undefined,
      sourceLabel:
        typeof body.sourceLabel === 'string' ? body.sourceLabel : undefined,
      sourceSessionId:
        typeof body.sourceSessionId === 'string'
          ? body.sourceSessionId
          : undefined,
      sourceFingerprint:
        typeof body.sourceFingerprint === 'string'
          ? body.sourceFingerprint
          : undefined,
      tags: Array.isArray(body.tags)
        ? body.tags
            .filter((tag): tag is string => typeof tag === 'string')
            .slice(0, 8)
        : undefined,
      verified: body.verified === true,
      impactScore:
        typeof body.impactScore === 'number' &&
        Number.isFinite(body.impactScore)
          ? Math.min(1, Math.max(0, body.impactScore))
          : undefined,
      significanceSignals: Array.isArray(body.significanceSignals)
        ? body.significanceSignals
            .filter((signal): signal is string => typeof signal === 'string')
            .slice(0, 8)
        : undefined,
      observedAt:
        typeof body.observedAt === 'string' ? body.observedAt : undefined,
    };
    return enterpriseClient.recordKnowledge(record);
  });
  ipcMain.handle(IPC.enterpriseKnowledgeList, async (_e, input: unknown) => {
    loadEnterpriseSession();
    const body =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {};
    return enterpriseClient.listKnowledge({
      query: typeof body.query === 'string' ? body.query : undefined,
      department:
        typeof body.department === 'string' ? body.department : undefined,
      includeReview: body.includeReview === true,
      status:
        body.status === 'pending_review' ||
        body.status === 'active' ||
        body.status === 'archived'
          ? body.status
          : undefined,
    });
  });
  ipcMain.handle(IPC.enterpriseKnowledgeReview, async (_e, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('知识审核格式不正确');
    const body = input as Record<string, unknown>;
    if (
      typeof body.id !== 'string' ||
      !/^\d+$/u.test(body.id) ||
      (body.action !== 'approve' && body.action !== 'archive')
    ) {
      throw new Error('知识审核字段不完整');
    }
    return enterpriseClient.reviewKnowledge(
      body.id,
      body.action,
      typeof body.note === 'string' ? body.note : undefined,
    );
  });
  ipcMain.handle(IPC.enterpriseKnowledgeRevise, async (_e, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('知识修订格式不正确');
    const body = input as Record<string, unknown>;
    const revision =
      body.input && typeof body.input === 'object'
        ? (body.input as Record<string, unknown>)
        : {};
    if (
      typeof body.id !== 'string' ||
      !/^\d+$/u.test(body.id) ||
      typeof revision.title !== 'string' ||
      !revision.title.trim() ||
      typeof revision.category !== 'string' ||
      !revision.category.trim() ||
      typeof revision.content !== 'string' ||
      !revision.content.trim()
    ) {
      throw new Error('知识修订字段不完整');
    }
    return enterpriseClient.reviseKnowledge(body.id, {
      title: revision.title,
      category: revision.category,
      content: revision.content,
      confidence:
        typeof revision.confidence === 'number'
          ? revision.confidence
          : undefined,
      changeNote:
        typeof revision.changeNote === 'string'
          ? revision.changeNote
          : undefined,
    });
  });
  ipcMain.handle(
    IPC.enterpriseKnowledgeRevisions,
    async (_e, input: unknown) => {
      loadEnterpriseSession();
      const body =
        input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {};
      if (typeof body.id !== 'string' || !/^\d+$/u.test(body.id)) {
        throw new Error('知识版本参数不正确');
      }
      return enterpriseClient.listKnowledgeRevisions(body.id);
    },
  );
  ipcMain.handle(
    IPC.enterpriseOrganizationView,
    async (_event, organizationId: unknown) => {
      loadEnterpriseSession();
      return enterpriseClient.getOrganizationView(
        typeof organizationId === 'string' ? organizationId : undefined,
      );
    },
  );
  ipcMain.handle(IPC.enterprisePresenceHeartbeat, async () => {
    loadEnterpriseSession();
    await enterpriseClient.heartbeatPresence('desktop');
  });
  ipcMain.handle(IPC.enterpriseOrganizationFeaturesGet, async () => {
    loadEnterpriseSession();
    return enterpriseClient.getOrganizationFeatures();
  });
  ipcMain.handle(
    IPC.enterpriseOrganizationFeaturesUpdate,
    async (_event, input: unknown) => {
      loadEnterpriseSession();
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('功能开关格式不正确');
      }
      const allowed = new Set([
        'enterprise_tree',
        'park_service',
        'feishu_auto_reply',
        'direct_messages',
        'atoa',
        'knowledge',
        'skill_market',
      ]);
      const patch = Object.fromEntries(
        Object.entries(input).filter(
          (entry): entry is [keyof EnterpriseOrganizationFeatures, boolean] =>
            allowed.has(entry[0]) && typeof entry[1] === 'boolean',
        ),
      );
      return enterpriseClient.updateOrganizationFeatures(patch);
    },
  );
  ipcMain.handle(IPC.enterpriseOrganizationDepartments, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listOrganizationDepartments();
  });
  ipcMain.handle(
    IPC.enterpriseOrganizationDepartmentCreate,
    async (_event, name: unknown) => {
      loadEnterpriseSession();
      if (typeof name !== 'string' || !name.trim())
        throw new Error('部门名称不能为空');
      return enterpriseClient.createOrganizationDepartment(name);
    },
  );
  ipcMain.handle(
    IPC.enterpriseOrganizationDepartmentUpdate,
    async (_event, id: unknown, name: unknown) => {
      loadEnterpriseSession();
      if (
        typeof id !== 'string' ||
        !id ||
        typeof name !== 'string' ||
        !name.trim()
      ) {
        throw new Error('部门信息不正确');
      }
      return enterpriseClient.updateOrganizationDepartment(id, name);
    },
  );
  ipcMain.handle(
    IPC.enterpriseOrganizationDepartmentDelete,
    async (_event, id: unknown) => {
      loadEnterpriseSession();
      if (typeof id !== 'string' || !id) throw new Error('部门信息不正确');
      await enterpriseClient.deleteOrganizationDepartment(id);
      return true;
    },
  );
  ipcMain.handle(
    IPC.enterpriseOrganizationPositionCreate,
    async (_event, input: unknown) => {
      loadEnterpriseSession();
      const body =
        input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {};
      if (
        typeof body.departmentId !== 'string' ||
        typeof body.title !== 'string' ||
        !['member', 'department_admin', 'enterprise_admin'].includes(
          String(body.roleMapping),
        )
      ) {
        throw new Error('职位信息不正确');
      }
      return enterpriseClient.createOrganizationPosition({
        departmentId: body.departmentId,
        title: body.title,
        roleMapping: body.roleMapping as EnterprisePositionRoleMapping,
      });
    },
  );
  ipcMain.handle(
    IPC.enterpriseOrganizationPositionUpdate,
    async (_event, id: unknown, input: unknown) => {
      loadEnterpriseSession();
      const body =
        input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {};
      if (
        typeof id !== 'string' ||
        !id ||
        (body.roleMapping !== undefined &&
          !['member', 'department_admin', 'enterprise_admin'].includes(
            String(body.roleMapping),
          ))
      ) {
        throw new Error('职位信息不正确');
      }
      return enterpriseClient.updateOrganizationPosition(id, {
        title: typeof body.title === 'string' ? body.title : undefined,
        roleMapping: body.roleMapping as
          EnterprisePositionRoleMapping | undefined,
      });
    },
  );
  ipcMain.handle(
    IPC.enterpriseOrganizationPositionDelete,
    async (_event, id: unknown) => {
      loadEnterpriseSession();
      if (typeof id !== 'string' || !id) throw new Error('职位信息不正确');
      await enterpriseClient.deleteOrganizationPosition(id);
      return true;
    },
  );
  ipcMain.handle(
    IPC.enterpriseMessagesList,
    async (_event, peerAccountId: unknown) => {
      loadEnterpriseSession();
      if (typeof peerAccountId !== 'string' || !peerAccountId)
        throw new Error('成员信息不正确');
      if (enterpriseClient.supportsMlsPrivateMessages()) {
        return enterpriseMlsPrivateMessages.list(peerAccountId);
      }
      return enterpriseClient.listDirectMessages(peerAccountId);
    },
  );
  ipcMain.handle(IPC.enterpriseMessagesUnread, async () => {
    loadEnterpriseSession();
    return listEnterpriseUnreadMessageNotifications();
  });
  ipcMain.handle(
    IPC.enterpriseMessageSend,
    async (
      _event,
      peerAccountId: unknown,
      content: unknown,
      attachments: unknown,
    ) => {
      loadEnterpriseSession();
      if (
        typeof peerAccountId !== 'string' ||
        !peerAccountId ||
        typeof content !== 'string'
      ) {
        throw new Error('消息信息不正确');
      }
      const normalizedAttachments =
        normalizeEnterpriseMessageAttachments(attachments);
      if (!content.trim() && normalizedAttachments.length === 0) {
        throw new Error('请输入消息或添加附件');
      }
      if (enterpriseClient.supportsMlsPrivateMessages()) {
        return enterpriseMlsPrivateMessages.send(
          peerAccountId,
          content,
          normalizedAttachments,
        );
      }
      return enterpriseClient.sendDirectMessage(
        peerAccountId,
        content,
        normalizedAttachments,
      );
    },
  );
  ipcMain.handle(
    IPC.enterpriseMessageAttachmentRead,
    async (_event, attachmentId: unknown) => {
      loadEnterpriseSession();
      if (
        typeof attachmentId !== 'string' ||
        !attachmentId ||
        attachmentId.length > 160
      ) {
        throw new Error('附件信息不正确');
      }
      if (enterpriseClient.supportsMlsPrivateMessages()) {
        return enterpriseMlsPrivateMessages.readAttachment(attachmentId);
      }
      return enterpriseClient.getDirectMessageAttachment(attachmentId);
    },
  );
  ipcMain.handle(IPC.enterpriseFederationContactCode, async () => {
    loadEnterpriseSession();
    return enterpriseClient.exportFederationContactCode();
  });
  ipcMain.handle(
    IPC.enterpriseFederationContactImport,
    async (_event, code: unknown) => {
      loadEnterpriseSession();
      if (typeof code !== 'string' || !code.trim() || code.length > 64_000) {
        throw new Error('联邦联系码无效');
      }
      return enterpriseClient.saveFederationContactCode(code);
    },
  );
  ipcMain.handle(IPC.enterpriseFederationContacts, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listFederationContacts();
  });
  ipcMain.handle(
    IPC.enterpriseFederationContactRemove,
    async (_event, contactId: unknown) => {
      loadEnterpriseSession();
      if (typeof contactId !== 'string' || !contactId) {
        throw new Error('联邦联系人无效');
      }
      await enterpriseClient.removeFederationContact(contactId);
      return true;
    },
  );
  ipcMain.handle(
    IPC.enterpriseFederationMessagesList,
    async (_event, contactId: unknown, options: unknown) => {
      loadEnterpriseSession();
      if (typeof contactId !== 'string' || !contactId) {
        throw new Error('联邦联系人无效');
      }
      const markRead = !(
        options && typeof options === 'object' &&
        'markRead' in options && options.markRead === false
      );
      return enterpriseClient.listFederationMessages(contactId, { markRead });
    },
  );
  ipcMain.handle(
    IPC.enterpriseFederationMessageSend,
    async (_event, contactId: unknown, content: unknown, attachments: unknown) => {
      loadEnterpriseSession();
      if (
        typeof contactId !== 'string' ||
        !contactId ||
        typeof content !== 'string'
      ) {
        throw new Error('联邦消息无效');
      }
      const normalizedAttachments = normalizeEnterpriseMessageAttachments(
        attachments,
        {
          maxFileBytes: 1024 * 1024 * 1024,
          maxTotalBytes: 1024 * 1024 * 1024,
        },
      );
      if (!content.trim() && normalizedAttachments.length === 0) {
        throw new Error('请输入消息或添加附件');
      }
      return enterpriseClient.sendFederationMessage(
        contactId,
        content,
        normalizedAttachments,
      );
    },
  );
  ipcMain.handle(
    IPC.enterpriseFederationAttachmentSave,
    async (
      _event,
      contactId: unknown,
      messageId: unknown,
      attachmentId: unknown,
      suggestedFileName: unknown,
    ) => {
      loadEnterpriseSession();
      if (
        typeof contactId !== 'string' || !contactId ||
        typeof messageId !== 'string' || !messageId ||
        typeof attachmentId !== 'string' || !attachmentId ||
        typeof suggestedFileName !== 'string' || !suggestedFileName
      ) {
        throw new Error('联邦附件信息无效');
      }
      const safeName = path.basename(suggestedFileName).slice(0, 255);
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, {
            defaultPath: path.join(app.getPath('downloads'), safeName),
          })
        : await dialog.showSaveDialog({
            defaultPath: path.join(app.getPath('downloads'), safeName),
          });
      if (result.canceled || !result.filePath) return null;
      return enterpriseClient.saveFederationMessageAttachment({
        contactId,
        messageId,
        attachmentId,
        destinationPath: result.filePath,
      });
    },
  );
  ipcMain.handle(IPC.enterpriseFederationAtoaTasks, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listFederationAtoaTasks();
  });
  ipcMain.handle(
    IPC.enterpriseFederationAtoaApprove,
    async (_event, input: unknown) => {
      loadEnterpriseSession();
      if (!input || typeof input !== 'object') {
        throw new Error('A2A 授权请求无效');
      }
      const candidate = input as Record<string, unknown>;
      if (
        typeof candidate.contactId !== 'string' || !candidate.contactId ||
        typeof candidate.messageId !== 'string' || !candidate.messageId
      ) {
        throw new Error('A2A 授权请求无效');
      }
      return enterpriseClient.approveFederationAtoaProposal({
        contactId: candidate.contactId,
        messageId: candidate.messageId,
        grantedSources: normalizeEnterpriseAtoaSources(candidate.grantedSources),
      });
    },
  );
  ipcMain.handle(
    IPC.enterpriseFederationAtoaDeny,
    async (_event, input: unknown) => {
      loadEnterpriseSession();
      if (!input || typeof input !== 'object') {
        throw new Error('A2A 拒绝请求无效');
      }
      const candidate = input as Record<string, unknown>;
      if (
        typeof candidate.contactId !== 'string' || !candidate.contactId ||
        typeof candidate.messageId !== 'string' || !candidate.messageId
      ) {
        throw new Error('A2A 拒绝请求无效');
      }
      return enterpriseClient.denyFederationAtoaProposal({
        contactId: candidate.contactId,
        messageId: candidate.messageId,
      });
    },
  );
  ipcMain.handle(
    IPC.enterpriseFederationAtoaDispatch,
    async (_event, input: unknown) => {
      loadEnterpriseSession();
      if (!input || typeof input !== 'object') {
        throw new Error('A2A 派发请求无效');
      }
      const candidate = input as Record<string, unknown>;
      if (
        typeof candidate.contactId !== 'string' || !candidate.contactId ||
        typeof candidate.decisionMessageId !== 'string' ||
        !candidate.decisionMessageId
      ) {
        throw new Error('A2A 派发请求无效');
      }
      return enterpriseClient.dispatchFederationAtoaGrant({
        contactId: candidate.contactId,
        decisionMessageId: candidate.decisionMessageId,
      });
    },
  );
  ipcMain.handle(
    IPC.enterpriseFederationAtoaRespond,
    async (_event, input: unknown) => {
      loadEnterpriseSession();
      if (!input || typeof input !== 'object') {
        throw new Error('A2A 回复请求无效');
      }
      const candidate = input as Record<string, unknown>;
      if (
        typeof candidate.contactId !== 'string' || !candidate.contactId ||
        typeof candidate.requestMessageId !== 'string' ||
        !candidate.requestMessageId ||
        typeof candidate.answer !== 'string' || !candidate.answer.trim()
      ) {
        throw new Error('A2A 回复请求无效');
      }
      return enterpriseClient.respondFederationAtoaRequest({
        contactId: candidate.contactId,
        requestMessageId: candidate.requestMessageId,
        answer: candidate.answer.trim().slice(0, 2400),
        grantedSources: normalizeEnterpriseAtoaSources(candidate.grantedSources),
      });
    },
  );
  ipcMain.handle(
    IPC.enterpriseFederationContactVerification,
    async (_event, contactId: unknown) => {
      loadEnterpriseSession();
      if (typeof contactId !== 'string' || !contactId) {
        throw new Error('联邦联系人无效');
      }
      return enterpriseClient.federationContactVerification(contactId);
    },
  );
  ipcMain.handle(
    IPC.enterpriseFederationContactVerify,
    async (_event, contactId: unknown) => {
      loadEnterpriseSession();
      if (typeof contactId !== 'string' || !contactId) {
        throw new Error('联邦联系人无效');
      }
      return enterpriseClient.verifyFederationContact(contactId);
    },
  );
  ipcMain.handle(
    IPC.enterpriseMessageSecurityReset,
    async (_event, peerAccountId: unknown) => {
      loadEnterpriseSession();
      if (
        typeof peerAccountId !== 'string' ||
        !peerAccountId ||
        peerAccountId.length > 200
      ) {
        throw new Error('E2EE reset peer account id is invalid');
      }
      if (!enterpriseClient.supportsMlsPrivateMessages()) {
        throw new Error('MLS private-message protocol is not active');
      }
      await enterpriseMlsPrivateMessages.reset(peerAccountId);
    },
  );
  ipcMain.handle(IPC.enterpriseE2eeDevicesList, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listOwnE2eeDevices(true);
  });
  ipcMain.handle(IPC.enterpriseE2eeKeyTransparency, async () => {
    loadEnterpriseSession();
    return enterpriseClient.getOwnE2eeKeyTransparency();
  });
  ipcMain.handle(
    IPC.enterpriseE2eeDeviceApprove,
    async (_event, deviceId: unknown) => {
      loadEnterpriseSession();
      if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 200) {
        throw new Error('invalid E2EE device id');
      }
      return enterpriseClient.approveOwnE2eeDevice(deviceId);
    },
  );
  ipcMain.handle(
    IPC.enterpriseE2eeDeviceVerification,
    async (_event, deviceId: unknown) => {
      loadEnterpriseSession();
      if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 200) {
        throw new Error('invalid E2EE device id');
      }
      return enterpriseClient.getOwnE2eeDeviceVerification(deviceId);
    },
  );
  ipcMain.handle(
    IPC.enterpriseE2eeDeviceRevoke,
    async (_event, deviceId: unknown) => {
      loadEnterpriseSession();
      if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 200) {
        throw new Error('E2EE device id is invalid');
      }
      await enterpriseClient.revokeOwnE2eeDevice(deviceId);
    },
  );
  ipcMain.handle(
    IPC.enterpriseE2eeRecoveryExport,
    async (_event, passphrase: unknown) => {
      loadEnterpriseSession();
      if (typeof passphrase !== 'string' || passphrase.length > 1024) {
        throw new Error('E2EE recovery passphrase is invalid');
      }
      const account = enterpriseClient.authenticatedAccountSnapshot();
      const session = enterpriseClient.snapshot();
      if (!account || !session.serverUrl)
        throw new Error('enterprise session has expired');
      return enterpriseE2eeVault.exportRecoveryBundle(
        session.serverUrl,
        account.id,
        passphrase,
      );
    },
  );
  ipcMain.handle(
    IPC.enterpriseE2eeRecoveryImport,
    async (_event, bundle: unknown, passphrase: unknown) => {
      loadEnterpriseSession();
      if (
        typeof bundle !== 'string' ||
        bundle.length > 10 * 1024 * 1024 ||
        typeof passphrase !== 'string' ||
        passphrase.length > 1024
      ) {
        throw new Error('E2EE recovery input is invalid');
      }
      const account = enterpriseClient.authenticatedAccountSnapshot();
      const session = enterpriseClient.snapshot();
      if (!account || !session.serverUrl)
        throw new Error('enterprise session has expired');
      enterpriseE2eeVault.importRecoveryBundle(
        session.serverUrl,
        account.id,
        bundle,
        passphrase,
      );
    },
  );
  ipcMain.handle(IPC.enterpriseAtoaInbox, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listAtoaInbox();
  });
  ipcMain.handle(
    IPC.enterpriseParkServicePush,
    async (_event, input: unknown) => {
      loadEnterpriseSession();
      const body =
        input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {};
      if (
        typeof body.recipientAccountId !== 'string' ||
        typeof body.serviceId !== 'string'
      ) {
        throw new Error('园区服务推送信息不正确');
      }
      return enterpriseClient.pushParkService({
        recipientAccountId: body.recipientAccountId,
        serviceId: body.serviceId,
        note: typeof body.note === 'string' ? body.note : null,
      });
    },
  );
  ipcMain.handle(IPC.enterpriseParkView, async () => {
    loadEnterpriseSession();
    return enterpriseClient.getParkView();
  });
  ipcMain.handle(IPC.enterpriseParkRegister, async (_event, input: unknown) => {
    loadEnterpriseSession();
    const body =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {};
    if (typeof body.name !== 'string' || !body.name.trim())
      throw new Error('产业园名称不能为空');
    return enterpriseClient.registerPark({
      name: body.name,
      slug: typeof body.slug === 'string' ? body.slug : undefined,
      brandName:
        typeof body.brandName === 'string' ? body.brandName : undefined,
    });
  });
  ipcMain.handle(IPC.enterpriseParkJoin, async (_event, input: unknown) => {
    loadEnterpriseSession();
    const body =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {};
    if (typeof body.inviteCode !== 'string' || !body.inviteCode.trim())
      throw new Error('产业园邀请码不能为空');
    if (typeof body.address !== 'string' || !body.address.trim())
      throw new Error('企业地址不能为空');
    if (typeof body.roomNumber !== 'string' || !body.roomNumber.trim())
      throw new Error('门牌号不能为空');
    return enterpriseClient.joinPark({
      inviteCode: body.inviteCode,
      address: body.address,
      roomNumber: body.roomNumber,
    });
  });
  ipcMain.handle(
    IPC.enterpriseParkProfileUpdate,
    async (_event, input: unknown) => {
      loadEnterpriseSession();
      const body =
        input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {};
      if (typeof body.address !== 'string' || !body.address.trim())
        throw new Error('企业地址不能为空');
      if (typeof body.roomNumber !== 'string' || !body.roomNumber.trim())
        throw new Error('门牌号不能为空');
      return enterpriseClient.updateParkTenantProfile({
        address: body.address,
        roomNumber: body.roomNumber,
      });
    },
  );
  ipcMain.handle(
    IPC.enterpriseParkInviteIssue,
    async (_event, maxUses: unknown) => {
      loadEnterpriseSession();
      if (
        maxUses !== null &&
        maxUses !== undefined &&
        typeof maxUses !== 'number'
      ) {
        throw new Error('邀请码使用次数不正确');
      }
      return enterpriseClient.issueParkInvite(
        maxUses as number | null | undefined,
      );
    },
  );
  ipcMain.handle(IPC.enterpriseParkTenants, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listParkTenantOrganizations();
  });
  ipcMain.handle(IPC.enterpriseParkStatistics, async () => {
    loadEnterpriseSession();
    return enterpriseClient.getParkStatistics();
  });
  ipcMain.handle(IPC.enterpriseParkSpecialists, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listParkSpecialists();
  });
  ipcMain.handle(
    IPC.enterpriseParkSpecialistSet,
    async (_event, serviceId: unknown, accountId: unknown) => {
      loadEnterpriseSession();
      if (
        typeof serviceId !== 'string' ||
        !serviceId ||
        typeof accountId !== 'string' ||
        !accountId
      ) {
        throw new Error('园区服务专员信息不正确');
      }
      return enterpriseClient.setParkSpecialist(serviceId, accountId);
    },
  );
  ipcMain.handle(
    IPC.enterpriseParkSpecialistRemove,
    async (_event, serviceId: unknown, accountId: unknown) => {
      loadEnterpriseSession();
      if (
        typeof serviceId !== 'string' ||
        !serviceId ||
        typeof accountId !== 'string' ||
        !accountId
      ) {
        throw new Error('园区服务专员信息不正确');
      }
      await enterpriseClient.removeParkSpecialist(serviceId, accountId);
      return true;
    },
  );
  ipcMain.handle(IPC.enterpriseParkServices, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listParkServices();
  });
  ipcMain.handle(
    IPC.enterpriseParkServiceUpdate,
    async (_event, input: unknown) => {
      loadEnterpriseSession();
      const body =
        input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {};
      if (typeof body.serviceId !== 'string' || !body.serviceId)
        throw new Error('园区服务信息不正确');
      const config =
        body.config &&
        typeof body.config === 'object' &&
        !Array.isArray(body.config)
          ? Object.fromEntries(
              Object.entries(body.config).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string',
              ),
            )
          : undefined;
      return enterpriseClient.updateParkService({
        serviceId: body.serviceId,
        name: typeof body.name === 'string' ? body.name : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        config,
      });
    },
  );
  ipcMain.handle(IPC.enterpriseParkPublications, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listParkPublications();
  });
  ipcMain.handle(IPC.enterpriseParkAnnouncementResults, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listParkAnnouncementResults();
  });
  ipcMain.handle(IPC.enterpriseParkSurveyResults, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listParkSurveyResults();
  });
  ipcMain.handle(
    IPC.enterpriseParkPublicationRead,
    async (_event, id: unknown) => {
      loadEnterpriseSession();
      if (typeof id !== 'string' || !id) throw new Error('园区内容编号不正确');
      return enterpriseClient.readParkPublication(id);
    },
  );
  ipcMain.handle(
    IPC.enterpriseParkSurveySubmit,
    async (_event, id: unknown, input: unknown) => {
      loadEnterpriseSession();
      if (
        typeof id !== 'string' ||
        !id ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input)
      ) {
        throw new Error('问卷提交内容不正确');
      }
      const responseData = Object.fromEntries(
        Object.entries(input).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      return enterpriseClient.submitParkSurvey(id, responseData);
    },
  );
  ipcMain.handle(IPC.enterpriseParkResources, async () => {
    loadEnterpriseSession();
    return enterpriseClient.getParkResources();
  });
  ipcMain.handle(IPC.enterpriseOrganizationInviteGet, async () => {
    loadEnterpriseSession();
    return enterpriseClient.getOrganizationInvite();
  });
  ipcMain.handle(
    IPC.enterpriseOrganizationInviteIssue,
    async (_event, input: unknown) => {
      loadEnterpriseSession();
      const body =
        input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {};
      return enterpriseClient.issueOrganizationInvite({
        defaultDepartment:
          typeof body.defaultDepartment === 'string'
            ? body.defaultDepartment
            : null,
        departmentId:
          typeof body.departmentId === 'string' ? body.departmentId : null,
        positionId:
          typeof body.positionId === 'string' ? body.positionId : null,
        positionTitle:
          typeof body.positionTitle === 'string' ? body.positionTitle : null,
        defaultRole:
          typeof body.defaultRole === 'string' ? body.defaultRole : null,
        maxUses: typeof body.maxUses === 'number' ? body.maxUses : null,
      });
    },
  );
  ipcMain.handle(IPC.enterpriseTicketInbox, async () => {
    loadEnterpriseSession();
    return enterpriseClient.ticketInbox();
  });
  ipcMain.handle(IPC.enterpriseTicketList, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listTickets();
  });
  ipcMain.handle(IPC.enterpriseTicketSubmit, async (_e, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('工单信息格式不正确');
    const body = input as Record<string, unknown>;
    if (
      typeof body.title !== 'string' ||
      typeof body.description !== 'string'
    ) {
      throw new Error('工单标题和描述均为必填项');
    }
    return enterpriseClient.submitTicket({
      serviceId:
        typeof body.serviceId === 'string' ? body.serviceId : undefined,
      title: body.title,
      description: body.description,
      targetTags: Array.isArray(body.targetTags)
        ? body.targetTags.filter(
            (tag): tag is string => typeof tag === 'string',
          )
        : undefined,
      formData:
        body.formData &&
        typeof body.formData === 'object' &&
        !Array.isArray(body.formData)
          ? Object.fromEntries(
              Object.entries(body.formData).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string',
              ),
            )
          : undefined,
      category: typeof body.category === 'string' ? body.category : undefined,
      location: typeof body.location === 'string' ? body.location : undefined,
      urgency: typeof body.urgency === 'string' ? body.urgency : undefined,
      contact: typeof body.contact === 'string' ? body.contact : undefined,
      contactPhone:
        typeof body.contactPhone === 'string' ? body.contactPhone : undefined,
    });
  });
  ipcMain.handle(IPC.enterpriseTicketRead, async (_e, id: unknown) => {
    loadEnterpriseSession();
    if (typeof id !== 'string' || !id) throw new Error('工单编号不正确');
    return enterpriseClient.readTicket(id);
  });
  ipcMain.handle(
    IPC.enterpriseTicketAction,
    async (_e, id: unknown, input: unknown) => {
      loadEnterpriseSession();
      if (
        typeof id !== 'string' ||
        !id ||
        !input ||
        typeof input !== 'object'
      ) {
        throw new Error('工单操作格式不正确');
      }
      const body = input as Record<string, unknown>;
      if (
        ![
          'respond',
          'accept',
          'complete',
          'confirm',
          'respond_and_transfer',
        ].includes(String(body.action))
      ) {
        throw new Error('工单操作不正确');
      }
      return enterpriseClient.updateTicket(id, {
        action: body.action as
          | 'respond'
          | 'accept'
          | 'complete'
          | 'confirm'
          | 'respond_and_transfer',
        responseType:
          typeof body.responseType === 'string' ? body.responseType : undefined,
        responseText:
          typeof body.responseText === 'string' ? body.responseText : undefined,
        transferDepartment:
          typeof body.transferDepartment === 'string'
            ? body.transferDepartment
            : undefined,
        transferNote:
          typeof body.transferNote === 'string' ? body.transferNote : undefined,
      });
    },
  );
  ipcMain.handle(IPC.parkNativeNotify, (_e, title: unknown, body: unknown) => {
    if (typeof title !== 'string' || typeof body !== 'string') {
      return false;
    }
    notificationService.show({
      sessionId: 'park:service',
      source: 'park',
      title,
      preview: body.slice(0, 240),
    });
    return notificationService.checkPermission();
  });
  // ── 通知系统 IPC 代理 ──
  ipcMain.handle(IPC.notificationShow, (_e, payload: unknown) => {
    const p = payload as NotificationPayload;
    if (!p || typeof p.sessionId !== 'string' || typeof p.preview !== 'string')
      return;
    notificationService.show(p);
  });
  ipcMain.handle(IPC.notificationMarkRead, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return;
    notificationService.markRead(sessionId);
  });
  ipcMain.handle(IPC.notificationGetUnread, () =>
    notificationService.getUnreadSessions(),
  );
  ipcMain.handle(IPC.notificationCheckPermission, () =>
    notificationService.checkPermission(),
  );
  // 通知点击跳转回调：push 给 renderer
  notificationService.registerCallbacks({
    onUnreadChange: (unread) => {
      updateUnreadIndicators(unread);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.notificationUnreadChanged, unread);
      }
    },
    onNotificationClick: (sessionId) => {
      showMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.notificationSessionOpen, sessionId);
      }
    },
    shouldPresentSystemNotification,
    onBackgroundAttention: requestBackgroundAttention,
    onSystemNotificationUnavailable: (payload, reason) => {
      console.warn(
        `[otto-desktop] system notification ${reason}; using fallback alert`,
      );
      showFallbackNotification(payload);
    },
  });
  ipcMain.handle(IPC.voiceGetConfig, () => loadVoiceConfig().public);
  ipcMain.handle(IPC.voiceSaveConfig, (_e, body: VoiceConfigInput) =>
    saveVoiceConfig(body),
  );
  ipcMain.handle(
    IPC.voiceTranscribe,
    async (_e, bytes: unknown, mimeType: unknown) => {
      if (!(bytes instanceof Uint8Array) || typeof mimeType !== 'string') {
        throw new Error('语音数据格式不合法');
      }
      return transcribeAudio(bytes, mimeType, loadVoiceConfig());
    },
  );
  // renderer 经 preload 拉当前端点（连接前 / 重连时）。
  ipcMain.handle(IPC.getEndpoint, () => {
    if (!endpoint) void ensureEndpoint();
    return endpoint ?? null;
  });
  ipcMain.handle(IPC.runtimeDiagnostic, () =>
    serverManager.getDesktopRuntimeDiagnostic(),
  );

  // host-only 命令（替代 webview 的 vscode host 命令；交付文档 [WEBVIEW] §5）。
  ipcMain.handle(IPC.openExternal, (_e, url: unknown) => {
    if (typeof url === 'string' && isExternalUrl(url)) {
      return shell.openExternal(url);
    }
    return Promise.resolve();
  });
  // 飞书状态：真查当前 server 的 /health 并透传守护详情（见文件上方说明）。
  // 状态诚实：server 未就绪 / 查询失败一律如实报告，绝不假报「已连接/运行中」。
  ipcMain.handle(IPC.feishuStatus, async () => {
    const health = await fetchServerHealth();
    if (!health) {
      return {
        text: '本地 server 未就绪，暂时无法查询飞书状态。',
        running: false,
      };
    }
    return {
      text: renderFeishuStatusText(health.feishu),
      // running = server 启用了飞书且守护在跑（≠已连接；连接态看 feishu.connected）。
      running:
        health.feishu.enabled && (health.feishu.status?.running ?? false),
      feishu: health.feishu,
    };
  });
  // 启停：真调 server 运行期端点 POST /feishu/start | /feishu/stop，
  // 透传真实结果（失败原样报错，不谎报动作已执行），并附最新守护状态。
  ipcMain.handle(IPC.feishuStart, async () => {
    const r = await postServerEndpoint('/feishu/start');
    if (!r) {
      return { text: '本地 server 未就绪，无法启动飞书守护，请稍后重试。' };
    }
    if (!r.ok) {
      // server 诚实报错（典型：凭证未配置），原样透传。
      return { text: `飞书守护启动失败：${r.error ?? '未知原因'}` };
    }
    const health = await fetchServerHealth();
    return {
      text:
        '飞书守护已启动（断线自动重连，连上一次后绝不永久断开）。\n' +
        (health ? renderFeishuStatusText(health.feishu) : ''),
    };
  });
  ipcMain.handle(IPC.feishuStop, async () => {
    const r = await postServerEndpoint('/feishu/stop');
    if (!r) {
      return { text: '本地 server 未就绪，无法执行停止操作。' };
    }
    if (!r.ok) {
      return { text: `飞书守护停止失败：${r.error ?? '未知原因'}` };
    }
    return {
      text:
        '飞书守护已停止（有意停止：不会自动重连，再次启动即恢复守护）。\n' +
        '注：若另有 CLI 守护进程（otto feishu daemon）在跑，请在终端单独停止。',
    };
  });
  // 飞书凭证配置（「飞书接入」面板）：转发 server /feishu/config。
  // GET 返回的本来就是脱敏视图（appSecret 只进不出，见 server 端约定）。
  ipcMain.handle(IPC.feishuGetConfig, async () => {
    const r = await requestFeishuConfig('GET');
    if (!r) return { ok: false, config: null, error: '本地 server 未就绪。' };
    return { ok: r.ok, config: r.data, error: r.error };
  });
  ipcMain.handle(IPC.feishuSaveConfig, async (_e, body: unknown) => {
    // 形状粗校验后转发；细校验（appId/domain/secret 规则）由 server 端负责。
    if (typeof body !== 'object' || body === null) {
      return { ok: false, config: null, error: '配置格式不合法。' };
    }
    const r = await requestFeishuConfig(
      'POST',
      body as FeishuConfigSaveRequest,
    );
    if (!r)
      return {
        ok: false,
        config: null,
        error: '本地 server 未就绪，凭证未保存。',
      };
    return { ok: r.ok, config: r.data, error: r.error };
  });
  ipcMain.handle(IPC.feishuClearConfig, async () => {
    const r = await requestFeishuConfig('DELETE');
    if (!r) return { ok: false, config: null, error: '本地 server 未就绪。' };
    return { ok: r.ok, config: r.data, error: r.error };
  });
  // ── 内置视频编辑器 ──────────────────────────────────────────
  ipcMain.handle(IPC.openVideoEditor, () =>
    Promise.resolve(createVideoEditorWindow()),
  );
  // 旧版园区服务定制兼容：新版企业账号以服务端园区配置为准。
  // 文件不存在或解析失败时返回 null，由 renderer fail closed。
  // ── 外观主题（跟随系统/浅色/深色）：nativeTheme.themeSource + userData 持久化 ──
  ipcMain.handle(IPC.themeGet, () => nativeTheme.themeSource);
  ipcMain.handle(IPC.themeSet, (_e, v: unknown) => {
    if (v !== 'system' && v !== 'light' && v !== 'dark')
      return nativeTheme.themeSource;
    nativeTheme.themeSource = v;
    try {
      fs.writeFileSync(
        themeFilePath(),
        JSON.stringify({ themeSource: v }),
        'utf8',
      );
    } catch {
      /* 写盘失败只影响下次启动的记忆，本次已生效 */
    }
    return nativeTheme.themeSource;
  });

  ipcMain.handle(
    IPC.skillLeaderboard,
    async () =>
      enterpriseSkillLibrary.leaderboard(await authenticatedSkillScope()),
  );

  // 工作日志：读取本地日历的今天，展示业务成果 + 支撑操作。
  ipcMain.handle(IPC.workLogToday, async () => {
    const worklogRoot = worklogRootDir();
    const today = localDateKey(new Date());
    const entries = await readWorkLogEntries(worklogRoot, today);
    return summarizeWorkLog(today, entries);
  });

  // 工作日志·近 N 天逐日明细（日历视图数据源：hover 某天列出当天条目）。
  ipcMain.handle(IPC.workLogRecent, async (_e, days?: number) => {
    const worklogRoot = worklogRootDir();
    return readRecentWorkLogs(worklogRoot, days, new Date());
  });

  // 一键生成真正的 Markdown 工作报告并保存到 summaries，返回完整路径供界面打开。
  ipcMain.handle(IPC.workLogReport, async () => {
    const worklogRoot = worklogRootDir();
    return generateAndSaveWorkReport(worklogRoot, localDateKey(new Date()));
  });

  ipcMain.handle(IPC.createDiagnosticBundle, async () => {
    const core = await import('otto-core');
    const result = await core.createDiagnosticBundle();
    if (result.ok) {
      try {
        await shell.showItemInFolder(result.path);
      } catch {
        // 打开文件夹失败不影响诊断包生成结果。
      }
    }
    return result;
  });

  ipcMain.handle(
    IPC.skillShareList,
    async () =>
      enterpriseSkillLibrary.listDepartment(await authenticatedSkillScope()),
  );
  ipcMain.handle(IPC.skillMarketplace, () =>
    enterpriseSkillLibrary.listMarketplace(),
  );

  ipcMain.handle(IPC.enterpriseSkillLocalList, async () => {
    const root = userSkillsRootDir();
    const entries = await fs.promises
      .readdir(root, { withFileTypes: true })
      .catch(() => []);
    const result: Array<{
      name: string;
      description: string;
      kind: 'auto' | 'personal';
    }> = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name === 'cache' ||
        entry.name === 'backups' ||
        entry.name.startsWith('market-')
      )
        continue;
      const filePath = path.join(root, entry.name, 'SKILL.md');
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile() || stat.size > 200_000) continue;
        const content = await fs.promises.readFile(filePath, 'utf8');
        result.push({
          name: entry.name,
          description: localSkillDescription(content),
          kind: entry.name.startsWith('auto-') ? 'auto' : 'personal',
        });
      } catch {
        // A partially written or removed Skill is skipped and can be retried on refresh.
      }
    }
    return result.sort((left, right) =>
      left.name.localeCompare(right.name, 'zh-CN'),
    );
  });

  ipcMain.handle(IPC.enterpriseSkillList, async (_event, input: unknown) => {
    loadEnterpriseSession();
    const body =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {};
    const scope =
      body.scope === 'company' ||
      body.scope === 'mine' ||
      body.scope === 'review'
        ? body.scope
        : 'department';
    const sort =
      body.sort === 'rating' ||
      body.sort === 'installs' ||
      body.sort === 'usage' ||
      body.sort === 'newest'
        ? body.sort
        : 'recommended';
    const [skills, localVersions] = await Promise.all([
      enterpriseClient.listEnterpriseSkills({
        scope,
        sort,
        query: typeof body.query === 'string' ? body.query : undefined,
      }),
      localMarketplaceInstallVersions(),
    ]);
    return skills.map((skill) => ({
      ...skill,
      installedVersion: localVersions.get(skill.id) ?? null,
    }));
  });

  ipcMain.handle(IPC.enterpriseSkillSubmit, async (_event, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('Skill 投稿参数不正确');
    const body = input as Record<string, unknown>;
    const localSkillName = safeLocalSkillName(body.localSkillName);
    const skillPath = await localSkillFilePath(localSkillName);
    const stat = await fs.promises.stat(skillPath);
    if (stat.size > 200_000)
      throw new Error('Skill 内容不能超过 200000 个字符');
    const content = await fs.promises.readFile(skillPath, 'utf8');
    return enterpriseClient.submitEnterpriseSkill({
      name: localSkillName,
      description: localSkillDescription(content),
      content,
      visibility: body.visibility === 'company' ? 'company' : 'department',
    });
  });

  ipcMain.handle(IPC.customerModuleList, async () => {
    loadEnterpriseSession();
    return enterpriseClient.listCustomerModules();
  });

  ipcMain.handle(IPC.customerModuleSubmit, async (_event, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object') throw new Error('客户模块投稿参数不正确');
    const body = input as Record<string, unknown>;
    if (!body.manifest || typeof body.manifest !== 'object' || !body.files || typeof body.files !== 'object') {
      throw new Error('客户模块清单和文件不能为空');
    }
    const files = body.files as Record<string, unknown>;
    let encodedSize = 0;
    const normalizedFiles: Record<string, string> = {};
    for (const [path, encoded] of Object.entries(files)) {
      if (typeof encoded !== 'string') throw new Error(`客户模块文件格式不正确：${path}`);
      encodedSize += encoded.length;
      if (encodedSize > 24_000_000) throw new Error('客户模块包超过上传限制');
      normalizedFiles[path] = encoded;
    }
    return enterpriseClient.submitCustomerModule({
      manifest: body.manifest as Record<string, unknown>,
      files: normalizedFiles,
    });
  });

  ipcMain.handle(IPC.customerModuleTest, async (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('客户模块测试参数不正确');
    const body = input as Record<string, unknown>;
    const manifest = parseCustomerModuleManifest(body.manifest, { requireSignature: false });
    if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files)) throw new Error('客户模块测试文件不能为空');
    const files = new Map(Object.entries(body.files as Record<string, unknown>).map(([name, encoded]) => {
      if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error(`客户模块文件不是有效 base64：${name}`);
      return [name, Uint8Array.from(Buffer.from(encoded, 'base64'))];
    }));
    validateCustomerModuleArchiveEntries(manifest, [...files].map(([filePath, bytes]) => ({ path: filePath, kind: 'file' as const, size: bytes.byteLength })), { requireSignature: false });
    await verifyCustomerModuleFileHashes(manifest.files, files);
    await scanCustomerModuleWasm(files.get(manifest.entrypoint) ?? new Uint8Array());
    const hostAudit: Array<Record<string, unknown>> = [];
    const host = new CustomerModuleHostBroker({
      invoke: async () => { throw new Error('本地沙箱测试禁止真实外部调用'); },
      onAudit: (event) => hostAudit.push(event as unknown as Record<string, unknown>),
    });
    const audit: Array<Record<string, unknown>> = [];
    const result = await new CustomerModuleRunner({ host, onAudit: (event) => audit.push(event as unknown as Record<string, unknown>) }).run({
      moduleId: manifest.id, version: manifest.version,
      wasm: files.get(manifest.entrypoint) ?? new Uint8Array(), input: {},
      approvedCapabilities: manifest.permissions.map((permission) => permission.kind),
      limits: { timeoutMs: 2_000, maxOutputBytes: 256 * 1024 },
    });
    return { result, audit, hostAudit };
  });

  ipcMain.handle(IPC.customerModuleInstalledList, async () => {
    loadEnterpriseSession();
    const root = path.join(app.getPath('userData'), 'customer-modules');
    try {
      await recoverCustomerModuleInstallReceipts(root, enterpriseClient);
      const records = await refreshCustomerModuleMarketStatus(root, enterpriseClient);
      return records.map(({ artifactPath: _artifactPath, receiptId: _receiptId, receiptStatus: _receiptStatus, manifest, ...record }) => ({ ...record, inputSchema: manifest.inputSchema }));
    } catch {
      const records = await listInstalledCustomerModules(root);
      return records.map(({ artifactPath: _artifactPath, receiptId: _receiptId, receiptStatus: _receiptStatus, manifest, ...record }) => ({ ...record, inputSchema: manifest.inputSchema }));
    }
  });

  ipcMain.handle(IPC.customerModuleInstall, async (_event, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object') throw new Error('客户模块安装参数不正确');
    const body = input as Record<string, unknown>;
    if (typeof body.moduleId !== 'string' || typeof body.version !== 'string' || !Array.isArray(body.approvedPermissions)) {
      throw new Error('客户模块安装参数不正确');
    }
    const installed = await installCustomerModule({
      root: path.join(app.getPath('userData'), 'customer-modules'),
      client: enterpriseClient,
      moduleId: body.moduleId,
      version: body.version,
      ottoVersion: app.getVersion(),
      approvedPermissions: body.approvedPermissions as never,
    });
    const { artifactPath: _artifactPath, receiptId: _receiptId, receiptStatus: _receiptStatus, manifest, ...record } = installed;
    return { ...record, inputSchema: manifest.inputSchema };
  });

  ipcMain.handle(IPC.customerModuleSetEnabled, async (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('客户模块启停参数不正确');
    const body = input as Record<string, unknown>;
    if (typeof body.moduleId !== 'string' || typeof body.enabled !== 'boolean') throw new Error('客户模块启停参数不正确');
    const root = path.join(app.getPath('userData'), 'customer-modules');
    const record = await setCustomerModuleEnabled(root, body.moduleId, body.enabled);
    const { artifactPath: _artifactPath, receiptId: _receiptId, receiptStatus: _receiptStatus, manifest, ...safe } = record;
    return { ...safe, inputSchema: manifest.inputSchema };
  });

  ipcMain.handle(IPC.customerModuleSetBackgroundEnabled, async (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('客户模块后台授权参数不正确');
    const body = input as Record<string, unknown>;
    if (typeof body.moduleId !== 'string' || typeof body.enabled !== 'boolean') throw new Error('客户模块后台授权参数不正确');
    const root = path.join(app.getPath('userData'), 'customer-modules');
    const record = await setCustomerModuleBackgroundEnabled(root, body.moduleId, body.enabled);
    const { artifactPath: _artifactPath, receiptId: _receiptId, receiptStatus: _receiptStatus, manifest, ...safe } = record;
    return { ...safe, inputSchema: manifest.inputSchema };
  });

  ipcMain.handle(IPC.customerModuleUninstall, async (_event, moduleId: unknown) => {
    if (typeof moduleId !== 'string') throw new Error('客户模块卸载参数不正确');
    await uninstallCustomerModule(path.join(app.getPath('userData'), 'customer-modules'), moduleId);
  });

  ipcMain.handle(IPC.customerModuleClearData, async (_event, moduleId: unknown) => {
    if (typeof moduleId !== 'string') throw new Error('客户模块数据清理参数不正确');
    await clearCustomerModuleData(path.join(app.getPath('userData'), 'customer-modules'), moduleId);
  });

  ipcMain.handle(IPC.customerModuleExportData, async (_event, moduleId: unknown) => {
    if (typeof moduleId !== 'string') throw new Error('客户模块数据导出参数不正确');
    const root = path.join(app.getPath('userData'), 'customer-modules');
    const exported = await exportCustomerModuleData(root, moduleId);
    const selected = await dialog.showSaveDialog({ defaultPath: `${moduleId}-data.json` });
    if (selected.canceled || !selected.filePath) return null;
    await fs.promises.writeFile(selected.filePath, `${JSON.stringify(exported, null, 2)}\n`, { mode: 0o600 });
    return selected.filePath;
  });

  ipcMain.handle(IPC.customerModuleRun, async (_event, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object') throw new Error('客户模块运行参数不正确');
    const body = input as Record<string, unknown>;
    if (typeof body.runId !== 'string' || typeof body.moduleId !== 'string' || typeof body.version !== 'string' || !body.formInput || typeof body.formInput !== 'object' || Array.isArray(body.formInput)) {
      throw new Error('客户模块运行参数不正确');
    }
    if (customerModuleRunControllers.has(body.runId)) throw new Error('客户模块运行 ID 已被占用');
    const controller = new AbortController();
    customerModuleRunControllers.set(body.runId, controller);
    const root = path.join(app.getPath('userData'), 'customer-modules');
    const record = (await listInstalledCustomerModules(root)).find((item) => item.id === body.moduleId && item.version === body.version);
    if (!record) throw new Error('客户模块未安装');
    const hostAudit: Array<Record<string, unknown>> = [];
    const host = createDesktopCustomerModuleHost({
      record,
      storageRoot: path.join(root, 'data'),
      modelInvoke: customerModuleModelInvoke,
      selectReadFile: async () => {
        const selected = await dialog.showOpenDialog({ properties: ['openFile'] });
        return selected.canceled ? null : selected.filePaths[0] ?? null;
      },
      selectWriteFile: async (suggestedName) => {
        const selected = await dialog.showSaveDialog({ defaultPath: suggestedName });
        return selected.canceled ? null : selected.filePath ?? null;
      },
      onAudit: (event) => {
        hostAudit.push(event as unknown as Record<string, unknown>);
        console.info('[customer-module-audit]', event);
      },
    });
    try {
      const execution = await runInstalledCustomerModule({
        root,
        moduleId: body.moduleId,
        version: body.version,
        formInput: body.formInput as Record<string, unknown>,
        host,
        signal: controller.signal,
      });
      return { ...execution, hostAudit };
    } finally {
      customerModuleRunControllers.delete(body.runId);
    }
  });

  ipcMain.handle(IPC.customerModuleCancel, (_event, runId: unknown) => {
    if (typeof runId !== 'string') throw new Error('客户模块取消参数不正确');
    const controller = customerModuleRunControllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  });

  ipcMain.handle(IPC.enterpriseSkillReview, async (_event, input: unknown) => {
    loadEnterpriseSession();
    if (!input || typeof input !== 'object')
      throw new Error('Skill 审核参数不正确');
    const body = input as Record<string, unknown>;
    if (
      typeof body.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,120}$/u.test(body.id) ||
      (body.action !== 'approve' && body.action !== 'archive')
    ) {
      throw new Error('Skill 审核参数不正确');
    }
    return enterpriseClient.reviewEnterpriseSkill(
      body.id,
      body.action,
      body.visibility === 'company' || body.visibility === 'department'
        ? body.visibility
        : undefined,
    );
  });

  ipcMain.handle(IPC.enterpriseSkillInstall, async (_event, input: unknown) => {
    loadEnterpriseSession();
    const body =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {};
    if (
      typeof body.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,120}$/u.test(body.id)
    ) {
      throw new Error('Skill 安装参数不正确');
    }
    const skill = await enterpriseClient.installEnterpriseSkill(body.id);
    const targetDir = path.join(userSkillsRootDir(), `market-${body.id}`);
    const targetPath = path.join(targetDir, 'SKILL.md');
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const metadataPath = path.join(targetDir, '.otto-market.json');
    const metadataTempPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
    const targetDirectoryStat = await fs.promises
      .lstat(targetDir)
      .catch(() => null);
    if (
      targetDirectoryStat?.isSymbolicLink() ||
      (targetDirectoryStat && !targetDirectoryStat.isDirectory())
    ) {
      throw new Error('Skill 安装目录不安全，请移除对应目录后重试');
    }
    await fs.promises.mkdir(targetDir, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.writeFile(tempPath, skill.content, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await replaceFileFromTemp(tempPath, targetPath);
      await fs.promises.writeFile(
        metadataTempPath,
        `${JSON.stringify(
          {
            skillId: skill.id,
            skillName: skill.name,
            version: skill.version,
            contentHash: skill.contentHash,
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      await replaceFileFromTemp(metadataTempPath, metadataPath);
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      await fs.promises
        .rm(metadataTempPath, { force: true })
        .catch(() => undefined);
    }
    const { content: _content, ...view } = skill;
    return { skill: view, installedPath: targetPath };
  });

  ipcMain.handle(IPC.enterpriseSkillRate, async (_event, input: unknown) => {
    loadEnterpriseSession();
    const body =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {};
    if (
      typeof body.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,120}$/u.test(body.id) ||
      !Number.isInteger(body.score) ||
      Number(body.score) < 1 ||
      Number(body.score) > 5
    ) {
      throw new Error('Skill 评分参数不正确');
    }
    return enterpriseClient.rateEnterpriseSkill(body.id, Number(body.score));
  });

  ipcMain.handle(IPC.enterpriseSkillLeaderboard, async () => {
    loadEnterpriseSession();
    return enterpriseClient.getEnterpriseSkillLeaderboard();
  });

  ipcMain.handle(IPC.parkConfig, async () => {
    try {
      const p = path.join(os.homedir(), '.otto-user', 'park-services.json');
      const raw = await fs.promises.readFile(p, 'utf8');
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      if (typeof cfg !== 'object' || cfg === null) return null;
      // 宽松形状校验：只透传认识的字段，坏字段丢弃不炸。
      const services = Array.isArray(cfg.services)
        ? cfg.services
            .filter(
              (s): s is Record<string, unknown> =>
                typeof s === 'object' && s !== null,
            )
            .map((s) => ({
              name: typeof s.name === 'string' ? s.name : '',
              desc: typeof s.desc === 'string' ? s.desc : '',
              prompt: typeof s.prompt === 'string' ? s.prompt : '',
            }))
            .filter((s) => s.name && s.prompt)
        : undefined;
      return {
        brandName:
          typeof cfg.brandName === 'string' ? cfg.brandName : undefined,
        parkName: typeof cfg.parkName === 'string' ? cfg.parkName : undefined,
        ...(services && services.length > 0 ? { services } : {}),
      };
    } catch {
      return null;
    }
  });

  // 本地测试模式：应用/清除 customProxyServerUrl。
  // renderer 通过 preload.setLocalTestUrl() 调用。
  // 实现方式：将 OTTO_SERVER_URL env 设为指定地址，待下次会话创建时 proxyConfig
  // 会读到该改变的环境变量，从而路由请求到本地。
  ipcMain.handle(IPC.setLocalTestUrl, (_e, url: unknown) => {
    if (typeof url !== 'string') return Promise.resolve();
    const trimmed = url.trim();
    if (trimmed) {
      // 应用本地测试地址（真实状态只存 env，不留影子变量）
      process.env.OTTO_SERVER_URL = trimmed;
      console.log(
        `[otto-desktop] 本地测试模式已应用： OTTO_SERVER_URL=${trimmed}`,
      );
    } else {
      // 清除本地测试
      delete process.env.OTTO_SERVER_URL;
      console.log(
        '[otto-desktop] 本地测试模式已清除， OTTO_SERVER_URL 已移除。',
      );
    }
    return Promise.resolve();
  });

  // ── 软件更新：检查 / 下载 / 取消 / 安装 + 版本查询（逻辑在 update-service.ts）──
  // 结果全部结构化透传，不在这里加工：「检查失败」与「已是最新」是 UpdateService
  // 返回的两种不同 status，任何一层都不许把失败粉饰成最新。
  ipcMain.handle(IPC.appVersion, () => app.getVersion());
  ipcMain.handle(IPC.updateCheck, () => checkDesktopUpdate());
  ipcMain.handle(IPC.updateDownload, () => updateService.downloadUpdate());
  ipcMain.handle(IPC.updateCancel, () => {
    updateService.cancelDownload();
  });
  ipcMain.handle(IPC.updateInstall, () => updateService.installUpdate());
  ipcMain.handle(IPC.incrementalUpdateCheck, (_event, payload?: unknown) => {
    const manifestUrl =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { manifestUrl?: unknown }).manifestUrl === 'string'
        ? (payload as { manifestUrl: string }).manifestUrl
        : undefined;
    return incrementalUpdateService.checkForUpdates(manifestUrl);
  });
  ipcMain.handle(IPC.incrementalUpdateApply, (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      return Promise.resolve({ ok: false, error: '增量更新参数必须是对象' });
    }
    const input = payload as { kind?: unknown; id?: unknown };
    if (
      input.kind !== 'patch' &&
      input.kind !== 'kernel' &&
      input.kind !== 'component'
    ) {
      return Promise.resolve({ ok: false, error: '增量更新 kind 无效' });
    }
    if (typeof input.id !== 'string' || input.id.trim().length === 0) {
      return Promise.resolve({ ok: false, error: '增量更新 id 不能为空' });
    }
    return incrementalUpdateService.applyUpdate(input.kind, input.id);
  });

  const resolveUserLocalPath = (candidate: unknown): string | null => {
    // 仅允许当前用户 home 内已存在的绝对路径。realpath 同时阻止符号链接越界。
    if (
      typeof candidate !== 'string' ||
      candidate.length === 0 ||
      !path.isAbsolute(candidate)
    ) {
      return null;
    }
    try {
      const home = fs.realpathSync(app.getPath('home'));
      const resolved = fs.realpathSync(path.resolve(candidate));
      return resolved === home || resolved.startsWith(home + path.sep)
        ? resolved
        : null;
    } catch {
      return null;
    }
  };
  const unsafeOutputExtensions = new Set([
    '.app',
    '.bat',
    '.cjs',
    '.cmd',
    '.com',
    '.command',
    '.desktop',
    '.exe',
    '.hta',
    '.jar',
    '.js',
    '.jse',
    '.lnk',
    '.mjs',
    '.msi',
    '.ps1',
    '.reg',
    '.scr',
    '.sh',
    '.url',
    '.vbe',
    '.vbs',
    '.wsf',
    '.wsh',
  ]);
  const inspectUserLocalPath = (
    candidate: unknown,
  ): {
    resolved: string | null;
    exists: boolean;
    kind: 'file' | 'directory' | 'missing';
    canOpen: boolean;
  } => {
    const resolved = resolveUserLocalPath(candidate);
    if (!resolved) {
      return { resolved: null, exists: false, kind: 'missing', canOpen: false };
    }
    try {
      const stat = fs.statSync(resolved);
      const kind = stat.isDirectory()
        ? 'directory'
        : stat.isFile()
          ? 'file'
          : 'missing';
      const exists = kind !== 'missing';
      const extension = path.extname(resolved).toLowerCase();
      const canOpen =
        exists &&
        (kind === 'directory' || !unsafeOutputExtensions.has(extension));
      return { resolved, exists, kind, canOpen };
    } catch {
      return { resolved: null, exists: false, kind: 'missing', canOpen: false };
    }
  };

  ipcMain.handle(IPC.openPath, (_e, p: unknown) => {
    const resolved = resolveUserLocalPath(p);
    return resolved ? shell.openPath(resolved) : Promise.resolve('');
  });
  ipcMain.handle(IPC.inspectLocalPath, (_e, p: unknown) => {
    const { exists, kind, canOpen } = inspectUserLocalPath(p);
    return { exists, kind, canOpen };
  });
  ipcMain.handle(
    IPC.activateLocalPath,
    async (_e, p: unknown, action: unknown) => {
      const inspected = inspectUserLocalPath(p);
      if (!inspected.resolved || !inspected.exists) {
        return { ok: false, error: '文件不存在，或不在当前用户目录内。' };
      }
      if (action === 'reveal') {
        shell.showItemInFolder(inspected.resolved);
        return { ok: true };
      }
      if (action !== 'open') return { ok: false, error: '不支持的文件操作。' };
      if (!inspected.canOpen) {
        return {
          ok: false,
          error: '为安全起见，可执行文件只能在文件夹中定位。',
        };
      }
      const error = await shell.openPath(inspected.resolved);
      return error ? { ok: false, error } : { ok: true };
    },
  );

  // 导出会话（对齐 CLI /export）：原生保存对话框 + 写文件。取消返回 null，
  // 写入失败抛错由 renderer 侧捕获展示；内容/文件名均来自 server 的 export_result 帧。
  ipcMain.handle(
    IPC.saveTextFile,
    async (_e, suggestedFileName: unknown, content: unknown) => {
      if (
        typeof suggestedFileName !== 'string' ||
        typeof content !== 'string'
      ) {
        return null;
      }
      const win = mainWindow;
      const ext = path.extname(suggestedFileName).slice(1).toLowerCase();
      const textExtensions = [
        'md',
        'markdown',
        'txt',
        'json',
        'csv',
        'xml',
        'html',
        'css',
        'js',
        'ts',
        'tsx',
        'jsx',
        'log',
        'yaml',
        'yml',
      ];
      const filters = textExtensions.includes(ext)
        ? [
            { name: `${ext.toUpperCase()} 文本`, extensions: [ext] },
            { name: '所有文件', extensions: ['*'] },
          ]
        : [
            { name: 'Markdown', extensions: ['md'] },
            { name: '所有文件', extensions: ['*'] },
          ];
      const result = win
        ? await dialog.showSaveDialog(win, {
            defaultPath: path.join(app.getPath('documents'), suggestedFileName),
            filters,
          })
        : await dialog.showSaveDialog({
            defaultPath: path.join(app.getPath('documents'), suggestedFileName),
            filters,
          });
      if (result.canceled || !result.filePath) return null;
      await fs.promises.writeFile(result.filePath, content, 'utf-8');
      return result.filePath;
    },
  );

  // 原生文件选择器：返回完整路径数组（用户授权选择，不在沙箱内）
  ipcMain.handle(IPC.selectFiles, async () => {
    const win = mainWindow;
    const result = await (win
      ? dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          filters: [
            {
              name: '所有支持的文件',
              extensions: [
                'png',
                'jpg',
                'jpeg',
                'gif',
                'webp',
                'bmp',
                'pdf',
                'doc',
                'docx',
                'xls',
                'xlsx',
                'ppt',
                'pptx',
                'txt',
                'csv',
                'json',
                'xml',
                'md',
                'zip',
                'log',
              ],
            },
          ],
        })
      : dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          filters: [
            {
              name: '所有支持的文件',
              extensions: [
                'png',
                'jpg',
                'jpeg',
                'gif',
                'webp',
                'bmp',
                'pdf',
                'doc',
                'docx',
                'xls',
                'xlsx',
                'ppt',
                'pptx',
                'txt',
                'csv',
                'json',
                'xml',
                'md',
                'zip',
                'log',
              ],
            },
          ],
        }));
    if (result.canceled || result.filePaths.length === 0) return [];
    return fileAccessGrants.grant(result.filePaths);
  });

  // Windows 不支持在同一个对话框中可靠混用 openFile/openDirectory；目录单独显式选择，
  // renderer 不能提交裸路径扩大授权范围。
  ipcMain.handle(IPC.selectFolders, async () => {
    const win = mainWindow;
    const result = await (win
      ? dialog.showOpenDialog(win, {
          properties: ['openDirectory', 'multiSelections'],
        })
      : dialog.showOpenDialog({
          properties: ['openDirectory', 'multiSelections'],
        }));
    if (result.canceled || result.filePaths.length === 0) return [];
    return fileAccessGrants.grantDirectories(result.filePaths);
  });

  ipcMain.handle(IPC.getWorkspaceDirectories, () => ({
    defaultPath: workspaceDirectories.defaultPath(),
    recentPaths: workspaceDirectories.list(),
  }));

  ipcMain.handle(IPC.selectWorkspaceDirectory, async () => {
    const win = mainWindow;
    const result = await (win
      ? dialog.showOpenDialog(win, {
          defaultPath: workspaceDirectories.defaultPath(),
          properties: ['openDirectory', 'createDirectory'],
        })
      : dialog.showOpenDialog({
          defaultPath: workspaceDirectories.defaultPath(),
          properties: ['openDirectory', 'createDirectory'],
        }));
    if (result.canceled || !result.filePaths[0]) return null;
    return workspaceDirectories.grant(result.filePaths[0]);
  });

  ipcMain.handle(IPC.authorizeWorkspaceDirectory, (_event, directory: unknown) => {
    if (typeof directory !== 'string') throw new Error('工作目录格式无效');
    return workspaceDirectories.authorize(directory);
  });

  // 拖拽/隐藏 input 的 File 路径由可信 preload 通过 webUtils 提取后送到这里。
  // renderer 只能传 File 对象给 contextBridge，没有任意字符串 grant API。
  ipcMain.handle(IPC.grantBrowserFile, (_e, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('无法获取所选文件的真实路径');
    }
    const [granted] = fileAccessGrants.grant([filePath]);
    if (!granted) throw new Error('文件未获得授权');
    return granted;
  });

  // preload 在 send_user_message 真正写入 WS 前调用。renderer 无 ipcRenderer，
  // 也拿不到 server endpoint/clientToken，因此不能绕过此复核直发裸路径。
  ipcMain.handle(IPC.authorizeMessageFiles, (_e, references: unknown) => {
    if (
      !Array.isArray(references) ||
      references.length === 0 ||
      references.length > 6 ||
      references.some(
        (value) =>
          !value ||
          typeof value !== 'object' ||
          typeof (value as { path?: unknown }).path !== 'string' ||
          !(value as { path: string }).path ||
          !['file', 'directory'].includes(
            String((value as { kind?: unknown }).kind),
          ),
      )
    ) {
      throw new Error('附件路径格式无效');
    }
    return fileAccessGrants.resolveReferences(
      references as Array<{ path: string; kind: 'file' | 'directory' }>,
      50 * 1024 * 1024,
    );
  });

  // 读取用户本进程中通过原生选择器明确授权的文件，返回 Base64 + 元数据。
  // 授权不再限定 home：外部卷、其它盘符与网络盘都可选；未选择路径仍 fail closed。

  ipcMain.handle(IPC.extractEditableDocument, async (_e, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('文件路径无效');
    }
    const granted = fileAccessGrants.resolve(filePath, 50 * 1024 * 1024);
    const core = (await import('otto-core')) as unknown as {
      extractEditableDocument(filePath: string): Promise<unknown>;
    };
    return core.extractEditableDocument(granted.filePath);
  });

  ipcMain.handle(
    IPC.exportEditedDocument,
    async (
      _e,
      sourcePath: unknown,
      suggestedFileName: unknown,
      content: unknown,
    ) => {
      if (
        typeof sourcePath !== 'string' ||
        typeof suggestedFileName !== 'string' ||
        typeof content !== 'string'
      ) {
        return null;
      }
      const granted = fileAccessGrants.resolve(sourcePath, 50 * 1024 * 1024);
      const ext = path.extname(suggestedFileName).slice(1).toLowerCase();
      const filters = ext
        ? [
            { name: ext.toUpperCase() + ' 文件', extensions: [ext] },
            { name: '所有文件', extensions: ['*'] },
          ]
        : [{ name: '所有文件', extensions: ['*'] }];
      const win = mainWindow;
      const result = win
        ? await dialog.showSaveDialog(win, {
            defaultPath: path.join(app.getPath('documents'), suggestedFileName),
            filters,
          })
        : await dialog.showSaveDialog({
            defaultPath: path.join(app.getPath('documents'), suggestedFileName),
            filters,
          });
      if (result.canceled || !result.filePath) return null;
      const core = (await import('otto-core')) as unknown as {
        exportEditedDocument(
          sourcePath: string,
          content: string,
          outPath: string,
        ): Promise<unknown>;
      };
      return core.exportEditedDocument(
        granted.filePath,
        content,
        result.filePath,
      );
    },
  );

  ipcMain.handle(IPC.readFilePath, async (_e, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('文件路径无效');
    }
    const granted = fileAccessGrants.resolve(filePath, 50 * 1024 * 1024);
    const buffer = await fs.promises.readFile(granted.filePath);
    const base64 = buffer.toString('base64');
    return {
      filePath: granted.filePath,
      fileName: path.basename(granted.filePath),
      size: granted.size,
      mimeType: getMimeType(granted.filePath),
      data: base64,
    };
  });
}

// ────────────────────────────────────────────────────────────────────────
// 生命周期
// ────────────────────────────────────────────────────────────────────────

// 自动化验收与受管部署可使用隔离配置目录，避免与用户正在运行的 Otto 实例争抢单实例锁。
const isolatedUserDataDir = process.env.OTTO_USER_DATA_DIR?.trim();
if (isolatedUserDataDir) app.setPath('userData', isolatedUserDataDir);

// Windows/Linux cold start 会把协议 URL 放进 argv；macOS 则通过 open-url 事件送达。
// 解析器只接受中心企业邀请码链接，旧 token+key 链接不会改变登录状态。
enterpriseRegistrationIntents.acceptArgv(process.argv);
app.on('open-url', (event, url) => {
  event.preventDefault();
  acceptEnterpriseRegistrationUrl(url);
});

// 在窗口、托盘和 Notification 创建前注册稳定 AUMID。部分 Windows 机器若注册过晚，
// 通知中心无法把 toast 与安装器创建的 Otto 开始菜单快捷方式关联。
if (process.platform === 'win32') app.setAppUserModelId('ai.otto.desktop');

// 单实例锁：第二次启动直接聚焦已开窗口，避免多开多个 server 抢端口。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let quitCleanupStarted = false;
  let quitCleanupFinished = false;
  app.on('second-instance', (_event, commandLine) => {
    const accepted = enterpriseRegistrationIntents.acceptArgv(commandLine);
    if (
      accepted &&
      enterpriseIntentRendererReady &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      const intent = enterpriseRegistrationIntents.take();
      if (intent)
        mainWindow.webContents.send(
          IPC.enterpriseRegistrationIntentOpened,
          intent,
        );
    }
    showMainWindow();
  });

  app.whenReady().then(async () => {
    if (process.defaultApp && process.argv[1]) {
      app.setAsDefaultProtocolClient('otto', process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    } else {
      app.setAsDefaultProtocolClient('otto');
    }
    // 外观主题：默认跟随系统（'system' 让 renderer 的 prefers-color-scheme 生效）；
    // 用户在偏好里手动选过浅色/深色则恢复上次选择（userData/theme.json）。
    nativeTheme.themeSource = loadSavedThemeSource();

    registerIpc();
    installAppMenu(() => mainWindow);
    createTray();
    mainWindowCreationReady = true;

    // 先建窗（show:false，ready-to-show 再显），同时并发确保 server。
    mainWindow = createWindow();
    if (pendingMainWindowFocusRequest) {
      pendingMainWindowFocusRequest = false;
      mainWindowPresentations.get(mainWindow)?.requestShow({ focus: true });
    }
    applyCsp();
    await ensureEndpoint();
    startEnterpriseIdentityRefresh();
    startEnterpriseModuleUpdatePolling();
    startEnterpriseSkillUsageReporting();
    powerMonitor.on('resume', () => {
      if (!isQuitting) enterpriseMlsOutboxRetry.wake();
      if (!isQuitting) enterpriseMlsInboundPoll.wake();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
        // 窗口重建后把已知端点补推一次。
        mainWindow.webContents.once('did-finish-load', pushEndpointToRenderer);
      } else {
        showMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    // Windows/Linux 关闭主窗口后常驻系统托盘，避免 Otto 服务随窗口关闭而退出。
    // 真正退出走应用菜单或托盘「退出 Otto」。
    // detached server 故意留活：飞书守护不受窗口关闭影响。
    if (process.platform === 'darwin') return;
  });

  app.on('before-quit', (event) => {
    isQuitting = true;
    if (endpointRetryTimer) {
      clearTimeout(endpointRetryTimer);
      endpointRetryTimer = undefined;
    }
    stopEnterpriseIdentityRefresh();
    stopEnterpriseModuleUpdatePolling();
    stopEnterpriseSkillUsageReporting();
    if (quitCleanupFinished) return;
    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;
    // 退出前中止未完成的更新下载（审查 M2）：abort 触发下载循环的 AbortError
    // 清理路径，best-effort 删掉 Downloads 里的 .part 临时文件。幂等，无任务时空操作。
    // 即使进程赶在异步清理完成前退出，下次下载同一资产会截断重写同名 .part，
    // 且 sha256 校验兜底完整性，残留无危害。
    updateService.cancelDownload();
    fileAccessGrants.clear();
    notificationService.clearAll();
    // detached server 仅用户主动退出托盘时才杀。
    // 关窗不杀：server + 飞书守护继续运行。
    void flushEnterpriseAccountDataSync(3_000)
      .catch(logAccountDataSyncFailure)
      .then(() => enterpriseMlsOutboxRetry.stop())
      .then(() => enterpriseMlsInboundPoll.stop())
      .then(() => enterpriseMls.close())
      .then(() => serverManager.shutdown(isQuitting))
      .catch((error) => {
        console.warn('[otto-desktop] 退出清理 server 失败:', error);
      })
      .finally(() => {
        quitCleanupFinished = true;
        app.quit();
      });
  });
}
