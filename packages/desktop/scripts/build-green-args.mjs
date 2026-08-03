/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * NSI-07: produce electron-builder CLI overrides that turn the normal Otto
 * build into the isolated Otto Green variant.
 *
 * Usage from a build script:
 *   import { greenBuilderArgs } from './build-green-args.mjs';
 *   electronBuilder('--win', '--x64', ...greenBuilderArgs(identity));
 *
 * Only identity fields that must differ are overridden; everything else is
 * inherited from package.json build config.
 */

import { OTTO_GREEN_IDENTITY } from './distribution-config.mjs';

/**
 * Returns `['--config.<path>=<value>', ...]` overrides for the given Green
 * identity. npm treats `--config.*` args as npm flags, so when invoked through
 * `npm run`, forward them via a wrapper that passes them straight to the binary.
 *
 * @param {DistributionIdentity} [identity]
 * @returns {string[]}
 */
export function greenBuilderArgs(identity = OTTO_GREEN_IDENTITY) {
  /** @param {string} path @param {string|number|boolean} value */
  const o = (path, value) => `--config.${path}=${String(value)}`;
  return [
    o('productName', identity.productName),
    o('appId', identity.appId),
    o('protocols[0].name', identity.protocolName),
    o('protocols[0].schemes[0]', identity.protocolScheme),
    o('mac.artifactName', `${identity.artifactToken}-\${version}-\${arch}.\${ext}`),
    o('mac.extendInfo.CFBundleName', identity.productName),
    o('nsis.artifactName', `${identity.artifactToken}-Setup-\${version}-win-x64.\${ext}`),
    o('nsis.shortcutName', identity.shortcutName),
    o('extraMetadata.name', 'otto-green-desktop'),
    o('extraMetadata.productName', identity.productName),
  ];
}

/** Convenience: base64-safe token used to stamp the release tag. */
export function greenReleaseTag(version) {
  return `v${version}-green`;
}
