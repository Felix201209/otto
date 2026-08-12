/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

import type {
  Database,
  EncryptedFieldCipher,
  EncryptedFieldValue,
} from '../data_platform/index.js';
import type {
  ClaimedFederationEnvelope,
  FederationChatContactView,
  FederationChatMessageView,
  FederationInboxMessageView,
  FederationMessageType,
  SignedFederationEnvelope,
} from './federationContracts.js';

const OUTBOX_BATCH_LIMIT = 100;
const INBOX_BATCH_LIMIT = 200;

export interface FederationRepositoryStore {
  db(): Database;
  fieldCipher: EncryptedFieldCipher;
  deploymentId(): string;
  now(): number;
}

interface OutboxRow {
  message_id: string;
  signed_envelope_json: string;
  attempts: number;
  expires_at_ms: number;
}

interface InboxClaimRow {
  message_id: string;
  claim_token_ciphertext: string;
  claim_token_iv: string;
  claim_token_auth_tag: string;
  claim_token_key_version: number;
}

interface InboxRow {
  cursor: number;
  message_id: string;
  signed_envelope_json: string;
  gateway_acknowledged: number;
  consumed_at_ms: number | null;
  received_at_ms: number;
}

interface GrantRow {
  grant_id: string;
  owner_deployment_id: string;
  requester_deployment_id: string;
  owner_principal_id: string;
  requester_principal_id: string;
  scopes_json: string;
  expires_at_ms: number;
  consumed_message_id: string | null;
  revoked_at_ms: number | null;
}

interface ChatContactRow {
  contact_id: string;
  remote_deployment_id: string;
  remote_principal_id: string;
  display_name: string;
  deployment_display_name: string;
  created_at_ms: number;
  updated_at_ms: number;
  last_message_at_ms: number | null;
  unread_count: number;
}

interface ChatMessageRow {
  sequence: number;
  message_id: string;
  contact_id: string;
  direction: 'inbound' | 'outbound';
  signed_envelope_json: string;
  received_at_ms: number | null;
  read_at_ms: number | null;
  created_at_ms: number;
  outbox_status: 'queued' | 'sent' | 'failed' | 'expired' | null;
}

function parseSignedEnvelope(value: string): SignedFederationEnvelope {
  const parsed = JSON.parse(value) as SignedFederationEnvelope;
  if (!parsed?.envelope || typeof parsed.signature !== 'string') {
    throw new Error('persisted federation envelope is invalid');
  }
  return parsed;
}

function claimContext(messageId: string): string {
  return `federation:claim-token:${messageId}`;
}

function encryptedColumns(value: EncryptedFieldValue): [string, string, string, number] {
  return [value.ciphertext, value.iv, value.authTag, value.keyVersion];
}

function decryptClaimToken(
  store: FederationRepositoryStore,
  row: InboxClaimRow,
): string {
  return store.fieldCipher.decryptText(
    {
      ciphertext: row.claim_token_ciphertext,
      iv: row.claim_token_iv,
      authTag: row.claim_token_auth_tag,
      keyVersion: row.claim_token_key_version,
    },
    claimContext(row.message_id),
  );
}

function clampedLimit(value: number | undefined, maximum: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.floor(value!)))
    : Math.min(50, maximum);
}

function retryAt(now: number, attempts: number): number {
  const delay = Math.min(15 * 60_000, 2_000 * (2 ** Math.min(8, attempts)));
  const jitter = Math.floor(delay * 0.2 * Math.random());
  return now + delay + jitter;
}

function federationContactId(
  ownerAccountId: string,
  remoteDeploymentId: string,
  remotePrincipalId: string,
): string {
  return `fcontact_${createHash('sha256')
    .update('otto:federation-contact:v1\0')
    .update(ownerAccountId)
    .update('\0')
    .update(remoteDeploymentId)
    .update('\0')
    .update(remotePrincipalId)
    .digest('hex')
    .slice(0, 40)}`;
}

