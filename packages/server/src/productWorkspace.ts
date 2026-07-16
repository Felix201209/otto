/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * v1.7 product-workspace domain.
 *
 * This module deliberately contains no HTTP, WebSocket, Electron, filesystem or
 * database integration. It owns the stable business rules that later server
 * routes can persist and expose: edition contexts, manager onboarding,
 * reference-only signed invites, schedules and credit economics.
 */

import {
  createPublicKey,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
  KeyObject,
} from 'node:crypto';

// ---------------------------------------------------------------------------
// Product contexts
// ---------------------------------------------------------------------------

export type ProductEdition = 'personal' | 'enterprise';

export type ProductRole =
  | 'personal'
  | 'company_owner'
  | 'company_admin'
  | 'manager'
  | 'member';

export type ProductCapability =
  | 'agent:base'
  | 'model:byok'
  | 'model:otto'
  | 'skill:built-in'
  | 'skill:auto-create'
  | 'skill:market'
  | 'organization:read'
  | 'organization:manage'
  | 'invite:issue'
  | 'schedule:write'
  | 'billing:read'
  | 'billing:manage';

export interface ProductContext {
  edition: ProductEdition;
  role: ProductRole;
  userId: string;
  displayName?: string;
  companyId?: string;
  departmentId?: string;
  positionId?: string;
  capabilities: ProductCapability[];
}

export interface PersonalContextInput {
  userId: string;
  displayName?: string;
}

export interface EnterpriseContextInput {
  userId: string;
  displayName?: string;
  companyId: string;
  role: Exclude<ProductRole, 'personal'>;
  departmentId?: string;
  positionId?: string;
}

const PERSONAL_CAPABILITIES: ProductCapability[] = [
  'agent:base',
  'model:byok',
  'skill:built-in',
  'skill:auto-create',
  'schedule:write',
];

const ENTERPRISE_BASE_CAPABILITIES: ProductCapability[] = [
  'agent:base',
  // 内部测试阶段企业视图也使用成员自己的 API；中转站上线前不启用 model:otto。
  'model:byok',
  'skill:built-in',
  'skill:auto-create',
  'skill:market',
  'organization:read',
  'schedule:write',
  'billing:read',
];

