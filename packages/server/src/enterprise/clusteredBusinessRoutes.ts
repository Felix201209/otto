/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { assertEnterpriseSkillContentSafe } from '../modules/enterprise_skill_market/index.js';
import {
  MODULE_UPDATE_ROLLOUTS,
  MODULE_UPDATE_SHA256_RE,
  licenseModuleCatalog,
  parsePublicKeyList,
  verifyEd25519Envelope,
  type ClusteredLicenseSummary,
} from '../modules/commercial_control/index.js';
import {
  ACCOUNT_SYNC_SCOPES,
  AccountSyncConflictError,
  type AccountSyncScope,
} from '../modules/personal_intelligence/index.js';
import type {
  PostgresBusinessRecord,
  PostgresEnterpriseBusinessRepository,
} from './postgresBusinessRepository.js';
import type { OrganizationFeatureKey } from '../productModules.js';
import type {
  PostgresEnterpriseAccountView,
  PostgresEnterpriseCoreRepository,
} from './postgresCoreRepository.js';

type BusinessRepository = Pick<
  PostgresEnterpriseBusinessRepository,
  | 'listAccountSyncSnapshots'
  | 'putAccountSyncSnapshot'
  | 'listBusinessRecords'
  | 'getBusinessRecord'
  | 'createBusinessRecord'
  | 'updateBusinessRecord'
  | 'appendBusinessEvent'
  | 'listBusinessEvents'
  | 'findActiveParkInvite'
  | 'listParkTenantMemberships'
  | 'listTicketRecordsForAccount'
  | 'listAddressedBusinessRecords'
> &
  Pick<
    PostgresEnterpriseCoreRepository,
    | 'getOrganizationFeatures'
    | 'getOrganization'
    | 'getAccount'
    | 'listAccounts'
  >;

export interface ClusteredBusinessRouteInput {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  member: PostgresEnterpriseAccountView;
  repository: BusinessRepository;
  readBody(
    req: IncomingMessage,
    maxLength?: number,
  ): Promise<Record<string, unknown>>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  requireCommercialFeature(feature: OrganizationFeatureKey): Promise<boolean>;
  commercialFeatureAvailable(feature: OrganizationFeatureKey): Promise<boolean>;
  commercialLicenseSummary(): Promise<ClusteredLicenseSummary>;
}

type KnowledgePayload = {
  title: string | null;
  department: string | null;
  category: string;
  content: string;
  tags: string[];
  contributor: string;
  contributorAccountId: string;
  confidence: number;
  sourceType: string;
  sourceId: string | null;
  sourceLabel: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
};

type SkillPayload = {
  slug: string;
  name: string;
  description: string;
  department: string | null;
  visibility: 'department' | 'company';
  authorAccountId: string;
  authorName: string;
  content: string;
  contentHash: string;
  installCount: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  ratingTotal: number;
  ratingCount: number;
  reviewedBy: string | null;
  reviewedAt: string | null;
};

function text(
  value: unknown,
  label: string,
  maximum: number,
  required = true,
): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  return normalized;
}

function knowledgeView(record: PostgresBusinessRecord<KnowledgePayload>) {
  return {
    id: record.resourceId,
    organizationId: record.organizationId,
    ...record.payload,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function skillView(
  record: PostgresBusinessRecord<SkillPayload>,
  options: { includeContent?: boolean; installedVersion?: number | null } = {},
) {
  const { content, ratingTotal: _ratingTotal, ...payload } = record.payload;
  return {
    id: record.resourceId,
    organizationId: record.organizationId,
    ...payload,
    status: record.status,
    version: record.version,
    rating:
      record.payload.ratingCount > 0
        ? record.payload.ratingTotal / record.payload.ratingCount
        : 0,
    installedVersion: options.installedVersion ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(options.includeContent ? { content } : {}),
  };
}

async function requireFeature(
  input: ClusteredBusinessRouteInput,
  feature: 'knowledge' | 'skill_market',
): Promise<boolean> {
  const features = await input.repository.getOrganizationFeatures(
    input.member.organizationId,
  );
  if (features[feature]) return true;
  input.sendJson(input.res, 403, {
    error:
      feature === 'knowledge'
        ? 'enterprise knowledge is disabled'
        : 'enterprise skill marketplace is disabled',
  });
  return false;
}

async function updateRecordWithRetry<T extends Record<string, unknown>>(
  repository: BusinessRepository,
  identity: {
    organizationId: string;
    domain:
      | 'knowledge'
      | 'skills'
      | 'park'
      | 'ticketing'
      | 'commercial_control'
      | 'data_governance';
    resourceType: string;
    resourceId: string;
  },
  update: (current: PostgresBusinessRecord<T>) => {
    status: string;
    payload: T;
  },
): Promise<PostgresBusinessRecord<T> | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await repository.getBusinessRecord<T>(identity);
    if (!current) return null;
    const next = update(current);
    const saved = await repository.updateBusinessRecord({
      ...identity,
      expectedVersion: current.version,
      status: next.status,
      payload: next.payload,
    });
    if (saved) return saved;
  }
  throw new Error('business record changed concurrently');
}

async function handleAccountSync(
  input: ClusteredBusinessRouteInput,
): Promise<boolean> {
  if (input.path !== '/enterprise/account-sync') return false;
  input.res.setHeader('Cache-Control', 'no-store');
  if (input.method === 'GET') {
    input.sendJson(input.res, 200, {
      snapshots: await input.repository.listAccountSyncSnapshots({
        organizationId: input.member.organizationId,
        accountId: input.member.id,
      }),
    });
    return true;
  }
  if (input.method !== 'PUT') {
    input.sendJson(input.res, 405, { error: 'method not allowed' });
    return true;
  }
  const body = await input.readBody(input.req, 12 * 1024 * 1024);
  const scope = typeof body.scope === 'string' ? body.scope : '';
  if (!(ACCOUNT_SYNC_SCOPES as readonly string[]).includes(scope)) {
    input.sendJson(input.res, 400, { error: 'account sync scope is invalid' });
    return true;
  }
  try {
    const snapshot = await input.repository.putAccountSyncSnapshot({
      organizationId: input.member.organizationId,
      accountId: input.member.id,
      scope: scope as AccountSyncScope,
      expectedVersion: Number(body.expectedVersion),
      payload: body.payload,
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : null,
    });
    input.sendJson(input.res, 200, { snapshot });
  } catch (error) {
    if (error instanceof AccountSyncConflictError) {
      input.sendJson(input.res, 409, {
        error: error.message,
        currentVersion: error.currentVersion,
      });
    } else {
      input.sendJson(input.res, 400, {
        error: error instanceof Error ? error.message : 'account sync failed',
      });
    }
  }
  return true;
}