export function federationConversationId(input: {
  localDeploymentId: string;
  localPrincipalId: string;
  remoteDeploymentId: string;
  remotePrincipalId: string;
}): string {
  const participants = [
    `${input.localDeploymentId}:${input.localPrincipalId}`,
    `${input.remoteDeploymentId}:${input.remotePrincipalId}`,
  ].sort();
  return `fconversation_${createHash('sha256')
    .update('otto:federation-conversation:v1\0')
    .update(participants.join('\0'))
    .digest('hex')
    .slice(0, 40)}`;
}

function contactView(row: ChatContactRow): FederationChatContactView {
  return {
    id: row.contact_id,
    identity: `${row.remote_deployment_id}:${row.remote_principal_id}`,
    remoteDeploymentId: row.remote_deployment_id,
    remotePrincipalId: row.remote_principal_id,
    displayName: row.display_name,
    deploymentDisplayName: row.deployment_display_name,
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
    lastMessageAt: row.last_message_at_ms === null
      ? null
      : new Date(row.last_message_at_ms).toISOString(),
    unreadCount: row.unread_count,
  };
}

export function saveFederationChatContactInRepository(
  store: FederationRepositoryStore,
  input: {
    ownerAccountId: string;
    remoteDeploymentId: string;
    remotePrincipalId: string;
    displayName: string;
    deploymentDisplayName: string;
  },
): FederationChatContactView {
  if (input.remoteDeploymentId === store.deploymentId()) {
    throw new Error('local accounts must use the local organization directory');
  }
  const owner = store.db().prepare(
    `SELECT id FROM accounts
     WHERE id = ? AND status = 'active' AND deleted_at IS NULL`,
  ).get(input.ownerAccountId) as { id: string } | undefined;
  if (!owner) throw new Error('federation contact owner is not an active account');
  const now = store.now();
  const contactId = federationContactId(
    input.ownerAccountId,
    input.remoteDeploymentId,
    input.remotePrincipalId,
  );
  store.db().prepare(
    `INSERT INTO federation_chat_contacts
      (contact_id, owner_account_id, remote_deployment_id,
       remote_principal_id, display_name, deployment_display_name,
       created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_account_id, remote_deployment_id, remote_principal_id)
     DO UPDATE SET display_name = excluded.display_name,
       deployment_display_name = excluded.deployment_display_name,
       updated_at_ms = excluded.updated_at_ms`,
  ).run(
    contactId,
    input.ownerAccountId,
    input.remoteDeploymentId,
    input.remotePrincipalId,
    input.displayName,
    input.deploymentDisplayName,
    now,
    now,
  );
  const saved = listFederationChatContactsInRepository(
    store,
    input.ownerAccountId,
  ).find((contact) => contact.id === contactId);
  if (!saved) throw new Error('federation contact could not be persisted');
  return saved;
}

export function listFederationChatContactsInRepository(
  store: FederationRepositoryStore,
  ownerAccountId: string,
): FederationChatContactView[] {
  const rows = store.db().prepare(
    `SELECT c.*,
       MAX(m.created_at_ms) AS last_message_at_ms,
       SUM(CASE WHEN m.direction = 'inbound' AND m.read_at_ms IS NULL
           THEN 1 ELSE 0 END) AS unread_count
     FROM federation_chat_contacts c
     LEFT JOIN federation_chat_messages m ON m.contact_id = c.contact_id
     WHERE c.owner_account_id = ?
     GROUP BY c.contact_id
     ORDER BY last_message_at_ms DESC, c.updated_at_ms DESC, c.contact_id`,
  ).all(ownerAccountId) as ChatContactRow[];
  return rows.map(contactView);
}

export function removeFederationChatContactInRepository(
  store: FederationRepositoryStore,
  input: { ownerAccountId: string; contactId: string },
): boolean {
  const result = store.db().prepare(
    `DELETE FROM federation_chat_contacts
     WHERE contact_id = ? AND owner_account_id = ?`,
  ).run(input.contactId, input.ownerAccountId);
  return Number(result.changes) > 0;
}

