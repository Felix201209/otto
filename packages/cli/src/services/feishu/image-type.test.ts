/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  detectImageExtension,
  detectImageExtensionFromBytes,
  detectImageExtensionFromContentType,
} from './image-type.js';

// Helper: build a buffer that starts with the given bytes, padded to a min length.
function buf(bytes: number[], minLen = 16): Uint8Array {
  const out = new Uint8Array(Math.max(bytes.length, minLen));
  out.set(bytes, 0);
  return out;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00];
// RIFF....WEBP
const WEBP = [
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
];
const BMP = [0x42, 0x4d, 0x00, 0x00];

describe('detectImageExtensionFromBytes (magic number sniffing)', () => {
  it('detects PNG', () => {
    expect(detectImageExtensionFromBytes(buf(PNG))).toBe('.png');
  });

  it('detects JPEG', () => {
    expect(detectImageExtensionFromBytes(buf(JPEG))).toBe('.jpg');
  });

  it('detects GIF', () => {
    expect(detectImageExtensionFromBytes(buf(GIF))).toBe('.gif');
  });

  it('detects WEBP (RIFF....WEBP)', () => {
    expect(detectImageExtensionFromBytes(buf(WEBP))).toBe('.webp');
  });

  it('detects BMP', () => {
    expect(detectImageExtensionFromBytes(buf(BMP))).toBe('.bmp');
  });

  it('returns undefined for unknown bytes', () => {
    expect(detectImageExtensionFromBytes(buf([0x00, 0x01, 0x02, 0x03]))).toBeUndefined();
  });

  it('returns undefined for too-short buffer', () => {
    expect(detectImageExtensionFromBytes(new Uint8Array([0x89]))).toBeUndefined();
  });

  it('does not misclassify RIFF that is not WEBP (e.g. WAV)', () => {
    // RIFF....WAVE
    const wav = [
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ];
    expect(detectImageExtensionFromBytes(buf(wav))).toBeUndefined();
  });
});

describe('detectImageExtensionFromContentType', () => {
  it('maps image/png', () => {
    expect(detectImageExtensionFromContentType('image/png')).toBe('.png');
  });

  it('maps image/jpeg and image/jpg to .jpg', () => {
    expect(detectImageExtensionFromContentType('image/jpeg')).toBe('.jpg');
    expect(detectImageExtensionFromContentType('image/jpg')).toBe('.jpg');
  });

  it('maps image/gif', () => {
    expect(detectImageExtensionFromContentType('image/gif')).toBe('.gif');
  });

  it('maps image/webp', () => {
    expect(detectImageExtensionFromContentType('image/webp')).toBe('.webp');
  });

  it('maps image/bmp', () => {
    expect(detectImageExtensionFromContentType('image/bmp')).toBe('.bmp');
  });

  it('handles charset/params and casing', () => {
    expect(detectImageExtensionFromContentType('Image/PNG; charset=binary')).toBe('.png');
  });

  it('returns undefined for null/empty/non-image', () => {
    expect(detectImageExtensionFromContentType(null)).toBeUndefined();
    expect(detectImageExtensionFromContentType('')).toBeUndefined();
    expect(detectImageExtensionFromContentType('application/octet-stream')).toBeUndefined();
  });
});

describe('detectImageExtension (combined, magic number first)', () => {
  it('prefers magic-number over a conflicting content-type', () => {
    // Bytes are JPEG but header lies that it is PNG → trust the bytes.
    expect(detectImageExtension(buf(JPEG), 'image/png')).toBe('.jpg');
  });

  it('falls back to content-type when bytes are unknown', () => {
    expect(detectImageExtension(buf([0x00, 0x01, 0x02, 0x03]), 'image/webp')).toBe('.webp');
  });

  it('falls back to .png when neither bytes nor content-type are conclusive', () => {
    expect(detectImageExtension(buf([0x00, 0x01, 0x02, 0x03]), null)).toBe('.png');
  });

  it('detects JPEG from bytes with no content-type', () => {
    expect(detectImageExtension(buf(JPEG))).toBe('.jpg');
  });
});
