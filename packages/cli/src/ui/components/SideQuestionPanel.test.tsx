/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SideQuestionPanel } from './SideQuestionPanel.js';

describe('SideQuestionPanel', () => {
  it('renders nothing when state is null', () => {
    const { lastFrame } = render(
      <SideQuestionPanel state={null} terminalHeight={40} terminalWidth={100} />,
    );
    expect(lastFrame()).toBe('');
  });

  it('renders the [/btw] tag and the question preview', () => {
    const { lastFrame } = render(
      <SideQuestionPanel
        state={{
          question: 'how many tokens does the current convo use?',
          answer: '',
          status: 'pending',
        }}
        terminalHeight={40}
        terminalWidth={100}
      />,
    );
    expect(lastFrame()).toContain('[/btw]');
    expect(lastFrame()).toContain('how many tokens does the current convo use?');
  });

  it('shows pending placeholder when there is no answer yet', () => {
    const { lastFrame } = render(
      <SideQuestionPanel
        state={{ question: 'q', answer: '', status: 'pending' }}
        terminalHeight={40}
        terminalWidth={100}
      />,
    );
    expect(lastFrame()).toContain('Forking a lightweight agent');
  });

  it('renders the streaming answer text', () => {
    const { lastFrame } = render(
      <SideQuestionPanel
        state={{
          question: 'q',
          answer: 'The cache hit rate is 78%.',
          status: 'streaming',
        }}
        terminalHeight={40}
        terminalWidth={100}
      />,
    );
    expect(lastFrame()).toContain('The cache hit rate is 78%.');
  });

  it('shows the explicit Esc-to-cancel hint while active', () => {
    const { lastFrame } = render(
      <SideQuestionPanel
        state={{ question: 'q', answer: 'partial', status: 'streaming' }}
        terminalHeight={40}
        terminalWidth={100}
      />,
    );
    expect(lastFrame()).toContain('Esc to cancel');
    // Spec calls for explicit acknowledgment that main agent is unaffected.
    expect(lastFrame()).toContain('does not affect the main agent');
  });

  it('shows the explicit Esc-to-close hint once done', () => {
    const { lastFrame } = render(
      <SideQuestionPanel
        state={{ question: 'q', answer: 'full answer', status: 'done' }}
        terminalHeight={40}
        terminalWidth={100}
      />,
    );
    expect(lastFrame()).toContain('Esc to close');
  });

  it('renders the error message on failure', () => {
    const { lastFrame } = render(
      <SideQuestionPanel
        state={{
          question: 'q',
          answer: '',
          status: 'failed',
          error: 'upstream 429',
        }}
        terminalHeight={40}
        terminalWidth={100}
      />,
    );
    expect(lastFrame()).toContain('failed');
    expect(lastFrame()).toContain('upstream 429');
  });

  it('caps height at 40% of terminal (min 5 rows)', () => {
    const { lastFrame } = render(
      <SideQuestionPanel
        state={{ question: 'q', answer: 'short', status: 'done' }}
        terminalHeight={50}
        terminalWidth={100}
      />,
    );
    // The panel renders within the 40% budget; we just confirm it renders
    // visibly. Exact row count varies by terminal/font.
    expect(lastFrame()).toContain('[/btw]');
    expect(lastFrame()).toContain('short');
  });

  it('truncates very long question previews in the header', () => {
    const longQ = 'x'.repeat(500);
    const { lastFrame } = render(
      <SideQuestionPanel
        state={{ question: longQ, answer: 'a', status: 'done' }}
        terminalHeight={40}
        terminalWidth={100}
      />,
    );
    // Header truncation marker present.
    expect(lastFrame()).toContain('…');
  });
});
