/**
 * 图片处理工具
 * 包含图片压缩、验证、处理等功能
 */

export interface ImageReference {
  id: string;
  fileName: string;
  data: string;        // base64
  mimeType: string;
  originalSize: number;
  compressedSize: number;
  width?: number;
  height?: number;
  filePath?: string;   // 原始文件路径（可从拖拽/文件上传中获取；粘贴时为空）
}

// 🎯 图片文件名序列生成器
let imageCounter = 0;
export function generateImageFileName(): string {
  if (imageCounter === 0) {
    imageCounter++;
    return 'image.jpg';
  } else {
    const name = `image${imageCounter}.jpg`;
    imageCounter++;
    return name;
  }
}

export function resetImageCounter(): void {
  imageCounter = 0;
}

// 🎯 验证图片数据完整性
export function validateImageData(buffer: Uint8Array, mimeType: string): { valid: boolean; reason?: string; details?: string } {
  if (!buffer || buffer.length < 8) {
    return { valid: false, reason: 'Buffer too small' };
  }

  const first8Bytes = Array.from(buffer.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log('🎯 First 8 bytes:', first8Bytes);

  // 🎯 PNG 魔法字节: 89 50 4E 47 0D 0A 1A 0A
  if (mimeType === 'image/png') {
    const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    const matches = pngSignature.every((expected, index) => buffer[index] === expected);

    if (!matches) {
      return {
        valid: false,
        reason: `Invalid PNG signature. Expected: ${pngSignature.map(b => b.toString(16)).join(' ')}, Got: ${first8Bytes}`
      };
    }
    return { valid: true, details: 'Valid PNG signature detected' };
  }

  // 🎯 JPEG 魔法字节: FF D8 FF
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return { valid: true, details: 'Valid JPEG signature detected' };
    }
    return {
      valid: false,
      reason: `Invalid JPEG signature. Expected: ff d8 ff, Got: ${first8Bytes}`
    };
  }

  // 🎯 GIF 魔法字节: 47 49 46 38 (GIF8)
  if (mimeType === 'image/gif') {
    const gifSignature = [0x47, 0x49, 0x46, 0x38];
    const matches = gifSignature.every((expected, index) => buffer[index] === expected);

    if (!matches) {
      return {
        valid: false,
        reason: `Invalid GIF signature. Expected: ${gifSignature.map(b => b.toString(16)).join(' ')}, Got: ${first8Bytes}`
      };
    }
    return { valid: true, details: 'Valid GIF signature detected' };
  }

  // 🎯 WebP 魔法字节: 52 49 46 46 ... 57 45 42 50
  if (mimeType === 'image/webp') {
    if (buffer.length < 12) {
      return { valid: false, reason: 'Buffer too small for WebP' };
    }

    const riffSignature = [0x52, 0x49, 0x46, 0x46]; // RIFF
    const webpSignature = [0x57, 0x45, 0x42, 0x50]; // WEBP

    const riffMatches = riffSignature.every((expected, index) => buffer[index] === expected);
    const webpMatches = webpSignature.every((expected, index) => buffer[index + 8] === expected);

    if (!riffMatches || !webpMatches) {
      return {
        valid: false,
        reason: `Invalid WebP signature. First 12 bytes: ${Array.from(buffer.slice(0, 12)).map(b => b.toString(16)).join(' ')}`
      };
    }
    return { valid: true, details: 'Valid WebP signature detected' };
  }

  // 🎯 BMP 魔法字节: 42 4D (BM)
  if (mimeType === 'image/bmp') {
    if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
      return { valid: true, details: 'Valid BMP signature detected' };
    }
    return {
      valid: false,
      reason: `Invalid BMP signature. Expected: 42 4d, Got: ${first8Bytes}`
    };
  }

  // 🎯 对于未知类型，不验证但记录
  console.log('🎯 Unknown image type, skipping signature validation:', mimeType);
  return { valid: true, details: `Unknown type ${mimeType}, skipped validation` };
}

