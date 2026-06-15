import { describe, expect, it } from 'vitest';
import { optimizeMarkdownStyle } from './markdown-style.js';

describe('optimizeMarkdownStyle', () => {
  it('preserves fenced code blocks that use longer backtick fences', () => {
    const input = ['**Result**', '````text', 'before', '```', '# inside heading', '````', 'tail'].join('\n');
    expect(optimizeMarkdownStyle(input, 1)).toBe(input);
  });

  it('downgrades H1 and H2-H6 headings', () => {
    const input = [
      '# Heading 1',
      'Some intro text.',
      '## Heading 2',
      'Detail description.',
      '### Heading 3',
      'More details.',
    ].join('\n');

    const result = optimizeMarkdownStyle(input, 2);
    // H1 -> H4
    expect(result).toContain('#### Heading 1');
    // H2 -> H5
    expect(result).toContain('##### Heading 2');
    // H3 -> H5
    expect(result).toContain('##### Heading 3');
  });

  it('preserves other content and strips invalid image keys', () => {
    const input = [
      'Here is an image: ![logo](https://example.com/logo.png)',
      'And a valid one: ![img](img_v3_02vb_12345)',
    ].join('\n');

    const result = optimizeMarkdownStyle(input, 2);
    expect(result).not.toContain('https://example.com/logo.png');
    expect(result).toContain('![img](img_v3_02vb_12345)');
  });
});
