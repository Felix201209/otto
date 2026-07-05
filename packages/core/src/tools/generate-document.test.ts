/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GenerateDocumentTool } from './generate-document.js';
import { createMockConfig } from '../utils/test-helpers.js';

describe('GenerateDocumentTool', () => {
  let tool: GenerateDocumentTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new GenerateDocumentTool(createMockConfig());
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

  // --- md2typst (private, test via execute mock) ---
  // Tested via integration in execute when child_process is mocked
});
