/**
 * @license
 * Copyright 2026 Miraphant
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import type { Part } from '@google/genai';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { Config } from '../config/config.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getErrorMessage } from '../utils/errors.js';
import { SceneType } from '../core/sceneManager.js';
import { getResponseText } from '../utils/generateContentResponseUtilities.js';
import { isCustomModel, generateCustomModelId } from '../types/customModel.js';

const execAsync = promisify(exec);

const TEMP_DIR = '/tmp/otto-video';
const KB_DIR = join(homedir(), '.otto', 'kb', 'videos');
const SCENE_THRESHOLD = 0.4;
const MAX_FRAMES = 30;

export interface VideoAnalyzerToolParams {
  url: string;
  save_to_kb?: boolean;
  lang?: string;
}

function isURL(s: string): boolean {
  return /^https?:\/\//.test(s);
}
function isYouTube(u: string): boolean {
  return /youtube\.com|youtu\.be/.test(u);
}
function platform(u: string): string {
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/zoom\.us|zoom\.com/.test(u)) return 'zoom';
  if (/loom\.com/.test(u)) return 'loom';
  return 'other';
}
function ensureDir(d: string) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
function parseSub(content: string): string {
  return content
    .replace(/^WEBVTT.*$/m, '')
    .replace(/^\d+$/gm, '')
    .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3}.*$/gm, '')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join(' ');
}

/**
 * VideoAnalyzer Tool
 *
 * Give Otto the ability to watch videos. Accepts a video URL (YouTube/Zoom/Loom)
 * or local path, downloads it, uses FFmpeg scene detection to extract key frames,
 * fetches subtitles (YouTube official or Whisper), and sends frames+subtitles
 * to a vision-capable LLM for structured analysis.
 *
 * After analysis, suggests saving to the knowledge base for future recall.
 */
export class VideoAnalyzerTool extends BaseTool<VideoAnalyzerToolParams, ToolResult> {
  static readonly Name: string = 'analyze_video';

