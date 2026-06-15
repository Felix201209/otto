/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 图片真实类型探测工具。
 *
 * 飞书图片资源下载后，过去一律以 `.png` 落盘，导致下游 `mime.lookup`
 * 按扩展名推断出错误的 mimeType。某些供应商（如 Anthropic Messages API）
 * 会校验 `media_type` 与图片实际字节是否一致，不匹配直接返回 400。
 *
 * 本模块提供两种探测手段（按可靠性排序）：
 *   1. 字节头嗅探（magic number）——最可靠，不受 HTTP 头是否准确影响
 *   2. HTTP Content-Type 映射——作为兜底
 */

export type ImageExtension =
  | '.png'
  | '.jpg'
  | '.gif'
  | '.webp'
  | '.bmp';

/**
 * 通过文件字节头（magic number）探测图片类型扩展名。
 *
 * @param bytes 图片二进制数据（至少前 12 字节有效）
 * @returns 形如 `.png` 的扩展名；无法识别时返回 undefined
 */
export function detectImageExtensionFromBytes(
  bytes: Uint8Array,
): ImageExtension | undefined {
  if (!bytes || bytes.length < 4) return undefined;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return '.png';
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return '.jpg';
  }

  // GIF: 47 49 46 38 (GIF8)
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return '.gif';
  }

  // BMP: 42 4D (BM)
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return '.bmp';
  }

  // WEBP: 52 49 46 46 (RIFF) .... 57 45 42 50 (WEBP)
  // 注意 RIFF 也用于 WAV/AVI，必须同时校验偏移 8 处的 WEBP 标识。
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return '.webp';
  }

  return undefined;
}

const CONTENT_TYPE_MAP: Record<string, ImageExtension> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
};

/**
 * 通过 HTTP Content-Type 头映射图片扩展名。
 * 会自动剥离 `; charset=...` 等参数并做大小写归一化。
 *
 * @param contentType 形如 `image/png; charset=binary` 的头部值
 * @returns 形如 `.png` 的扩展名；非图片或无法识别时返回 undefined
 */
export function detectImageExtensionFromContentType(
  contentType: string | null | undefined,
): ImageExtension | undefined {
  if (!contentType) return undefined;
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_MAP[normalized];
}

/**
 * 综合探测图片扩展名：优先信任字节头，其次 Content-Type，最后兜底 `.png`。
 *
 * 字节头优先的原因：HTTP 头可能缺失或不准确，而文件实际字节是权威依据。
 *
 * @param bytes       图片二进制数据
 * @param contentType HTTP 响应的 Content-Type（可选）
 * @returns 始终返回一个可用扩展名（最差情况兜底 `.png`）
 */
export function detectImageExtension(
  bytes: Uint8Array,
  contentType?: string | null,
): ImageExtension {
  return (
    detectImageExtensionFromBytes(bytes) ??
    detectImageExtensionFromContentType(contentType) ??
    '.png'
  );
}
