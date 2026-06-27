/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import process from 'node:process';
import {
  Config,
  loadServerHierarchicalMemory,
  setOttoMdFilename as setServerGeminiMdFilename,
  getCurrentGeminiMdFilename,
  ApprovalMode,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
  FileDiscoveryService,
  TelemetryTarget,
  FileFilteringOptions,
  IdeClient,
} from 'otto-core';
import { getEncoding } from 'js-tiktoken';
import { Settings } from './settings.js';
import { loadCustomModels } from './customModelsStorage.js';

import { Extension, annotateActiveExtensions } from './extension.js';
import { getCliVersion } from '../utils/version.js';
import { loadSandboxConfig } from './sandboxConfig.js';
import { extensionsCommand } from '../commands/extensions.js';
import { checkpointCommand } from '../commands/checkpoint.js';
import {
  loadAllExtensionCommands,
  registerExtensionCommands,
} from './extension-commands.js';

// Simple console logger for now - replace with actual logger if available
const logger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any[]) => console.debug('[DEBUG]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (...args: any[]) => console.warn('[WARN]', ...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any[]) => console.error('[ERROR]', ...args),
};

export interface CliArgs {
  model: string | undefined;
  sandbox: boolean | string | undefined;
  sandboxImage: string | undefined;
  debug: boolean | undefined;
  prompt: string | undefined;
  promptInteractive: string | undefined;
  allFiles: boolean | undefined;
  all_files: boolean | undefined;
  showMemoryUsage: boolean | undefined;
  show_memory_usage: boolean | undefined;
  yolo: boolean | undefined;
  telemetry: boolean | undefined;
  checkpointing: boolean | undefined;
  telemetryTarget: string | undefined;
  outputFormat: 'stream-json' | 'json' | 'default' | undefined;
  _: string[]; // positional arguments
  telemetryOtlpEndpoint: string | undefined;
  telemetryLogPrompts: boolean | undefined;
  telemetryOutfile: string | undefined;
  allowedMcpServerNames: string[] | undefined;
  acp: boolean | undefined;
  experimentalAcp: boolean | undefined;
  extensions: string[] | undefined;
  listExtensions: boolean | undefined;
  ideMode: boolean | undefined;
  proxy: string | undefined;
  update: boolean | undefined;
  continue: boolean | undefined;
  session: string | undefined;
  listSessions: boolean | undefined;
  exportSession: string | undefined;
  cloudMode: boolean | undefined;
  cloudServer: string | undefined;
  testAudio: boolean | undefined;
  workdir: string | undefined;
  login: string | undefined;
  feishu: boolean | undefined;
}

