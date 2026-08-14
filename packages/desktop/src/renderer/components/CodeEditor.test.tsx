/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodeEditor } from './CodeEditor.js';

describe('CodeEditor', () => {
  it('preserves immediate user edits and saves the latest content', () => {
    const onSave = vi.fn();
    render(
      <CodeEditor
        content={'# Checklist\n\nPending'}
        filePath="C:\\docs\\readiness.pdf"
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '# Checklist\n\nApproved' },
    });
    const save = screen.getByRole('button', { name: /保存/ });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);

    expect(onSave).toHaveBeenCalledWith('# Checklist\n\nApproved');
  });

  it('resets the editor when a different document content is supplied', () => {
    const { rerender } = render(
      <CodeEditor content="First document" filePath="C:\\docs\\first.md" />,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Unsaved local edit' },
    });

    rerender(<CodeEditor content="Second document" filePath="C:\\docs\\second.md" />);

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Second document');
  });
});
