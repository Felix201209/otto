/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectEnterpriseRuntimeComponents,
  createEnterpriseSupplyChainDocuments,
} from '../enterprise-supply-chain.mjs';

function writePackage(root, relative, value) {
  const directory = path.join(root, 'node_modules', relative);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify(value)}\n`,
  );
}

describe('enterprise server supply-chain documents', () => {
  it('describes only dependencies that are present in the packaged runtime', () => {
    const releaseRoot = mkdtempSync(path.join(tmpdir(), 'otto-sbom-'));
    try {
      writePackage(releaseRoot, 'fastify', {
        name: 'fastify',
        version: '5.6.0',
        license: 'MIT',
      });
      writePackage(releaseRoot, '@otto/runtime-helper', {
        name: '@otto/runtime-helper',
        version: '1.2.3',
        licenses: [{ type: 'Apache-2.0' }],
      });
      writePackage(releaseRoot, 'unknown-license', {
        name: 'unknown-license',
        version: '0.1.0',
      });

      expect(collectEnterpriseRuntimeComponents(releaseRoot)).toEqual([
        {
          name: '@otto/runtime-helper',
          version: '1.2.3',
          license: 'Apache-2.0',
        },
        { name: 'fastify', version: '5.6.0', license: 'MIT' },
        {
          name: 'unknown-license',
          version: '0.1.0',
          license: 'NOASSERTION',
        },
      ]);

      const documents = createEnterpriseSupplyChainDocuments({
        releaseRoot,
        version: '1.10.2',
        releaseChannel: 'stable',
        sourceCommit: '1'.repeat(40),
        sourceTreeDirty: false,
        sourceInputSha256: '2'.repeat(64),
        sourceDiffSha256: '3'.repeat(64),
        builderRuntime: 'v22.23.1',
        runtime: {
          node: '22.23.1',
          supportedArchitectures: ['linux-x64', 'linux-arm64'],
        },
        database: {
          schemaFrom: [2],
          schemaTo: 2,
          futureSchemaPolicy: 'reject',
        },
      });

      expect(documents.sbom).toMatchObject({
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        metadata: {
          component: {
            name: 'otto-enterprise-server',
            version: '1.10.2',
          },
        },
      });
      expect(documents.sbom.components).toHaveLength(3);
      expect(documents.sbom.components[2].licenses).toEqual([
        { license: { name: 'NOASSERTION' } },
      ]);
      expect(documents.licenses.components).toHaveLength(3);
      expect(documents.provenance).toMatchObject({
        source: {
          commit: '1'.repeat(40),
          treeDirty: false,
          sourceInputSha256: '2'.repeat(64),
          sourceDiffSha256: '3'.repeat(64),
        },
        invocation: {
          releaseChannel: 'stable',
          version: '1.10.2',
          targetArchitectures: ['linux-x64', 'linux-arm64'],
        },
      });
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });
});
