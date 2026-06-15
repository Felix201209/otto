/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import {
  isNodeError,
  escapePath,
  unescapePath,
  getErrorMessage,
  Config,
  FileDiscoveryService,
  DEFAULT_FILE_FILTERING_OPTIONS,
} from 'otto-core';
import {
  MAX_SUGGESTIONS_TO_SHOW,
  Suggestion,
} from '../components/SuggestionsDisplay.js';
import { CommandContext, SlashCommand } from '../commands/types.js';
import { TextBuffer } from '../components/shared/text-buffer.js';
import { isSlashCommand } from '../utils/commandUtils.js';
import { toCodePoints } from '../utils/textUtils.js';
import { t } from '../utils/i18n.js';
import { getShellCompletions, isShellCompletionSupported } from '../utils/shellCompletionUtils.js';
import { fuzzyMatch, sortByRelevance } from '../utils/fuzzyMatch.js';

export interface UseCompletionReturn {
  suggestions: Suggestion[];
  activeSuggestionIndex: number;
  visibleStartIndex: number;
  showSuggestions: boolean;
  isLoadingSuggestions: boolean;
  isPerfectMatch: boolean;
  setActiveSuggestionIndex: React.Dispatch<React.SetStateAction<number>>;
  setShowSuggestions: React.Dispatch<React.SetStateAction<boolean>>;
  resetCompletionState: () => void;
  suppressCompletion: () => void; // 新增：抑制自动补全
  triggerShellCompletion: () => void; // 新增：手动触发shell补全
  navigateUp: () => void;
  navigateDown: () => void;
  handleAutocomplete: (indexToUse: number) => void;
}

