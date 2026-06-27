/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseTool, Icon, ToolResult } from './tools.js';
import { FunctionDeclaration, Type } from '@google/genai';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { glob } from 'glob';
import { Config } from '../config/config.js';

const memoryToolSchemaData: FunctionDeclaration = {
  name: 'save_memory',
  description:
    'Saves a specific piece of information or fact to your long-term memory. Use this when the user explicitly asks you to remember something, or when they state a clear, concise fact that seems important to retain for future interactions.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      fact: {
        type: Type.STRING,
        description:
          'The specific fact or piece of information to remember. Should be a clear, self-contained statement.',
      },
    },
    required: ['fact'],
  },
};

const memoryToolDescription = `
Saves a specific piece of information or fact to your long-term memory.

Use this tool:

- When the user explicitly asks you to remember something (e.g., "Remember that I like pineapple on pizza", "Please save this: my cat's name is Whiskers").
- When the user states a clear, concise fact about themselves, their preferences, or their environment that seems important for you to retain for future interactions to provide a more personalized and effective assistance.

Do NOT use this tool:

- To remember conversational context that is only relevant for the current session.
- To save long, complex, or rambling pieces of text. The fact should be relatively short and to the point.
- If you are unsure whether the information is a fact worth remembering long-term. If in doubt, you can ask the user, "Should I remember that for you?"

## Parameters

- \`fact\` (string, required): The specific fact or piece of information to remember. This should be a clear, self-contained statement. For example, if the user says "My favorite color is blue", the fact would be "My favorite color is blue".
`;

export const OTTO_CONFIG_DIR = '.otto-user';
export const DEFAULT_CONTEXT_FILENAME = 'OTTO.md';
export const MEMORY_SECTION_HEADER = '## Otto Added Memories';

/**
 * 单个记忆文件的写入上限(字节)。超过则不再追加新事实并 warn,
 * 防止 append-only 记忆无限膨胀拖垮每次 prompt 的 token 成本与资源。
 */
export const MAX_MEMORY_FILE_SIZE = 256 * 1024; // 256KB

/**
 * Otto 只认自己的上下文文件 OTTO.md。
 * 早期版本还认 AGENTS.md / .cursor / .augement——但 AGENTS.md 是 clawd、codex
 * 等其它工具的通用约定文件,会被向上/全局扫描当成"Otto 的记忆"加载进来,
 * 造成跨工具串味(读到 ~/clawd 、~/.codex 下别人的记忆)。这里收紧为单一来源。
 * 需要兼容 AGENTS.md 的项目可通过 settings 的 contextFileName 显式配置。
 */
export const DEFAULT_CONTEXT_FILENAMES = [
  'OTTO.md',
];

// This variable will hold the currently configured filename for context files.
// It defaults to DEFAULT_CONTEXT_FILENAME but can be overridden by setOttoMdFilename.
let currentGeminiMdFilename: string | string[] = DEFAULT_CONTEXT_FILENAME;

export function setOttoMdFilename(newFilename: string | string[]): void {
  if (Array.isArray(newFilename)) {
    if (newFilename.length > 0) {
      currentGeminiMdFilename = newFilename.map((name) => name.trim());
    }
  } else if (newFilename && newFilename.trim() !== '') {
    currentGeminiMdFilename = newFilename.trim();
  }
}

export function getCurrentGeminiMdFilename(): string {
  if (Array.isArray(currentGeminiMdFilename)) {
    return currentGeminiMdFilename[0];
  }
  return currentGeminiMdFilename;
}

export function getAllGeminiMdFilenames(): string[] {
  if (Array.isArray(currentGeminiMdFilename)) {
    return currentGeminiMdFilename;
  }
  return [currentGeminiMdFilename];
}

/**
 * Discovers context files based on priority order in the specified directory.
 * This is used when the filename is not explicitly set and we want to find
 * the highest priority existing configuration file.
 */
export async function discoverContextFilenames(baseDir: string = path.join(homedir(), OTTO_CONFIG_DIR)): Promise<string[]> {
  const foundFiles = await findContextFilesInDirectory(baseDir, DEFAULT_CONTEXT_FILENAMES);

  if (foundFiles.length > 0) {
    return [path.basename(foundFiles[0])];
  }

  return [DEFAULT_CONTEXT_FILENAME];
}

