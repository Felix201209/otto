/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import { sanitizeOutput } from '../test-utils.js';

describe('<MarkdownDisplay />', () => {
  const baseProps = {
    isPending: false,
    terminalWidth: 80,
    availableTerminalHeight: 40,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for empty text', () => {
    const { lastFrame } = render(<MarkdownDisplay {...baseProps} text="" />);
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('renders a simple paragraph', () => {
    const text = 'Hello, world.';
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('renders headers with correct levels', () => {
    const text = `
# Header 1
## Header 2
### Header 3
#### Header 4
`;
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('renders a fenced code block with a language', () => {
    const text = '```javascript\nconst x = 1;\nconsole.log(x);\n```';
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('renders a fenced code block without a language', () => {
    const text = '```\nplain text\n```';
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('handles unclosed (pending) code blocks', () => {
    const text = '```typescript\nlet y = 2;';
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('renders unordered lists with different markers', () => {
    const text = `
- item A
* item B
+ item C
`;
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('renders nested unordered lists', () => {
    const text = `
* Level 1
  * Level 2
    * Level 3
`;
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('renders ordered lists', () => {
    const text = `
1. First item
2. Second item
`;
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('renders horizontal rules', () => {
    const text = `
Hello
---
World
***
Test
`;
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('renders tables correctly', () => {
    const text = `
| Header 1 | Header 2 |
|----------|:--------:|
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |
`;
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('handles a table at the end of the input', () => {
    const text = `
Some text before.
| A | B |
|---|
| 1 | 2 |`;
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('inserts a single space between paragraphs', () => {
    const text = `Paragraph 1.

Paragraph 2.`;
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  it('correctly parses a mix of markdown elements', () => {
    const text = `
# Main Title

Here is a paragraph.

- List item 1
- List item 2

\`\`\`
some code
\`\`\`

Another paragraph.
`;
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(sanitizeOutput(lastFrame())).toMatchSnapshot();
  });

  // --- Defensive fence robustness tests (added for malformed-fence bug fix) ---

  it('handles a fence with language and content glued on same line (no newline)', () => {
    // LLM occasionally emits ```text/Users/foo (no \n between lang and content).
    // Before the fix this fell through to a paragraph and exposed raw backticks.
    const text = '```text/Users/mark/.config/foo\n```';
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    const out = sanitizeOutput(lastFrame());
    // Must NOT contain ANY backticks — fence chars must be consumed by the parser.
    expect(out).not.toContain('`');
    // The glued first line must appear as code content.
    expect(out).toContain('/Users/mark/.config/foo');
    // And the language identifier must NOT bleed into the rendered text.
    expect(out).not.toContain('text/Users');
  });

  it('handles non-word language identifiers like c++', () => {
    const text = '```c++\nint main() { return 0; }\n```';
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    const out = sanitizeOutput(lastFrame());
    expect(out).not.toContain('`');
    expect(out).toContain('int main()');
    // The language label must not leak into the body.
    expect(out).not.toMatch(/^c\+\+/m);
  });

  it('handles CRLF line endings inside a fenced code block', () => {
    const text = '```bash\r\necho hello\r\n```';
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    const out = sanitizeOutput(lastFrame());
    expect(out).not.toContain('`');
    expect(out).toContain('echo hello');
    // Language must not be emitted as content.
    expect(out).not.toMatch(/^bash\b/m);
  });

  it('handles fence with content glued via JSON-escaped \\n leak', () => {
    // Upstream escape leak: literal "\n" instead of real newline between language and code.
    // Renderer should still recover the fence (treat the leaked tail as code content).
    const text = '```bash\\nchmod 600 ~/.config\n```';
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    const out = sanitizeOutput(lastFrame());
    expect(out).not.toContain('`');
    // The chmod content must still be visible (not collapsed into "bashchmod").
    expect(out).toContain('chmod 600');
    expect(out).not.toContain('bashchmod');
  });

  it('handles streaming unclosed fence with glued content as a code block', () => {
    // While streaming the closing ``` has not arrived yet, but content already streamed.
    const text = '```text/Users/mark/.config/foo';
    const { lastFrame } = render(
      <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
    );
    const out = sanitizeOutput(lastFrame());
    expect(out).not.toContain('`');
    expect(out).toContain('/Users/mark/.config/foo');
    expect(out).not.toContain('text/Users');
  });

  // --- Real-world malformed fence samples extracted from user bug reports ---
  // (D:\tmp\last-requests, gpt-5.5 outputs that produced visible glitches)

  it('recovers ```bashopen ios/Runner.xcworkspace``` (cmd glued to lang)', () => {
    const text = '```bashopen ios/Runner.xcworkspace```';
    const { lastFrame } = render(<MarkdownDisplay {...baseProps} text={text} />);
    const out = sanitizeOutput(lastFrame());
    expect(out).not.toContain('`');
    // The full command must be visible to the user.
    expect(out).toContain('open ios/Runner.xcworkspace');
    // Pollution: the bogus language label "bashopen" must NOT bleed into the body.
    expect(out).not.toContain('bashopen');
  });

  it('recovers ```bash./ci/run_ios_prod.sh release``` (path glued to lang)', () => {
    const text = '```bash./ci/run_ios_prod.sh release```';
    const { lastFrame } = render(<MarkdownDisplay {...baseProps} text={text} />);
    const out = sanitizeOutput(lastFrame());
    expect(out).not.toContain('`');
    expect(out).toContain('./ci/run_ios_prod.sh release');
  });

  it('recovers ```textci/fastlane_match_setup.md``` (text+path)', () => {
    const text = '```textci/fastlane_match_setup.md```';
    const { lastFrame } = render(<MarkdownDisplay {...baseProps} text={text} />);
    const out = sanitizeOutput(lastFrame());
    expect(out).not.toContain('`');
    expect(out).toContain('ci/fastlane_match_setup.md');
    // "textci" is not a real language — must not show as a label inside the body.
    expect(out).not.toContain('textci');
  });

  it('recovers ```Unable to install /Users/mark/...``` (long English prose treated as lang)', () => {
    const text = '```Unable to install /Users/mark/workspace/iosthemeskit/build/ios/Runner.app```';
    const { lastFrame } = render(<MarkdownDisplay {...baseProps} text={text} />);
    const out = sanitizeOutput(lastFrame());
    expect(out).not.toContain('`');
    // The full prose body must be intact for the user to read.
    expect(out).toContain('Unable to install /Users/mark/workspace/iosthemeskit/build/ios/Runner.app');
  });
});
