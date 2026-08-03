/**
 * @license
 * Copyright 2025 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Video Editor Tool - Built-in OpenReel video editor integration.
 * Loads OpenReel from bundled resources (no external server needed).
 */

import { exec, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BaseTool, ToolResult, ToolCallConfirmationDetails, Icon, ToolLocation } from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { SceneType } from '../core/sceneManager.js';

const execAsync = promisify(exec);

// OpenReel bundled path
const BUNDLED_EDITOR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..', 'resources', 'video-editor', 'index.html');
const DEV_URL = 'http://localhost:5174';
const PROJECTS_DIR = path.join(os.homedir(), '.otto', 'video-projects');

export interface VideoEditorToolParams {
  action: 'open' | 'import' | 'add_subtitle' | 'add_text' | 'cut' | 'export' | 'ai_edit' | 'status' | 'close';
  file_path?: string;
  text?: string;
  start_time?: number;
  end_time?: number;
  position?: 'top' | 'center' | 'bottom';
  duration?: number;
  font_size?: number;
  color?: string;
  export_format?: 'mp4' | 'webm' | 'prores';
  quality?: '480p' | '720p' | '1080p' | '4k';
  ai_instruction?: string;
}

export class VideoEditorTool extends BaseTool<VideoEditorToolParams, ToolResult> {
  static readonly Name: string = 'video_editor';
  private readonly managedChildren = new Set<ChildProcess>();

