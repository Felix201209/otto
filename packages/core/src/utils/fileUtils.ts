/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { PartUnion } from '@google/genai';
import mime from 'mime-types';
import Jimp from 'jimp';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
// Note: Dynamic import for pdf-parse to avoid initialization issues

// Constants for text file processing
const DEFAULT_MAX_LINES_TEXT_FILE = 2000;
const MAX_LINE_LENGTH_TEXT_FILE = 2000;

// Constants for image compression
const MAX_IMAGE_WIDTH = 1920;
const MAX_IMAGE_HEIGHT = 1080;
const MAX_IMAGE_WIDTH_AGGRESSIVE = 1280; // 激进压缩时的最大宽度
const MAX_IMAGE_HEIGHT_AGGRESSIVE = 720;  // 激进压缩时的最大高度
const JPEG_QUALITY = 60; // 降低JPEG质量以获得更好的压缩率
const JPEG_QUALITY_AGGRESSIVE = 45; // 更激进的压缩质量
const PNG_COMPRESSION_LEVEL = 6;

// Default values for encoding and separator format
export const DEFAULT_ENCODING: BufferEncoding = 'utf-8';

/**
 * Looks up the specific MIME type for a file path.
 * @param filePath Path to the file.
 * @returns The specific MIME type string (e.g., 'text/python', 'application/javascript') or undefined if not found or ambiguous.
 */
export function getSpecificMimeType(filePath: string): string | undefined {
  const lookedUpMime = mime.lookup(filePath);
  return typeof lookedUpMime === 'string' ? lookedUpMime : undefined;
}

/**
 * Checks if a path is within a given root directory.
 * @param pathToCheck The absolute path to check.
 * @param rootDirectory The absolute root directory.
 * @returns True if the path is within the root directory, false otherwise.
 */
export function isWithinRoot(
  pathToCheck: string,
  rootDirectory: string,
): boolean {
  let normalizedPathToCheck = path.resolve(pathToCheck);
  let normalizedRootDirectory = path.resolve(rootDirectory);

  if (process.platform === 'win32') {
    // 💡 Windows 平台文件路径大小写不敏感。统一转成小写进行比对，
    // 彻底解决 'D:\...' vs 'd:\...' 盘符大小写不匹配导致 isWithinRoot 校验报错的致命 Bug！
    normalizedPathToCheck = normalizedPathToCheck.toLowerCase();
    normalizedRootDirectory = normalizedRootDirectory.toLowerCase();
  }

  // Ensure the rootDirectory path ends with a separator for correct startsWith comparison,
  // unless it's the root path itself (e.g., '/' or 'C:\').
  const rootWithSeparator =
    normalizedRootDirectory === path.sep ||
    normalizedRootDirectory.endsWith(path.sep)
      ? normalizedRootDirectory
      : normalizedRootDirectory + path.sep;

  return (
    normalizedPathToCheck === normalizedRootDirectory ||
    normalizedPathToCheck.startsWith(rootWithSeparator)
  );
}

/**
 * Determines if a file is likely binary based on content sampling.
 * @param filePath Path to the file.
 * @returns Promise that resolves to true if the file appears to be binary.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  let fileHandle: fs.promises.FileHandle | undefined;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');

    // Read up to 4KB or file size, whichever is smaller
    const stats = await fileHandle.stat();
    const fileSize = stats.size;
    if (fileSize === 0) {
      // Empty file is not considered binary for content checking
      return false;
    }
    const bufferSize = Math.min(4096, fileSize);
    const buffer = Buffer.alloc(bufferSize);
    const result = await fileHandle.read(buffer, 0, buffer.length, 0);
    const bytesRead = result.bytesRead;

    if (bytesRead === 0) return false;

    let nonPrintableCount = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true; // Null byte is a strong indicator
      if (buffer[i] < 9 || (buffer[i] > 13 && buffer[i] < 32)) {
        nonPrintableCount++;
      }
    }
    // If >30% non-printable characters, consider it binary
    return nonPrintableCount / bytesRead > 0.3;
  } catch (error) {
    // Log error for debugging while maintaining existing behavior
    console.warn(
      `Failed to check if file is binary: ${filePath}`,
      error instanceof Error ? error.message : String(error),
    );
    // If any error occurs (e.g. file not found, permissions),
    // treat as not binary here; let higher-level functions handle existence/access errors.
    return false;
  } finally {
    // Safely close the file handle if it was successfully opened
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch (closeError) {
        // Log close errors for debugging while continuing with cleanup
        console.warn(
          `Failed to close file handle for: ${filePath}`,
          closeError instanceof Error ? closeError.message : String(closeError),
        );
        // The important thing is that we attempted to clean up
      }
    }
  }
}

/**
 * Compresses an image buffer to optimize token usage while maintaining AI readability.
 * Uses Jimp (pure JavaScript) to avoid native binary dependencies.
 * @param imageBuffer The original image buffer.
 * @param mimeType The original image MIME type.
 * @returns Promise that resolves to compressed image buffer and new MIME type.
 */
