/**
 * @license
 * Copyright 2025 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Slash Command Service for VSCode UI Plugin
 *
 * Loads custom slash commands from .toml files, sharing the same configuration
 * paths as the CLI (~/.otto/commands and <project>/.otto/commands).
 *
 * Also exposes a small set of **built-in** commands that mirror high-value
 * CLI counterparts (currently: /init, /compress).
 *
 * Built-in commands have two execution shapes:
 *   1. `prompt` — same as TOML commands: returns a processed prompt string,
 *     the webview then sends it to the AI as a normal user message.
 *   2. `side_effect` — the command performs a backend action (e.g. compress
 *     history) and the webview MUST NOT forward it to the AI. Side-effect
 *     commands carry a discriminator (`sideEffect: 'compress' | …`) which
 *     the webview switches on to dispatch the right local action.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as toml from '@iarna/toml';
import { glob } from 'glob';
import { getUserCommandsDirs, getProjectCommandsDirs } from 'otto-core';
import { Logger } from '../utils/logger';
import { INIT_COMMAND_PROMPT } from '../constants/initPrompt';

/**
 * Slash command info sent to webview (serializable)
 */
export interface SlashCommandInfo {
  /** Command name (e.g., 'git:commit', 'test') */
  name: string;
  /** Human-readable description */
  description: string;
  /** Command source: 'file' for custom commands, 'built-in' for hardcoded */
  kind: 'file' | 'built-in';
  /** The prompt template (TOML 命令直接是用户写的；built-in 'prompt' 命令是固定文本；side-effect 命令为空字符串) */
  prompt: string;
  /**
   * Built-in 命令的执行风格：
   *   - undefined / 'prompt'：和 TOML 命令一样，processCommandPrompt 返回字符串，
   *     webview 拿去当 user message 发给 AI。
   *   - 'side_effect'：调用方应当走副作用分支（不发 AI），由 sideEffect 字段
   *     指明执行哪种动作。
   */
  execution?: 'prompt' | 'side_effect';
  /** 副作用类型（execution === 'side_effect' 时必填） */
  sideEffect?: 'compress';
  /** 命令别名（webview 在 fuzzy 匹配 / 输入解析时会兼容这些别名） */
  altNames?: string[];
}

/**
 * TOML command definition schema
 */
interface TomlCommandDef {
  prompt: string;
  description?: string;
}

/**
 * Placeholder for shorthand argument injection
 */
const SHORTHAND_ARGS_PLACEHOLDER = '{{args}}';

/**
 * 内置命令清单。**故意**和 CLI `packages/cli/src/ui/commands/*.ts` 保持
 * 字段语义一致：name / altNames / description 都从 CLI 复制过来，让用户
 * 在两端体验一致。
 *
 * 现仅注册 /init 与 /compress 两个最高频的命令；后续如需移植 /clear /memory
 * 等命令，只需在这里追加新条目并在 setupSlashCommandHandlers 中扩展副作用
 * 分支即可。
 */
const BUILT_IN_COMMANDS: SlashCommandInfo[] = [
  {
    name: 'init',
    description: 'Analyze the current workspace and create a OTTO.md project context file',
    kind: 'built-in',
    execution: 'prompt',
    prompt: INIT_COMMAND_PROMPT,
  },
  {
    name: 'compress',
    altNames: ['summarize', 'compact'],
    description: 'Manually compress the conversation history to free up context (calls tryCompressChat)',
    kind: 'built-in',
    execution: 'side_effect',
    sideEffect: 'compress',
    // side-effect 命令不会被作为 prompt 发送，但保留一段说明文本，
    // 以便万一调用方误用 processCommandPrompt 时仍有合理 fallback。
    prompt: '[Built-in /compress invoked]',
  },
];

/**
 * Service for managing custom slash commands in VSCode
 */
export class SlashCommandService {
  private commands: Map<string, SlashCommandInfo> = new Map();
  private initialized = false;

  constructor(private readonly logger: Logger) {}

  /**
   * Initialize and load all commands
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await this.loadCommands();
      this.initialized = true;
      this.logger.info(`[SlashCommandService] Loaded ${this.commands.size} custom commands`);
    } catch (error) {
      this.logger.error('[SlashCommandService] Failed to initialize', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Reload all commands (useful when files change)
   */
  async reload(): Promise<void> {
    this.commands.clear();
    this.initialized = false;
    await this.initialize();
  }

  /**
   * Get all available commands
   */
  getCommands(): SlashCommandInfo[] {
    return Array.from(this.commands.values());
  }

  /**
   * Get a specific command by name. 同时匹配主名 + altNames（CLI 行为对齐）。
   */
  getCommand(name: string): SlashCommandInfo | undefined {
    if (!name) return undefined;
    // 直接命中主名（最常见路径）
    const direct = this.commands.get(name);
    if (direct) return direct;
    // 退化：扫一次 altNames 命中（命令数量很少，O(n) 完全可接受）
    for (const cmd of this.commands.values()) {
      if (cmd.altNames && cmd.altNames.includes(name)) {
        return cmd;
      }
    }
    return undefined;
  }

