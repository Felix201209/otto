/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import process from 'node:process';
import {
  AuthType,
  ContentGeneratorConfig,
  createContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { PromptRegistry } from '../prompts/prompt-registry.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { HookDefinition, HookEventName } from '../hooks/types.js';
import { isMCPDiscoveryTriggered, markMCPDiscoveryTriggered, unloadMcpServer } from '../tools/mcp-client.js';
import { LSTool } from '../tools/ls.js';
import { ReadFileTool } from '../tools/read-file.js';
import { GrepTool } from '../tools/grep.js';
import { GlobTool } from '../tools/glob.js';
import { EditTool } from '../tools/edit.js';
import { ShellTool } from '../tools/shell.js';
import { WriteFileTool } from '../tools/write-file.js';
import { DeleteFileTool } from '../tools/delete-file.js';
import { WebFetchTool } from '../tools/web-fetch.js';
import { ReadManyFilesTool } from '../tools/read-many-files.js';
import {
  MemoryTool,
  setOttoMdFilename,
  OTTO_CONFIG_DIR as OTTO_DIR,
} from '../tools/memoryTool.js';
import { WebSearchTool } from '../tools/web-search.js';
import type { SearchTelemetryEvent } from '../tools/web-search-runtime.js';
import { ImageReaderTool } from '../tools/image-reader.js';
import { TodoWriteTool } from '../tools/todo-write.js';
import { ReadLintsTool } from '../tools/read-lints.js';
import { LintFixTool } from '../tools/lint-fix.js';
import { TaskTool } from '../tools/task.js';
import { WorkflowTool } from '../tools/workflow.js';
import { UseSkillTool } from '../tools/use-skill.js';
import { ListSkillsTool } from '../tools/list-skills.js';
import { GetSkillDetailsTool } from '../tools/get-skill-details.js';
// Old LSP tools imports removed

import { CodeSearchTool } from '../tools/codesearch.js';
import { LspTool } from '../tools/lsp.js';
import { MultiEditTool } from '../tools/multiedit.js';
import { PatchTool } from '../tools/patch.js';
import { BatchTool } from '../tools/batch.js';
import { AskUserQuestionTool } from '../tools/ask-user-question.js';
import { LocalTimeTool } from '../tools/local-time.js';
import { LocalScheduleTool } from '../tools/local-schedule.js';
import { LarkCliTool } from '../tools/lark-cli.js';
import { KnowledgeBaseTool } from '../tools/knowledge-base.js';
import { DelegateToAgentTool } from '../tools/delegate-agent.js';
import { CheckDelegateStatusTool } from '../tools/delegate-status.js';
import { ProjectSettingsManager } from './projectSettings.js';
import { generateCustomModelId } from '../types/customModel.js';
import { OttoClient } from '../core/client.js';
import { ResourceRegistry } from '../resources/resource-registry.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import {
  type FileSystemService,
  StandardFileSystemService,
} from '../services/fileSystemService.js';
import { GitService } from '../services/gitService.js';
import { getProjectTempDir } from '../utils/paths.js';
import {
  initializeTelemetry,
  DEFAULT_TELEMETRY_TARGET,
  DEFAULT_OTLP_ENDPOINT,
  TelemetryTarget,
} from '../telemetry/index.js';
import {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
} from './models.js';
import { shouldAttemptBrowserLaunch } from '../utils/browser.js';
import { MCPOAuthConfig } from '../mcp/oauth-provider.js';
import { IdeClient } from '../ide/ide-client.js';
import { enableAutoLearning } from '../utils/post-exec-hook.js';
import { HookSystem } from '../hooks/hookSystem.js';
import { resolveSecret } from './secretResolver.js';

// Re-export OAuth config type
export type { MCPOAuthConfig };

export enum ApprovalMode {
  DEFAULT = 'default',
  AUTO_EDIT = 'autoEdit',
  YOLO = 'yolo',
}

export interface AccessibilitySettings {
  disableLoadingPhrases?: boolean;
}

/**
 * 由外层产品注入的受信文档署名。
 *
 * Core 只负责承载通用文档身份，不知道企业、组织树或账号来源；
 * 身份解析与授权留给 server/desktop 等产品外壳。
 */
export interface DocumentIdentity {
  name: string;
  department?: string;
}

export interface BugCommandSettings {
  urlTemplate: string;
}

export interface SummarizeToolOutputSettings {
  tokenBudget?: number;
}

export interface CloudModelInfo {
  name: string;
  displayName: string;
  creditsPerRequest: number;
  available: boolean;
  maxToken: number;
  highVolumeThreshold: number;
  highVolumeCredits: number;
}

export interface TelemetrySettings {
  enabled?: boolean;
  target?: TelemetryTarget;
  otlpEndpoint?: string;
  logPrompts?: boolean;
  outfile?: string;
}

export interface GeminiCLIExtension {
  name: string;
  version: string;
  isActive: boolean;
  hooks?: { [K in HookEventName]?: HookDefinition[] };
  mcpServers?: Record<string, unknown>;
}
export interface FileFilteringOptions {
  respectGitIgnore: boolean;
  respectGeminiIgnore: boolean;
}
// For memory files
export const DEFAULT_MEMORY_FILE_FILTERING_OPTIONS: FileFilteringOptions = {
  respectGitIgnore: false,
  respectGeminiIgnore: true,
};
// For all other files
export const DEFAULT_FILE_FILTERING_OPTIONS: FileFilteringOptions = {
  respectGitIgnore: true,
  respectGeminiIgnore: true,
};
export class MCPServerConfig {
  constructor(
    // For stdio transport
    readonly command?: string,
    readonly args?: string[],
    readonly env?: Record<string, string>,
    readonly cwd?: string,
    // For sse transport
    readonly url?: string,
    // For streamable http transport
    readonly httpUrl?: string,
    readonly headers?: Record<string, string>,
    // For websocket transport
    readonly tcp?: string,
    // Common
    readonly timeout?: number,
    readonly trust?: boolean,
    // Metadata
    readonly description?: string,
    readonly includeTools?: string[],
    readonly excludeTools?: string[],
    readonly extensionName?: string,
    // OAuth configuration
    readonly oauth?: MCPOAuthConfig,
    readonly authProviderType?: AuthProviderType,
  ) { }
}

export enum AuthProviderType {
  DYNAMIC_DISCOVERY = 'dynamic_discovery',
  GOOGLE_CREDENTIALS = 'google_credentials',
}

export interface SandboxConfig {
  command: 'docker' | 'podman' | 'sandbox-exec';
  image: string;
}

export type FlashFallbackHandler = (
  currentModel: string,
  fallbackModel: string,
  error?: unknown,
) => Promise<boolean | string | null>;

