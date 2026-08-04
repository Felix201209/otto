/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../', import.meta.url);

function readRepositoryFile(path) {
  return readFileSync(new URL(path, repositoryRoot), 'utf8');
}

describe('legacy legal documentation gate', () => {
  it('does not ship the inherited Gemini legal or quota pages', () => {
    expect(existsSync(new URL('docs/tos-privacy.md', repositoryRoot))).toBe(
      false,
    );
    expect(
      existsSync(new URL('docs/quota-and-pricing.md', repositoryRoot)),
    ).toBe(false);
  });

  it('keeps the documentation index free of inherited Gemini legal links', () => {
    const index = readRepositoryFile('docs/index.md');

    expect(index).not.toMatch(/tos-privacy\.md|quota-and-pricing\.md/u);
    expect(index).not.toMatch(/Gemini CLI.*(?:Terms|Privacy|Pricing)/iu);
    expect(index).toContain('./compliance/data-governance.zh-CN.md');
  });

  it('does not mix Google or Gemini terms into the Otto compliance baseline', () => {
    const baseline = readRepositoryFile(
      'docs/compliance/data-governance.zh-CN.md',
    );

    expect(baseline).not.toMatch(
      /Gemini CLI|Google Terms of Service|Google Privacy Policy/iu,
    );
  });
});
