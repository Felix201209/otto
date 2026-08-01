/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  approveE2eeDeviceInRepository,
  getE2eeDeviceDirectoryFromRepository,
  getE2eeTransparencyInclusionProofFromRepository,
  registerE2eeAccountRootInRepository,
  registerE2eeDeviceInRepository,
  revokeE2eeDeviceInRepository,
  type SecureMessagingRepositoryStore,
} from './secureMessagingRepository.js';

export function createSecureMessagingFacade(
  store: SecureMessagingRepositoryStore,
) {
  return {
    registerE2eeAccountRoot: registerE2eeAccountRootInRepository.bind(
      null,
      store,
    ),
    registerE2eeDevice: registerE2eeDeviceInRepository.bind(null, store),
    approveE2eeDevice: approveE2eeDeviceInRepository.bind(null, store),
    revokeE2eeDevice: revokeE2eeDeviceInRepository.bind(null, store),
    getE2eeDeviceDirectory: getE2eeDeviceDirectoryFromRepository.bind(
      null,
      store,
    ),
    getE2eeTransparencyInclusionProof:
      getE2eeTransparencyInclusionProofFromRepository.bind(null, store),
  };
}