/**
 * web_search 工具的搜索后端。
 * - bing：抓取 cn.bing.com 结果页，免 key、国内开箱可用（默认）
 * - bocha：博查 Web Search API，需要 API key
 * - gemini：Gemini API googleSearch grounding（海外可用）
 * - volcengine：火山方舟 Responses API 的内置 Web Search（需 API key + 豆包模型/接入点）
 */
export type WebSearchProvider = 'bing' | 'bocha' | 'gemini' | 'volcengine';

export interface SearchProviderRuntimeConfig {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  /** 管理员配置的单次调用估算费用；不配置时只统计次数，不猜测价格。 */
  costPerRequestCny?: number;
}

export interface SearchQuotaDecision {
  allowed: boolean;
  reason?: string;
}

export interface ConfigParameters {
  sessionId: string;
  embeddingModel?: string;
  sandbox?: SandboxConfig;
  targetDir: string;
  debugMode: boolean;
  question?: string;
  feishuAutoStart?: boolean;
  fullContext?: boolean;
  coreTools?: string[];
  excludeTools?: string[];
  toolDiscoveryCommand?: string;
  toolCallCommand?: string;
  mcpServerCommand?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  /** 安全的无工具会话不得在 initialize() 后台连接任何 MCP 服务。 */
  disableMcpDiscovery?: boolean;
  /** 隔离会话不得把 cwd、系统信息或目录树加入模型历史。 */
  disableEnvironmentContext?: boolean;
  /** 隔离会话在 OttoChat 的生成配置中也必须保持空工具集。 */
  disableTools?: boolean;
  userMemory?: string;
  /** 飞书按会话隔离的个人记忆文件路径(每 chat 独立,save_memory 写此处)。 */
  feishuSessionMemoryFile?: string;
  geminiMdFileCount?: number;
  userRules?: string;
  /** 文档工具必须优先使用的受信署名，避免回退到操作系统登录用户名。 */
  documentIdentity?: DocumentIdentity;
  approvalMode?: ApprovalMode;
  showMemoryUsage?: boolean;
  contextFileName?: string | string[];
  accessibility?: AccessibilitySettings;
  telemetry?: TelemetrySettings;
  usageStatisticsEnabled?: boolean;
  fileFiltering?: {
    respectGitIgnore?: boolean;
    respectGeminiIgnore?: boolean;
    enableRecursiveFileSearch?: boolean;
  };
  checkpointing?: boolean;
  proxy?: string;
  customProxyServerUrl?: string; // Custom proxy server URL (from settings)
  /** web_search 工具的搜索后端：bing(默认,免key,国内可用) / bocha(需key) / gemini(Google grounding) */
  searchProvider?: WebSearchProvider;
  /** bocha 等需要 key 的搜索后端的 API key；未配置时环境变量 OTTO_BOCHA_API_KEY 兜底 */
  searchApiKey?: string;
  /** 搜索 API 完整地址；火山方舟默认 https://ark.cn-beijing.volces.com/api/v3/responses */
  searchApiUrl?: string;
  /** 负责执行搜索的模型 ID / 推理接入点 ID（火山方舟必填）。 */
  searchModel?: string;
  /** 已保存的备用搜索线路；用于主线路熔断后的自动切换。 */
  searchProviderConfigs?: Partial<
    Record<WebSearchProvider, SearchProviderRuntimeConfig>
  >;
  /** 搜索统计租户键。企业会话传 organizationId，个人会话传 accountId/local。 */
  searchTenantId?: string;
  /** 外壳可把脱敏搜索事件持久化；事件不含查询词、网页正文或 API Key。 */
  searchTelemetrySink?: (event: SearchTelemetryEvent) => void;
  /** 在发起供应商请求前执行企业月度额度校验。 */
  searchQuotaGuard?: (input: {
    tenantId: string;
    estimatedCostCny: number;
  }) => SearchQuotaDecision;
  cwd: string;
  fileDiscoveryService?: FileDiscoveryService;
  bugCommand?: BugCommandSettings;
  //model: string;
  extensionContextFilePaths?: string[];
  maxSessionTurns?: number;
  experimentalAcp?: boolean;
  listExtensions?: boolean;
  listSessions?: boolean;
  extensions?: GeminiCLIExtension[];
  blockedMcpServers?: Array<{ name: string; extensionName: string }>;
  noBrowser?: boolean;
  summarizeToolOutput?: Record<string, SummarizeToolOutputSettings>;
  model?: string;
  cloudModels?: CloudModelInfo[];
  customModels?: Array<import('../types/customModel.js').CustomModelConfig>;
  ideMode?: boolean;
  ideClient?: IdeClient;
  silentMode?: boolean;
  vsCodePluginMode?: boolean;
  feishuMode?: boolean;
  memoryTokenCount?: number; // 新增
  hooks?: { [K in HookEventName]?: HookDefinition[] };
  healthyUse?: boolean;
  preferredLanguage?: string;
}

