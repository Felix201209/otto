/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { extractPdfTextWithCache } from './fileUtils.js';

export type EditableDocumentFormat = 'text' | 'markdown' | 'docx' | 'pdf';

export interface EditableDocumentExtraction {
  filePath: string;
  fileName: string;
  sourceFormat: EditableDocumentFormat;
  editableFormat: 'markdown';
  content: string;
  readonly: boolean;
  message: string;
}

export interface EditableDocumentExportResult {
  ok: boolean;
  path: string;
  format: EditableDocumentFormat;
  message: string;
}

function sourceFormat(filePath: string): EditableDocumentFormat {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx' || ext === 'doc') return 'docx';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return 'text';
}

function normalizeEditableText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function markdownFromPlainText(text: string, title: string): string {
  const body = normalizeEditableText(text);
  if (!body) return '# ' + title + '\n\n';
  if (/^#\s/m.test(body)) return body;
  return '# ' + title + '\n\n' + body;
}

export async function extractEditableDocument(filePath: string): Promise<EditableDocumentExtraction> {
  const format = sourceFormat(filePath);
  const fileName = path.basename(filePath);
  const title = path.basename(fileName, path.extname(fileName));
  if (format === 'pdf') {
    const extraction = await extractPdfTextWithCache(filePath);
    return {
      filePath,
      fileName,
      sourceFormat: 'pdf',
      editableFormat: 'markdown',
      content: markdownFromPlainText(extraction.text, title),
      readonly: false,
      message: extraction.cacheHit ? '已从 PDF 缓存提取可编辑文本。' : '已从 PDF 提取可编辑文本。',
    };
  }
  if (format === 'docx') {
    const { default: mammoth } = await import('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return {
      filePath,
      fileName,
      sourceFormat: 'docx',
      editableFormat: 'markdown',
      content: markdownFromPlainText(result.value, title),
      readonly: false,
      message: result.messages.length > 0
        ? '已从 Word 提取可编辑文本，包含 ' + result.messages.length + ' 条转换提示。'
        : '已从 Word 提取可编辑文本。',
    };
  }
  const raw = await fs.promises.readFile(filePath, 'utf8');
  return {
    filePath,
    fileName,
    sourceFormat: format,
    editableFormat: 'markdown',
    content: format === 'markdown' ? raw : markdownFromPlainText(raw, title),
    readonly: false,
    message: '已读取文本文件。',
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownLinesToParagraphXml(markdown: string): string {
  const normalized = normalizeEditableText(markdown);
  const paragraphs = normalized ? normalized.split('\n') : [''];
  return paragraphs.map((line) => {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const text = heading ? heading[2] : line.replace(/^[-*+]\s+/, '• ');
    const style = heading ? '<w:pStyle w:val="Heading' + heading[1].length + '"/>' : '';
    return '<w:p><w:pPr>' + style + '</w:pPr><w:r><w:t xml:space="preserve">' + xmlEscape(text) + '</w:t></w:r></w:p>';
  }).join('');
}

async function writeDocxFromMarkdown(markdown: string, outPath: string): Promise<void> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.folder('_rels')?.file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.folder('_rels')?.file('document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.folder('word')?.file('styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style></w:styles>');
  const body = markdownLinesToParagraphXml(markdown);
  zip.folder('word')?.file('document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>');
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.promises.writeFile(outPath, buffer);
}

function pdfEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function encodePdfText(value: string): Buffer {
  const escaped = pdfEscape(value);
  return Buffer.from(escaped.replace(/[^\x20-\x7e]/g, '?'), 'latin1');
}

async function writePdfFromMarkdown(markdown: string, outPath: string): Promise<void> {
  const lines = normalizeEditableText(markdown).split('\n').flatMap((line) => {
    if (line.length <= 86) return [line];
    const chunks: string[] = [];
    for (let i = 0; i < line.length; i += 86) chunks.push(line.slice(i, i + 86));
    return chunks;
  }).slice(0, 42);
  const prefix = ['BT', '/F1 11 Tf', '50 790 Td', '14 TL'].join('\n') + '\n';
  const suffix = '\nET';
  const lineBuffers = lines.map((line, index) => Buffer.concat([
    Buffer.from(index === 0 ? '(' : 'T* (', 'latin1'),
    encodePdfText(line),
    Buffer.from(') Tj\n', 'latin1'),
  ]));
  const stream = Buffer.concat([Buffer.from(prefix, 'latin1'), ...lineBuffers, Buffer.from(suffix, 'latin1')]);
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj\n',
    '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>endobj\n',
    '5 0 obj<</Length ' + stream.length + '>>stream\n',
  ];
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [0];
  for (const object of objects.slice(0, 4)) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(object, 'latin1'));
  }
  offsets.push(Buffer.concat(chunks).length);
  chunks.push(Buffer.from(objects[4], 'latin1'), stream, Buffer.from('\nendstream endobj\n', 'latin1'));
  const xrefOffset = Buffer.concat(chunks).length;
  const xref = ['xref', '0 6', '0000000000 65535 f ', ...offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n '), 'trailer<</Size 6/Root 1 0 R>>', 'startxref', String(xrefOffset), '%%EOF'].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  await fs.promises.writeFile(outPath, Buffer.concat(chunks));
}

export async function exportEditedDocument(
  sourcePath: string,
  content: string,
  outPath: string,
): Promise<EditableDocumentExportResult> {
  const format = sourceFormat(outPath || sourcePath);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  if (format === 'docx') {
    await writeDocxFromMarkdown(content, outPath);
  } else if (format === 'pdf') {
    await writePdfFromMarkdown(content, outPath);
  } else {
    await fs.promises.writeFile(outPath, content, 'utf8');
  }
  return { ok: true, path: outPath, format, message: '已保存编辑稿：' + path.basename(outPath) };
}