function requireText(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${label}不能为空`);
  return clean;
}

export function createPersonalContext(input: PersonalContextInput): ProductContext {
  return {
    edition: 'personal',
    role: 'personal',
    userId: requireText(input.userId, '用户 ID'),
    ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
    capabilities: [...PERSONAL_CAPABILITIES],
  };
}

export function createEnterpriseContext(input: EnterpriseContextInput): ProductContext {
  const elevated = input.role === 'company_owner' || input.role === 'company_admin';
  const manager = elevated || input.role === 'manager';
  const capabilities = new Set<ProductCapability>(ENTERPRISE_BASE_CAPABILITIES);
  if (manager) capabilities.add('invite:issue');
  if (elevated) {
    capabilities.add('organization:manage');
    capabilities.add('billing:manage');
  }

  return {
    edition: 'enterprise',
    role: input.role,
    userId: requireText(input.userId, '用户 ID'),
    ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
    companyId: requireText(input.companyId, '企业 ID'),
    ...(input.departmentId?.trim() ? { departmentId: input.departmentId.trim() } : {}),
    ...(input.positionId?.trim() ? { positionId: input.positionId.trim() } : {}),
    capabilities: [...capabilities],
  };
}

// ---------------------------------------------------------------------------
// Manager profile -> initial organization framework
// ---------------------------------------------------------------------------

export interface ManagerProfileInput {
  managerId: string;
  managerName: string;
  companyName: string;
  industry?: string;
  employeeScale?: string;
  departmentNames?: string[];
}

export interface ManagerProfile extends ManagerProfileInput {
  managerId: string;
  managerName: string;
  companyName: string;
  createdAt: string;
}

export interface WorkspaceCompany {
  id: string;
  name: string;
  ownerUserId: string;
  parentCompanyId?: string;
}

export interface WorkspaceDepartment {
  id: string;
  companyId: string;
  name: string;
  parentDepartmentId?: string;
}

export interface WorkspacePosition {
  id: string;
  companyId: string;
  departmentId: string;
  title: string;
  incumbentUserId?: string;
}

export interface OrganizationFramework {
  rootCompanyId: string;
  companies: WorkspaceCompany[];
  departments: WorkspaceDepartment[];
  positions: WorkspacePosition[];
}

export interface ManagerWorkspace {
  profile: ManagerProfile;
  context: ProductContext;
  organization: OrganizationFramework;
}

const DEFAULT_DEPARTMENTS = ['产品与研发部', '市场与销售部', '财务与行政部'];

function uniqueDepartmentNames(input?: string[]): string[] {
  // 明确提供「CEO 办公室」时它就是管理层节点，不再额外制造一个重复的“管理层”。
  const hasCeoOffice = input?.some((name) => name.trim() === 'CEO 办公室') ?? false;
  const result = hasCeoOffice ? [] : ['管理层'];
  const seen = new Set(result);
  for (const raw of input ?? DEFAULT_DEPARTMENTS) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function newDomainId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function buildManagerWorkspace(
  input: ManagerProfileInput,
  now: Date = new Date(),
): ManagerWorkspace {
  const managerId = requireText(input.managerId, '管理者 ID');
  const managerName = requireText(input.managerName, '管理者姓名');
  const companyName = requireText(input.companyName, '企业名称');
  const companyId = newDomainId('company');

  const profile: ManagerProfile = {
    ...input,
    managerId,
    managerName,
    companyName,
    ...(input.industry?.trim() ? { industry: input.industry.trim() } : {}),
    ...(input.employeeScale?.trim() ? { employeeScale: input.employeeScale.trim() } : {}),
    ...(input.departmentNames ? { departmentNames: [...input.departmentNames] } : {}),
    createdAt: now.toISOString(),
  };

  const departments = uniqueDepartmentNames(input.departmentNames).map<WorkspaceDepartment>(
    (name) => ({ id: newDomainId('dept'), companyId, name }),
  );
  const management = departments.find((department) => department.name === '管理层')
    ?? departments.find((department) => department.name === 'CEO 办公室');
  if (!management) throw new Error('组织框架缺少管理层');

  const ceoPosition: WorkspacePosition = {
    id: newDomainId('position'),
    companyId,
    departmentId: management.id,
    title: 'CEO',
    incumbentUserId: managerId,
  };
  const leadPositions = departments
    .filter((department) => department.id !== management.id)
    .map<WorkspacePosition>((department) => ({
      id: newDomainId('position'),
      companyId,
      departmentId: department.id,
      title: `${department.name}负责人`,
    }));

  const organization: OrganizationFramework = {
    rootCompanyId: companyId,
    companies: [{ id: companyId, name: companyName, ownerUserId: managerId }],
    departments,
    positions: [ceoPosition, ...leadPositions],
  };
  const context = createEnterpriseContext({
    userId: managerId,
    displayName: managerName,
    companyId,
    role: 'company_owner',
    departmentId: management.id,
    positionId: ceoPosition.id,
  });

  return { profile, context, organization };
}

// ---------------------------------------------------------------------------
// Compact Ed25519 invite payloads
// ---------------------------------------------------------------------------

export type InviteKind = 'position' | 'company' | 'company_link';
export type CompanyLinkDirection = 'parent_invites_child' | 'child_requests_parent';
export type InviteRole = 'company_admin' | 'manager' | 'member';

export interface InviteClaims {
  version: 1;
  id: string;
  kind: InviteKind;
  issuerUserId: string;
  companyId: string;
  departmentId?: string;
  positionId?: string;
  role?: InviteRole;
  direction?: CompanyLinkDirection;
  targetCompanyId?: string;
  issuedAt: string;
  expiresAt: string;
}

interface CompactInviteClaims {
  v: 1;
  j: string;
  k: 'p' | 'c' | 'l';
  i: string;
  c: string;
  d?: string;
  p?: string;
  r?: InviteRole;
  x?: 'pc' | 'cp';
  t?: string;
  a: number;
  e: number;
}

export interface SignedInvitePayload {
  /** Base64url-encoded compact claims. Does not contain organization snapshots. */
  payload: string;
  /** Base64url Ed25519 signature over `payload`. */
  signature: string;
  /** Transport form suitable for a short invite link. */
  token: string;
}

export interface InviteRedemption {
  inviteId: string;
  issuerUserId: string;
  redeemerUserId: string;
  kind: InviteKind;
  companyId: string;
  departmentId?: string;
  positionId?: string;
  role?: InviteRole;
  direction?: CompanyLinkDirection;
  targetCompanyId?: string;
  redeemedAt: string;
}

/**
 * Applies a verified one-time company-link redemption to the local CEO's
 * organization tree. The signed link intentionally carries references only,
 * so a newly linked remote company uses a neutral placeholder name until a
 * trusted enterprise directory provides its full profile.
 */
export function applyCompanyLinkRedemption(
  organization: OrganizationFramework,
  localCompanyId: string,
  redemption: InviteRedemption,
): OrganizationFramework {
  if (redemption.kind !== 'company_link' || !redemption.direction) {
    throw new Error('该链接不是父子公司接入用途');
  }
  const localId = requireText(localCompanyId, '本地企业 ID');
  const remoteId = requireText(redemption.companyId, '关联企业 ID');
  const issuerUserId = requireText(redemption.issuerUserId, '签发人 ID');
  if (redemption.targetCompanyId && redemption.targetCompanyId !== localId) {
    throw new Error('该链接指定的目标企业与当前企业不匹配');
  }
  if (remoteId === localId) throw new Error('不能将企业与自己建立父子关联');

  const companies = organization.companies.map((company) => ({ ...company }));
  const localCompany = companies.find((company) => company.id === localId);
  if (!localCompany) throw new Error('当前企业不在本地组织框架中');

  let remoteCompany = companies.find((company) => company.id === remoteId);
  if (!remoteCompany) {
    remoteCompany = {
      id: remoteId,
      name: `关联企业（${remoteId.slice(-8)}）`,
      ownerUserId: issuerUserId,
    };
    companies.push(remoteCompany);
  }

  if (redemption.direction === 'parent_invites_child') {
    if (localCompany.parentCompanyId === remoteId) throw new Error('该总公司已关联');
    if (localCompany.parentCompanyId) throw new Error('当前企业已有总公司');
    localCompany.parentCompanyId = remoteId;
  } else {
    if (remoteCompany.parentCompanyId === localId) throw new Error('该子公司已关联');
    if (remoteCompany.parentCompanyId) throw new Error('该子公司已隶属其他总公司');
    remoteCompany.parentCompanyId = localId;
  }

  const byId = new Map(companies.map((company) => [company.id, company]));
  for (const company of companies) {
    const visited = new Set<string>();
    let cursor: WorkspaceCompany | undefined = company;
    while (cursor) {
      if (visited.has(cursor.id)) throw new Error('父子公司关联会形成循环');
      visited.add(cursor.id);
      cursor = cursor.parentCompanyId ? byId.get(cursor.parentCompanyId) : undefined;
    }
  }

  let rootCompanyId = localId;
  const rootVisited = new Set<string>();
  while (true) {
    if (rootVisited.has(rootCompanyId)) throw new Error('父子公司关联会形成循环');
    rootVisited.add(rootCompanyId);
    const parentId = byId.get(rootCompanyId)?.parentCompanyId;
    if (!parentId) break;
    rootCompanyId = parentId;
  }

  return {
    rootCompanyId,
    companies,
    departments: organization.departments.map((department) => ({ ...department })),
    positions: organization.positions.map((position) => ({ ...position })),
  };
}

type KeyMaterial = KeyObject | string | Buffer;

function derivePublicKey(privateKey: KeyMaterial): KeyObject {
  if (privateKey instanceof KeyObject) {
    return createPublicKey(privateKey.export({ format: 'pem', type: 'pkcs8' }));
  }
  return createPublicKey(privateKey);
}

export interface Ed25519InviteServiceOptions {
  privateKey?: KeyMaterial;
  publicKey?: KeyMaterial;
  now?: () => Date;
  idFactory?: () => string;
}

interface BaseInviteInput {
  issuerUserId: string;
  companyId: string;
  expiresInSeconds?: number;
}

export interface PositionInviteInput extends BaseInviteInput {
  departmentId: string;
  positionId: string;
}

export interface CompanyInviteInput extends BaseInviteInput {
  role?: InviteRole;
}

export interface CompanyLinkInviteInput extends BaseInviteInput {
  direction: CompanyLinkDirection;
  targetCompanyId?: string;
}

const DEFAULT_INVITE_TTL_SECONDS = 24 * 60 * 60;
const MAX_INVITE_TTL_SECONDS = 30 * 24 * 60 * 60;

function encodeCompactClaims(claims: CompactInviteClaims): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

function decodeCanonicalBase64Url(value: string, label: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label}格式无效`);
  }
  const decoded = Buffer.from(value, 'base64url');
  // Node's decoder accepts non-canonical trailing bits. Round-tripping closes
  // that ambiguity so changing any token character is always detected.
  if (decoded.toString('base64url') !== value) {
    throw new Error(`${label}格式无效`);
  }
  return decoded;
}

