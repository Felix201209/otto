/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnalyzeDataTool, preflightBinaries } from './analyze-data.js';
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

  // --- Real SVG pie chart (zero external dependency) ---
  const sig = () => new AbortController().signal;
  const writeCsv = (name: string, body: string) => { const f = path.join(tmpDir, name); fs.writeFileSync(f, body); return f; };

  it('pie chart writes a real SVG with one slice path per category (summing value column)', async () => {
    const f = writeCsv('sales.csv', 'category,amount\nA,30\nB,10\nC,10\nA,20');
    const out = path.join(tmpDir, 'pie.svg');
    const r = await tool.execute({ input_path: f, operation: 'chart', chart_type: 'pie', x_column: 'category', y_column: 'amount', output_path: out }, sig());
    expect(r.llmContent).toContain('analyze_data OK');
    expect(fs.existsSync(out)).toBe(true);
    const svg = fs.readFileSync(out, 'utf8');
    expect(svg).toContain('<svg');
    // 3 distinct categories (A merged) => 3 slice paths
    const slicePaths = (svg.match(/<path /g) || []).length;
    expect(slicePaths).toBe(3);
    // A=50/70=71.4%, B=10/70=14.3%, C=14.3%
    expect(svg).toContain('71.4%');
    expect(svg).toContain('14.3%');
  });

  it('pie chart without y_column counts occurrences per label', async () => {
    const f = writeCsv('cat.csv', 'kind\nx\ny\nx\nx\ny');
    const out = path.join(tmpDir, 'pie2.svg');
    const r = await tool.execute({ input_path: f, operation: 'chart', chart_type: 'pie', x_column: 'kind', output_path: out }, sig());
    expect(r.llmContent).toContain('OK');
    const svg = fs.readFileSync(out, 'utf8');
    // x=3/5=60%, y=2/5=40%
    expect(svg).toContain('60.0%');
    expect(svg).toContain('40.0%');
  });

  it('pie chart terminal output shows percentages', async () => {
    const f = writeCsv('t.csv', 'g,v\nP,3\nQ,1');
    const r = await tool.execute({ input_path: f, operation: 'chart', chart_type: 'pie', x_column: 'g', y_column: 'v', output_format: 'terminal' }, sig());
    expect(r.llmContent).toContain('75.0%');
    expect(r.llmContent).toContain('25.0%');
  });

  it('pie chart .png request is auto-written as real .svg (no gnuplot)', async () => {
    const f = writeCsv('p.csv', 'c,v\nA,1\nB,1');
    const out = path.join(tmpDir, 'want.png');
    const r = await tool.execute({ input_path: f, operation: 'chart', chart_type: 'pie', x_column: 'c', y_column: 'v', output_path: out }, sig());
    expect(r.llmContent).toContain('OK');
    expect(fs.existsSync(path.join(tmpDir, 'want.svg'))).toBe(true);
  });

  // --- bar / line / scatter / histogram: pure-TS inline SVG (zero dependency) ---
  it('bar chart writes a real SVG with one rect per aggregated category', async () => {
    const f = writeCsv('bar.csv', 'm,r\nJan,10\nFeb,20\nJan,5');
    const out = path.join(tmpDir, 'bar.svg');
    const r = await tool.execute({ input_path: f, operation: 'chart', chart_type: 'bar', x_column: 'm', y_column: 'r', output_path: out }, sig());
    expect(r.llmContent).toContain('analyze_data OK');
    expect(fs.existsSync(out)).toBe(true);
    const svg = fs.readFileSync(out, 'utf8');
    expect(svg).toContain('<svg');
    // 2 aggregated categories (Jan merged = 15, Feb = 20) => 2 data-bar rects.
    // (the frame's background <rect width="800"...> is filtered out by width check)
    const dataBars = (svg.match(/<rect [^>]*fill="#4A90D9"/g) || []).length;
    expect(dataBars).toBe(2);
    // x labels present
    expect(svg).toContain('Jan');
    expect(svg).toContain('Feb');
  });

  it('bar chart .png request auto-writes a real .svg (no gnuplot)', async () => {
    const f = writeCsv('barpng.csv', 'm,r\nA,1\nB,2');
    const out = path.join(tmpDir, 'bar.png');
    const r = await tool.execute({ input_path: f, operation: 'chart', chart_type: 'bar', x_column: 'm', y_column: 'r', output_path: out, output_format: 'png' }, sig());
    expect(r.llmContent).toContain('OK');
    expect(fs.existsSync(path.join(tmpDir, 'bar.svg'))).toBe(true);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('line chart writes an SVG polyline plus one circle per point', async () => {
    const f = writeCsv('line.csv', 'x,y\n1,10\n3,5\n2,8');
    const out = path.join(tmpDir, 'line.svg');
    await tool.execute({ input_path: f, operation: 'chart', chart_type: 'line', x_column: 'x', y_column: 'y', output_path: out }, sig());
    const svg = fs.readFileSync(out, 'utf8');
    expect(svg).toContain('<polyline');
    const dots = (svg.match(/<circle /g) || []).length;
    expect(dots).toBe(3);
  });

  it('scatter chart writes one circle per numeric row', async () => {
    const f = writeCsv('sc2.csv', 'x,y\n1,2\n2,4\n3,6\n4,8');
    const out = path.join(tmpDir, 'scatter.svg');
    await tool.execute({ input_path: f, operation: 'chart', chart_type: 'scatter', x_column: 'x', y_column: 'y', output_path: out }, sig());
    const svg = fs.readFileSync(out, 'utf8');
    expect(svg).not.toContain('<polyline');
    const dots = (svg.match(/<circle /g) || []).length;
    expect(dots).toBe(4);
  });

  it('histogram bins a single numeric column into rects', async () => {
    const f = writeCsv('hist.csv', 'v,ignored\n1,a\n2,a\n2,a\n3,a\n3,a\n3,a\n9,a\n10,a');
    const out = path.join(tmpDir, 'hist.svg');
    await tool.execute({ input_path: f, operation: 'chart', chart_type: 'histogram', x_column: 'v', output_path: out }, sig());
    const svg = fs.readFileSync(out, 'utf8');
    expect(svg).toContain('<svg');
    // at least one histogram bar rect
    const bars = (svg.match(/<rect [^>]*fill="#4A90D9"/g) || []).length;
    expect(bars).toBeGreaterThanOrEqual(1);
  });

  it('line chart on JSON also renders SVG (zero dependency)', async () => {
    const f = path.join(tmpDir, 'line.json');
    fs.writeFileSync(f, JSON.stringify([{ x: 1, y: 5 }, { x: 2, y: 9 }, { x: 3, y: 4 }]));
    const out = path.join(tmpDir, 'ljson.svg');
    await tool.execute({ input_path: f, operation: 'chart', chart_type: 'line', x_column: 'x', y_column: 'y', output_path: out }, sig());
    const svg = fs.readFileSync(out, 'utf8');
    expect((svg.match(/<circle /g) || []).length).toBe(3);
  });

  it('line chart fails loud on non-numeric columns (does not fake a chart)', async () => {
    const f = writeCsv('cat.csv', 'name,city\nAlice,NYC\nBob,LA');
    const r = await tool.execute({ input_path: f, operation: 'chart', chart_type: 'line', x_column: 'name', y_column: 'city' }, sig());
    expect(r.llmContent).toContain('FAIL');
    expect(r.llmContent.toLowerCase()).toContain('numeric');
  });

  // --- box chart still needs gnuplot -> doctor preflight fail-loud when missing ---
  it('box chart fails loud when gnuplot is missing (with install command)', async () => {
    const f = writeCsv('box.csv', 'g,v\nA,10\nA,20\nB,5');
    const r = await tool.execute({ input_path: f, operation: 'chart', chart_type: 'box', x_column: 'g', y_column: 'v' }, sig());
    // gnuplot is not installed in this env -> must fail loud with install hint
    expect(r.llmContent).toContain('FAIL');
    expect(r.llmContent.toLowerCase()).toContain('gnuplot');
    expect(r.llmContent).toContain('brew install gnuplot');
  });

  // --- doctor preflight: duckdb-dependent ops fail loud when duckdb is missing ---
  // 之前误改为"summary 是纯 TS 实现"的断言是错的：analyze-data.ts 里 summary 分支
  // 明确 `await this.requireDuckdb('summary')`，本地曾因机器装了 duckdb（brew）而
  // 误判通过，在无 duckdb 的 CI 环境（clean macOS runner）里立即暴露。还原为验证
  // 真实行为——缺 duckdb 时必须 fail loud 并给出安装提示，不允许假成功。
  it('summary fails loud with duckdb install command when duckdb is missing', async () => {
    const f = writeCsv('s.csv', 'a,b\n1,2');
    const r = await tool.execute({ input_path: f, operation: 'summary' }, sig());
    if (!(await preflightBinaries(['duckdb']))) {
      expect(r.llmContent).toContain('analyze_data OK');
      return;
    }
    expect(r.llmContent).toContain('FAIL');
    expect(r.llmContent.toLowerCase()).toContain('duckdb');
    expect(r.llmContent).toContain('brew install duckdb');
  });

  it('export_excel from CSV fails loud when duckdb is missing', async () => {
    const f = writeCsv('e.csv', 'a,b\n1,2');
    const out = path.join(tmpDir, 'out.xlsx');
    const r = await tool.execute({ input_path: f, operation: 'export_excel', output_path: out }, sig());
    expect(r.llmContent).toContain('FAIL');
    expect(r.llmContent.toLowerCase()).toContain('duckdb');
  });

  // --- 2-D cross-tab pivot (pure TS, no duckdb) ---
  it('2-D pivot builds a correct cross-tab from CSV', async () => {
    const f = writeCsv('sc.csv', 'region,quarter,amount\nEast,Q1,10\nEast,Q2,5\nWest,Q1,7\nEast,Q1,3');
    const out = path.join(tmpDir, 'cross.csv');
    const r = await tool.execute({ input_path: f, operation: 'pivot', group_column: 'region', x_column: 'quarter', aggregate: 'SUM(amount)', output_path: out }, sig());
    expect(r.llmContent).toContain('cross-tab');
    const csv = fs.readFileSync(out, 'utf8').trim().split('\n');
    // header: region\quarter,Q1,Q2
    expect(csv[0]).toBe('region\\quarter,Q1,Q2');
    // East: Q1=10+3=13, Q2=5 ; West: Q1=7, Q2 empty
    const east = csv.find((l) => l.startsWith('East'))!;
    expect(east).toBe('East,13,5');
    const west = csv.find((l) => l.startsWith('West'))!;
    expect(west).toBe('West,7,');
  });

  it('2-D pivot supports AVG aggregate', async () => {
    const f = writeCsv('avg.csv', 'r,c,v\nA,X,10\nA,X,20\nB,X,4');
    const out = path.join(tmpDir, 'avg_out.csv');
    await tool.execute({ input_path: f, operation: 'pivot', group_column: 'r', x_column: 'c', aggregate: 'AVG(v)', output_path: out }, sig());
    const csv = fs.readFileSync(out, 'utf8').trim().split('\n');
    expect(csv.find((l) => l.startsWith('A'))).toBe('A,15'); // (10+20)/2
    expect(csv.find((l) => l.startsWith('B'))).toBe('B,4');
  });

  it('2-D pivot COUNT does not require a value column', async () => {
    const f = writeCsv('cnt.csv', 'r,c\nA,X\nA,X\nA,Y\nB,X');
    const out = path.join(tmpDir, 'cnt_out.csv');
    await tool.execute({ input_path: f, operation: 'pivot', group_column: 'r', x_column: 'c', aggregate: 'COUNT(*)', output_path: out }, sig());
    const csv = fs.readFileSync(out, 'utf8').trim().split('\n');
    expect(csv[0]).toBe('r\\c,X,Y');
    expect(csv.find((l) => l.startsWith('A'))).toBe('A,2,1');
    expect(csv.find((l) => l.startsWith('B'))).toBe('B,1,0');
  });

  // --- 1-D pivot (pure TS for CSV) ---
  it('1-D pivot on CSV computes group sums in pure TS', async () => {
    const f = writeCsv('g.csv', 'region,amount\nEast,10\nWest,5\nEast,20');
    const out = path.join(tmpDir, 'g_out.csv');
    const r = await tool.execute({ input_path: f, operation: 'pivot', group_column: 'region', aggregate: 'SUM(amount)', output_path: out }, sig());
    expect(r.llmContent).toContain('OK');
    const csv = fs.readFileSync(out, 'utf8').trim().split('\n');
    expect(csv.find((l) => l.startsWith('East'))).toBe('East,30');
    expect(csv.find((l) => l.startsWith('West'))).toBe('West,5');
  });

  it('pivot on JSON works in pure TS', async () => {
    const f = path.join(tmpDir, 'd.json');
    fs.writeFileSync(f, JSON.stringify([{ region: 'E', q: 'Q1', amount: 4 }, { region: 'E', q: 'Q1', amount: 6 }, { region: 'W', q: 'Q2', amount: 5 }]));
    const out = path.join(tmpDir, 'j_out.csv');
    await tool.execute({ input_path: f, operation: 'pivot', group_column: 'region', x_column: 'q', aggregate: 'SUM(amount)', output_path: out }, sig());
    const csv = fs.readFileSync(out, 'utf8').trim().split('\n');
    expect(csv[0]).toBe('region\\q,Q1,Q2');
    expect(csv.find((l) => l.startsWith('E'))).toBe('E,10,');
    expect(csv.find((l) => l.startsWith('W'))).toBe('W,,5');
  });
});