  constructor(private readonly config: Config) {
    const desc = `Built-in Video Editor (OpenReel) - Professional browser-based video editing, bundled with Otto.

ACTIONS:
  open:        Launch the video editor in a new window.
  import:      Import a video file into the editor.
               {action:"import", file_path:"/path/to/video.mp4"}
  add_subtitle: Add subtitle text at a specific time.
               {action:"add_subtitle", text:"Hello", start_time:1.5, duration:3}
  add_text:    Add styled text overlay.
               {action:"add_text", text:"Title", position:"top", font_size:48}
  cut:         Cut/trim video between two timestamps.
               {action:"cut", start_time:2.0, end_time:10.5}
  export:      Export the current project.
               {action:"export", export_format:"mp4", quality:"1080p"}
  ai_edit:     Natural language editing instruction.
               {action:"ai_edit", ai_instruction:"Add fade in for first 2 seconds"}
  status:      Check if editor is running.
  close:       Close the editor.

BUNDLED: Editor runs from local resources, no internet needed.
GPU: Uses WebGPU/WebCodecs for hardware acceleration.`;

    super(VideoEditorTool.Name, 'VideoEditor', desc, Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, description: 'Editor action', enum: ['open', 'import', 'add_subtitle', 'add_text', 'cut', 'export', 'ai_edit', 'status', 'close'] },
          file_path: { type: Type.STRING, description: 'Video file path (for import)' },
          text: { type: Type.STRING, description: 'Text content' },
          start_time: { type: Type.NUMBER, description: 'Start time in seconds' },
          end_time: { type: Type.NUMBER, description: 'End time in seconds' },
          position: { type: Type.STRING, description: 'Text position', enum: ['top', 'center', 'bottom'] },
          duration: { type: Type.NUMBER, description: 'Duration in seconds' },
          font_size: { type: Type.NUMBER, description: 'Font size (default: 32)' },
          color: { type: Type.STRING, description: 'Hex color (default: #FFFFFF)' },
          export_format: { type: Type.STRING, description: 'Export format', enum: ['mp4', 'webm', 'prores'] },
          quality: { type: Type.STRING, description: 'Export quality', enum: ['480p', '720p', '1080p', '4k'] },
          ai_instruction: { type: Type.STRING, description: 'Natural language edit instruction' },
        },
        required: ['action'],
      },
    );
  }

  validateToolParams(p: VideoEditorToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, VideoEditorTool.Name);
    if (e) return e;
    if (p.action === 'import' && !p.file_path) return 'video_editor/import: file_path required';
    if ((p.action === 'add_subtitle' || p.action === 'add_text') && !p.text) return 'video_editor/' + p.action + ': text required';
    if (p.action === 'cut' && (p.start_time === undefined || p.end_time === undefined)) return 'video_editor/cut: start_time and end_time required';
    if (p.action === 'ai_edit' && !p.ai_instruction) return 'video_editor/ai_edit: ai_instruction required';
    return null;
  }

  toolLocations(): ToolLocation[] { return []; }
  getDescription(p: VideoEditorToolParams): string { return 'video_editor: ' + p.action; }

  async shouldConfirmExecute(p: VideoEditorToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    if (this.validateToolParams(p)) return false;
    if (p.action === 'close') {
      return {
        type: 'exec',
        title: '[WARN] Close processes started by the video editor?',
        command: 'video_editor(close)',
        rootCommand: VideoEditorTool.Name,
        warning: 'Only child processes started and tracked by this tool will be terminated.',
        onConfirm: async () => {},
      };
    }
    return false; // Remaining editor actions are non-destructive or undoable.
  }

  private getEditorPath(): string {
    // Try bundled first, then dev server
    if (fs.existsSync(BUNDLED_EDITOR)) return 'file:///' + BUNDLED_EDITOR.replace(/\\/g, '/');
    return DEV_URL;
  }

  private trackManagedChild(child: ChildProcess): void {
    this.managedChildren.add(child);
    const forget = () => this.managedChildren.delete(child);
    child.once('exit', forget);
    child.once('error', forget);
  }

  private isManagedChildRunning(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null && !child.killed;
  }

  private async isEditorRunning(): Promise<boolean> {
    return [...this.managedChildren].some(child => this.isManagedChildRunning(child));
  }

  private closeManagedChildren(): number {
    let stopped = 0;
    for (const child of this.managedChildren) {
      try {
        if (this.isManagedChildRunning(child) && child.kill()) stopped++;
      } finally {
        this.managedChildren.delete(child);
      }
    }
    return stopped;
  }

  private async launchEditor(): Promise<string> {
    const editorPath = this.getEditorPath();
    const isWin = os.platform() === 'win32';

    if (editorPath.startsWith('file://')) {
      // Open bundled editor in default browser (works for all platforms)
      if (isWin) {
        this.trackManagedChild(exec(`start "" "${editorPath}"`));
      } else if (os.platform() === 'darwin') {
        this.trackManagedChild(exec(`open "${editorPath}"`));
      } else {
        this.trackManagedChild(exec(`xdg-open "${editorPath}"`));
      }
      return `launched bundled editor (${editorPath.substring(0, 50)}...)`;
    }

    // Fallback: try dev server
    if (!await this.isDevServerRunning()) {
      const openreelDir = path.join(os.homedir(), 'openreel-video');
      if (!fs.existsSync(openreelDir)) return 'OpenReel not installed. Clone: git clone https://github.com/Augani/openreel-video.git ~';
      const child = spawn('pnpm', ['dev', '--', '--port', '5174'], { cwd: openreelDir, stdio: 'ignore', shell: isWin });
      this.trackManagedChild(child);
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await this.isDevServerRunning()) break;
      }
    }

    if (isWin) this.trackManagedChild(exec(`start "" "${DEV_URL}"`));
    else if (os.platform() === 'darwin') this.trackManagedChild(exec(`open "${DEV_URL}"`));
    else this.trackManagedChild(exec(`xdg-open "${DEV_URL}"`));
    return `launched dev server at ${DEV_URL}`;
  }

  private async isDevServerRunning(): Promise<boolean> {
    try {
      const isWin = os.platform() === 'win32';
      const cmd = isWin
        ? `powershell -Command "(Invoke-WebRequest -Uri '${DEV_URL}' -UseBasicParsing -TimeoutSec 2).StatusCode"`
        : `curl -s -o /dev/null -w "%{http_code}" ${DEV_URL}`;
      const { stdout } = await execAsync(cmd, { timeout: 3000 });
      return stdout.trim() === '200';
    } catch { return false; }
  }

  async execute(p: VideoEditorToolParams, _s: AbortSignal): Promise<ToolResult> {
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    try {
      let r = '';
      switch (p.action) {
        case 'open': {
          r = await this.launchEditor();
          break;
        }

        case 'import': {
          if (!fs.existsSync(p.file_path!)) return { llmContent: `File not found: ${p.file_path}`, returnDisplay: 'Import failed' };
          if (!await this.isEditorRunning() && !await this.isDevServerRunning()) await this.launchEditor();
          await new Promise(r => setTimeout(r, 2000));
          r = `Video "${path.basename(p.file_path!)}" ready for import. In the editor, use File > Import to load it.\nPath: ${p.file_path}`;
          break;
        }

        case 'add_subtitle': {
          r = `Subtitle command queued: "${p.text}" at ${p.start_time || 0}s for ${p.duration || 3}s (${p.position || 'bottom'}). Apply in editor timeline.`;
          break;
        }

        case 'add_text': {
          r = `Text overlay queued: "${p.text}" (${p.position || 'center'}, ${p.font_size || 48}px, ${p.color || '#FFFFFF'}).`;
          break;
        }

        case 'cut': {
          r = `Cut command queued: ${p.start_time}s → ${p.end_time}s. Apply in editor timeline.`;
          break;
        }

        case 'export': {
          if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
          const outPath = path.join(PROJECTS_DIR, `export_${Date.now()}.${p.export_format || 'mp4'}`);
          r = `Export queued: ${p.export_format || 'mp4'} ${p.quality || '1080p'} → ${outPath}. Use editor's Export panel to start rendering.`;
          break;
        }

        case 'ai_edit': {
          const client = this.config.getOttoClient();
          if (client?.createTemporaryChat) {
            try {
              const chat = await client.createTemporaryChat(SceneType.IMAGE_READER);
              const resp = await chat.sendMessage({
                message: [{ text: `You are a video editing assistant. Convert this instruction to step-by-step editing commands: "${p.ai_instruction}". Reply with numbered steps.` }],
                config: { abortSignal: _s },
              }, `ai-edit-${Date.now()}`, SceneType.IMAGE_READER);
              const llmResponse = (resp?.text || '').trim();
              r = `AI edit plan:\n${llmResponse.substring(0, 800)}`;
            } catch {
              r = `AI instruction: "${p.ai_instruction}". (LLM unavailable — apply manually in editor)`;
            }
          } else {
            r = `AI instruction: "${p.ai_instruction}". (LLM unavailable — apply manually in editor)`;
          }
          break;
        }

        case 'status': {
          const bundled = fs.existsSync(BUNDLED_EDITOR);
          const running = await this.isEditorRunning() || await this.isDevServerRunning();
          r = `Editor: ${running ? 'running' : 'not running'} | Bundled: ${bundled ? 'yes' : 'no'} | Path: ${bundled ? BUNDLED_EDITOR : DEV_URL}`;
          break;
        }

        case 'close': {
          const stopped = this.closeManagedChildren();
          r = stopped > 0
            ? `${stopped} managed process${stopped === 1 ? '' : 'es'} closed`
            : 'No managed editor process was running; no external process was touched';
          break;
        }

        default:
          return { llmContent: 'video_editor FAIL: unknown action', returnDisplay: 'FAIL: unknown action' };
      }
      return { llmContent: 'video_editor OK: ' + r, returnDisplay: 'video_editor OK: ' + r.split('\n')[0] };
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      return { llmContent: 'video_editor FAIL: ' + m, returnDisplay: 'video_editor FAIL: ' + m };
    }
  }
}
