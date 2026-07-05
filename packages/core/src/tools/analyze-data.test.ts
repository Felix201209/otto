/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnalyzeDataTool } from './analyze-data.js';
import { createMockConfig } from '../utils/test-helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('AnalyzeDataTool', () => {
  let tool: AnalyzeDataTool;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new AnalyzeDataTool(createMockConfig());
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-test-data-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // --- Metadata ---
  it('has correct name', () => { expect(AnalyzeDataTool.Name).toBe('analyze_data'); });
  it('has display name', () => { expect(tool.displayName).toBe('AnalyzeData'); });
  it('has Info icon', () => { expect(tool.icon).toBe('info'); });

  // --- Validation ---
  it('rejects missing input_path', () => {
    expect(tool.validateToolParams({ operation: 'summary' } as any)).not.toBeNull();
  });
  it('rejects relative input_path', () => {
    expect(tool.validateToolParams({ input_path: 'data.csv', operation: 'summary' })).toContain('absolute');
  });
  it('rejects non-existent file', () => {
    expect(tool.validateToolParams({ input_path: '/nonexistent/data.csv', operation: 'summary' })).toContain('not found');
  });
  it('requires query for query operation', () => {
    const f = path.join(tmpDir, 'data.csv'); fs.writeFileSync(f, 'a,b\n1,2');
    expect(tool.validateToolParams({ input_path: f, operation: 'query' })).toContain('query');
  });
  it('requires chart_type for chart operation', () => {
    const f = path.join(tmpDir, 'data.csv'); fs.writeFileSync(f, 'a,b\n1,2');
    expect(tool.validateToolParams({ input_path: f, operation: 'chart' })).toContain('chart_type');
  });
  it('requires x_column for chart/bar', () => {
    const f = path.join(tmpDir, 'data.csv'); fs.writeFileSync(f, 'a,b\n1,2');
    expect(tool.validateToolParams({ input_path: f, operation: 'chart', chart_type: 'bar' })).toContain('x_column');
  });
  it('accepts chart/pie with only x_column', () => {
    const f = path.join(tmpDir, 'data.csv'); fs.writeFileSync(f, 'a,b\n1,2');
    expect(tool.validateToolParams({ input_path: f, operation: 'chart', chart_type: 'pie', x_column: 'a' })).toBeNull();
  });
  it('requires group_column+aggregate for pivot', () => {
    const f = path.join(tmpDir, 'data.csv'); fs.writeFileSync(f, 'a,b\n1,2');
    expect(tool.validateToolParams({ input_path: f, operation: 'pivot' })).toContain('group_column');
  });
  it('accepts export_excel', () => {
    const f = path.join(tmpDir, 'data.csv'); fs.writeFileSync(f, 'a,b\n1,2');
    expect(tool.validateToolParams({ input_path: f, operation: 'export_excel' })).toBeNull();
  });
  it('accepts summary', () => {
    const f = path.join(tmpDir, 'data.csv'); fs.writeFileSync(f, 'a,b\n1,2');
    expect(tool.validateToolParams({ input_path: f, operation: 'summary' })).toBeNull();
  });

  // --- getDescription ---
  it('getDescription includes operation', () => {
    expect(tool.getDescription({ input_path: '/tmp/data.csv', operation: 'summary' })).toContain('summary');
  });

  // --- shouldConfirmExecute ---
  it('shouldConfirmExecute returns confirmation in DEFAULT mode', async () => {
    const f = path.join(tmpDir, 'data.csv'); fs.writeFileSync(f, 'a,b\n1,2');
    const r = await tool.shouldConfirmExecute({ input_path: f, operation: 'summary' }, new AbortController().signal);
    expect(r).not.toBe(false);
  });
});