function decodeCompactClaims(payload: string): CompactInviteClaims {
  try {
    return JSON.parse(
      decodeCanonicalBase64Url(payload, '邀请 payload ').toString('utf8'),
    ) as CompactInviteClaims;
  } catch {
    throw new Error('邀请 payload 格式无效');
  }
}

function parseInviteToken(token: string): { payload: string; signature: string } {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('邀请 token 格式无效');
  }
  return { payload: parts[0], signature: parts[1] };
}

function validateTtl(value?: number): number {
  const ttl = value ?? DEFAULT_INVITE_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_INVITE_TTL_SECONDS) {
    throw new Error('邀请有效期必须是 1 秒到 30 天之间的整数');
  }
  return ttl;
}

function compactKind(kind: InviteKind): CompactInviteClaims['k'] {
  return kind === 'position' ? 'p' : kind === 'company' ? 'c' : 'l';
}

function expandKind(kind: CompactInviteClaims['k']): InviteKind {
  if (kind === 'p') return 'position';
  if (kind === 'c') return 'company';
  if (kind === 'l') return 'company_link';
  throw new Error('邀请类型无效');
}

function compactDirection(direction: CompanyLinkDirection): 'pc' | 'cp' {
  return direction === 'parent_invites_child' ? 'pc' : 'cp';
}

