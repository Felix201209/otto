/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  ToolConfirmationOutcome, Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ToolError, ToolErrorCode } from '../utils/tool-error.js';
import { ProcessGuard } from '../utils/process-guard.js';

const execAsync = promisify(exec);

export interface ConvertDocumentToolParams {
  input_path?: string; input_paths?: string[];
  output_format: string; output_path?: string;
  engine?: 'pandoc' | 'libreoffice' | 'auto';
  options?: string; merge?: boolean; compress?: number;
}

export class ConvertDocumentTool extends BaseTool<ConvertDocumentToolParams, ToolResult> {
  static readonly Name: string = 'convert_document';

  constructor(private readonly config: Config) {
    const desc = `Lossless document format conversion using pandoc and LibreOffice.

EXAMPLES:
  Single: {input_path:"/path/to/report.docx", output_format:"pdf"}
  Batch: {input_paths:["/a.docx","/b.docx"], output_format:"pdf"}
  Merge: {input_paths:["/a.docx","/b.docx"], output_format:"pdf", merge:true, output_path:"/merged.pdf"}
  Compress: {input_path:"/big.pdf", output_format:"pdf", compress:3}
  Custom: {input_path:"/doc.md", output_format:"pdf", engine:"pandoc", options:"--toc --number-sections"}

SUPPORTED FORMATS:
  Pandoc: markdown, html, pdf, docx, epub, latex, rst, org, plain, odt, rtf
  LibreOffice: pdf, docx, xlsx, pptx, odt, ods, odp, html, csv
  Engine "auto" picks best: office formats -> libreoffice, text formats -> pandoc

DEPENDENCIES: pandoc + libreoffice. macOS: brew install pandoc libreoffice. Windows: winget install pandoc LibreOffice.`;
    super(ConvertDocumentTool.Name, 'ConvertDocument', desc, Icon.FileSearch,
      {
        type: Type.OBJECT,
        properties: {
          input_path: { type: Type.STRING, description: 'Single input file (absolute path)' },
          input_paths: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Multiple input files for batch or merge mode' },
          output_format: { type: Type.STRING, description: 'Target format: pdf, docx, markdown, html, epub, latex, odt, rtf, csv' },
          output_path: { type: Type.STRING, description: 'Output file path. Default: same dir as input, new extension. Required for merge mode.' },
          engine: { type: Type.STRING, enum: ['pandoc','libreoffice','auto'], description: 'Conversion engine. Default: auto (best match)' },
          options: { type: Type.STRING, description: 'Extra CLI flags. pandoc: --toc --number-sections. libreoffice: --infilter=...' },
          merge: { type: Type.BOOLEAN, description: 'If true, merge all input_paths into one output_path. Requires output_path.' },
          compress: { type: Type.NUMBER, description: 'PDF compression level 1-5 where 1=smallest file, 5=best quality. Uses ghostscript.' },
        },
        required: ['output_format'],
      },
    );
  }