export function getFederationChatContactInRepository(
  store: FederationRepositoryStore,
  input: { ownerAccountId: string; contactId: string },
): FederationChatContactView | null {
  return listFederationChatContactsInRepository(store, input.ownerAccountId)
    .find((contact) => contact.id === input.contactId) ?? null;
}

export function queueFederationEnvelopeInRepository(
  store: FederationRepositoryStore,
  signed: SignedFederationEnvelope,
): { messageId: string; duplicate: boolean } {
  const now = store.now();
  const serialized = JSON.stringify(signed);
  const digest = createHash('sha256')
    .update(signed.envelope.ciphertext, 'utf8')
    .digest('hex');
  const result = store.db().prepare(
    `INSERT OR IGNORE INTO federation_outbox
      (message_id, recipient_deployment_id, message_type,
       signed_envelope_json, ciphertext_sha256, status, attempts,
       expires_at_ms, next_attempt_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
  ).run(
    signed.envelope.messageId,
    signed.envelope.recipientDeploymentId,
    signed.envelope.type,
    serialized,
    digest,
    Date.parse(signed.envelope.expiresAt),
    now,
    now,
    now,
  );
  if (Number(result.changes) === 0) {
    const existing = store.db().prepare(
      'SELECT signed_envelope_json FROM federation_outbox WHERE message_id = ?',
    ).get(signed.envelope.messageId) as { signed_envelope_json: string } | undefined;
    if (!existing || existing.signed_envelope_json !== serialized) {
      throw new Error('federation message id is already used by another payload');
    }
  }
  return {
    messageId: signed.envelope.messageId,
    duplicate: Number(result.changes) === 0,
  };
}

export function queueFederationChatEnvelopeInRepository(
  store: FederationRepositoryStore,
  input: {
    ownerAccountId: string;
    contactId: string;
    signed: SignedFederationEnvelope;
  },
): { messageId: string; duplicate: boolean } {
  const contact = getFederationChatContactInRepository(store, {
    ownerAccountId: input.ownerAccountId,
    contactId: input.contactId,
  });
  if (!contact) throw new Error('federation contact was not found');
  const envelope = input.signed.envelope;
  if (
    envelope.type !== 'chat.message' ||
    envelope.senderDeploymentId !== store.deploymentId() ||
    envelope.recipientDeploymentId !== contact.remoteDeploymentId ||
    envelope.routing.senderPrincipalId !== input.ownerAccountId ||
    envelope.routing.recipientPrincipalId !== contact.remotePrincipalId
  ) {
    throw new Error('federation chat envelope does not match the contact');
  }
  const queued = queueFederationEnvelopeInRepository(store, input.signed);
  const now = store.now();
  store.db().prepare(
    `INSERT OR IGNORE INTO federation_chat_messages
      (message_id, contact_id, owner_account_id, direction,
       signed_envelope_json, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 'outbound', ?, ?, ?)`,
  ).run(
    envelope.messageId,
    input.contactId,
    input.ownerAccountId,
    JSON.stringify(input.signed),
    Date.parse(envelope.issuedAt),
    now,
  );
  return queued;
}

export function listDueFederationOutboxInRepository(
  store: FederationRepositoryStore,
  limit?: number,
): Array<{ signed: SignedFederationEnvelope; attempts: number }> {
  const now = store.now();
  store.db().prepare(
    `UPDATE federation_outbox SET status = 'expired', updated_at_ms = ?
     WHERE status IN ('queued', 'failed') AND expires_at_ms <= ?`,
  ).run(now, now);
  const rows = store.db().prepare(
    `SELECT message_id, signed_envelope_json, attempts, expires_at_ms
     FROM federation_outbox
     WHERE (status = 'queued' OR
            (status = 'failed' AND next_attempt_at_ms IS NOT NULL))
       AND expires_at_ms > ?
       AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
     ORDER BY created_at_ms, message_id LIMIT ?`,
  ).all(now, now, clampedLimit(limit, OUTBOX_BATCH_LIMIT)) as OutboxRow[];
  return rows.map((row) => ({
    signed: parseSignedEnvelope(row.signed_envelope_json),
    attempts: row.attempts,
  }));
}

export function markFederationOutboxSentInRepository(
  store: FederationRepositoryStore,
  messageId: string,
): void {
  const now = store.now();
  store.db().prepare(
    `UPDATE federation_outbox
     SET status = 'sent', sent_at_ms = ?, next_attempt_at_ms = NULL,
         last_error = NULL, updated_at_ms = ?
     WHERE message_id = ?`,
  ).run(now, now, messageId);
}

export function markFederationOutboxFailedInRepository(
  store: FederationRepositoryStore,
  input: {
    messageId: string;
    error: string;
    retryable: boolean;
    attempts: number;
  },
): void {
  const now = store.now();
  store.db().prepare(
    `UPDATE federation_outbox
     SET status = 'failed', attempts = attempts + 1,
         next_attempt_at_ms = ?, last_error = ?, updated_at_ms = ?
     WHERE message_id = ?`,
  ).run(
    input.retryable ? retryAt(now, input.attempts + 1) : null,
    input.error.slice(0, 1000),
    now,
    input.messageId,
  );
}

function inboundA2aRejectionReason(
  store: FederationRepositoryStore,
  signed: SignedFederationEnvelope,
): string | null {
  if (signed.envelope.type !== 'a2a.request') return null;
  const grantId = signed.envelope.routing.a2aGrantId;
  const scope = signed.envelope.routing.a2aScope;
  if (!grantId || !scope) return 'federated A2A request has no grant';
  const grant = store.db().prepare(
    `SELECT * FROM federation_a2a_grants WHERE grant_id = ?`,
  ).get(grantId) as GrantRow | undefined;
  if (
    !grant || grant.owner_deployment_id !== store.deploymentId() ||
    grant.requester_deployment_id !== signed.envelope.senderDeploymentId ||
    grant.owner_principal_id !== signed.envelope.routing.recipientPrincipalId ||
    grant.requester_principal_id !== signed.envelope.routing.senderPrincipalId ||
    grant.expires_at_ms <= store.now() || grant.revoked_at_ms !== null ||
    (grant.consumed_message_id !== null &&
      grant.consumed_message_id !== signed.envelope.messageId)
  ) {
    return 'federated A2A grant is invalid or already consumed';
  }
  const scopes = JSON.parse(grant.scopes_json) as unknown;
  if (!Array.isArray(scopes) || !scopes.includes(scope)) {
    return 'federated A2A scope is not authorized';
  }
  return null;
}

export function storeClaimedFederationEnvelopeInRepository(
  store: FederationRepositoryStore,
  claimed: ClaimedFederationEnvelope,
): { duplicate: boolean; discarded: boolean } {
  const { signed } = claimed;
  const database = store.db();
  const now = store.now();
  const blocked = Boolean(database.prepare(
    'SELECT 1 FROM federation_blocks WHERE blocked_deployment_id = ?',
  ).get(signed.envelope.senderDeploymentId));
  const rejectionReason = blocked
    ? 'sender deployment is locally blocked'
    : inboundA2aRejectionReason(store, signed);
  const discarded = rejectionReason !== null;
  const token = store.fieldCipher.encryptText(
    claimed.claimToken,
    claimContext(signed.envelope.messageId),
  );
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = database.prepare(
      `INSERT OR IGNORE INTO federation_inbox
        (message_id, sender_deployment_id, recipient_principal_id,
         sender_principal_id, conversation_id, message_type,
         signed_envelope_json, claim_token_ciphertext, claim_token_iv,
         claim_token_auth_tag, claim_token_key_version,
         gateway_acknowledged, discarded, received_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      signed.envelope.messageId,
      signed.envelope.senderDeploymentId,
      signed.envelope.routing.recipientPrincipalId,
      signed.envelope.routing.senderPrincipalId,
      signed.envelope.routing.conversationId,
      signed.envelope.type,
      JSON.stringify(signed),
      ...encryptedColumns(token),
      discarded ? 1 : 0,
      now,
      now,
    );
    const duplicate = Number(result.changes) === 0;
    if (duplicate) {
      database.prepare(
        `UPDATE federation_inbox
         SET claim_token_ciphertext = ?, claim_token_iv = ?,
             claim_token_auth_tag = ?, claim_token_key_version = ?,
             gateway_acknowledged = 0, updated_at_ms = ?
         WHERE message_id = ?`,
      ).run(...encryptedColumns(token), now, signed.envelope.messageId);
    } else if (!discarded && signed.envelope.type === 'a2a.request') {
      database.prepare(
        `UPDATE federation_a2a_grants
         SET consumed_message_id = ?, consumed_at_ms = ?
         WHERE grant_id = ? AND consumed_message_id IS NULL`,
      ).run(
        signed.envelope.messageId,
        now,
        signed.envelope.routing.a2aGrantId,
      );
    }
    if (!duplicate && !discarded && signed.envelope.type === 'chat.message') {
      const recipient = database.prepare(
        `SELECT id FROM accounts
         WHERE id = ? AND status = 'active' AND deleted_at IS NULL`,
      ).get(signed.envelope.routing.recipientPrincipalId) as
        | { id: string }
        | undefined;
      if (recipient) {
        const contactId = federationContactId(
          recipient.id,
          signed.envelope.senderDeploymentId,
          signed.envelope.routing.senderPrincipalId,
        );
        database.prepare(
          `INSERT INTO federation_chat_contacts
            (contact_id, owner_account_id, remote_deployment_id,
             remote_principal_id, display_name, deployment_display_name,
             created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner_account_id, remote_deployment_id, remote_principal_id)
           DO UPDATE SET updated_at_ms = excluded.updated_at_ms`,
        ).run(
          contactId,
          recipient.id,
          signed.envelope.senderDeploymentId,
          signed.envelope.routing.senderPrincipalId,
          signed.envelope.routing.senderPrincipalId,
          signed.envelope.senderDeploymentId,
          now,
          now,
        );
        database.prepare(
          `INSERT OR IGNORE INTO federation_chat_messages
            (message_id, contact_id, owner_account_id, direction,
             signed_envelope_json, received_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?)`,
        ).run(
          signed.envelope.messageId,
          contactId,
          recipient.id,
          JSON.stringify(signed),
          now,
          Date.parse(signed.envelope.issuedAt),
          now,
        );
      }
    }
    database.exec('COMMIT');
    if (rejectionReason) {
      setFederationRuntimeStateInRepository(store, 'last_rejected_inbound', {
        messageId: signed.envelope.messageId,
        senderDeploymentId: signed.envelope.senderDeploymentId,
        reason: rejectionReason,
        rejectedAt: new Date(now).toISOString(),
      });
    }
    return { duplicate, discarded };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original validation or storage error.
    }
    throw error;
  }
}

