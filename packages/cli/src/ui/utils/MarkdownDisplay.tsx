/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text, Box } from 'ink';
import stringWidth from 'string-width';
import { Colors } from '../colors.js';
import { t } from '../utils/i18n.js';
import { colorizeCode } from './CodeColorizer.js';
import { TableRenderer } from './TableRenderer.js';
import { RenderInline } from './InlineMarkdownRenderer.js';

interface MarkdownDisplayProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
}

// Constants for Markdown parsing and rendering

const EMPTY_LINE_HEIGHT = 1;
const CODE_BLOCK_PREFIX_PADDING = 1;
const LIST_ITEM_PREFIX_PADDING = 1;
const LIST_ITEM_TEXT_FLEX_GROW = 1;

// Known language identifiers accepted on a fenced code block opener.
// Keep lowercase. Includes lowlight `common` languages plus popular aliases
// LLMs frequently emit (sh/zsh/dart/tsx/jsx/text/c++/c#/etc.). Tokens NOT in
// this set are treated as glued body content rather than as a language tag —
// this protects against malformed openers like ```bashopen,  ```Unable to ...
// observed in production user bug reports.
const KNOWN_FENCE_LANGS = new Set<string>([
  // lowlight "common" set
  'arduino', 'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'go', 'graphql',
  'ini', 'java', 'javascript', 'json', 'kotlin', 'less', 'lua', 'makefile',
  'markdown', 'objectivec', 'perl', 'php', 'php-template', 'plaintext',
  'python', 'python-repl', 'r', 'ruby', 'rust', 'scss', 'shell', 'sql',
  'swift', 'typescript', 'vbnet', 'wasm', 'xml', 'yaml',
  // Common aliases / extensions
  'js', 'jsx', 'ts', 'tsx', 'sh', 'zsh', 'fish', 'powershell', 'ps1', 'pwsh',
  'bat', 'cmd', 'cs', 'fs', 'fsharp', 'kt', 'kts', 'rb', 'py', 'rs', 'dart',
  'flutter', 'dockerfile', 'docker', 'toml', 'csv', 'tsv', 'log', 'md', 'mdx',
  'html', 'htm', 'svg', 'vue', 'svelte', 'astro', 'tex', 'latex', 'bibtex',
  'asm', 'nasm', 'gas', 'vim', 'viml', 'lisp', 'clojure', 'clj', 'cljs',
  'elixir', 'ex', 'exs', 'erlang', 'erl', 'haskell', 'hs', 'ocaml', 'ml',
  'scala', 'groovy', 'gradle', 'cmake', 'mermaid', 'plantuml', 'graphviz',
  'dot', 'protobuf', 'proto', 'thrift', 'capnp', 'nginx', 'apache', 'caddy',
  'env', 'conf', 'config', 'properties', 'gitignore', 'gitconfig',
  // Generic/text-y
  'text', 'plain', 'plaintext', 'txt', 'console', 'output', 'terminal',
  'c++', 'c#', 'obj-c', 'objective-c',
]);

// Sorted descending by length: needed for longest-known-prefix matching so
// that e.g. "javascript" is matched before "java", "typescript" before "ts".
const KNOWN_FENCE_LANGS_BY_LEN = [...KNOWN_FENCE_LANGS].sort(
  (a, b) => b.length - a.length,
);

/**
 * When the LLM glued the first body token onto the language tag (e.g.
 * ```bashopen, ```textci, ```bash.), try to recover the real language by
 * matching the LONGEST known language as a prefix of the captured token.
 * Returns { lang, leftover } where `leftover` should be re-glued onto the
 * body. Returns null if no known language is a prefix.
 */
function splitGluedLang(token: string): { lang: string; leftover: string } | null {
  if (!token) return null;
  const lower = token.toLowerCase();
  for (const known of KNOWN_FENCE_LANGS_BY_LEN) {
    if (lower.startsWith(known) && lower.length > known.length) {
      return { lang: token.slice(0, known.length), leftover: token.slice(known.length) };
    }
  }
  return null;
}

