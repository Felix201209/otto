/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

export function supportedEnterpriseSchemaVersions(schemaVersion) {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 2) {
    throw new Error('enterprise schema version must be an integer >= 2');
  }
  return Array.from({ length: schemaVersion - 1 }, (_, index) => index + 2);
}