function expandDirection(direction: 'pc' | 'cp'): CompanyLinkDirection {
  return direction === 'pc' ? 'parent_invites_child' : 'child_requests_parent';
}

export class Ed25519InviteService {
  private readonly privateKey?: KeyMaterial;
  private readonly publicKey: KeyMaterial;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: Ed25519InviteServiceOptions) {
    if (!options.privateKey && !options.publicKey) {
      throw new Error('邀请服务至少需要 Ed25519 公钥');
    }
    this.privateKey = options.privateKey;
    this.publicKey = options.publicKey ?? derivePublicKey(options.privateKey as KeyMaterial);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  issuePositionInvite(input: PositionInviteInput): SignedInvitePayload {
    return this.issue('position', input, {
      d: requireText(input.departmentId, '部门 ID'),
      p: requireText(input.positionId, '职位 ID'),
    });
  }

  issueCompanyInvite(input: CompanyInviteInput): SignedInvitePayload {
    return this.issue('company', input, { r: input.role ?? 'member' });
  }

  issueCompanyLinkInvite(input: CompanyLinkInviteInput): SignedInvitePayload {
    return this.issue('company_link', input, {
      x: compactDirection(input.direction),
      ...(input.targetCompanyId?.trim() ? { t: input.targetCompanyId.trim() } : {}),
    });
  }

  private issue(
    kind: InviteKind,
    input: BaseInviteInput,
    extra: Partial<CompactInviteClaims>,
  ): SignedInvitePayload {
    if (!this.privateKey) throw new Error('当前邀请服务只有公钥，不能签发邀请');
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const claims: CompactInviteClaims = {
      v: 1,
      j: requireText(this.idFactory(), '邀请 ID'),
      k: compactKind(kind),
      i: requireText(input.issuerUserId, '签发人 ID'),
      c: requireText(input.companyId, '企业 ID'),
      a: issuedAt,
      e: issuedAt + validateTtl(input.expiresInSeconds),
      ...extra,
    };
    const payload = encodeCompactClaims(claims);
    const signature = signBytes(null, Buffer.from(payload, 'utf8'), this.privateKey).toString(
      'base64url',
    );
    return { payload, signature, token: `${payload}.${signature}` };
  }

  verify(token: string, at: Date = this.now()): InviteClaims {
    const { payload, signature } = parseInviteToken(token);
    let signatureBytes: Buffer;
    try {
      signatureBytes = decodeCanonicalBase64Url(signature, '邀请签名');
    } catch {
      throw new Error('邀请签名格式无效');
    }
    const valid = verifyBytes(
      null,
      Buffer.from(payload, 'utf8'),
      this.publicKey,
      signatureBytes,
    );
    if (!valid) throw new Error('邀请签名校验失败');

    const raw = decodeCompactClaims(payload);
    if (
      raw.v !== 1 ||
      !raw.j ||
      !raw.i ||
      !raw.c ||
      !Number.isSafeInteger(raw.a) ||
      !Number.isSafeInteger(raw.e) ||
      raw.e <= raw.a
    ) {
      throw new Error('邀请 payload 字段无效');
    }
    const kind = expandKind(raw.k);
    if (kind === 'position' && (!raw.d || !raw.p)) {
      throw new Error('职位邀请缺少部门或职位引用');
    }
    if (kind === 'company_link' && raw.x !== 'pc' && raw.x !== 'cp') {
      throw new Error('父子公司邀请方向无效');
    }
    const nowSeconds = Math.floor(at.getTime() / 1000);
    if (raw.e <= nowSeconds) throw new Error('邀请已过期');

    return {
      version: 1,
      id: raw.j,
      kind,
      issuerUserId: raw.i,
      companyId: raw.c,
      ...(raw.d ? { departmentId: raw.d } : {}),
      ...(raw.p ? { positionId: raw.p } : {}),
      ...(raw.r ? { role: raw.r } : {}),
      ...(raw.x ? { direction: expandDirection(raw.x) } : {}),
      ...(raw.t ? { targetCompanyId: raw.t } : {}),
      issuedAt: new Date(raw.a * 1000).toISOString(),
      expiresAt: new Date(raw.e * 1000).toISOString(),
    };
  }

  /**
   * Builds the immutable receipt a future server route can persist inside the
   * same transaction that joins/links the user. The route must enforce a
   * UNIQUE constraint on `inviteId`; this pure domain intentionally does not
   * pretend an in-memory Set can provide durable one-time redemption.
   */
  createRedemption(
    token: string,
    redeemerUserId: string,
    at: Date = this.now(),
  ): InviteRedemption {
    const claims = this.verify(token, at);
    return {
      inviteId: claims.id,
      issuerUserId: claims.issuerUserId,
      redeemerUserId: requireText(redeemerUserId, '核销用户 ID'),
      kind: claims.kind,
      companyId: claims.companyId,
      ...(claims.departmentId ? { departmentId: claims.departmentId } : {}),
      ...(claims.positionId ? { positionId: claims.positionId } : {}),
      ...(claims.role ? { role: claims.role } : {}),
      ...(claims.direction ? { direction: claims.direction } : {}),
      ...(claims.targetCompanyId ? { targetCompanyId: claims.targetCompanyId } : {}),
      redeemedAt: at.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Schedule domain
// ---------------------------------------------------------------------------

export interface ScheduleInput {
  date: string;
  title: string;
  startTime?: string;
  endTime?: string;
  notes?: string;
}

export interface ScheduleEntry extends ScheduleInput {
  id: string;
  ownerUserId: string;
  companyId?: string;
  createdAt: string;
}

export interface ScheduleBookOptions {
  idFactory?: () => string;
  now?: () => Date;
}

function validateDateKey(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期必须是 YYYY-MM-DD');
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error('日期不存在');
  }
  return date;
}

function validateTime(value: string, label: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${label}必须是 HH:mm`);
  }
  return value;
}

export class ScheduleBook {
  private readonly entries = new Map<string, ScheduleEntry>();
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: ScheduleBookOptions = {}) {
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  add(context: ProductContext, input: ScheduleInput): ScheduleEntry {
    const date = validateDateKey(input.date);
    const title = requireText(input.title, '日程标题');
    const startTime = input.startTime ? validateTime(input.startTime, '开始时间') : undefined;
    const endTime = input.endTime ? validateTime(input.endTime, '结束时间') : undefined;
    if (endTime && !startTime) throw new Error('填写结束时间时必须同时填写开始时间');
    if (startTime && endTime && endTime <= startTime) {
      throw new Error('结束时间必须晚于开始时间');
    }

    const id = requireText(this.idFactory(), '日程 ID');
    if (this.entries.has(id)) throw new Error(`日程 ID 重复：${id}`);
    const entry: ScheduleEntry = {
      id,
      ownerUserId: context.userId,
      ...(context.companyId ? { companyId: context.companyId } : {}),
      date,
      title,
      ...(startTime ? { startTime } : {}),
      ...(endTime ? { endTime } : {}),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      createdAt: this.now().toISOString(),
    };
    this.entries.set(id, entry);
    return { ...entry };
  }

  remove(context: ProductContext, eventId: string): boolean {
    const id = requireText(eventId, '日程 ID');
    const entry = this.entries.get(id);
    if (!entry || entry.ownerUserId !== context.userId) return false;
    return this.entries.delete(id);
  }

  listByDate(context: ProductContext, date: string): ScheduleEntry[] {
    const key = validateDateKey(date);
    return [...this.entries.values()]
      .filter((entry) => entry.ownerUserId === context.userId && entry.date === key)
      .sort((a, b) => {
        const byTime = (a.startTime ?? '99:99').localeCompare(b.startTime ?? '99:99');
        return byTime || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      })
      .map((entry) => ({ ...entry }));
  }
}

// ---------------------------------------------------------------------------
// Credits and model multiplier catalogue
// ---------------------------------------------------------------------------

/**
 * Integer economics: one paid fen grants one displayed credit. Ten credits are
 * backed by nine fen of DeepSeek upstream budget, leaving the requested 10%.
 */
export const CREDIT_ECONOMICS = Object.freeze({
  creditsPerCny: 100,
  creditsPerFen: 1,
  deepSeekBudgetNumerator: 9,
  deepSeekBudgetDenominator: 10,
});

function requireSafeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负整数`);
  }
  return value;
}

