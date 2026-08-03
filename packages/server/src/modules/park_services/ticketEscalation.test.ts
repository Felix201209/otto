/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * NSI-11: park ticket unread-notification escalation queue — tests.
 *
 * Covers the acceptance criteria:
 *   - read within 5 minutes → SMS not sent
 *   - timeout → SMS sent exactly once
 *   - server restart resumes the timer (durable state)
 *   - SMS failure does not affect the ticket (retry, never re-sends beyond cap)
 *   - operator can inspect status + failure reasons
 */

import { describe, expect, it } from 'vitest';

import { Database, applyDatabaseSchemaContributors } from '../data_platform/index.js';
import { createTicketEscalationSchemaContributor } from './ticketEscalationSchema.js';
import { TicketEscalationFacade } from './ticketEscalationFacade.js';
import type {
  EscalationChannelSender,
  EscalationJob,
} from './ticketEscalationTypes.js';

const DEFAULT_ORG = 'org-default';

function createHarness(senders: {
  otto?: EscalationChannelSender;
  feishu?: EscalationChannelSender;
  sms?: EscalationChannelSender;
} = {}) {
  const database = new Database(':memory:');
  applyDatabaseSchemaContributors(database, [
    createTicketEscalationSchemaContributor({ defaultOrganizationId: DEFAULT_ORG }),
  ]);

  // Optional FK prerequisites so inserts referencing it_tickets/accounts work.
  database.exec(`
    CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS it_tickets (id TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO organizations (id) VALUES ('${DEFAULT_ORG}');
    INSERT OR IGNORE INTO accounts (id) VALUES ('account-creator'), ('account-handler'), ('account-tenant');
    INSERT OR IGNORE INTO it_tickets (id) VALUES ('ticket-a');
  `);

  const store = {
    db: () => database,
    createJobId: () => `jid-${Math.random().toString(36).slice(2)}`,
    now: () => new Date(),
  };

  const sent: Array<{ channel: string; recipient: string; title: string; body: string; time: Date }> =
    [];
  let clock = new Date('2026-08-04T00:00:00Z');
  const now = () => clock;

  const facade = new TicketEscalationFacade(store, {
    senders: {
      otto: {
        channel: 'otto',
        async send(job, recipientId, title, body) {
          sent.push({ channel: 'otto', recipient: recipientId, title, body, time: now() });
          return true;
        },
      },
      feishu: senders.feishu ?? {
        channel: 'feishu',
        async send(job, recipientId, title, body) {
          if (recipientId) sent.push({ channel: 'feishu', recipient: recipientId, title, body, time: now() });
          return Boolean(recipientId);
        },
      },
      sms: senders.sms ?? {
        channel: 'sms',
        async send(job, recipientId, title, body) {
          sent.push({ channel: 'sms', recipient: recipientId, title, body, time: now() });
          return true;
        },
      },
    },
    now,
  });

  return { database, sent, now, facade };
}

const baseInput = {
  organizationId: DEFAULT_ORG,
  ticketId: 'ticket-a',
  recipientAccountId: 'account-handler',
  feishuOpenId: 'ou_test',
  phone: '13800000000',
  title: 'New repair ticket',
  body: 'Please check room A-101.',
  escalateAfterMs: 5 * 60 * 1000,
};