const MarkdownDisplayInternal: React.FC<MarkdownDisplayProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  terminalWidth,
}) => {
  if (!text) return <></>;

  // Normalize CRLF (and bare CR) so downstream split('\n') works on Windows-origin streams.
  // Also recover from JSON-escape leaks where "\n" was emitted as a literal backslash-n
  // immediately after a fence opener (e.g. ```bash\nchmod 600 ...). We unescape only
  // when the literal \n appears within the same line as the fence opener — never in arbitrary
  // body content — to avoid corrupting genuine "\n" characters discussed in prose.
  const normalizedText = text
    .replace(/\r\n?/g, '\n')
    .replace(/^( *(?:`{3,}|~{3,})[^\n]*?)\\n/gm, '$1\n');

  const lines = normalizedText.split('\n');
  const headerRegex = /^ *(#{1,4}) +(.*)/;
  // Fenced code block opener:
  //   group 1: fence run (``` or ~~~ or longer)
  //   group 2: language identifier — restricted to chars typically seen in
  //            language names. We accept letters, digits, underscore, plus,
  //            hash and hyphen. We deliberately EXCLUDE '.' and '/' so that
  //            ```bash./ci/x.sh is parsed with lang="bash" and the rest
  //            captured into group 3 as glued content.
  //   group 3: trailing content glued on the same line — recovered as the first body line.
  // The closing-fence check (in `inCodeBlock` branch below) requires group 3 to be empty,
  // so this relaxed regex does not accidentally swallow lines that look like fences but
  // carry trailing content inside an open block.
  const codeFenceRegex =
    /^ *(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#-]*)[ \t]*(.*?)[ \t]*$/;
  const ulItemRegex = /^([ \t]*)([-*+]) +(.*)/;
  const olItemRegex = /^([ \t]*)(\d+)\. +(.*)/;
  const hrRegex = /^ *([-*_] *){3,} *$/;
  const tableRowRegex = /^\s*\|(.+)\|\s*$/;
  const tableSeparatorRegex = /^\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)+\|?\s*$/;
  const thinkStartRegex = /<think>/i;
  const thinkEndRegex = /<\/think>/i;

  const contentBlocks: React.ReactNode[] = [];
  let inCodeBlock = false;
  let lastLineEmpty = true;
  let codeBlockContent: string[] = [];
  let codeBlockLang: string | null = null;
  let codeBlockFence = '';
  let inThinkBlock = false;
  let thinkBlockContent: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];
  let tableHeaders: string[] = [];
  let isTruncated = false;

  function addContentBlock(block: React.ReactNode) {
    if (isTruncated) return;

    // Simple truncation for pending messages to prevent screen flickering
    // We use a rough estimate: 1 block ~= 1 line (though some blocks are larger)
    // This prevents the UI from growing indefinitely during generation
    if (isPending && availableTerminalHeight && contentBlocks.length >= availableTerminalHeight) {
      isTruncated = true;
      contentBlocks.push(
        <Box key="truncation-indicator" paddingLeft={1}>
          <Text color={Colors.Gray}>... generating ...</Text>
        </Box>
      );
      return;
    }

    if (block) {
      contentBlocks.push(block);
      lastLineEmpty = false;
    }
  }

  lines.forEach((line, index) => {
    if (isTruncated) return;
    const key = `line-${index}`;

    if (inCodeBlock) {
      const fenceMatch = line.match(codeFenceRegex);
      // Closing fence requirements:
      //   * Same fence char family (``` vs ~~~).
      //   * Fence run length >= the opening run length.
      //   * No trailing content glued on the same line — otherwise this is just a body line
      //     that happens to contain backticks (e.g. ` ```bash some code `).
      if (
        fenceMatch &&
        fenceMatch[1].startsWith(codeBlockFence[0]) &&
        fenceMatch[1].length >= codeBlockFence.length &&
        (fenceMatch[3] ?? '').trim() === ''
      ) {
        addContentBlock(
          <RenderCodeBlock
            key={key}
            content={codeBlockContent}
            lang={codeBlockLang}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            terminalWidth={terminalWidth}
          />,
        );
        inCodeBlock = false;
        codeBlockContent = [];
        codeBlockLang = null;
        codeBlockFence = '';
      } else {
        codeBlockContent.push(line);
      }
      return;
    }

    if (inThinkBlock) {
      const endMatch = line.match(thinkEndRegex);
      if (endMatch) {
        const endTagIndex = line.toLowerCase().indexOf('</think>');
        const beforeTag = line.substring(0, endTagIndex);
        const afterTag = line.substring(endTagIndex + 8);

        if (beforeTag) thinkBlockContent.push(beforeTag);

        addContentBlock(
          <RenderThinkBlock
            key={key}
            content={thinkBlockContent}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            terminalWidth={terminalWidth}
          />,
        );

        inThinkBlock = false;
        thinkBlockContent = [];

        if (afterTag.trim()) {
          addContentBlock(
            <Box key={`${key}-after`}>
              <Text wrap="wrap">
                <RenderInline text={afterTag} />
              </Text>
            </Box>,
          );
        }
      } else {
        thinkBlockContent.push(line);
      }
      return;
    }

    const codeFenceMatch = line.match(codeFenceRegex);
    const thinkStartMatch = line.match(thinkStartRegex);
    const headerMatch = line.match(headerRegex);
    const ulMatch = line.match(ulItemRegex);
    const olMatch = line.match(olItemRegex);
    const hrMatch = line.match(hrRegex);
    const tableRowMatch = line.match(tableRowRegex);
    const tableSeparatorMatch = line.match(tableSeparatorRegex);

    if (codeFenceMatch) {
      const fenceRun = codeFenceMatch[1];
      const fenceChar = fenceRun[0];
      let lang = codeFenceMatch[2] || '';
      let remainder = codeFenceMatch[3] ?? '';

      // Heuristic: only trust the captured token as a language if it is in the
      // known-language allowlist. Otherwise try to split it as
      // "<known-language>+<glued body prefix>" (e.g. "bashopen" → "bash"+"open",
      // "textci" → "text"+"ci"). If neither works, push the whole token back
      // into the body. This protects against real-world LLM outputs observed
      // in production user reports where the model glued the first line of
      // code onto the fence opener with no separator.
      if (lang) {
        const normalized = lang.toLowerCase();
        if (!KNOWN_FENCE_LANGS.has(normalized)) {
          const split = splitGluedLang(lang);
          if (split) {
            // "bashopen" → lang="bash", leftover="open" — re-glue leftover to
            // the front of remainder. Insert a space ONLY if remainder doesn't
            // already start with a separator (whitespace or path char) — many
            // real LLM outputs are like "bashopen ios/foo" where remainder
            // already has its own leading space, so adding another would be wrong.
            const needsSpace =
              remainder.length > 0 && !/^[\s/.]/.test(remainder);
            remainder = remainder.length > 0
              ? `${split.leftover}${needsSpace ? ' ' : ''}${remainder}`
              : split.leftover;
            lang = split.lang;
          } else {
            // "Unable to install..." → no known prefix, push whole token back.
            const needsSpace =
              remainder.length > 0 && !/^[\s/.]/.test(remainder);
            remainder = remainder.length > 0
              ? `${lang}${needsSpace ? ' ' : ''}${remainder}`
              : lang;
            lang = '';
          }
        }
      }

      // Same-line closing fence: ```bash...``` (no newline anywhere).
      // Detect ≥-fence-length run of the same fence char at the END of remainder.
      // If found, emit the code block immediately and DON'T enter inCodeBlock state.
      const closerPattern = new RegExp(
        `^(.*?)\\s*(${fenceChar === '`' ? '`' : '~'}{${fenceRun.length},})\\s*$`,
      );
      const closedMatch = remainder ? remainder.match(closerPattern) : null;

      if (closedMatch) {
        // Single-line fenced block: render and stay out of code-block state.
        const innerBody = closedMatch[1] ?? '';
        addContentBlock(
          <RenderCodeBlock
            key={key}
            content={innerBody.length > 0 ? [innerBody] : []}
            lang={lang || null}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            terminalWidth={terminalWidth}
          />,
        );
        // Do NOT set inCodeBlock — this fence is already closed.
      } else {
        inCodeBlock = true;
        codeBlockFence = fenceRun;
        codeBlockLang = lang || null;
        // Defensive: if the LLM glued the first code line onto the fence opener
        // (e.g. ```text/Users/foo or after a JSON-escaped "\n" leak that we already
        // normalized above), recover that glued tail as the first body line so
        // it is rendered as code, not paragraph text.
        if (remainder.length > 0) {
          codeBlockContent.push(remainder);
        }
      }
    } else if (thinkStartMatch) {
      const startTagIndex = line.toLowerCase().indexOf('<think>');
      const beforeTag = line.substring(0, startTagIndex);
      const afterTag = line.substring(startTagIndex + 7);

      if (beforeTag.trim()) {
        addContentBlock(
          <Box key={`${key}-before`}>
            <Text wrap="wrap">
              <RenderInline text={beforeTag} />
            </Text>
          </Box>,
        );
      }

      inThinkBlock = true;
      const endTagIndex = afterTag.toLowerCase().indexOf('</think>');
      if (endTagIndex !== -1) {
        const thinkContent = afterTag.substring(0, endTagIndex);
        const remaining = afterTag.substring(endTagIndex + 8);

        addContentBlock(
          <RenderThinkBlock
            key={key}
            content={[thinkContent]}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            terminalWidth={terminalWidth}
          />,
        );
        inThinkBlock = false;

        if (remaining.trim()) {
          addContentBlock(
            <Box key={`${key}-after`}>
              <Text wrap="wrap">
                <RenderInline text={remaining} />
              </Text>
            </Box>,
          );
        }
      } else {
        if (afterTag) thinkBlockContent.push(afterTag);
      }
    } else if (tableRowMatch && !inTable) {
      // Potential table start - check if next line is separator
      if (
        index + 1 < lines.length &&
        lines[index + 1].match(tableSeparatorRegex)
      ) {
        inTable = true;
        tableHeaders = tableRowMatch[1].split('|').map((cell) => cell.trim());
        tableRows = [];
      } else {
        // Not a table, treat as regular text
        addContentBlock(
          <Box key={key}>
            <Text wrap="wrap">
              <RenderInline text={line} />
            </Text>
          </Box>,
        );
      }
    } else if (inTable && tableSeparatorMatch) {
      // Skip separator line - already handled
    } else if (inTable && tableRowMatch) {
      // Add table row
      const cells = tableRowMatch[1].split('|').map((cell) => cell.trim());
      // Ensure row has same column count as headers
      while (cells.length < tableHeaders.length) {
        cells.push('');
      }
      if (cells.length > tableHeaders.length) {
        cells.length = tableHeaders.length;
      }
      tableRows.push(cells);
    } else if (inTable && !tableRowMatch) {
      // End of table
      if (tableHeaders.length > 0 && tableRows.length > 0) {
        addContentBlock(
          <RenderTable
            key={`table-${contentBlocks.length}`}
            headers={tableHeaders}
            rows={tableRows}
            terminalWidth={terminalWidth}
          />,
        );
      }
      inTable = false;
      tableRows = [];
      tableHeaders = [];

      // Process current line as normal
      if (line.trim().length > 0) {
        addContentBlock(
          <Box key={key}>
            <Text wrap="wrap">
              <RenderInline text={line} />
            </Text>
          </Box>,
        );
      }
    } else if (hrMatch) {
      addContentBlock(
        <Box key={key}>
          <Text dimColor>---</Text>
        </Box>,
      );
    } else if (headerMatch) {
      const level = headerMatch[1].length;
      const headerText = headerMatch[2];
      let headerNode: React.ReactNode = null;
      switch (level) {
        case 1:
          headerNode = (
            <Text bold color={Colors.AccentCyan}>
              <RenderInline text={headerText} />
            </Text>
          );
          break;
        case 2:
          headerNode = (
            <Text bold color={Colors.AccentBlue}>
              <RenderInline text={headerText} />
            </Text>
          );
          break;
        case 3:
          headerNode = (
            <Text bold>
              <RenderInline text={headerText} />
            </Text>
          );
          break;
        case 4:
          headerNode = (
            <Text italic color={Colors.Gray}>
              <RenderInline text={headerText} />
            </Text>
          );
          break;
        default:
          headerNode = (
            <Text>
              <RenderInline text={headerText} />
            </Text>
          );
          break;
      }
      if (headerNode) addContentBlock(<Box key={key}>{headerNode}</Box>);
    } else if (ulMatch) {
      const leadingWhitespace = ulMatch[1];
      const marker = ulMatch[2];
      const itemText = ulMatch[3];
      addContentBlock(
        <RenderListItem
          key={key}
          itemText={itemText}
          type="ul"
          marker={marker}
          leadingWhitespace={leadingWhitespace}
        />,
      );
    } else if (olMatch) {
      const leadingWhitespace = olMatch[1];
      const marker = olMatch[2];
      const itemText = olMatch[3];
      addContentBlock(
        <RenderListItem
          key={key}
          itemText={itemText}
          type="ol"
          marker={marker}
          leadingWhitespace={leadingWhitespace}
        />,
      );
    } else {
      if (line.trim().length === 0 && !inCodeBlock) {
        if (!lastLineEmpty) {
          contentBlocks.push(
            <Box key={`spacer-${index}`} height={EMPTY_LINE_HEIGHT} />,
          );
          lastLineEmpty = true;
        }
      } else {
        addContentBlock(
          <Box key={key} width={terminalWidth} flexShrink={0}>
            <Text wrap="wrap">
              <RenderInline text={line} />
            </Text>
          </Box>,
        );
      }
    }
  });

  if (inCodeBlock) {
    addContentBlock(
      <RenderCodeBlock
        key="line-eof"
        content={codeBlockContent}
        lang={codeBlockLang}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        terminalWidth={terminalWidth}
      />,
    );
  }

  if (inThinkBlock) {
    addContentBlock(
      <RenderThinkBlock
        key="think-eof"
        content={thinkBlockContent}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        terminalWidth={terminalWidth}
      />,
    );
  }

  // Handle table at end of content
  if (inTable && tableHeaders.length > 0 && tableRows.length > 0) {
    addContentBlock(
      <RenderTable
        key={`table-${contentBlocks.length}`}
        headers={tableHeaders}
        rows={tableRows}
        terminalWidth={terminalWidth}
      />,
    );
  }

  return <>{contentBlocks}</>;
};

// Helper functions (adapted from static methods of MarkdownRenderer)

interface RenderThinkBlockProps {
  content: string[];
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
}

const RenderThinkBlockInternal: React.FC<RenderThinkBlockProps> = ({
  content,
  isPending,
  availableTerminalHeight,
  terminalWidth,
}) => {
  const lineChar = '─';
  const label = t('model.reasoning');
  const labelWidth = stringWidth(label) + 1; // label + space
  const remainingWidth = Math.max(0, terminalWidth - labelWidth - 2);

  // If pending, only show the last few lines to keep UI responsive
  let displayLines = content;
  const MAX_LINES_WHEN_PENDING = availableTerminalHeight
    ? Math.max(2, Math.floor(availableTerminalHeight * 0.3))
    : 10;

  if (isPending && content.length > MAX_LINES_WHEN_PENDING) {
    displayLines = content.slice(-MAX_LINES_WHEN_PENDING);
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Box flexDirection="row" alignItems="center" width={terminalWidth}>
        <Text color={Colors.AccentBlue} bold>
          {label}{' '}
        </Text>
        <Text color={Colors.Gray}>
          {lineChar.repeat(remainingWidth)}
        </Text>
      </Box>
      <Box paddingX={1} flexDirection="column" width={terminalWidth}>
        {displayLines.map((line, idx) => {
          const ulMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
          const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);

          if (ulMatch) {
            const leadingWhitespace = ulMatch[1];
            const marker = ulMatch[2];
            const itemText = ulMatch[3];
            return (
              <Box key={idx} marginLeft={leadingWhitespace.length}>
                <Text color={Colors.Comment} italic>
                  {marker}{' '}
                  <RenderInline text={itemText} />
                </Text>
              </Box>
            );
          }

          if (olMatch) {
            const leadingWhitespace = olMatch[1];
            const num = olMatch[2];
            const itemText = olMatch[3];
            return (
              <Box key={idx} marginLeft={leadingWhitespace.length}>
                <Text color={Colors.Comment} italic>
                  {num}.{' '}
                  <RenderInline text={itemText} />
                </Text>
              </Box>
            );
          }

          return (
            <Box key={idx}>
              <Text color={Colors.Comment} italic wrap="wrap">
                <RenderInline text={line} />
              </Text>
            </Box>
          );
        })}
        {isPending ? (
          <Text color={Colors.Comment}>
            ...
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="row" alignItems="center" width={terminalWidth}>
        <Text color={Colors.Gray}>
          {lineChar.repeat(terminalWidth - 1)}
        </Text>
      </Box>
    </Box>
  );
};

const RenderThinkBlock = React.memo(RenderThinkBlockInternal);

interface RenderCodeBlockProps {
  content: string[];
  lang: string | null;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
}

const RenderCodeBlockInternal: React.FC<RenderCodeBlockProps> = ({
  content,
  lang,
  isPending,
  availableTerminalHeight,
  terminalWidth,
}) => {
  const MIN_LINES_FOR_MESSAGE = 1; // Minimum lines to show before the "generating more" message
  const RESERVED_LINES = 2; // Lines reserved for the message itself and potential padding

  if (isPending && availableTerminalHeight !== undefined) {
    const MAX_CODE_LINES_WHEN_PENDING = Math.max(
      0,
      availableTerminalHeight - RESERVED_LINES,
    );

    if (content.length > MAX_CODE_LINES_WHEN_PENDING) {
      if (MAX_CODE_LINES_WHEN_PENDING < MIN_LINES_FOR_MESSAGE) {
        // Not enough space to even show the message meaningfully
        return (
          <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING}>
            <Text color={Colors.Gray}>... code is being written ...</Text>
          </Box>
        );
      }
      const truncatedContent = content.slice(0, MAX_CODE_LINES_WHEN_PENDING);
      const colorizedTruncatedCode = colorizeCode(
        truncatedContent.join('\n'),
        lang,
        availableTerminalHeight,
        terminalWidth - CODE_BLOCK_PREFIX_PADDING,
      );
      return (
        <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING} flexDirection="column">
          {colorizedTruncatedCode}
          <Text color={Colors.Gray}>... generating more ...</Text>
        </Box>
      );
    }
  }

  const fullContent = content.join('\n');
  const colorizedCode = colorizeCode(
    fullContent,
    lang,
    availableTerminalHeight,
    terminalWidth - CODE_BLOCK_PREFIX_PADDING,
  );

  return (
    <Box
      paddingLeft={CODE_BLOCK_PREFIX_PADDING}
      flexDirection="column"
      width={terminalWidth}
      flexShrink={0}
    >
      {colorizedCode}
    </Box>
  );
};

