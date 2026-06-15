/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandActionReturn } from './types.js';

/**
 * `/init` — ask the agent to analyze the current directory and generate a
 * project memory file. In gemini-cli this file is called `GEMINI.md`; in
 * DeepCode it is `OTTO.md`. The prompt text is deliberately the same
 * instructional content, only the filename changes.
 */
export function performInit(doesMemoryFileExist: boolean): CommandActionReturn {
  if (doesMemoryFileExist) {
    return {
      type: 'message',
      messageType: 'info',
      content:
        'A OTTO.md file already exists in this directory. No changes were made.',
    };
  }
  return {
    type: 'submit_prompt',
    content: `
You are an AI agent that brings the power of Otto directly into the terminal. Your task is to analyze the current directory and generate a comprehensive OTTO.md file to be used as instructional context for future interactions.

**Analysis Process:**

1.  **Initial Exploration:**
    *   Start by listing the files and directories to get a high-level overview of the structure.
    *   Read the README file (e.g., \`README.md\`, \`README.txt\`) if it exists.

2.  **Iterative Deep Dive (up to 10 files):**
    *   Select a few files that seem most important (e.g. config, main source, docs).
    *   Read them and let your discoveries guide further exploration.

3.  **Identify Project Type:**
    *   **Code Project:** Look for \`package.json\`, \`requirements.txt\`, \`pom.xml\`, \`go.mod\`, \`Cargo.toml\`, a \`src\` directory, etc.
    *   **Non-Code Project:** Documentation, research, notes, etc.

**OTTO.md Content Generation:**

**For a Code Project:**
*   **Project Overview:** Purpose, main technologies, architecture.
*   **Building and Running:** Key build / run / test commands.
*   **Development Conventions:** Coding styles, testing practices, contribution guidelines.

**For a Non-Code Project:**
*   **Directory Overview:** Purpose and contents.
*   **Key Files:** Important files with brief explanation.
*   **Usage:** How the contents are intended to be used.

**Final Output:**

Write the complete content to the \`OTTO.md\` file. The output must be well-formatted Markdown.
`,
  };
}