export async function parseArguments(extensions: Extension[] = []): Promise<CliArgs> {
  const yargsInstance = yargs(hideBin(process.argv))
    .scriptName('otto')
    .usage(
      '$0 [options]',
      'Otto - Launch an interactive CLI, use -p/--prompt for non-interactive mode',
    )
    .option('model', {
      alias: 'm',
      type: 'string',
      description: `Model`,
      default: process.env.GEMINI_MODEL,
    })
    .option('prompt', {
      alias: 'p',
      type: 'string',
      description: 'Prompt. Appended to input on stdin (if any).',
    })
    .option('prompt-interactive', {
      alias: 'i',
      type: 'string',
      description:
        'Execute the provided prompt and continue in interactive mode',
    })
    .option('sandbox', {
      alias: 's',
      type: 'boolean',
      description: 'Run in sandbox?',
    })
    .option('sandbox-image', {
      type: 'string',
      description: 'Sandbox image URI.',
    })
    .option('debug', {
      alias: 'd',
      type: 'boolean',
      description: 'Run in debug mode?',
      default: false,
    })
    .option('all-files', {
      alias: ['a'],
      type: 'boolean',
      description: 'Include ALL files in context?',
      default: false,
    })
    .option('all_files', {
      type: 'boolean',
      description: 'Include ALL files in context?',
      default: false,
    })
    .deprecateOption(
      'all_files',
      'Use --all-files instead. We will be removing --all_files in the coming weeks.',
    )
    .option('show-memory-usage', {
      type: 'boolean',
      description: 'Show memory usage in status bar',
      default: false,
    })
    .option('show_memory_usage', {
      type: 'boolean',
      description: 'Show memory usage in status bar',
      default: false,
    })
    .deprecateOption(
      'show_memory_usage',
      'Use --show-memory-usage instead. We will be removing --show_memory_usage in the coming weeks.',
    )
    .option('yolo', {
      alias: 'y',
      type: 'boolean',
      description:
        'Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?',
      default: false,
    })
    .option('telemetry', {
      type: 'boolean',
      description:
        'Enable telemetry? This flag specifically controls if telemetry is sent. Other --telemetry-* flags set specific values but do not enable telemetry on their own.',
    })
    .option('telemetry-target', {
      type: 'string',
      choices: ['local', 'gcp'],
      description:
        'Set the telemetry target (local or gcp). Overrides settings files.',
    })
    .option('telemetry-otlp-endpoint', {
      type: 'string',
      description:
        'Set the OTLP endpoint for telemetry. Overrides environment variables and settings files.',
    })
    .option('telemetry-log-prompts', {
      type: 'boolean',
      description:
        'Enable or disable logging of user prompts for telemetry. Overrides settings files.',
    })
    .option('telemetry-outfile', {
      type: 'string',
      description: 'Redirect all telemetry output to the specified file.',
    })
    .option('checkpointing', {
      type: 'boolean',
      description: 'Enables checkpointing of file edits',
      default: false,
    })
    .option('acp', {
      type: 'boolean',
      description: 'Starts the agent in ACP mode',
    })
    .option('feishu', {
      type: 'boolean',
      description:
        'Launch directly into Feishu/Lark gateway mode (auto-runs /feishu start after startup). Used by self-update auto-restart.',
    })
    .option('experimental-acp', {
      type: 'boolean',
      description:
        'Starts the agent in ACP mode (deprecated, use --acp instead)',
    })
    .option('allowed-mcp-server-names', {
      type: 'array',
      string: true,
      description: 'Allowed MCP server names',
    })
    .option('extensions', {
      alias: 'e',
      type: 'array',
      string: true,
      description:
        'A list of extensions to use. If not provided, all extensions are used.',
    })
    .option('list-extensions', {
      alias: 'l',
      type: 'boolean',
      description: 'List all available extensions and exit.',
    })
    .option('ide-mode', {
      type: 'boolean',
      description: 'Run in IDE mode?',
    })
    .option('proxy', {
      type: 'string',
      description:
        'Proxy for Otto client, like schema://user:password@host:port',
    })
    .option('update', {
      alias: 'u',
      type: 'boolean',
      description:
        'Force check for updates and prompt to install if available. Combine with -y (`-uy`) to auto-confirm optional updates without the y/N prompt.',
      default: false,
    })
    .option('continue', {
      alias: 'c',
      type: 'boolean',
      description: 'Continue from the last active session',
      default: true,
    })
    .option('session', {
      type: 'string',
      description: 'Resume a specific session by ID',
    })
    .option('list-sessions', {
      type: 'boolean',
      description: 'List all available sessions with their timestamps and exit',
      default: false,
    })
    .option('export-session', {
      type: 'string',
      description: 'Export a specific session history to a Markdown file and exit',
    })
    .option('cloud-mode', {
      alias: ['remote', 'cloud'],
      type: 'boolean',
      description: 'Connect to cloud server for remote access',
      default: false,
    })
    .option('cloud-server', {
      type: 'string',
      description: 'Cloud server URL for cloud mode (BYO: set via --cloud-server or OTTO_SERVER_URL)',
      default: '',
    })
    .option('test-audio', {
      type: 'boolean',
      description: 'Test audio notification sounds and exit',
      default: false,
    })
    .option('workdir', {
      type: 'string',
      description: 'Specify the working directory (supports both Windows and Unix paths)',
    })
    .option('login', {
      type: 'string',
      description: 'Non-interactive login using an API Key (e.g. otto --login sk_live_xxx). Exchanges the key for a JWT and exits.',
    })
    .option('output-format', {
      type: 'string',
      choices: ['stream-json', 'json', 'default'],
      description: 'Output format for non-interactive mode (stream-json for streaming JSONL, json for single JSON result, default for plain text)',
      default: 'default',
    })
    .command(extensionsCommand)
    .command(checkpointCommand);

  // Dynamically load and register extension commands at runtime
  if (extensions.length > 0) {
    const extensionCommands = await loadAllExtensionCommands(extensions);
    if (extensionCommands.length > 0) {
      registerExtensionCommands(yargsInstance, extensionCommands);
    }
  }

  yargsInstance
    .version(await getCliVersion()) // This will enable the --version flag based on package.json
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .strict()
    .check((argv) => {
      if (argv.prompt && argv.promptInteractive) {
        throw new Error(
          'Cannot use both --prompt (-p) and --prompt-interactive (-i) together',
        );
      }
      return true;
    });

  yargsInstance.wrap(yargsInstance.terminalWidth());
  const parsedArgs = yargsInstance.argv as unknown as CliArgs;

  // Type-safe conversion for outputFormat
  if (parsedArgs.outputFormat && !['stream-json', 'json', 'default'].includes(parsedArgs.outputFormat)) {
    parsedArgs.outputFormat = 'default';
  }

  // Handle positional arguments as prompt
  // If no explicit --prompt/-p is provided, use positional arguments as the prompt
  // This supports natural command syntax like: otto "your prompt" --yolo
  if (!parsedArgs.prompt && !parsedArgs.promptInteractive) {
    // First try to get from yargs parsed args
    let positionalPrompt = '';

    if (parsedArgs._ && parsedArgs._.length > 0) {
      positionalPrompt = parsedArgs._.join(' ').trim();
    }

    // Fallback: manually check process.argv for the last non-option argument
    // This handles cases where yargs might miss the positional argument
    // especially when it appears after options: otto --output-format stream-json "prompt"
    if (!positionalPrompt) {
      const rawArgv = process.argv.slice(2);
      for (let i = rawArgv.length - 1; i >= 0; i--) {
        const arg = rawArgv[i];
        // Skip if it's an option or a value for an option
        if (!arg.startsWith('-') && !arg.startsWith('--')) {
          // Check if previous argument was an option that expects a value
          if (i > 0) {
            const prevArg = rawArgv[i - 1];
            // Options that take values
            const valueOptions = ['--model', '-m', '--output-format', '--sandbox-image', '--prompt', '-p', '--prompt-interactive', '-i', '--workdir', '--telemetry-target', '--telemetry-otlp-endpoint', '--telemetry-outfile', '--allowed-mcp-server-names', '--extensions', '-e', '--session', '--cloud-server', '--proxy'];
            if (valueOptions.includes(prevArg)) {
              continue;
            }
          }
          positionalPrompt = arg;
          break;
        }
      }
    }

    if (positionalPrompt.length > 0) {
      parsedArgs.prompt = positionalPrompt;
    }
  }

  return parsedArgs as CliArgs;
}