export function listFederationChatMessagesInRepository(
  store: FederationRepositoryStore,
  input: {
    ownerAccountId: string;
    contactId: string;
    afterSequence?: number;
    limit?: number;
  },
): FederationChatMessageView[] {
  const contact = getFederationChatContactInRepository(store, input);
  if (!contact) throw new Error('federation contact was not found');
  const after = Number.isFinite(input.afterSequence)
    ? Math.max(0, Math.floor(input.afterSequence!))
    : 0;
  const rows = store.db().prepare(
    `SELECT m.sequence, m.message_id, m.contact_id, m.direction,
            m.signed_envelope_json, m.received_at_ms, m.read_at_ms,
            m.created_at_ms, o.status AS outbox_status
     FROM federation_chat_messages m
     LEFT JOIN federation_outbox o ON o.message_id = m.message_id
     WHERE m.owner_account_id = ? AND m.contact_id = ? AND m.sequence > ?
     ORDER BY m.sequence LIMIT ?`,
  ).all(
    input.ownerAccountId,
    input.contactId,
    after,
    clampedLimit(input.limit, INBOX_BATCH_LIMIT),
  ) as ChatMessageRow[];
  return rows.map((row) => {
    const signed = parseSignedEnvelope(row.signed_envelope_json);
    return {
      cursor: row.sequence,
      messageId: row.message_id,
      contactId: row.contact_id,
      direction: row.direction,
      type: signed.envelope.type,
      senderDeploymentId: signed.envelope.senderDeploymentId,
      issuedAt: signed.envelope.issuedAt,
      expiresAt: signed.envelope.expiresAt,
      ciphertext: signed.envelope.ciphertext,
      routing: signed.envelope.routing,
      signingKeyId: signed.signingKeyId,
      signature: signed.signature,
      gatewayAcknowledged: row.direction === 'outbound' || (
        (store.db().prepare(
          `SELECT gateway_acknowledged FROM federation_inbox WHERE message_id = ?`,
        ).get(row.message_id) as { gateway_acknowledged: number } | undefined)
          ?.gateway_acknowledged === 1
      ),
      consumedAt: null,
      receivedAt: new Date(row.received_at_ms ?? row.created_at_ms).toISOString(),
      deliveryStatus: row.direction === 'inbound'
        ? 'received'
        : row.outbox_status ?? 'queued',
      readAt: row.read_at_ms === null
        ? null
        : new Date(row.read_at_ms).toISOString(),
    };
  });
}