/**
 * Common directories to ignore when searching for context files
 */
export const COMMON_IGNORE_PATTERNS = [
  // Node.js
  'node_modules/**',
  // Python
  '__pycache__/**',
  '.venv/**',
  'venv/**',
  'env/**',
  '.env/**',
  'site-packages/**',
  // Java
  'target/**',
  '.gradle/**',
  'build/**',
  // .NET
  'bin/**',
  'obj/**',
  // Go
  'vendor/**',
  // Rust
  'target/**',
  // Build outputs
  'dist/**',
  'out/**',
  'output/**',
  'build/**',
  '.next/**',
  '.nuxt/**',
  // Version control
  '.git/**',
  '.svn/**',
  '.hg/**',
  // IDEs
  '.vscode/**',
  '.idea/**',
  '.vs/**',
  // OS
  '.DS_Store',
  'Thumbs.db',
  // Logs
  'logs/**',
  '*.log',
  // Cache
  '.cache/**',
  '.tmp/**',
  'tmp/**',
  'temp/**',
];

/**
 * Finds context files in a directory based on priority patterns.
 */
async function findContextFilesInDirectory(baseDir: string, filePatterns: string[]): Promise<string[]> {
  const foundFiles: string[] = [];

  try {
    // Ensure directory exists
    await fs.mkdir(baseDir, { recursive: true });
  } catch (error) {
    console.warn(`Warning: failed to create directory ${baseDir}: ${error}`);
    return [];
  }

  for (const pattern of filePatterns) {
    if (pattern.includes('*')) {
      // Handle glob patterns
      try {
        const fullPattern = path.join(baseDir, pattern);
        const matches = await glob(fullPattern, {
          cwd: baseDir,
          absolute: true,
          nodir: true,
          ignore: COMMON_IGNORE_PATTERNS
        });
        if (matches.length > 0) {
          foundFiles.push(...matches);
          break; // Use first pattern that has matches
        }
      } catch (error) {
        console.warn(`Warning: failed to glob pattern ${pattern} in ${baseDir}: ${error}`);
      }
    } else {
      // Handle direct file paths
      const filePath = path.join(baseDir, pattern);

      // Check if the file path matches any ignore patterns
      const relativePath = path.relative(baseDir, filePath);
      const shouldIgnore = COMMON_IGNORE_PATTERNS.some(ignorePattern => {
        // Remove /** suffix for directory matching
        const cleanPattern = ignorePattern.replace('/**', '');
        return relativePath.startsWith(cleanPattern) ||
               relativePath.includes(`/${cleanPattern}/`) ||
               relativePath.includes(`\\${cleanPattern}\\`);
      });

      if (shouldIgnore) {
        continue; // Skip this file
      }

      try {
        await fs.access(filePath);
        foundFiles.push(filePath);
        break; // Use first existing file
      } catch {
        // File doesn't exist, continue to next pattern
      }
    }
  }

  return foundFiles;
}

interface SaveMemoryParams {
  fact: string;
}

/**
 * Discovers context files in the current working directory (project directory)
 */
async function discoverProjectContextFilenames(projectDir: string = process.cwd()): Promise<string[]> {
  // Check if the project directory itself should be ignored
  const shouldIgnoreProjectDir = COMMON_IGNORE_PATTERNS.some(ignorePattern => {
    const cleanPattern = ignorePattern.replace('/**', '');
    return projectDir.includes(`/${cleanPattern}/`) ||
           projectDir.includes(`\\${cleanPattern}\\`) ||
           projectDir.endsWith(`/${cleanPattern}`) ||
           projectDir.endsWith(`\\${cleanPattern}`);
  });

  if (shouldIgnoreProjectDir) {
    return []; // Don't search in ignored directories
  }

  const foundFiles = await findContextFilesInDirectory(projectDir, DEFAULT_CONTEXT_FILENAMES);

  if (foundFiles.length > 0) {
    return [path.basename(foundFiles[0])];
  }

  return [];
}

async function getProjectMemoryFilePath(config: Config): Promise<string> {
  // Always use project root directory OTTO.md for memory storage
  return path.join(config.getProjectRoot(), 'OTTO.md');
}

