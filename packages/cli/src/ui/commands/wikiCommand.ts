/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CommandKind,
  SlashCommand,
  SlashCommandActionReturn,
  CommandContext,
} from './types.js';
import { MessageType } from '../types.js';
import { t } from '../utils/i18n.js';
import {
  WIKI_DIR,
  WIKI_RAW_DIR,
  WIKI_PAGES_DIR,
  WIKI_INDEX,
  WIKI_LOG,
  WIKI_INIT_PROMPT,
  getWikiIngestPrompt,
  WIKI_INGEST_ALL_PROMPT,
  getWikiQueryPrompt,
  WIKI_LINT_PROMPT,
} from './prompts/wikiPrompts.js';

/** Resolve wiki paths relative to the project root */
function getWikiPaths(context: CommandContext) {
  const targetDir = context.services.config?.getTargetDir() || process.cwd();
  return {
    root: path.join(targetDir, WIKI_DIR),
    raw: path.join(targetDir, WIKI_RAW_DIR),
    wiki: path.join(targetDir, WIKI_PAGES_DIR),
    index: path.join(targetDir, WIKI_INDEX),
    log: path.join(targetDir, WIKI_LOG),
  };
}

/** Check if the wiki has been initialized */
function isWikiInitialized(context: CommandContext): boolean {
  const paths = getWikiPaths(context);
  return fs.existsSync(paths.index) && fs.existsSync(paths.log);
}

// ── Sub-commands ────────────────────────────────────────────────

const initSubCommand: SlashCommand = {
  name: 'init',
  description: t('command.wiki.init.description'),
  kind: CommandKind.BUILT_IN,
  action: async (context): Promise<SlashCommandActionReturn> => {
    if (isWikiInitialized(context)) {
      const paths = getWikiPaths(context);
      return {
        type: 'message',
        messageType: 'info',
        content: t('wiki.init.alreadyExists').replace('{path}', paths.root),
      };
    }
    context.ui.addItem(
      { type: MessageType.INFO, text: t('wiki.init.starting') },
      Date.now(),
    );
    return { type: 'submit_prompt', content: WIKI_INIT_PROMPT, silent: true };
  },
};

const ingestSubCommand: SlashCommand = {
  name: 'ingest',
  description: t('command.wiki.ingest.description'),
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    if (!isWikiInitialized(context)) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('wiki.notInitialized'),
      };
    }

    // No args → ingest all un-ingested files in raw/
    if (!args || args.trim() === '') {
      const paths = getWikiPaths(context);
      let rawCount = 0;
      try {
        const files = fs.readdirSync(paths.raw);
        rawCount = files.filter(f => !f.startsWith('.')).length;
      } catch {
        // ignore
      }
      if (rawCount === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: t('wiki.ingest.rawEmpty'),
        };
      }
      context.ui.addItem(
        { type: MessageType.INFO, text: t('wiki.ingest.startingAll').replace('{count}', String(rawCount)) },
        Date.now(),
      );
      return {
        type: 'submit_prompt',
        content: WIKI_INGEST_ALL_PROMPT,
        silent: true,
      };
    }

    context.ui.addItem(
      { type: MessageType.INFO, text: t('wiki.ingest.starting').replace('{path}', args.trim()) },
      Date.now(),
    );
    return {
      type: 'submit_prompt',
      content: getWikiIngestPrompt(args.trim()),
      silent: true,
    };
  },
};

const querySubCommand: SlashCommand = {
  name: 'query',
  altNames: ['q', 'ask'],
  description: t('command.wiki.query.description'),
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    if (!isWikiInitialized(context)) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('wiki.notInitialized'),
      };
    }
    if (!args || args.trim() === '') {
      return {
        type: 'message',
        messageType: 'error',
        content: t('wiki.query.usage'),
      };
    }
    context.ui.addItem(
      { type: MessageType.INFO, text: t('wiki.query.searching').replace('{question}', args.trim()) },
      Date.now(),
    );
    return {
      type: 'submit_prompt',
      content: getWikiQueryPrompt(args.trim()),
      silent: true,
    };
  },
};

const lintSubCommand: SlashCommand = {
  name: 'lint',
  description: t('command.wiki.lint.description'),
  kind: CommandKind.BUILT_IN,
  action: async (context): Promise<SlashCommandActionReturn> => {
    if (!isWikiInitialized(context)) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('wiki.notInitialized'),
      };
    }
    context.ui.addItem(
      { type: MessageType.INFO, text: t('wiki.lint.starting') },
      Date.now(),
    );
    return { type: 'submit_prompt', content: WIKI_LINT_PROMPT, silent: true };
  },
};

const statusSubCommand: SlashCommand = {
  name: 'status',
  description: t('command.wiki.status.description'),
  kind: CommandKind.BUILT_IN,
  action: async (context): Promise<void> => {
    const paths = getWikiPaths(context);

    if (!isWikiInitialized(context)) {
      context.ui.addItem(
        { type: MessageType.INFO, text: t('wiki.status.notInitialized') },
        Date.now(),
      );
      return;
    }

    // Count pages
    let pageCount = 0;
    let sourceCount = 0;
    try {
      const files = fs.readdirSync(paths.wiki);
      for (const f of files) {
        if (f.endsWith('.md')) {
          pageCount++;
          if (f.startsWith('source-')) sourceCount++;
        }
      }
    } catch {
      // directory might not exist yet
    }

    // Count raw sources
    let rawCount = 0;
    try {
      const raws = fs.readdirSync(paths.raw);
      rawCount = raws.length;
    } catch {
      // directory might not exist yet
    }

    // Read last log entries
    let lastEntries = '';
    try {
      const logContent = fs.readFileSync(paths.log, 'utf8');
      const entries = logContent.match(/^## \[.+$/gm) || [];
      const recent = entries.slice(-5);
      lastEntries = recent.length > 0
        ? recent.join('\n')
        : t('wiki.status.noLogEntries');
    } catch {
      lastEntries = t('wiki.status.noLogEntries');
    }

    const statusText = [
      `📚 **LLM Wiki Status**`,
      ``,
      `Path: \`${paths.root}\``,
      `Wiki pages: ${pageCount} (${sourceCount} source summaries)`,
      `Raw sources: ${rawCount}`,
      ``,
      `**Recent activity:**`,
      lastEntries,
    ].join('\n');

    context.ui.addItem({ type: MessageType.INFO, text: statusText }, Date.now());
  },
};

const logSubCommand: SlashCommand = {
  name: 'log',
  description: t('command.wiki.log.description'),
  kind: CommandKind.BUILT_IN,
  action: async (context): Promise<void> => {
    const paths = getWikiPaths(context);

    if (!isWikiInitialized(context)) {
      context.ui.addItem(
        { type: MessageType.INFO, text: t('wiki.status.notInitialized') },
        Date.now(),
      );
      return;
    }

    try {
      const logContent = fs.readFileSync(paths.log, 'utf8');
      context.ui.addItem(
        { type: MessageType.INFO, text: logContent },
        Date.now(),
      );
    } catch {
      context.ui.addItem(
        { type: MessageType.ERROR, text: t('wiki.log.readError') },
        Date.now(),
      );
    }
  },
};

// ── Parent command ──────────────────────────────────────────────

export const wikiCommand: SlashCommand = {
  name: 'wiki',
  description: t('command.wiki.description'),
  kind: CommandKind.BUILT_IN,
  subCommands: [
    initSubCommand,
    ingestSubCommand,
    querySubCommand,
    lintSubCommand,
    statusSubCommand,
    logSubCommand,
  ],
};