// 🎯 浏览器端图片压缩 - 使用 Image 元素和 Canvas
export async function compressImageInBrowser(
  buffer: Uint8Array,
  originalMimeType: string
): Promise<{
  compressedData: string;
  compressedSize: number;
  width: number;
  height: number;
}> {
  return new Promise((resolve, reject) => {
    try {
      // 🎯 验证输入参数
      if (!buffer || buffer.length === 0) {
        reject(new Error('Empty image buffer'));
        return;
      }

      if (!originalMimeType || !originalMimeType.startsWith('image/')) {
        reject(new Error(`Unsupported mime type: ${originalMimeType}`));
        return;
      }

      console.log('🎯 Processing image with Canvas:', {
        mimeType: originalMimeType,
        bufferSize: buffer.length
      });

      const blob = new Blob([buffer.buffer as ArrayBuffer], { type: originalMimeType });

      // 🎯 验证 Blob 创建
      if (!blob || blob.size === 0) {
        reject(new Error('Failed to create blob from image data'));
        return;
      }

      console.log('🎯 Created blob:', { size: blob.size, type: blob.type });

      const img = new Image();
      let objectUrl: string | null = null;

      // 🎯 设置超时处理
      const timeout = setTimeout(() => {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
        reject(new Error('Image loading timeout (10s)'));
      }, 10000);

      img.onload = () => {
        clearTimeout(timeout);

        try {
          console.log('🎯 Image loaded successfully:', { width: img.width, height: img.height });

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          if (!ctx) {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            reject(new Error('Failed to get canvas context'));
            return;
          }

          // 计算压缩后的尺寸
          const MAX_WIDTH = 1920;
          const MAX_HEIGHT = 1080;
          let { width, height } = img;

          if (width > MAX_WIDTH || height > MAX_HEIGHT) {
            const ratio = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }

          canvas.width = width;
          canvas.height = height;

          // 绘制并压缩
          ctx.drawImage(img, 0, 0, width, height);

          // 转换为 JPEG (80% 质量)
          canvas.toBlob((compressedBlob) => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);

            if (!compressedBlob) {
              reject(new Error('Failed to compress image'));
              return;
            }

            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              if (!result || !result.includes(',')) {
                reject(new Error('Invalid base64 data'));
                return;
              }

              const base64 = result.split(',')[1]; // 去掉 data:image/jpeg;base64, 前缀
              console.log('🎯 Image compressed successfully:', {
                originalSize: buffer.length,
                compressedSize: compressedBlob.size,
                width,
                height,
                compressionRatio: ((1 - compressedBlob.size / buffer.length) * 100).toFixed(1) + '%'
              });

              resolve({
                compressedData: base64,
                compressedSize: compressedBlob.size,
                width,
                height
              });
            };
            reader.onerror = () => {
              reject(new Error('Failed to read compressed image as base64'));
            };
            reader.readAsDataURL(compressedBlob);
          }, 'image/jpeg', 0.8);
        } catch (error) {
          clearTimeout(timeout);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          reject(new Error(`Image processing error: ${error instanceof Error ? error.message : 'Unknown error'}`));
        }
      };

      img.onerror = (event) => {
        clearTimeout(timeout);
        if (objectUrl) URL.revokeObjectURL(objectUrl);

        console.error('🎯 Image loading failed:', {
          event,
          mimeType: originalMimeType,
          blobSize: blob.size,
          bufferLength: buffer.length
        });

        reject(new Error(`Failed to load image: ${originalMimeType} (size: ${blob.size})`));
      };

      // 🎯 创建 Object URL 并设置到 img.src
      try {
        objectUrl = URL.createObjectURL(blob);
        console.log('🎯 Created object URL:', objectUrl);
        img.src = objectUrl;
      } catch (error) {
        clearTimeout(timeout);
        reject(new Error(`Failed to create object URL: ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
    } catch (error) {
      reject(new Error(`Compression setup error: ${error instanceof Error ? error.message : 'Unknown error'}`));
    }
  });
}

// 🎯 处理剪切板图片
export async function processClipboardImage(file: File, sourcePath?: string): Promise<ImageReference | null> {
  try {
    console.log('🎯 Processing clipboard image:', {
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
      lastModified: file.lastModified
    });

    // 🎯 验证文件
    if (!file) {
      throw new Error('No file provided');
    }

    if (file.size === 0) {
      throw new Error('Empty file');
    }

    if (file.size > 50 * 1024 * 1024) { // 50MB 限制
      throw new Error(`File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB (max 50MB)`);
    }

    // 🎯 检查文件类型
    if (!file.type) {
      console.warn('🎯 No MIME type detected, attempting to process anyway');
    }

    if (file.type && !file.type.startsWith('image/')) {
      throw new Error(`Unsupported file type: ${file.type}`);
    }

    // 🎯 支持的图片格式
    const supportedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp'];
    if (file.type && !supportedTypes.includes(file.type.toLowerCase())) {
      console.warn('🎯 Potentially unsupported image type:', file.type);
    }

    // 🎯 使用原始 MIME 类型或降级到通用类型
    const mimeType = file.type || 'image/png';

    // 读取文件
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    console.log('🎯 File read successfully:', {
      arrayBufferSize: arrayBuffer.byteLength,
      bufferLength: buffer.length
    });

    if (buffer.length === 0) {
      throw new Error('File content is empty');
    }

    // 🎯 验证图片数据完整性
    const isValidImageData = validateImageData(buffer, mimeType);
    if (!isValidImageData.valid) {
      console.warn('🎯 Invalid image data detected:', isValidImageData.reason);
      // 不抛出错误，继续尝试处理，可能浏览器能处理
    } else {
      console.log('🎯 Image data validation passed:', isValidImageData.details);
    }

    // 🎯 生成简洁的序列文件名
    const fileName = generateImageFileName();

    console.log('🎯 Starting image compression...');

    // 压缩图片（如果可能的话）
    const { compressedData, compressedSize, width, height } = await compressImageInBrowser(buffer, mimeType);

    const result = {
      id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      fileName,
      data: compressedData,
      mimeType: 'image/jpeg', // 压缩后统一为 JPEG
      originalSize: file.size,
      compressedSize,
      width,
      height,
      filePath: sourcePath || (file as any).path || undefined, // 🎯 保留原始文件路径
    };

    console.log('🎯 Image processed successfully:', {
      originalSize: file.size,
      compressedSize,
      compressionRatio: ((1 - compressedSize / file.size) * 100).toFixed(1) + '%',
      dimensions: `${width}x${height}`
    });

    return result;
  } catch (error) {
    console.error('🎯 Failed to process clipboard image:', {
      error,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      fileName: file?.name,
      fileType: file?.type,
      fileSize: file?.size
    });
    return null;
  }
}