const RenderCodeBlock = React.memo(RenderCodeBlockInternal);

interface RenderListItemProps {
  itemText: string;
  type: 'ul' | 'ol';
  marker: string;
  leadingWhitespace?: string;
}

const RenderListItemInternal: React.FC<RenderListItemProps> = ({
  itemText,
  type,
  marker,
  leadingWhitespace = '',
}) => {
  const prefix = type === 'ol' ? `${marker}. ` : `${marker} `;
  const prefixWidth = prefix.length;
  const indentation = leadingWhitespace.length;

  return (
    <Box
      paddingLeft={indentation + LIST_ITEM_PREFIX_PADDING}
      flexDirection="row"
    >
      <Box width={prefixWidth}>
        <Text>{prefix}</Text>
      </Box>
      <Box flexGrow={LIST_ITEM_TEXT_FLEX_GROW}>
        <Text wrap="wrap">
          <RenderInline text={itemText} />
        </Text>
      </Box>
    </Box>
  );
};

const RenderListItem = React.memo(RenderListItemInternal);

interface RenderTableProps {
  headers: string[];
  rows: string[][];
  terminalWidth: number;
}

const RenderTableInternal: React.FC<RenderTableProps> = ({
  headers,
  rows,
  terminalWidth,
}) => (
  <TableRenderer headers={headers} rows={rows} terminalWidth={terminalWidth} />
);

const RenderTable = React.memo(RenderTableInternal);

export const MarkdownDisplay = React.memo(MarkdownDisplayInternal);
