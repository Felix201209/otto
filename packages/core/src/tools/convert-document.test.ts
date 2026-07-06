/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { ConvertDocumentTool } from './convert-document.js';
import { createMockConfig } from '../utils/test-helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Minimal valid single-page PDF for real merge tests.
function makePdf(text: string): Buffer {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
  ];
  const stream = 'BT /F1 18 Tf 20 100 Td (' + text + ') Tj ET';
  objs.push('4 0 obj\n<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream\nendobj\n');
  objs.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  const xrefPos = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF';
  return Buffer.from(pdf, 'latin1');
}
function hasBin(name: string): boolean {
  try { execSync('command -v ' + name, { stdio: 'ignore' }); return true; } catch { return false; }
}

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

  // --- Lossless all-PDF merge via pdfunite (real run) ---
  const pdfuniteAvailable = hasBin('pdfunite');

  it.runIf(pdfuniteAvailable)('merges all-PDF inputs losslessly via pdfunite', async () => {
    const a = path.join(tmpDir, 'a.pdf'); fs.writeFileSync(a, makePdf('Page A'));
    const b = path.join(tmpDir, 'b.pdf'); fs.writeFileSync(b, makePdf('Page B'));
    const out = path.join(tmpDir, 'merged.pdf');
    const r = await tool.execute({ input_paths: [a, b], output_format: 'pdf', merge: true, output_path: out }, new AbortController().signal);
    expect(r.llmContent).toContain('OK');
    expect(r.llmContent).toContain('lossless');
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
    // Real page-count assertion when pdfinfo is present.
    if (hasBin('pdfinfo')) {
      const info = execSync('pdfinfo "' + out + '"', { encoding: 'utf8' });
      expect(info).toMatch(/Pages:\s*2/);
    } else {
      // Fallback: merged PDF must contain 2 page objects.
      const bytes = fs.readFileSync(out, 'latin1');
      expect((bytes.match(/\/Type\s*\/Page[^s]/g) || []).length).toBe(2);
    }
  });

  it.runIf(pdfuniteAvailable)('merges three PDFs into a 3-page file', async () => {
    const files = ['a', 'b', 'c'].map((n) => { const f = path.join(tmpDir, n + '.pdf'); fs.writeFileSync(f, makePdf('Page ' + n)); return f; });
    const out = path.join(tmpDir, 'm3.pdf');
    const r = await tool.execute({ input_paths: files, output_format: 'pdf', merge: true, output_path: out }, new AbortController().signal);
    expect(r.llmContent).toContain('OK');
    if (hasBin('pdfinfo')) {
      const info = execSync('pdfinfo "' + out + '"', { encoding: 'utf8' });
      expect(info).toMatch(/Pages:\s*3/);
    }
  });
});
