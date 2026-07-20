/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * v1.7 产品工作区的服务端权威存储。renderer 只拿脱敏快照；Ed25519 私钥
 * 单独存进 0600 secrets 文件，不进入 product-workspace.json 或线协议。
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Ed25519InviteService,
  applyCompanyLinkRedemption,
  buildManagerWorkspace,
  createEnterpriseContext,
  createPersonalContext,
  type InviteKind,
  type InviteRedemption,
  type ManagerWorkspace,
  type ProductContext,
} from './productWorkspace.js';

export interface WorkspaceMember {
  userId: string;
  displayName: string;
  companyId: string;
  departmentId?: string;
  departmentName?: string;
  positionId?: string;
  positionTitle?: string;
  role: ProductContext['role'];
}

export interface WorkspaceFriend {
  id: string;
  displayName: string;
  note?: string;
  createdAt: string;
}

export interface WorkspaceCreditAccount {
  balance: number;
  frozen: number;
  /** v1.7 尚未接支付；该字段明确提示 UI 这是设计态账户。 */
  status: 'design-preview' | 'active';
}

export interface ProductWorkspaceSnapshot {
  schemaVersion: 1;
  context: ProductContext;
  /**
   * 由中心企业服务认证的组织标识。它是只读展示信息，不等同于本机
   * managerWorkspace，也不会写入 product-workspace.json。
   */
  authenticatedOrganization?: {
    id: string;
    name: string;
  };
  /** 切回个人版时仍保留，便于之后无损恢复企业身份。 */
  managerWorkspace?: ManagerWorkspace;
  members: WorkspaceMember[];
  friends: WorkspaceFriend[];
  credits: WorkspaceCreditAccount;
  enterprisePublicKey?: string;
}

interface StoredWorkspace extends ProductWorkspaceSnapshot {
  personalUserId: string;
  personalDisplayName?: string;
  redemptions: InviteRedemption[];
}

export interface ConfigureManagerInput {
  managerName: string;
  companyName: string;
  industry?: string;
  employeeScale?: string;
}

export type IssueInviteInput =
  | {
      kind: 'position';
      departmentId: string;
      positionId: string;
      expiresInSeconds?: number;
    }
  | { kind: 'company'; expiresInSeconds?: number }
  | {
      kind: 'company_link';
      direction: 'parent_invites_child' | 'child_requests_parent';
      targetCompanyId?: string;
      expiresInSeconds?: number;
    };

export interface IssuedWorkspaceInvite {
  kind: InviteKind;
  link: string;
  expiresAt: string;
}

export interface AcceptInviteIdentity {
  userId: string;
  displayName: string;
}

export interface ProductWorkspaceStoreOptions {
  rootDir?: string;
  now?: () => Date;
}

/**
 * 已由中心企业服务认证的账号。role/tags 仅保留作输入兼容，绝不参与
 * 本地授权；授权唯一依据是中心服务签发的 isAdmin。
 */
export interface AuthenticatedEnterpriseAccount {
  id: string;
  organizationId: string;
  organizationName?: string;
  name: string;
  isAdmin: boolean;
  /**
   * 中心服务签发的短期身份租约（ISO-8601）。本机只在租约有效期内信任
   * 这份身份；过期后不会回退到可能仍是企业版的本机旧身份。
   */
  leaseExpiresAt: string;
  role?: string | null;
  tags?: string[];
  department?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
}

export type EnterpriseIdentityState =
  | { status: 'none'; account: null; fingerprint: 'none' }
  | {
      status: 'active' | 'expired';
      account: AuthenticatedEnterpriseAccount;
      fingerprint: string;
    };

const BASIC_DEPARTMENTS = [
  'CEO 办公室',
  '产品与研发部',
  '市场部',
  '销售与客户成功部',
  '财务部',
  '人力与行政部',
];

