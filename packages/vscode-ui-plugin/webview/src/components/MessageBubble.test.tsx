import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from './MessageBubble';
import { ChatMessage } from '../types';

// Mock dependencies
vi.mock('../hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('./ToolCallList', () => ({
  ToolCallList: () => <div data-testid="tool-call-list" />,
}));

vi.mock('./ReasoningDisplay', () => ({
  ReasoningDisplay: () => <div data-testid="reasoning-display" />,
}));

vi.mock('./SystemNotificationMessage', () => ({
  SystemNotificationMessage: () => <div data-testid="system-notification" />,
}));

vi.mock('./renderers/SubAgentDisplayRenderer', () => ({
  SubAgentDisplayRenderer: () => <div data-testid="sub-agent-display" />,
}));

describe('MessageBubble', () => {
  it('renders user message correctly', () => {
    const message: ChatMessage = {
      id: '1',
      type: 'user',
      content: [{ type: 'text', value: 'Hello AI' }],
      timestamp: Date.now(),
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText('Hello AI')).toBeInTheDocument();
  });

  it('renders assistant message with markdown', () => {
    const message: ChatMessage = {
      id: '2',
      type: 'assistant',
      content: [{ type: 'text', value: '# Hello\nThis is **bold**' }],
      timestamp: Date.now(),
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello');
    expect(screen.getByText('This is')).toBeInTheDocument();
    expect(screen.getByText('bold')).toBeInTheDocument();
  });

  it('renders tool message', () => {
    const message: ChatMessage = {
      id: '3',
      type: 'tool',
      content: [{ type: 'text', value: 'tool result' }],
      timestamp: Date.now(),
      associatedToolCalls: [{ id: 'tc1', toolName: 'test_tool', displayName: 'Test Tool', parameters: {}, status: 'success' as any }],
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByTestId('tool-call-list')).toBeInTheDocument();
  });

  it('renders reasoning display when isReasoning is true', () => {
    const message: ChatMessage = {
      id: '4',
      type: 'assistant',
      content: [{ type: 'text', value: 'Result' }],
      timestamp: Date.now(),
      reasoning: 'Thinking...',
      isReasoning: true,
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByTestId('reasoning-display')).toBeInTheDocument();
  });

  // --- Defensive code-block rendering tests (added for empty-TEXT-block bug fix) ---

  it('does not render code-block wrapper for empty fenced block while streaming', () => {
    // Streaming mid-state: the fence opener has arrived but no body or closer yet.
    // Before the fix this rendered an empty box with header "TEXT".
    const message: ChatMessage = {
      id: 'sb-1',
      type: 'assistant',
      content: [{ type: 'text', value: '```\n' }],
      timestamp: Date.now(),
      isStreaming: true,
    };
    const { container } = render(<MessageBubble message={message} />);
    // The "TEXT" / language label must not appear for an empty streaming block.
    expect(container.querySelector('.code-language')).toBeNull();
    // No outer code-block-wrapper should be rendered for an empty body.
    expect(container.querySelector('.code-block-wrapper')).toBeNull();
  });

  it('renders normal code block when content is present', () => {
    const message: ChatMessage = {
      id: 'sb-2',
      type: 'assistant',
      content: [
        { type: 'text', value: '```bash\nchmod 600 ~/.config\n```' },
      ],
      timestamp: Date.now(),
    };
    const { container } = render(<MessageBubble message={message} />);
    // With real content, the wrapper must render and language must be 'bash'.
    expect(container.querySelector('.code-block-wrapper')).not.toBeNull();
    const lang = container.querySelector('.code-language');
    expect(lang?.textContent).toBe('bash');
  });

  it('does not render code-block wrapper for empty block when finished (no language label leaks)', () => {
    // Even if the LLM somehow emitted ```\n``` (empty block), we should not show a
    // bare "TEXT" header — render minimal placeholder instead.
    const message: ChatMessage = {
      id: 'sb-3',
      type: 'assistant',
      content: [{ type: 'text', value: '```\n```' }],
      timestamp: Date.now(),
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(container.querySelector('.code-language')).toBeNull();
    expect(container.querySelector('.code-block-wrapper')).toBeNull();
  });

  // --- Glued single-line fence rehab tests (real-world LLM outputs) ---

  it('promotes single-line glued fence ```bashopen ios/foo``` to a real block', () => {
    // Real LLM output: opener + body + closer all on the same line. By CommonMark
    // spec react-markdown treats this as inline code. Our preprocessing should
    // promote it to a block-level fenced code block with lang "bash".
    const message: ChatMessage = {
      id: 'sb-glued-1',
      type: 'assistant',
      content: [
        { type: 'text', value: '```bashopen ios/Runner.xcworkspace```' },
      ],
      timestamp: Date.now(),
    };
    const { container } = render(<MessageBubble message={message} />);
    // Block code wrapper must be present.
    expect(container.querySelector('.code-block-wrapper')).not.toBeNull();
    expect(container.querySelector('.code-language')?.textContent).toBe('bash');
    // The actual code body — read directly from <code>, NOT the whole tree
    // (textContent of the wrapper would also include the language label).
    const codeBody = container.querySelector('pre.code-block code')?.textContent ?? '';
    expect(codeBody.trim()).toBe('open ios/Runner.xcworkspace');
  });

  it('promotes ```bash./ci/run_ios_prod.sh release``` to block with lang=bash', () => {
    const message: ChatMessage = {
      id: 'sb-glued-2',
      type: 'assistant',
      content: [
        { type: 'text', value: '```bash./ci/run_ios_prod.sh release```' },
      ],
      timestamp: Date.now(),
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(container.querySelector('.code-block-wrapper')).not.toBeNull();
    expect(container.querySelector('.code-language')?.textContent).toBe('bash');
    const codeBody = container.querySelector('pre.code-block code')?.textContent ?? '';
    expect(codeBody.trim()).toBe('./ci/run_ios_prod.sh release');
  });
});