async function handleKnowledge(
  input: ClusteredBusinessRouteInput,
): Promise<boolean> {
  if (
    input.path !== '/enterprise/knowledge' &&
    !input.path.startsWith('/enterprise/knowledge/')
  ) {
    return false;
  }
  if (!(await requireFeature(input, 'knowledge'))) return true;
  const organizationId = input.member.organizationId;

  if (input.path === '/enterprise/knowledge' && input.method === 'GET') {
    const includeReview =
      input.url.searchParams.get('includeReview') === 'true';
    const requestedDepartment =
      input.url.searchParams.get('department')?.trim() || null;
    if (
      !input.member.isAdmin &&
      requestedDepartment &&
      requestedDepartment !== input.member.department
    ) {
      input.sendJson(input.res, 403, {
        error: 'cannot read another department knowledge',
      });
      return true;
    }
    const query = (input.url.searchParams.get('q') || '').trim().toLowerCase();
    const requestedStatus = input.url.searchParams.get('status');
    const records =
      await input.repository.listBusinessRecords<KnowledgePayload>({
        organizationId,
        domain: 'knowledge',
        resourceType: 'entry',
        statuses:
          input.member.isAdmin && includeReview && requestedStatus
            ? [requestedStatus]
            : input.member.isAdmin && includeReview
              ? []
              : ['active'],
        limit: 500,
      });
    const visible = records.filter((record) => {
      const entry = record.payload;
      if (
        !input.member.isAdmin &&
        entry.department &&
        entry.department !== input.member.department
      ) {
        return includeReview && entry.contributorAccountId === input.member.id;
      }
      if (requestedDepartment && entry.department !== requestedDepartment)
        return false;
      if (!query) return true;
      return [entry.title, entry.category, entry.content, entry.sourceLabel]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
    input.sendJson(input.res, 200, {
      knowledge: visible.map(knowledgeView),
    });
    return true;
  }

  if (input.path === '/enterprise/knowledge' && input.method === 'POST') {
    const body = await input.readBody(input.req);
    const content = text(body.content, 'content', 20_000)!;
    const confidence =
      typeof body.confidence === 'number' &&
      Number.isFinite(body.confidence) &&
      body.confidence >= 0 &&
      body.confidence <= 1
        ? body.confidence
        : 0.5;
    const sourceType =
      typeof body.sourceType === 'string'
        ? body.sourceType.trim().slice(0, 80) || 'manual'
        : 'manual';
    const status =
      input.member.isAdmin && sourceType === 'manual'
        ? 'active'
        : 'pending_review';
    const record =
      await input.repository.createBusinessRecord<KnowledgePayload>({
        organizationId,
        domain: 'knowledge',
        resourceType: 'entry',
        ownerAccountId: input.member.id,
        status,
        payload: {
          title: text(body.title, 'title', 300, false),
          department:
            input.member.isAdmin && typeof body.department === 'string'
              ? text(body.department, 'department', 160, false)
              : input.member.department,
          category: text(body.category ?? 'general', 'category', 120)!,
          content,
          tags: Array.isArray(body.tags)
            ? body.tags
                .filter((tag): tag is string => typeof tag === 'string')
                .map((tag) => tag.trim())
                .filter(Boolean)
                .slice(0, 50)
            : [],
          contributor: input.member.name,
          contributorAccountId: input.member.id,
          confidence,
          sourceType,
          sourceId: text(body.sourceId, 'source id', 200, false),
          sourceLabel: text(body.sourceLabel, 'source label', 300, false),
          reviewedBy: status === 'active' ? input.member.name : null,
          reviewedAt: status === 'active' ? new Date().toISOString() : null,
          reviewNote: null,
        },
      });
    input.sendJson(input.res, 200, {
      status: 'added',
      added: true,
      outcome: 'inserted',
      reviewStatus: record.status,
      knowledgeId: record.resourceId,
    });
    return true;
  }

  const review = /^\/enterprise\/knowledge\/([^/]+)\/review$/u.exec(input.path);
  if (review && input.method === 'POST') {
    if (!input.member.isAdmin) {
      input.sendJson(input.res, 403, {
        error: 'administrator permission required',
      });
      return true;
    }
    const body = await input.readBody(input.req);
    if (body.action !== 'approve' && body.action !== 'archive') {
      input.sendJson(input.res, 400, {
        error: 'action must be approve or archive',
      });
      return true;
    }
    const saved = await updateRecordWithRetry<KnowledgePayload>(
      input.repository,
      {
        organizationId,
        domain: 'knowledge',
        resourceType: 'entry',
        resourceId: decodeURIComponent(review[1]!),
      },
      (current) => ({
        status: body.action === 'approve' ? 'active' : 'archived',
        payload: {
          ...current.payload,
          reviewedBy: input.member.name,
          reviewedAt: new Date().toISOString(),
          reviewNote: text(body.note, 'review note', 1_000, false),
        },
      }),
    );
    input.sendJson(
      input.res,
      saved ? 200 : 404,
      saved
        ? { knowledge: knowledgeView(saved) }
        : { error: 'knowledge not found' },
    );
    return true;
  }

  const revisions = /^\/enterprise\/knowledge\/([^/]+)\/revisions$/u.exec(
    input.path,
  );
  if (revisions && input.method === 'GET') {
    if (!input.member.isAdmin) {
      input.sendJson(input.res, 403, {
        error: 'administrator permission required',
      });
      return true;
    }
    input.sendJson(input.res, 200, {
      revisions: await input.repository.listBusinessEvents({
        organizationId,
        domain: 'knowledge',
        resourceType: 'entry',
        resourceId: decodeURIComponent(revisions[1]!),
        limit: 500,
      }),
    });
    return true;
  }

  const entry = /^\/enterprise\/knowledge\/([^/]+)$/u.exec(input.path);
  if (entry && input.method === 'PATCH') {
    if (!input.member.isAdmin) {
      input.sendJson(input.res, 403, {
        error: 'administrator permission required',
      });
      return true;
    }
    const resourceId = decodeURIComponent(entry[1]!);
    const body = await input.readBody(input.req);
    const before = await input.repository.getBusinessRecord<KnowledgePayload>({
      organizationId,
      domain: 'knowledge',
      resourceType: 'entry',
      resourceId,
    });
    if (!before) {
      input.sendJson(input.res, 404, { error: 'knowledge not found' });
      return true;
    }
    const saved = await updateRecordWithRetry<KnowledgePayload>(
      input.repository,
      {
        organizationId,
        domain: 'knowledge',
        resourceType: 'entry',
        resourceId,
      },
      (current) => ({
        status: current.status,
        payload: {
          ...current.payload,
          title:
            body.title === undefined
              ? current.payload.title
              : text(body.title, 'title', 300, false),
          category:
            body.category === undefined
              ? current.payload.category
              : text(body.category, 'category', 120)!,
          content:
            body.content === undefined
              ? current.payload.content
              : text(body.content, 'content', 20_000)!,
          confidence:
            typeof body.confidence === 'number'
              ? Math.min(1, Math.max(0, body.confidence))
              : current.payload.confidence,
          sourceLabel:
            body.sourceLabel === undefined
              ? current.payload.sourceLabel
              : text(body.sourceLabel, 'source label', 300, false),
        },
      }),
    );
    if (!saved) throw new Error('business record changed concurrently');
    await input.repository.appendBusinessEvent({
      organizationId,
      domain: 'knowledge',
      resourceType: 'entry',
      resourceId,
      actorAccountId: input.member.id,
      eventType: 'revised',
      payload: {
        fromVersion: before.version,
        toVersion: saved.version,
        changeNote: text(body.changeNote, 'change note', 1_000, false),
        previous: before.payload,
      },
    });
    input.sendJson(input.res, 200, { knowledge: knowledgeView(saved) });
    return true;
  }

  input.sendJson(input.res, 404, { error: 'knowledge route not found' });
  return true;
}

function skillSlug(name: string, requested: unknown): string {
  const source =
    typeof requested === 'string' && requested.trim() ? requested : name;
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60);
  return (
    normalized ||
    `shared-skill-${createHash('sha256').update(name).digest('hex').slice(0, 10)}`
  );
}

async function handleSkills(
  input: ClusteredBusinessRouteInput,
): Promise<boolean> {
  if (
    input.path !== '/enterprise/skills' &&
    !input.path.startsWith('/enterprise/skills/')
  ) {
    return false;
  }
  if (!(await requireFeature(input, 'skill_market'))) return true;
  const organizationId = input.member.organizationId;

  if (input.path === '/enterprise/skills' && input.method === 'GET') {
    const scope = input.url.searchParams.get('scope') || 'department';
    const query = (input.url.searchParams.get('q') || '').trim().toLowerCase();
    const records = await input.repository.listBusinessRecords<SkillPayload>({
      organizationId,
      domain: 'skills',
      resourceType: 'skill',
      statuses: scope === 'review' && input.member.isAdmin ? [] : ['active'],
      limit: 500,
    });
    const skills = records
      .filter((record) => {
        const skill = record.payload;
        if (scope === 'mine') return skill.authorAccountId === input.member.id;
        if (scope === 'review') return input.member.isAdmin;
        if (
          skill.visibility === 'department' &&
          skill.department !== input.member.department
        ) {
          return false;
        }
        if (!query) return true;
        return [skill.name, skill.description, skill.slug].some((value) =>
          value.toLowerCase().includes(query),
        );
      })
      .map((record) => skillView(record));
    const sort = input.url.searchParams.get('sort');
    skills.sort((left, right) => {
      if (sort === 'rating') return right.rating - left.rating;
      if (sort === 'installs') return right.installCount - left.installCount;
      if (sort === 'usage') return right.usageCount - left.usageCount;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
    input.sendJson(input.res, 200, { skills });
    return true;
  }

  if (input.path === '/enterprise/skills' && input.method === 'POST') {
    const body = await input.readBody(input.req, 400_000);
    const name = text(body.name, 'skill name', 100)!;
    const description = text(body.description, 'skill description', 1_000)!;
    const content = text(body.content, 'skill content', 200_000)!;
    assertEnterpriseSkillContentSafe(content);
    const slug = skillSlug(name, body.slug);
    const visibility = body.visibility === 'company' ? 'company' : 'department';
    const record = await input.repository.createBusinessRecord<SkillPayload>({
      organizationId,
      domain: 'skills',
      resourceType: 'skill',
      resourceId: `skill_${createHash('sha256')
        .update(`${organizationId}\0${slug}`)
        .digest('hex')
        .slice(0, 32)}`,
      ownerAccountId: input.member.id,
      status: input.member.isAdmin ? 'active' : 'pending_review',
      payload: {
        slug,
        name,
        description,
        department: input.member.department,
        visibility,
        authorAccountId: input.member.id,
        authorName: input.member.name,
        content,
        contentHash: createHash('sha256').update(content).digest('hex'),
        installCount: 0,
        usageCount: 0,
        successCount: 0,
        failureCount: 0,
        ratingTotal: 0,
        ratingCount: 0,
        reviewedBy: input.member.isAdmin ? input.member.name : null,
        reviewedAt: input.member.isAdmin ? new Date().toISOString() : null,
      },
    });
    input.sendJson(input.res, 201, {
      outcome: 'submitted',
      skill: skillView(record),
    });
    return true;
  }

  if (
    input.path === '/enterprise/skills/leaderboard' &&
    input.method === 'GET'
  ) {
    const records = await input.repository.listBusinessRecords<SkillPayload>({
      organizationId,
      domain: 'skills',
      resourceType: 'skill',
      statuses: ['active'],
      limit: 500,
    });
    const ranked = records
      .map((record) => skillView(record))
      .sort(
        (left, right) =>
          right.installCount +
          right.usageCount -
          (left.installCount + left.usageCount),
      )
      .slice(0, 100)
      .map((skill, index) => ({
        ...skill,
        rank: index + 1,
        score: skill.installCount + skill.usageCount,
        successRate:
          skill.usageCount > 0 ? skill.successCount / skill.usageCount : 0,
      }));
    input.sendJson(input.res, 200, {
      skills: ranked,
      contributors: [],
      generatedAt: new Date().toISOString(),
    });
    return true;
  }

  const actionRoute =
    /^\/enterprise\/skills\/([A-Za-z0-9_-]{1,120})\/(review|install|rating|usage)$/u.exec(
      input.path,
    );
  if (!actionRoute) {
    input.sendJson(input.res, 404, { error: 'skill route not found' });
    return true;
  }
  if (input.method !== 'POST') {
    input.sendJson(input.res, 405, { error: 'method not allowed' });
    return true;
  }
  const resourceId = actionRoute[1]!;
  const action = actionRoute[2]!;
  const identity = {
    organizationId,
    domain: 'skills' as const,
    resourceType: 'skill',
    resourceId,
  };
  const current =
    await input.repository.getBusinessRecord<SkillPayload>(identity);
  if (!current) {
    input.sendJson(input.res, 404, { error: 'skill not found' });
    return true;
  }

  if (action === 'review') {
    if (!input.member.isAdmin) {
      input.sendJson(input.res, 403, {
        error: 'administrator permission required',
      });
      return true;
    }
    const body = await input.readBody(input.req);
    if (body.action !== 'approve' && body.action !== 'archive') {
      input.sendJson(input.res, 400, {
        error: 'action must be approve or archive',
      });
      return true;
    }
    const saved = await updateRecordWithRetry<SkillPayload>(
      input.repository,
      identity,
      (record) => ({
        status: body.action === 'approve' ? 'active' : 'archived',
        payload: {
          ...record.payload,
          visibility:
            body.visibility === 'company' || body.visibility === 'department'
              ? body.visibility
              : record.payload.visibility,
          reviewedBy: input.member.name,
          reviewedAt: new Date().toISOString(),
        },
      }),
    );
    input.sendJson(input.res, 200, { skill: skillView(saved!) });
    return true;
  }

  if (current.status !== 'active') {
    input.sendJson(input.res, 403, { error: 'skill is not active' });
    return true;
  }
  if (
    current.payload.visibility === 'department' &&
    current.payload.department !== input.member.department
  ) {
    input.sendJson(input.res, 403, {
      error: 'skill is outside your department',
    });
    return true;
  }

  const body = await input.readBody(input.req);
  if (action === 'install') {
    const event = await input.repository.appendBusinessEvent({
      ...identity,
      eventId: `install:${input.member.id}:${resourceId}`,
      actorAccountId: input.member.id,
      eventType: 'installed',
      payload: { version: current.version },
    });
    const saved = event.inserted
      ? await updateRecordWithRetry<SkillPayload>(
          input.repository,
          identity,
          (record) => ({
            status: record.status,
            payload: {
              ...record.payload,
              installCount: record.payload.installCount + 1,
            },
          }),
        )
      : current;
    input.sendJson(input.res, 200, {
      skill: skillView(saved!, {
        includeContent: true,
        installedVersion: saved!.version,
      }),
    });
    return true;
  }

  if (action === 'rating') {
    const score = Number(body.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      input.sendJson(input.res, 400, { error: 'rating must be 1 to 5' });
      return true;
    }
    await input.repository.appendBusinessEvent({
      ...identity,
      eventId: `rating:${input.member.id}:${resourceId}:${randomUUID()}`,
      actorAccountId: input.member.id,
      eventType: 'rated',
      payload: { score },
    });
    const saved = await updateRecordWithRetry<SkillPayload>(
      input.repository,
      identity,
      (record) => ({
        status: record.status,
        payload: {
          ...record.payload,
          ratingTotal: record.payload.ratingTotal + score,
          ratingCount: record.payload.ratingCount + 1,
        },
      }),
    );
    input.sendJson(input.res, 200, { skill: skillView(saved!) });
    return true;
  }

  if (typeof body.success !== 'boolean' || typeof body.eventId !== 'string') {
    input.sendJson(input.res, 400, {
      error: 'usage requires success and eventId',
    });
    return true;
  }
  const event = await input.repository.appendBusinessEvent({
    ...identity,
    eventId: `usage:${body.eventId}`,
    actorAccountId: input.member.id,
    eventType: 'used',
    payload: { success: body.success },
  });
  const saved = event.inserted
    ? await updateRecordWithRetry<SkillPayload>(
        input.repository,
        identity,
        (record) => ({
          status: record.status,
          payload: {
            ...record.payload,
            usageCount: record.payload.usageCount + 1,
            successCount:
              record.payload.successCount + (body.success === true ? 1 : 0),
            failureCount:
              record.payload.failureCount + (body.success === false ? 1 : 0),
          },
        }),
      )
    : current;
  input.sendJson(input.res, 200, { skill: skillView(saved!) });
  return true;
}

type ParkPayload = {
  name: string;
  address: string | null;
  adminOrganizationId: string;
};

type ParkMembershipPayload = {
  parkId: string;
  adminOrganizationId: string;
  address: string | null;
  roomNumber: string | null;
  joinedAt: string;
};

async function parkAuthority(input: ClusteredBusinessRouteInput): Promise<{
  park: PostgresBusinessRecord<ParkPayload> | null;
  membership: PostgresBusinessRecord<ParkMembershipPayload> | null;
  resourceOrganizationId: string;
}> {
  const organizationId = input.member.organizationId;
  const ownPark = await input.repository.getBusinessRecord<ParkPayload>({
    organizationId,
    domain: 'park',
    resourceType: 'park',
    resourceId: `park_${organizationId}`,
  });
  if (ownPark) {
    return {
      park: ownPark,
      membership: null,
      resourceOrganizationId: organizationId,
    };
  }
  const membership =
    await input.repository.getBusinessRecord<ParkMembershipPayload>({
      organizationId,
      domain: 'park',
      resourceType: 'membership',
      resourceId: `membership_${organizationId}`,
    });
  if (!membership || membership.status !== 'active') {
    return {
      park: null,
      membership: null,
      resourceOrganizationId: organizationId,
    };
  }
  const park = await input.repository.getBusinessRecord<ParkPayload>({
    organizationId: membership.payload.adminOrganizationId,
    domain: 'park',
    resourceType: 'park',
    resourceId: membership.payload.parkId,
  });
  return {
    park,
    membership,
    resourceOrganizationId: membership.payload.adminOrganizationId,
  };
}

function parkView(record: PostgresBusinessRecord<ParkPayload>) {
  return {
    id: record.resourceId,
    ...record.payload,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function recordPayloadView<T extends Record<string, unknown>>(
  record: PostgresBusinessRecord<T>,
) {
  return {
    id: record.resourceId,
    ...record.payload,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function handlePark(
  input: ClusteredBusinessRouteInput,
): Promise<boolean> {
  const isParkRoute =
    input.path === '/enterprise/park' ||
    input.path.startsWith('/enterprise/park/') ||
    input.path.startsWith('/enterprise/park-');
  if (!isParkRoute) return false;
  const features = await input.repository.getOrganizationFeatures(
    input.member.organizationId,
  );
  if (!features.park_services) {
    input.sendJson(input.res, 403, { error: 'park services are disabled' });
    return true;
  }
  const organizationId = input.member.organizationId;

  if (
    (input.path === '/enterprise/park' ||
      input.path === '/enterprise/park/manage') &&
    (input.method === 'GET' || input.method === 'POST')
  ) {
    let authority = await parkAuthority(input);
    if (input.method === 'POST' && !authority.park) {
      if (!input.member.isAdmin) {
        input.sendJson(input.res, 403, {
          error: 'administrator permission required',
        });
        return true;
      }
      const body = await input.readBody(input.req);
      const organization =
        await input.repository.getOrganization(organizationId);
      const park = await input.repository.createBusinessRecord<ParkPayload>({
        organizationId,
        domain: 'park',
        resourceType: 'park',
        resourceId: `park_${organizationId}`,
        ownerAccountId: input.member.id,
        payload: {
          name: text(
            body.name ?? `${organization?.name ?? 'Otto'} Park`,
            'park name',
            160,
          )!,
          address: text(body.address, 'park address', 500, false),
          adminOrganizationId: organizationId,
        },
      });
      authority = {
        park,
        membership: null,
        resourceOrganizationId: organizationId,
      };
    }
    input.sendJson(input.res, 200, {
      park: authority.park ? parkView(authority.park) : null,
    });
    return true;
  }

  if (input.path === '/enterprise/park/invite' && input.method === 'POST') {
    const authority = await parkAuthority(input);
    if (
      !input.member.isAdmin ||
      !authority.park ||
      authority.park.payload.adminOrganizationId !== organizationId
    ) {
      input.sendJson(input.res, 403, { error: 'park administrator required' });
      return true;
    }
    const body = await input.readBody(input.req);
    const code = randomBytes(12).toString('base64url').toUpperCase();
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const maxUses = Math.min(
      10_000,
      Math.max(1, Math.floor(Number(body.maxUses ?? 1))),
    );
    const invite = await input.repository.createBusinessRecord({
      organizationId,
      domain: 'park',
      resourceType: 'invite',
      ownerAccountId: input.member.id,
      payload: {
        parkId: authority.park.resourceId,
        adminOrganizationId: organizationId,
        codeSha256: createHash('sha256').update(code).digest('hex'),
        maxUses,
        usedCount: 0,
        expiresAt,
      },
    });
    input.sendJson(input.res, 201, {
      invite: {
        id: invite.resourceId,
        code,
        maxUses,
        usedCount: 0,
        expiresAt,
      },
    });
    return true;
  }

  if (input.path === '/enterprise/park/join' && input.method === 'POST') {
    if (!input.member.isAdmin) {
      input.sendJson(input.res, 403, {
        error: 'administrator permission required',
      });
      return true;
    }
    const body = await input.readBody(input.req);
    const code = text(body.inviteCode, 'park invitation', 200)!;
    const invite = await input.repository.findActiveParkInvite<{
      parkId: string;
      adminOrganizationId: string;
      codeSha256: string;
      maxUses: number;
      usedCount: number;
      expiresAt: string;
    }>(createHash('sha256').update(code).digest('hex'));
    if (!invite || invite.payload.usedCount >= invite.payload.maxUses) {
      input.sendJson(input.res, 403, {
        error: 'park invitation is unavailable',
      });
      return true;
    }
    const existing =
      await input.repository.getBusinessRecord<ParkMembershipPayload>({
        organizationId,
        domain: 'park',
        resourceType: 'membership',
        resourceId: `membership_${organizationId}`,
      });
    if (existing?.status === 'active') {
      input.sendJson(input.res, 409, {
        error: 'organization already joined a park',
      });
      return true;
    }
    const membership =
      await input.repository.createBusinessRecord<ParkMembershipPayload>({
        organizationId,
        domain: 'park',
        resourceType: 'membership',
        resourceId: `membership_${organizationId}`,
        ownerAccountId: input.member.id,
        payload: {
          parkId: invite.payload.parkId,
          adminOrganizationId: invite.payload.adminOrganizationId,
          address: text(body.address, 'tenant address', 500, false),
          roomNumber: text(body.roomNumber, 'room number', 120, false),
          joinedAt: new Date().toISOString(),
        },
      });
    await input.repository.updateBusinessRecord({
      organizationId: invite.organizationId,
      domain: 'park',
      resourceType: 'invite',
      resourceId: invite.resourceId,
      expectedVersion: invite.version,
      status:
        invite.payload.usedCount + 1 >= invite.payload.maxUses
          ? 'consumed'
          : 'active',
      payload: {
        ...invite.payload,
        usedCount: invite.payload.usedCount + 1,
      },
    });
    const park = await input.repository.getBusinessRecord<ParkPayload>({
      organizationId: membership.payload.adminOrganizationId,
      domain: 'park',
      resourceType: 'park',
      resourceId: membership.payload.parkId,
    });
    input.sendJson(input.res, 200, {
      park: park ? parkView(park) : null,
      profile: recordPayloadView(membership),
    });
    return true;
  }

  if (input.path === '/enterprise/park/profile' && input.method === 'PATCH') {
    if (!input.member.isAdmin) {
      input.sendJson(input.res, 403, {
        error: 'administrator permission required',
      });
      return true;
    }
    const authority = await parkAuthority(input);
    if (!authority.membership) {
      input.sendJson(input.res, 404, { error: 'park membership not found' });
      return true;
    }
    const body = await input.readBody(input.req);
    const saved = await updateRecordWithRetry<ParkMembershipPayload>(
      input.repository,
      {
        organizationId,
        domain: 'park',
        resourceType: 'membership',
        resourceId: authority.membership.resourceId,
      },
      (record) => ({
        status: record.status,
        payload: {
          ...record.payload,
          address:
            body.address === undefined
              ? record.payload.address
              : text(body.address, 'tenant address', 500, false),
          roomNumber:
            body.roomNumber === undefined
              ? record.payload.roomNumber
              : text(body.roomNumber, 'room number', 120, false),
        },
      }),
    );
    input.sendJson(input.res, 200, { profile: recordPayloadView(saved!) });
    return true;
  }

  if (input.path === '/enterprise/park/tenants' && input.method === 'GET') {
    const authority = await parkAuthority(input);
    if (
      !input.member.isAdmin ||
      !authority.park ||
      authority.resourceOrganizationId !== organizationId
    ) {
      input.sendJson(input.res, 403, { error: 'park administrator required' });
      return true;
    }
    const memberships =
      await input.repository.listParkTenantMemberships<ParkMembershipPayload>(
        organizationId,
      );
    const organizations = await Promise.all(
      memberships.map(async (membership) => ({
        ...(await input.repository.getOrganization(membership.organizationId)),
        profile: recordPayloadView(membership),
      })),
    );
    input.sendJson(input.res, 200, { organizations });
    return true;
  }

  if (
    input.path === '/enterprise/park/services' &&
    (input.method === 'GET' || input.method === 'PATCH')
  ) {
    const authority = await parkAuthority(input);
    if (!authority.park) {
      input.sendJson(input.res, 404, { error: 'park not found' });
      return true;
    }
    if (input.method === 'GET') {
      const services = await input.repository.listBusinessRecords({
        organizationId: authority.resourceOrganizationId,
        domain: 'park',
        resourceType: 'service',
        limit: 100,
      });
      input.sendJson(input.res, 200, {
        services: services.map(recordPayloadView),
      });
      return true;
    }
    if (
      !input.member.isAdmin ||
      authority.resourceOrganizationId !== organizationId
    ) {
      input.sendJson(input.res, 403, { error: 'park administrator required' });
      return true;
    }
    const body = await input.readBody(input.req);
    const serviceId = text(body.id ?? body.serviceId, 'service id', 120)!;
    const current = await input.repository.getBusinessRecord({
      organizationId,
      domain: 'park',
      resourceType: 'service',
      resourceId: serviceId,
    });
    const payload = {
      name: text(
        body.name ?? current?.payload.name ?? serviceId,
        'service name',
        160,
      )!,
      enabled: body.enabled !== false,
      formSchema:
        body.formSchema && typeof body.formSchema === 'object'
          ? body.formSchema
          : (current?.payload.formSchema ?? {}),
    };
    const service = current
      ? await input.repository.updateBusinessRecord({
          organizationId,
          domain: 'park',
          resourceType: 'service',
          resourceId: serviceId,
          expectedVersion: current.version,
          status: payload.enabled ? 'active' : 'disabled',
          payload,
        })
      : await input.repository.createBusinessRecord({
          organizationId,
          domain: 'park',
          resourceType: 'service',
          resourceId: serviceId,
          ownerAccountId: input.member.id,
          status: payload.enabled ? 'active' : 'disabled',
          payload,
        });
    input.sendJson(input.res, 200, { service: recordPayloadView(service!) });
    return true;
  }

  if (
    input.path === '/enterprise/park/specialists' &&
    ['GET', 'POST', 'DELETE'].includes(input.method)
  ) {
    const authority = await parkAuthority(input);
    if (
      !input.member.isAdmin ||
      !authority.park ||
      authority.resourceOrganizationId !== organizationId
    ) {
      input.sendJson(input.res, 403, { error: 'park administrator required' });
      return true;
    }
    if (input.method === 'GET') {
      const records = await input.repository.listBusinessRecords({
        organizationId,
        domain: 'park',
        resourceType: 'specialist',
        statuses: ['active'],
        limit: 500,
      });
      input.sendJson(input.res, 200, {
        specialists: records.map(recordPayloadView),
      });
      return true;
    }
    const body = await input.readBody(input.req);
    const accountId = text(body.accountId, 'account id', 200)!;
    const account = await input.repository.getAccount(
      accountId,
      organizationId,
    );
    if (!account) {
      input.sendJson(input.res, 404, { error: 'account not found' });
      return true;
    }
    const current = await input.repository.getBusinessRecord({
      organizationId,
      domain: 'park',
      resourceType: 'specialist',
      resourceId: accountId,
    });
    if (input.method === 'DELETE') {
      const saved = current
        ? await input.repository.updateBusinessRecord({
            organizationId,
            domain: 'park',
            resourceType: 'specialist',
            resourceId: accountId,
            expectedVersion: current.version,
            status: 'removed',
            payload: current.payload,
          })
        : null;
      input.sendJson(input.res, saved ? 200 : 404, {
        removed: Boolean(saved),
      });
      return true;
    }
    const payload = {
      accountId,
      name: account.name,
      serviceIds: Array.isArray(body.serviceIds)
        ? body.serviceIds.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
    };
    const saved = current
      ? await input.repository.updateBusinessRecord({
          organizationId,
          domain: 'park',
          resourceType: 'specialist',
          resourceId: accountId,
          expectedVersion: current.version,
          status: 'active',
          payload,
        })
      : await input.repository.createBusinessRecord({
          organizationId,
          domain: 'park',
          resourceType: 'specialist',
          resourceId: accountId,
          ownerAccountId: accountId,
          payload,
        });
    input.sendJson(input.res, 200, { specialist: recordPayloadView(saved!) });
    return true;
  }

  if (input.path === '/enterprise/park/view' && input.method === 'GET') {
    const authority = await parkAuthority(input);
    if (!authority.park) {
      input.sendJson(input.res, 404, { error: 'park not found' });
      return true;
    }
    const services = await input.repository.listBusinessRecords({
      organizationId: authority.resourceOrganizationId,
      domain: 'park',
      resourceType: 'service',
      statuses: ['active'],
      limit: 100,
    });
    input.sendJson(input.res, 200, {
      park: parkView(authority.park),
      profile: authority.membership
        ? recordPayloadView(authority.membership)
        : null,
      services: services.map(recordPayloadView),
    });
    return true;
  }

  if (input.path === '/enterprise/park/statistics' && input.method === 'GET') {
    const authority = await parkAuthority(input);
    if (
      !authority.park ||
      authority.resourceOrganizationId !== organizationId
    ) {
      input.sendJson(input.res, 403, { error: 'park administrator required' });
      return true;
    }
    const tenants =
      await input.repository.listParkTenantMemberships(organizationId);
    input.sendJson(input.res, 200, {
      statistics: {
        parkId: authority.park.resourceId,
        tenantCount: tenants.length,
        generatedAt: new Date().toISOString(),
      },
    });
    return true;
  }

  if (input.path === '/enterprise/park-settings') {
    const authority = await parkAuthority(input);
    if (!authority.park) {
      input.sendJson(input.res, 404, { error: 'park not found' });
      return true;
    }
    const identity = {
      organizationId: authority.resourceOrganizationId,
      domain: 'park' as const,
      resourceType: 'settings',
      resourceId: 'default',
    };
    const current = await input.repository.getBusinessRecord(identity);
    if (input.method === 'GET') {
      input.sendJson(input.res, 200, {
        settings: current ? recordPayloadView(current) : null,
      });
      return true;
    }
    if (
      input.method !== 'PUT' ||
      !input.member.isAdmin ||
      authority.resourceOrganizationId !== organizationId
    ) {
      input.sendJson(input.res, 403, { error: 'park administrator required' });
      return true;
    }
    const body = await input.readBody(input.req);
    const saved = current
      ? await input.repository.updateBusinessRecord({
          ...identity,
          expectedVersion: current.version,
          status: 'active',
          payload: body,
        })
      : await input.repository.createBusinessRecord({
          ...identity,
          ownerAccountId: input.member.id,
          payload: body,
        });
    input.sendJson(input.res, 200, { settings: recordPayloadView(saved!) });
    return true;
  }

  if (input.path === '/enterprise/park-meeting-rooms') {
    const authority = await parkAuthority(input);
    if (!authority.park) {
      input.sendJson(input.res, 404, { error: 'park not found' });
      return true;
    }
    if (input.method === 'GET') {
      const rooms = await input.repository.listBusinessRecords({
        organizationId: authority.resourceOrganizationId,
        domain: 'park',
        resourceType: 'meeting_room',
        statuses: ['active'],
        limit: 500,
      });
      input.sendJson(input.res, 200, {
        meetingRooms: rooms.map(recordPayloadView),
      });
      return true;
    }
    if (
      input.method !== 'POST' ||
      !input.member.isAdmin ||
      authority.resourceOrganizationId !== organizationId
    ) {
      input.sendJson(input.res, 403, { error: 'park administrator required' });
      return true;
    }
    const body = await input.readBody(input.req);
    const room = await input.repository.createBusinessRecord({
      organizationId,
      domain: 'park',
      resourceType: 'meeting_room',
      ownerAccountId: input.member.id,
      payload: {
        name: text(body.name, 'meeting room name', 160)!,
        capacity: Math.max(1, Math.floor(Number(body.capacity ?? 1))),
        location: text(body.location, 'meeting room location', 300, false),
        priceHalfDay: Math.max(0, Number(body.priceHalfDay ?? 0)),
      },
    });
    input.sendJson(input.res, 201, { meetingRoom: recordPayloadView(room) });
    return true;
  }

  const roomRoute = /^\/enterprise\/park-meeting-rooms\/([^/]+)$/u.exec(
    input.path,
  );
  if (roomRoute && (input.method === 'PATCH' || input.method === 'DELETE')) {
    const authority = await parkAuthority(input);
    if (
      !input.member.isAdmin ||
      authority.resourceOrganizationId !== organizationId
    ) {
      input.sendJson(input.res, 403, { error: 'park administrator required' });
      return true;
    }
    const resourceId = decodeURIComponent(roomRoute[1]!);
    const current = await input.repository.getBusinessRecord({
      organizationId,
      domain: 'park',
      resourceType: 'meeting_room',
      resourceId,
    });
    if (!current) {
      input.sendJson(input.res, 404, { error: 'meeting room not found' });
      return true;
    }
    const body =
      input.method === 'PATCH' ? await input.readBody(input.req) : {};
    const saved = await input.repository.updateBusinessRecord({
      organizationId,
      domain: 'park',
      resourceType: 'meeting_room',
      resourceId,
      expectedVersion: current.version,
      status: input.method === 'DELETE' ? 'removed' : current.status,
      payload:
        input.method === 'PATCH'
          ? { ...current.payload, ...body }
          : current.payload,
    });
    input.sendJson(input.res, 200, {
      ...(input.method === 'DELETE'
        ? { deleted: true }
        : { meetingRoom: recordPayloadView(saved!) }),
    });
    return true;
  }

  if (input.path === '/enterprise/park-meeting-slots') {
    const authority = await parkAuthority(input);
    if (!authority.park) {
      input.sendJson(input.res, 404, { error: 'park not found' });
      return true;
    }
    if (input.method === 'GET') {
      const slots = await input.repository.listBusinessRecords({
        organizationId: authority.resourceOrganizationId,
        domain: 'park',
        resourceType: 'meeting_slot',
        limit: 500,
      });
      input.sendJson(input.res, 200, {
        meetingSlots: slots.map(recordPayloadView),
      });
      return true;
    }
    if (
      input.method !== 'PUT' ||
      !input.member.isAdmin ||
      authority.resourceOrganizationId !== organizationId
    ) {
      input.sendJson(input.res, 403, { error: 'park administrator required' });
      return true;
    }
    const body = await input.readBody(input.req);
    const key = text(
      body.id ?? `${body.roomId}:${body.date}:${body.startTime}`,
      'slot id',
      200,
    )!;
    const current = await input.repository.getBusinessRecord({
      organizationId,
      domain: 'park',
      resourceType: 'meeting_slot',
      resourceId: key,
    });
    const saved = current
      ? await input.repository.updateBusinessRecord({
          organizationId,
          domain: 'park',
          resourceType: 'meeting_slot',
          resourceId: key,
          expectedVersion: current.version,
          status: body.available === false ? 'unavailable' : 'active',
          payload: { ...current.payload, ...body },
        })
      : await input.repository.createBusinessRecord({
          organizationId,
          domain: 'park',
          resourceType: 'meeting_slot',
          resourceId: key,
          ownerAccountId: input.member.id,
          status: body.available === false ? 'unavailable' : 'active',
          payload: body,
        });
    input.sendJson(input.res, 200, { meetingSlot: recordPayloadView(saved!) });
    return true;
  }

  if (input.path === '/enterprise/park-resources' && input.method === 'GET') {
    const authority = await parkAuthority(input);
    if (!authority.park) {
      input.sendJson(input.res, 404, { error: 'park not found' });
      return true;
    }
    const [settings, rooms, slots] = await Promise.all([
      input.repository.getBusinessRecord({
        organizationId: authority.resourceOrganizationId,
        domain: 'park',
        resourceType: 'settings',
        resourceId: 'default',
      }),
      input.repository.listBusinessRecords({
        organizationId: authority.resourceOrganizationId,
        domain: 'park',
        resourceType: 'meeting_room',
        statuses: ['active'],
        limit: 500,
      }),
      input.repository.listBusinessRecords({
        organizationId: authority.resourceOrganizationId,
        domain: 'park',
        resourceType: 'meeting_slot',
        limit: 500,
      }),
    ]);
    input.sendJson(input.res, 200, {
      settings: settings ? recordPayloadView(settings) : null,
      meetingRooms: rooms.map(recordPayloadView),
      meetingSlots: slots.map(recordPayloadView),
    });
    return true;
  }

  if (
    input.path === '/enterprise/park-services/push' &&
    input.method === 'POST'
  ) {
    const authority = await parkAuthority(input);
    if (
      !input.member.isAdmin ||
      !authority.park ||
      authority.resourceOrganizationId !== organizationId
    ) {
      input.sendJson(input.res, 403, { error: 'park administrator required' });
      return true;
    }
    const body = await input.readBody(input.req);
    const recipientAccountIds = Array.isArray(body.recipientAccountIds)
      ? body.recipientAccountIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    const publication = await input.repository.createBusinessRecord({
      organizationId,
      domain: 'park',
      resourceType: 'publication',
      ownerAccountId: input.member.id,
      status: 'published',
      payload: {
        kind: body.kind === 'survey' ? 'survey' : 'announcement',
        title: text(body.title, 'publication title', 200)!,
        content: text(body.content, 'publication content', 10_000)!,
        targetOrganizationId:
          typeof body.targetOrganizationId === 'string'
            ? body.targetOrganizationId
            : null,
        recipientAccountIds,
        options: Array.isArray(body.options)
          ? body.options
              .filter((value): value is string => typeof value === 'string')
              .slice(0, 50)
          : [],
      },
    });
    input.sendJson(input.res, 201, {
      publication: recordPayloadView(publication),
    });
    return true;
  }

  if (
    input.path === '/enterprise/park-services/publications' &&
    input.method === 'GET'
  ) {
    const publications = await input.repository.listAddressedBusinessRecords({
      organizationId,
      accountId: input.member.id,
      domain: 'park',
      resourceType: 'publication',
      limit: 500,
    });
    input.sendJson(input.res, 200, {
      publications: publications.map(recordPayloadView),
    });
    return true;
  }

  if (
    (input.path === '/enterprise/park-services/survey-results' ||
      input.path === '/enterprise/park-services/announcement-results') &&
    input.method === 'GET'
  ) {
    if (!input.member.isAdmin) {
      input.sendJson(input.res, 403, {
        error: 'administrator permission required',
      });
      return true;
    }
    const publications = await input.repository.listBusinessRecords({
      organizationId,
      domain: 'park',
      resourceType: 'publication',
      limit: 500,
    });
    const results = await Promise.all(
      publications.map(async (publication) => ({
        publication: recordPayloadView(publication),
        responses: await input.repository.listBusinessEvents({
          organizationId,
          domain: 'park',
          resourceType: 'publication',
          resourceId: publication.resourceId,
          limit: 500,
        }),
      })),
    );
    input.sendJson(input.res, 200, {
      ...(input.path.includes('survey')
        ? { surveys: results }
        : { announcements: results }),
    });
    return true;
  }

  const publicationAction =
    /^\/enterprise\/park-services\/publications\/([^/]+)\/(read|survey)$/u.exec(
      input.path,
    );
  if (publicationAction && input.method === 'POST') {
    const publications = await input.repository.listAddressedBusinessRecords({
      organizationId,
      accountId: input.member.id,
      domain: 'park',
      resourceType: 'publication',
      limit: 500,
    });
    const publication = publications.find(
      (record) =>
        record.resourceId === decodeURIComponent(publicationAction[1]!),
    );
    if (!publication) {
      input.sendJson(input.res, 404, {
        error: 'publication not found or access denied',
      });
      return true;
    }
    const body = await input.readBody(input.req);
    const event = await input.repository.appendBusinessEvent({
      organizationId: publication.organizationId,
      domain: 'park',
      resourceType: 'publication',
      resourceId: publication.resourceId,
      eventId: `${publicationAction[2]}:${input.member.id}:${publication.resourceId}`,
      actorAccountId: input.member.id,
      eventType: publicationAction[2]!,
      payload:
        publicationAction[2] === 'survey'
          ? { response: body.response ?? body }
          : {},
    });
    input.sendJson(input.res, 200, {
      publication: recordPayloadView(publication),
      event,
    });
    return true;
  }

  if (
    (input.path === '/enterprise/park-statistics' ||
      input.path === '/enterprise/park-statistics/inbox') &&
    (input.method === 'GET' || input.method === 'POST')
  ) {
    if (input.method === 'GET') {
      const tasks = await input.repository.listAddressedBusinessRecords({
        organizationId,
        accountId: input.member.id,
        domain: 'park',
        resourceType: 'statistics_task',
        limit: 500,
      });
      input.sendJson(input.res, 200, { tasks: tasks.map(recordPayloadView) });
      return true;
    }
    if (!input.member.isAdmin) {
      input.sendJson(input.res, 403, {
        error: 'administrator permission required',
      });
      return true;
    }
    const body = await input.readBody(input.req);
    const task = await input.repository.createBusinessRecord({
      organizationId,
      domain: 'park',
      resourceType: 'statistics_task',
      ownerAccountId: input.member.id,
      status: 'open',
      payload: {
        title: text(body.title, 'statistics title', 200)!,
        description: text(
          body.description,
          'statistics description',
          2_000,
          false,
        ),
        deadline: text(body.deadline, 'statistics deadline', 80, false),
        template:
          body.template && typeof body.template === 'object'
            ? body.template
            : {},
        targetOrganizationId:
          typeof body.targetOrganizationId === 'string'
            ? body.targetOrganizationId
            : organizationId,
        recipientAccountIds: Array.isArray(body.recipientAccountIds)
          ? body.recipientAccountIds.filter(
              (value): value is string => typeof value === 'string',
            )
          : [],
      },
    });
    input.sendJson(input.res, 201, { task: recordPayloadView(task) });
    return true;
  }

  const statisticsAction =
    /^\/enterprise\/park-statistics\/([^/]+)\/(template|read|delegate|submit|review|remind|return)$/u.exec(
      input.path,
    );
  if (statisticsAction && ['GET', 'POST'].includes(input.method)) {
    const tasks = await input.repository.listAddressedBusinessRecords({
      organizationId,
      accountId: input.member.id,
      domain: 'park',
      resourceType: 'statistics_task',
      limit: 500,
    });
    const task = tasks.find(
      (record) =>
        record.resourceId === decodeURIComponent(statisticsAction[1]!),
    );
    if (!task) {
      input.sendJson(input.res, 404, { error: 'statistics task not found' });
      return true;
    }
    if (statisticsAction[2] === 'template' && input.method === 'GET') {
      input.sendJson(input.res, 200, { template: task.payload.template ?? {} });
      return true;
    }
    const body = await input.readBody(input.req);
    const event = await input.repository.appendBusinessEvent({
      organizationId: task.organizationId,
      domain: 'park',
      resourceType: 'statistics_task',
      resourceId: task.resourceId,
      actorAccountId: input.member.id,
      eventType: statisticsAction[2]!,
      payload: body,
    });
    const status =
      statisticsAction[2] === 'submit'
        ? 'submitted'
        : statisticsAction[2] === 'review'
          ? 'reviewed'
          : statisticsAction[2] === 'return'
            ? 'returned'
            : task.status;
    const saved = await input.repository.updateBusinessRecord({
      organizationId: task.organizationId,
      domain: 'park',
      resourceType: 'statistics_task',
      resourceId: task.resourceId,
      expectedVersion: task.version,
      status,
      payload: task.payload,
    });
    input.sendJson(input.res, 200, {
      task: recordPayloadView(saved!),
      event,
    });
    return true;
  }

  return false;
}

type TicketPayload = {
  createdByAccountId: string;
  createdByName: string;
  sourceOrganizationId: string;
  targetOrganizationId: string;
  parkId: string | null;
  serviceId: string;
  title: string;
  description: string;
  targetTags: string[];
  formData: Record<string, string>;
  assigneeAccountIds: string[];
  participantAccountIds: string[];
  unreadAccountIds: string[];
  responseType: string | null;
  responseText: string | null;
};

function ticketView(record: PostgresBusinessRecord<TicketPayload>) {
  return {
    id: record.resourceId,
    organizationId: record.payload.sourceOrganizationId,
    ...record.payload,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function accessibleTicket(
  input: ClusteredBusinessRouteInput,
  resourceId: string,
): Promise<PostgresBusinessRecord<TicketPayload> | null> {
  const records =
    await input.repository.listTicketRecordsForAccount<TicketPayload>({
      organizationId: input.member.organizationId,
      accountId: input.member.id,
      inbox: input.member.isAdmin,
      limit: 500,
    });
  return records.find((record) => record.resourceId === resourceId) ?? null;
}

async function handleTickets(
  input: ClusteredBusinessRouteInput,
): Promise<boolean> {
  if (
    input.path !== '/enterprise/tickets' &&
    !input.path.startsWith('/enterprise/tickets/')
  ) {
    return false;
  }
  const organizationId = input.member.organizationId;

  if (input.path === '/enterprise/tickets' && input.method === 'POST') {
    const body = await input.readBody(input.req);
    const title = text(body.title, 'ticket title', 200)!;
    const description = text(body.description, 'ticket description', 2_000)!;
    const serviceId = text(body.serviceId ?? 'it', 'service id', 120)!;
    const isParkRequest = serviceId !== 'it';
    if (
      isParkRequest &&
      !(await input.requireCommercialFeature('park_service'))
    ) {
      return true;
    }
    const authority = isParkRequest ? await parkAuthority(input) : null;
    if (isParkRequest && (!authority?.park || !authority.membership)) {
      input.sendJson(input.res, 403, {
        error: 'organization has not joined a park',
      });
      return true;
    }
    const targetOrganizationId =
      authority?.resourceOrganizationId ?? organizationId;
    const targetAccounts =
      await input.repository.listAccounts(targetOrganizationId);
    const targetTags = Array.isArray(body.targetTags)
      ? body.targetTags.filter((tag): tag is string => typeof tag === 'string')
      : serviceId === 'it'
        ? ['IT']
        : ['customer-service'];
    const assignees = targetAccounts
      .filter(
        (account) =>
          account.status === 'active' &&
          (account.isAdmin ||
            account.tags.some((tag) => targetTags.includes(tag))),
      )
      .map((account) => account.id);
    const formData =
      body.formData &&
      typeof body.formData === 'object' &&
      !Array.isArray(body.formData)
        ? Object.fromEntries(
            Object.entries(body.formData)
              .filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string',
              )
              .slice(0, 100)
              .map(([key, value]) => [key.slice(0, 80), value.slice(0, 2_000)]),
          )
        : {};
    const record = await input.repository.createBusinessRecord<TicketPayload>({
      organizationId,
      domain: 'ticketing',
      resourceType: 'ticket',
      ownerAccountId: input.member.id,
      status: 'open',
      payload: {
        createdByAccountId: input.member.id,
        createdByName: input.member.name,
        sourceOrganizationId: organizationId,
        targetOrganizationId,
        parkId: authority?.park?.resourceId ?? null,
        serviceId,
        title,
        description,
        targetTags,
        formData,
        assigneeAccountIds: assignees,
        participantAccountIds: [input.member.id, ...assignees],
        unreadAccountIds: assignees,
        responseType: null,
        responseText: null,
      },
    });
    await input.repository.appendBusinessEvent({
      organizationId,
      domain: 'ticketing',
      resourceType: 'ticket',
      resourceId: record.resourceId,
      actorAccountId: input.member.id,
      eventType: 'created',
      payload: { status: 'open' },
    });
    input.sendJson(input.res, 201, { ticket: ticketView(record) });
    return true;
  }

  if (
    (input.path === '/enterprise/tickets' ||
      input.path === '/enterprise/tickets/inbox') &&
    input.method === 'GET'
  ) {
    const inbox = input.path.endsWith('/inbox');
    const records =
      await input.repository.listTicketRecordsForAccount<TicketPayload>({
        organizationId,
        accountId: input.member.id,
        inbox,
        limit: 500,
      });
    const canReadParkTickets = await input.commercialFeatureAvailable(
      'park_service',
    );
    input.sendJson(input.res, 200, {
      tickets: records
        .filter((record) => !record.payload.parkId || canReadParkTickets)
        .map(ticketView),
    });
    return true;
  }

  const actionRoute = /^\/enterprise\/tickets\/([^/]+)\/(read|action)$/u.exec(
    input.path,
  );
  if (!actionRoute || input.method !== 'POST') {
    input.sendJson(input.res, 404, { error: 'ticket route not found' });
    return true;
  }
  const resourceId = decodeURIComponent(actionRoute[1]!);
  const current = await accessibleTicket(input, resourceId);
  if (!current) {
    input.sendJson(input.res, 404, {
      error: 'ticket not found or access denied',
    });
    return true;
  }
  if (
    current.payload.parkId &&
    !(await input.requireCommercialFeature('park_service'))
  ) {
    return true;
  }
  if (actionRoute[2] === 'read') {
    const saved = await updateRecordWithRetry<TicketPayload>(
      input.repository,
      {
        organizationId: current.organizationId,
        domain: 'ticketing',
        resourceType: 'ticket',
        resourceId,
      },
      (record) => ({
        status: record.status,
        payload: {
          ...record.payload,
          unreadAccountIds: record.payload.unreadAccountIds.filter(
            (accountId) => accountId !== input.member.id,
          ),
        },
      }),
    );
    input.sendJson(input.res, 200, { ticket: ticketView(saved!) });
    return true;
  }

  const body = await input.readBody(input.req);
  const action = typeof body.action === 'string' ? body.action : '';
  if (
    ![
      'respond',
      'accept',
      'complete',
      'confirm',
      'respond_and_transfer',
    ].includes(action)
  ) {
    input.sendJson(input.res, 400, { error: 'ticket action is invalid' });
    return true;
  }
  const creator = current.payload.createdByAccountId === input.member.id;
  const targetActor =
    current.payload.targetOrganizationId === organizationId &&
    (input.member.isAdmin ||
      current.payload.assigneeAccountIds.includes(input.member.id));
  if (
    (action === 'confirm' && !creator) ||
    (action !== 'confirm' && !targetActor)
  ) {
    input.sendJson(input.res, 403, { error: 'ticket action is not permitted' });
    return true;
  }
  const nextStatus =
    action === 'accept'
      ? 'accepted'
      : action === 'complete'
        ? 'waiting_confirmation'
        : action === 'confirm'
          ? 'completed'
          : action === 'respond_and_transfer'
            ? 'transferred'
            : 'in_progress';
  const transferAccountId =
    typeof body.transferAccountId === 'string'
      ? body.transferAccountId.trim()
      : '';
  if (transferAccountId) {
    const target = await input.repository.getAccount(
      transferAccountId,
      current.payload.targetOrganizationId,
    );
    if (!target || target.status !== 'active') {
      input.sendJson(input.res, 400, {
        error: 'transfer account is unavailable',
      });
      return true;
    }
  }
  const saved = await updateRecordWithRetry<TicketPayload>(
    input.repository,
    {
      organizationId: current.organizationId,
      domain: 'ticketing',
      resourceType: 'ticket',
      resourceId,
    },
    (record) => ({
      status: nextStatus,
      payload: {
        ...record.payload,
        assigneeAccountIds: transferAccountId
          ? [transferAccountId]
          : record.payload.assigneeAccountIds,
        participantAccountIds: transferAccountId
          ? [
              ...new Set([
                ...record.payload.participantAccountIds,
                transferAccountId,
              ]),
            ]
          : record.payload.participantAccountIds,
        unreadAccountIds:
          action === 'confirm'
            ? record.payload.assigneeAccountIds
            : [record.payload.createdByAccountId],
        responseType:
          typeof body.responseType === 'string'
            ? body.responseType.slice(0, 120)
            : record.payload.responseType,
        responseText:
          typeof body.responseText === 'string'
            ? body.responseText.slice(0, 2_000)
            : record.payload.responseText,
      },
    }),
  );
  await input.repository.appendBusinessEvent({
    organizationId: current.organizationId,
    domain: 'ticketing',
    resourceType: 'ticket',
    resourceId,
    actorAccountId: input.member.id,
    eventType: action,
    payload: {
      status: nextStatus,
      responseType: saved!.payload.responseType,
      responseText: saved!.payload.responseText,
      transferAccountId: transferAccountId || null,
    },
  });
  input.sendJson(input.res, 200, { ticket: ticketView(saved!) });
  return true;
}

async function putSingletonRecord(
  input: ClusteredBusinessRouteInput,
  resourceType: string,
  payload: Record<string, unknown>,
  status = 'active',
): Promise<PostgresBusinessRecord<Record<string, unknown>>> {
  const identity = {
    organizationId: input.member.organizationId,
    domain: 'commercial_control' as const,
    resourceType,
    resourceId: 'current',
  };
  const current = await input.repository.getBusinessRecord(identity);
  if (!current) {
    return input.repository.createBusinessRecord({
      ...identity,
      ownerAccountId: input.member.id,
      status,
      payload,
    });
  }
  const saved = await input.repository.updateBusinessRecord({
    ...identity,
    expectedVersion: current.version,
    status,
    payload,
  });
  if (!saved) throw new Error('commercial control state changed concurrently');
  return saved;
}

function licenseStatus(payload: Record<string, unknown> | null): string {
  if (!payload) return 'missing';
  const expiresAt = Date.parse(String(payload.expiresAt ?? ''));
  if (!Number.isFinite(expiresAt)) return 'invalid';
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return 'expired';
  return remaining <= 30 * 24 * 60 * 60 * 1_000 ? 'expiring' : 'active';
}

function publicLicense(
  record: PostgresBusinessRecord<Record<string, unknown>> | null,
  activeSeatCount: number,
) {
  if (!record) {
    return {
      status: 'missing',
      plan: 'unlicensed',
      expiresAt: '',
      seatLimit: 0,
      activeSeatCount,
      modules: [],
      offline: true,
      enforce: true,
    };
  }
  const {
    signedEnvelope: _signedEnvelope,
    ...publicPayload
  } = record.payload;
  return {
    ...publicPayload,
    status: licenseStatus(record.payload),
    activeSeatCount,
    seatLimitExceeded:
      activeSeatCount > Math.max(0, Number(record.payload.seatLimit ?? 0)),
    enforce: true,
    updatedAt: record.updatedAt,
  };
}

async function commercialStatus(input: ClusteredBusinessRouteInput) {
  const organizationId = input.member.organizationId;
  const [
    verifiedLicense,
    telemetry,
    updatePolicy,
    telemetryBatches,
    backups,
  ] = await Promise.all([
    input.commercialLicenseSummary(),
    input.repository.getBusinessRecord({
      organizationId,
      domain: 'commercial_control',
      resourceType: 'telemetry_settings',
      resourceId: 'current',
    }),
    input.repository.getBusinessRecord({
      organizationId,
      domain: 'commercial_control',
      resourceType: 'update_policy',
      resourceId: 'current',
    }),
    input.repository.listBusinessRecords({
      organizationId,
      domain: 'commercial_control',
      resourceType: 'telemetry_batch',
      limit: 500,
    }),
    input.repository.listBusinessRecords({
      organizationId,
      domain: 'commercial_control',
      resourceType: 'backup_request',
      limit: 100,
    }),
  ]);
  const telemetrySummary = {
    queued: telemetryBatches.filter((record) => record.status === 'queued')
      .length,
    failed: telemetryBatches.filter((record) => record.status === 'failed')
      .length,
    sent: telemetryBatches.filter((record) => record.status === 'sent').length,
    lastQueuedAt: telemetryBatches[0]?.createdAt ?? null,
  };
  return {
    deploymentId:
      process.env.OTTO_DEPLOYMENT_ID?.trim() || 'clustered-enterprise',
    authority: 'postgresql',
    license: verifiedLicense,
    telemetry: {
      ...(telemetry?.payload ?? {
        enabled: false,
        contentMode: 'operational_only',
        endpoint: null,
      }),
      ...telemetrySummary,
    },
    updatePolicy: updatePolicy?.payload ?? {
      channel: 'stable',
      automatic: false,
    },
    dataBoundary: {
      uploadsContentByDefault: false,
      includesUserMessages: false,
      includesFiles: false,
      includesMeetingAudio: false,
      defaultPayload: ['operational_metrics', 'license_state', 'module_usage'],
      messageContent: 'client_e2ee_ciphertext_only',
      attachmentContent: 'client_e2ee_ciphertext_only',
      clientIdentityPrivateKeys: 'client_only',
    },
    moduleCatalog: licenseModuleCatalog(),
    dataProtection: {
      provider: 'managed_postgresql_or_cluster_pitr',
      backupCount: backups.length,
      retentionDays: 0,
      minimumRetained: 0,
      lastSuccessAt: null,
      lastRequestedAt: backups[0]?.createdAt ?? null,
      lastError: null,
      capacityWarning: false,
    },
    operationsSecurity: {
      topology: {
        database: { backend: 'postgresql', replicas: 'shared' },
        attachments: { backend: 's3' },
        cache: { backend: 'redis' },
      },
      sqlCipher: { state: 'not_applicable_server' },
      keyManagement: {
        databaseKeyProvider: 'provider_disk_or_kms',
        remoteProvider: 'deployment_managed',
        automaticRotation: 'deployment_managed',
      },
    },
  };
}

async function handleCommercialControl(
  input: ClusteredBusinessRouteInput,
): Promise<boolean> {
  const handles =
    input.path.startsWith('/enterprise/deployment/') ||
    input.path === '/enterprise/modules/updates' ||
    input.path === '/enterprise/modules/updates/client';
  if (!handles) return false;
  const organizationId = input.member.organizationId;

  if (
    input.path === '/enterprise/deployment/update-policy' &&
    input.method === 'POST'
  ) {
    const body = await input.readBody(input.req);
    const distributionId = text(body.distributionId, 'distribution id', 64)!;
    const currentVersion = text(body.currentVersion, 'current version', 120)!;
    if (!/^[a-z0-9][a-z0-9_.-]{1,63}$/u.test(distributionId)) {
      input.sendJson(input.res, 400, { error: 'distribution id is invalid' });
      return true;
    }
    if (
      !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
        currentVersion,
      )
    ) {
      input.sendJson(input.res, 400, { error: 'current version is invalid' });
      return true;
    }
    input.sendJson(input.res, 200, {
      status: 'not_configured',
      reason: 'online_license_required',
    });
    return true;
  }

  if (
    input.path === '/enterprise/modules/updates/client' &&
    input.method === 'GET'
  ) {
    const modules = await input.repository.listBusinessRecords({
      organizationId,
      domain: 'commercial_control',
      resourceType: 'module_update',
      limit: 500,
    });
    input.sendJson(input.res, 200, {
      format: 'otto-module-updates-v1',
      deploymentId:
        process.env.OTTO_DEPLOYMENT_ID?.trim() || 'clustered-enterprise',
      generatedAt: new Date().toISOString(),
      modules: modules.map((record) => record.payload),
      catalog: licenseModuleCatalog(),
    });
    return true;
  }

  if (!input.member.isAdmin) {
    input.sendJson(input.res, 403, {
      error: 'administrator permission required',
    });
    return true;
  }

  if (
    input.path === '/enterprise/deployment/status' &&
    input.method === 'GET'
  ) {
    input.sendJson(input.res, 200, await commercialStatus(input));
    return true;
  }

  if (
    input.path === '/enterprise/deployment/data-protection' &&
    input.method === 'GET'
  ) {
    input.sendJson(input.res, 200, {
      database: {
        backend: 'postgresql',
        encryption: 'provider_disk_or_kms',
        transport: 'tls_required',
        backup: 'managed_postgresql_or_cluster_pitr',
      },
      attachments: {
        backend: 's3_compatible',
        content: 'client_e2ee_ciphertext_only',
        storageEncryption: 'sse_kms_optional',
      },
      clientPrivateKeys: 'client_only',
    });
    return true;
  }

  if (
    input.path === '/enterprise/deployment/data-protection/backup' &&
    input.method === 'POST'
  ) {
    const request = await input.repository.createBusinessRecord({
      organizationId,
      domain: 'commercial_control',
      resourceType: 'backup_request',
      ownerAccountId: input.member.id,
      status: 'requested',
      payload: {
        strategy: 'provider_managed_postgresql_pitr',
        requestedAt: new Date().toISOString(),
        requestedBy: input.member.id,
      },
    });
    input.sendJson(input.res, 202, {
      request: recordPayloadView(request),
      note: 'The managed PostgreSQL backup controller must consume and attest this request.',
    });
    return true;
  }

  if (
    (input.path === '/enterprise/deployment/license' ||
      input.path === '/enterprise/deployment/license/lease') &&
    input.method === 'POST'
  ) {
    const body = await input.readBody(input.req);
    const envelope = body as Record<string, unknown>;
    const payloadValue = envelope.license ?? envelope.payload;
    const payload =
      payloadValue &&
      typeof payloadValue === 'object' &&
      !Array.isArray(payloadValue)
        ? (payloadValue as Record<string, unknown>)
        : null;
    const signature =
      typeof envelope.signature === 'string' ? envelope.signature : '';
    const signingKeyId =
      typeof envelope.signingKeyId === 'string' ? envelope.signingKeyId : null;
    const publicKeys = parsePublicKeyList(
      process.env.OTTO_LICENSE_PUBLIC_KEYS,
      process.env.OTTO_LICENSE_REVOKED_KEY_IDS,
    );
    if (!payload || publicKeys.length === 0) {
      input.sendJson(input.res, 503, {
        error: 'license verification keys are unavailable',
        code: 'LICENSE_VERIFICATION_UNAVAILABLE',
      });
      return true;
    }
    const verification = verifyEd25519Envelope(
      payload,
      signature,
      publicKeys,
      signingKeyId,
    );
    if (!verification.valid) {
      input.sendJson(input.res, 400, { error: 'license signature is invalid' });
      return true;
    }
    const deploymentId =
      process.env.OTTO_DEPLOYMENT_ID?.trim() || 'clustered-enterprise';
    if (
      payload.deploymentId !== deploymentId ||
      payload.organizationId !== organizationId
    ) {
      input.sendJson(input.res, 409, {
        error: 'license deployment or organization does not match',
      });
      return true;
    }
    const expiresAt = new Date(
      Number(
        payload.expiresAtMs ?? Date.parse(String(payload.expiresAt ?? '')),
      ),
    );
    const seatLimit = Math.floor(Number(payload.seatLimit ?? 0));
    const knownModules = new Set(
      licenseModuleCatalog().map((item) => item.module),
    );
    const modules = Array.isArray(payload.modules)
      ? [
          ...new Set(
            payload.modules.filter(
              (item): item is string => typeof item === 'string',
            ),
          ),
        ]
      : [];
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now() ||
      seatLimit < 1 ||
      modules.length === 0 ||
      modules.some((module) => !knownModules.has(module))
    ) {
      input.sendJson(input.res, 400, { error: 'license claims are invalid' });
      return true;
    }
    const sensitiveFields = [
      'telemetryToken',
      'leaseToken',
      'billingHoldToken',
      'billingFinalizeToken',
    ];
    if (sensitiveFields.some((field) => typeof payload[field] === 'string')) {
      input.sendJson(input.res, 400, {
        error:
          'license secrets must be provisioned through the server secret provider',
      });
      return true;
    }
    const stored = await putSingletonRecord(input, 'license', {
      id: typeof payload.id === 'string' ? payload.id : `lic_${randomUUID()}`,
      revision: Math.max(1, Math.floor(Number(payload.revision ?? 1))),
      deploymentId,
      organizationId,
      customerName: text(payload.customerName, 'customer name', 240)!,
      plan: text(payload.plan ?? 'enterprise', 'license plan', 120)!,
      expiresAt: expiresAt.toISOString(),
      seatLimit,
      seatEnforcement: 'enforce',
      modules,
      offline: payload.offline !== false,
      telemetryAllowed: payload.telemetryAllowed === true,
      signatureAlgorithm: 'ed25519',
      signingKeyId: verification.keyId,
      signedEnvelope: {
        payload,
        signature,
        signingKeyId: verification.keyId,
      },
    });
    input.sendJson(input.res, 200, {
      license: publicLicense(
        stored,
        (await input.repository.listAccounts(organizationId)).filter(
          (account) =>
            account.accountType === 'enterprise' && account.status === 'active',
        ).length,
      ),
    });
    return true;
  }

  if (
    input.path === '/enterprise/deployment/telemetry' &&
    input.method === 'PATCH'
  ) {
    const body = await input.readBody(input.req);
    const record = await putSingletonRecord(input, 'telemetry_settings', {
      enabled: body.enabled === true,
      contentMode:
        body.contentMode === 'diagnostic_redacted'
          ? 'diagnostic_redacted'
          : 'operational_only',
      endpoint:
        typeof body.endpoint === 'string' &&
        body.endpoint.startsWith('https://')
          ? body.endpoint.slice(0, 2_000)
          : null,
    });
    input.sendJson(input.res, 200, { telemetry: recordPayloadView(record) });
    return true;
  }

  if (
    input.path === '/enterprise/deployment/telemetry/ingest' &&
    input.method === 'POST'
  ) {
    const body = await input.readBody(input.req, 2 * 1024 * 1024);
    const serialized = JSON.stringify(body).toLowerCase();
    if (
      /messagecontent|filecontent|meetingaudio|privatekey|ciphertext/u.test(
        serialized,
      )
    ) {
      input.sendJson(input.res, 400, {
        error: 'telemetry batch contains a forbidden content field',
      });
      return true;
    }
    const eventId =
      typeof body.batchId === 'string' ? body.batchId : randomUUID();
    const batch = await input.repository.createBusinessRecord({
      organizationId,
      domain: 'commercial_control',
      resourceType: 'telemetry_batch',
      resourceId: eventId,
      ownerAccountId: input.member.id,
      status: 'queued',
      payload: body,
    });
    input.sendJson(input.res, 202, { receipt: recordPayloadView(batch) });
    return true;
  }

  if (
    input.path === '/enterprise/deployment/telemetry/flush' &&
    input.method === 'POST'
  ) {
    const batches = await input.repository.listBusinessRecords({
      organizationId,
      domain: 'commercial_control',
      resourceType: 'telemetry_batch',
      statuses: ['queued', 'failed'],
      limit: 500,
    });
    input.sendJson(input.res, 200, {
      result: {
        queued: batches.length,
        delivery: 'external_collector_required',
      },
    });
    return true;
  }

  if (
    input.path === '/enterprise/deployment/diagnostics' &&
    input.method === 'GET'
  ) {
    const memory = process.memoryUsage();
    input.sendJson(input.res, 200, {
      generatedAt: new Date().toISOString(),
      authority: 'postgresql',
      runtime: {
        nodeVersion: process.version,
        uptimeSec: Math.floor(process.uptime()),
        memoryRssMb: Math.round(memory.rss / 1024 / 1024),
        memoryHeapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      },
      secretsIncluded: false,
    });
    return true;
  }

  if (input.path === '/enterprise/modules/updates' && input.method === 'GET') {
    const modules = await input.repository.listBusinessRecords({
      organizationId,
      domain: 'commercial_control',
      resourceType: 'module_update',
      limit: 500,
    });
    input.sendJson(input.res, 200, {
      format: 'otto-module-updates-v1',
      deploymentId:
        process.env.OTTO_DEPLOYMENT_ID?.trim() || 'clustered-enterprise',
      generatedAt: new Date().toISOString(),
      modules: modules.map((record) => record.payload),
      catalog: licenseModuleCatalog(),
    });
    return true;
  }

  if (
    input.path === '/enterprise/modules/updates' &&
    input.method === 'PATCH'
  ) {
    const body = await input.readBody(input.req);
    const moduleName = text(body.module, 'module', 120)!;
    const knownModules = new Set(
      licenseModuleCatalog().map((item) => item.module),
    );
    if (!knownModules.has(moduleName)) {
      input.sendJson(input.res, 400, { error: 'module is unknown' });
      return true;
    }
    const version = text(body.version, 'module version', 120)!;
    const rollout =
      typeof body.rollout === 'string' &&
      MODULE_UPDATE_ROLLOUTS.has(body.rollout as never)
        ? body.rollout
        : 'off';
    const sha256 =
      typeof body.sha256 === 'string' &&
      MODULE_UPDATE_SHA256_RE.test(body.sha256)
        ? body.sha256.toLowerCase()
        : null;
    if (body.sha256 != null && !sha256) {
      input.sendJson(input.res, 400, { error: 'module checksum is invalid' });
      return true;
    }
    const identity = {
      organizationId,
      domain: 'commercial_control' as const,
      resourceType: 'module_update',
      resourceId: moduleName,
    };
    const current = await input.repository.getBusinessRecord(identity);
    const payload = {
      module: moduleName,
      version,
      rollout,
      notes: typeof body.notes === 'string' ? body.notes.slice(0, 2_000) : '',
      minAppVersion:
        typeof body.minAppVersion === 'string'
          ? body.minAppVersion.slice(0, 120)
          : null,
      manifestUrl:
        typeof body.manifestUrl === 'string' &&
        body.manifestUrl.startsWith('https://')
          ? body.manifestUrl.slice(0, 2_000)
          : null,
      sha256,
      publishedAt: rollout === 'off' ? null : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const saved = current
      ? await input.repository.updateBusinessRecord({
          ...identity,
          expectedVersion: current.version,
          status: rollout === 'off' ? 'disabled' : 'active',
          payload,
        })
      : await input.repository.createBusinessRecord({
          ...identity,
          ownerAccountId: input.member.id,
          status: rollout === 'off' ? 'disabled' : 'active',
          payload,
        });
    const modules = await input.repository.listBusinessRecords({
      organizationId,
      domain: 'commercial_control',
      resourceType: 'module_update',
      limit: 500,
    });
    input.sendJson(input.res, 200, {
      moduleUpdate: recordPayloadView(saved!),
      manifest: {
        format: 'otto-module-updates-v1',
        deploymentId:
          process.env.OTTO_DEPLOYMENT_ID?.trim() || 'clustered-enterprise',
        generatedAt: new Date().toISOString(),
        modules: modules.map((record) => record.payload),
        catalog: licenseModuleCatalog(),
      },
    });
    return true;
  }

  input.sendJson(input.res, 404, {
    error: 'commercial control route not found',
  });
  return true;
}

export async function handleClusteredBusinessRoute(
  input: ClusteredBusinessRouteInput,
): Promise<boolean> {
  return (
    (await handleAccountSync(input)) ||
    (await handleKnowledge(input)) ||
    (await handleSkills(input)) ||
    (await handlePark(input)) ||
    (await handleTickets(input)) ||
    (await handleCommercialControl(input))
  );
}