export class Config {
  private toolRegistry!: ToolRegistry;
  private promptRegistry!: PromptRegistry;
  private resourceRegistry!: ResourceRegistry;
  private sessionId: string;
  private contentGeneratorConfig!: ContentGeneratorConfig;
  private acpAuthApiKey?: string;
  private acpAuthBaseUrl?: string;
  private acpAuthCustomHeaders?: Record<string, string>;
  private readonly embeddingModel: string;
  private readonly sandbox: SandboxConfig | undefined;
  private readonly targetDir: string;
  private readonly debugMode: boolean;
  private readonly question: string | undefined;
  private readonly feishuAutoStart: boolean;
  private readonly fullContext: boolean;
  private readonly coreTools: string[] | undefined;
  private readonly excludeTools: string[] | undefined;
  private readonly toolDiscoveryCommand: string | undefined;
  private readonly toolCallCommand: string | undefined;
  private readonly mcpServerCommand: string | undefined;
  private mcpServers: Record<string, MCPServerConfig> | undefined;
  private readonly disableMcpDiscovery: boolean;
  private readonly disableEnvironmentContext: boolean;
  private readonly disableTools: boolean;
  private userMemory: string;
  private feishuSessionMemoryFile: string | undefined;
  /**
   * 可选的分层记忆 Provider(Hermes 式三层记忆框架)。默认 undefined,
   * 此时记忆走既有 OTTO.md / 飞书会话文件路径,行为完全不变(向后兼容)。
   * 接入方可挂一个 MemoryProvider 后,经装配函数把三层合并进 userMemory。
   */
  private memoryProvider:
    | import('../memory/memoryProvider.js').MemoryProvider
    | undefined;
  private memoryTokenCount: number = 0; // 新增
  private geminiMdFileCount: number;
  private userRules: string;
  private readonly documentIdentity: DocumentIdentity | undefined;
  private geminiMdFilePaths: string[] = [];
  private approvalMode: ApprovalMode;
  private readonly showMemoryUsage: boolean;
  private readonly accessibility: AccessibilitySettings;
  private readonly telemetrySettings: TelemetrySettings;
  private readonly usageStatisticsEnabled: boolean;
  private geminiClient!: OttoClient;
  private hookSystem!: HookSystem;
  private readonly fileFiltering: {
    respectGitIgnore: boolean;
    respectGeminiIgnore: boolean;
    enableRecursiveFileSearch: boolean;
  };
  private fileDiscoveryService: FileDiscoveryService | null = null;
  private fileSystemService: FileSystemService | null = null;
  private gitService: GitService | undefined = undefined;
  private readonly checkpointing: boolean;
  private readonly proxy: string | undefined;
  private readonly customProxyServerUrl: string | undefined;
  private searchProvider: WebSearchProvider | undefined;
  private searchApiKey: string | undefined;
  private searchApiUrl: string | undefined;
  private searchModel: string | undefined;
  private searchProviderConfigs: Partial<
    Record<WebSearchProvider, SearchProviderRuntimeConfig>
  >;
  private searchTenantId: string;
  private searchTelemetrySink:
    ((event: SearchTelemetryEvent) => void) | undefined;
  private searchQuotaGuard:
    | ((input: {
        tenantId: string;
        estimatedCostCny: number;
      }) => SearchQuotaDecision)
    | undefined;
  private readonly cwd: string;
  private readonly bugCommand: BugCommandSettings | undefined;
  //private readonly model: string;
  private readonly extensionContextFilePaths: string[];
  private readonly noBrowser: boolean;
  private readonly ideMode: boolean;
  private readonly ideClient: IdeClient | undefined;
  private modelSwitchedDuringSession: boolean = false;
  private readonly maxSessionTurns: number;
  private readonly listExtensions: boolean;
  private readonly listSessions: boolean;
  private readonly _extensions: GeminiCLIExtension[];
  private readonly _blockedMcpServers: Array<{
    name: string;
    extensionName: string;
  }>;
  flashFallbackHandler?: FlashFallbackHandler;
  private quotaErrorOccurred: boolean = false;
  private readonly summarizeToolOutput:
    | Record<string, SummarizeToolOutputSettings>
    | undefined;
  private model: string | undefined;
  private cloudModels: CloudModelInfo[] | undefined;
  private customModels: Array<import('../types/customModel.js').CustomModelConfig> | undefined;
  private readonly experimentalAcp: boolean = false;
  private readonly silentMode: boolean;
  private readonly vsCodePluginMode: boolean;
  private readonly feishuMode: boolean;
  private projectSettingsManager: ProjectSettingsManager;
  private planModeActive: boolean = false;
  private readonly hooks: { [K in HookEventName]?: HookDefinition[] };
  private healthyUse: boolean;
  private preferredLanguage: string | undefined;

  constructor(params: ConfigParameters) {
    this.sessionId = params.sessionId;
    this.embeddingModel =
      params.embeddingModel ?? DEFAULT_GEMINI_EMBEDDING_MODEL;
    this.sandbox = params.sandbox;
    this.targetDir = path.resolve(params.targetDir);
    this.debugMode = params.debugMode;
    this.question = params.question;
    this.feishuAutoStart = params.feishuAutoStart ?? false;
    this.fullContext = params.fullContext ?? false;
    this.coreTools = params.coreTools;
    this.excludeTools = params.excludeTools;
    this.toolDiscoveryCommand = params.toolDiscoveryCommand;
    this.toolCallCommand = params.toolCallCommand;
    this.mcpServerCommand = params.mcpServerCommand;
    this.mcpServers = params.mcpServers;
    this.disableMcpDiscovery = params.disableMcpDiscovery ?? false;
    this.disableEnvironmentContext = params.disableEnvironmentContext ?? false;
    this.disableTools = params.disableTools ?? false;
    this.userMemory = params.userMemory ?? '';
    this.feishuSessionMemoryFile = params.feishuSessionMemoryFile;
    this.memoryTokenCount = params.memoryTokenCount ?? 0; // 新增
    this.geminiMdFileCount = params.geminiMdFileCount ?? 0;
    this.userRules = params.userRules ?? '';
    const documentName = params.documentIdentity?.name.trim();
    const documentDepartment = params.documentIdentity?.department?.trim();
    this.documentIdentity = documentName
      ? {
          name: documentName,
          ...(documentDepartment ? { department: documentDepartment } : {}),
        }
      : undefined;
    this.cwd = params.cwd ?? process.cwd();

    // 初始化项目配置管理器
    this.projectSettingsManager = new ProjectSettingsManager(this.cwd);
    const projectSettings = this.projectSettingsManager.load();

    // Security: default is ask-user. YOLO must be explicitly opted in.
    // 项目级配置默认优先于一般参数配置
    // 但如果命令行明确传入了 YOLO 模式（-y），它应具有最高优先级覆盖项目配置
    const projectApprovalMode = ProjectSettingsManager.toApprovalMode(projectSettings.yolo);
    this.approvalMode = params.approvalMode === ApprovalMode.YOLO
      ? ApprovalMode.YOLO
      : (projectApprovalMode ?? params.approvalMode ?? ApprovalMode.DEFAULT);
    this.showMemoryUsage = params.showMemoryUsage ?? false;
    this.accessibility = params.accessibility ?? {};
    // 硬编码禁用所有遥测功能
    this.telemetrySettings = {
      enabled: false,
      target: params.telemetry?.target ?? DEFAULT_TELEMETRY_TARGET,
      otlpEndpoint: params.telemetry?.otlpEndpoint ?? DEFAULT_OTLP_ENDPOINT,
      logPrompts: false,
      outfile: params.telemetry?.outfile,
    };
    // 硬编码禁用使用统计收集
    this.usageStatisticsEnabled = false;

    this.fileFiltering = {
      respectGitIgnore: params.fileFiltering?.respectGitIgnore ?? true,
      respectGeminiIgnore: params.fileFiltering?.respectGeminiIgnore ?? true,
      enableRecursiveFileSearch:
        params.fileFiltering?.enableRecursiveFileSearch ?? true,
    };
    this.checkpointing = params.checkpointing ?? false;
    this.proxy = params.proxy;
    this.customProxyServerUrl = params.customProxyServerUrl;
    this.searchProvider = params.searchProvider;
    this.searchApiKey = params.searchApiKey;
    this.searchApiUrl = params.searchApiUrl;
    this.searchModel = params.searchModel;
    this.searchProviderConfigs = params.searchProviderConfigs ?? {};
    this.searchTenantId = params.searchTenantId?.trim() || 'local';
    this.searchTelemetrySink = params.searchTelemetrySink;
    this.searchQuotaGuard = params.searchQuotaGuard;
    this.fileDiscoveryService = params.fileDiscoveryService ?? null;
    this.bugCommand = params.bugCommand;
    //this.model = params.model;
    this.extensionContextFilePaths = params.extensionContextFilePaths ?? [];
    this.maxSessionTurns = params.maxSessionTurns ?? -1;
    this.experimentalAcp = params.experimentalAcp ?? false;
    this.silentMode = params.silentMode ?? false;
    this.listExtensions = params.listExtensions ?? false;
    this.listSessions = params.listSessions ?? false;
    this._extensions = params.extensions ?? [];
    this._blockedMcpServers = params.blockedMcpServers ?? [];
    this.noBrowser = params.noBrowser ?? false;
    this.summarizeToolOutput = params.summarizeToolOutput;
    this.model = params.model;
    this.cloudModels = params.cloudModels;
    this.customModels = params.customModels;
    this.ideMode = params.ideMode ?? false;
    this.ideClient = params.ideClient;
    this.vsCodePluginMode = params.vsCodePluginMode ?? false;
    this.feishuMode = params.feishuMode ?? false;
    this.hooks = params.hooks ?? {};
    this.healthyUse = params.healthyUse ?? true;
    this.preferredLanguage = params.preferredLanguage;

    if (params.contextFileName) {
      setOttoMdFilename(params.contextFileName);
    }

    if (this.telemetrySettings.enabled) {
      initializeTelemetry(this);
    }
  }