function cleanText(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${label}不能为空`);
  return clean;
}

function defaultRoot(): string {
  const configured = process.env['OTTO_USER_DIR']?.trim();
  return configured || path.join(os.homedir(), '.otto-user');
}

export class ProductWorkspaceStore {
  private readonly rootDir: string;
  private readonly statePath: string;
  private readonly privateKeyPath: string;
  private readonly publicKeyPath: string;
  private readonly now: () => Date;
  private state: StoredWorkspace;
  /** 中心身份只驻留内存；清除后无损恢复本机原始状态。 */
  private authenticatedAccount: AuthenticatedEnterpriseAccount | null = null;

  constructor(options: ProductWorkspaceStoreOptions = {}) {
    this.rootDir = options.rootDir ?? defaultRoot();
    this.statePath = path.join(this.rootDir, 'product-workspace.json');
    const secretsDir = path.join(this.rootDir, 'secrets');
    this.privateKeyPath = path.join(secretsDir, 'enterprise-invite-ed25519.pem');
    this.publicKeyPath = path.join(secretsDir, 'enterprise-invite-ed25519.pub.pem');
    this.now = options.now ?? (() => new Date());
    this.state = this.loadOrCreate();
  }

  snapshot(): ProductWorkspaceSnapshot {
    const identity = this.enterpriseIdentityState();
    if (identity.status === 'expired') {
      throw new Error('中心认证身份租约已过期，请重新登录');
    }
    if (identity.status === 'active') {
      const account = identity.account;
      const role: ProductContext['role'] = account.isAdmin
        ? 'company_admin'
        : 'member';
      const context = createEnterpriseContext({
        userId: account.id,
        displayName: account.name,
        companyId: account.organizationId,
        role,
        ...(account.positionId ? { positionId: account.positionId } : {}),
      });
      return JSON.parse(
        JSON.stringify({
          schemaVersion: 1,
          context,
          ...(account.organizationName
            ? {
                authenticatedOrganization: {
                  id: account.organizationId,
                  name: account.organizationName,
                },
              }
            : {}),
          members: [
            {
              userId: account.id,
              displayName: account.name,
              companyId: account.organizationId,
              ...(account.department
                ? { departmentName: account.department }
                : {}),
              ...(account.positionId
                ? { positionId: account.positionId }
                : {}),
              ...(account.positionTitle
                ? { positionTitle: account.positionTitle }
                : {}),
              role,
            },
          ],
          friends: this.state.friends,
          credits: this.state.credits,
        }),
      ) as ProductWorkspaceSnapshot;
    }
    return JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        context: this.state.context,
        ...(this.state.managerWorkspace ? { managerWorkspace: this.state.managerWorkspace } : {}),
        members: this.state.members,
        friends: this.state.friends,
        credits: this.state.credits,
        ...(this.state.enterprisePublicKey
          ? { enterprisePublicKey: this.state.enterprisePublicKey }
          : {}),
      }),
    ) as ProductWorkspaceSnapshot;
  }

  /**
   * 应用中心服务已经认证过的身份。该方法不落盘，调用方必须位于可信控制面；
   * null 表示注销并恢复此前本机工作区。
   */
  setAuthenticatedEnterpriseAccount(
    account: AuthenticatedEnterpriseAccount | null,
  ): ProductWorkspaceSnapshot {
    if (account === null) {
      this.authenticatedAccount = null;
      return this.snapshot();
    }
    const id = cleanText(account.id, '中心账号 ID');
    const organizationId = cleanText(account.organizationId, '中心企业 ID');
    const name = cleanText(account.name, '中心账号姓名');
    if (typeof account.isAdmin !== 'boolean') {
      throw new Error('中心账号 isAdmin 必须是布尔值');
    }
    const leaseExpiresAtMs = Date.parse(account.leaseExpiresAt);
    if (
      !Number.isFinite(leaseExpiresAtMs) ||
      leaseExpiresAtMs <= this.now().getTime()
    ) {
      throw new Error('中心认证身份租约无效或已过期');
    }
    this.authenticatedAccount = {
      id,
      organizationId,
      name,
      isAdmin: account.isAdmin,
      leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
      ...(account.organizationName?.trim()
        ? { organizationName: account.organizationName.trim() }
        : {}),
      ...(typeof account.role === 'string' || account.role === null
        ? { role: account.role }
        : {}),
      ...(Array.isArray(account.tags)
        ? { tags: account.tags.filter((tag): tag is string => typeof tag === 'string') }
        : {}),
      ...(typeof account.department === 'string' || account.department === null
        ? { department: account.department }
        : {}),
      ...(account.positionId?.trim()
        ? { positionId: account.positionId.trim() }
        : {}),
      ...(account.positionTitle?.trim()
        ? { positionTitle: account.positionTitle.trim() }
        : {}),
    };
    return this.snapshot();
  }

  /**
   * 返回中心身份的租约状态与稳定指纹。过期身份仍保留在内存中，直到可信
   * 控制面显式刷新或清除，以便调用方区分「已注销」和「租约过期」并 fail closed。
   */
  enterpriseIdentityState(): EnterpriseIdentityState {
    if (!this.authenticatedAccount) {
      return { status: 'none', account: null, fingerprint: 'none' };
    }
    const account = JSON.parse(
      JSON.stringify(this.authenticatedAccount),
    ) as AuthenticatedEnterpriseAccount;
    const status =
      Date.parse(account.leaseExpiresAt) > this.now().getTime()
        ? 'active'
        : 'expired';
    return {
      status,
      account,
      fingerprint: JSON.stringify({
        id: account.id,
        organizationId: account.organizationId,
        organizationName: account.organizationName ?? null,
        name: account.name,
        isAdmin: account.isAdmin,
        role: account.role ?? null,
        tags: [...(account.tags ?? [])].sort(),
        department: account.department ?? null,
        positionId: account.positionId ?? null,
        positionTitle: account.positionTitle ?? null,
      }),
    };
  }

  configureManager(input: ConfigureManagerInput): ProductWorkspaceSnapshot {
    this.assertLocalIdentityMutable();
    const managerName = cleanText(input.managerName, '管理者姓名');
    const companyName = cleanText(input.companyName, '企业名称');
    const workspace = buildManagerWorkspace(
      {
        managerId: this.state.personalUserId,
        managerName,
        companyName,
        industry: input.industry,
        employeeScale: input.employeeScale,
        departmentNames: BASIC_DEPARTMENTS,
      },
      this.now(),
    );
    const key = this.ensureInviteKeys().publicKey;
    this.state.context = workspace.context;
    this.state.managerWorkspace = workspace;
    this.state.personalDisplayName = managerName;
    this.state.enterprisePublicKey = key;
    this.state.members = [
      {
        userId: workspace.context.userId,
        displayName: managerName,
        companyId: workspace.context.companyId!,
        departmentId: workspace.context.departmentId,
        positionId: workspace.context.positionId,
        role: 'company_owner',
      },
    ];
    this.save();
    return this.snapshot();
  }

  switchToPersonal(): ProductWorkspaceSnapshot {
    this.assertLocalIdentityMutable();
    const wasEnterprise = this.state.context.edition === 'enterprise';
    const wasMember = this.state.context.role !== 'company_owner';
    this.state.context = createPersonalContext({
      userId: this.state.personalUserId,
      displayName: this.state.personalDisplayName,
    });
    // 非管理员的成员退出企业时，清除旧的红利与成员信息，
    // 使其可以接受一个新的职位邀请链接（不再报「该企业链接已使用」）。
    if (wasEnterprise && wasMember) {
      this.state.members = [];
      this.state.redemptions = [];
    }
    this.save();
    return this.snapshot();
  }

  /** 完全销毁本机所有用户数据——注销/退出企业时调用。 */
  destroyAllUserData(): void {
    try {
      // 递归删除整个 rootDir（默认 ~/.otto-user/）
      // 这会清除 product-workspace.json、会话历史、知识库、Skill、记忆等全部数据
      fs.rmSync(this.rootDir, { recursive: true, force: true });
    } catch {
      // rootDir 已不存在或权限不足，忽略
    }
    // 重建目录并创建全新的空白个人版状态
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.state = {
      schemaVersion: 1,
      personalUserId: randomUUID(),
      personalDisplayName: undefined,
      context: createPersonalContext({ userId: this.state.personalUserId || randomUUID() }),
      members: [],
      friends: [],
      credits: { balance: 0, frozen: 0, status: 'design-preview' },
      redemptions: [],
    };
    this.save();
  }

  issueInvite(input: IssueInviteInput): IssuedWorkspaceInvite {
    this.assertLocalIdentityMutable();
    if (!this.state.context.capabilities.includes('invite:issue')) {
      throw new Error('当前身份没有签发企业链接的权限');
    }
    const companyId = this.state.context.companyId;
    if (!companyId) throw new Error('当前没有企业上下文');
    if (input.kind === 'company_link' && this.state.context.role !== 'company_owner') {
      throw new Error('只有企业 CEO 可以签发父子公司链接');
    }
    const { privateKey, publicKey } = this.ensureInviteKeys();
    const service = new Ed25519InviteService({
      privateKey,
      publicKey,
      now: this.now,
    });
    const base = {
      issuerUserId: this.state.context.userId,
      companyId,
      expiresInSeconds: input.expiresInSeconds,
    };
    let signed;
    if (input.kind === 'position') {
      const organization = this.state.managerWorkspace?.organization;
      if (!organization?.departments.some((item) => item.id === input.departmentId)) {
        throw new Error('邀请部门不存在');
      }
      if (
        !organization.positions.some(
          (item) => item.id === input.positionId && item.departmentId === input.departmentId,
        )
      ) {
        throw new Error('邀请职位不存在或不属于该部门');
      }
      signed = service.issuePositionInvite({
        ...base,
        departmentId: input.departmentId,
        positionId: input.positionId,
      });
    } else if (input.kind === 'company_link') {
      signed = service.issueCompanyLinkInvite({
        ...base,
        direction: input.direction,
        targetCompanyId: input.targetCompanyId,
      });
    } else {
      signed = service.issueCompanyInvite({ ...base, role: 'member' });
    }
    const claims = service.verify(signed.token, this.now());
    const publicDer = Buffer.from(
      // 公钥文件使用 PEM；转换成单行 base64url，方便链接粘贴。
      publicKey,
      'utf8',
    ).toString('base64url');
    const params = new URLSearchParams({ token: signed.token, key: publicDer });
    return {
      kind: claims.kind,
      link: `otto://enterprise/join?${params.toString()}`,
      expiresAt: claims.expiresAt,
    };
  }

  acceptInvite(link: string, identity: AcceptInviteIdentity): ProductWorkspaceSnapshot {
    this.assertLocalIdentityMutable();
    const cleanUserId = cleanText(identity.userId, '用户 ID');
    const cleanDisplayName = cleanText(identity.displayName, '姓名');
    const redemption = this.createRedemptionFromLink(link, cleanUserId);
    if (this.state.redemptions.some((item) => item.inviteId === redemption.inviteId)) {
      throw new Error('该企业链接已使用');
    }
    if (redemption.kind === 'company_link') {
      throw new Error('父子公司链接需要由企业管理者在企业框架页接入');
    }
    const role = redemption.role ?? 'member';
    this.state.context = createEnterpriseContext({
      userId: cleanUserId,
      displayName: cleanDisplayName,
      companyId: redemption.companyId,
      role,
      departmentId: redemption.departmentId,
      positionId: redemption.positionId,
    });
    this.state.personalDisplayName = cleanDisplayName;
    this.state.redemptions.push(redemption);
    const member: WorkspaceMember = {
      userId: cleanUserId,
      displayName: cleanDisplayName,
      companyId: redemption.companyId,
      departmentId: redemption.departmentId,
      positionId: redemption.positionId,
      role,
    };
    this.state.members = [
      ...this.state.members.filter((item) => item.userId !== member.userId),
      member,
    ];
    this.save();
    return this.snapshot();
  }

  acceptCompanyLink(link: string): ProductWorkspaceSnapshot {
    this.assertLocalIdentityMutable();
    if (
      this.state.context.edition !== 'enterprise'
      || this.state.context.role !== 'company_owner'
      || !this.state.context.capabilities.includes('organization:manage')
    ) {
      throw new Error('只有当前企业的 CEO 才能接入总公司或子公司');
    }
    const workspace = this.state.managerWorkspace;
    const localCompanyId = this.state.context.companyId;
    if (!workspace || !localCompanyId) throw new Error('当前没有可管理的企业框架');

    const redemption = this.createRedemptionFromLink(link, this.state.context.userId);
    if (this.state.redemptions.some((item) => item.inviteId === redemption.inviteId)) {
      throw new Error('该企业链接已使用');
    }
    const organization = applyCompanyLinkRedemption(
      workspace.organization,
      localCompanyId,
      redemption,
    );
    this.state.managerWorkspace = { ...workspace, organization };
    this.state.redemptions.push(redemption);
    this.save();
    return this.snapshot();
  }

  private createRedemptionFromLink(link: string, redeemerUserId: string): InviteRedemption {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new Error('企业链接格式无效');
    }
    if (url.protocol !== 'otto:' || url.hostname !== 'enterprise' || url.pathname !== '/join') {
      throw new Error('企业链接格式无效');
    }
    const token = url.searchParams.get('token');
    const encodedKey = url.searchParams.get('key');
    if (!token || !encodedKey) throw new Error('企业链接缺少 token 或签名公钥');
    let publicKey: string;
    try {
      publicKey = Buffer.from(encodedKey, 'base64url').toString('utf8');
    } catch {
      throw new Error('企业链接签名公钥无效');
    }
    const service = new Ed25519InviteService({ publicKey, now: this.now });
    return service.createRedemption(
      token,
      cleanText(redeemerUserId, '用户 ID'),
      this.now(),
    );
  }

  addFriend(displayName: string, note?: string): ProductWorkspaceSnapshot {
    this.assertIdentityLeaseActiveIfPresent();
    const friend: WorkspaceFriend = {
      id: randomUUID(),
      displayName: cleanText(displayName, '好友姓名'),
      ...(note?.trim() ? { note: note.trim() } : {}),
      createdAt: this.now().toISOString(),
    };
    this.state.friends.push(friend);
    this.save();
    return this.snapshot();
  }

  private assertLocalIdentityMutable(): void {
    if (this.authenticatedAccount) {
      this.assertIdentityLeaseActiveIfPresent();
      throw new Error('中心认证身份生效中，不能修改本机企业身份');
    }
  }

  private assertIdentityLeaseActiveIfPresent(): void {
    if (this.enterpriseIdentityState().status === 'expired') {
      throw new Error('中心认证身份租约已过期，请重新登录');
    }
  }

  private loadOrCreate(): StoredWorkspace {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as StoredWorkspace;
      if (parsed.schemaVersion === 1 && parsed.context?.userId && parsed.personalUserId) {
        return parsed;
      }
    } catch {
      // 首启或损坏：下方创建安全默认值。旧文件不覆盖，save 用原子替换。
    }
    const personalUserId = `user_${randomUUID()}`;
    const initial: StoredWorkspace = {
      schemaVersion: 1,
      personalUserId,
      context: createPersonalContext({ userId: personalUserId }),
      members: [],
      friends: [],
      credits: { balance: 0, frozen: 0, status: 'design-preview' },
      redemptions: [],
    };
    this.state = initial;
    this.save();
    return initial;
  }

  private save(): void {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temp, this.statePath);
  }

  private ensureInviteKeys(): { privateKey: string; publicKey: string } {
    try {
      return {
        privateKey: fs.readFileSync(this.privateKeyPath, 'utf8'),
        publicKey: fs.readFileSync(this.publicKeyPath, 'utf8'),
      };
    } catch {
      const keys = generateKeyPairSync('ed25519');
      const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
      fs.mkdirSync(path.dirname(this.privateKeyPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600 });
      fs.writeFileSync(this.publicKeyPath, publicKey, { encoding: 'utf8', mode: 0o600 });
      return { privateKey, publicKey };
    }
  }
}