async function compressImage(
  imageBuffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string; compressionInfo: string }> {
  const originalSize = imageBuffer.length;
  const originalSizeKB = Math.round(originalSize / 1024);

  console.log(`🖼️  Jimp图片压缩开始 - 原始大小: ${originalSizeKB}KB, 格式: ${mimeType}`);

  try {
    // 使用Jimp加载图片
    const image = await Jimp.read(imageBuffer);
    const originalWidth = image.getWidth();
    const originalHeight = image.getHeight();

    console.log(`📏 图片元数据: ${originalWidth}x${originalHeight}, 格式: ${mimeType}`);

    // Skip compression if image is already small enough
    if (
      originalWidth <= MAX_IMAGE_WIDTH &&
      originalHeight <= MAX_IMAGE_HEIGHT &&
      imageBuffer.length <= 200 * 1024 // 200KB
    ) {
      console.log('⏭️  图片已足够小，跳过压缩');
      return {
        buffer: imageBuffer,
        mimeType,
        compressionInfo: '(no compression needed)'
      };
    }

    console.log(`🔄 开始压缩处理 - 目标尺寸: ${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT}`);

    // 对于特大文件，使用更激进的尺寸压缩
    const isLargeFile = originalSize > 500 * 1024; // 大于500KB的文件
    const targetWidth = isLargeFile ? MAX_IMAGE_WIDTH_AGGRESSIVE : MAX_IMAGE_WIDTH;
    const targetHeight = isLargeFile ? MAX_IMAGE_HEIGHT_AGGRESSIVE : MAX_IMAGE_HEIGHT;

    if (isLargeFile) {
      console.log(`📦 检测到大文件(${originalSizeKB}KB)，使用激进压缩: ${targetWidth}x${targetHeight}`);
    }

    // Resize image if too large (maintain aspect ratio)
    let resizedImage = image;
    if (originalWidth > targetWidth || originalHeight > targetHeight) {
      // Jimp.RESIZE_BEZIER provides good quality for downscaling
      resizedImage = image.scaleToFit(targetWidth, targetHeight, Jimp.RESIZE_BEZIER);
      console.log(`📐 图片已缩放至: ${resizedImage.getWidth()}x${resizedImage.getHeight()}`);
    }

    let compressedBuffer: Buffer;
    let finalMimeType: string;

    // Convert all images to JPEG for maximum compression
    console.log('🎨 转换为JPEG格式进行激进压缩...');

    // Try different quality levels and choose the best compression
    const jpegNormal = await resizedImage.quality(JPEG_QUALITY).getBufferAsync(Jimp.MIME_JPEG);
    const jpegAggressive = await resizedImage.quality(JPEG_QUALITY_AGGRESSIVE).getBufferAsync(Jimp.MIME_JPEG);

    // Choose the version with better compression
    compressedBuffer = jpegAggressive.length < jpegNormal.length ? jpegAggressive : jpegNormal;
    const selectedQuality = jpegAggressive.length < jpegNormal.length ? JPEG_QUALITY_AGGRESSIVE : JPEG_QUALITY;

    console.log(`📊 选择JPEG质量: ${selectedQuality} (${Math.round(compressedBuffer.length/1024)}KB)`);
    finalMimeType = 'image/jpeg';

    // 4MB兜底机制：如果压缩后仍然大于4MB，继续缩小尺寸
    const maxSize = 4 * 1024 * 1024; // 4MB
    if (compressedBuffer.length > maxSize) {
      console.log(`⚠️  压缩后文件仍然过大(${Math.round(compressedBuffer.length/1024/1024)}MB)，启动兜底压缩机制...`);

      let currentImage = resizedImage;
      let currentBuffer = compressedBuffer;
      let attempts = 0;
      const maxAttempts = 5;

      while (currentBuffer.length > maxSize && attempts < maxAttempts) {
        attempts++;
        // 每次将尺寸缩小20%
        const currentWidth = currentImage.getWidth();
        const currentHeight = currentImage.getHeight();
        const newWidth = Math.floor(currentWidth * 0.8);
        const newHeight = Math.floor(currentHeight * 0.8);

        console.log(`🔄 兜底压缩第${attempts}次: ${currentWidth}x${currentHeight} → ${newWidth}x${newHeight}`);

        currentImage = currentImage.resize(newWidth, newHeight, Jimp.RESIZE_BEZIER);

        // 使用最激进的质量
        currentBuffer = await currentImage.quality(JPEG_QUALITY_AGGRESSIVE).getBufferAsync(Jimp.MIME_JPEG);

        console.log(`📏 当前大小: ${Math.round(currentBuffer.length/1024)}KB`);
      }

      if (currentBuffer.length <= maxSize) {
        console.log(`✅ 兜底压缩成功！最终尺寸: ${currentImage.getWidth()}x${currentImage.getHeight()}`);
        compressedBuffer = currentBuffer;
        resizedImage = currentImage;
      } else {
        console.log(`⚠️  经过${maxAttempts}次尝试仍未达到4MB限制，使用当前最小版本`);
        compressedBuffer = currentBuffer;
        resizedImage = currentImage;
      }
    }

    const compressedSize = compressedBuffer.length;
    const compressedSizeKB = Math.round(compressedSize / 1024);
    const compressionRatio = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);

    const compressionInfo = `(compressed: ${originalSizeKB}KB → ${compressedSizeKB}KB, saved ${compressionRatio}%)`;
    console.log(`✅ 压缩完成 ${compressionInfo}`);

    return {
      buffer: compressedBuffer,
      mimeType: finalMimeType,
      compressionInfo
    };
  } catch (error) {
    // If compression fails, return original
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ 图片压缩失败，使用原图:', errorMessage);

    return {
      buffer: imageBuffer,
      mimeType,
      compressionInfo: `(compression failed: ${errorMessage})`
    };
  }
}