  /**
   * 🎯 动态加载扩展中的 MCP 服务器
   */
  async loadExtensionMcpServers(extension: GeminiCLIExtension): Promise<void> {
    if (!extension.isActive) return;

    const mcpServers = extension.mcpServers ?? {};
    for (const name of Object.keys(mcpServers)) {
      await this.toolRegistry.discoverToolsForServer(name);
    }

    // 更新 AI 引擎的工具列表
    if (this.geminiClient?.isInitialized()) {
      await this.geminiClient.setTools();
    }
  }

  /**
   * 🎯 动态卸载扩展中的 MCP 服务器
   */
  async unloadExtensionMcpServers(extension: GeminiCLIExtension): Promise<void> {
    const mcpServers = extension.mcpServers ?? {};
    for (const name of Object.keys(mcpServers)) {
      await unloadMcpServer(
        name,
        this.toolRegistry,
        this.promptRegistry,
        this.resourceRegistry
      );
    }

    // 更新 AI 引擎的工具列表
    if (this.geminiClient?.isInitialized()) {
      await this.geminiClient.setTools();
    }
  }

  async initialize(): Promise<void> {
    // Set silent mode for core logging if configured
    if (this.silentMode) {
      const { setSilentMode } = await import('../utils/logging.js');
      setSilentMode(true);
    }

    // 🧹 异步清理 ~/.otto/last-requests/ 内超过 3 天的旧 dump 文件。
    // 进程内只跑一次，不阻塞 initialize；失败不影响启动。
    void (async () => {
      try {
        const { cleanupLastRequestsDir } = await import('../utils/lastRequestsCleanup.js');
        const removed = await cleanupLastRequestsDir();
        if (removed > 0) {
          // 用 console.log 而不是 logger，避免与 silentMode 互锁。
          // 信息量很小，启动期带一行无害。
          console.log(`[otto] last-requests cleanup: removed ${removed} stale dump file(s)`);
        }
      } catch {
        // 清理失败永远不能阻塞或抛错。
      }
    })();

    // Initialize centralized FileDiscoveryService
    this.getFileService();
    if (this.getCheckpointingEnabled()) {
      await this.getGitService();
    }
    this.promptRegistry = new PromptRegistry();
    this.resourceRegistry = new ResourceRegistry();

    // 初始化钩子系统（在工具注册表之前）
    this.hookSystem = new HookSystem(this);
    await this.hookSystem.initialize();

    // 快速初始化：只加载核心工具和命令行工具，不等待MCP服务器
    this.toolRegistry = await this.createToolRegistry();

    // MCP服务器异步后台加载，不阻塞初始化
    // 🎯 使用全局标志确保 MCP 发现只执行一次
    // 这避免了多个 Config 实例（特别是 VSCode 插件模式）导致 MCP 服务器重复连接和状态跳变
    if (!this.disableMcpDiscovery && !isMCPDiscoveryTriggered()) {
      markMCPDiscoveryTriggered();
      setImmediate(() => {
        this.discoverMcpToolsAsync();
      });
    }
  }

  /** 供 server 与测试确认安全会话的 MCP 隔离已进入真实 Config。 */
  getMcpDiscoveryDisabled(): boolean {
    return this.disableMcpDiscovery;
  }

  getEnvironmentContextDisabled(): boolean {
    return this.disableEnvironmentContext;
  }

  getToolsDisabled(): boolean {
    return this.disableTools;
  }

  /**
   * Asynchronously discover MCP tools in the background.
   * This doesn't block CLI initialization.
   */
  private async discoverMcpToolsAsync(): Promise<void> {
    try {
      await this.toolRegistry.discoverMcpTools();
      // 更新AI模型的工具列表和系统提示，使其能够感知到新加载的MCP工具和prompts
      if (this.geminiClient && this.geminiClient.isInitialized()) {
        await this.geminiClient.setTools();
        // 同时更新系统提示以包含最新发现的MCP prompts
        await this.geminiClient.updateSystemPromptWithMcpPrompts();
      }
    } catch (_error) {
      // MCP discovery errors are already logged in mcp-client.ts
      // We don't want to crash the CLI if MCP servers fail to connect
    }
  }

  async refreshAuth(
    authMethod: AuthType,
    options?: {
      apiKey?: string;
      baseUrl?: string;
      customHeaders?: Record<string, string>;
    },
  ) {
    // BUG修复: 保存当前模型设置，防止在重新配置时丢失
    // 修复策略: 在refreshAuth前保存模型，重新配置后恢复
    // 影响范围: packages/core/src/config/config.ts:refreshAuth方法
    // 修复日期: 2025-01-09
    // const currentModel = this.getModel();
    // const wasModelSwitched = this.modelSwitchedDuringSession;

    this.contentGeneratorConfig = createContentGeneratorConfig(
      this,
      authMethod,
    );

    // 允许 ACP 客户端在认证时覆盖 apiKey / baseUrl / headers。
    // DeepCode 的 ContentGeneratorConfig 目前只承载 authType / proxy，
    // 这些扩展字段先存到 Config 实例上，供 ACP 适配层读取。
    if (options?.apiKey !== undefined) {
      this.acpAuthApiKey = options.apiKey;
    }
    if (options?.baseUrl !== undefined) {
      this.acpAuthBaseUrl = options.baseUrl;
    }
    if (options?.customHeaders !== undefined) {
      this.acpAuthCustomHeaders = options.customHeaders;
    }

    // 恢复之前设置的模型（特别是Claude模型）
    // if (currentModel && this.contentGeneratorConfig) {
    //   this.contentGeneratorConfig.model = currentModel;
    //   this.modelSwitchedDuringSession = wasModelSwitched;
    // }

    this.geminiClient = new OttoClient(this);
    await this.geminiClient.initialize(this.contentGeneratorConfig);
  }

