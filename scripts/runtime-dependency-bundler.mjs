/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function packagePath(base, name) {
  return path.join(base, 'node_modules', ...name.split('/'));
}

function resolvePackageDirectory(name, fromDirectory) {
  let current = path.resolve(fromDirectory);
  while (true) {
    const candidate = packagePath(current, name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function packageMetadata(directory) {
  return JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
}

function targetRelativePath(packageDirectory, rootNodeModules) {
  const relative = path.relative(rootNodeModules, packageDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `runtime dependency is outside the root node_modules: ${packageDirectory}`,
    );
  }
  return relative;
}

function copyPackageWithoutNestedDependencies(
  source,
  target,
  bundledDependencies,
) {
  const bundled = new Set(bundledDependencies || []);
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter(candidate) {
      const relative = path.relative(source, candidate);
      if (!relative) return true;
      const segments = relative.split(path.sep);
      const nodeModulesIndex = segments.indexOf('node_modules');
      if (nodeModulesIndex < 0) return true;
      const dependencyName = segments[nodeModulesIndex + 1]?.startsWith('@')
        ? `${segments[nodeModulesIndex + 1]}/${segments[nodeModulesIndex + 2]}`
        : segments[nodeModulesIndex + 1];
      return bundled.has(dependencyName);
    },
  });
}

export function collectRuntimeDependencyClosure(input) {
  const rootNodeModules = path.join(input.repoRoot, 'node_modules');
  const pending = input.directDependencies.map((name) => ({
    name,
    fromDirectory: input.repoRoot,
    optional: false,
  }));
  const packages = new Map();
  while (pending.length > 0) {
    const request = pending.pop();
    const directory = resolvePackageDirectory(
      request.name,
      request.fromDirectory,
    );
    if (!directory) {
      if (request.optional) continue;
      throw new Error(
        `required runtime dependency is not installed: ${request.name}`,
      );
    }
    const relative = targetRelativePath(directory, rootNodeModules);
    if (packages.has(relative)) continue;
    const metadata = packageMetadata(directory);
    packages.set(relative, {
      name: metadata.name,
      version: metadata.version,
      directory,
      relative,
      bundledDependencies:
        metadata.bundleDependencies || metadata.bundledDependencies || [],
    });
    for (const dependency of Object.keys(metadata.dependencies || {})) {
      pending.push({
        name: dependency,
        fromDirectory: directory,
        optional: false,
      });
    }
    for (const dependency of Object.keys(metadata.optionalDependencies || {})) {
      pending.push({
        name: dependency,
        fromDirectory: directory,
        optional: true,
      });
    }
    for (const dependency of Object.keys(metadata.peerDependencies || {})) {
      pending.push({
        name: dependency,
        fromDirectory: directory,
        optional: true,
      });
    }
  }
  return [...packages.values()].sort((left, right) =>
    left.relative.localeCompare(right.relative),
  );
}

export function bundleRuntimeDependencyClosure(input) {
  const packages = collectRuntimeDependencyClosure(input);
  const targetNodeModules = path.join(input.releaseRoot, 'node_modules');
  mkdirSync(targetNodeModules, { recursive: true });
  for (const dependency of packages) {
    const target = path.join(targetNodeModules, dependency.relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyPackageWithoutNestedDependencies(
      dependency.directory,
      target,
      dependency.bundledDependencies,
    );
  }
  const directVersions = {};
  for (const name of input.directDependencies) {
    const directory = resolvePackageDirectory(name, input.repoRoot);
    const metadata = directory ? packageMetadata(directory) : null;
    if (!metadata?.version) {
      throw new Error(`unable to resolve direct runtime dependency: ${name}`);
    }
    directVersions[name] = metadata.version;
  }
  return { packages, directVersions };
}