export function markFederationChatMessageReadInRepository(
  store: FederationRepositoryStore,
  input: { ownerAccountId: string; contactId: string; messageId: string },
): boolean {
  const now = store.now();
  const result = store.db().prepare(
    `UPDATE federation_chat_messages
     SET read_at_ms = COALESCE(read_at_ms, ?), updated_at_ms = ?
     WHERE message_id = ? AND contact_id = ? AND owner_account_id = ?
       AND direction = 'inbound'`,
  ).run(now, now, input.messageId, input.contactId, input.ownerAccountId);
  if (Number(result.changes) > 0) {
    consumeFederationInboxInRepository(store, {
      recipientPrincipalId: input.ownerAccountId,
      messageId: input.messageId,
    });
  }
  return Number(result.changes) > 0;
}

export function listFederationAcknowledgementsInRepository(
  store: FederationRepositoryStore,
  limit?: number,
): Array<{ messageId: string; claimToken: string }> {
  const rows = store.db().prepare(
    `SELECT message_id, claim_token_ciphertext, claim_token_iv,
            claim_token_auth_tag, claim_token_key_version
     FROM federation_inbox
     WHERE gateway_acknowledged = 0 AND claim_token_ciphertext IS NOT NULL
     ORDER BY received_at_ms, cursor LIMIT ?`,
  ).all(clampedLimit(limit, OUTBOX_BATCH_LIMIT)) as InboxClaimRow[];
  return rows.map((row) => ({
    messageId: row.message_id,
    claimToken: decryptClaimToken(store, row),
  }));
}