  /** ACP 认证时透传的 API Key（可空）。 */
  getAcpAuthApiKey(): string | undefined {
    return this.acpAuthApiKey;
  }

  /** ACP 认证时透传的 base URL（可空）。 */
  getAcpAuthBaseUrl(): string | undefined {
    return this.acpAuthBaseUrl;
  }

  /** ACP 认证时透传的自定义 HTTP headers（可空）。 */
  getAcpAuthCustomHeaders(): Record<string, string> | undefined {
    return this.acpAuthCustomHeaders;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getContentGeneratorConfig(): ContentGeneratorConfig {
    return this.contentGeneratorConfig;
  }

  getModel(): string {
    return this.model || 'auto';
  }

  getCloudModels(): CloudModelInfo[] | undefined {
    return this.cloudModels;
  }

  getCloudModelInfo(modelName: string): CloudModelInfo | undefined {
    return this.cloudModels?.find(model => model.name === modelName);
  }

  setCloudModels(models: CloudModelInfo[]): void {
    this.cloudModels = models;
  }

  getCustomModels(): Array<import('../types/customModel.js').CustomModelConfig> | undefined {
    return this.customModels;
  }

  getCustomModelConfig(modelId: string): import('../types/customModel.js').CustomModelConfig | undefined {
    // 新格式: custom:{provider}:{modelId}@{hash}
    // 通过生成每个配置的 ID 来匹配
    const matchByNewFormat = this.customModels?.find(model => {
      if (model.enabled === false) return false;
      return generateCustomModelId(model) === modelId;
    });
    if (matchByNewFormat) return matchByNewFormat;

    // 旧格式兼容: custom:{displayName}
    const withoutPrefix = modelId.replace('custom:', '');
    // 检查是否为新格式（包含 @ 表示 hash）
    if (!withoutPrefix.includes('@')) {
      // 纯旧格式，通过 displayName 匹配
      return this.customModels?.find(model => model.displayName === withoutPrefix && model.enabled !== false);
    }

    return undefined;
  }

  setCustomModels(models: Array<import('../types/customModel.js').CustomModelConfig>): void {
    this.customModels = models;
  }

  setModel(newModel: string): void {
    if (this.contentGeneratorConfig) {
      //this.contentGeneratorConfig.model = newModel;
      this.modelSwitchedDuringSession = true;
    }
    this.model = newModel;
  }

  isModelSwitchedDuringSession(): boolean {
    return this.modelSwitchedDuringSession;
  }

  resetModelToDefault(): void {
    if (this.contentGeneratorConfig) {
      //this.contentGeneratorConfig.model = this.preferredModel; // Reset to preferred model or original default
      this.modelSwitchedDuringSession = false;
    }
  }

  setFlashFallbackHandler(handler: FlashFallbackHandler): void {
    this.flashFallbackHandler = handler;
  }

  getMaxSessionTurns(): number {
    return this.maxSessionTurns;
  }

  setQuotaErrorOccurred(value: boolean): void {
    this.quotaErrorOccurred = value;
  }

  getQuotaErrorOccurred(): boolean {
    return this.quotaErrorOccurred;
  }

  getEmbeddingModel(): string {
    return this.embeddingModel;
  }

  getSandbox(): SandboxConfig | undefined {
    return this.sandbox;
  }

  getTargetDir(): string {
    return this.targetDir;
  }

  getProjectRoot(): string {
    return this.targetDir;
  }

  getToolRegistry(): Promise<ToolRegistry> {
    return Promise.resolve(this.toolRegistry);
  }

  getPromptRegistry(): PromptRegistry {
    return this.promptRegistry;
  }

  getResourceRegistry(): ResourceRegistry {
    return this.resourceRegistry;
  }

  getDebugMode(): boolean {
    return this.debugMode;
  }
  getQuestion(): string | undefined {
    return this.question;
  }

  getFeishuAutoStart(): boolean {
    return this.feishuAutoStart;
  }

  getFullContext(): boolean {
    return this.fullContext;
  }

  getCoreTools(): string[] | undefined {
    return this.coreTools;
  }

  getExcludeTools(): string[] | undefined {
    return this.excludeTools;
  }

  getToolDiscoveryCommand(): string | undefined {
    return this.toolDiscoveryCommand;
  }

  getToolCallCommand(): string | undefined {
    return this.toolCallCommand;
  }

  getMcpServerCommand(): string | undefined {
    return this.mcpServerCommand;
  }

  getMcpServers(): Record<string, MCPServerConfig> | undefined {
    return this.mcpServers;
  }

  getUserMemory(): string {
    return this.userMemory;
  }

  /** 飞书按会话隔离的个人记忆文件路径(未设置则用项目级 OTTO.md)。 */
  getFeishuSessionMemoryFile(): string | undefined {
    return this.feishuSessionMemoryFile;
  }

  getMemoryTokenCount(): number {
    return this.memoryTokenCount;
  }

  setUserMemory(newUserMemory: string): void {
    this.userMemory = newUserMemory;
  }

  /**
   * 取得分层记忆 Provider(若已挂载)。未挂载返回 undefined,调用方应回退到
   * 既有 OTTO.md / 飞书会话记忆路径(向后兼容)。
   */
  getMemoryProvider():
    | import('../memory/memoryProvider.js').MemoryProvider
    | undefined {
    return this.memoryProvider;
  }

  /** 挂载分层记忆 Provider(可选增强;不挂载则维持现状行为)。 */
  setMemoryProvider(
    provider:
      | import('../memory/memoryProvider.js').MemoryProvider
      | undefined,
  ): void {
    this.memoryProvider = provider;
  }

  setMemoryTokenCount(count: number): void {
    this.memoryTokenCount = count;
  }

  // 🎯 用户规则相关
  getUserRules(): string {
    return this.userRules;
  }

  setUserRules(rules: string): void {
    this.userRules = rules;
  }

  getDocumentIdentity(): DocumentIdentity | undefined {
    return this.documentIdentity
      ? { ...this.documentIdentity }
      : undefined;
  }

  getOttoMdFileCount(): number {
    return this.geminiMdFileCount;
  }

  setOttoMdFileCount(count: number): void {
    this.geminiMdFileCount = count;
  }

  getOttoMdFilePaths(): string[] {
    return this.geminiMdFilePaths;
  }

  setOttoMdFilePaths(paths: string[]): void {
    this.geminiMdFilePaths = paths;
  }

  updateMcpServers(servers: Record<string, MCPServerConfig> | undefined): void {
    this.mcpServers = servers;
  }

  /**
   * 🎯 动态添加 MCP 服务器配置
   */
  addMcpServer(name: string, config: MCPServerConfig): void {
    if (!this.mcpServers) {
      this.mcpServers = {};
    }
    this.mcpServers[name] = config;
  }

  /**
   * 🎯 动态移除 MCP 服务器配置
   */
  removeMcpServer(name: string): void {
    if (this.mcpServers) {
      delete this.mcpServers[name];
    }
  }

  getApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
  }