/**
 * Filter memory loading results based on projectMemoryMode setting.
 * - 'all' (default): keep both OTTO.md and AGENTS.md
 * - 'otto-only': keep only OTTO.md (filter out AGENTS.md)
 * - 'none': return empty results
 */
export function filterMemoryByMode(
  result: { memoryContent: string; fileCount: number; filePaths: string[] },
  mode: Settings['projectMemoryMode'],
): { memoryContent: string; fileCount: number; filePaths: string[] } {
  if (mode === 'none') {
    return { memoryContent: '', fileCount: 0, filePaths: [] };
  }

  if (mode === 'otto-only') {
    const filteredPaths = result.filePaths.filter((fp) => {
      const filename = fp.split(/[\\/]/).pop() || '';
      return !filename.toUpperCase().startsWith('AGENTS');
    });
    if (filteredPaths.length === result.filePaths.length) {
      return result; // No AGENTS.md files found, return as-is
    }
    // Re-filter memory content by removing AGENTS.md blocks
    const filteredContent = result.memoryContent
      .split('\n\n')
      .filter((block) => !block.includes('AGENTS.md ---'))
      .join('\n\n')
      .trim();
    return {
      memoryContent: filteredContent,
      fileCount: filteredPaths.length,
      filePaths: filteredPaths,
    };
  }

  // 'all' or undefined (default) — no filtering
  return result;
}

