/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Thin compatibility adapter for the original simple park API.
 */

import { randomInt, randomUUID } from 'node:crypto';
import { createSimpleParkCompatibilityFacade } from '../modules/park_services/index.js';
import { getDB } from './db.js';

export type {
  Park,
  ParkInviteCode,
  ParkServiceRequest,
  ParkServiceSpecialist,
} from '../modules/park_services/index.js';

export const {
  assignSpecialist,
  createInviteCode,
  createPark,
  createServiceRequest,
  getPark,
  getParkServiceRequests,
  getSpecialists,
  listParks,
  removeSpecialist,
  resolveServiceRequest,
  routeServiceRequest,
  useInviteCode,
  validateInviteCode,
} = createSimpleParkCompatibilityFacade({
  db: getDB,
  createId: randomUUID,
  randomInteger: randomInt,
  now: () => new Date(),
});