  /**
   * 设置YOLO模式并同步到项目配置文件
   * @param mode - 要设置的批准模式
   * @param saveToProject - 是否保存到项目配置文件
   */
  setApprovalModeWithProjectSync(mode: ApprovalMode, saveToProject: boolean = false): void {
    this.approvalMode = mode;

    if (saveToProject) {
      const yoloEnabled = mode === ApprovalMode.YOLO;
      this.projectSettingsManager.setYoloMode(yoloEnabled);
    }
  }

  /**
   * 获取项目配置管理器
   */
  getProjectSettingsManager(): ProjectSettingsManager {
    return this.projectSettingsManager;
  }

  /**
   * 获取Plan模式状态
   * @returns 当前是否处于Plan模式
   */
  getPlanModeActive(): boolean {
    return this.planModeActive;
  }

  /**
   * 设置Plan模式状态
   * @param active - 是否启用Plan模式
   */
  setPlanModeActive(active: boolean): void {
    this.planModeActive = active;
  }

  getHealthyUseEnabled(): boolean {
    return this.healthyUse;
  }

  /** 运行期切换健康使用提醒（不落盘；持久化由调用方经 settings.json 负责，如 CLI /config healthy-use）。 */
  setHealthyUseEnabled(enabled: boolean): void {
    this.healthyUse = enabled;
  }

  getPreferredLanguage(): string | undefined {
    return this.preferredLanguage;
  }

  /** 运行期切换偏好语言（不落盘；持久化由调用方负责）。 */
  setPreferredLanguage(language: string | undefined): void {
    this.preferredLanguage = language;
  }

  /**
   * 获取当前 Agent 风格
   * @returns 'default' (Claude-style) 或 'codex' (Codex-style)
   */
  getAgentStyle(): import('./projectSettings.js').AgentStyle {
    return this.projectSettingsManager.getAgentStyle();
  }

  /**
   * 设置 Agent 风格并持久化
   * @param style - 'default' 或 'codex'
   */
  setAgentStyle(style: import('./projectSettings.js').AgentStyle): void {
    this.projectSettingsManager.setAgentStyle(style);
  }

  /**
   * 获取当前思考配置（来自项目设置，可被 /thinking 命令修改）
   * 返回 undefined 表示用户未显式设置，应使用模型/provider 默认值
   */
  getThinkingConfig(): import('../types/customModel.js').ThinkingConfig | undefined {
    return this.projectSettingsManager.getThinkingConfig();
  }

  /**
   * 设置思考配置并持久化
   * 传入 undefined 可清除项目级配置（恢复为模型默认）
   */
  setThinkingConfig(config: import('../types/customModel.js').ThinkingConfig | undefined): void {
    this.projectSettingsManager.setThinkingConfig(config);
  }

  getShowMemoryUsage(): boolean {
    return this.showMemoryUsage;
  }

  getAccessibility(): AccessibilitySettings {
    return this.accessibility;
  }

  getTelemetryEnabled(): boolean {
    // 硬编码禁用遥测数据收集
    return false;
  }

  getTelemetryLogPromptsEnabled(): boolean {
    return this.telemetrySettings.logPrompts ?? true;
  }

  getTelemetryOtlpEndpoint(): string {
    return this.telemetrySettings.otlpEndpoint ?? DEFAULT_OTLP_ENDPOINT;
  }

  getTelemetryTarget(): TelemetryTarget {
    return this.telemetrySettings.target ?? DEFAULT_TELEMETRY_TARGET;
  }

  getTelemetryOutfile(): string | undefined {
    return this.telemetrySettings.outfile;
  }

  getOttoClient(): OttoClient {
    return this.geminiClient;
  }

  getHookSystem(): HookSystem {
    return this.hookSystem;
  }

  getOttoDir(): string {
    return path.join(this.targetDir, OTTO_DIR);
  }

  getProjectTempDir(): string {
    return getProjectTempDir(this.getProjectRoot());
  }

  getEnableRecursiveFileSearch(): boolean {
    return this.fileFiltering.enableRecursiveFileSearch;
  }

  getFileFilteringRespectGitIgnore(): boolean {
    return this.fileFiltering.respectGitIgnore;
  }
  getFileFilteringRespectGeminiIgnore(): boolean {
    return this.fileFiltering.respectGeminiIgnore;
  }

  getFileFilteringOptions(): FileFilteringOptions {
    return {
      respectGitIgnore: this.fileFiltering.respectGitIgnore,
      respectGeminiIgnore: this.fileFiltering.respectGeminiIgnore,
    };
  }

  getCheckpointingEnabled(): boolean {
    return this.checkpointing;
  }

  getProxy(): string | undefined {
    return this.proxy;
  }

  getCustomProxyServerUrl(): string | undefined {
    return this.customProxyServerUrl;
  }

  /** web_search 的搜索后端；不配置时默认 bing（免 key、国内开箱可用）。 */
  getSearchProvider(): WebSearchProvider {
    return this.searchProvider ?? 'bing';
  }

  /** 搜索 API key；按 provider 分别支持 ARK_API_KEY / OTTO_BOCHA_API_KEY 环境变量。 */
  getSearchApiKey(
    provider: WebSearchProvider = this.getSearchProvider(),
  ): string | undefined {
    const providerKey = this.searchProviderConfigs[provider]?.apiKey;
    if (providerKey) return resolveSecret(providerKey);
    if (provider === this.getSearchProvider() && this.searchApiKey) {
      // Resolve secret references ($ENV: / $KEYCHAIN:) before returning
      return resolveSecret(this.searchApiKey);
    }
    return provider === 'volcengine'
      ? (process.env.ARK_API_KEY ?? undefined)
      : provider === 'bocha'
        ? (process.env.OTTO_BOCHA_API_KEY ?? undefined)
        : undefined;
  }

