/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CUSTOM_AGENT_PRESET_ICONS,
  createUploadedCustomAgentIcon,
  isCustomAgentIcon,
} from './customAgentIcons.js';

describe('自定义专家图标', () => {
  it('提供恰好 30 个不重复的企业常用预置图标', () => {
    expect(CUSTOM_AGENT_PRESET_ICONS).toHaveLength(30);
    expect(new Set(CUSTOM_AGENT_PRESET_ICONS.map((item) => item.id)).size).toBe(30);
    expect(new Set(CUSTOM_AGENT_PRESET_ICONS.map((item) => item.label)).size).toBe(30);
  });

  it('只接受注册的预置图标和受限的本地图片数据', () => {
    expect(isCustomAgentIcon({ kind: 'preset', name: 'agent-customer-success' })).toBe(true);
    expect(isCustomAgentIcon({ kind: 'preset', name: 'not-registered' })).toBe(false);
    expect(isCustomAgentIcon({
      kind: 'upload',
      dataUrl: 'data:image/webp;base64,UklGRg==',
    })).toBe(true);
    expect(isCustomAgentIcon({
      kind: 'upload',
      dataUrl: 'data:text/html;base64,PHNjcmlwdD4=',
    })).toBe(false);
    expect(isCustomAgentIcon({
      kind: 'upload',
      dataUrl: `data:image/png;base64,${'A'.repeat(200_000)}`,
    })).toBe(false);
  });

  it('上传时拒绝非图片和超过 5MB 的文件', async () => {
    await expect(createUploadedCustomAgentIcon(
      new File(['not-an-image'], 'payload.txt', { type: 'text/plain' }),
    )).rejects.toThrow('请选择 PNG、JPEG 或 WebP 图片');

    const oversized = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      'oversized.png',
      { type: 'image/png' },
    );
    await expect(createUploadedCustomAgentIcon(oversized)).rejects.toThrow('图片不能超过 5MB');
  });

  it('把上传图片居中裁切为正方形并保存为受限图片数据', async () => {
    const close = vi.fn();
    const bitmap = { width: 400, height: 200, close } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const drawImage = vi.fn();
    const context = { drawImage } as unknown as CanvasRenderingContext2D;
    const contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context);
    const dataSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/webp;base64,UklGRg==');

    try {
      await expect(createUploadedCustomAgentIcon(
        new File(['image'], 'avatar.png', { type: 'image/png' }),
      )).resolves.toEqual({ kind: 'upload', dataUrl: 'data:image/webp;base64,UklGRg==' });
      expect(drawImage).toHaveBeenCalledWith(bitmap, 100, 0, 200, 200, 0, 0, 256, 256);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      contextSpy.mockRestore();
      dataSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
