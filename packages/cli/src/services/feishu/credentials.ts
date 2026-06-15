/**
 * @license
 * Copyright 2026 Otto team
 * https://github.com/Felix201209/otto.git
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书凭证管理 — 持久化 App ID / App Secret / Domain / 授权策略
 *
 * 安全模型（重要）：
 *   - 凭证文件以 0o600 (owner read/write only) 写入磁盘。
 *   - 文件本身使用 AES-256-GCM 做对称加密 + 完整性校验，密钥派生自一个
 *     一次性生成的 256-bit 随机字节，与凭证文件存放在同一目录下并同样
 *     设为 0o600。
 *   - **请理解此加密的真实威胁模型**：因密钥与密文同位，加密的主要价值
 *     是抵御"路径意外泄露 / cat 输出 / 备份扫描"等被动暴露场景，
 *     无法抵御能读取整个 ~/.otto-user 目录的攻击者。要更高安全等级请走
 *     OS keychain（macOS Keychain / Windows DPAPI / libsecret），
 *     这个工程改动较大，目前未实现。
 *
 *   - 仅接受经过认证加密的 AES-256-GCM 凭证（带 `gcm:` 前缀）。历史的
 *     AES-256-CBC 格式无完整性校验，会让能写入凭证文件的攻击者篡改 /
 *     padding-oracle 后经 JSON.parse 注入，因此已彻底移除：任何非 GCM
 *     blob 一律视为不可读（fail closed），需 `/feishu logout` 后重新 setup。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  /** 扫码建应用时拿到的 bot 信息 */
  botName?: string;
  botOpenId?: string;
  /** 手动输入时探测到的租户名 */
  tenantName?: string;
  /**
   * Bot 拥有者的飞书 open_id —— 通常是 setup 时扫码用户的 open_id。
   * 用于授权检查：默认仅此 open_id 可以触发 Bot 的 LLM/工具调用。
   */
  ownerOpenId?: string;
  /**
   * 额外的授权 open_id 白名单（除 ownerOpenId 外）。
   * 通过 `/feishu allow <openId>` 添加；`/feishu deny <openId>` 移除。
   */
  allowlist?: string[];
}

const FEISHU_CREDENTIALS_FILE = 'feishu-credentials.json';
const ENCRYPTION_KEY_FILE = 'feishu-key';

/**
 * 飞书凭证统一存放在用户全局目录 `~/.otto-user/`。
 *
 * 命名约定（重要，避免混淆）：
 *   - 全局：`<home>/.otto-user/`        ← 这里
 *   - 项目：`<projectRoot>/.otto/`
 * 飞书 Bot 凭证不区分项目，固定走全局，因此不接受 projectRoot 形参。
 */
function credDir(): string {
  return path.join(os.homedir(), '.otto-user');
}

function credPath(): string {
  return path.join(credDir(), FEISHU_CREDENTIALS_FILE);
}

function keyPath(): string {
  return path.join(credDir(), ENCRYPTION_KEY_FILE);
}

async function loadOrCreateKey(): Promise<Buffer> {
  const dir = credDir();
  const kp = keyPath();
  await fs.mkdir(dir, { recursive: true });
  try {
    const existing = await fs.readFile(kp);
    return existing;
  } catch {
    const key = crypto.randomBytes(32);
    await fs.writeFile(kp, key, { mode: 0o600 });
    return key;
  }
}

// --- AES-256-GCM (current format) ---

const GCM_PREFIX = 'gcm:';
const GCM_IV_BYTES = 12; // recommended for GCM

function encryptGcm(data: string, key: Buffer): string {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${GCM_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptGcm(payload: string, key: Buffer): string {
  const body = payload.slice(GCM_PREFIX.length);
  const [ivHex, tagHex, encHex] = body.split(':');
  if (!ivHex || !tagHex || !encHex) {
    throw new Error('Malformed GCM payload');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Distinguishes "credentials not yet configured" from "credentials are
 * present but cannot be decrypted" so callers can show actionable errors.
 */
export class CredentialsLoadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CredentialsLoadError';
  }
}

/**
 * Returns null when the credentials file does not exist.
 * Throws CredentialsLoadError on decryption / parse failure (so users
 * can be told to run `/feishu logout` and re-setup).
 */
export async function loadCredentials(): Promise<FeishuCredentials | null> {
  let encrypted: string;
  try {
    encrypted = (await fs.readFile(credPath(), 'utf8')).trim();
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw new CredentialsLoadError(
      `Failed to read Feishu credentials: ${(e as Error).message}`,
      e,
    );
  }

  let key: Buffer;
  try {
    key = await loadOrCreateKey();
  } catch (e: unknown) {
    throw new CredentialsLoadError(
      `Failed to read Feishu encryption key: ${(e as Error).message}`,
      e,
    );
  }

  try {
    // 只接受经过认证加密的 GCM 格式；非 GCM blob 一律拒绝（fail closed），
    // 不再回退到无完整性校验的 CBC，避免篡改 / 注入。
    if (!encrypted.startsWith(GCM_PREFIX)) {
      throw new Error('Unauthenticated or unrecognized credentials format');
    }
    const json = decryptGcm(encrypted, key);
    return JSON.parse(json) as FeishuCredentials;
  } catch (e: unknown) {
    throw new CredentialsLoadError(
      'Feishu credentials file is corrupted or was encrypted with a different key. ' +
        'Run `/feishu logout` to clear and re-setup.',
      e,
    );
  }
}

export async function saveCredentials(
  creds: FeishuCredentials,
): Promise<void> {
  await fs.mkdir(credDir(), { recursive: true });
  const key = await loadOrCreateKey();
  const json = JSON.stringify(creds);
  const encrypted = encryptGcm(json, key);
  await fs.writeFile(credPath(), encrypted, { mode: 0o600 });
}

export async function clearCredentials(): Promise<void> {
  try {
    await fs.unlink(credPath());
  } catch {
    // ignore
  }
}

/**
 * Authorization helper: returns true if the given Feishu open_id is allowed
 * to invoke the Bot's LLM/agent capabilities.
 *
 * Allowed iff:
 *   - openId equals creds.ownerOpenId, OR
 *   - openId is in creds.allowlist.
 *
 * If neither field is set (e.g. legacy credentials), we deny by default and
 * caller should prompt user to run `/feishu allow self` or upgrade.
 */
export function isSenderAuthorized(
  creds: FeishuCredentials,
  senderOpenId: string,
): boolean {
  if (!senderOpenId) return false;
  if (creds.ownerOpenId && creds.ownerOpenId === senderOpenId) return true;
  if (creds.allowlist?.includes(senderOpenId)) return true;
  return false;
}