  getSearchApiUrl(
    provider: WebSearchProvider = this.getSearchProvider(),
  ): string | undefined {
    return (
      this.searchProviderConfigs[provider]?.apiUrl ??
      (provider === this.getSearchProvider() ? this.searchApiUrl : undefined) ??
      (provider === 'volcengine'
        ? process.env.OTTO_SEARCH_API_URL
        : undefined) ??
      undefined
    );
  }

  getSearchModel(
    provider: WebSearchProvider = this.getSearchProvider(),
  ): string | undefined {
    return (
      this.searchProviderConfigs[provider]?.model ??
      (provider === this.getSearchProvider() ? this.searchModel : undefined) ??
      (provider === 'volcengine' ? process.env.OTTO_SEARCH_MODEL : undefined) ??
      undefined
    );
  }

  getSearchProviderCostCny(provider: WebSearchProvider): number | undefined {
    const value = this.searchProviderConfigs[provider]?.costPerRequestCny;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  }

  getSearchTenantId(): string {
    return this.searchTenantId;
  }

  emitSearchTelemetry(event: SearchTelemetryEvent): void {
    try {
      this.searchTelemetrySink?.(event);
    } catch (error) {
      console.warn('[Config] Search telemetry sink failed:', error);
    }
  }

  checkSearchQuota(estimatedCostCny = 0): SearchQuotaDecision {
    try {
      return (
        this.searchQuotaGuard?.({
          tenantId: this.searchTenantId,
          estimatedCostCny: Math.max(0, estimatedCostCny),
        }) ?? { allowed: true }
      );
    } catch (error) {
      console.warn('[Config] Search quota guard failed:', error);
      return { allowed: false, reason: 'search quota status unavailable' };
    }
  }

  /** 桌面设置保存后热更新存活会话；WebSearchTool 每次执行都从 Config 读取。 */
  setSearchConfig(config: {
    provider: WebSearchProvider;
    apiKey?: string;
    apiUrl?: string;
    model?: string;
    providerConfigs?: Partial<
      Record<WebSearchProvider, SearchProviderRuntimeConfig>
    >;
  }): void {
    this.searchProvider = config.provider;
    this.searchApiKey = config.apiKey;
    this.searchApiUrl = config.apiUrl;
    this.searchModel = config.model;
    if (config.providerConfigs) {
      this.searchProviderConfigs = config.providerConfigs;
    }
  }

  getWorkingDir(): string {
    return this.cwd;
  }

  getBugCommand(): BugCommandSettings | undefined {
    return this.bugCommand;
  }

  getFileService(): FileDiscoveryService {
    if (!this.fileDiscoveryService) {
      this.fileDiscoveryService = new FileDiscoveryService(this.targetDir);
    }
    return this.fileDiscoveryService;
  }

  /**
   * The text file read/write provider. Defaults to {@link StandardFileSystemService}
   * (Node `fs/promises`). ACP clients can install an editor-backed provider
   * via {@link setFileSystemService}.
   */
  getFileSystemService(): FileSystemService {
    if (!this.fileSystemService) {
      this.fileSystemService = new StandardFileSystemService();
    }
    return this.fileSystemService;
  }

  /** Replace the active {@link FileSystemService}. */
  setFileSystemService(service: FileSystemService): void {
    this.fileSystemService = service;
  }

  getUsageStatisticsEnabled(): boolean {
    // 硬编码禁用使用统计收集
    return false;
  }

  getExtensionContextFilePaths(): string[] {
    return this.extensionContextFilePaths;
  }

  getExperimentalAcp(): boolean {
    return this.experimentalAcp;
  }

  getSilentMode(): boolean {
    return this.silentMode;
  }

  getListExtensions(): boolean {
    return this.listExtensions;
  }

  getListSessions(): boolean {
    return this.listSessions;
  }

  getExtensions(): GeminiCLIExtension[] {
    return this._extensions;
  }

  getBlockedMcpServers(): Array<{ name: string; extensionName: string }> {
    return this._blockedMcpServers;
  }

  getNoBrowser(): boolean {
    return this.noBrowser;
  }

  isBrowserLaunchSuppressed(): boolean {
    return this.getNoBrowser() || !shouldAttemptBrowserLaunch();
  }

  getSummarizeToolOutputConfig():
    | Record<string, SummarizeToolOutputSettings>
    | undefined {
    return this.summarizeToolOutput;
  }

  getPreferredModel(): string | undefined {
    return this.model;
  }

  getIdeMode(): boolean {
    return this.ideMode;
  }

  getIdeClient(): IdeClient | undefined {
    return this.ideClient;
  }

  getVsCodePluginMode(): boolean {
    return this.vsCodePluginMode;
  }

  getFeishuMode(): boolean {
    return this.feishuMode;
  }

  getHooks(): { [K in HookEventName]?: HookDefinition[] } {
    return this.hooks;
  }

  async getGitService(): Promise<GitService> {
    if (!this.gitService) {
      this.gitService = new GitService(this.targetDir);
      const initResult = await this.gitService.initialize();

      // Log the initialization result but don't throw errors
      if (!initResult.success) {
        console.warn(`[CONFIG] Git service initialization failed but continuing: ${initResult.disabledReason}`);
      }
    }
    return this.gitService;
  }

