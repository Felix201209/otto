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

export interface GenerateDocumentToolParams {
  content: string;
  format: 'report'|'slides'|'letter'|'resume'|'article'|'table';
  output_format: 'pdf'|'docx'|'html'|'markdown'|'pptx';
  output_path?: string; title?: string; author?: string; template_options?: string;
}

export class GenerateDocumentTool extends BaseTool<GenerateDocumentToolParams, ToolResult> {
  static readonly Name: string = 'generate_document';

  constructor(private readonly config: Config) {
    const desc = `Generates polished documents from markdown content.

EXAMPLES:
  Report: {format:"report", output_format:"pdf", title:"Q3 Report", author:"Me", content:"# Summary\\n\\nContent here..."}
  Slides: {format:"slides", output_format:"pptx", title:"Presentation", content:"---\\n# Slide 1\\n\\n---\\n# Slide 2"}
  Letter: {format:"letter", output_format:"pdf", title:"Regarding...", author:"Me", content:"Body text..."}
  Resume: {format:"resume", output_format:"pdf", title:"My Resume", content:"## Experience\\n\\n- Job 1..."}
  Simple: {format:"article", output_format:"markdown", content:"# Hello World"}

ENGINES: PDF -> Typst (reports/letters/resume) or Pandoc (tables). Slides -> Marp (pdf, html, pptx). docx/html -> Pandoc.

DEPENDENCIES: typst + marp-cli + pandoc. macOS: brew install typst pandoc; npm i -g @marp-team/marp-cli. Windows: winget install typst pandoc; npm i -g @marp-team/marp-cli.`;
    super(GenerateDocumentTool.Name, 'GenerateDocument', desc, Icon.Pencil,
      {
        type: Type.OBJECT,
        properties: {
          content: { type: Type.STRING, description: 'Markdown content. Use # ## ### for headings, --- for slide breaks, - for lists, **bold**, *italic*' },
          format: { type: Type.STRING, enum: ['report','slides','letter','resume','article','table'], description: 'Document layout style' },
          output_format: { type: Type.STRING, enum: ['pdf','docx','html','markdown','pptx'], description: 'Output file format. Slides only: pdf, html, pptx.' },
          output_path: { type: Type.STRING, description: 'Output file path. Default: Desktop/generated_<ts>.<ext>' },
          title: { type: Type.STRING, description: 'Document title (appears in header/metadata)' },
          author: { type: Type.STRING, description: 'Author name (appears in metadata)' },
          template_options: { type: Type.STRING, description: 'Extra flags for the rendering engine' },
        },
        required: ['content','format','output_format'],
      },
    );
  }