// This function is now a thin wrapper around the server's implementation.
// It's kept in the CLI for now as App.tsx directly calls it for memory refresh.
// TODO: Consider if App.tsx should get memory via a server call or if Config should refresh itself.
export async function loadHierarchicalOttoMemory(
  currentWorkingDirectory: string,
  debugMode: boolean,
  fileService: FileDiscoveryService,
  settings: Settings,
  extensionContextFilePaths: string[] = [],
  fileFilteringOptions?: FileFilteringOptions,
): Promise<{ memoryContent: string; fileCount: number; filePaths: string[] }> {
  if (debugMode) {
    logger.debug(
      `CLI: Delegating hierarchical memory load to server for CWD: ${currentWorkingDirectory}`,
    );
  }

  // Directly call the server function.
  // The server function will use its own homedir() for the global path.
  const result = await loadServerHierarchicalMemory(
    currentWorkingDirectory,
    debugMode,
    fileService,
    extensionContextFilePaths,
    fileFilteringOptions,
    settings.memoryDiscoveryMaxDirs,
  );

  // Apply projectMemoryMode filtering
  return filterMemoryByMode(result, settings.projectMemoryMode);
}

export async function loadCliConfig(
  settings: Settings,
  extensions: Extension[],
  sessionId: string,
  argv: CliArgs,
): Promise<Config> {
  // Check if in non-interactive mode (-p flag) for silent operation
  // Also check environment variable set by start.js
  const isNonInteractiveMode = !!(argv.prompt && !argv.promptInteractive) ||
                               process.env.OTTO_SILENT_MODE === 'true';

  const debugMode = false; // 默认关闭调试模式，只保留必要的用户信息输出

  // 修改IDE模式逻辑：在VSCode环境中且没有沙盒时自动启用IDE模式
  // 除非用户明确通过 --no-ide-mode 禁用
  const shouldTryIdeConnection =
    process.env.TERM_PROGRAM === 'vscode' &&
    !process.env.SANDBOX;

  const ideMode = shouldTryIdeConnection &&
    (argv.ideMode !== false); // 只有明确设置 --no-ide-mode 才禁用

  // 创建IDE连接（如果满足条件）
  let ideClient: IdeClient | undefined;
  if (shouldTryIdeConnection) {
    ideClient = new IdeClient();
  }

  const allExtensions = annotateActiveExtensions(
    extensions,
    argv.extensions || [],
  );

  const activeExtensions = extensions.filter(
    (_, i) => allExtensions[i].isActive,
  );

  // Set the context filename in the server's memoryTool module BEFORE loading memory
  // TODO(b/343434939): This is a bit of a hack. The contextFileName should ideally be passed
  // directly to the Config constructor in core, and have core handle setOttoMdFilename.
  // However, loadHierarchicalOttoMemory is called *before* createServerConfig.
  if (settings.contextFileName) {
    setServerGeminiMdFilename(settings.contextFileName);
  } else {
    // Reset to default if not provided in settings.
    setServerGeminiMdFilename(getCurrentGeminiMdFilename());
  }

  const extensionContextFilePaths = activeExtensions.flatMap(
    (e) => e.contextFiles,
  );

  const fileService = new FileDiscoveryService(process.cwd());

  const fileFiltering = {
    ...DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
    ...settings.fileFiltering,
  };

  // Call the (now wrapper) loadHierarchicalOttoMemory which calls the server's version
  const { memoryContent, fileCount, filePaths } = await loadHierarchicalOttoMemory(
    process.cwd(),
    debugMode,
    fileService,
    settings,
    extensionContextFilePaths,
    fileFiltering,
  );

  // Log memory file paths during initialization (for user transparency)
  if (filePaths.length > 0) {
    if (debugMode) {
      logger.debug(`Loaded ${fileCount} memory file(s):`);
      filePaths.forEach((filePath) => {
        logger.debug(`  - ${filePath}`);
      });
    }
  }

  let mcpServers = mergeMcpServers(settings, activeExtensions);
  const excludeTools = mergeExcludeTools(settings, activeExtensions);
  const blockedMcpServers: Array<{ name: string; extensionName: string }> = [];

  if (!argv.allowedMcpServerNames) {
    if (settings.allowMCPServers) {
      const allowedNames = new Set(settings.allowMCPServers.filter(Boolean));
      if (allowedNames.size > 0) {
        mcpServers = Object.fromEntries(
          Object.entries(mcpServers).filter(([key]) => allowedNames.has(key)),
        );
      }
    }

    if (settings.excludeMCPServers) {
      const excludedNames = new Set(settings.excludeMCPServers.filter(Boolean));
      if (excludedNames.size > 0) {
        mcpServers = Object.fromEntries(
          Object.entries(mcpServers).filter(([key]) => !excludedNames.has(key)),
        );
      }
    }
  }

  if (argv.allowedMcpServerNames) {
    const allowedNames = new Set(argv.allowedMcpServerNames.filter(Boolean));
    if (allowedNames.size > 0) {
      mcpServers = Object.fromEntries(
        Object.entries(mcpServers).filter(([key, server]) => {
          const isAllowed = allowedNames.has(key);
          if (!isAllowed) {
            blockedMcpServers.push({
              name: key,
              extensionName: server.extensionName || '',
            });
          }
          return isAllowed;
        }),
      );
    } else {
      blockedMcpServers.push(
        ...Object.entries(mcpServers).map(([key, server]) => ({
          name: key,
          extensionName: server.extensionName || '',
        })),
      );
      mcpServers = {};
    }
  }

  const sandboxConfig = await loadSandboxConfig(settings, argv);

  // 计算 memory token
  let memoryTokenCount = 0;
  try {
    const enc = getEncoding('cl100k_base');
    memoryTokenCount = enc.encode(memoryContent).length;
  } catch {
    memoryTokenCount = 0;
  }

  const config = new Config({
    sessionId,
    embeddingModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
    sandbox: sandboxConfig,
    targetDir: process.cwd(),
    debugMode,
    question: argv.promptInteractive || argv.prompt || '',
    feishuAutoStart: argv.feishu || false,
    fullContext: argv.allFiles || argv.all_files || false,
    coreTools: settings.coreTools || undefined,
    excludeTools,
    toolDiscoveryCommand: settings.toolDiscoveryCommand,
    toolCallCommand: settings.toolCallCommand,
    mcpServerCommand: settings.mcpServerCommand,
    mcpServers,
    userMemory: memoryContent,
    memoryTokenCount, // 新增
    geminiMdFileCount: fileCount,
    // ACP mode is agent-to-agent: there is no human to answer interactive
    // permission prompts in the calling process. We default to YOLO so
    // non-dangerous tools (edits, writes, MCP, generic shell) execute
    // without prompting. Genuinely dangerous operations (destructive shell
    // commands, `delete_file`, `ask_user_question`) still generate a
    // confirmation that the ACP runtime forwards to the caller agent via
    // `requestPermission`.
    approvalMode:
      argv.yolo || argv.acp || argv.experimentalAcp
        ? ApprovalMode.YOLO
        : ApprovalMode.DEFAULT,
    showMemoryUsage:
      argv.showMemoryUsage ||
      argv.show_memory_usage ||
      settings.showMemoryUsage ||
      false,
    accessibility: settings.accessibility,
    // 硬编码禁用所有遥测功能
    telemetry: {
      enabled: false,
      target: (argv.telemetryTarget ??
        settings.telemetry?.target) as TelemetryTarget,
      otlpEndpoint:
        argv.telemetryOtlpEndpoint ??
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
        settings.telemetry?.otlpEndpoint,
      logPrompts: false,
      outfile: argv.telemetryOutfile ?? settings.telemetry?.outfile,
    },
    // 硬编码禁用使用统计收集
    usageStatisticsEnabled: false,
    // Git-aware file filtering settings
    fileFiltering: {
      respectGitIgnore: settings.fileFiltering?.respectGitIgnore,
      respectGeminiIgnore: settings.fileFiltering?.respectGeminiIgnore,
      enableRecursiveFileSearch:
        settings.fileFiltering?.enableRecursiveFileSearch,
    },
    checkpointing: argv.checkpointing || settings.checkpointing?.enabled || process.env.ENABLE_CHECKPOINTING !== 'false',
    proxy:
      argv.proxy ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy,
    customProxyServerUrl: settings.customProxyServerUrl,
    cwd: process.cwd(),
    fileDiscoveryService: fileService,
    bugCommand: settings.bugCommand,
    model: argv.model! || settings.preferredModel,
    extensionContextFilePaths,
    maxSessionTurns: settings.maxSessionTurns ?? -1,
    experimentalAcp: argv.acp || argv.experimentalAcp || false,
    listExtensions: argv.listExtensions || false,
    listSessions: argv.listSessions || false,
    extensions: allExtensions,
    blockedMcpServers,
    noBrowser: !!process.env.NO_BROWSER,
    summarizeToolOutput: settings.summarizeToolOutput,
    cloudModels: settings.cloudModels,
    customModels: loadCustomModels(), // 从独立文件加载，避免与settings.json并发冲突
    ideMode,
    ideClient,
    silentMode: isNonInteractiveMode,
    hooks: settings.hooks,
    healthyUse: settings.healthyUse ?? true,
    preferredLanguage: settings.preferredLanguage,
  });

  // Set memory file paths for display in UI
  config.setOttoMdFilePaths(filePaths);

  return config;
}