  async createToolRegistry(): Promise<ToolRegistry> {
    const registry = new ToolRegistry(this);

    const isCoreToolEnabled = (className: string, toolName: string) => {
      const coreTools = this.getCoreTools();
      const excludeTools = this.getExcludeTools();

      let isEnabled = false;
      if (coreTools === undefined) {
        isEnabled = true;
      } else {
        isEnabled = coreTools.some(
          (tool) =>
            tool === className ||
            tool === toolName ||
            tool.startsWith(`${className}(`) ||
            tool.startsWith(`${toolName}(`),
        );
      }

      if (
        excludeTools?.includes(className) ||
        excludeTools?.includes(toolName)
      ) {
        isEnabled = false;
      }

      return isEnabled;
    };

    // helper to create & register core tools that are enabled
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registerCoreTool = (ToolClass: any, ...args: unknown[]) => {
      const className = ToolClass.name;
      const toolName = ToolClass.Name || className;

      if (isCoreToolEnabled(className, toolName)) {
        registry.registerTool(new ToolClass(...args));
      }
    };

    const registerLazyCoreTool = async (
      className: string,
      toolName: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      loadToolClass: () => Promise<any>,
      ...args: unknown[]
    ) => {
      if (!isCoreToolEnabled(className, toolName)) return;
      const ToolClass = await loadToolClass();
      registry.registerTool(new ToolClass(...args));
    };

    registerCoreTool(LSTool, this);
    registerCoreTool(ReadFileTool, this);
    registerCoreTool(GrepTool, this);
    registerCoreTool(GlobTool, this);
    registerCoreTool(EditTool, this);
    registerCoreTool(WriteFileTool, this);
    registerCoreTool(DeleteFileTool, this);
    registerCoreTool(WebFetchTool, this);
    registerCoreTool(ReadManyFilesTool, this);
    registerCoreTool(ShellTool, this);
    registerCoreTool(MemoryTool, this);
    registerCoreTool(WebSearchTool, this);
    // 个人知识库：完全本地（~/.otto-user/knowledge），不依赖 server / 企业鉴权
    registerCoreTool(KnowledgeBaseTool, this);
    registerCoreTool(ImageReaderTool, this);
    registerCoreTool(TodoWriteTool, this);
    if (this.getVsCodePluginMode()) {
      registerCoreTool(ReadLintsTool, this);
    }
    registerCoreTool(LintFixTool, this);
    registerCoreTool(UseSkillTool, this);
    registerCoreTool(ListSkillsTool, this);
    registerCoreTool(GetSkillDetailsTool, this);

    // Old individual LSP tools registration removed in favor of unified LspTool

    await registerLazyCoreTool(
      'PptOutlineTool',
      'ppt_outline',
      async () => (await import('../tools/ppt/pptOutlineTool.js')).PptOutlineTool,
      this,
    );
    await registerLazyCoreTool(
      'PptGenerateTool',
      'ppt_generate',
      async () => (await import('../tools/ppt/pptGenerateTool.js')).PptGenerateTool,
      this,
    );
    registerCoreTool(CodeSearchTool, this);
    registerCoreTool(LspTool, this);
    registerCoreTool(MultiEditTool, this);
    registerCoreTool(PatchTool, this);
    registerCoreTool(BatchTool, this);

    // AskUserQuestion interactive dialog is only available in CLI mode;
    // it performs poorly in VSCode plugin environment
    if (!this.getVsCodePluginMode()) {
      registerCoreTool(AskUserQuestionTool, this);
    }

    registerCoreTool(LocalTimeTool, this);
    registerCoreTool(LocalScheduleTool, this);
    registerCoreTool(LarkCliTool, this);

    // —— Otto Enterprise 九大能力：把「AI 办公同事」落到实处 ——
    // 这些工具对系统二进制/依赖均做优雅降级（缺依赖时 fail-loud，不崩）。
    await registerLazyCoreTool('DesktopAutomationTool', 'desktop_automation', async () => (await import('../tools/desktop-automation.js')).DesktopAutomationTool, this); // 桌面自动化（窗口/键鼠/脚本）
    await registerLazyCoreTool('VideoEditorTool', 'video_editor', async () => (await import('../tools/video-editor.js')).VideoEditorTool, this); // 视频编辑器（OpenReel集成）
    await registerLazyCoreTool('ConvertDocumentTool', 'convert_document', async () => (await import('../tools/convert-document.js')).ConvertDocumentTool, this); // 文档格式转换（pandoc/LibreOffice）
    await registerLazyCoreTool('GenerateDocumentTool', 'generate_document', async () => (await import('../tools/generate-document.js')).GenerateDocumentTool, this); // 文档生成（Typst/Marp）
    await registerLazyCoreTool('AnalyzeDataTool', 'analyze_data', async () => (await import('../tools/analyze-data.js')).AnalyzeDataTool, this); // 数据分析出图（DuckDB/gnuplot）
    await registerLazyCoreTool('DiagnoseSystemTool', 'diagnose_system', async () => (await import('../tools/diagnose-system.js')).DiagnoseSystemTool, this); // 系统诊断（macOS/Windows）
    await registerLazyCoreTool('WebAutomationTool', 'web_automation', async () => (await import('../tools/web-automation.js')).WebAutomationTool, this);
    await registerLazyCoreTool('MultiChannelTool', 'multi_channel', async () => (await import('../tools/multi-channel.js')).MultiChannelTool, this); // 多渠道消息（飞书/企微/钉钉等）
    await registerLazyCoreTool('MemoryManagerTool', 'memory_manager', async () => (await import('../tools/memory-manager.js')).MemoryManagerTool, this); // 知识沉淀 + HR 生命周期
    await registerLazyCoreTool('FeishuProjectCollabTool', 'feishu_project_collab', async () => (await import('../tools/feishu-project-collab.js')).FeishuProjectCollabTool, this); // 飞书项目协作：表格/多维表格/验收节点/提醒/进度同步
    await registerLazyCoreTool('EnterpriseCollaborationTool', 'enterprise_collaboration', async () => (await import('../tools/enterprise-collaboration.js')).EnterpriseCollaborationTool); // 企业树成员、私聊与经授权的 Otto-to-Otto 协作
    // 语音输入：真管线在 scripts/voice_bridge.py（已并入）；运行时另需 ffmpeg + python3 +
    // 本地 whisper 或云端转写 API。缺依赖时工具 fail-loud，不影响其它能力。
    await registerLazyCoreTool('VoiceBridgeTool', 'voice_bridge', async () => (await import('../tools/voice-bridge.js')).VoiceBridgeTool, this); // 语音输入（录音→转写→润色成指令）
    await registerLazyCoreTool('DoctorTool', 'doctor', async () => (await import('../tools/doctor.js')).DoctorTool, this); // 依赖体检（一次性自检上述能力所需的外部二进制/模块）

    // Delegate-to-external-agent (ACP client). Drives the user's local Claude
    // Code; gracefully reports a readable error if the bridge isn't installed.
    registerCoreTool(DelegateToAgentTool, this);
    registerCoreTool(CheckDelegateStatusTool, this);

    // TaskTool (SubAgent) is available in both CLI and VSCode environments
    registerCoreTool(TaskTool, this, registry);

    // WorkflowTool is disabled in VSCode plugin mode (not yet adapted)
    // but remains available in CLI mode
    if (!this.getVsCodePluginMode()) {
      registerCoreTool(WorkflowTool, this, registry);
    }

    // 快速启动优化：只发现命令行工具，MCP工具将在后台异步加载
    // 这样可以让CLI界面立即显示，不用等待所有MCP服务器连接完成
    await registry.discoverCommandLineTools();
    // Enable auto-learning: every task execution auto-logs to memory_manager
    enableAutoLearning(registry, this);
    return registry;
  }
}
// Export model constants for use in CLI
export { DEFAULT_GEMINI_FLASH_MODEL };
