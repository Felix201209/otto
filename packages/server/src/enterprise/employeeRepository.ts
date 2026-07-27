/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Compatibility entrypoint. New code imports the identity_organization module.
 */

export * from '../modules/identity_organization/index.js';
export {
  createEmployee,
  getEmployee,
  listEmployees,
  offboardEmployee,
} from './db.js';
