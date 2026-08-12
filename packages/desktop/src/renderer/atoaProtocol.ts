/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export {
  ATOA_CONTEXT_SOURCES,
  ATOA_DIRECT_MESSAGE_MAX_LENGTH,
  ATOA_REQUEST_PREFIX,
  ATOA_RESPONSE_PREFIX,
  buildAtoaRequest,
  buildAtoaResponse,
  parseAtoaMessage,
  type AtoaContextSource,
  type AtoaMode,
  type AtoaRequestPayload,
  type AtoaResponsePayload,
  type BuildAtoaRequestOptions,
  type ParsedAtoaMessage,
} from '../../../core/src/a2a/atoaProtocol.js';

import {
  displayDirectMessageContent as displayAtoaContent,
} from '../../../core/src/a2a/atoaProtocol.js';
import {
  displayFederationAtoaDecision,
  parseFederationAtoaDecision,
} from '../../../core/src/a2a/federationAtoaProtocol.js';

export {
  buildFederationAtoaDecision,
  FEDERATION_ATOA_DECISION_PREFIX,
  parseFederationAtoaDecision,
  type FederationAtoaApprovedDecision,
  type FederationAtoaDecision,
  type FederationAtoaDeniedDecision,
} from '../../../core/src/a2a/federationAtoaProtocol.js';

export function displayDirectMessageContent(content: string): string {
  const decision = parseFederationAtoaDecision(content);
  return decision
    ? displayFederationAtoaDecision(decision)
    : displayAtoaContent(content);
}