/**
 * Checks if a .dts/.dtsi file is a Linux device tree file (vs DTS audio file).
 * Uses simplified detection for performance.
 * @param filePath Path to the file.
 * @returns Promise that resolves to true if it's a Linux device tree file.
 */
async function isLinuxDeviceTreeFile(filePath: string): Promise<boolean> {
  let fileHandle: fs.promises.FileHandle | undefined;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');

    // Read first 2KB to handle copyright headers
    const buffer = Buffer.alloc(2048);
    const result = await fileHandle.read(buffer, 0, buffer.length, 0);

    if (result.bytesRead === 0) return false;

    // Quick binary check - if contains null bytes, likely binary audio file
    if (buffer.slice(0, result.bytesRead).includes(0)) {
      return false;
    }

    const content = buffer.slice(0, result.bytesRead).toString('utf-8');

    // Simple feature check: any device tree characteristic indicates it's a DT file
    return /\/\/\s*SPDX-License-Identifier:|\/dts-v1\/|#include.*dt-bindings|compatible\s*=|#address-cells|&\w+/.test(content);

  } catch (error) {
    return false;
  } finally {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch (closeError) {
        // Ignore close errors
      }
    }
  }
}

/**
 * Detects the type of file based on extension and content.
 * @param filePath Path to the file.
 * @returns Promise that resolves to 'text', 'image', 'pdf', 'audio', 'video', 'binary', 'svg', 'excel', or 'word'.
 */
