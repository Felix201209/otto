/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ProcessGuard } from '../utils/process-guard.js';

const execAsync = promisify(exec);

export interface AnalyzeDataToolParams {
  input_path: string;
  operation: 'summary'|'query'|'chart'|'transform'|'pivot'|'export_excel';
  query?: string; chart_type?: 'bar'|'line'|'pie'|'scatter'|'histogram'|'box';
  x_column?: string; y_column?: string;
  output_path?: string; output_format?: 'png'|'svg'|'terminal';
  group_column?: string; aggregate?: string;
}

export class AnalyzeDataTool extends BaseTool<AnalyzeDataToolParams, ToolResult> {
  static readonly Name: string = 'analyze_data';

  constructor(private readonly config: Config) {
    const desc = `Data analysis and charting using DuckDB SQL + gnuplot.

EXAMPLES:
  Summary: {input_path:"/data/sales.csv", operation:"summary"}
  SQL query: {input_path:"/data/sales.csv", operation:"query", query:"SELECT category, SUM(amount) FROM t GROUP BY category ORDER BY 2 DESC"}
  Chart: {input_path:"/data/sales.csv", operation:"chart", chart_type:"bar", x_column:"month", y_column:"revenue", output_format:"png"}
  Pie: {input_path:"/data/sales.csv", operation:"chart", chart_type:"pie", x_column:"category"}  (real SVG, no gnuplot needed)
  Pivot (1-D): {input_path:"/data/sales.csv", operation:"pivot", group_column:"region", aggregate:"SUM(amount)"}
  Pivot (2-D cross-tab): {input_path:"/data/sales.csv", operation:"pivot", group_column:"region", x_column:"quarter", aggregate:"SUM(amount)"}
  Transform: {input_path:"/data/sales.csv", operation:"transform", query:"WHERE amount > 1000 ORDER BY amount DESC", output_path:"/out/filtered.csv"}
  Export Excel: {input_path:"/data/sales.csv", operation:"export_excel", output_path:"/out/sales.xlsx"}

INPUT: CSV, JSON, XLSX, Parquet.
CHART OUTPUT: png/svg/terminal. Pie charts render as real SVG with zero dependencies (no gnuplot).

DEPENDENCIES: Pie chart + CSV/JSON pivot need NO external tools (pure TS). summary/query/transform/export_excel and non-pie charts still use duckdb + gnuplot; if those binaries are missing the tool fails loudly instead of faking output. macOS: brew install duckdb gnuplot.`;
    super(AnalyzeDataTool.Name, 'AnalyzeData', desc, Icon.Info,
      {
        type: Type.OBJECT,
        properties: {
          input_path: { type: Type.STRING, description: 'Absolute path to data file (csv, json, xlsx, parquet)' },
          operation: { type: Type.STRING, enum: ['summary','query','chart','transform','pivot','export_excel'], description: 'What to do: quick stats, run SQL, plot chart, export, pivot table, save as xlsx' },
          query: { type: Type.STRING, description: 'DuckDB SQL. For query: full SELECT. For transform: WHERE/ORDER clauses (FROM auto-added). Can reference table as "t".' },
          chart_type: { type: Type.STRING, enum: ['bar','line','pie','scatter','histogram','box'], description: 'Chart type. For pie chart, only x_column is required.' },
          x_column: { type: Type.STRING, description: 'Column for X axis / pie labels. For pivot: optional COLUMN dimension to build a true 2-D cross-tab (group_column x x_column).' },
          y_column: { type: Type.STRING, description: 'Column for Y axis. Not needed for pie, histogram.' },
          output_path: { type: Type.STRING, description: 'Output file path for chart PNG/SVG or transformed CSV' },
          output_format: { type: Type.STRING, enum: ['png','svg','terminal'], description: 'Chart output format. Default: png. terminal = ASCII chart.' },
          group_column: { type: Type.STRING, description: 'pivot: GROUP BY column' },
          aggregate: { type: Type.STRING, description: 'pivot: aggregate expression like SUM(amount), AVG(score), COUNT(*), MAX(price)' },
        },
        required: ['input_path','operation'],
      },
    );
  }

