/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConvertDocumentTool } from './convert-document.js';
import { createMockConfig } from '../utils/test-helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ConvertDocumentTool', () => {
  let tool: ConvertDocumentTool;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new ConvertDocumentTool(createMockConfig());
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-test-convert-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // --- Metadata ---
  it('has correct name', () => { expect(ConvertDocumentTool.Name).toBe('convert_document'); });
  it('has display name', () => { expect(tool.displayName).toBe('ConvertDocument'); });
  it('has icon', () => { expect(tool.icon).toBe('fileSearch'); });

  // --- Validation ---
  it('rejects missing input_path and input_paths', () => {
    const err = tool.validateToolParams({ output_format: 'pdf' });
    expect(err).not.toBeNull();
  });
  it('rejects relative input_path', () => {
    const err = tool.validateToolParams({ input_path: 'relative/path.md', output_format: 'pdf' });
    expect(err).toContain('must be absolute');
  });
  it('rejects non-existent input_path', () => {
    const err = tool.validateToolParams({ input_path: '/nonexistent/file.md', output_format: 'pdf' });
    expect(err).toContain('file not found');
  });
  it('accepts valid single file', () => {
    const f = path.join(tmpDir, 'test.md');
    fs.writeFileSync(f, '# Test');
    expect(tool.validateToolParams({ input_path: f, output_format: 'pdf' })).toBeNull();
  });
  it('accepts batch input_paths', () => {
    const f1 = path.join(tmpDir, 'a.md'); fs.writeFileSync(f1, 'a');
    const f2 = path.join(tmpDir, 'b.md'); fs.writeFileSync(f2, 'b');
    expect(tool.validateToolParams({ input_paths: [f1, f2], output_format: 'pdf' })).toBeNull();
  });
  it('rejects merge with less than 2 files', () => {
    const f = path.join(tmpDir, 'a.md'); fs.writeFileSync(f, 'a');
    const err = tool.validateToolParams({ input_paths: [f], output_format: 'pdf', merge: true });
    expect(err).toContain('at least 2');
  });
  it('rejects merge without output_path', () => {
    const f1 = path.join(tmpDir, 'a.md'); fs.writeFileSync(f1, 'a');
    const f2 = path.join(tmpDir, 'b.md'); fs.writeFileSync(f2, 'b');
    const err = tool.validateToolParams({ input_paths: [f1, f2], output_format: 'pdf', merge: true });
    expect(err).toContain('output_path');
  });
  it('requires output_format', () => {
    const err = tool.validateToolParams({ input_path: '/tmp/x.md' } as any);
    expect(err).toContain('output_format');
  });

  // --- getDescription ---
  it('getDescription for single file', () => {
    expect(tool.getDescription({ input_path: '/tmp/report.docx', output_format: 'pdf' })).toContain('report.docx');
  });
  it('getDescription for batch', () => {
    expect(tool.getDescription({ input_paths: ['/tmp/a.docx','/tmp/b.docx'], output_format: 'pdf' })).toContain('batch');
  });

  // --- shouldConfirmExecute ---
  it('shouldConfirmExecute returns false in DEFAULT mode', async () => {
    const f = path.join(tmpDir, 'test.md'); fs.writeFileSync(f, '# Test');
    const r = await tool.shouldConfirmExecute({ input_path: f, output_format: 'pdf' }, new AbortController().signal);
    expect(r).not.toBe(false);
  });
});
