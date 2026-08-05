/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── Types ──

export interface CodeEditorProps {
  /** File content to edit */
  content: string;
  /** File path (for save + language detection) */
  filePath?: string;
  /** Readonly mode */
  readOnly?: boolean;
  /** Callback when save is requested */
  onSave?: (newContent: string) => void;
  /** Callback when content changes */
  onChange?: (newContent: string) => void;
}

// ── Language detection ──

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    py: 'python',
    pyi: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    svg: 'xml',
    toml: 'toml',
    ini: 'ini',
    cfg: 'ini',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    proto: 'protobuf',
    vue: 'html',
    svelte: 'html',
    md: 'markdown',
    mdx: 'markdown',
    dockerfile: 'dockerfile',
    env: 'plaintext',
    gitignore: 'plaintext',
  };
  return map[ext] ?? 'plaintext';
}

// ── Token-based syntax highlighter ──

interface Token {
  text: string;
  className?: string;
}

const KEYWORDS = new Set([
  'function', 'const', 'let', 'var', 'class', 'export', 'import', 'from',
  'return', 'if', 'else', 'async', 'await', 'for', 'while', 'switch',
  'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw',
  'new', 'typeof', 'instanceof', 'extends', 'implements', 'interface',
  'type', 'enum', 'public', 'private', 'protected', 'readonly', 'static',
  'abstract', 'def', 'lambda', 'print', 'pass', 'yield', 'raise',
  'except', 'finally', 'elif', 'True', 'False', 'None', 'and', 'or',
  'not', 'in', 'is', 'fn', 'pub', 'use', 'mod', 'impl', 'struct',
  'trait', 'match', 'where', 'unsafe', 'extern', 'mut', 'ref',
  'self', 'super', 'package', 'val', 'var', 'fun', 'object', 'sealed',
  'when', 'nil', 'do', 'end', 'begin', 'rescue', 'ensure', 'require',
  'include', 'attr_accessor', 'attr_reader', 'attr_writer',
]);

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < code.length) {
    // Single-line comment //
    if (code[i] === '/' && code[i + 1] === '/') {
      let j = i;
      while (j < code.length && code[j] !== '\n') j++;
      tokens.push({ text: code.slice(i, j), className: 'otto-ce__token-comment' });
      i = j;
      continue;
    }
    // Single-line comment #
    if (code[i] === '#') {
      let j = i;
      while (j < code.length && code[j] !== '\n') j++;
      tokens.push({ text: code.slice(i, j), className: 'otto-ce__token-comment' });
      i = j;
      continue;
    }
    // Strings
    if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
      const quote = code[i];
      let j = i + 1;
      while (j < code.length && code[j] !== quote) {
        if (code[j] === '\\') j++;
        j++;
      }
      if (j < code.length) j++; // include closing quote
      tokens.push({ text: code.slice(i, j), className: 'otto-ce__token-string' });
      i = j;
      continue;
    }
    // Multiline comments /* */
    /* istanbul ignore next */
    if (code[i] === '/' && code[i + 1] === '*') {
      let j = i;
      while (j < code.length - 1 && !(code[j] === '*' && code[j + 1] === '/')) j++;
      if (j < code.length - 1) j += 2;
      tokens.push({ text: code.slice(i, j + 1), className: 'otto-ce__token-comment' });
      i = j + 1;
      continue;
    }
    // Keywords
    if (/^[a-zA-Z_$]/.test(code[i])) {
      let j = i;
      while (j < code.length && /^[a-zA-Z0-9_$]$/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (KEYWORDS.has(word)) {
        tokens.push({ text: word, className: 'otto-ce__token-keyword' });
      } else {
        tokens.push({ text: word });
      }
      i = j;
      continue;
    }
    // Numbers
    if (/^[0-9]/.test(code[i])) {
      let j = i;
      while (j < code.length && /^[0-9a-fA-FxXoO._eE+-]$/.test(code[j])) j++;
      tokens.push({ text: code.slice(i, j), className: 'otto-ce__token-number' });
      i = j;
      continue;
    }

    tokens.push({ text: code[i] });
    i++;
  }

  return tokens;
}

