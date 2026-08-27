import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

const DEFAULT_EXCLUDED_PACKAGES = new Set(['better-sqlite3', 'otto-core']);

function normalizeLockLocation(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//u, '');
}

function dependencyCandidates(parentLocation, dependencyName) {
  const candidates = [];
  let current = normalizeLockLocation(parentLocation);
  while (true) {
    candidates.push(
      current
        ? path.posix.join(current, 'node_modules', dependencyName)
        : path.posix.join('node_modules', dependencyName),
    );
    if (!current) break;
    const parent = path.posix.dirname(current);
    current = parent === '.' || parent === current ? '' : parent;
  }
  return [...new Set(candidates)];
}

function resolveLockedDependency(packages, parentLocation, dependencyName) {
  for (const candidate of dependencyCandidates(parentLocation, dependencyName)) {
    if (packages[candidate] && packages[candidate].link !== true) {
      return candidate;
    }
  }
  return null;
}

function releaseTargetForLockLocation(location) {
  const normalized = normalizeLockLocation(location);
  const serverPrefix = 'packages/server/node_modules/';
  const rootPrefix = 'node_modules/';
  if (normalized.startsWith(serverPrefix)) {
    return path.posix.join(
      'node_modules',
      normalized.slice(serverPrefix.length),
    );
  }
  if (normalized.startsWith(rootPrefix)) return normalized;
  throw new Error(`unsupported enterprise dependency location: ${location}`);
}

function packageNameForLocation(location) {
  const segments = normalizeLockLocation(location).split('/');
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (nodeModulesIndex < 0 || nodeModulesIndex === segments.length - 1) {
    throw new Error(`invalid package location: ${location}`);
  }
  const first = segments[nodeModulesIndex + 1];
  return first.startsWith('@')
    ? `${first}/${segments[nodeModulesIndex + 2]}`
    : first;
}

export function collectEnterpriseRuntimeDependencies({
  repoRoot,
  excludedPackages = DEFAULT_EXCLUDED_PACKAGES,
}) {
  const lock = JSON.parse(
    readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'),
  );
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    throw new Error('enterprise runtime packaging requires npm lockfile v3');
  }
  const packages = Object.fromEntries(
    Object.entries(lock.packages).map(([location, entry]) => [
      normalizeLockLocation(location),
      entry,
    ]),
  );
  const serverLocation = 'packages/server';
  const server = packages[serverLocation];
  if (!server?.dependencies) {
    throw new Error('packages/server production dependencies missing from lock');
  }

  const direct = [];
  const queue = [];
  for (const dependencyName of Object.keys(server.dependencies).sort()) {
    if (excludedPackages.has(dependencyName)) continue;
    const location = resolveLockedDependency(
      packages,
      serverLocation,
      dependencyName,
    );
    if (!location) {
      throw new Error(`locked server dependency not installed: ${dependencyName}`);
    }
    direct.push({ dependencyName, location });
    queue.push(location);
  }

  const selected = new Map();
  while (queue.length > 0) {
    const location = queue.shift();
    if (selected.has(location)) continue;
    const entry = packages[location];
    if (!entry || entry.link === true) {
      throw new Error(`invalid locked runtime dependency: ${location}`);
    }
    const name = entry.name || packageNameForLocation(location);
    if (!entry.version || typeof entry.version !== 'string') {
      throw new Error(`runtime dependency version missing: ${location}`);
    }
    selected.set(location, {
      location,
      name,
      version: entry.version,
      target: releaseTargetForLockLocation(location),
    });

    const required = entry.dependencies || {};
    const optional = entry.optionalDependencies || {};
    for (const dependencyName of Object.keys({
      ...required,
      ...optional,
    }).sort()) {
      const childLocation = resolveLockedDependency(
        packages,
        location,
        dependencyName,
      );
      if (!childLocation) {
        const optionalPeer =
          entry.peerDependenciesMeta?.[dependencyName]?.optional === true;
        if (dependencyName in optional || optionalPeer) continue;
        throw new Error(
          `locked runtime dependency ${dependencyName} missing for ${location}`,
        );
      }
      queue.push(childLocation);
    }
  }

  const selectedNames = new Set(
    [...selected.values()].map(({ name }) => name),
  );
  for (const { location } of selected.values()) {
    const entry = packages[location];
    for (const peerName of Object.keys(entry.peerDependencies || {})) {
      if (entry.peerDependenciesMeta?.[peerName]?.optional === true) continue;
      if (!selectedNames.has(peerName) && !excludedPackages.has(peerName)) {
        throw new Error(
          `required runtime peer ${peerName} missing for ${location}`,
        );
      }
    }
  }

  const byTarget = new Map();
  for (const dependency of selected.values()) {
    const existing = byTarget.get(dependency.target);
    if (
      existing &&
      (existing.name !== dependency.name ||
        existing.version !== dependency.version)
    ) {
      throw new Error(
        `enterprise runtime dependency target conflict: ${dependency.target} ` +
          `(${existing.version} from ${existing.location}; ` +
          `${dependency.version} from ${dependency.location})`,
      );
    }
    if (!existing) byTarget.set(dependency.target, dependency);
  }

  const directVersions = Object.fromEntries(
    direct.map(({ dependencyName, location }) => [
      dependencyName,
      packages[location].version,
    ]),
  );
  return {
    directVersions,
    dependencies: [...byTarget.values()].sort((left, right) =>
      left.target.localeCompare(right.target),
    ),
  };
}

function assertPortablePackageTree(root, current = root) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const candidate = path.join(current, entry.name);
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`runtime dependency contains symlink: ${candidate}`);
    }
    if (entry.isDirectory()) assertPortablePackageTree(root, candidate);
  }
}

export function copyEnterpriseRuntimeDependencies({ repoRoot, releaseRoot }) {
  const collected = collectEnterpriseRuntimeDependencies({ repoRoot });
  for (const dependency of collected.dependencies) {
    const source = path.resolve(repoRoot, dependency.location);
    const sourceRelative = path.relative(repoRoot, source);
    if (
      sourceRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(sourceRelative)
    ) {
      throw new Error(
        `runtime dependency source is outside the locked install: ${dependency.location}`,
      );
    }
    if (!existsSync(source)) {
      throw new Error(
        `runtime dependency source is missing from npm ci: ${dependency.location}`,
      );
    }
    assertPortablePackageTree(source);
    const target = path.join(
      releaseRoot,
      ...dependency.target.split('/'),
    );
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, {
      recursive: true,
      filter: (candidate) => {
        const relative = path.relative(source, candidate);
        return (
          !relative ||
          !relative.split(path.sep).includes('node_modules')
        );
      },
    });
  }
  return collected;
}
