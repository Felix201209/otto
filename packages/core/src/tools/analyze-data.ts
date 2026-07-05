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
  Pie: {input_path:"/data/sales.csv", operation:"chart", chart_type:"pie", x_column:"category"}
  Pivot: {input_path:"/data/sales.csv", operation:"pivot", group_column:"region", aggregate:"SUM(amount)"}
  Transform: {input_path:"/data/sales.csv", operation:"transform", query:"WHERE amount > 1000 ORDER BY amount DESC", output_path:"/out/filtered.csv"}
  Export Excel: {input_path:"/data/sales.csv", operation:"export_excel", output_path:"/out/sales.xlsx"}

INPUT: CSV, JSON, XLSX, Parquet.
CHART OUTPUT: png (default), svg, terminal (ASCII art in terminal).

DEPENDENCIES: duckdb + gnuplot. macOS: brew install duckdb gnuplot. Windows: winget install DuckDB.cli; choco install gnuplot.`;
    super(AnalyzeDataTool.Name, 'AnalyzeData', desc, Icon.Info,
      {
        type: Type.OBJECT,
        properties: {
          input_path: { type: Type.STRING, description: 'Absolute path to data file (csv, json, xlsx, parquet)' },
          operation: { type: Type.STRING, enum: ['summary','query','chart','transform','pivot','export_excel'], description: 'What to do: quick stats, run SQL, plot chart, export, pivot table, save as xlsx' },
          query: { type: Type.STRING, description: 'DuckDB SQL. For query: full SELECT. For transform: WHERE/ORDER clauses (FROM auto-added). Can reference table as "t".' },
          chart_type: { type: Type.STRING, enum: ['bar','line','pie','scatter','histogram','box'], description: 'Chart type. For pie chart, only x_column is required.' },
          x_column: { type: Type.STRING, description: 'Column for X axis or pie labels' },
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
        case 'pivot': r=await this.doPivot(p.input_path, p.group_column!, p.aggregate!, p.output_path); break;
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
    try { const { stdout } = await execAsync('duckdb -csv -c "' + sql.replace(/'/g, "'\\''") + '"', { maxBuffer:20*1024*1024 }); return stdout.trim(); }
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
    const outFmt=output_format||'png';
    const outPath=p.output_path||path.join(path.dirname(input_path),'chart_'+path.basename(input_path,path.extname(input_path))+'.'+outFmt);
    const t=this.tbl(input_path);
    const cols=chart_type==='pie'?`"${x_column}", "${y_column||x_column}"`:`"${x_column}", "${y_column}"`;
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
      if(chart_type!=='pie') gp+='set ylabel "'+this.gpe(y_column!||'')+'"\n';
      switch(chart_type){case'pie':case'bar':gp+='set style fill solid\nset boxwidth 0.8\n';gp+="plot '"+tmpCsv+"' using 2:xtic(1) with boxes lc rgb '#4A90D9' notitle\n";break;case'line':gp+="plot '"+tmpCsv+"' using 1:2 with linespoints lc rgb '#4A90D9' lw 2 pt 7 ps 1 notitle\n";break;case'scatter':gp+="plot '"+tmpCsv+"' using 1:2 with points lc rgb '#D94A90' pt 7 ps 1.5 notitle\n";break;case'histogram':gp+='set style fill solid\nset boxwidth 0.8\n';gp+="plot '"+tmpCsv+"' using 1 with histogram lc rgb '#4A90D9' notitle\n";break;case'box':gp+="plot '"+tmpCsv+"' using 1:2 with boxplot notitle\n";break;default:gp+="plot '"+tmpCsv+"' using 1:2 with linespoints notitle\n";}
      fs.writeFileSync(gpFile,gp);
      try{await execAsync('gnuplot "'+gpFile+'"',{maxBuffer:10*1024*1024});}finally{try{fs.unlinkSync(gpFile);}catch{}}
      return 'Chart saved: '+outPath;
    }finally{try{fs.unlinkSync(tmpCsv);}catch{}}
  }
  private gpe(s:string):string{return s.replace(/[\\"'`]/g,'');}
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
  private async doPivot(f:string,g:string,a:string,out?:string):Promise<string>{
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
