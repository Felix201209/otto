/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 图片附件预处理：把用户选中的图片文件读入、按最长边等比缩放、统一压成 JPEG
 * base64，组成协议的 image_reference value（见 packages/server/src/protocol.ts）。
 *
 * 为什么压缩：原图直接 base64 走 WS 会撞 server 的 10MB maxPayload，且多数
 * vision 模型对超大图无收益。缩到最长边 1568px、JPEG 0.85 兼顾清晰与体积。
 */

import type { ImageAttachment, FileAttachment, Attachment } from '../state/useOttoStore.js';

/** 最长边上限（px）。对齐 Anthropic vision 推荐尺寸，兼顾清晰与体积。 */
const MAX_EDGE = 1568;
/** JPEG 导出质量。 */
const JPEG_QUALITY = 0.85;
/** 单张原图大小上限（字节）。超过直接拒绝，避免读入超大文件卡住渲染进程。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 单文件上传上限（字节）。 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** 单条消息最多附带的附件数。 */
export const MAX_ATTACHMENTS = 6;

let seq = 0;

const SUPPORTED_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
/** 允许上传的文档类型 */
const SUPPORTED_FILE_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.csv', '.json', '.xml', '.md', '.zip', '.log',
]);

/** 是否是本工具支持的图片类型。 */
export function isSupportedImage(file: File): boolean {
  return SUPPORTED_IMAGE.test(file.type);
}

/** 是否是允许的文档类型。 */
export function isSupportedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return [...SUPPORTED_FILE_EXTS].some((ext) => name.endsWith(ext));
}

/** 判断附件是否为图片类型 */
export function isImageAttachment(att: Attachment): att is ImageAttachment {
  return 'data' in att;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

/** 把 (w,h) 等比缩到最长边不超过 max；已足够小则原样返回。 */
function fitWithin(
  w: number,
  h: number,
  max: number,
): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  const scale = max / Math.max(w, h);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * 把一个图片文件转成 image_reference value（已压缩）。
 * 抛错场景：类型不支持、超出大小上限、解码/画布失败——由调用方捕获并提示。
 */
export async function fileToImageAttachment(
  file: File,
): Promise<ImageAttachment> {
  if (!isSupportedImage(file)) {
    throw new Error(`不支持的图片类型：${file.type || file.name}`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `图片过大（${Math.round(file.size / 1024 / 1024)}MB），上限 ${
        MAX_IMAGE_BYTES / 1024 / 1024
      }MB`,
    );
  }

  const dataUrl = await readAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const { width, height } = fitWithin(
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
    MAX_EDGE,
  );

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布上下文');
  // JPEG 无透明通道：先铺白底，避免透明 PNG 被压成黑块。
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const outMime = 'image/jpeg';
  const outUrl = canvas.toDataURL(outMime, JPEG_QUALITY);
  const base64 = outUrl.slice(outUrl.indexOf(',') + 1);

  return {
    id: `img-${Date.now()}-${seq++}`,
    fileName: file.name || 'image',
    data: base64,
    mimeType: outMime,
    originalSize: file.size,
    // base64 长度 → 原始字节数近似（每 4 字符 = 3 字节）。
    compressedSize: Math.floor((base64.length * 3) / 4),
    width,
    height,
  };
}

/** 从 image_reference value 还原可用于 <img src> 的 data URL。 */
export function attachmentToDataUrl(att: ImageAttachment): string {
  return `data:${att.mimeType};base64,${att.data}`;
}

/**
 * 把一个普通文件转为 file_reference value。
 * 不压缩、不转码——原样保留文件名和本地路径。
 */
export async function fileToFileAttachment(
  file: File,
): Promise<FileAttachment> {
  if (!isSupportedFile(file)) {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    throw new Error(
      `不支持的文件类型：${ext ? '.' + ext : file.name}。` +
      `支持的格式：${[...SUPPORTED_FILE_EXTS].join(' ')}`,
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `文件过大（${Math.round(file.size / 1024 / 1024)}MB），上限 ${MAX_FILE_BYTES / 1024 / 1024}MB`,
    );
  }

  // 对于 Electron 桌面端：file 对象可能带有 path 属性
  const filePath = (file as File & { path?: string }).path || file.name;

  return {
    fileName: file.name,
    filePath,
  };
}

/**
 * 通用附件处理：图片走压缩 pipeline，文件走直传 pipeline。
 */
export async function fileToAttachment(
  file: File,
): Promise<Attachment> {
  if (isSupportedImage(file)) {
    return fileToImageAttachment(file);
  }
  return fileToFileAttachment(file);
}
