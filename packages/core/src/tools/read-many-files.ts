/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseTool, Icon, ToolResult } from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';
import * as path from 'path';
import * as fs from 'fs';
import { glob } from 'glob';
import { getCurrentGeminiMdFilename } from './memoryTool.js';
import {
  detectFileType,
  processSingleFileContent,
  DEFAULT_ENCODING,
  getSpecificMimeType,
} from '../utils/fileUtils.js';
import { PartListUnion, Schema, Type } from '@google/genai';
import { Config, DEFAULT_FILE_FILTERING_OPTIONS } from '../config/config.js';
import {
  recordFileOperationMetric,
  FileOperation,
} from '../telemetry/metrics.js';
import { PROJECT_CONFIG_DIR_NAME, ProjectSettingsManager } from '../config/projectSettings.js';
import { isClipboardPath } from '../utils/pathUtils.js';

/**
 * Parameters for the ReadManyFilesTool.
 */
export interface ReadManyFilesParams {
  /**
   * An array of file paths or directory paths to search within.
   * Paths are relative to the tool's configured target directory.
   * Glob patterns can be used directly in these paths.
   */
  paths: string[];

  /**
   * Optional. Glob patterns for files to include.
   * These are effectively combined with the `paths`.
   * Example: ["*.ts", "src/** /*.md"]
   */
  include?: string[];

  /**
   * Optional. Glob patterns for files/directories to exclude.
   * Applied as ignore patterns.
   * Example: ["*.log", "dist/**"]
   */
  exclude?: string[];

  /**
   * Optional. Search directories recursively.
   * This is generally controlled by glob patterns (e.g., `**`).
   * The glob implementation is recursive by default for `**`.
   * For simplicity, we'll rely on `**` for recursion.
   */
  recursive?: boolean;

  /**
   * Optional. Apply default exclusion patterns. Defaults to true.
   */
  useDefaultExcludes?: boolean;

  /**
   * Whether to respect .gitignore and .geminiignore patterns (optional, defaults to true)
   */
  file_filtering_options?: {
    respect_git_ignore?: boolean;
    respect_gemini_ignore?: boolean;
  };

  /**
   * Optional. Allow local execution that bypasses workspace directory restrictions.
   * When true, files outside the configured target directory can be accessed.
   * WARNING: This should only be used in trusted local environments as it can access any file on the system.
   * Defaults to false for security.
   */
  allowLocalExecution?: boolean;
}

/**
 * Default exclusion patterns for commonly ignored directories and binary file types.
 * These are compatible with glob ignore patterns.
 * TODO(adh): Consider making this configurable or extendable through a command line argument.
 * TODO(adh): Look into sharing this list with the glob tool.
 */
const DEFAULT_EXCLUDES: string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.vscode/**',
  '**/.idea/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/*.pyc',
  '**/*.pyo',
  '**/*.bin',
  '**/*.exe',
  '**/*.dll',
  '**/*.so',
  '**/*.dylib',
  '**/*.class',
  '**/*.jar',
  '**/*.war',
  '**/*.zip',
  '**/*.tar',
  '**/*.gz',
  '**/*.bz2',
  '**/*.rar',
  '**/*.7z',
  '**/*.ppt',
  '**/*.pptx',
  '**/*.odt',
  '**/*.ods',
  '**/*.odp',
  '**/*.DS_Store',
  '**/.env',
  `**/${getCurrentGeminiMdFilename()}`,
];

const DEFAULT_OUTPUT_SEPARATOR_FORMAT = '--- {filePath} ---';

/**
 * Tool implementation for finding and reading multiple text files from the local filesystem
 * within a specified target directory. The content is concatenated.
 * It is intended to run in an environment with access to the local file system (e.g., a Node.js backend).
 */
export class ReadManyFilesTool extends BaseTool<
  ReadManyFilesParams,
  ToolResult
