/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { GenerateDocumentTool } from './generate-document.js';
import { createMockConfig } from '../utils/test-helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function hasBin(name: string): boolean {
  try { execSync('command -v ' + name, { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('GenerateDocumentTool', () => {
  let tool: GenerateDocumentTool;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new GenerateDocumentTool(createMockConfig());
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-test-gen-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // --- Metadata ---
  it('has correct name', () => { expect(GenerateDocumentTool.Name).toBe('generate_document'); });
  it('has display name', () => { expect(tool.displayName).toBe('GenerateDocument'); });
  it('has Pencil icon', () => { expect(tool.icon).toBe('pencil'); });

  // --- Validation ---
  it('rejects empty content', () => {
    expect(tool.validateToolParams({ content: '', format: 'report', output_format: 'pdf' })).toContain('content');
  });
  it('rejects slides with docx output', () => {
    expect(tool.validateToolParams({ content: '# Hi', format: 'slides', output_format: 'docx' })).toContain('slides');
  });
  it('accepts slides with pptx output', () => {
    expect(tool.validateToolParams({ content: '# Hi\n---\n# Page 2', format: 'slides', output_format: 'pptx' })).toBeNull();
  });
  it('accepts report with pdf', () => {
    expect(tool.validateToolParams({ content: '# Report\nContent', format: 'report', output_format: 'pdf' })).toBeNull();
  });
  it('accepts letter with html', () => {
    expect(tool.validateToolParams({ content: 'Dear...', format: 'letter', output_format: 'html' })).toBeNull();
  });
  it('accepts resume with markdown', () => {
    expect(tool.validateToolParams({ content: '## Skills', format: 'resume', output_format: 'markdown' })).toBeNull();
  });

  // --- getDescription ---
  it('getDescription includes format and output', () => {
    expect(tool.getDescription({ content: 'x', format: 'report', output_format: 'pdf' })).toContain('report');
  });

  // --- shouldConfirmExecute ---
  it('shouldConfirmExecute returns confirmation in DEFAULT mode', async () => {
    const r = await tool.shouldConfirmExecute(
      { content: '# Hi', format: 'report', output_format: 'pdf' },
      new AbortController().signal,
    );
    expect(r).not.toBe(false);
  });

  // --- markdown output needs no external tool (pure fs write) ---
  it('markdown output writes a file with zero dependencies', async () => {
    const out = path.join(tmpDir, 'doc.md');
    const r = await tool.execute(
      { content: '# Hello\n\nWorld', format: 'article', output_format: 'markdown', title: 'T', output_path: out },
      new AbortController().signal,
    );
    expect(r.llmContent).toContain('generate_document OK');
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toContain('# T');
  });

  // --- Doctor preflight: engine binaries checked BEFORE rendering ---
  const typstAvailable = hasBin('typst');
  const marpAvailable = hasBin('marp') || hasBin('marp-cli');
  const pandocAvailable = hasBin('pandoc');

  it.runIf(!typstAvailable)('report->pdf fails loud with typst install command when typst is missing', async () => {
    const out = path.join(tmpDir, 'r.pdf');
    const r = await tool.execute(
      { content: '# Report\n\nBody', format: 'report', output_format: 'pdf', title: 'R', output_path: out },
      new AbortController().signal,
    );
    expect(r.llmContent).toContain('FAIL');
    expect(r.llmContent.toLowerCase()).toContain('typst');
    expect(r.llmContent).toContain('brew install typst');
  });

  it.runIf(!marpAvailable)('slides->pptx fails loud with marp install command when marp is missing', async () => {
    const out = path.join(tmpDir, 's.pptx');
    const r = await tool.execute(
      { content: '# Slide 1\n---\n# Slide 2', format: 'slides', output_format: 'pptx', title: 'S', output_path: out },
      new AbortController().signal,
    );
    expect(r.llmContent).toContain('FAIL');
    expect(r.llmContent.toLowerCase()).toContain('marp');
    expect(r.llmContent).toContain('@marp-team/marp-cli');
  });

  it.runIf(!pandocAvailable)('article->docx fails loud with pandoc install command when pandoc is missing', async () => {
    const out = path.join(tmpDir, 'a.docx');
    const r = await tool.execute(
      { content: '# Article\n\nText', format: 'article', output_format: 'docx', title: 'A', output_path: out },
      new AbortController().signal,
    );
    expect(r.llmContent).toContain('FAIL');
    expect(r.llmContent.toLowerCase()).toContain('pandoc');
    expect(r.llmContent).toContain('brew install pandoc');
  });
});