/** 记忆根目录(~/.otto-user/memory),三层记忆(global/session)共用根。 */
export const MEMORY_ROOT_DIR = path.join(homedir(), OTTO_CONFIG_DIR, 'memory');

/** 飞书按会话隔离的个人记忆目录(每个 chat 一个文件,避免跨会话/跨用户串味)。 */
export const FEISHU_SESSION_MEMORY_DIR = path.join(MEMORY_ROOT_DIR, 'sessions');

/**
 * 全局(跨项目、跨会话)记忆文件:~/.otto-user/memory/global.md。
 * 用于沉淀用户级偏好/习惯,与项目级 OTTO.md、会话级 sessions/<id>.md 三层并存。
 */
export const GLOBAL_MEMORY_FILE = path.join(MEMORY_ROOT_DIR, 'global.md');

/** 全局记忆文件的绝对路径(供分层记忆 Provider 使用)。 */
export function getGlobalMemoryPath(): string {
  return GLOBAL_MEMORY_FILE;
}

/** 按飞书 chatId 解析其专属记忆文件路径(文件名净化,防路径穿越)。 */
export function getFeishuSessionMemoryPath(chatId: string): string {
  const safe = (chatId || 'unknown')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
  return path.join(FEISHU_SESSION_MEMORY_DIR, `${safe}.md`);
}

/**
 * Ensures proper newline separation before appending content.
 */
function ensureNewlineSeparation(currentContent: string): string {
  if (currentContent.length === 0) return '';
  if (currentContent.endsWith('\n\n') || currentContent.endsWith('\r\n\r\n'))
    return '';
  if (currentContent.endsWith('\n') || currentContent.endsWith('\r\n'))
    return '\n';
  return '\n\n';
}

export class MemoryTool extends BaseTool<SaveMemoryParams, ToolResult> {
  static readonly Name: string = memoryToolSchemaData.name!;
  constructor(private readonly config: Config) {
    super(
      MemoryTool.Name,
      'Save Memory',
      memoryToolDescription,
      Icon.LightBulb,
      memoryToolSchemaData.parameters as Record<string, unknown>,
    );
  }

