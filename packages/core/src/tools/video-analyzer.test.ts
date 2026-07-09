/**
 * @license
 * Copyright 2026 Miraphant
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VideoAnalyzerTool } from './video-analyzer.js';
import type { Config } from '../config/config.js';

vi.mock('./analyze-data.js', () => ({
  preflightBinaries: vi.fn(),
}));

import { preflightBinaries } from './analyze-data.js';

describe('VideoAnalyzerTool', () => {
  const mockConfig = {} as unknown as Config;

  beforeEach(() => {
    vi.mocked(preflightBinaries).mockReset();
  });

  it('rejects when url param is missing', async () => {
    const tool = new VideoAnalyzerTool(mockConfig);
    const result = await tool.execute(
      { url: '' } as any,
      new AbortController().signal,
    );
    expect(result.llmContent).toContain('url is required');
  });

  it('fails loud with an install command when ffmpeg is missing, before attempting any download', async () => {
    vi.mocked(preflightBinaries).mockResolvedValue(
      'ffmpeg 未安装（语音录音）。安装：brew install ffmpeg',
    );

    const tool = new VideoAnalyzerTool(mockConfig);
    const result = await tool.execute(
      { url: '/tmp/does-not-exist.mp4' },
      new AbortController().signal,
    );

    expect(preflightBinaries).toHaveBeenCalledWith(['ffmpeg']);
    expect(result.llmContent).toContain('analyze_video needs');
    expect(result.llmContent).toContain('brew install ffmpeg');
    // Regression guard: must fail before hitting the "file not found" branch,
    // proving the preflight check runs first and short-circuits execution.
    expect(result.llmContent).not.toContain('file not found');
  });

  it('requests yt-dlp as an additional required binary for YouTube URLs', async () => {
    vi.mocked(preflightBinaries).mockResolvedValue(
      'yt-dlp 未安装（视频下载）。安装：brew install yt-dlp',
    );

    const tool = new VideoAnalyzerTool(mockConfig);
    await tool.execute(
      { url: 'https://www.youtube.com/watch?v=abc123' },
      new AbortController().signal,
    );

    expect(preflightBinaries).toHaveBeenCalledWith(['ffmpeg', 'yt-dlp']);
  });

  it('does not require yt-dlp for local file paths', async () => {
    vi.mocked(preflightBinaries).mockResolvedValue(null);

    const tool = new VideoAnalyzerTool(mockConfig);
    await tool.execute(
      { url: '/tmp/does-not-exist.mp4' },
      new AbortController().signal,
    );

    expect(preflightBinaries).toHaveBeenCalledWith(['ffmpeg']);
  });
});