  validateToolParams(p: ConvertDocumentToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, ConvertDocumentTool.Name);
    if (e) return e;
    if (!p.input_path && (!p.input_paths || p.input_paths.length === 0))
      return 'convert_document: must provide input_path (single) or input_paths (batch/merge)';
    if (p.input_path && !path.isAbsolute(p.input_path))
      return 'convert_document: input_path must be absolute: '+p.input_path;
    if (p.input_paths) {
      for (const ip of p.input_paths) {
        if (!path.isAbsolute(ip)) return 'convert_document: input_paths must all be absolute: '+ip;
        if (!fs.existsSync(ip)) return 'convert_document: file not found: '+ip;
      }
    }
    if (p.input_path && !fs.existsSync(p.input_path))
      return 'convert_document: file not found: '+p.input_path;
    if (!p.output_format?.trim()) return 'convert_document: output_format required (e.g. pdf, docx, markdown)';
    if (p.merge && (!p.input_paths || p.input_paths.length < 2))
      return 'convert_document/merge: need at least 2 files in input_paths';
    if (p.merge && !p.output_path)
      return 'convert_document/merge: output_path required when merging';
    return null;
  }

  toolLocations(p: ConvertDocumentToolParams): ToolLocation[] {
    const locs: ToolLocation[] = [];
    if (p.input_path) locs.push({ path: p.input_path });
    if (p.input_paths) for (const ip of p.input_paths) locs.push({ path: ip });
    if (p.output_path) locs.push({ path: p.output_path });
    return locs;
  }

  getDescription(p: ConvertDocumentToolParams): string {
    if (p.merge) return 'merge '+ (p.input_paths?.length||0) +' docs -> '+ p.output_format;
    if (p.input_paths) return 'batch convert '+ p.input_paths.length +' files -> '+ p.output_format;
    return 'convert '+ path.basename(p.input_path!) +' -> '+ p.output_format;
  }

  async shouldConfirmExecute(p: ConvertDocumentToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    if (this.validateToolParams(p)) return false;
    return { type:'exec', title:'Confirm: '+this.getDescription(p), command:'convert_document', rootCommand:'convert_document', onConfirm: async ()=>{}};
  }

  async execute(p: ConvertDocumentToolParams, _s: AbortSignal): Promise<ToolResult> {
    const logLabel = 'convert_document.'+(p.output_format || 'single');
    console.time(logLabel);
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    try {
      if (p.merge && p.input_paths && p.input_paths.length >= 2) return await this.doMerge(p);
      if (p.input_paths && p.input_paths.length > 0) return await this.doBatch(p);
      return await this.doSingle(p);
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      if (m.includes('not found') || m.includes('command not found')) {
        const isMac = process.platform === 'darwin';
        return { llmContent: 'convert_document FAIL: '+m+'. Install: '+(isMac?'brew install pandoc libreoffice':'winget install pandoc LibreOffice'), returnDisplay: 'convert_document FAIL: tool not installed' };
      }
      return { llmContent: 'convert_document FAIL: '+m, returnDisplay: 'convert_document FAIL: '+m };
    }
  }

  private async doSingle(p: ConvertDocumentToolParams): Promise<ToolResult> {
    const { input_path: ip, output_format: fmt, engine, options } = p;
    const ext = path.extname(ip!).slice(1).toLowerCase();
    const outPath = p.output_path || ip!.replace(/\.[^.]+$/, '.'+fmt);
    const dir = path.dirname(ip!);

    let eng = engine || 'auto';
    if (eng === 'auto') {
      const offIn = ['docx','xlsx','pptx','odt','ods','odp'];
      const offOut = ['pdf','docx','xlsx','pptx','odt','ods','odp'];
      eng = offIn.includes(ext) || offOut.includes(fmt) ? 'libreoffice' : 'pandoc';
    }

    if (eng === 'libreoffice') {
      const loCmd = process.platform === 'win32' ? 'soffice' : 'libreoffice';
      await execAsync(`${loCmd} --headless --convert-to ${fmt} --outdir "${dir}" "${ip}"${options?' '+options:''}`, { maxBuffer:50*1024*1024 });
      const loName = path.basename(ip!, path.extname(ip!))+'.'+fmt;
      const loPath = path.join(dir, loName);
      if (p.output_path && path.resolve(loPath) !== path.resolve(p.output_path) && fs.existsSync(loPath)) {
        if (fs.existsSync(p.output_path)) fs.unlinkSync(p.output_path);
        fs.renameSync(loPath, p.output_path);
      }
    } else {
      let cmd = `pandoc "${ip}" -o "${outPath}"${options?' '+options:''}`;
      if (fmt === 'pdf' && !cmd.includes('--pdf-engine')) cmd += ' --pdf-engine=xelatex';
      await execAsync(cmd, { maxBuffer:50*1024*1024 });
    }

    if (p.compress && fmt === 'pdf' && fs.existsSync(outPath)) {
      await this.compressPDF(outPath, p.compress);
    }

    const sz = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    const label = path.basename(ip!)+' -> '+path.basename(outPath)+' ('+sz+' bytes)';
    return { llmContent: 'convert_document OK: '+label, returnDisplay: 'convert_document OK: '+label };
  }

  private async doBatch(p: ConvertDocumentToolParams): Promise<ToolResult> {
    const results: string[] = [];
    for (const ip of p.input_paths!) {
      const sp: ConvertDocumentToolParams = { ...p, input_path: ip, input_paths: undefined, merge: undefined };
      const r = await this.doSingle(sp);
      results.push(r.returnDisplay as string);
    }
    return { llmContent: 'convert_document batch OK: '+results.length+' files converted\n'+results.join('\n'), returnDisplay: 'convert_document OK: '+results.length+' files batch-converted' };
  }

  private async doMerge(p: ConvertDocumentToolParams): Promise<ToolResult> {
    const tmpDir = path.join(path.dirname(p.input_paths![0]), '.otto-merge-'+Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const mdFiles: string[] = [];
      for (let i = 0; i < p.input_paths!.length; i++) {
        const mdPath = path.join(tmpDir, 'part_'+i+'.md');
        await execAsync(`pandoc "${p.input_paths![i]}" -o "${mdPath}" -t markdown`, { maxBuffer:50*1024*1024 });
        mdFiles.push(mdPath);
      }
      const merged = path.join(tmpDir, 'merged.md');
      let allContent = '';
      for (const mf of mdFiles) allContent += fs.readFileSync(mf, 'utf8') + '\n\n\\pagebreak\n\n';
      fs.writeFileSync(merged, allContent);
      const sp: ConvertDocumentToolParams = { ...p, input_path: merged, input_paths: undefined, merge: undefined };
      return await this.doSingle(sp);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  private async compressPDF(file: string, level: number): Promise<void> {
    const settings = ['/default','/screen','/ebook','/printer','/prepress','/prepress'];
    const s = settings[Math.min(level, 5)];
    const tmp = file + '.tmp.pdf';
    const gsCmd = process.platform === 'win32' ? 'gswin64c' : 'gs';
    await execAsync(`${gsCmd} -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${s} -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${tmp}" "${file}"`, { maxBuffer:100*1024*1024 });
    if (fs.existsSync(tmp)) { fs.unlinkSync(file); fs.renameSync(tmp, file); }
  }
}