  constructor(private readonly config: Config) {
    super(
      VideoAnalyzerTool.Name,
      'VideoAnalyzer',
      'Analyze a video from URL or local path. Downloads the video, extracts key frames ' +
        'via FFmpeg scene detection (only captures frames when the screen actually changes), ' +
        'fetches subtitles (YouTube official free subtitles, or Whisper for Zoom/Loom/local), ' +
        'and generates a structured LLM summary with key moments and action items. ' +
        'Optionally saves to the knowledge base for future recall. ' +
        'Use when the user asks to watch/analyze/summarize a video.',
      Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          url: {
            type: Type.STRING,
            description:
              'Video URL (YouTube, Zoom, Loom) or local file path. ' +
              'Examples: https://www.youtube.com/watch?v=xxx, /path/to/video.mp4',
          },
          save_to_kb: {
            type: Type.BOOLEAN,
            description:
              'Whether to save the analysis to the knowledge base for future recall. ' +
              'Default: false. Set to true if the user wants to remember this video.',
          },
          lang: {
            type: Type.STRING,
            description: 'Language hint for transcription (e.g. "zh", "en"). Default: "zh".',
          },
        },
        required: ['url'],
      },
    );
  }

  override validateToolParams(params: VideoAnalyzerToolParams): string | null {
    if (!params.url || typeof params.url !== 'string') {
      return 'Error: url is required and must be a string.';
    }
    return null;
  }

  async execute(
    params: VideoAnalyzerToolParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return { llmContent: validationError, returnDisplay: validationError };
    }

    const { url, save_to_kb = false, lang = 'zh' } = params;

    try {
      // ===== Step 1: Download =====
      let videoPath = url;
      let videoTitle = 'Unknown';
      let videoDuration = 0;

      if (isURL(url)) {
        ensureDir(TEMP_DIR);
        videoPath = join(TEMP_DIR, 'video.mp4');

        // Download via yt-dlp
        const dlCmd = isYouTube(url) || platform(url) !== 'other'
          ? `yt-dlp -f "best[ext=mp4]/best" -o "${videoPath}" "${url}"`
          : `curl -L -s -o "${videoPath}" "${url}"`;
        await execAsync(dlCmd, { timeout: 300000, signal });

        if (!existsSync(videoPath)) {
          return { llmContent: 'Error: video download failed.', returnDisplay: 'Download failed' };
        }

        // Get title
        try {
          const { stdout: titleOut } = await execAsync(`yt-dlp --get-title "${url}"`, { timeout: 30000 });
          videoTitle = titleOut.trim() || 'Unknown';
        } catch { /* ignore */ }

        // Get duration
        try {
          const { stdout: durOut } = await execAsync(
            `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`,
          );
          videoDuration = parseFloat(durOut.trim()) || 0;
        } catch { /* ignore */ }
      } else {
        // Local file
        if (!existsSync(url)) {
          return { llmContent: `Error: file not found: ${url}`, returnDisplay: 'File not found' };
        }
        try {
          const { stdout: durOut } = await execAsync(
            `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${url}"`,
          );
          videoDuration = parseFloat(durOut.trim()) || 0;
        } catch { /* ignore */ }
        videoTitle = url.split('/').pop() || 'Unknown';
      }

      // ===== Step 2: Scene detection frame extraction =====
      const framesDir = join(TEMP_DIR, 'frames');
      ensureDir(framesDir);
      const framePattern = join(framesDir, 'frame_%04d.jpg');

      await execAsync(
        `ffmpeg -i "${videoPath}" ` +
        `-vf "select='gt(scene,${SCENE_THRESHOLD})'" ` +
        `-vsync vfr -q:v 2 "${framePattern}" -y`,
        { timeout: 120000, signal },
      ).catch(() => {/* may produce 0 frames for static videos */});

      let frames = existsSync(framesDir)
        ? readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort()
        : [];

      // Fallback: uniform sampling if too few frames
      if (frames.length < 3) {
        const count = 10;
        for (let i = 1; i <= count; i++) {
          const t = (videoDuration / count * i).toFixed(1);
          const out = join(framesDir, `sample_${String(i).padStart(4, '0')}.jpg`);
          try {
            await execAsync(`ffmpeg -ss ${t} -i "${videoPath}" -frames:v 1 -q:v 2 "${out}" -y`, { timeout: 10000 });
          } catch { /* skip */ }
        }
        frames = readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
      }

      // Downsample if too many
      if (frames.length > MAX_FRAMES) {
        const step = Math.ceil(frames.length / MAX_FRAMES);
        frames = frames.filter((_, i) => i % step === 0);
      }

      // ===== Step 3: Subtitles =====
      let subtitleText = '';
      let subtitleSource = 'none';

      if (isURL(url) && isYouTube(url)) {
        // Try YouTube official subtitles first
        try {
          const subBase = join(TEMP_DIR, 'subtitle');
          await execAsync(
            `yt-dlp --write-auto-sub --sub-lang ${lang},en --skip-download -o "${subBase}" "${url}"`,
            { timeout: 60000 },
          );
          const subFiles = readdirSync(TEMP_DIR).filter(
            f => f.startsWith('subtitle') && (f.endsWith('.vtt') || f.endsWith('.srt')),
          );
          if (subFiles.length > 0) {
            subtitleText = parseSub(readFileSync(join(TEMP_DIR, subFiles[0]), 'utf-8'));
            subtitleSource = 'youtube_official';
          }
        } catch { /* fall through to whisper */ }
      }

      // Fallback: Whisper (only if no subtitles yet)
      if (!subtitleText) {
        try {
          await execAsync(
            `whisper "${videoPath}" --model base --language ${lang} --output_format txt --output_dir "${TEMP_DIR}"`,
            { timeout: 600000, signal },
          );
          const txtFile = join(TEMP_DIR, videoPath.split('/').pop()!.replace(/\.\w+$/, '') + '.txt');
          if (existsSync(txtFile)) {
            subtitleText = readFileSync(txtFile, 'utf-8').trim();
            subtitleSource = 'whisper';
          }
        } catch { /* no subtitles available */ }
      }

      // ===== Step 4: LLM Analysis =====
      // Read frames as base64 for vision model
      const framePaths = frames.slice(0, MAX_FRAMES).map(f => join(framesDir, f));
      const frameBuffers: Buffer[] = [];
      for (const fp of framePaths) {
        try {
          frameBuffers.push(readFileSync(fp));
        } catch { /* skip */ }
      }

      // Build analysis prompt
      const subContext = subtitleText
        ? `\n\n字幕内容（来源：${subtitleSource}）：\n${subtitleText.substring(0, 4000)}`
        : '\n\n（无字幕信息）';

      const analysisPrompt =
        `你是一个视频分析助手。以下是视频的关键帧${frameBuffers.length > 0 ? '（图片）' : ''}和字幕信息。` +
        `请分析视频内容并输出结构化总结。\n\n` +
        `视频标题：${videoTitle}\n` +
        `视频时长：${Math.round(videoDuration)}秒\n` +
        `提取帧数：${frameBuffers.length}帧` +
        subContext +
        `\n\n请输出以下内容：\n` +
        `1. summary: 一句话概述视频内容（不超过100字）\n` +
        `2. topics: 视频涉及的主要主题（数组）\n` +
        `3. key_moments: 关键时刻列表，每个含 frame_index 和 description\n` +
        `4. action_items: 如果视频中有可执行的建议或步骤\n` +
        `5. target_audience: 目标观众`;

      // Try vision model via Otto's temporary chat (like AudioReaderTool)
      let analysisResult = '';

      const currentModel = typeof this.config.getModel === 'function' ? this.config.getModel() : undefined;
      const isUsingCustomModel = currentModel ? isCustomModel(currentModel) : false;
      let resolvedModel: string | undefined = undefined;

      if (isUsingCustomModel && typeof this.config.getCustomModels === 'function') {
        const customModels = this.config.getCustomModels() || [];
        const visionModel = customModels.find(m => {
          if (m.enabled === false) return false;
          const id = (m.modelId || '').toLowerCase();
          const name = (m.displayName || '').toLowerCase();
          return (id.includes('gemini') && id.includes('flash')) ||
                 (id.includes('gpt-4o')) ||
                 (id.includes('vision')) ||
                 (name.includes('gemini') && name.includes('flash')) ||
                 (name.includes('gpt-4o')) ||
                 (name.includes('vision'));
        });
        if (visionModel) {
          resolvedModel = generateCustomModelId(visionModel);
        }
      }

      try {
        const geminiClient = this.config.getOttoClient();
        const temporaryChat = await geminiClient.createTemporaryChat(
          SceneType.IMAGE_READER,
          resolvedModel,
          { type: 'sub', agentId: 'VideoAnalyzer' },
          { disableSystemPrompt: true },
        );

        const messageParts: Part[] = [{ text: analysisPrompt }];
        for (const buf of frameBuffers) {
          messageParts.push({
            inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') },
          });
        }

        const response = await temporaryChat.sendMessage(
          { message: messageParts, config: { abortSignal: signal } },
          `video-analyzer-${Date.now()}`,
          SceneType.IMAGE_READER,
        );

        analysisResult = (getResponseText(response) || '').trim();
      } catch (_e) {
        // Fallback: basic summary
        analysisResult =
          `视频"${videoTitle}"分析完成。\n` +
          `时长：${Math.round(videoDuration)}秒\n` +
          `提取帧数：${frameBuffers.length}帧\n` +
          `字幕来源：${subtitleSource}\n` +
          (subtitleText ? `字幕摘要：${subtitleText.substring(0, 500)}\n` : '') +
          `\n（注：视觉分析模型不可用，以上为基础摘要）`;
      }

      // ===== Step 5: Knowledge base =====
      let kbId = '';
      if (save_to_kb) {
        ensureDir(KB_DIR);
        const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        kbId = `video_${ts}`;
        const kbEntry = {
          id: kbId,
          url,
          title: videoTitle,
          platform: isURL(url) ? platform(url) : 'local',
          analyzed_at: new Date().toISOString(),
          duration_sec: Math.round(videoDuration),
          summary: analysisResult,
          subtitle_source: subtitleSource,
          transcript: subtitleText,
          frame_count: frameBuffers.length,
        };
        writeFileSync(join(KB_DIR, `${kbId}.json`), JSON.stringify(kbEntry, null, 2));
      }

      // ===== Output =====
      const output =
        `📹 视频分析完成\n\n` +
        `标题：${videoTitle}\n` +
        `来源：${isURL(url) ? platform(url) : '本地文件'}\n` +
        `时长：${Math.round(videoDuration)}秒\n` +
        `关键帧：${frameBuffers.length}帧（场景检测）\n` +
        `字幕：${subtitleSource}\n\n` +
        `分析结果：\n${analysisResult}` +
        (save_to_kb ? `\n\n✅ 已存入知识库（ID: ${kbId}）` : '');

      return {
        llmContent: output,
        returnDisplay: `Analyzed: ${videoTitle} (${Math.round(videoDuration)}s, ${frameBuffers.length} frames)`,
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      return {
        llmContent: `Error analyzing video "${url}": ${msg}`,
        returnDisplay: `Error: ${msg}`,
      };
    }
  }
}