  validateToolParams(p: AnalyzeDataToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, AnalyzeDataTool.Name);
    if (e) return e;
    if (!path.isAbsolute(p.input_path)) return 'analyze_data: input_path must be absolute';
    if (!fs.existsSync(p.input_path)) return 'analyze_data: file not found: '+p.input_path;
    if (['query','transform'].includes(p.operation) && !p.query) return 'analyze_data/'+p.operation+': query required';
    if (p.operation==='chart') {
      if (!p.chart_type) return 'analyze_data/chart: chart_type required (bar, line, pie, scatter, histogram, box)';
      if (p.chart_type!=='pie' && (!p.x_column || !p.y_column)) return 'analyze_data/chart: x_column and y_column required for '+p.chart_type;
      if (p.chart_type==='pie' && !p.x_column) return 'analyze_data/chart: x_column required for pie chart (labels)';
    }
    if (p.operation==='pivot' && (!p.group_column || !p.aggregate)) return 'analyze_data/pivot: group_column and aggregate required';
    return null;
  }

  toolLocations(p: AnalyzeDataToolParams): ToolLocation[] { return p.output_path?[{path:p.output_path}]:[]; }
  getDescription(p: AnalyzeDataToolParams): string { return p.operation+' '+path.basename(p.input_path); }
  async shouldConfirmExecute(p: AnalyzeDataToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    if (this.validateToolParams(p)) return false;
    return { type:'exec', title:'Confirm: '+this.getDescription(p), command:'analyze_data', rootCommand:'analyze_data', onConfirm:async ()=>{}};
  }

  async execute(p: AnalyzeDataToolParams, _s: AbortSignal): Promise<ToolResult> {
    const logLabel = 'analyze_data.'+(p.operation || 'unknown');
    console.time(logLabel);
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };
    try {
      let r = '';
      switch (p.operation) {
        case 'summary': r=await this.doSummary(p.input_path); break;
        case 'query': r=await this.doQuery(p.input_path, p.query!); break;
        case 'chart': r=await this.doChart(p); break;
        case 'transform': r=await this.doTransform(p.input_path, p.query!, p.output_path); break;
        case 'pivot': r=await this.doPivot(p.input_path, p.group_column!, p.aggregate!, p.output_path, p.x_column); break;
        case 'export_excel': r=await this.doExportExcel(p.input_path, p.output_path); break;
        default: return { llmContent:'analyze_data FAIL: unknown operation', returnDisplay:'analyze_data FAIL: unknown op' };
      }
      return { llmContent: 'analyze_data OK: '+r, returnDisplay:'analyze_data OK: '+r.split('\n')[0] };
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      if (m.includes('not found')) return { llmContent:'analyze_data FAIL: tool not installed. macOS: brew install duckdb gnuplot. Windows: winget install DuckDB; choco install gnuplot.', returnDisplay:'analyze_data FAIL: tool not installed' };
      return { llmContent:'analyze_data FAIL: '+m, returnDisplay:'analyze_data FAIL: '+m };
    }
  }

  private async duckdb(sql: string): Promise<string> {
    const tmp = path.join(os.tmpdir(),'otto-sql-'+Date.now()+'.sql');
    fs.writeFileSync(tmp, sql);
    try { const tmp = path.join(os.tmpdir(), 'otto-sql-'+Date.now()+'.sql'); fs.writeFileSync(tmp, sql); const { stdout } = await execAsync('duckdb -csv < "'+tmp+'"', { maxBuffer:20*1024*1024 }); fs.unlinkSync(tmp); return stdout.trim(); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  private tbl(f: string): string {
    const sp = f.replace(/'/g,"''"); const e=path.extname(f).toLowerCase();
    if(e==='.json') return "read_json_auto('"+sp+"')";
    if(e==='.xlsx'||e==='.xls') return "read_xlsx('"+sp+"')";
    if(e==='.parquet') return "read_parquet('"+sp+"')";
    return "read_csv_auto('"+sp+"')";
  }

  private async doSummary(f: string): Promise<string> {
    const t=this.tbl(f);
    const desc=await this.duckdb('DESCRIBE SELECT * FROM '+t);
    const lines=desc.split('\n').slice(1).map(l=>{const p=l.split(','); return{name:p[0]?.replace(/"/g,''),type:p[1]?.replace(/"/g,'')};});
    const nums=lines.filter(c=>['integer','bigint','double','float','decimal','numeric','real','int'].some(n=>c.type.toLowerCase().includes(n)));
    let s='File: '+path.basename(f)+'\nColumns('+lines.length+'): '+lines.map(c=>c.name).join(', ')+'\n';
    s+='Rows: '+(await this.duckdb('SELECT COUNT(*) FROM '+t)).split('\n')[1]+'\n';
    if(nums.length>0){const parts=nums.map(c=>'COUNT("'+c.name+'") as "'+c.name+'_count", AVG("'+c.name+'") as "'+c.name+'_avg", MIN("'+c.name+'") as "'+c.name+'_min", MAX("'+c.name+'") as "'+c.name+'_max"'); s+='\nNumeric stats:\n'+await this.duckdb('SELECT '+parts.join(', ')+' FROM '+t);}
    s+='\n\nSample (5 rows):\n'+await this.duckdb('SELECT * FROM '+t+' LIMIT 5');
    return s;
  }
  private async doQuery(f: string, q: string): Promise<string> {
    const sql=q.toLowerCase().includes('from ')?q:'SELECT '+q+' FROM '+this.tbl(f);
    return await this.duckdb(sql);
  }
  private async doChart(p: AnalyzeDataToolParams): Promise<string> {
    const {input_path,chart_type,x_column,y_column,output_format}=p;
    // Pie chart: real SVG renderer, zero external dependency (no gnuplot/duckdb).
    if (chart_type === 'pie') return this.doPieChart(p);
    // Every other chart type still needs gnuplot. Fail loud if it is missing
    // rather than pretending a chart was produced.
    if (!(await this.hasBinary('gnuplot'))) {
      throw new Error("chart_type '" + chart_type + "' requires gnuplot, which is not installed. Install it (macOS: brew install gnuplot) or use chart_type:'pie' (pure-SVG, no dependency) / output_format:'terminal'.");
    }
    const outFmt=output_format||'png';
    const outPath=p.output_path||path.join(path.dirname(input_path),'chart_'+path.basename(input_path,path.extname(input_path))+'.'+outFmt);
    const t=this.tbl(input_path);
    const cols=`"${x_column}", "${y_column}"`;
    const csv=await this.duckdb('SELECT '+cols+' FROM '+t+(chart_type!=='histogram'?' ORDER BY "'+x_column+'"':''));
    if(!csv.trim()) return 'No data for charting';
    if(outFmt==='terminal') return this.termChart(csv,chart_type!,x_column!,y_column||x_column!);
    const tmpCsv=path.join(os.tmpdir(),'otto-chart-'+Date.now()+'.csv');
    fs.writeFileSync(tmpCsv, csv.split('\n').slice(1).join('\n'));
    try {
      const gpFile=path.join(os.tmpdir(),'otto-gp-'+Date.now()+'.gp');
      const term=outFmt==='svg'?'svg':'pngcairo';
      let gp='set terminal '+term+' enhanced size 800,600\n';
      gp+="set output '"+outPath.replace(/'/g,"'\\''")+"'\nset datafile separator ','\nset grid\n";
      gp+='set title "'+this.gpe(path.basename(input_path))+'"\n';
      gp+='set xlabel "'+this.gpe(x_column!)+'"\n';
      gp+='set ylabel "'+this.gpe(y_column!||'')+'"\n';
      switch(chart_type){case'bar':gp+='set style fill solid\nset boxwidth 0.8\n';gp+="plot '"+tmpCsv+"' using 2:xtic(1) with boxes lc rgb '#4A90D9' notitle\n";break;case'line':gp+="plot '"+tmpCsv+"' using 1:2 with linespoints lc rgb '#4A90D9' lw 2 pt 7 ps 1 notitle\n";break;case'scatter':gp+="plot '"+tmpCsv+"' using 1:2 with points lc rgb '#D94A90' pt 7 ps 1.5 notitle\n";break;case'histogram':gp+='set style fill solid\nset boxwidth 0.8\n';gp+="plot '"+tmpCsv+"' using 1 with histogram lc rgb '#4A90D9' notitle\n";break;case'box':gp+="plot '"+tmpCsv+"' using 1:2 with boxplot notitle\n";break;default:gp+="plot '"+tmpCsv+"' using 1:2 with linespoints notitle\n";}
      fs.writeFileSync(gpFile,gp);
      try{await execAsync('gnuplot "'+gpFile+'"',{maxBuffer:10*1024*1024});}finally{try{fs.unlinkSync(gpFile);}catch{}}
      return 'Chart saved: '+outPath;
    }finally{try{fs.unlinkSync(tmpCsv);}catch{}}
  }
  private gpe(s:string):string{return s.replace(/[\\"'`]/g,'');}

  // Check whether an external binary is on PATH (used for fail-loud on gnuplot/duckdb).
  private async hasBinary(name: string): Promise<boolean> {
    const probe = process.platform === 'win32' ? 'where ' + name : 'command -v ' + name;
    try { await execAsync(probe); return true; } catch { return false; }
  }

  // --- Zero-dependency data loading (no duckdb) for pie chart + pivot ---
  // Parses CSV/JSON directly in TS so these paths work without any external binary.
  private parseTable(f: string): { columns: string[]; rows: Record<string, string>[] } {
    const e = path.extname(f).toLowerCase();
    const raw = fs.readFileSync(f, 'utf8');
    if (e === '.json') return this.parseJsonTable(raw);
    return this.parseCsvTable(raw);
  }
  private parseJsonTable(raw: string): { columns: string[]; rows: Record<string, string>[] } {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new Error('invalid JSON'); }
    const arr = Array.isArray(data) ? data : [data];
    const columns: string[] = [];
    const rows: Record<string, string>[] = [];
    for (const item of arr) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const rec: Record<string, string> = {};
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          if (!columns.includes(k)) columns.push(k);
          rec[k] = v == null ? '' : String(v);
        }
        rows.push(rec);
      }
    }
    return { columns, rows };
  }
  private parseCsvLine(line: string): string[] {
    const out: string[] = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out.map(s => s.trim());
  }
  private parseCsvTable(raw: string): { columns: string[]; rows: Record<string, string>[] } {
    const lines = raw.split(/\r?\n/).filter(l => l.length > 0);
    if (lines.length === 0) return { columns: [], rows: [] };
    const columns = this.parseCsvLine(lines[0]);
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = this.parseCsvLine(lines[i]);
      const rec: Record<string, string> = {};
      columns.forEach((c, idx) => { rec[c] = cells[idx] ?? ''; });
      rows.push(rec);
    }
    return { columns, rows };
  }

  // --- Real pie chart via inline SVG (zero external dependency, no gnuplot) ---
  private renderPieSvg(labels: string[], values: number[], title: string): string {
    const total = values.reduce((a, b) => a + b, 0);
    const W = 800, H = 600, cx = 300, cy = 300, r = 220;
    const palette = ['#4A90D9','#D94A90','#50B36E','#E8A33D','#9B59B6','#1ABC9C','#E74C3C','#34495E','#F39C12','#16A085','#8E44AD','#2980B9'];
    const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    let angle = -Math.PI / 2; // start at top
    const slices: string[] = [];
    const legend: string[] = [];
    for (let i = 0; i < values.length; i++) {
      const frac = total > 0 ? values[i] / total : 0;
      const pct = (frac * 100);
      const color = palette[i % palette.length];
      if (total > 0 && frac > 0) {
        const end = angle + frac * Math.PI * 2;
        const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
        const large = frac > 0.5 ? 1 : 0;
        // Full circle (single slice = 100%) needs a special path
        if (frac >= 0.9999) {
          slices.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`);
        } else {
          slices.push(`<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${color}"/>`);
        }
        // percentage label at slice midpoint
        const mid = angle + (frac * Math.PI * 2) / 2;
        const lx = cx + r * 0.6 * Math.cos(mid), ly = cy + r * 0.6 * Math.sin(mid);
        slices.push(`<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" font-size="16" fill="#fff" text-anchor="middle" dominant-baseline="middle">${pct.toFixed(1)}%</text>`);
        angle = end;
      }
      const ly = 90 + i * 26;
      legend.push(`<rect x="580" y="${ly - 12}" width="16" height="16" fill="${color}"/><text x="604" y="${ly}" font-size="14" fill="#333" dominant-baseline="middle">${esc(labels[i])} (${pct.toFixed(1)}%)</text>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<text x="${W/2}" y="40" font-size="22" font-family="sans-serif" text-anchor="middle" fill="#222">${esc(title)}</text>
<g font-family="sans-serif">
${slices.join('\n')}
${legend.join('\n')}
</g>
</svg>`;
  }
  // Aggregate rows into (label -> summed numeric value) pairs for a pie chart.
  private aggregateForPie(rows: Record<string, string>[], labelCol: string, valueCol?: string): { labels: string[]; values: number[] } {
    const acc = new Map<string, number>();
    const order: string[] = [];
    for (const row of rows) {
      const label = row[labelCol] ?? '';
      if (label === '') continue;
      // No value column => count occurrences; else sum the numeric value.
      const v = valueCol ? (parseFloat(row[valueCol]) || 0) : 1;
      if (!acc.has(label)) { acc.set(label, 0); order.push(label); }
      acc.set(label, acc.get(label)! + v);
    }
    return { labels: order, values: order.map(l => acc.get(l)!) };
  }
  private async doPieChart(p: AnalyzeDataToolParams): Promise<string> {
    const { input_path, x_column, y_column } = p;
    const ext = path.extname(input_path).toLowerCase();
    if (!['.csv', '.json'].includes(ext)) {
      throw new Error('pie chart supports .csv/.json only (zero-dependency renderer); ' + ext + ' requires duckdb which is not available');
    }
    const { columns, rows } = this.parseTable(input_path);
    if (!columns.includes(x_column!)) throw new Error('column not found: ' + x_column + ' (available: ' + columns.join(', ') + ')');
    if (y_column && !columns.includes(y_column)) throw new Error('column not found: ' + y_column + ' (available: ' + columns.join(', ') + ')');
    const { labels, values } = this.aggregateForPie(rows, x_column!, y_column);
    if (!labels.length) return 'No data for pie chart';
    const title = path.basename(input_path) + ' - ' + x_column + (y_column ? ' by ' + y_column : ' (count)');
    const outFmt = p.output_format || 'svg';
    if (outFmt === 'terminal') {
      const total = values.reduce((a, b) => a + b, 0);
      let c = title + '\n\n';
      const ml = Math.max(...labels.map(l => l.length), 6);
      for (let i = 0; i < labels.length; i++) {
        const pct = total > 0 ? (values[i] / total) * 100 : 0;
        const bar = '#'.repeat(Math.round((pct / 100) * 40));
        c += labels[i].padStart(ml) + ' | ' + bar + ' ' + pct.toFixed(1) + '% (' + values[i] + ')\n';
      }
      return c;
    }
    // png requested but we produce a real SVG (no gnuplot); write .svg and tell the caller.
    const svg = this.renderPieSvg(labels, values, title);
    let outPath = p.output_path || path.join(path.dirname(input_path), 'chart_' + path.basename(input_path, path.extname(input_path)) + '.svg');
    if (outPath.toLowerCase().endsWith('.png')) outPath = outPath.replace(/\.png$/i, '.svg');
    else if (!outPath.toLowerCase().endsWith('.svg')) outPath = outPath + '.svg';
    fs.writeFileSync(outPath, svg);
    return 'Pie chart (SVG) saved: ' + outPath + ' (' + labels.length + ' slices)';
  }

  // --- Real 2-D pivot (row dim x col dim) in pure TS, no duckdb ---
  private aggregateFn(name: string): { fn: (vals: number[]) => number; needsValue: boolean } {
    const m = /^(sum|avg|mean|count|min|max)\s*\(/i.exec(name.trim());
    const kind = m ? m[1].toLowerCase() : 'sum';
    switch (kind) {
      case 'count': return { fn: (v) => v.length, needsValue: false };
      case 'avg': case 'mean': return { fn: (v) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0, needsValue: true };
      case 'min': return { fn: (v) => v.length ? Math.min(...v) : 0, needsValue: true };
      case 'max': return { fn: (v) => v.length ? Math.max(...v) : 0, needsValue: true };
      default: return { fn: (v) => v.reduce((a, b) => a + b, 0), needsValue: true };
    }
  }
  // Extracts the value column name from an aggregate expression like "SUM(amount)".
  private aggregateValueColumn(expr: string): string | null {
    const m = /\(\s*([^)]*?)\s*\)/.exec(expr);
    if (!m) return null;
    const inner = m[1].trim();
    if (inner === '' || inner === '*') return null;
    return inner.replace(/^["']|["']$/g, '');
  }
  private csvCell(s: string): string {
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  private computePivot2D(rows: Record<string, string>[], rowCol: string, colCol: string, aggExpr: string): { header: string[]; matrix: string[][] } {
    const { fn, needsValue } = this.aggregateFn(aggExpr);
    const valueCol = this.aggregateValueColumn(aggExpr);
    if (needsValue && !valueCol) throw new Error('aggregate ' + aggExpr + ' requires a column, e.g. SUM(amount)');
    const rowKeys: string[] = [];
    const colKeys: string[] = [];
    const buckets = new Map<string, number[]>();
    for (const r of rows) {
      const rk = r[rowCol] ?? '';
      const ck = r[colCol] ?? '';
      if (!rowKeys.includes(rk)) rowKeys.push(rk);
      if (!colKeys.includes(ck)) colKeys.push(ck);
      const key = rk + ' ' + ck;
      if (!buckets.has(key)) buckets.set(key, []);
      const v = needsValue ? parseFloat(valueCol ? r[valueCol] : '') : 0;
      if (!needsValue || !isNaN(v)) buckets.get(key)!.push(needsValue ? v : 0);
    }
    rowKeys.sort(); colKeys.sort();
    const header = [rowCol + '\\' + colCol, ...colKeys];
    const matrix: string[][] = [];
    for (const rk of rowKeys) {
      const line = [rk];
      for (const ck of colKeys) {
        const vals = buckets.get(rk + ' ' + ck);
        line.push(vals && vals.length ? String(fn(vals)) : (needsValue ? '' : '0'));
      }
      matrix.push(line);
    }
    return { header, matrix };
  }
  private termChart(csv:string,ct:string,xC:string,yC:string):string{
    const data=csv.trim().split('\n').slice(1).map(l=>{const p=l.split(',');return{label:(p[0]||'').replace(/"/g,''),value:parseFloat(p[1])||0};}).filter(d=>d.label&&!isNaN(d.value));
    if(!data.length)return'No numeric data';const mv=Math.max(...data.map(d=>d.value));const ml=Math.max(...data.map(d=>d.label.length),6);
    let c=xC+' vs '+yC+' ('+ct+')\n\n';
    for(const d of data){const b='#'.repeat(Math.round((d.value/mv)*40));c+=d.label.padStart(ml)+' | '+b+' '+d.value.toFixed(1)+'\n';}
    return c;
  }
  private async doTransform(f:string,sql:string,out?:string):Promise<string>{
    const fullSql=sql.toLowerCase().includes('from ')?sql:'SELECT '+sql+' FROM '+this.tbl(f);
    const output=out||f.replace(/\.[^.]+$/,'_transformed.csv');
    await this.duckdb("COPY ("+fullSql+") TO '"+output.replace(/'/g,"''")+"' (FORMAT CSV, HEADER)");
    return 'Transformed data: '+output;
  }
  // Pivot. Single-dim (group_column only) or true 2-D cross-tab when col_dim (x_column) is given.
  // CSV/JSON use a pure-TS engine (zero dependency, fully verifiable). Other formats need duckdb.
  private async doPivot(f:string,g:string,a:string,out?:string,colDim?:string):Promise<string>{
    const ext=path.extname(f).toLowerCase();
    const pureTs=['.csv','.json'].includes(ext);
    if(colDim){
      // True cross-tab (row dim x col dim). Pure-TS path.
      if(!pureTs){
        if(!(await this.hasBinary('duckdb'))) throw new Error("2-D pivot on "+ext+" requires duckdb, which is not installed. Convert to CSV/JSON first (handled in pure TS), or install duckdb.");
        // duckdb PIVOT for non-csv/json when available
        const sql='PIVOT (SELECT * FROM '+this.tbl(f)+') ON "'+colDim+'" USING '+a+' GROUP BY "'+g+'" ORDER BY "'+g+'"';
        const output=out||f.replace(/\.[^.]+$/,'_pivot.csv');
        await this.duckdb("COPY ("+sql+") TO '"+output.replace(/'/g,"''")+"' (FORMAT CSV, HEADER)");
        const res=await this.duckdb(sql);
        return 'Pivot cross-tab ('+g+' x '+colDim+': '+a+')\n'+output+'\n\n'+res;
      }
      const {columns,rows}=this.parseTable(f);
      for(const c of [g,colDim]) if(!columns.includes(c)) throw new Error('column not found: '+c+' (available: '+columns.join(', ')+')');
      const {header,matrix}=this.computePivot2D(rows,g,colDim,a);
      const csvLines=[header.map(h=>this.csvCell(h)).join(','),...matrix.map(row=>row.map(c=>this.csvCell(c)).join(','))];
      const output=out||f.replace(/\.[^.]+$/,'_pivot.csv');
      fs.writeFileSync(output,csvLines.join('\n')+'\n');
      const preview=[header.join(' | '),...matrix.slice(0,20).map(r=>r.join(' | '))].join('\n');
      return 'Pivot cross-tab ('+g+' x '+colDim+': '+a+')\n'+output+'\n\n'+preview;
    }
    // Single-dimension pivot.
    if(pureTs){
      const {columns,rows}=this.parseTable(f);
      if(!columns.includes(g)) throw new Error('column not found: '+g+' (available: '+columns.join(', ')+')');
      const {fn,needsValue}=this.aggregateFn(a);
      const valueCol=this.aggregateValueColumn(a);
      if(needsValue&&!valueCol) throw new Error('aggregate '+a+' requires a column, e.g. SUM(amount)');
      const groups=new Map<string,number[]>(); const order:string[]=[];
      for(const r of rows){const k=r[g]??''; if(!groups.has(k)){groups.set(k,[]);order.push(k);} const v=needsValue?parseFloat(valueCol?r[valueCol]:''):0; if(!needsValue||!isNaN(v)) groups.get(k)!.push(needsValue?v:0);}
      order.sort();
      const header=[g,a];
      const csvLines=[header.map(h=>this.csvCell(h)).join(','),...order.map(k=>this.csvCell(k)+','+this.csvCell(String(fn(groups.get(k)!))))];
      const output=out||f.replace(/\.[^.]+$/,'_pivot.csv');
      fs.writeFileSync(output,csvLines.join('\n')+'\n');
      const preview=[header.join(' | '),...order.slice(0,20).map(k=>k+' | '+fn(groups.get(k)!))].join('\n');
      return 'Pivot ('+g+': '+a+')\n'+output+'\n\n'+preview;
    }
    // Non-csv/json single-dim: needs duckdb.
    if(!(await this.hasBinary('duckdb'))) throw new Error('pivot on '+ext+' requires duckdb, which is not installed. Convert to CSV/JSON (pure-TS pivot) or install duckdb.');
    const sql='SELECT "'+g+'", '+a+' FROM '+this.tbl(f)+' GROUP BY "'+g+'" ORDER BY "'+g+'"';
    const output=out||f.replace(/\.[^.]+$/,'_pivot.csv');
    await this.duckdb("COPY ("+sql+") TO '"+output.replace(/'/g,"''")+"' (FORMAT CSV, HEADER)");
    const result=await this.duckdb(sql);
    return 'Pivot ('+g+': '+a+')\n'+output+'\n\n'+result;
  }
  private async doExportExcel(f:string,out?:string):Promise<string>{
    const output=out||f.replace(/\.[^.]+$/,'_export.xlsx');
    const e=path.extname(f).toLowerCase();
    if(e==='.xlsx'||e==='.xls'){fs.copyFileSync(f,output);return'Copied: '+output;}
    await this.duckdb("COPY (SELECT * FROM "+this.tbl(f)+") TO '"+output.replace(/'/g,"''")+"' (FORMAT XLSX)");
    return 'Exported: '+output;
  }
}