  /**
   * Process a command's prompt with given arguments
   * @param command The command to execute
   * @param args User-provided arguments
   * @returns Processed prompt ready for AI
   */
  processCommandPrompt(command: SlashCommandInfo, args: string): string {
    let prompt = command.prompt;

    // Handle {{args}} placeholder (shorthand mode)
    if (prompt.includes(SHORTHAND_ARGS_PLACEHOLDER)) {
      prompt = prompt.split(SHORTHAND_ARGS_PLACEHOLDER).join(args);
    } else if (args.trim()) {
      // Default mode: append raw input to prompt
      prompt = `${prompt}\n\n/${command.name} ${args}`;
    }

    return prompt;
  }

  /**
   * Load commands from both user and project directories
   *
   * 加载顺序（后者覆盖前者）：
   *   1) Built-in 命令（/init, /compress …）
   *   2) 用户级 TOML 命令
   *   3) 项目级 TOML 命令
   *
   * 用户的 TOML 命令可以覆盖 built-in（比如想给 /compress 自定义行为），
   * 这与 CLI 的命令解析优先级保持一致。
   */
  private async loadCommands(): Promise<void> {
    // 1) 先注册 built-in 命令
    for (const cmd of BUILT_IN_COMMANDS) {
      this.commands.set(cmd.name, cmd);
    }

    const globOptions = {
      nodir: true,
      dot: true,
    };

    // Load user-level commands (~/.otto/commands and ~/.gemini/commands)
    for (const userDir of getUserCommandsDirs()) {
      await this.loadCommandsFromDir(userDir, globOptions);
    }

    // Load project-level commands (project/.otto/commands and project/.gemini/commands)
    // Project commands override user commands with the same name
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      this.logger.info(`[SlashCommandService] Found ${workspaceFolders.length} workspace folders`);
      for (const folder of workspaceFolders) {
        const workspaceRoot = folder.uri.fsPath;
        const projectDirs = getProjectCommandsDirs(workspaceRoot);
        this.logger.info(`[SlashCommandService] Checking project command dirs for ${workspaceRoot}: ${projectDirs.join(', ')}`);
        for (const projectDir of projectDirs) {
          await this.loadCommandsFromDir(projectDir, globOptions);
        }
      }
    } else {
      this.logger.info('[SlashCommandService] No workspace folders found');
    }
  }

  /**
   * Load commands from a specific directory
   */
  private async loadCommandsFromDir(
    baseDir: string,
    globOptions: { nodir: boolean; dot: boolean }
  ): Promise<void> {
    try {
      // Check if directory exists
      await fs.access(baseDir);

      const files = await glob('**/*.toml', {
        ...globOptions,
        cwd: baseDir,
      });

      this.logger.info(`[SlashCommandService] Found ${files.length} command files in ${baseDir}`);

      for (const file of files) {
        const filePath = path.join(baseDir, file);
        const command = await this.parseTomlFile(filePath, baseDir);
        if (command) {
          this.commands.set(command.name, command);
        }
      }
    } catch (error) {
      // Directory doesn't exist or not accessible - that's fine
      this.logger.debug(`[SlashCommandService] Directory not accessible or error reading: ${baseDir}. Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Parse a single .toml file into a SlashCommandInfo
   */
  private async parseTomlFile(
    filePath: string,
    baseDir: string
  ): Promise<SlashCommandInfo | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = toml.parse(content) as unknown as TomlCommandDef;

      // Validate required fields
      if (!parsed.prompt || typeof parsed.prompt !== 'string') {
        this.logger.warn(`[SlashCommandService] Invalid command file (missing prompt): ${filePath}`);
        return null;
      }

      // Calculate command name from file path
      // e.g., 'git/commit.toml' -> 'git:commit'
      const relativePathWithExt = path.relative(baseDir, filePath);
      const relativePath = relativePathWithExt.substring(
        0,
        relativePathWithExt.length - 5 // remove '.toml'
      );

      // Normalize to forward slashes for consistent name splitting across platforms
      const normalizedPath = relativePath.replace(/\\/g, '/');
      const commandName = normalizedPath
        .split('/')
        .map((segment) => segment.split(':').join('_'))
        .join(':');

      return {
        name: commandName,
        description: parsed.description || `Custom command from ${path.basename(filePath)}`,
        kind: 'file',
        prompt: parsed.prompt,
      };
    } catch (error) {
      this.logger.error(
        `[SlashCommandService] Failed to parse ${filePath}`,
        error instanceof Error ? error : undefined
      );
      return null;
    }
  }
}