> {
  static readonly Name: string = 'read_many_files';

  constructor(private config: Config) {
    const parameterSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        paths: {
          type: Type.ARRAY,
          items: {
            type: Type.STRING,
            minLength: '1',
          },
          minItems: '1',
          description:
            "Required. An array of glob patterns or paths relative to the tool's target directory. Examples: ['src/**/*.ts'], ['README.md', 'docs/']",
        },
        include: {
          type: Type.ARRAY,
          items: {
            type: Type.STRING,
            minLength: '1',
          },
          description:
            'Optional. Additional glob patterns to include. These are merged with `paths`. Example: ["*.test.ts"] to specifically add test files if they were broadly excluded.',
          default: [],
        },
        exclude: {
          type: Type.ARRAY,
          items: {
            type: Type.STRING,
            minLength: '1',
          },
          description:
            'Optional. Glob patterns for files/directories to exclude. Added to default excludes if useDefaultExcludes is true. Example: ["**/*.log", "temp/"]',
          default: [],
        },
        recursive: {
          type: Type.BOOLEAN,
          description:
            'Optional. Whether to search recursively (primarily controlled by `**` in glob patterns). Defaults to true.',
          default: true,
        },
        useDefaultExcludes: {
          type: Type.BOOLEAN,
          description:
            'Optional. Whether to apply a list of default exclusion patterns (e.g., node_modules, .git, binary files). Defaults to true.',
          default: true,
        },
        file_filtering_options: {
          description:
            'Whether to respect ignore patterns from .gitignore or .geminiignore',
          type: Type.OBJECT,
          properties: {
            respect_git_ignore: {
              description:
                'Optional: Whether to respect .gitignore patterns when listing files. Only available in git repositories. Defaults to true.',
              type: Type.BOOLEAN,
            },
            respect_gemini_ignore: {
              description:
                'Optional: Whether to respect .geminiignore patterns when listing files. Defaults to true.',
              type: Type.BOOLEAN,
            },
          },
        },
        allowLocalExecution: {
          type: Type.BOOLEAN,
          description:
            'Optional. Allow reading files outside the workspace directory. Use with caution as this can access any file on the system. Defaults to false for security.',
          default: false,
        },
      },
      required: ['paths'],
    };

    super(
      ReadManyFilesTool.Name,
      'ReadManyFiles',
      `Reads content from multiple files or single files, including external files outside the workspace. Supports both relative paths (within workspace) and absolute paths (anywhere on system). For text files, it concatenates their content into a single string. Handles text files, images, PDFs, Excel, and Word documents.

IMPORTANT: This is the PREFERRED tool for:
- Reading files outside the workspace directory (external files with absolute paths)
- Reading PDF files from any location
- Processing single files when they are outside the workspace
- Reading multiple files at once

This tool automatically enables external file access when absolute paths are detected. For text files, it uses UTF-8 encoding and '--- {filePath} ---' separator between file contents. Supports glob patterns like 'src/**/*.js' for workspace files and direct absolute paths like 'C:\\external\\file.pdf' for external files.`,
      Icon.FileSearch,
      parameterSchema,
    );
  }

  validateParams(params: ReadManyFilesParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params, ReadManyFilesTool.Name);
    if (errors) {
      return errors;
    }
    return null;
  }

  getDescription(params: ReadManyFilesParams): string {
    const allPatterns = [...params.paths, ...(params.include || [])];
    const pathDesc = `using patterns: \`${allPatterns.join('`, `')}\` (within target directory: \`${this.config.getTargetDir()}\`)`;

    // Determine the final list of exclusion patterns exactly as in execute method
    const paramExcludes = params.exclude || [];
    const paramUseDefaultExcludes = params.useDefaultExcludes !== false;
    const geminiIgnorePatterns = this.config
      .getFileService()
      .getGeminiIgnorePatterns();
    const finalExclusionPatternsForDescription: string[] =
      paramUseDefaultExcludes
        ? [...DEFAULT_EXCLUDES, ...paramExcludes, ...geminiIgnorePatterns]
        : [...paramExcludes, ...geminiIgnorePatterns];

    let excludeDesc = `Excluding: ${finalExclusionPatternsForDescription.length > 0 ? `patterns like \`${finalExclusionPatternsForDescription.slice(0, 2).join('`, `')}${finalExclusionPatternsForDescription.length > 2 ? '...`' : '`'}` : 'none specified'}`;

    // Add a note if .geminiignore patterns contributed to the final list of exclusions
    if (geminiIgnorePatterns.length > 0) {
      const geminiPatternsInEffect = geminiIgnorePatterns.filter((p) =>
        finalExclusionPatternsForDescription.includes(p),
      ).length;
      if (geminiPatternsInEffect > 0) {
        excludeDesc += ` (includes ${geminiPatternsInEffect} from .geminiignore)`;
      }
    }

    return `Will attempt to read and concatenate files ${pathDesc}. ${excludeDesc}. File encoding: ${DEFAULT_ENCODING}. Separator: "${DEFAULT_OUTPUT_SEPARATOR_FORMAT.replace('{filePath}', 'path/to/file.ext')}".`;
  }

  async execute(
    params: ReadManyFilesParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters for ${this.displayName}. Reason: ${validationError}`,
        returnDisplay: `## Parameter Error\n\n${validationError}`,
      };
    }

    const {
      paths: inputPatterns,
      include = [],
      exclude = [],
      useDefaultExcludes = true,
      allowLocalExecution = false,
    } = params;

    // Smart external path detection: If any path is absolute and outside target dir,
    // automatically enable external execution for better user experience
    const allPaths = [...inputPatterns, ...include];
    const hasExternalPaths = allPaths.some(pattern => {
      // Check if pattern is an absolute path outside target directory
      if (path.isAbsolute(pattern)) {
        try {
          const resolvedPattern = path.resolve(pattern);
          const targetDir = this.config.getTargetDir();
          return !resolvedPattern.startsWith(targetDir);
        } catch {
          return false;
        }
      }
      return false;
    });

    // Enable external execution if external paths detected, unless explicitly disabled
    const effectiveAllowLocalExecution = allowLocalExecution || hasExternalPaths;

    const defaultFileIgnores =
      this.config.getFileFilteringOptions() ?? DEFAULT_FILE_FILTERING_OPTIONS;

    const fileFilteringOptions = {
      respectGitIgnore:
        params.file_filtering_options?.respect_git_ignore ??
        defaultFileIgnores.respectGitIgnore, // Use the property from the returned object
      respectGeminiIgnore:
        params.file_filtering_options?.respect_gemini_ignore ??
        defaultFileIgnores.respectGeminiIgnore, // Use the property from the returned object
    };
    // Get centralized file discovery service
    const fileDiscovery = this.config.getFileService();

    const filesToConsider = new Set<string>();
    const skippedFiles: Array<{ path: string; reason: string }> = [];
    const processedFilesRelativePaths: string[] = [];
    const processedFilesAbsolutePaths: string[] = []; // 🎯 新增：跟踪已处理文件的绝对路径，用于计算实际文件大小
    const contentParts: PartListUnion = []; // 🎯 修复：使用正确的类型来支持混合内容（文本+图片+PDF）

    const effectiveExcludes = useDefaultExcludes
      ? [...DEFAULT_EXCLUDES, ...exclude]
      : [...exclude];

    const searchPatterns = [...inputPatterns, ...include];
    if (searchPatterns.length === 0) {
      return {
        llmContent: 'No search paths or include patterns provided.',
        returnDisplay: `## Information\n\nNo search paths or include patterns were specified. Nothing to read or concatenate.`,
      };
    }

    try {
      const entries = await glob(
        searchPatterns.map((p) => p.replace(/\\/g, '/')),
        {
          cwd: this.config.getTargetDir(),
          ignore: effectiveExcludes,
          nodir: true,
          dot: true,
          absolute: true,
          nocase: true,
          signal,
        },
      );

      const gitFilteredEntries = fileFilteringOptions.respectGitIgnore
        ? (() => {
            const targetDir = this.config.getTargetDir();
            // Get the config dir name for clipboard path checking

            const relativePaths = entries.map((p) => path.relative(targetDir, p));

            // Filter files through git ignore rules
            const gitFiltered = fileDiscovery.filterFiles(relativePaths, {
              respectGitIgnore: true,
              respectGeminiIgnore: false,
            });

            // Re-add clipboard files that might have been filtered out by git ignore
            const gitFilteredSet = new Set(gitFiltered);
            for (const relativePath of relativePaths) {
              if (!gitFilteredSet.has(relativePath) && isClipboardPath(relativePath, targetDir, PROJECT_CONFIG_DIR_NAME)) {
                gitFiltered.push(relativePath);
              }
            }

            return gitFiltered.map((p) => path.resolve(targetDir, p));
          })()
        : entries;

      // Apply gemini ignore filtering if enabled
      const finalFilteredEntries = fileFilteringOptions.respectGeminiIgnore
        ? fileDiscovery
            .filterFiles(
              gitFilteredEntries.map((p) =>
                path.relative(this.config.getTargetDir(), p),
              ),
              {
                respectGitIgnore: false,
                respectGeminiIgnore: true,
              },
            )
            .map((p) => path.resolve(this.config.getTargetDir(), p))
        : gitFilteredEntries;

      // 🎯 Fix: Create normalized path sets for case-insensitive comparison on Windows
      // On Windows, path.resolve() can return different casing even for the same file
      const normalizePath = (filePath: string): string => {
        const resolved = path.resolve(filePath);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      };

      const gitFilteredSet = new Set(gitFilteredEntries.map(normalizePath));
      const geminiFilteredSet = new Set(finalFilteredEntries.map(normalizePath));

      let gitIgnoredCount = 0;
      let geminiIgnoredCount = 0;

      for (const absoluteFilePath of entries) {
        // Security check: ensure the glob library didn't return something outside targetDir.
        // Skip this check if external execution is allowed
        if (!effectiveAllowLocalExecution) {
          const relativePathCheck = path.relative(this.config.getTargetDir(), absoluteFilePath);
          // Check if path is outside (starts with .. and separator, or is just .., or is absolute/different drive)
          // This handles case sensitivity differences on Windows (e.g. d: vs D:) correctly
          const isOutside = relativePathCheck === '..' ||
                           relativePathCheck.startsWith(`..${path.sep}`) ||
                           path.isAbsolute(relativePathCheck);

          if (isOutside) {
            skippedFiles.push({
              path: absoluteFilePath,
              reason: `Security: Glob library returned path outside target directory. Base: ${this.config.getTargetDir()}, Path: ${absoluteFilePath}`,
            });
            continue;
          }
        }

        // Check if this file was filtered out by git ignore
        if (
          fileFilteringOptions.respectGitIgnore &&
          !gitFilteredSet.has(normalizePath(absoluteFilePath))
        ) {
          gitIgnoredCount++;
          continue;
        }

        // Check if this file was filtered out by gemini ignore
        if (
          fileFilteringOptions.respectGeminiIgnore &&
          !geminiFilteredSet.has(normalizePath(absoluteFilePath))
        ) {
          geminiIgnoredCount++;
          continue;
        }

        filesToConsider.add(absoluteFilePath);
      }

      // Add info about git-ignored files if any were filtered
      if (gitIgnoredCount > 0) {
        skippedFiles.push({
          path: `${gitIgnoredCount} file(s)`,
          reason: 'git ignored',
        });
      }

      // Add info about gemini-ignored files if any were filtered
      if (geminiIgnoredCount > 0) {
        skippedFiles.push({
          path: `${geminiIgnoredCount} file(s)`,
          reason: 'gemini ignored',
        });
      }
    } catch (error) {
      return {
        llmContent: `Error during file search: ${getErrorMessage(error)}`,
        returnDisplay: `## File Search Error\n\nAn error occurred while searching for files:\n\`\`\`\n${getErrorMessage(error)}\n\`\`\``,
      };
    }

    const sortedFiles = Array.from(filesToConsider).sort();

    // 🚀 智能内容管理策略：防止context爆炸
    const MAX_FILES_COUNT = 50;              // 最大文件数量限制
    const MAX_TOTAL_CONTENT_SIZE = 150 * 1024; // 150KB总内容限制（低于grep的147KB问题阈值）
    const MAX_SINGLE_FILE_SIZE = 20 * 1024;    // 单个文件20KB限制

    let totalContentSize = 0;
    let processedFilesCount = 0;
    let sizeLimitReached = false;

    for (const filePath of sortedFiles) {
      // 文件数量限制检查
      if (processedFilesCount >= MAX_FILES_COUNT) {
        skippedFiles.push({
          path: `${sortedFiles.length - processedFilesCount} remaining file(s)`,
          reason: `file count limit reached (max: ${MAX_FILES_COUNT})`,
        });
        break;
      }

      const relativePathForDisplay = path
        .relative(this.config.getTargetDir(), filePath)
        .replace(/\\/g, '/');

      const fileType = await detectFileType(filePath);

      if (fileType === 'image' || fileType === 'excel' || fileType === 'word') {
        const fileExtension = path.extname(filePath).toLowerCase();
        const fileNameWithoutExtension = path.basename(filePath, fileExtension);
        const requestedExplicitly = inputPatterns.some(
          (pattern: string) =>
            pattern.toLowerCase().includes(fileExtension) ||
            pattern.includes(fileNameWithoutExtension),
        );

        if (!requestedExplicitly) {
          skippedFiles.push({
            path: relativePathForDisplay,
            reason:
              'asset file (image/office) was not explicitly requested by name or extension',
          });
          continue;
        }
      }

      // Use processSingleFileContent for all file types now
      const fileReadResult = await processSingleFileContent(
        filePath,
        this.config.getTargetDir(),
      );

      if (fileReadResult.error) {
        skippedFiles.push({
          path: relativePathForDisplay,
          reason: `Read error: ${fileReadResult.error}`,
        });
      } else {
        let fileContentSize = 0;

        const separator = DEFAULT_OUTPUT_SEPARATOR_FORMAT.replace(
          '{filePath}',
          filePath,  // 🎯 修复：使用绝对路径以保持与现有测试的兼容性
        );

        if (typeof fileReadResult.llmContent === 'string') {
          // 🎯 智能内容截断策略 - 文本文件处理
          let contentToUse = fileReadResult.llmContent;
          let isTruncated = fileReadResult.isTruncated;

          // 单个文件大小检查和截断
          if (contentToUse.length > MAX_SINGLE_FILE_SIZE) {
            contentToUse = contentToUse.substring(0, MAX_SINGLE_FILE_SIZE);
            contentToUse += '\n\n[TRUNCATED: File content exceeds size limit. Use read_file for complete content.]';
            isTruncated = true;
          }

          const textContentWithSeparator = `${separator}\n\n${isTruncated ? '[TRUNCATED FILE - Use read_file for complete content]\n\n' : ''}${contentToUse}\n\n`;
          fileContentSize = textContentWithSeparator.length;

          // 总内容大小检查 - 文本文件
          if (totalContentSize + fileContentSize > MAX_TOTAL_CONTENT_SIZE) {
            sizeLimitReached = true;
            skippedFiles.push({
              path: relativePathForDisplay,
              reason: `total content size limit reached (${Math.round(totalContentSize / 1024)}KB of ${Math.round(MAX_TOTAL_CONTENT_SIZE / 1024)}KB used)`,
            });

            // 跳过剩余文件
            const remainingFilesCount = sortedFiles.length - sortedFiles.indexOf(filePath);
            if (remainingFilesCount > 1) {
              skippedFiles.push({
                path: `${remainingFilesCount - 1} remaining file(s)`,
                reason: 'total content size limit reached',
              });
            }
            break;
          }

          // 添加文本内容
          contentParts.push(textContentWithSeparator);
          processedFilesRelativePaths.push(relativePathForDisplay);
          processedFilesAbsolutePaths.push(filePath); // 🎯 新增：记录绝对路径
          totalContentSize += fileContentSize;
          processedFilesCount++;
        } else {
          // 🎯 修复：正确处理图片/PDF等二进制文件的内联数据
          if (fileReadResult.llmContent && typeof fileReadResult.llmContent === 'object' && 'inlineData' in fileReadResult.llmContent) {
            // 这是一个包含inlineData的媒体文件（图片、PDF等）
            // 🎯 NEW: 从returnDisplay中提取压缩信息（现在是英文格式）
            let compressionInfo = '';
            if (fileReadResult.returnDisplay) {
              // 提取括号中的压缩信息，例如：(compressed: 6435KB → 924KB, saved 85.6%)
              const compressionMatch = fileReadResult.returnDisplay.match(/\([^)]+\)$/);
              if (compressionMatch) {
                compressionInfo = ` ${compressionMatch[0]}`;
              }
            }

            // 为媒体文件添加文本标题，包含压缩信息
            const mediaSeparator = `${separator}\n\n[MEDIA FILE: ${fileType.toUpperCase()} - ${relativePathForDisplay}${compressionInfo}]\n\n`;

            // 估算媒体文件的"内容大小"（base64数据长度的大致估算）
            const estimatedMediaSize = mediaSeparator.length + 1000; // 给媒体文件预留1KB的计算空间

            // 检查是否会超出总大小限制
            if (totalContentSize + estimatedMediaSize > MAX_TOTAL_CONTENT_SIZE) {
              sizeLimitReached = true;
              skippedFiles.push({
                path: relativePathForDisplay,
                reason: `total content size limit reached (${Math.round(totalContentSize / 1024)}KB of ${Math.round(MAX_TOTAL_CONTENT_SIZE / 1024)}KB used)`,
              });

              // 跳过剩余文件
              const remainingFilesCount = sortedFiles.length - sortedFiles.indexOf(filePath);
              if (remainingFilesCount > 1) {
                skippedFiles.push({
                  path: `${remainingFilesCount - 1} remaining file(s)`,
                  reason: 'total content size limit reached',
                });
              }
              break;
            }

            // 添加媒体文件分隔符
            contentParts.push(mediaSeparator);
            // 添加实际的媒体数据
            contentParts.push(fileReadResult.llmContent);

            processedFilesRelativePaths.push(relativePathForDisplay);
            processedFilesAbsolutePaths.push(filePath); // 🎯 新增：记录绝对路径
            totalContentSize += estimatedMediaSize;
            processedFilesCount++;
          } else {
            // 其他类型的非字符串内容 - 作为错误处理
            const errorContent = `${separator}\n\n[ERROR: Unhandled content type for ${fileType.toUpperCase()} file: ${relativePathForDisplay}]\n\n`;
            const errorContentSize = errorContent.length;

            if (totalContentSize + errorContentSize <= MAX_TOTAL_CONTENT_SIZE) {
              contentParts.push(errorContent);
              processedFilesRelativePaths.push(relativePathForDisplay);
              processedFilesAbsolutePaths.push(filePath); // 🎯 新增：记录绝对路径
              totalContentSize += errorContentSize;
              processedFilesCount++;
            } else {
              skippedFiles.push({
                path: relativePathForDisplay,
                reason: 'unhandled content type and size limit reached',
              });
            }
          }
        }

        const lines =
          typeof fileReadResult.llmContent === 'string'
            ? fileReadResult.llmContent.split('\n').length
            : undefined;
        const mimetype = getSpecificMimeType(filePath);
        recordFileOperationMetric(
          this.config,
          FileOperation.READ,
          lines,
          mimetype,
          path.extname(filePath),
        );

        // 追踪文件读取，用于压缩后上下文恢复
        this.config.getGeminiClient?.()?.trackFileRead(filePath);
      }
    }

    // 🎯 修复：计算实际文件总大小，而不是处理后的内容大小
    let actualFilesTotalSize = 0;
    try {
      for (const filePath of processedFilesAbsolutePaths) {
        const stats = await fs.promises.stat(filePath);
        actualFilesTotalSize += stats.size;
      }
    } catch (error) {
      // 如果无法获取文件大小，回退到内容大小
      actualFilesTotalSize = totalContentSize;
    }

    let displayMessage = `### ReadManyFiles Result (Target Dir: \`${this.config.getTargetDir()}\`)\n\n`;
    if (processedFilesRelativePaths.length > 0) {
      displayMessage += `Successfully read and concatenated content from **${processedFilesRelativePaths.length} file(s)** (${Math.round(actualFilesTotalSize / 1024)}KB total).\n`;

      // 🎯 显示智能管理统计信息
      if (sizeLimitReached || processedFilesCount >= MAX_FILES_COUNT) {
        displayMessage += `\n⚠️ **Content Management Applied**: Limits reached to prevent context explosion.\n`;
        displayMessage += `- Total size limit: ${Math.round(MAX_TOTAL_CONTENT_SIZE / 1024)}KB\n`;
        displayMessage += `- Max files limit: ${MAX_FILES_COUNT}\n`;
        displayMessage += `- Single file limit: ${Math.round(MAX_SINGLE_FILE_SIZE / 1024)}KB\n`;
      }
      if (processedFilesRelativePaths.length <= 10) {
        displayMessage += `\n**Processed Files:**\n`;
        processedFilesRelativePaths.forEach(
          (p) => (displayMessage += `- \`${p}\`\n`),
        );
      } else {
        displayMessage += `\n**Processed Files (first 10 shown):**\n`;
        processedFilesRelativePaths
          .slice(0, 10)
          .forEach((p) => (displayMessage += `- \`${p}\`\n`));
        displayMessage += `- ...and ${processedFilesRelativePaths.length - 10} more.\n`;
      }
    }

    if (skippedFiles.length > 0) {
      if (processedFilesRelativePaths.length === 0) {
        displayMessage += `No files were read and concatenated based on the criteria.\n`;
      }
      if (skippedFiles.length <= 5) {
        displayMessage += `\n**Skipped ${skippedFiles.length} item(s):**\n`;
      } else {
        displayMessage += `\n**Skipped ${skippedFiles.length} item(s) (first 5 shown):**\n`;
      }
      skippedFiles
        .slice(0, 5)
        .forEach(
          (f) => (displayMessage += `- \`${f.path}\` (Reason: ${f.reason})\n`),
        );
      if (skippedFiles.length > 5) {
        displayMessage += `- ...and ${skippedFiles.length - 5} more.\n`;
      }
    } else if (
      processedFilesRelativePaths.length === 0 &&
      skippedFiles.length === 0
    ) {
      displayMessage += `No files were read and concatenated based on the criteria.\n`;
    }

    // 🎯 修复：正确处理空结果情况
    if (contentParts.length === 0) {
        contentParts.push(
          'No files matching the criteria were found or all were skipped.',
        );
    }

    return {
      llmContent: contentParts,
      returnDisplay: displayMessage.trim(),
    };
  }
}
