/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config } from 'otto-core';
import { CommandService } from './services/CommandService.js';
import { CommandContext, SlashCommand, CommandKind } from './ui/commands/types.js';
import { LoadedSettings } from './config/settings.js';
import { McpPromptLoader } from './services/McpPromptLoader.js';
import { BuiltinCommandLoader } from './services/BuiltinCommandLoader.js';
import { InlineCommandLoader } from './services/InlineCommandLoader.js';
import { ExtensionCommandLoader } from './services/ExtensionCommandLoader.js';
import { FileCommandLoader } from './services/FileCommandLoader.js';

/**
 * Result type for slash command preprocessing in non-interactive mode
 */
export type NonInteractiveSlashCommandResult =
  | {
      type: 'tool_call';
      toolName: string;
      toolArgs: Record<string, unknown>;
    }
  | {
      type: 'submit_prompt';
      content: string;
    }
  | {
      type: 'complete';
      success: boolean;
      message: string;
    }
  | {
      type: 'unsupported';
      reason: string;
    }
  | {
      type: 'not_slash_command';
    };

/**
 * Checks if the input is a slash command
 */
function isSlashCommand(input: string): boolean {
  return input.trim().startsWith('/');
}

/**
 * Handles slash commands in non-interactive mode
 *
 * This function processes slash commands that would normally be handled by the UI layer,
 * making them work in stream-json and other non-interactive output formats.
 *
 * @param input - The user input to process
 * @param config - The config instance
 * @param settings - The loaded settings
 * @returns Result indicating how to handle the command, or null if not a slash command
 */
export async function handleNonInteractiveSlashCommand(
  input: string,
  config: Config,
  settings: LoadedSettings,
): Promise<NonInteractiveSlashCommandResult> {
  // Quick check: is it a slash command?
  if (!isSlashCommand(input)) {
    return { type: 'not_slash_command' };
  }

  // Load available commands
  const abortController = new AbortController();
  const loaders = [
    new McpPromptLoader(config),
    new BuiltinCommandLoader(config),
    new InlineCommandLoader(config),
    new ExtensionCommandLoader(config),
    new FileCommandLoader(config),
    // Note: PluginCommandLoader is intentionally excluded here for simplicity
    // as it requires SkillLoader which may not be available in non-interactive mode
  ];
  const commandService = await CommandService.create(loaders, abortController.signal);
  const commands = commandService.getCommands();

  // Parse the command
  const trimmed = input.trim();
  const parts = trimmed.substring(1).trim().split(/\s+/);
  const commandPath = parts.filter((p) => p);

  if (commandPath.length === 0) {
    return { type: 'not_slash_command' };
  }

  // Find the command
  let currentCommands: readonly SlashCommand[] = commands;
  let commandToExecute: SlashCommand | undefined;
  let pathIndex = 0;

  for (const part of commandPath) {
    // Check for exact match on primary name
    let foundCommand = currentCommands.find((cmd) => cmd.name === part);

    // Check for alias if no primary match
    if (!foundCommand) {
      foundCommand = currentCommands.find((cmd) =>
        cmd.altNames?.includes(part),
      );
    }

    if (foundCommand) {
      commandToExecute = foundCommand;
      pathIndex++;
      if (foundCommand.subCommands) {
        currentCommands = foundCommand.subCommands;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  if (!commandToExecute) {
    return { type: 'not_slash_command' };
  }

  // Extract arguments (everything after the command path)
  const args = parts.slice(pathIndex).join(' ');

  // Create minimal command context for non-interactive mode
  // Note: Some properties are minimal/no-op since we're in non-interactive mode
  const context: CommandContext = {
    invocation: {
      raw: input,
      name: commandToExecute.name,
      args,
    },
    isNonInteractive: true, // 🆕 标记为非交互模式
    services: {
      config,
      settings,
      git: undefined, // Git service not needed in non-interactive mode
      logger: console as any, // Use console as a basic logger
    },
    ui: {
      addItem: () => 0, // No-op in non-interactive mode, returns dummy ID
      clear: () => {}, // No-op
      setDebugMessage: () => {}, // No-op
      pendingItem: null,
      setPendingItem: () => {}, // No-op
      loadHistory: () => {}, // No-op
      toggleCorgiMode: () => {}, // No-op
      toggleVimEnabled: async () => false, // No-op
      debugMessages: [],
    },
    session: {
      stats: {
        sessionStartTime: new Date(),
        metrics: {
          models: {},
          tools: {
            totalCalls: 0,
            totalSuccess: 0,
            totalFail: 0,
            totalDurationMs: 0,
            totalDecisions: {
              accept: 0,
              reject: 0,
              modify: 0,
            },
            byName: {},
          },
        },
        lastPromptTokenCount: 0,
        promptCount: 0,
        subAgentStats: {
          totalApiCalls: 0,
          totalErrors: 0,
          totalLatencyMs: 0,
          totalTokens: 0,
          promptTokens: 0,
          candidatesTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          thoughtsTokens: 0,
          toolTokens: 0,
        },
      },
      cumulativeCredits: 0,
      totalSessionCredits: 0,
      lastTokenUsage: null,
    },
  };

  try {
    // Execute the command - check if action exists
    if (!commandToExecute.action) {
      return {
        type: 'unsupported',
        reason: `Command /${commandToExecute.name} has no action handler`,
      };
    }

    const result = await commandToExecute.action(context, args);

    if (!result) {
      return {
        type: 'unsupported',
        reason: `Command /${commandToExecute.name} cannot be used in non-interactive mode (no result returned)`,
      };
    }

    // Handle different result types
    switch (result.type) {
      case 'tool':
        // This is what we want - convert to tool call
        return {
          type: 'tool_call',
          toolName: result.toolName,
          toolArgs: result.toolArgs,
        };

      case 'submit_prompt':
        // Command wants to submit a prompt instead
        return {
          type: 'submit_prompt',
          content: result.content,
        };

      case 'message':
        // 🆕 Message type is now supported - output the message and complete
        // This is useful for commands that complete asynchronously (e.g., /nanobanana)
        return {
          type: 'complete',
          success: result.messageType !== 'error',
          message: result.content,
        };

      case 'dialog':
      case 'quit':
      case 'load_history':
      case 'refine_result':
      case 'select_session':
      case 'switch_session':
        // These are UI-specific commands that don't make sense in non-interactive mode
        return {
          type: 'unsupported',
          reason: `Command /${commandToExecute.name} (${result.type}) is not supported in non-interactive mode`,
        };

      default:
        const unhandled: never = result;
        return {
          type: 'unsupported',
          reason: `Unhandled command result type: ${(unhandled as any)?.type}`,
        };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      type: 'unsupported',
      reason: `Command /${commandToExecute.name} failed: ${errorMsg}`,
    };
  }
}
