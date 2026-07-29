/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const templatePath = path.resolve(
  process.cwd(),
  'deployment/enterprise-oneclick/templates/otto-enterprise.caddy',
);

describe('enterprise Caddy transport policy', () => {
  it('pins supported TLS versions and keeps attachment uploads within product limits', () => {
    const template = fs.readFileSync(templatePath, 'utf8');

    expect(template).toMatch(/protocols\s+tls1\.2\s+tls1\.3/);
    expect(template).toMatch(
      /@direct_message_upload[\s\S]*method POST[\s\S]*path \/enterprise\/messages\/\*[\s\S]*max_size 32MB/,
    );
    expect(template).toMatch(/handle\s*\{[\s\S]*max_size 1MB/);
    expect(template).toContain('reverse_proxy 127.0.0.1:7778');
  });
});