export function markFederationAcknowledgedInRepository(
  store: FederationRepositoryStore,
  messageId: string,
): void {
  const now = store.now();
  store.db().prepare(
    `UPDATE federation_inbox
     SET gateway_acknowledged = 1, acknowledged_at_ms = ?,
         claim_token_ciphertext = NULL, claim_token_iv = NULL,
         claim_token_auth_tag = NULL, claim_token_key_version = NULL,
         updated_at_ms = ?
     WHERE message_id = ?`,
  ).run(now, now, messageId);
}

export function clearFederationClaimInRepository(
  store: FederationRepositoryStore,
  messageId: string,
): void {
  store.db().prepare(
    `UPDATE federation_inbox
     SET claim_token_ciphertext = NULL, claim_token_iv = NULL,
         claim_token_auth_tag = NULL, claim_token_key_version = NULL,
         updated_at_ms = ? WHERE message_id = ?`,
  ).run(store.now(), messageId);
}

export function listFederationInboxInRepository(
  store: FederationRepositoryStore,
  input: { recipientPrincipalId: string; afterCursor?: number; limit?: number },
): FederationInboxMessageView[] {
  const after = Number.isFinite(input.afterCursor)
    ? Math.max(0, Math.floor(input.afterCursor!))
    : 0;
  const rows = store.db().prepare(
    `SELECT cursor, message_id, signed_envelope_json, gateway_acknowledged,
            consumed_at_ms, received_at_ms
     FROM federation_inbox
     WHERE recipient_principal_id = ? AND cursor > ? AND discarded = 0
     ORDER BY cursor LIMIT ?`,
  ).all(
    input.recipientPrincipalId,
    after,
    clampedLimit(input.limit, INBOX_BATCH_LIMIT),
  ) as InboxRow[];
  return rows.map((row) => {
    const signed = parseSignedEnvelope(row.signed_envelope_json);
    return {
      cursor: row.cursor,
      messageId: row.message_id,
      type: signed.envelope.type,
      senderDeploymentId: signed.envelope.senderDeploymentId,
      issuedAt: signed.envelope.issuedAt,
      expiresAt: signed.envelope.expiresAt,
      ciphertext: signed.envelope.ciphertext,
      routing: signed.envelope.routing,
      signingKeyId: signed.signingKeyId,
      signature: signed.signature,
      gatewayAcknowledged: row.gateway_acknowledged === 1,
      consumedAt: row.consumed_at_ms === null
        ? null
        : new Date(row.consumed_at_ms).toISOString(),
      receivedAt: new Date(row.received_at_ms).toISOString(),
    };
  });
}

