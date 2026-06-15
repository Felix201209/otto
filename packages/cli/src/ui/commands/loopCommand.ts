/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandContext,
  CommandKind,
  MessageActionReturn,
  SlashCommand,
} from './types.js';
import { MessageType } from '../types.js';

// Parse duration to milliseconds (e.g. "5m", "1h", "30s")
function parseDuration(durationStr: string): number | null {
  const match = durationStr.trim().match(/^(\d+)([smh])$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: return null;
  }
}

const rootAction = async (
  context: CommandContext,
  argsStr: string,
): Promise<MessageActionReturn> => {
  const { config } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Configuration not ready. Try again after the CLI finishes loading.',
    };
  }

  const client = config.getGeminiClient();
  const currentLoop = client?.getLoopContext();

  let expiresMs = 3 * 24 * 60 * 60 * 1000; // 3 days default max
  let cleanArgsStr = (argsStr || '').trim();

  // Parse and strip --expires option if present
  const expiresRegex = /--expires\s+(\S+)/i;
  const expiresMatch = cleanArgsStr.match(expiresRegex);
  if (expiresMatch) {
    const expiresStr = expiresMatch[1];
    const parsedExpires = parseDuration(expiresStr);
    if (parsedExpires === null) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Invalid expires duration format "${expiresStr}". Use e.g. "1h", "30m", "10s".`,
      };
    }
    expiresMs = parsedExpires;
    cleanArgsStr = cleanArgsStr.replace(expiresRegex, '').trim();
  }

  const args = cleanArgsStr ? cleanArgsStr.split(/\s+/) : [];
  if (args.length === 0) {
    if (currentLoop) {
      const remainingTime = Math.max(0, currentLoop.expiresAt - Date.now());
      const remainingMin = Math.ceil(remainingTime / 60000);
      return {
        type: 'message',
        messageType: 'info',
        content: [
          `🔄 Active Watchdog Loop:`,
          `- Prompt: "${currentLoop.prompt}"`,
          `- Interval: ${currentLoop.intervalMs / 1000}s`,
          `- Status: Running (expires in ${remainingMin} minutes)`,
          `- Started: ${new Date(currentLoop.startedAt).toLocaleTimeString()}`,
          `- Last Run: ${currentLoop.lastRunAt ? new Date(currentLoop.lastRunAt).toLocaleTimeString() : 'Never'}`,
          `\nTo stop this loop, use: /loop clear`,
        ].join('\n'),
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: [
        '🔄 /loop Watchdog Command — Schedule a recurring task in the current session.',
        'Usage:',
        '  /loop <interval> <prompt> [--expires <duration>]   - Start a watchdog loop with a lifetime limit (e.g. `--expires 1h`)',
        '  /loop clear                                        - Stop the active watchdog loop',
        '  /loop                                              - Show current loop status',
        '\nSupported intervals: s (seconds), m (minutes), h (hours). Minimum interval is 1m (60s).',
      ].join('\n'),
    };
  }

  // Parse first arg as interval
  const intervalStr = args[0];
  const intervalMs = parseDuration(intervalStr);
  if (intervalMs === null) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Invalid interval format "${intervalStr}". Use e.g. "5m", "10s", "1h".`,
    };
  }

  if (intervalMs < 60000) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Minimum loop interval is 1 minute (60s / 1m) to prevent API rate limiting and spam.',
    };
  }

  const promptText = args.slice(1).join(' ').trim();
  if (!promptText) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Prompt cannot be empty. Please specify what the loop should do (e.g. `/loop 5m run tests`).',
    };
  }

  if (!client) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Gemini client is not initialized yet.',
    };
  }

  const now = Date.now();
  const expiresAt = now + expiresMs;

  client.setLoopContext({
    prompt: promptText,
    intervalMs,
    expiresAt,
    startedAt: now,
    lastRunAt: 0, // Never run yet
    isPendingRun: false,
  });

  context.ui.addItem(
    {
      type: MessageType.INFO,
      text: `🔄 Loop scheduled! Will run "${promptText}" every ${intervalStr}. To stop, use "/loop clear".`,
    },
    Date.now(),
  );

  return {
    type: 'message',
    messageType: 'info',
    content: '🔄 Loop activated. Waiting for the first interval...',
  };
};

const clearAction = async (
  context: CommandContext,
  _argsStr: string,
): Promise<MessageActionReturn> => {
  const { config } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Configuration not ready.',
    };
  }

  const client = config.getGeminiClient();
  if (!client || !client.getLoopContext()) {
    return {
      type: 'message',
      messageType: 'info',
      content: 'No active /loop watchdog to clear.',
    };
  }

  client.clearLoopContext();

  context.ui.addItem(
    {
      type: MessageType.INFO,
      text: '🔄 Active watchdog loop cleared and stopped.',
    },
    Date.now(),
  );

  return {
    type: 'message',
    messageType: 'info',
    content: '🔄 Active /loop stopped.',
  };
};

const clearSubCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear and stop the active /loop watchdog',
  kind: CommandKind.BUILT_IN,
  action: clearAction,
};

export const loopCommand: SlashCommand = {
  name: 'loop',
  description: 'Schedule recurring prompts in the current session (e.g. /loop 5m run tests)',
  kind: CommandKind.BUILT_IN,
  action: rootAction,
  subCommands: [clearSubCommand],
};
