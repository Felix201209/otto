import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeLicense(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    if (typeof value.type === 'string' && value.type.trim())
      return value.type.trim();
    if (Array.isArray(value)) {
      const licenses = value
        .map(normalizeLicense)
        .filter((entry) => entry !== 'NOASSERTION');
      if (licenses.length > 0) return licenses.join(' OR ');
    }
  }
  return 'NOASSERTION';
}

function cyclonedxLicense(license) {
  return license === 'NOASSERTION' ? { name: license } : { id: license };
}

function packageAt(directory) {
  const packagePath = path.join(directory, 'package.json');
  if (!existsSync(packagePath)) return null;
  const value = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (typeof value.name !== 'string' || typeof value.version !== 'string')
    return null;
  return {
    name: value.name,
    version: value.version,
    license: normalizeLicense(value.license ?? value.licenses),
    path: directory,
  };
}

function packagesBelow(nodeModulesDirectory, output, visited) {
  if (!existsSync(nodeModulesDirectory)) return;
  const resolved = path.resolve(nodeModulesDirectory);
  if (visited.has(resolved)) return;
  visited.add(resolved);
  for (const entry of readdirSync(nodeModulesDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const directory = path.join(nodeModulesDirectory, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(directory, { withFileTypes: true })) {
        if (!scoped.isDirectory()) continue;
        const packageDirectory = path.join(directory, scoped.name);
        const component = packageAt(packageDirectory);
        if (component) output.push(component);
        packagesBelow(
          path.join(packageDirectory, 'node_modules'),
          output,
          visited,
        );
      }
      continue;
    }
    const component = packageAt(directory);
    if (component) output.push(component);
    packagesBelow(path.join(directory, 'node_modules'), output, visited);
  }
}

function componentPurl(name, version) {
  const encodedName = name
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

export function collectEnterpriseRuntimeComponents(releaseRoot) {
  const collected = [];
  packagesBelow(path.join(releaseRoot, 'node_modules'), collected, new Set());
  const unique = new Map();
  for (const component of collected) {
    const key = `${component.name}@${component.version}`;
    if (!unique.has(key)) unique.set(key, component);
  }
  return [...unique.values()]
    .map(({ name, version, license }) => ({ name, version, license }))
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`,
      ),
    );
}

export function createEnterpriseSupplyChainDocuments(input) {
  const components = collectEnterpriseRuntimeComponents(input.releaseRoot);
  const product = {
    type: 'application',
    name: 'otto-enterprise-server',
    version: input.version,
    licenses: [{ license: { id: 'Apache-2.0' } }],
    properties: [
      { name: 'otto:source-commit', value: input.sourceCommit },
      { name: 'otto:source-input-sha256', value: input.sourceInputSha256 },
      { name: 'otto:release-channel', value: input.releaseChannel },
    ],
  };
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: { component: product },
    components: components.map((component) => ({
      type: 'library',
      name: component.name,
      version: component.version,
      purl: componentPurl(component.name, component.version),
      licenses: [{ license: cyclonedxLicense(component.license) }],
    })),
  };
  const licenses = {
    format: 'otto-enterprise-license-inventory-v1',
    product: {
      name: product.name,
      version: product.version,
      license: 'Apache-2.0',
    },
    components: components.map((component) => ({
      name: component.name,
      version: component.version,
      license: component.license,
    })),
  };
  const provenance = {
    format: 'otto-enterprise-build-provenance-v1',
    buildType:
      'https://github.com/Felix201209/otto/blob/main/scripts/build-enterprise-oneclick.mjs',
    builder: {
      id: 'otto-enterprise-release-builder-v1',
      runtime: input.builderRuntime,
    },
    source: {
      repository: 'https://github.com/Felix201209/otto',
      commit: input.sourceCommit,
      treeDirty: input.sourceTreeDirty,
      sourceInputSha256: input.sourceInputSha256,
      sourceDiffSha256: input.sourceDiffSha256,
    },
    invocation: {
      releaseChannel: input.releaseChannel,
      version: input.version,
      targetArchitectures: input.runtime.supportedArchitectures,
    },
    runtime: input.runtime,
    database: input.database,
    materials: [
      {
        uri: `git+https://github.com/Felix201209/otto@${input.sourceCommit}`,
        digest: {
          sha1: input.sourceCommit,
          sha256: input.sourceInputSha256,
        },
      },
    ],
  };
  return { sbom, licenses, provenance };
}

export function writeEnterpriseSupplyChainDocuments(input) {
  const documents = createEnterpriseSupplyChainDocuments(input);
  const files = {
    sbom: 'sbom.cdx.json',
    licenses: 'THIRD-PARTY-LICENSES.json',
    provenance: 'provenance.json',
  };
  for (const [kind, relative] of Object.entries(files)) {
    writeFileSync(
      path.join(input.releaseRoot, relative),
      `${JSON.stringify(documents[kind], null, 2)}\n`,
      { mode: 0o644 },
    );
  }
  return Object.fromEntries(
    Object.entries(files).map(([kind, relative]) => [
      kind,
      {
        path: relative,
        sha256: sha256(readFileSync(path.join(input.releaseRoot, relative))),
      },
    ]),
  );
}