function mergeMcpServers(settings: Settings, extensions: Extension[]) {
  const mcpServers = { ...(settings.mcpServers || {}) };
  for (const extension of extensions) {
    Object.entries(extension.config.mcpServers || {}).forEach(
      ([key, server]) => {
        if (mcpServers[key]) {
          logger.warn(
            `Skipping extension MCP config for server with key "${key}" as it already exists.`,
          );
          return;
        }

        // Replace ${extensionPath} in args and command
        const resolvedServer = { ...server };
        if (extension.path) {
          if (resolvedServer.args) {
            resolvedServer.args = resolvedServer.args.map((arg) =>
              arg.replace(/\$\{extensionPath\}/g, extension.path!),
            );
          }
          if (resolvedServer.command) {
            resolvedServer.command = resolvedServer.command.replace(
              /\$\{extensionPath\}/g,
              extension.path,
            );
          }
        }

        mcpServers[key] = {
          ...resolvedServer,
          extensionName: extension.config.name,
        };
      },
    );
  }
  return mcpServers;
}

function mergeExcludeTools(
  settings: Settings,
  extensions: Extension[],
): string[] {
  const allExcludeTools = new Set(settings.excludeTools || []);
  for (const extension of extensions) {
    for (const tool of extension.config.excludeTools || []) {
      allExcludeTools.add(tool);
    }
  }
  return [...allExcludeTools];
}