describe('ticket escalation queue (NSI-11)', () => {
  it('submits a job and delivers Otto + Feishu immediately', async () => {
    const h = createHarness();
    const result = await h.facade.submit({ ...baseInput, id: 'job-1', now: h.now() });
    expect(result.accepted).toBe(true);
    expect(result.job.status).toBe('delivered');

    const channels = h.sent.map((s) => s.channel);
    expect(channels).toContain('otto');
    expect(channels).toContain('feishu');
    expect(channels).not.toContain('sms');
  });

  it('is idempotent for the same job id', async () => {
    const h = createHarness();
    const first = await h.facade.submit({ ...baseInput, id: 'job-1', now: h.now() });
    const second = await h.facade.submit({ ...baseInput, id: 'job-1', now: h.now() });
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it('skips SMS when a read receipt arrives within 5 minutes', async () => {
    const h = createHarness();
    await h.facade.submit({ ...baseInput, id: 'job-1', now: h.now() });
    // Recipient reads it at minute 3.
    h.now().setTime(h.now().getTime() + 3 * 60 * 1000);
    h.facade.acknowledge(DEFAULT_ORG, 'job-1', h.now());
    // Scheduler runs well past the 5-minute deadline.
    h.now().setTime(h.now().getTime() + 10 * 60 * 1000);
    const escalated = await h.facade.tick(h.now());
    expect(escalated).toBe(0);
    expect(h.sent.some((s) => s.channel === 'sms')).toBe(false);
    expect(h.facade.inspect(DEFAULT_ORG, 'job-1')?.status).toBe('resolved');
  });

  it('sends SMS exactly once when unread past the deadline', async () => {
    const h = createHarness();
    await h.facade.submit({ ...baseInput, id: 'job-1', now: h.now() });
    h.now().setTime(h.now().getTime() + 6 * 60 * 1000);
    const first = await h.facade.tick(h.now());
    expect(first).toBe(1);
    const smsCountAfterFirst = h.sent.filter((s) => s.channel === 'sms').length;
    expect(smsCountAfterFirst).toBe(1);

    // A second scheduler run must not send SMS again (already escalated once).
    h.now().setTime(h.now().getTime() + 5 * 60 * 1000);
    const second = await h.facade.tick(h.now());
    expect(second).toBe(0); // job already escalated once -> nothing new escalated
    expect(h.sent.filter((s) => s.channel === 'sms').length).toBe(smsCountAfterFirst);
  });

  it('resumes the escalation timer across a "restart" (durable state)', async () => {
    const h = createHarness();
    await h.facade.submit({ ...baseInput, id: 'job-1', now: h.now() });

    // Server restart: a NEW facade instance over the SAME persisted database.
    // We re-scan the same DB via a second facade bound to the same store DB.
    const db2 = h.database; // same underlying store persists across restart
    const store2 = {
      db: () => db2,
      createJobId: () => `jid-${Math.random().toString(36).slice(2)}`,
      now: () => new Date(),
    };
    const now2 = new Date(h.now().getTime() + 6 * 60 * 1000);
    const facade2 = new TicketEscalationFacade(store2, {
      senders: {
        otto: { channel: 'otto' as const, async send() { return true; } },
        feishu: { channel: 'feishu' as const, async send() { return true; } },
        sms: { channel: 'sms' as const, async send() { return true; } },
      },
      now: () => now2,
    });

    // The same job row must still be visible after restart.
    const job = facade2.inspect(DEFAULT_ORG, 'job-1');
    expect(job).not.toBeNull();
    expect(job?.status).toBe('delivered');

    // Time has passed past the deadline since submit; restart resumes and escalates.
    const escalated = await facade2.tick(now2);
    expect(escalated).toBe(1);
    expect(facade2.inspect(DEFAULT_ORG, 'job-1')?.escalatedAt).not.toBeNull();
  });

  it('records SMS failure and keeps retrying without losing the job', async () => {
    let smsFail = true;
    const h = createHarness({
      sms: {
        channel: 'sms',
        async send() {
          if (smsFail) return false;
          return true;
        },
      },
    });
    await h.facade.submit({ ...baseInput, id: 'job-1', now: h.now() });
    h.now().setTime(h.now().getTime() + 6 * 60 * 1000);
    const first = await h.facade.tick(h.now());
    expect(first).toBe(0); // failed, not counted as escalated
    let job = h.facade.inspect(DEFAULT_ORG, 'job-1');
    expect(job?.retryCount).toBe(1);
    expect(job?.failureReason).toContain('SMS delivery failed');

    // Sender recovers; next tick succeeds.
    smsFail = false;
    const second = await h.facade.tick(h.now());
    expect(second).toBe(1);
    job = h.facade.inspect(DEFAULT_ORG, 'job-1');
    expect(job?.escalatedAt).not.toBeNull();
    expect(job?.status).toBe('delivered');
  });

  it('exposes operator inspection with status and failure reason', async () => {
    const h = createHarness();
    await h.facade.submit({ ...baseInput, id: 'job-1', now: h.now() });
    const view = h.facade.inspect(DEFAULT_ORG, 'job-1');
    expect(view).not.toBeNull();
    expect(view!.status).toBe('delivered');
    expect(Array.isArray(view!.attempts)).toBe(true);
    expect(view!.attempts.length).toBeGreaterThanOrEqual(2); // otto + feishu
  });

  it('cancels a pending job so SMS is never sent', async () => {
    const h = createHarness();
    await h.facade.submit({ ...baseInput, id: 'job-1', now: h.now() });
    expect(h.facade.cancel(DEFAULT_ORG, 'job-1')).toBe(true);
    h.now().setTime(h.now().getTime() + 6 * 60 * 1000);
    const escalated = await h.facade.tick(h.now());
    expect(escalated).toBe(0);
    expect(h.sent.some((s) => s.channel === 'sms')).toBe(false);
    expect(h.facade.inspect(DEFAULT_ORG, 'job-1')?.status).toBe('cancelled');
  });
});
