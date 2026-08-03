/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * NSI-07: Otto Green distribution variant.
 *
 * Otto and Otto Green must be able to install, log in and update side-by-side
 * on the same machine without colliding: distinct product name, app id,
 * protocol scheme, artifact names, macOS bundle id/data directory and update
 * channel. This module is the single source of truth for those identity
 * fields so electron-builder and the packaging scripts stay in lockstep.
 *
 * Picking the green variant:
 *   OTTO_GREEN=1  → Otto Green
 *   otherwise     → Otto (default)
 */

export const OTTO_DISTRIBUTION = 'Otto';
export const OTTO_GREEN_DISTRIBUTION = 'Otto Green';

/**
 * Distribution identity fields (plain object).
 * @typedef {Object} DistributionIdentity
 * @property {string} productName Display product name (electron-builder productName / shortcut).
 * @property {string} appId Reverse-DNS app id (electron-builder appId / mac bundle id).
 * @property {string} protocolName URL scheme / deep-link protocol display name (must differ from Otto).
 * @property {string} protocolScheme URL scheme / deep-link protocol (must differ from Otto).
 * @property {string} artifactToken Artifact token used in build artifact names.
 * @property {string} shortcutName Windows install shortcut name.
 * @property {string} dataDirectoryName Data-directory identifier (userData folder name).
 * @property {string} distributionId Update channel distribution id (see update-policy-adapter).
 * @property {string|null} variantEnv Env var that selects this variant when set to a truthy value.
 * @property {string} macBundleId macOS bundle id (explicit, keeps Gatekeeper/update isolation).
 */

export const OTTO_IDENTITY = {
  productName: 'Otto',
  appId: 'ai.otto.desktop',
  protocolName: 'Otto Enterprise Invite',
  protocolScheme: 'otto',
  artifactToken: 'Otto',
  shortcutName: 'Otto',
  dataDirectoryName: 'Otto',
  distributionId: 'otto',
  variantEnv: null,
  macBundleId: 'ai.otto.desktop',
};

export const OTTO_GREEN_IDENTITY = {
  productName: 'Otto Green',
  appId: 'ai.otto.green.desktop',
  protocolName: 'Otto Green Invite',
  protocolScheme: 'otto-green',
  artifactToken: 'OttoGreen',
  shortcutName: 'Otto Green',
  dataDirectoryName: 'Otto Green',
  distributionId: 'otto-green',
  variantEnv: 'OTTO_GREEN',
  macBundleId: 'ai.otto.green.desktop',
};

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Selects the variant: Green when OTTO_GREEN=1, else Otto.
 * @param {Record<string,string|undefined>} [env]
 * @returns {DistributionIdentity}
 */
export function resolveDistribution(
  env = process.env,
) {
  return TRUTHY.has(String(env[OTTO_GREEN_IDENTITY.variantEnv] ?? '').toLowerCase())
    ? OTTO_GREEN_IDENTITY
    : OTTO_IDENTITY;
}

/**
 * Windows artifact name, e.g. "OttoGreen-Setup-1.2.3-win-x64.exe".
 * @param {string} version
 * @param {string} [arch]
 * @param {DistributionIdentity} [identity]
 * @returns {string}
 */
export function winArtifactName(
  version,
  arch = 'x64',
  identity = resolveDistribution(),
) {
  return `${identity.artifactToken}-Setup-${version}-win-${arch}.exe`;
}

/**
 * macOS artifact name, e.g. "OttoGreen-1.2.3-arm64.dmg".
 * @param {string} version
 * @param {'arm64'|'x64'} arch
 * @param {DistributionIdentity} [identity]
 * @returns {string}
 */
export function macArtifactName(
  version,
  arch,
  identity = resolveDistribution(),
) {
  return `${identity.artifactToken}-${version}-${arch}.dmg`;
}

/** Blockmap file name for incremental updates. */
export function blockmapName(baseName) {
  return `${baseName}.blockmap`;
}
