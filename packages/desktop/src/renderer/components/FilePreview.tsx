/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';

// ── Types ──

export interface FileEntry {
  /** Unique key for the list */
  id: string;
  /** Display name */
  name: string;
  /** Absolute or relative path */
  path: string;
  /** File content as text (if available) */
  content?: string;
  /** MIME type hint */
  mimeType?: string;
  /** File size in bytes */
  size?: number;
  /** Source: tool result or message attachment */
  source?: string;
}

function inferCategory(file: FileEntry): 'image' | 'markdown' | 'code' | 'pdf' | 'text' {
  const name = file.name.toLowerCase();
  const mime = file.mimeType?.toLowerCase() ?? '';

  if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/.test(name) || mime.startsWith('image/')) {
    return 'image';
  }
  if (/\.(md|mdx)$/.test(name) || mime === 'text/markdown') {
    return 'markdown';
  }
  if (/\.pdf$/.test(name) || mime === 'application/pdf') {
    return 'pdf';
  }
  if (
    /\.(tsx?|jsx?|json|css|html?|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sh|bash|zsh|yaml|yml|xml|toml|ini|cfg|sql|graphql|proto|vue|svelte)$/.test(
      name,
    )
  ) {
    return 'code';
  }
  return 'text';
}

// ── Simple Markdown Renderer (no external dependency) ──

function renderMarkdown(md: string): string {
  // A minimal markdown-to-HTML converter
  let html = md
    // Escape HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="otto-file-preview__inline-code">$1</code>')
    // Images
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:6px;" />')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // Headings
    .replace(/^#### (.+)$/gm, '<h4 class="otto-file-preview__h4">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 class="otto-file-preview__h3">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="otto-file-preview__h2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="otto-file-preview__h1">$1</h1>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr />')
    // Unordered lists
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    // Ordered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Wrap consecutive <li> in <ul>
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    // Blockquotes
    .replace(/^&gt; (.+)$/gm, '<blockquote class="otto-file-preview__blockquote">$1</blockquote>')
    // Paragraphs: wrap non-tag lines in <p>
    .replace(/^(?!<[a-zA-Z/!])(.+)$/gm, '<p>$1</p>');

  // Fix double-wrapping
  html = html.replace(/<ul>\s*<ul>/g, '<ul>').replace(/<\/ul>\s*<\/ul>/g, '</ul>');

  return html;
}

// ── Syntax Highlighting helpers ──

function extensionToLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    json: 'json', css: 'css', html: 'html', htm: 'html',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    yaml: 'yaml', yml: 'yaml', xml: 'xml',
    toml: 'toml', ini: 'ini', cfg: 'ini',
    sql: 'sql', graphql: 'graphql',
    vue: 'html', svelte: 'html',
    md: 'markdown', mdx: 'markdown',
  };
  return map[ext] ?? '';
}

// Simple syntax-highlight tokens
interface Token {
  text: string;
  className?: string;
}

function tokenizeCode(code: string, lang: string): Token[] {
  const tokens: Token[] = [];
  const lines = code.split('\n');
  const isCommentable = ['javascript', 'typescript', 'tsx', 'jsx', 'python', 'ruby', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'css'].includes(lang);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    if (lineIdx > 0) tokens.push({ text: '\n' });
    const line = lines[lineIdx];
    let i = 0;

    while (i < line.length) {
      // Single-line comment //
      if (isCommentable && line[i] === '/' && line[i + 1] === '/') {
        tokens.push({ text: line.slice(i), className: 'otto-file-preview__token-comment' });
        break;
      }
      // Single-line comment #
      if (['python', 'ruby'].includes(lang) && line[i] === '#') {
        tokens.push({ text: line.slice(i), className: 'otto-file-preview__token-comment' });
        break;
      }
      // Strings
      if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
        const quote = line[i];
        let j = i + 1;
        while (j < line.length && line[j] !== quote) {
          if (line[j] === '\\') j++;
          j++;
        }
        tokens.push({ text: line.slice(i, j + 1), className: 'otto-file-preview__token-string' });
        i = j + 1;
        continue;
      }
      // Keywords
      const keywordMatch = line.slice(i).match(/^(function|const|let|var|class|export|import|from|return|if|else|async|await|for|while|switch|case|break|continue|try|catch|finally|throw|new|typeof|instanceof|extends|implements|interface|type|enum|public|private|protected|readonly|static|abstract|def|lambda|print|pass|yield|raise|except|finally|elif|True|False|None|and|or|not|in|is|fn|pub|use|mod|impl|struct|trait|enum|match|where|unsafe|extern|mut|ref|let|self|super|package|val|var|fun|object|sealed|when|nil|do|end|begin|rescue|ensure|require|include|attr_accessor|attr_reader|attr_writer)\b/);
      if (keywordMatch && /^[a-zA-Z_$]/.test(line[i])) {
        tokens.push({ text: keywordMatch[0], className: 'otto-file-preview__token-keyword' });
        i += keywordMatch[0].length;
        continue;
      }
      // Numbers
      if (/^\d/.test(line[i])) {
        const numMatch = line.slice(i).match(/^\d+(\.\d+)?([eE][+-]?\d+)?/);
        if (numMatch) {
          tokens.push({ text: numMatch[0], className: 'otto-file-preview__token-number' });
          i += numMatch[0].length;
          continue;
        }
      }

      tokens.push({ text: line[i] });
      i++;
    }
  }

  return tokens;
}

