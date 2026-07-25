/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { exportEditedDocument, extractEditableDocument } from './editableDocument.js';

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-editable-document-'));
});

afterEach(async () => {
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

async function hasFpdf2(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('python3', ['-c', 'import fpdf'], { timeout: 3_000 }, (error) => resolve(!error));
  });
}

describe('editableDocument', () => {
  it('extracts a text document as editable markdown', async () => {
    const input = path.join(tempRoot, 'brief.txt');
    await fs.promises.writeFile(input, '第一段\n\n第二段', 'utf8');

    const extracted = await extractEditableDocument(input);

    expect(extracted.sourceFormat).toBe('text');
    expect(extracted.content).toContain('# brief');
    expect(extracted.content).toContain('第二段');
  });

  it('exports markdown edits to a valid docx package', async () => {
    const output = path.join(tempRoot, 'brief.edited.docx');

    const result = await exportEditedDocument(
      path.join(tempRoot, 'brief.docx'),
      '# Brief\n\n- Done',
      output,
    );

    expect(result.ok).toBe(true);
    const zip = await JSZip.loadAsync(await fs.promises.readFile(output));
    const documentXml = await zip.file('word/document.xml')?.async('string');
    expect(documentXml).toContain('Brief');
    expect(documentXml).toContain('• Done');
  });

  it('exports markdown edits to a PDF file or fails loud when fpdf2 is missing', async () => {
    const output = path.join(tempRoot, 'brief.edited.pdf');

    if (!(await hasFpdf2())) {
      await expect(exportEditedDocument(
        path.join(tempRoot, 'brief.pdf'),
        '# Brief\n\n中文内容',
        output,
      )).rejects.toThrow(/fpdf2|PDF 编辑稿导出失败/);
      expect(fs.existsSync(output)).toBe(false);
      return;
    }

    await exportEditedDocument(path.join(tempRoot, 'brief.pdf'), '# Brief\n\n中文内容', output);

    const header = await fs.promises.readFile(output, 'utf8');
    expect(header.startsWith('%PDF-')).toBe(true);
    expect(header).toContain('xref');
    expect(header).not.toContain('??');
  });
});