export async function detectFileType(
  filePath: string,
): Promise<'text' | 'image' | 'pdf' | 'audio' | 'video' | 'binary' | 'svg' | 'excel' | 'word'> {
  const ext = path.extname(filePath).toLowerCase();

  // The mimetype for "ts" is MPEG transport stream (a video format) but we want
  // to assume these are typescript files instead.
  if (ext === '.ts') {
    return 'text';
  }

  if (ext === '.svg') {
    return 'svg';
  }

  // Office file detection
  if (['.xlsx', '.xls'].includes(ext)) {
    return 'excel';
  }
  if (['.docx', '.doc'].includes(ext)) {
    return 'word';
  }

  // DTS/DTSI files intelligent detection
  if (ext === '.dts' || ext === '.dtsi') {
    if (await isLinuxDeviceTreeFile(filePath)) {
      return 'text';
    }
    // If not a device tree file, continue with MIME type processing (might be audio DTS)
  }

  const lookedUpMimeType = mime.lookup(filePath); // Returns false if not found, or the mime type string
  if (lookedUpMimeType) {
    if (lookedUpMimeType.startsWith('image/')) {
      return 'image';
    }
    if (lookedUpMimeType.startsWith('audio/')) {
      return 'audio';
    }
    if (lookedUpMimeType.startsWith('video/')) {
      return 'video';
    }
    if (lookedUpMimeType === 'application/pdf') {
      return 'pdf';
    }
  }

  // Stricter binary check for common non-text extensions before content check
  // These are often not well-covered by mime-types or might be misidentified.
  // Note: .doc, .docx, .xls, .xlsx are handled separately as office files
  if (
    [
      // Archives
      '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz',
      // Executables/Binaries
      '.exe', '.dll', '.so', '.class', '.jar', '.war', '.bin', '.dat', '.obj', '.o', '.a', '.lib', '.wasm',
      // Python bytecode
      '.pyc', '.pyo', '.pyd',
      // Fonts
      '.ttf', '.otf', '.woff', '.woff2', '.eot',
      // Images (already handled by MIME, but adding common ones for safety)
      '.ico', '.cur', '.psd', '.ai',
      // Media (already handled by MIME, but adding common ones for safety)
      '.mp3', '.mp4', '.m4a', '.wav', '.flac', '.ogg', '.avi', '.mov', '.wmv', '.mkv',
      // Office (some handled separately, adding others)
      '.ppt', '.pptx', '.odt', '.ods', '.odp',
    ].includes(ext)
  ) {
    return 'binary';
  }

  // Fall back to content-based check if mime type wasn't conclusive for image/pdf
  // and it's not a known binary extension.
  if (await isBinaryFile(filePath)) {
    return 'binary';
  }

  return 'text';
}

/**
 * Extracts text content from an Excel file (.xlsx, .xls).
 * @param filePath Path to the Excel file.
 * @returns Promise that resolves to extracted text content.
 */
async function extractExcelContent(filePath: string): Promise<string> {
  try {
    // Read file as buffer first
    const fileBuffer = fs.readFileSync(filePath);

    // Use XLSX.read instead of XLSX.readFile for ES modules
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    let content = '';

    /**
     * Clean cell content by removing excess whitespace and control characters
     */
    const cleanCellContent = (cell: any): string => {
      if (cell === null || cell === undefined) return '';
      let text = String(cell);
      // Remove control characters (except newlines and tabs)
      text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      // Normalize multiple spaces to single space
      text = text.replace(/\s+/g, ' ');
      // Trim leading and trailing whitespace
      return text.trim();
    };

    // Process each sheet
    workbook.SheetNames.forEach((sheetName, index) => {
      const worksheet = workbook.Sheets[sheetName];

      // Add sheet header
      if (workbook.SheetNames.length > 1) {
        content += `\n=== Sheet ${index + 1}: ${sheetName} ===\n`;
      }

      // Convert to array of arrays (rows and columns)
      const jsonData: any[][] = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: '', // Use empty string for empty cells
        blankrows: false // Skip completely blank rows
      });

      // Format as tab-separated values
      jsonData.forEach((row: any[], rowIndex) => {
        const cleanedRow = row.map(cleanCellContent);
        // Only add rows that have at least one non-empty cell
        if (cleanedRow.some(cell => cell.length > 0)) {
          content += cleanedRow.join('\t') + '\n';
        }
      });

      if (index < workbook.SheetNames.length - 1) {
        content += '\n'; // Add spacing between sheets
      }
    });

    return content.trim();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Excel file: ${errorMessage}`);
  }
}

/**
 * Extracts text content from a Word document (.docx).
 * @param filePath Path to the Word document.
 * @returns Promise that resolves to extracted text content.
 */
async function extractWordContent(filePath: string): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ path: filePath });

    // Check for conversion warnings
    if (result.messages && result.messages.length > 0) {
      console.warn(`Word document conversion warnings for ${filePath}:`, result.messages);
    }

    return result.value;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Word document: ${errorMessage}`);
  }
}

/**
 * Extracts text content from a PDF file.
 * @param filePath Path to the PDF file.
 * @returns Promise that resolves to extracted text content.
 */
/**
 * Multi-library PDF text extraction with pure JavaScript fallbacks
 */