// ── Component ──

export function CodeEditor({
  content,
  filePath,
  readOnly = false,
  onSave,
  onChange,
}: CodeEditorProps): React.JSX.Element {
  const [editedContent, setEditedContent] = useState(content);
  const [saved, setSaved] = useState(false);
  const [modified, setModified] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousContentRef = useRef(content);
  const lineCount = useMemo(() => editedContent.split('\n').length, [editedContent]);
  const language = useMemo(() => (filePath ? detectLanguage(filePath) : 'plaintext'), [filePath]);

  useEffect(() => {
    if (previousContentRef.current === content) return;
    previousContentRef.current = content;
    setEditedContent(content);
    setModified(false);
    setSaved(false);
  }, [content]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value;
      setEditedContent(newContent);
      setModified(newContent !== content);
      setSaved(false);
      if (onChange) onChange(newContent);
    },
    [content, onChange],
  );

  const handleSave = useCallback(() => {
    if (onSave) {
      onSave(editedContent);
      setSaved(true);
      setModified(false);
    }
  }, [editedContent, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl+S / Cmd+S to save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!readOnly && modified) handleSave();
      }
      // Tab to insert spaces
      if (e.key === 'Tab') {
        e.preventDefault();
        const textarea = e.currentTarget as HTMLTextAreaElement;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const newContent =
          editedContent.substring(0, start) + '  ' + editedContent.substring(end);
        setEditedContent(newContent);
        setModified(newContent !== content);
        // Restore cursor position
        requestAnimationFrame(() => {
          textarea.selectionStart = start + 2;
          textarea.selectionEnd = start + 2;
        });
      }
    },
    [readOnly, modified, editedContent, content, handleSave],
  );

  // Syntax highlighted overlay tokens
  const highlightedTokens = useMemo(() => tokenize(editedContent), [editedContent]);

  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'),
    [lineCount],
  );

  return (
    <div className="otto-ce">
      {/* Toolbar */}
      <div className="otto-ce__toolbar">
        <span className="otto-ce__filename">
          {filePath ? (
            <>
              <span className="otto-ce__lang-badge">{language}</span>
              {filePath}
            </>
          ) : (
            '未命名文件'
          )}
        </span>
        <span className="otto-ce__actions">
          {saved ? <span className="otto-ce__saved">✅ 已保存</span> : null}
          {modified ? <span className="otto-ce__modified">已修改</span> : null}
          {!readOnly ? (
            <button
              type="button"
              className="otto-ce__save-btn"
              disabled={!modified}
              onClick={handleSave}
            >
              保存 💾
            </button>
          ) : null}
        </span>
      </div>

      {/* Editor area */}
      <div className="otto-ce__editor">
        {/* Line numbers gutter */}
        <div className="otto-ce__gutter">
          <pre className="otto-ce__linenums">{lineNumbers}</pre>
        </div>

        {/* Code editing area */}
        <div className="otto-ce__code-area">
          {/* Highlighting overlay (behind textarea) */}
          <pre className="otto-ce__highlight" aria-hidden="true">
            <code>
              {highlightedTokens.map((token, idx) =>
                token.className ? (
                  <span key={idx} className={token.className}>
                    {token.text}
                  </span>
                ) : (
                  <React.Fragment key={idx}>{token.text}</React.Fragment>
                ),
              )}
            </code>
          </pre>

          {/* Actual textarea */}
          <textarea
            ref={textareaRef}
            className="otto-ce__textarea"
            value={editedContent}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            readOnly={readOnly}
            spellCheck={false}
            aria-label={filePath ? `编辑 ${filePath}` : '代码编辑器'}
          />
        </div>
      </div>

      {/* Status bar */}
      <div className="otto-ce__statusbar">
        <span>行 {lineCount}</span>
        <span>{editedContent.length} 字符</span>
        {readOnly ? <span>只读</span> : null}
      </div>
    </div>
  );
}