export function consumeFederationInboxInRepository(
  store: FederationRepositoryStore,
  input: { recipientPrincipalId: string; messageId: string },
): boolean {
  const result = store.db().prepare(
    `UPDATE federation_inbox
     SET consumed_at_ms = COALESCE(consumed_at_ms, ?), updated_at_ms = ?
     WHERE message_id = ? AND recipient_principal_id = ? AND discarded = 0`,
  ).run(store.now(), store.now(), input.messageId, input.recipientPrincipalId);
  return Number(result.changes) > 0;
}

export function saveFederationA2aGrantInRepository(
  store: FederationRepositoryStore,
  input: {
    grantId: string;
    requesterDeploymentId: string;
    ownerPrincipalId: string;
    requesterPrincipalId: string;
    scopes: string[];
    expiresAt: string;
  },
): void {
  store.db().prepare(
    `INSERT INTO federation_a2a_grants
      (grant_id, owner_deployment_id, requester_deployment_id,
       owner_principal_id, requester_principal_id, scopes_json,
       expires_at_ms, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(grant_id) DO UPDATE SET
       requester_deployment_id = excluded.requester_deployment_id,
       owner_principal_id = excluded.owner_principal_id,
       requester_principal_id = excluded.requester_principal_id,
       scopes_json = excluded.scopes_json,
       expires_at_ms = excluded.expires_at_ms`,
  ).run(
    input.grantId,
    store.deploymentId(),
    input.requesterDeploymentId,
    input.ownerPrincipalId,
    input.requesterPrincipalId,
    JSON.stringify([...new Set(input.scopes)].sort()),
    Date.parse(input.expiresAt),
    store.now(),
  );
}