async function extractPdfText(filePath: string): Promise<string> {
  const fileName = path.basename(filePath);

  // Method 1: Try pdf2json first (better for complex PDFs, zero dependencies)
  try {
    return await extractPdfWithPdf2json(filePath);
  } catch (pdf2jsonError) {
    // pdf2json failed, trying pdf-parse fallback

    // Method 2: Try original pdf-parse (fallback)
    try {
      return await extractPdfWithPdfParse(filePath);
    } catch (pdfParseError) {
      // Both PDF parsing methods failed

      // Return helpful error message with file info
      const stats = await fs.promises.stat(filePath);
      const fileSize = Math.round(stats.size / 1024);

      return `PDF文件解析失败: ${fileName}
文件大小: ${fileSize} KB

尝试的解析方法:
❌ pdf2json (零依赖): ${pdf2jsonError instanceof Error ? pdf2jsonError.message : String(pdf2jsonError)}
❌ pdf-parse (原方法): ${pdfParseError instanceof Error ? pdfParseError.message : String(pdfParseError)}

可能的解决方案:
1. 这可能是扫描版PDF，需要OCR处理
2. 文件可能受密码保护或有特殊格式
3. 可以尝试将PDF转换为图片格式后重新处理
4. 或者手动复制粘贴PDF中的文本内容

文件确实存在且可访问，但内容无法自动提取。`;
    }
  }
}

/**
 * Extract PDF text using pdf2json (zero dependencies, better for complex PDFs)
 */
async function extractPdfWithPdf2json(filePath: string): Promise<string> {
  try {
    // Dynamic import to avoid initialization issues
    const PDFParser = (await import('pdf2json')).default;

    return new Promise((resolve, reject) => {
      const pdfParser = new PDFParser();

      // Set shorter timeout for better UX
      const timeout = setTimeout(() => {
        reject(new Error('pdf2json parsing timeout after 6 seconds'));
      }, 6000);

      pdfParser.on('pdfParser_dataError', (errData: any) => {
        clearTimeout(timeout);
        reject(new Error(`pdf2json parsing error: ${errData?.parserError || 'unknown error'}`));
      });

      pdfParser.on('pdfParser_dataReady', (pdfData: any) => {
        clearTimeout(timeout);
        try {
          let fullText = '';

          if (pdfData?.Pages) {
            pdfData.Pages.forEach((page: any) => {
              if (page?.Texts) {
                page.Texts.forEach((text: any) => {
                  if (text?.R?.[0]?.T) {
                    // Decode URI components and add spaces between text elements
                    fullText += decodeURIComponent(text.R[0].T) + ' ';
                  }
                });
              }
              fullText += '\n'; // Add newline after each page
            });
          }

          const cleanedText = fullText.trim();
          if (cleanedText) {
            resolve(cleanPdfText(cleanedText));
          } else {
            reject(new Error('pdf2json extracted no text content'));
          }
        } catch (parseErr) {
          reject(new Error(`pdf2json data processing error: ${parseErr}`));
        }
      });

      // Load PDF file
      pdfParser.loadPDF(filePath);
    });
  } catch (importError) {
    throw new Error(`Failed to load pdf2json library: ${importError}`);
  }
}

/**
 * Extract PDF text using pdf-parse (original method, fallback)
 */
async function extractPdfWithPdfParse(filePath: string): Promise<string> {
  // Dynamic import to avoid initialization issues with pdf-parse
  const pdfParse = (await import('pdf-parse')).default;
  const dataBuffer = await fs.promises.readFile(filePath);

  // Shorter timeout for better UX
  const PDF_PARSE_TIMEOUT = 4000; // 4 seconds

  const parsePromise = pdfParse(dataBuffer);
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('pdf-parse timeout after 4 seconds')), PDF_PARSE_TIMEOUT);
  });

  const pdfData = await Promise.race([parsePromise, timeoutPromise]);

  if (!pdfData || !pdfData.text) {
    throw new Error('pdf-parse extracted no text content');
  }

  // Clean up the extracted text
  return cleanPdfText(pdfData.text);
}

/**
 * Cleans up PDF extracted text by removing excessive whitespace and fixing common issues.
 * @param rawText Raw PDF text
 * @returns Cleaned text
 */
function cleanPdfText(rawText: string): string {
  return rawText
    // Remove excessive blank lines (more than 2 consecutive)
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    // Fix broken words across lines (word-\nword -> wordword)
    .replace(/(\w+)-\s*\n\s*(\w+)/g, '$1$2')
    // Normalize spaces and tabs to single spaces
    .replace(/[ \t]+/g, ' ')
    // Clean up line beginnings and endings
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim();
}

export interface ProcessedFileReadResult {
  llmContent: PartUnion; // string for text, Part for image/pdf/unreadable binary
  returnDisplay: string;
  error?: string; // Optional error message for the LLM if file processing failed
  isTruncated?: boolean; // For text files, indicates if content was truncated
  originalLineCount?: number; // For text files
  linesShown?: [number, number]; // For text files [startLine, endLine] (1-based for display)
}