  validateToolParams(p: GenerateDocumentToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, GenerateDocumentTool.Name);
    if (e) return e;
    if (!p.content?.trim()) return 'generate_document: content is required';
    if (p.format==='slides' && !['pdf','html','pptx'].includes(p.output_format))
      return 'generate_document/slides: output_format must be pdf, html, or pptx. Got: '+p.output_format;
    return null;
  }

  toolLocations(p: GenerateDocumentToolParams): ToolLocation[] {
    return p.output_path ? [{ path: p.output_path }] : [];
  }
  getDescription(p: GenerateDocumentToolParams): string {
    return 'generate '+p.format+' as '+p.output_format;
  }
  async shouldConfirmExecute(p: GenerateDocumentToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    if (this.validateToolParams(p)) return false;
    return { type:'exec', title:'Confirm: '+this.getDescription(p), command:'generate_document', rootCommand:'generate_document', onConfirm: async ()=>{}};
  }

  async execute(p: GenerateDocumentToolParams, _s: AbortSignal): Promise<ToolResult> {
    const logLabel = 'generate_document.'+(p.output_format || p.format);
    console.time(logLabel);
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    const { content, format, output_format, title, author } = p;
    const titleStr = title || 'Untitled';
    const authorStr = author || '';
    const outPath = p.output_path || path.join(os.homedir(), 'Desktop', 'generated_'+Date.now()+'.'+output_format);
    const tmpDir = path.join(os.tmpdir(), 'otto-doc-'+Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      if (format === 'slides') {
        await this.genSlides(content, output_format, outPath, tmpDir, titleStr);
      } else if (output_format === 'markdown') {
        fs.writeFileSync(outPath, '# '+titleStr+'\n'+(authorStr?'**'+authorStr+'**\n':'')+'\n'+content);
      } else if (output_format === 'pdf' && ['report','article','letter','resume'].includes(format)) {
        await this.genTypst(content, format, outPath, tmpDir, titleStr, authorStr);
      } else {
        await this.genPandoc(content, outPath, tmpDir, titleStr, authorStr, output_format, format);
      }

      const sz = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
      const label = path.basename(outPath)+' ('+format+', '+sz+' bytes)';
      return { llmContent: 'generate_document OK: '+label, returnDisplay: 'generate_document OK: '+label };
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      if (m.includes('not found') || m.includes('command not found')) {
        return { llmContent: 'generate_document FAIL: tool not installed. macOS: brew install typst pandoc; npm i -g @marp-team/marp-cli. '+m, returnDisplay: 'generate_document FAIL: tool not installed' };
      }
      return { llmContent: 'generate_document FAIL: '+m, returnDisplay: 'generate_document FAIL: '+m };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  private async genSlides(content: string, fmt: string, outPath: string, tmpDir: string, title: string): Promise<void> {
    const mdFile = path.join(tmpDir, 'slides.md');
    fs.writeFileSync(mdFile, '---\nmarp: true\ntheme: default\npaginate: true\ntitle: '+title+'\n---\n\n'+content);
    if (fmt === 'pptx') {
      await execAsync('marp "'+mdFile+'" --pptx -o "'+outPath+'" --allow-local-files', { maxBuffer:50*1024*1024 });
    } else {
      await execAsync('marp "'+mdFile+'" -o "'+outPath+'" --allow-local-files', { maxBuffer:50*1024*1024 });
    }
  }
  private async genTypst(content: string, format: string, outPath: string, tmpDir: string, title: string, author: string): Promise<void> {
    const typFile = path.join(tmpDir, 'doc.typ');
    fs.writeFileSync(typFile, this.md2typst(content, format, title, author));
    await execAsync('typst compile "'+typFile+'" "'+outPath+'"', { maxBuffer:50*1024*1024 });
  }
  private async genPandoc(content: string, outPath: string, tmpDir: string, title: string, author: string, fmt: string, format: string): Promise<void> {
    const mdFile = path.join(tmpDir, 'doc.md');
    fs.writeFileSync(mdFile, '# '+title+'\n'+(author?'**'+author+'**\n':'')+'\n'+content);
    const extra = format==='report' ? ' --toc --number-sections' : '';
    await execAsync('pandoc "'+mdFile+'" -o "'+outPath+'" -f markdown -t '+fmt+' --standalone'+extra, { maxBuffer:50*1024*1024 });
  }

  private md2typst(md: string, format: string, title: string, author: string): string {
    const now = new Date().toLocaleDateString();
    let preamble = '#set document(title: "'+this.te(title)+'", author: "'+this.te(author)+'", date: "'+now+'")\n\n';
    if (format==='report'||format==='article') {
      preamble += '#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm), numbering: "1")\n';
      preamble += '#set text(font: "New Computer Modern", size: 11pt)\n#set par(justify: true, leading: 0.8em)\n';
      preamble += '#show heading: it => { if it.level == 1 [= #it.body] else if it.level == 2 [== #it.body] else [=== #it.body] }\n#pagebreak()\n';
    } else if (format==='letter') {
      preamble += '#set page(paper: "a4", margin: 2.5cm)\n#set text(font: "New Computer Modern", size: 11pt)\n#set par(justify: true)\n';
    } else if (format==='resume') {
      preamble += '#set page(paper: "a4", margin: 1.5cm)\n#set text(font: "New Computer Modern", size: 10pt)\n';
    } else {
      preamble += '#set page(paper: "a4", margin: 2.5cm)\n#set text(size: 11pt)\n#set par(justify: true)\n';
    }

    const cb: string[] = [];
    let s = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, body) => {
      cb.push('#raw(block: true'+(lang?', lang: "'+this.te(lang)+'"':'')+', "'+this.te(body.trim())+'")');
      return '\x00CB'+ (cb.length-1) +'\x00';
    });
    const ic: string[] = [];
    s = s.replace(/`([^`]+)`/g, (_, body) => { ic.push('#raw("'+this.te(body)+'")'); return '\x00IC'+ (ic.length-1) +'\x00'; });
    s = s.replace(/^### (.+)$/gm, '=== $1');
    s = s.replace(/^## (.+)$/gm, '== $1');
    s = s.replace(/^# (.+)$/gm, '= $1');
    s = s.replace(/\*\*(.+?)\*\*/g, '*$1*');
    s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');
    s = s.replace(/^> (.+)$/gm, '#quote[$1]');
    s = s.replace(/^- (.+)$/gm, '- $1');
    s = s.replace(/^(\d+)\. (.+)$/gm, '+ $2');
    s = s.replace(/\x00CB(\d+)\x00/g, (_, i) => cb[+i]);
    s = s.replace(/\x00IC(\d+)\x00/g, (_, i) => ic[+i]);
    return preamble + '\n' + s;
  }
  private te(s: string): string { return s.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,' '); }
}
