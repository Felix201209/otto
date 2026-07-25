/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('exports markdown edits to a PDF file', async () => {
    const output = path.join(tempRoot, 'brief.edited.pdf');

    await exportEditedDocument(path.join(tempRoot, 'brief.pdf'), '# Brief\n\nDone', output);

    const header = await fs.promises.readFile(output, 'utf8');
    expect(header.startsWith('%PDF-1.4')).toBe(true);
    expect(header).toContain('xref');
  });
});