export function purchaseCreditsFromFen(amountFen: number): number {
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
    throw new Error('购买金额必须是正整数分');
  }
  return amountFen * CREDIT_ECONOMICS.creditsPerFen;
}

export function creditsToDeepSeekBudgetFen(credits: number): number {
  const safeCredits = requireSafeNonNegativeInteger(credits, '积分');
  return Math.floor(
    (safeCredits * CREDIT_ECONOMICS.deepSeekBudgetNumerator) /
      CREDIT_ECONOMICS.deepSeekBudgetDenominator,
  );
}

export interface ModelCreditRule {
  modelId: string;
  displayName: string;
  creditMultiplier: number;
}

export interface ModelCreditDisplay extends ModelCreditRule {
  multiplierLabel: string;
}

interface StoredModelCreditRule {
  modelId: string;
  displayName: string;
  multiplierMilli: number;
}

const MULTIPLIER_SCALE = 1000;

function formatMultiplier(multiplierMilli: number): string {
  return String(multiplierMilli / MULTIPLIER_SCALE);
}

export class ModelCreditCatalog {
  private readonly rules = new Map<string, StoredModelCreditRule>();

  constructor(rules: ModelCreditRule[]) {
    for (const rule of rules) {
      const modelId = requireText(rule.modelId, '模型 ID');
      const displayName = requireText(rule.displayName, '模型名称');
      if (!Number.isFinite(rule.creditMultiplier) || rule.creditMultiplier <= 0) {
        throw new Error(`模型 ${modelId} 的积分倍率必须大于 0`);
      }
      const multiplierMilli = Math.round(rule.creditMultiplier * MULTIPLIER_SCALE);
      if (multiplierMilli <= 0 || !Number.isSafeInteger(multiplierMilli)) {
        throw new Error(`模型 ${modelId} 的积分倍率无效`);
      }
      if (this.rules.has(modelId)) throw new Error(`模型 ID 重复：${modelId}`);
      this.rules.set(modelId, { modelId, displayName, multiplierMilli });
    }
  }

  list(): ModelCreditDisplay[] {
    return [...this.rules.values()].map((rule) => {
      const creditMultiplier = rule.multiplierMilli / MULTIPLIER_SCALE;
      return {
        modelId: rule.modelId,
        displayName: rule.displayName,
        creditMultiplier,
        multiplierLabel: `${formatMultiplier(rule.multiplierMilli)}× 积分`,
      };
    });
  }

  charge(modelId: string, baseCredits: number): number {
    const rule = this.rules.get(requireText(modelId, '模型 ID'));
    if (!rule) throw new Error(`模型不存在：${modelId}`);
    const base = requireSafeNonNegativeInteger(baseCredits, '基础积分');
    return Math.ceil((base * rule.multiplierMilli) / MULTIPLIER_SCALE);
  }
}