// ── Component ──

export interface FilePreviewProps {
  /** Files available for preview */
  files: FileEntry[];
  /** Callback when user requests to open a file externally */
  onOpenExternal?: (file: FileEntry) => void;
  /** Callback when user drops files */
  onDropFiles?: (paths: string[]) => void;
  /** Currently selected file id */
  selectedId?: string;
  /** Selection callback */
  onSelectFile?: (file: FileEntry) => void;
}

export function FilePreview({
  files,
  onOpenExternal,
  onDropFiles,
  selectedId,
  onSelectFile,
}: FilePreviewProps): React.JSX.Element {
  const [activeId, setActiveId] = useState<string>(selectedId ?? '');
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (selectedId !== undefined) setActiveId(selectedId);
  }, [selectedId]);

  // Auto-select first file if none selected
  useEffect(() => {
    if (!activeId && files.length > 0) {
      setActiveId(files[0].id);
    } else if (activeId && !files.find((f) => f.id === activeId)) {
      setActiveId(files[0]?.id ?? '');
    }
  }, [files, activeId]);

  const activeFile = useMemo(
    () => files.find((f) => f.id === activeId) ?? null,
    [files, activeId],
  );

  const category = activeFile ? inferCategory(activeFile) : 'text';
  const language = activeFile ? extensionToLanguage(activeFile.name) : '';

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => setDragOver(false), []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const paths: string[] = [];
      if (e.dataTransfer.files) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const f = e.dataTransfer.files[i];
          // Electron exposes `.path` on File objects
          const filePath = (f as File & { path?: string }).path;
          if (filePath) paths.push(filePath);
        }
      }
      if (paths.length > 0 && onDropFiles) {
        onDropFiles(paths);
      }
    },
    [onDropFiles],
  );

  const handleOpenExternal = useCallback(() => {
    if (activeFile && onOpenExternal) onOpenExternal(activeFile);
  }, [activeFile, onOpenExternal]);

  return (
    <div className="otto-file-preview" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {dragOver ? <div className="otto-file-preview__dropover">释放以添加文件到预览</div> : null}

      <div className="otto-file-preview__layout">
        {/* ── Left: file list ── */}
        <div className="otto-file-preview__list">
          <div className="otto-file-preview__list-head">
            <strong>文件</strong>
            <span>{files.length} 项</span>
          </div>
          {files.length === 0 ? (
            <div className="otto-file-preview__empty">
              暂无文件。拖放文件到此区域，或从工具结果中提取。
            </div>
          ) : (
            <div className="otto-file-preview__list-items">
              {files.map((file) => {
                const cat = inferCategory(file);
                const icon = cat === 'image' ? '🖼' : cat === 'markdown' ? '📝' : cat === 'code' ? '📄' : cat === 'pdf' ? '📕' : '📃';
                return (
                  <button
                    key={file.id}
                    type="button"
                    className={`otto-file-preview__list-item${file.id === activeId ? ' is-active' : ''}`}
                    onClick={() => {
                      setActiveId(file.id);
                      if (onSelectFile) onSelectFile(file);
                    }}
                  >
                    <span className="otto-file-preview__list-item-icon">{icon}</span>
                    <span className="otto-file-preview__list-item-name">{file.name}</span>
                    {file.size ? (
                      <span className="otto-file-preview__list-item-size">{formatSize(file.size)}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Right: preview ── */}
        <div className="otto-file-preview__content">
          {activeFile ? (
            <>
              <div className="otto-file-preview__toolbar">
                <span className="otto-file-preview__filename" title={activeFile.path}>
                  {activeFile.name}
                  {activeFile.source ? <span className="otto-file-preview__source">{activeFile.source}</span> : null}
                </span>
                <button type="button" className="otto-file-preview__open-btn" onClick={handleOpenExternal} title="用系统默认程序打开">
                  外部打开 ↗
                </button>
              </div>
              <div className="otto-file-preview__body">
                {category === 'image' ? (
                  <img
                    src={activeFile.content ?? `file://${activeFile.path}`}
                    alt={activeFile.name}
                    className="otto-file-preview__image"
                    style={{ maxWidth: '100%', height: 'auto', borderRadius: 6 }}
                  />
                ) : category === 'markdown' ? (
                  <div
                    className="otto-file-preview__markdown"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(activeFile.content ?? ''),
                    }}
                  />
                ) : category === 'pdf' ? (
                  <div className="otto-file-preview__pdf-info">
                    <div className="otto-file-preview__pdf-icon">📕</div>
                    <strong>{activeFile.name}</strong>
                    <span>{activeFile.size ? formatSize(activeFile.size) : '未知大小'}</span>
                    <span>PDF 文件 — 点击"外部打开"用系统默认程序查看</span>
                    <button type="button" className="otto-file-preview__open-btn" onClick={handleOpenExternal}>
                      打开 PDF ↗
                    </button>
                  </div>
                ) : (
                  // Code / text with syntax highlighting
                  <div className="otto-file-preview__code-wrap">
                    {language ? (
                      <span className="otto-file-preview__lang-badge">{language}</span>
                    ) : null}
                    <pre className="otto-file-preview__code">
                      <code>
                        {tokenizeCode(activeFile.content ?? '', language).map((token, idx) =>
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
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="otto-file-preview__empty">选择文件以预览</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
