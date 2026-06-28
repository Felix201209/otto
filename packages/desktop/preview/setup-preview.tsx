/* TEMP visual-verification entry for SetupPanel (Issue #7). Deleted after screenshot. */
/* eslint-disable */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/renderer/styles/tokens.css';
import '../src/renderer/styles/app.css';
import { SetupPanel } from '../src/renderer/setup/SetupPanel.js';

(window as any).otto = { openExternal: async () => {} };

const MODELS = [
  { id: 'custom:anthropic:claude-opus-4@abc', displayName: 'Claude Opus 4', provider: 'anthropic' },
  { id: 'custom:openai:gpt-5.1@def', displayName: 'OpenAI gpt-5.1', provider: 'openai-responses' },
];

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <div style={{ height: '100vh', position: 'relative', background: '#fff' }} className="otto-app">
      <SetupPanel models={MODELS as any} onClose={() => {}} />
    </div>,
  );
}