  static async performAddMemoryEntry(
    text: string,
    memoryFilePath: string,
    fsAdapter: {
      readFile: (path: string, encoding: 'utf-8') => Promise<string>;
      writeFile: (
        path: string,
        data: string,
        encoding: 'utf-8',
      ) => Promise<void>;
      mkdir: (
        path: string,
        options: { recursive: boolean },
      ) => Promise<string | undefined>;
    },
  ): Promise<void> {
    let processedText = text.trim();
    // Remove leading hyphens and spaces that might be misinterpreted as markdown list items
    processedText = processedText.replace(/^(-+\s*)+/, '').trim();
    const newMemoryItem = `- ${processedText}`;

    // 正确性:按文件串行化 read-modify-write,防止并发(最多 6 个 Sub-Agent +
    // 异步飞书消息分发)同时写同一记忆文件 → "后写覆盖先写、事实丢失"。
    const prev =
      MemoryTool.memoryWriteChains.get(memoryFilePath) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() =>
        MemoryTool.writeMemoryEntryLocked(
          memoryFilePath,
          newMemoryItem,
          fsAdapter,
        ),
      );
    MemoryTool.memoryWriteChains.set(memoryFilePath, run);
    try {
      await run;
    } finally {
      if (MemoryTool.memoryWriteChains.get(memoryFilePath) === run) {
        MemoryTool.memoryWriteChains.delete(memoryFilePath);
      }
    }
  }

  /** 按文件串行化的记忆写入链(进程内 mutex,消除并发丢更新)。 */
  private static memoryWriteChains = new Map<string, Promise<void>>();

  /** 记忆写入临界区:read-modify-write,由 memoryWriteChains 保证同文件串行。 */
  private static async writeMemoryEntryLocked(
    memoryFilePath: string,
    newMemoryItem: string,
    fsAdapter: {
      readFile: (path: string, encoding: 'utf-8') => Promise<string>;
      writeFile: (
        path: string,
        data: string,
        encoding: 'utf-8',
      ) => Promise<void>;
      mkdir: (
        path: string,
        options: { recursive: boolean },
      ) => Promise<string | undefined>;
    },
  ): Promise<void> {
    try {
      await fsAdapter.mkdir(path.dirname(memoryFilePath), { recursive: true });
      let content = '';
      try {
        content = await fsAdapter.readFile(memoryFilePath, 'utf-8');
      } catch (_e) {
        // File doesn't exist, will be created with header and item.
      }

      // 去重:同一条事实(去掉 "- " 前缀后的纯文本)已存在则跳过,
      // 避免重复事实灌满记忆文件。在临界区内做,保证读到的是最新内容。
      const factText = newMemoryItem.replace(/^-\s*/, '').trim();
      if (factText.length > 0 && content.includes(factText)) {
        return; // 已记录过该事实,幂等跳过
      }

      // 大小上限:超过 MAX_MEMORY_FILE_SIZE 则不再追加,防止记忆无限膨胀。
      if (Buffer.byteLength(content, 'utf-8') >= MAX_MEMORY_FILE_SIZE) {
        console.warn(
          `[MemoryTool] Memory file ${memoryFilePath} has reached the size limit (${MAX_MEMORY_FILE_SIZE} bytes); skipping new memory entry.`,
        );
        return;
      }

      const headerIndex = content.indexOf(MEMORY_SECTION_HEADER);

      if (headerIndex === -1) {
        // Header not found, append header and then the entry
        const separator = ensureNewlineSeparation(content);
        content += `${separator}${MEMORY_SECTION_HEADER}\n${newMemoryItem}\n`;
      } else {
        // Header found, find where to insert the new memory entry
        const startOfSectionContent =
          headerIndex + MEMORY_SECTION_HEADER.length;
        let endOfSectionIndex = content.indexOf('\n## ', startOfSectionContent);
        if (endOfSectionIndex === -1) {
          endOfSectionIndex = content.length; // End of file
        }

        const beforeSectionMarker = content
          .substring(0, startOfSectionContent)
          .trimEnd();
        let sectionContent = content
          .substring(startOfSectionContent, endOfSectionIndex)
          .trimEnd();
        const afterSectionMarker = content.substring(endOfSectionIndex);

        sectionContent += `\n${newMemoryItem}`;
        content =
          `${beforeSectionMarker}\n${sectionContent.trimStart()}\n${afterSectionMarker}`.trimEnd() +
          '\n';
      }
      await fsAdapter.writeFile(memoryFilePath, content, 'utf-8');
    } catch (error) {
      console.error(
        `[MemoryTool] Error adding memory entry to ${memoryFilePath}:`,
        error,
      );
      throw new Error(
        `[MemoryTool] Failed to add memory entry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async execute(
    params: SaveMemoryParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const { fact } = params;

    if (!fact || typeof fact !== 'string' || fact.trim() === '') {
      const errorMessage = 'Parameter "fact" must be a non-empty string.';
      return {
        llmContent: JSON.stringify({ success: false, error: errorMessage }),
        returnDisplay: `Error: ${errorMessage}`,
      };
    }

    try {
      // Use the static method with actual fs promises
      // 飞书会话:若 config 指定了按会话隔离的记忆文件,存到该文件(每 chat 独立);
      // 否则沿用项目级 OTTO.md(向后兼容)。
      const sessionFile = this.config.getFeishuSessionMemoryFile?.();
      const memoryFilePath =
        sessionFile || (await getProjectMemoryFilePath(this.config));
      await MemoryTool.performAddMemoryEntry(fact, memoryFilePath, {
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        mkdir: fs.mkdir,
      });
      const successMessage = `Okay, I've remembered that: "${fact}"`;
      return {
        llmContent: JSON.stringify({ success: true, message: successMessage }),
        returnDisplay: successMessage,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[MemoryTool] Error executing save_memory for fact "${fact}": ${errorMessage}`,
      );
      return {
        llmContent: JSON.stringify({
          success: false,
          error: `Failed to save memory. Detail: ${errorMessage}`,
        }),
        returnDisplay: `Error saving memory: ${errorMessage}`,
      };
    }
  }
}