export function revokeFederationA2aGrantInRepository(
  store: FederationRepositoryStore,
  grantId: string,
): void {
  store.db().prepare(
    `UPDATE federation_a2a_grants SET revoked_at_ms = ?
     WHERE grant_id = ? AND owner_deployment_id = ?`,
  ).run(store.now(), grantId, store.deploymentId());
}

export function blockFederationDeploymentInRepository(
  store: FederationRepositoryStore,
  input: { deploymentId: string; reason: string },
): void {
  store.db().prepare(
    `INSERT INTO federation_blocks
      (blocked_deployment_id, reason, created_at_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(blocked_deployment_id) DO UPDATE SET
       reason = excluded.reason, created_at_ms = excluded.created_at_ms`,
  ).run(input.deploymentId, input.reason, store.now());
}

export function unblockFederationDeploymentInRepository(
  store: FederationRepositoryStore,
  deploymentId: string,
): boolean {
  return Number(store.db().prepare(
    'DELETE FROM federation_blocks WHERE blocked_deployment_id = ?',
  ).run(deploymentId).changes) > 0;
}

export function listFederationBlocksInRepository(
  store: FederationRepositoryStore,
): Array<{ deploymentId: string; reason: string; createdAt: string }> {
  return (store.db().prepare(
    `SELECT blocked_deployment_id, reason, created_at_ms
     FROM federation_blocks ORDER BY created_at_ms DESC`,
  ).all() as Array<{
    blocked_deployment_id: string;
    reason: string;
    created_at_ms: number;
  }>).map((row) => ({
    deploymentId: row.blocked_deployment_id,
    reason: row.reason,
    createdAt: new Date(row.created_at_ms).toISOString(),
  }));
}

export function setFederationRuntimeStateInRepository(
  store: FederationRepositoryStore,
  key: string,
  value: unknown,
): void {
  store.db().prepare(
    `INSERT INTO federation_runtime_state (key, value, updated_at_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(key, JSON.stringify(value), store.now());
}

export function getFederationRuntimeStateInRepository(
  store: FederationRepositoryStore,
  key: string,
): unknown {
  const row = store.db().prepare(
    'SELECT value FROM federation_runtime_state WHERE key = ?',
  ).get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

export function getFederationQueueSummaryInRepository(
  store: FederationRepositoryStore,
): Record<string, number> {
  const outbox = store.db().prepare(
    `SELECT
       SUM(CASE WHEN status = 'queued' OR
         (status = 'failed' AND next_attempt_at_ms IS NOT NULL)
         THEN 1 ELSE 0 END) AS queued,
       SUM(CASE WHEN status = 'failed' AND next_attempt_at_ms IS NULL
         THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired
     FROM federation_outbox`,
  ).get() as {
    queued: number | null;
    failed: number | null;
    sent: number | null;
    expired: number | null;
  };
  const inbox = store.db().prepare(
    `SELECT
       SUM(CASE WHEN gateway_acknowledged = 0 THEN 1 ELSE 0 END) AS ack_pending,
       SUM(CASE WHEN consumed_at_ms IS NULL AND discarded = 0 THEN 1 ELSE 0 END) AS available,
       SUM(CASE WHEN discarded = 1 THEN 1 ELSE 0 END) AS discarded
     FROM federation_inbox`,
  ).get() as {
    ack_pending: number | null;
    available: number | null;
    discarded: number | null;
  };
  return {
    outboxQueued: Number(outbox.queued ?? 0),
    outboxFailed: Number(outbox.failed ?? 0),
    outboxSent: Number(outbox.sent ?? 0),
    outboxExpired: Number(outbox.expired ?? 0),
    inboxAcknowledgementPending: Number(inbox.ack_pending ?? 0),
    inboxAvailable: Number(inbox.available ?? 0),
    inboxDiscarded: Number(inbox.discarded ?? 0),
  };
}

export function isFederationMessageType(
  value: unknown,
): value is FederationMessageType {
  return value === 'chat.message' || value === 'chat.receipt' ||
    value === 'a2a.request' || value === 'a2a.response';
}