export function useCompletion(
  buffer: TextBuffer,
  cwd: string,
  slashCommands: readonly SlashCommand[],
  commandContext: CommandContext,
  config?: Config,
  shellModeActive?: boolean,
  isBusy?: boolean, // AI 正在工作或有队列
  isInSpecialMode?: boolean, // 正在润色/编辑队列等特殊模式
): UseCompletionReturn {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] =
    useState<number>(-1);
  const [visibleStartIndex, setVisibleStartIndex] = useState<number>(0);
  const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
  const [isLoadingSuggestions, setIsLoadingSuggestions] =
    useState<boolean>(false);
  const [isPerfectMatch, setIsPerfectMatch] = useState<boolean>(false);
  const [suppressUntilNextChange, setSuppressUntilNextChange] = useState<boolean>(false);
  const prevTextRef = useRef<string>(buffer.text);

  const resetCompletionState = useCallback(() => {
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    setVisibleStartIndex(0);
    setShowSuggestions(false);
    setIsLoadingSuggestions(false);
    setIsPerfectMatch(false);
  }, []);

  const suppressCompletion = useCallback(() => {
    resetCompletionState();
    setSuppressUntilNextChange(true);
  }, [resetCompletionState]);

  // 🔧 智能匹配：根据用户输入自动选中匹配的建议项
  const findBestMatch = useCallback((currentInput: string, suggestions: Suggestion[]): number => {
    if (!currentInput || suggestions.length === 0) return 0;

    // 1. 精确匹配（优先级最高）
    const exactMatchIndex = suggestions.findIndex(s =>
      s.value === currentInput || s.label === currentInput
    );
    if (exactMatchIndex !== -1) return exactMatchIndex;

    // 2. 前缀匹配
    const prefixMatchIndex = suggestions.findIndex(s =>
      s.value.startsWith(currentInput) || s.label.startsWith(currentInput)
    );
    if (prefixMatchIndex !== -1) return prefixMatchIndex;

    // 3. 包含匹配（不区分大小写）
    const lowerInput = currentInput.toLowerCase();
    const containsMatchIndex = suggestions.findIndex(s =>
      s.value.toLowerCase().includes(lowerInput) || s.label.toLowerCase().includes(lowerInput)
    );
    if (containsMatchIndex !== -1) return containsMatchIndex;

    // 4. 没有匹配则返回第一个
    return 0;
  }, []);

  const navigateUp = useCallback(() => {
    if (suggestions.length === 0) return;
    setSuppressUntilNextChange(false); // 用户导航时重置抑制状态

    setActiveSuggestionIndex((prevActiveIndex) => {
      // Calculate new active index, handling wrap-around
      const newActiveIndex =
        prevActiveIndex <= 0 ? suggestions.length - 1 : prevActiveIndex - 1;

      // Adjust scroll position based on the new active index
      setVisibleStartIndex((prevVisibleStart) => {
        // Case 1: Wrapped around to the last item
        if (
          newActiveIndex === suggestions.length - 1 &&
          suggestions.length > MAX_SUGGESTIONS_TO_SHOW
        ) {
          return Math.max(0, suggestions.length - MAX_SUGGESTIONS_TO_SHOW);
        }
        // Case 2: Scrolled above the current visible window
        if (newActiveIndex < prevVisibleStart) {
          return newActiveIndex;
        }
        // Otherwise, keep the current scroll position
        return prevVisibleStart;
      });

      return newActiveIndex;
    });
  }, [suggestions.length]);

  const navigateDown = useCallback(() => {
    if (suggestions.length === 0) return;
    setSuppressUntilNextChange(false); // 用户导航时重置抑制状态

    setActiveSuggestionIndex((prevActiveIndex) => {
      // Calculate new active index, handling wrap-around
      const newActiveIndex =
        prevActiveIndex >= suggestions.length - 1 ? 0 : prevActiveIndex + 1;

      // Adjust scroll position based on the new active index
      setVisibleStartIndex((prevVisibleStart) => {
        // Case 1: Wrapped around to the first item
        if (
          newActiveIndex === 0 &&
          suggestions.length > MAX_SUGGESTIONS_TO_SHOW
        ) {
          return 0;
        }
        // Case 2: Scrolled below the current visible window
        const visibleEndIndex = prevVisibleStart + MAX_SUGGESTIONS_TO_SHOW;
        if (newActiveIndex >= visibleEndIndex) {
          return newActiveIndex - MAX_SUGGESTIONS_TO_SHOW + 1;
        }
        // Otherwise, keep the current scroll position
        return prevVisibleStart;
      });

      return newActiveIndex;
    });
  }, [suggestions.length]);

  // Check if cursor is after @ or / without unescaped spaces
  const isActive = useMemo(() => {
    if (isSlashCommand(buffer.text.trim())) {
      return true;
    }

    // For other completions like '@', we search backwards from the cursor.
    const [row, col] = buffer.cursor;
    const currentLine = buffer.lines[row] || '';
    const codePoints = toCodePoints(currentLine);

    for (let i = col - 1; i >= 0; i--) {
      const char = codePoints[i];

      if (char === ' ') {
        // Check for unescaped spaces.
        let backslashCount = 0;
        for (let j = i - 1; j >= 0 && codePoints[j] === '\\'; j--) {
          backslashCount++;
        }
        if (backslashCount % 2 === 0) {
          return false; // Inactive on unescaped space.
        }
      } else if (char === '@') {
        // Active if we find an '@' before any unescaped space.
        return true;
      }
    }

    return false;
  }, [buffer.text, buffer.cursor, buffer.lines, shellModeActive]);

  useEffect(() => {
    // 🚀 恢复机制：如果用户删除了字符（退格），自动重置抑制状态，重新显示补全
    const isDeletion = buffer.text.length < prevTextRef.current.length;
    prevTextRef.current = buffer.text;

    if (isDeletion && suppressUntilNextChange) {
      setSuppressUntilNextChange(false);
      // 注意：这里的 suppressUntilNextChange 状态更新是异步的，
      // 所以我们不能在同一个 effect 运行中依赖它的新值。
      // 但没关系，下一行代码会处理。
    }

    if (!isActive) {
      resetCompletionState();
      setSuppressUntilNextChange(false); // 重置抑制状态
      return;
    }

    // 🔧 如果当前被抑制（且不是退格操作），则不触发自动补全
    if (suppressUntilNextChange && !isDeletion) {
      return;
    }

    const trimmedQuery = buffer.text.trimStart();



    // 🚀 性能优化：早期退出，避免不必要的计算
    // 只有在输入特殊字符时才需要补全处理
    if (!trimmedQuery.startsWith('/') && !buffer.text.includes('@')) {
      resetCompletionState();
      return;
    }

    // 🚀 优先处理 @ 文件路径补全（即使在命令模式下）
    // 如果当前正在输入 @ 文件路径，跳过命令补全逻辑，直接使用全局文件补全
    const lastToken = buffer.text.split(/\s+/).pop() || '';
    const isAtCompletion = lastToken.startsWith('@');

    if (trimmedQuery.startsWith('/') && !isAtCompletion) {
      // Always reset perfect match at the beginning of processing.
      setIsPerfectMatch(false);

      const fullPath = trimmedQuery.substring(1);
      const hasTrailingSpace = trimmedQuery.endsWith(' ');

      // Get all non-empty parts of the command.
      const rawParts = fullPath.split(/\s+/).filter((p) => p);

      let commandPathParts = rawParts;
      let partial = '';

      // If there's no trailing space, the last part is potentially a partial segment.
      // We tentatively separate it.
      if (!hasTrailingSpace && rawParts.length > 0) {
        partial = rawParts[rawParts.length - 1];
        commandPathParts = rawParts.slice(0, -1);
      }

      // Traverse the Command Tree using the tentative completed path
      // 🚀 过滤命令列表：在 AI 忙碌或特殊模式时限制可用命令
      let availableCommands: readonly SlashCommand[] = slashCommands;
      if (isBusy && !isInSpecialMode) {
        // AI 正在工作时，只显示队列管理、退出和 workflow 面板命令
        availableCommands = slashCommands.filter(cmd =>
          cmd.name === 'queue' || cmd.name === 'quit' ||
          cmd.name === 'workflow' || cmd.name === 'wf' || cmd.name === 'workflows'
        );
      } else if (isInSpecialMode) {
        // 特殊模式（润色确认、队列编辑）时，不提供命令补全
        availableCommands = [];
      }

      let currentLevel: readonly SlashCommand[] | undefined = availableCommands;
      let leafCommand: SlashCommand | null = null;
      let commandDepth = 0; // Track how many parts were consumed as command/subcommand names

      for (const part of commandPathParts) {
        if (!currentLevel) {
          // No more subcommands to search, remaining parts are arguments
          break;
        }
        const lowerPart = part.toLowerCase();
        const found: SlashCommand | undefined = currentLevel.find(
          (cmd) =>
            cmd.name.toLowerCase() === lowerPart ||
            cmd.altNames?.some((alt) => alt.toLowerCase() === lowerPart),
        );
        if (found) {
          leafCommand = found;
          commandDepth++;
          currentLevel = found.subCommands as
            | readonly SlashCommand[]
            | undefined;
        } else {
          // Part is not a subcommand, it must be an argument
          // Keep the current leafCommand and stop searching
          currentLevel = undefined;
          break;
        }
      }

      // Handle the Ambiguous Case
      if (!hasTrailingSpace && currentLevel) {
        const lowerPartial = partial.toLowerCase();
        const exactMatchAsParent = currentLevel.find(
          (cmd) =>
            (cmd.name.toLowerCase() === lowerPartial ||
              cmd.altNames?.some((alt) => alt.toLowerCase() === lowerPartial)) &&
            cmd.subCommands,
        );

        if (exactMatchAsParent) {
          // It's a perfect match for a parent command. Override our initial guess.
          // Treat it as a completed command path.
          leafCommand = exactMatchAsParent;
          currentLevel = exactMatchAsParent.subCommands;
          partial = ''; // We now want to suggest ALL of its sub-commands.
        }
      }

      // Check for perfect, executable match
      if (!hasTrailingSpace) {
        if (leafCommand && partial === '' && leafCommand.action) {
          // Case: /command<enter> - command has action, no sub-commands were suggested
          setIsPerfectMatch(true);
        } else if (currentLevel) {
          // Case: /command subcommand<enter>
          const lowerPartial = partial.toLowerCase();
          const perfectMatch = currentLevel.find(
            (cmd) =>
              (cmd.name.toLowerCase() === lowerPartial ||
                cmd.altNames?.some(
                  (alt) => alt.toLowerCase() === lowerPartial,
                )) &&
              cmd.action,
          );
          if (perfectMatch) {
            setIsPerfectMatch(true);
          }
        }
      }

      const depth = commandDepth; // Use actual command depth, not commandPathParts.length

      // Provide Suggestions based on the now-corrected context

      // Argument Completion
      if (
        leafCommand?.completion &&
        (hasTrailingSpace ||
          (rawParts.length > depth && depth > 0 && partial !== ''))
      ) {
        const fetchAndSetSuggestions = async () => {
          setIsLoadingSuggestions(true);
          // Preserve trailing space so completion function knows user is moving to next parameter
          const argString = rawParts.slice(depth).join(' ') + (hasTrailingSpace ? ' ' : '');
          const results =
            (await leafCommand!.completion!(commandContext, argString)) || [];

          // 处理新的返回类型：既可能是字符串数组，也可能是 Suggestion 对象数组
          const finalSuggestions = results.map((s) => {
            if (typeof s === 'string') {
              return { label: s, value: s };
            } else {
              return s; // 已经是 Suggestion 对象
            }
          });

          // 🔧 智能匹配：根据当前输入的参数找到最佳匹配项
          let bestMatchIndex = 0;
          if (finalSuggestions.length > 0) {
            // 获取当前正在输入的参数（最后一个参数）
            const currentArg = rawParts.length > depth ? rawParts[rawParts.length - 1] : '';
            bestMatchIndex = findBestMatch(currentArg, finalSuggestions);
          }

          setSuggestions(finalSuggestions);
          setShowSuggestions(finalSuggestions.length > 0);
          setActiveSuggestionIndex(finalSuggestions.length > 0 ? bestMatchIndex : -1);
          setVisibleStartIndex(0); // 🔧 重置滚动位置，防止列表更新后由于偏移过大导致显示空白
          setIsLoadingSuggestions(false);
        };
        fetchAndSetSuggestions();
        return;
      }

      // Command/Sub-command Completion
      const commandsToSearch = (currentLevel || []).filter(cmd => !cmd.hidden);
      if (commandsToSearch.length > 0) {
        let potentialSuggestions: SlashCommand[];
        const potentialSuggestionsWithScore: Array<{ cmd: SlashCommand; fuzzyScore: number }> = [];

        // 只有当用户输入了搜索词时，才使用模糊匹配；否则显示所有命令
        if (partial) {
          // 使用模糊匹配替代前缀匹配，支持任意位置的匹配
          const suggestionsWithScore = commandsToSearch
            .filter((cmd) => cmd.description)
            .map((cmd) => {
              // 获取命令名和别名的匹配结果
              const nameMatch = fuzzyMatch(cmd.name, partial);
              const aliasMatches = (cmd.altNames || []).map((alt) => fuzzyMatch(alt, partial));

              // 选择最高分的匹配
              const allMatches = [nameMatch, ...aliasMatches].filter((m) => m.matched);
              const bestMatch = allMatches.reduce((best, current) =>
                current.score > best.score ? current : best,
                { matched: false, score: 0, indices: [] as number[] },
              );

              return { cmd, matched: bestMatch.matched, fuzzyScore: bestMatch.score };
            })
            .filter((item) => item.matched);

          potentialSuggestions = suggestionsWithScore.map((item) => item.cmd);
          potentialSuggestionsWithScore.push(...suggestionsWithScore);
        } else {
          // 没有搜索词时，显示所有有描述的命令，保持原顺序
          potentialSuggestions = commandsToSearch.filter((cmd) => cmd.description);
        }

        // If a user's input is an exact match and it is a leaf command,
        // enter should submit immediately.
        if (potentialSuggestions.length > 0 && !hasTrailingSpace) {
          const lowerPartial = partial.toLowerCase();
          const perfectMatch = potentialSuggestions.find(
            (s) =>
              (s.name.toLowerCase() === lowerPartial ||
                s.altNames?.some((alt) => alt.toLowerCase() === lowerPartial)) &&
              s.action &&
              !s.subCommands, // 🔧 如果有子命令，即使名字匹配也不应清除补全，方便用户继续输入
          );
          if (perfectMatch) {
            potentialSuggestions = [];
            potentialSuggestionsWithScore.length = 0;
          }
        }

        const finalSuggestions = potentialSuggestions.map((cmd) => ({
          label: cmd.name,
          value: cmd.name,
          description: cmd.description,
        }));

        // 🔧 自定义排序：只在有搜索词时，按模糊匹配得分和优先级排序
        if (partial && potentialSuggestionsWithScore.length > 0) {
          const scoreMap = new Map<string, number>();
          potentialSuggestionsWithScore.forEach((item) => {
            scoreMap.set(item.cmd.name, item.fuzzyScore);
          });

          finalSuggestions.sort((a, b) => {
            const getPriority = (name: string): number => {
              if (name === 'help-ask') return 0;
              if (name === 'help') return 1;
              if (name === 'about') return 999;
              return 500; // 其他命令的默认优先级
            };

            const priorityA = getPriority(a.value);
            const priorityB = getPriority(b.value);

            if (priorityA !== priorityB) {
              return priorityA - priorityB;
            }

            // 同优先级下，按照模糊匹配得分降序排列
            const scoreA = scoreMap.get(a.value) || 0;
            const scoreB = scoreMap.get(b.value) || 0;

            if (scoreA !== scoreB) {
              return scoreB - scoreA; // 降序
            }

            // 同分数下，按长度升序排列（短的优先）
            const lengthDiff = a.value.length - b.value.length;
            if (lengthDiff !== 0) {
              return lengthDiff;
            }

            // 长度也相同，按字母顺序排列
            return a.value.localeCompare(b.value);
          });
        }

        // 🔧 智能匹配：根据当前输入找到最佳匹配的命令
        let bestMatchIndex = 0;
        if (finalSuggestions.length > 0 && partial) {
          bestMatchIndex = findBestMatch(partial, finalSuggestions);
        }

        setSuggestions(finalSuggestions);
        setShowSuggestions(finalSuggestions.length > 0);
        setActiveSuggestionIndex(finalSuggestions.length > 0 ? bestMatchIndex : -1);
        setVisibleStartIndex(0); // 🔧 重置滚动位置，防止列表更新后由于偏移过大导致显示空白
        setIsLoadingSuggestions(false);
        return;
      }

      // If we fall through, no suggestions are available.
      resetCompletionState();
      return;
    }

    // Handle At Command Completion (也用于斜杠命令中的 @ 文件补全)
    const atIndex = buffer.text.lastIndexOf('@');
    if (atIndex === -1) {
      resetCompletionState();
      return;
    }

    let partialPath = buffer.text.substring(atIndex + 1);

    // 🚀 修复：如果路径以引号开头（因为选中了自动补全的目录），去除引号以便继续匹配子目录
    // 例如：@"path/to/dir/ -> path/to/dir/
    if (partialPath.startsWith('"')) {
      // 如果有闭合引号且光标在闭合引号后面，那就不应该是补全状态了（除非是在修改引号内的内容）
      // 这里我们假设光标在引号内部或刚刚输入了内容
      // 简单地去除所有引号来获取原始路径
      partialPath = partialPath.replace(/"/g, '');
    }

    const lastSlashIndex = partialPath.lastIndexOf('/');
    const baseDirRelative =
      lastSlashIndex === -1
        ? '.'
        : partialPath.substring(0, lastSlashIndex + 1);
    const prefix = unescapePath(
      lastSlashIndex === -1
        ? partialPath
        : partialPath.substring(lastSlashIndex + 1),
    );

    const baseDirAbsolute = path.resolve(cwd, baseDirRelative);

    let isMounted = true;

    const findFilesRecursively = async (
      startDir: string,
      searchPrefix: string,
      fileDiscovery: FileDiscoveryService | null,
      filterOptions: {
        respectGitIgnore?: boolean;
        respectGeminiIgnore?: boolean;
      },
      currentRelativePath = '',
      depth = 0,
      maxDepth = 10, // Limit recursion depth
      maxResults = 100, // Increase limit for fuzzy matching
    ): Promise<Suggestion[]> => {
      if (depth > maxDepth) {
        return [];
      }

      let foundSuggestions: Suggestion[] = [];
      try {
        const entries = await fs.readdir(startDir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPathRelative = path.join(currentRelativePath, entry.name);
          const entryPathFromRoot = path.relative(
            cwd,
            path.join(startDir, entry.name),
          );

          // Conditionally ignore dotfiles
          if (!searchPrefix.startsWith('.') && entry.name.startsWith('.')) {
            continue;
          }

          // Check if this entry should be ignored by filtering options
          if (
            fileDiscovery &&
            fileDiscovery.shouldIgnoreFile(entryPathFromRoot, filterOptions)
          ) {
            continue;
          }

          // 🎯 使用模糊匹配代替 startsWith
          const matchResult = fuzzyMatch(entry.name, searchPrefix);
          if (matchResult.matched) {
            foundSuggestions.push({
              label: entryPathRelative + (entry.isDirectory() ? '/' : ''),
              value: escapePath(
                entryPathRelative + (entry.isDirectory() ? '/' : ''),
              ),
              matchScore: matchResult.score, // 保存匹配分数用于排序
            });
          }

          if (
            entry.isDirectory() &&
            entry.name !== 'node_modules' &&
            !entry.name.startsWith('.')
          ) {
            foundSuggestions = foundSuggestions.concat(
              await findFilesRecursively(
                path.join(startDir, entry.name),
                searchPrefix, // Pass original searchPrefix for recursive calls
                fileDiscovery,
                filterOptions,
                entryPathRelative,
                depth + 1,
                maxDepth,
                maxResults,
              ),
            );
          }
        }
      } catch (_err) {
        // Ignore errors like permission denied or ENOENT during recursive search
      }
      return foundSuggestions;
    };

    const findFilesWithGlob = async (
      searchPrefix: string,
      fileDiscoveryService: FileDiscoveryService,
      filterOptions: {
        respectGitIgnore?: boolean;
        respectGeminiIgnore?: boolean;
      },
      maxResults = 100,
    ): Promise<Suggestion[]> => {
      // 🎯 使用更宽泛的 glob 模式来获取所有可能的文件
      const globPattern = `**/*${searchPrefix}*`;
      const files = await glob(globPattern, {
        cwd,
        dot: searchPrefix.startsWith('.'),
        nocase: true,
      });

      const suggestions: Suggestion[] = files
        .map((file: string) => {
          // 计算匹配分数
          const fileName = path.basename(file);
          const matchResult = fuzzyMatch(fileName, searchPrefix);

          return {
            label: file,
            value: escapePath(file),
            matchScore: matchResult.score,
          };
        })
        .filter((s) => {
          if (fileDiscoveryService) {
            return !fileDiscoveryService.shouldIgnoreFile(
              s.label,
              filterOptions,
            ); // relative path
          }
          return true;
        });

      return suggestions;
    };

    const fetchSuggestions = async () => {
      console.log(`[DEBUG] fetchSuggestions triggered for text: "${buffer.text}" (length: ${buffer.text.length})`);
      setIsLoadingSuggestions(true);
      let fetchedSuggestions: Suggestion[] = [];

      const fileDiscoveryService = config ? config.getFileService() : null;
      const enableRecursiveSearch =
        config?.getEnableRecursiveFileSearch() ?? true;
      const filterOptions =
        config?.getFileFilteringOptions() ?? DEFAULT_FILE_FILTERING_OPTIONS;

      try {
        // If there's no slash, or it's the root, do a recursive search from cwd
        if (
          partialPath.indexOf('/') === -1 &&
          prefix &&
          enableRecursiveSearch
        ) {
          if (fileDiscoveryService) {
            fetchedSuggestions = await findFilesWithGlob(
              prefix,
              fileDiscoveryService,
              filterOptions,
            );
          } else {
            fetchedSuggestions = await findFilesRecursively(
              cwd,
              prefix,
              null,
              filterOptions,
            );
          }
        } else {
          // Original behavior: list files in the specific directory
          const entries = await fs.readdir(baseDirAbsolute, {
            withFileTypes: true,
          });

          // Filter entries using git-aware filtering
          const filteredEntries = [];
          for (const entry of entries) {
            // Conditionally ignore dotfiles
            if (!prefix.startsWith('.') && entry.name.startsWith('.')) {
              continue;
            }

            // 🎯 使用模糊匹配代替 startsWith
            const matchResult = fuzzyMatch(entry.name, prefix);
            if (!matchResult.matched) continue;

            const relativePath = path.relative(
              cwd,
              path.join(baseDirAbsolute, entry.name),
            );

            const shouldIgnore = fileDiscoveryService &&
              fileDiscoveryService.shouldIgnoreFile(relativePath, filterOptions);

            if (shouldIgnore) {
              continue;
            }

            filteredEntries.push({ entry, matchScore: matchResult.score });
          }
          fetchedSuggestions = filteredEntries.map(({ entry, matchScore }) => {
            const label = entry.isDirectory() ? entry.name + '/' : entry.name;
            return {
              label,
              value: escapePath(label), // Value for completion should be just the name part
              matchScore,
            };
          });
        }

        // Like glob, we always return forwardslashes, even in windows.
        fetchedSuggestions = fetchedSuggestions.map((suggestion) => ({
          ...suggestion,
          label: suggestion.label.replace(/\\/g, '/'),
          value: suggestion.value.replace(/\\/g, '/'),
        }));

        // 🎯 智能排序：优先按匹配分数，其次按深度和类型
        fetchedSuggestions.sort((a, b) => {
          // 1. 优先按匹配分数排序（分数越高越靠前）
          const scoreA = a.matchScore ?? 0;
          const scoreB = b.matchScore ?? 0;
          if (scoreA !== scoreB) {
            return scoreB - scoreA;
          }

          // 2. 同分数情况下，按深度排序（浅层优先）
          const depthA = (a.label.match(/\//g) || []).length;
          const depthB = (b.label.match(/\//g) || []).length;
          if (depthA !== depthB) {
            return depthA - depthB;
          }

          // 3. 同深度情况下，目录优先
          const aIsDir = a.label.endsWith('/');
          const bIsDir = b.label.endsWith('/');
          if (aIsDir && !bIsDir) return -1;
          if (!aIsDir && bIsDir) return 1;

          // 4. 最后按文件名字母顺序排序
          const filenameA = a.label.substring(
            0,
            a.label.length - path.extname(a.label).length,
          );
          const filenameB = b.label.substring(
            0,
            b.label.length - path.extname(b.label).length,
          );

          return (
            filenameA.localeCompare(filenameB) || a.label.localeCompare(b.label)
          );
        });

        if (isMounted) {
          // 🎯 添加特殊的 clipboard 建议
          if ('clipboard'.startsWith(prefix.toLowerCase()) && !fetchedSuggestions.some(s => s.value === 'clipboard')) {
            fetchedSuggestions.unshift({
              label: '📋 clipboard',
              value: 'clipboard',
              description: t('completion.clipboard.description')
            });
          }

          // 🔧 智能匹配：根据当前输入的文件名找到最佳匹配项
          let bestMatchIndex = 0;
          if (fetchedSuggestions.length > 0) {
            // 获取当前正在输入的文件名部分
            const currentFileName = prefix; // prefix 是用户当前输入的文件名前缀
            bestMatchIndex = findBestMatch(currentFileName, fetchedSuggestions);
          }

          setSuggestions(fetchedSuggestions);
          setShowSuggestions(fetchedSuggestions.length > 0);
          setActiveSuggestionIndex(fetchedSuggestions.length > 0 ? bestMatchIndex : -1);
          setVisibleStartIndex(0);
        }
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          if (isMounted) {
            setSuggestions([]);
            setShowSuggestions(false);
          }
        } else {
          console.error(
            `Error fetching completion suggestions for ${partialPath}: ${getErrorMessage(error)}`,
          );
          if (isMounted) {
            resetCompletionState();
          }
        }
      }
      if (isMounted) {
        setIsLoadingSuggestions(false);
      }
    };

    const debounceTimeout = setTimeout(fetchSuggestions, 150); // 🚀 优化：从 250ms 恢复到更灵敏的 150ms

    return () => {
      isMounted = false;
      clearTimeout(debounceTimeout);
    };
  }, [
    buffer.text, // 主要触发条件
    isActive,    // 激活状态
    suppressUntilNextChange, // 抑制状态
    cwd,         // 工作目录（仅在@文件补全时需要）
    // 🚀 性能优化：移除不必要的依赖项，减少重复触发
    // resetCompletionState, slashCommands, commandContext, config 这些通常不会频繁变化
  ]);

  const handleAutocomplete = useCallback(
    (indexToUse: number) => {
      if (indexToUse < 0 || indexToUse >= suggestions.length) {
        return;
      }
      setSuppressUntilNextChange(false); // 重置抑制状态
      const query = buffer.text;
      const suggestion = suggestions[indexToUse].value;

      // Shell mode completion
      if (shellModeActive) {
        const trimmed = query.trim();
        const parts = trimmed.split(/\s+/);

        if (parts.length === 1) {
          // 命令补全：直接替换整个命令
          buffer.setText(suggestion);
        } else {
          // 文件补全：替换最后一个参数
          const commandPart = parts.slice(0, -1).join(' ');
          buffer.setText(commandPart + ' ' + suggestion);
        }
        resetCompletionState();
        return;
      }

      if (query.trimStart().startsWith('/')) {
        // 🎯 检查是否是斜杠命令中的 @ 文件路径补全
        const lastAtIndex = query.lastIndexOf('@');
        if (lastAtIndex !== -1) {
          const charBefore = lastAtIndex > 0 ? query[lastAtIndex - 1] : ' ';
          // 如果 @ 前面是空格，说明是文件路径补全
          if (charBefore === ' ') {
            const afterAt = query.substring(lastAtIndex + 1);
            // 如果 @ 后面没有空格，替换 @ 及其后面的内容
            if (!afterAt.includes(' ')) {
              // 找到最后一个斜杠，保留路径前缀
              const lastSlashIndex = afterAt.lastIndexOf('/');
              let prefix = '';
              if (lastSlashIndex !== -1) {
                prefix = afterAt.substring(0, lastSlashIndex + 1);
              }

              // 🚀 优化：使用引号包裹路径，防止终端（如 iTerm2）将其误识别为 URL
              // 同时移除可能存在的引号和转义，统一处理
              const cleanPrefix = prefix.startsWith('"') ? prefix.substring(1) : prefix;
              const cleanSuggestion = unescapePath(suggestion);
              const isDirectory = cleanSuggestion.endsWith('/');

              const beforeAt = query.substring(0, lastAtIndex); // 不包含 @
              let atContent: string;
              if (isDirectory) {
                atContent = `@"${cleanPrefix}${cleanSuggestion}`;
              } else {
                atContent = `@"${cleanPrefix}${cleanSuggestion}" `;
              }

              const newValue = beforeAt + atContent;
              buffer.setText(newValue);
              resetCompletionState();
              return;
            }
          }
        }

        const hasTrailingSpace = query.endsWith(' ');
        const parts = query
          .trimStart()
          .substring(1)
          .split(/\s+/)
          .filter(Boolean);

        let isParentPath = false;
        // If there's no trailing space, we need to check if the current query
        // is already a complete path to a parent command.
        if (!hasTrailingSpace) {
          let currentLevel: readonly SlashCommand[] | undefined = slashCommands;
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const lowerPart = part.toLowerCase();
            const found: SlashCommand | undefined = currentLevel?.find(
              (cmd) =>
                cmd.name.toLowerCase() === lowerPart ||
                cmd.altNames?.some((alt) => alt.toLowerCase() === lowerPart),
            );

            if (found) {
              if (i === parts.length - 1 && found.subCommands) {
                isParentPath = true;
              }
              currentLevel = found.subCommands as
                | readonly SlashCommand[]
                | undefined;
            } else {
              // Path is invalid, so it can't be a parent path.
              currentLevel = undefined;
              break;
            }
          }
        }

        // Determine the base path of the command.
        // - If there's a trailing space, the whole command is the base.
        // - If it's a known parent path, the whole command is the base.
        // - If the last part is a complete argument, the whole command is the base.
        // - Otherwise, the base is everything EXCEPT the last partial part.
        const lastPart = parts.length > 0 ? parts[parts.length - 1] : '';
        const isLastPartACompleteArg =
          lastPart.startsWith('--') && lastPart.includes('=');

        const basePath =
          hasTrailingSpace || isParentPath || isLastPartACompleteArg
            ? parts
            : parts.slice(0, -1);

        let newValue = `/${[...basePath, suggestion].join(' ')}`;
        // Don't add a trailing space if the suggestion ends with a colon (e.g. "marketplace:")
        // This allows the user to immediately type the next part (e.g. "plugin") without a space.
        if (!suggestion.endsWith(':')) {
          newValue += ' ';
        }

        buffer.setText(newValue);
      } else {
        const atIndex = query.lastIndexOf('@');
        if (atIndex === -1) return;

        const pathPart = query.substring(atIndex + 1);
        const lastSlashIndexInPath = pathPart.lastIndexOf('/');
        const prefix = lastSlashIndexInPath !== -1
          ? pathPart.substring(0, lastSlashIndexInPath + 1)
          : '';

        // 🚀 优化：使用引号包裹路径，防止终端（如 iTerm2）将其误识别为 URL
        const cleanPrefix = prefix.startsWith('"') ? prefix.substring(1) : prefix;
        const cleanSuggestion = unescapePath(suggestion);
        const isDirectory = cleanSuggestion.endsWith('/');

        let newValue: string;
        if (isDirectory) {
          newValue = `@"${cleanPrefix}${cleanSuggestion}`;
        } else {
          newValue = `@"${cleanPrefix}${cleanSuggestion}" `;
        }

        // replaceRangeByOffset 会自动将光标移到替换文本的末尾
        // 不需要手动调用 moveToOffset，否则会覆盖正确的位置
        buffer.replaceRangeByOffset(atIndex, buffer.text.length, newValue);
      }
      resetCompletionState();
    },
    [resetCompletionState, buffer, suggestions, slashCommands, shellModeActive],
  );

  const triggerShellCompletion = useCallback(async () => {
    if (!shellModeActive || !isShellCompletionSupported() || !buffer.text.trim()) {
      return;
    }

    setIsLoadingSuggestions(true);

    try {
      const shellSuggestions = await getShellCompletions(buffer.text, cwd);
      setSuggestions(shellSuggestions);
      setShowSuggestions(shellSuggestions.length > 0);
      setActiveSuggestionIndex(shellSuggestions.length > 0 ? 0 : -1);
      setIsLoadingSuggestions(false);
    } catch {
      resetCompletionState();
    }
  }, [shellModeActive, buffer.text, cwd, resetCompletionState]);

  return {
    suggestions,
    activeSuggestionIndex,
    visibleStartIndex,
    showSuggestions,
    isLoadingSuggestions,
    isPerfectMatch,
    setActiveSuggestionIndex,
    setShowSuggestions,
    resetCompletionState,
    suppressCompletion,
    triggerShellCompletion,
    navigateUp,
    navigateDown,
    handleAutocomplete,
  };
}