/**
 * Reads and processes a single file, handling text, images, and PDFs.
 * @param filePath Absolute path to the file.
 * @param rootDirectory Absolute path to the project root for relative path display.
 * @param offset Optional offset for text files (0-based line number).
 * @param limit Optional limit for text files (number of lines to read).
 * @returns ProcessedFileReadResult object.
 */
export async function processSingleFileContent(
  filePath: string,
  rootDirectory: string,
  offset?: number,
  limit?: number,
): Promise<ProcessedFileReadResult> {
  try {
    if (!fs.existsSync(filePath)) {
      // Sync check is acceptable before async read
      return {
        llmContent: '',
        returnDisplay: 'File not found.',
        error: `File not found: ${filePath}`,
      };
    }
    const stats = await fs.promises.stat(filePath);
    if (stats.isDirectory()) {
      return {
        llmContent: '',
        returnDisplay: 'Path is a directory.',
        error: `Path is a directory, not a file: ${filePath}`,
      };
    }

    const fileSizeInBytes = stats.size;
    // 20MB limit
    const maxFileSize = 20 * 1024 * 1024;

    if (fileSizeInBytes > maxFileSize) {
      throw new Error(
        `File size exceeds the 20MB limit: ${filePath} (${(
          fileSizeInBytes /
          (1024 * 1024)
        ).toFixed(2)}MB)`,
      );
    }

    const fileType = await detectFileType(filePath);
    const relativePathForDisplay = path
      .relative(rootDirectory, filePath)
      .replace(/\\/g, '/');

    switch (fileType) {
      case 'binary': {
        return {
          llmContent: `Cannot display content of binary file: ${relativePathForDisplay}`,
          returnDisplay: `Skipped binary file: ${relativePathForDisplay}`,
        };
      }
      case 'svg': {
        const SVG_MAX_SIZE_BYTES = 1 * 1024 * 1024;
        if (stats.size > SVG_MAX_SIZE_BYTES) {
          return {
            llmContent: `Cannot display content of SVG file larger than 1MB: ${relativePathForDisplay}`,
            returnDisplay: `Skipped large SVG file (>1MB): ${relativePathForDisplay}`,
          };
        }
        const content = await fs.promises.readFile(filePath, 'utf8');
        return {
          llmContent: content,
          returnDisplay: `Read SVG as text: ${relativePathForDisplay}`,
        };
      }
      case 'text': {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        const originalLineCount = lines.length;

        const startLine = offset || 0;
        const effectiveLimit =
          limit === undefined ? DEFAULT_MAX_LINES_TEXT_FILE : limit;
        // Ensure endLine does not exceed originalLineCount
        const endLine = Math.min(startLine + effectiveLimit, originalLineCount);
        // Ensure selectedLines doesn't try to slice beyond array bounds if startLine is too high
        const actualStartLine = Math.min(startLine, originalLineCount);
        const selectedLines = lines.slice(actualStartLine, endLine);

        let linesWereTruncatedInLength = false;
        const formattedLines = selectedLines.map((line) => {
          if (line.length > MAX_LINE_LENGTH_TEXT_FILE) {
            linesWereTruncatedInLength = true;
            return (
              line.substring(0, MAX_LINE_LENGTH_TEXT_FILE) + '... [truncated]'
            );
          }
          return line;
        });

        const contentRangeTruncated = endLine < originalLineCount;
        const isTruncated = contentRangeTruncated || linesWereTruncatedInLength;

        let llmTextContent = '';
        if (contentRangeTruncated) {
          llmTextContent += `[File content truncated: showing lines ${actualStartLine + 1}-${endLine} of ${originalLineCount} total lines. Use offset/limit parameters to view more.]\n`;
        } else if (linesWereTruncatedInLength) {
          llmTextContent += `[File content partially truncated: some lines exceeded maximum length of ${MAX_LINE_LENGTH_TEXT_FILE} characters.]\n`;
        }
        llmTextContent += formattedLines.join('\n');

        const displayInfo = isTruncated
          ? `read lines: ${actualStartLine + 1}-${endLine}`
          : `(${endLine} lines)`;
        return {
          llmContent: llmTextContent,
          returnDisplay: displayInfo,
          isTruncated,
          originalLineCount,
          linesShown: [actualStartLine + 1, endLine],
        };
      }
      case 'image': {
        const originalBuffer = await fs.promises.readFile(filePath);
        const originalMimeType =
          mime.lookup(filePath) || 'application/octet-stream';

        // Compress image to optimize token usage
        const { buffer: compressedBuffer, mimeType: compressedMimeType, compressionInfo } =
          await compressImage(originalBuffer, originalMimeType);

        const base64Data = compressedBuffer.toString('base64');

        return {
          llmContent: {
            inlineData: {
              data: base64Data,
              mimeType: compressedMimeType,
            },
          },
          returnDisplay: `Read ${fileType} file: ${relativePathForDisplay} ${compressionInfo}`,
        };
      }
      case 'excel': {
        try {
          const content = await extractExcelContent(filePath);
          const lines = content.split('\n');
          const originalLineCount = lines.length;

          // Apply the same offset/limit logic as text files
          const startLine = offset || 0;
          const effectiveLimit = limit === undefined ? DEFAULT_MAX_LINES_TEXT_FILE : limit;
          const endLine = Math.min(startLine + effectiveLimit, originalLineCount);
          const actualStartLine = Math.min(startLine, originalLineCount);
          const selectedLines = lines.slice(actualStartLine, endLine);

          let linesWereTruncatedInLength = false;
          const formattedLines = selectedLines.map((line) => {
            if (line.length > MAX_LINE_LENGTH_TEXT_FILE) {
              linesWereTruncatedInLength = true;
              return line.substring(0, MAX_LINE_LENGTH_TEXT_FILE) + '... [truncated]';
            }
            return line;
          });

          const contentRangeTruncated = endLine < originalLineCount;
          const isTruncated = contentRangeTruncated || linesWereTruncatedInLength;

          let llmTextContent = `Excel file content from ${relativePathForDisplay}:\n\n`;
          if (contentRangeTruncated) {
            llmTextContent += `[Excel content truncated: showing lines ${actualStartLine + 1}-${endLine} of ${originalLineCount} total lines. Use offset/limit parameters to view more.]\n`;
          } else if (linesWereTruncatedInLength) {
            llmTextContent += `[Excel content partially truncated: some lines exceeded maximum length of ${MAX_LINE_LENGTH_TEXT_FILE} characters.]\n`;
          }
          llmTextContent += formattedLines.join('\n');

          const displayInfo = isTruncated
            ? `read lines: ${actualStartLine + 1}-${endLine}`
            : `${endLine} lines`;
          return {
            llmContent: llmTextContent,
            returnDisplay: `Read Excel file: ${relativePathForDisplay} (${displayInfo})`,
            isTruncated,
            originalLineCount,
            linesShown: [actualStartLine + 1, endLine],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            llmContent: `Error reading Excel file ${relativePathForDisplay}: ${errorMessage}`,
            returnDisplay: `Error reading Excel file: ${relativePathForDisplay}`,
            error: `Error reading Excel file ${filePath}: ${errorMessage}`,
          };
        }
      }
      case 'word': {
        try {
          const content = await extractWordContent(filePath);
          const lines = content.split('\n');
          const originalLineCount = lines.length;

          // Apply the same offset/limit logic as text files
          const startLine = offset || 0;
          const effectiveLimit = limit === undefined ? DEFAULT_MAX_LINES_TEXT_FILE : limit;
          const endLine = Math.min(startLine + effectiveLimit, originalLineCount);
          const actualStartLine = Math.min(startLine, originalLineCount);
          const selectedLines = lines.slice(actualStartLine, endLine);

          let linesWereTruncatedInLength = false;
          const formattedLines = selectedLines.map((line) => {
            if (line.length > MAX_LINE_LENGTH_TEXT_FILE) {
              linesWereTruncatedInLength = true;
              return line.substring(0, MAX_LINE_LENGTH_TEXT_FILE) + '... [truncated]';
            }
            return line;
          });

          const contentRangeTruncated = endLine < originalLineCount;
          const isTruncated = contentRangeTruncated || linesWereTruncatedInLength;

          let llmTextContent = `Word document content from ${relativePathForDisplay}:\n\n`;
          if (contentRangeTruncated) {
            llmTextContent += `[Word content truncated: showing lines ${actualStartLine + 1}-${endLine} of ${originalLineCount} total lines. Use offset/limit parameters to view more.]\n`;
          } else if (linesWereTruncatedInLength) {
            llmTextContent += `[Word content partially truncated: some lines exceeded maximum length of ${MAX_LINE_LENGTH_TEXT_FILE} characters.]\n`;
          }
          llmTextContent += formattedLines.join('\n');

          const displayInfo = isTruncated
            ? `read lines: ${actualStartLine + 1}-${endLine}`
            : `${endLine} lines`;
          return {
            llmContent: llmTextContent,
            returnDisplay: `Read Word document: ${relativePathForDisplay} (${displayInfo})`,
            isTruncated,
            originalLineCount,
            linesShown: [actualStartLine + 1, endLine],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            llmContent: `Error reading Word document ${relativePathForDisplay}: ${errorMessage}`,
            returnDisplay: `Error reading Word document: ${relativePathForDisplay}`,
            error: `Error reading Word document ${filePath}: ${errorMessage}`,
          };
        }
      }
      case 'pdf': {
        try {
          const extractedText = await extractPdfText(filePath);
          const lines = extractedText.split('\n');
          const originalLineCount = lines.length;

          // Apply the same offset/limit logic as text files
          const startLine = offset || 0;
          const effectiveLimit = limit === undefined ? DEFAULT_MAX_LINES_TEXT_FILE : limit;
          const endLine = Math.min(startLine + effectiveLimit, originalLineCount);
          const actualStartLine = Math.min(startLine, originalLineCount);
          const selectedLines = lines.slice(actualStartLine, endLine);

          // Apply line length limits
          let linesWereTruncatedInLength = false;
          const formattedLines = selectedLines.map((line) => {
            if (line.length > MAX_LINE_LENGTH_TEXT_FILE) {
              linesWereTruncatedInLength = true;
              return line.substring(0, MAX_LINE_LENGTH_TEXT_FILE) + '... [truncated]';
            }
            return line;
          });

          const contentRangeTruncated = endLine < originalLineCount;
          const isTruncated = contentRangeTruncated || linesWereTruncatedInLength;

          let llmTextContent = `PDF document content from ${relativePathForDisplay}:\n\n`;
          if (contentRangeTruncated) {
            llmTextContent += `[PDF content truncated: showing lines ${actualStartLine + 1}-${endLine} of ${originalLineCount} total lines. Use offset/limit parameters to view more.]\n`;
          } else if (linesWereTruncatedInLength) {
            llmTextContent += `[PDF content partially truncated: some lines exceeded maximum length of ${MAX_LINE_LENGTH_TEXT_FILE} characters.]\n`;
          }
          llmTextContent += formattedLines.join('\n');

          const displayInfo = isTruncated
            ? `read lines: ${actualStartLine + 1}-${endLine}`
            : `${endLine} lines`;
          return {
            llmContent: llmTextContent, // Return as plain text, not inlineData
            returnDisplay: `Read PDF as text: ${relativePathForDisplay} (${displayInfo})`,
            isTruncated,
            originalLineCount,
            linesShown: [actualStartLine + 1, endLine],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          // Provide user-friendly error messages
          let userFriendlyMessage = '';
          if (errorMessage.includes('Invalid PDF') || errorMessage.includes('invalid')) {
            userFriendlyMessage = 'The file appears to be corrupted or not a valid PDF.';
          } else if (errorMessage.includes('Encrypted') || errorMessage.includes('password')) {
            userFriendlyMessage = 'The PDF is password protected and cannot be read.';
          } else {
            userFriendlyMessage = 'Unable to extract text from this PDF file.';
          }

          return {
            llmContent: `Error reading PDF document ${relativePathForDisplay}: ${userFriendlyMessage}`,
            returnDisplay: `Error reading PDF document: ${relativePathForDisplay}`,
            error: `Error reading PDF document ${filePath}: ${errorMessage}`,
          };
        }
      }
      case 'audio':
      case 'video': {
        const contentBuffer = await fs.promises.readFile(filePath);
        const base64Data = contentBuffer.toString('base64');
        return {
          llmContent: {
            inlineData: {
              data: base64Data,
              mimeType: mime.lookup(filePath) || 'application/octet-stream',
            },
          },
          returnDisplay: `Read ${fileType} file: ${relativePathForDisplay}`,
        };
      }
      default: {
        // Should not happen with current detectFileType logic
        const exhaustiveCheck: never = fileType;
        return {
          llmContent: `Unhandled file type: ${exhaustiveCheck}`,
          returnDisplay: `Skipped unhandled file type: ${relativePathForDisplay}`,
          error: `Unhandled file type for ${filePath}`,
        };
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const displayPath = path
      .relative(rootDirectory, filePath)
      .replace(/\\/g, '/');
    return {
      llmContent: `Error reading file ${displayPath}: ${errorMessage}`,
      returnDisplay: `Error reading file ${displayPath}: ${errorMessage}`,
      error: `Error reading file ${filePath}: ${errorMessage}`,
    };
  }
}
