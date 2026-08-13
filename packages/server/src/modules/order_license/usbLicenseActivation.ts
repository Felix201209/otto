import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyEd25519Envelope } from '../commercial_control/signedEnvelope.js';

const execFileAsync = promisify(execFile);
const REGISTRY_KEY = 'HKCU\\Software\\Otto\\UsbLicenses';

export interface UsbActivationOptions { licensePath: string; statePath: string }
export interface UsbActivationDeps {
  publicKeys: readonly string[];
  fingerprint(): Promise<string>;
  readProtectedState(licenseId: string): Promise<string | null>;
  writeProtectedState(licenseId: string, state: string): Promise<void>;
  now?: () => number;
}
interface ActivationState { licenseId: string; activationNonce: string; fingerprint: string; activatedAt: string }

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function activateUsbLicense(options: UsbActivationOptions, deps: UsbActivationDeps) {
  let envelope: Record<string, unknown>;
  try { envelope = object(JSON.parse(await readFile(options.licensePath, 'utf8'))); }
  catch { throw new Error('无法读取 U 盘许可证 license.bin'); }
  const license = object(envelope.license ?? envelope.payload);
  const signature = typeof envelope.signature === 'string' ? envelope.signature : '';
  const keyId = typeof envelope.signingKeyId === 'string' ? envelope.signingKeyId : null;
  if (!verifyEd25519Envelope(license, signature, deps.publicKeys, keyId).valid) {
    throw new Error('U 盘许可证签名无效，已拒绝启动');
  }
  const licenseId = String(license.id || '');
  const activationNonce = String(license.activationNonce || '');
  if (!licenseId || !activationNonce) throw new Error('U 盘许可证缺少激活标识');
  const fingerprint = await deps.fingerprint();
  const preboundFingerprint = String(license.machineFingerprint || '');
  if (preboundFingerprint && preboundFingerprint !== fingerprint) {
    throw new Error('许可证已绑定到另一台机器，无法激活');
  }
  let diskState: ActivationState | null = null;
  try { diskState = JSON.parse(await readFile(options.statePath, 'utf8')) as ActivationState; } catch { /* absent */ }
  const protectedRaw = await deps.readProtectedState(licenseId);
  let protectedState: ActivationState | null = null;
  try { protectedState = protectedRaw ? JSON.parse(protectedRaw) as ActivationState : null; }
  catch { throw new Error('本机许可证激活状态已损坏'); }
  for (const state of [diskState, protectedState]) {
    if (!state) continue;
    if (state.licenseId !== licenseId || state.activationNonce !== activationNonce) throw new Error('U 盘许可证激活状态不匹配');
    if (state.fingerprint !== fingerprint) throw new Error('许可证已在该 U 盘首次激活时绑定到另一台机器，无法再次激活');
  }
  const existing = diskState ?? protectedState;
  const state: ActivationState = existing ?? { licenseId, activationNonce, fingerprint,
    activatedAt: new Date((deps.now ?? Date.now)()).toISOString() };
  await mkdir(path.dirname(options.statePath), { recursive: true });
  await writeFile(options.statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await deps.writeProtectedState(licenseId, JSON.stringify(state));
  return { activated: !existing, fingerprint, license };
}

export async function windowsMachineFingerprint(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('U 盘许可证仅支持 Windows');
  const script = "$g=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid;$b=(Get-CimInstance Win32_BaseBoard).SerialNumber;$c=(Get-CimInstance Win32_Processor|Select-Object -First 1).ProcessorId;$d=(Get-CimInstance Win32_DiskDrive|Select-Object -First 1).SerialNumber;@($g,$b,$c,$d)-join \"`n\"";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  const material = stdout.trim();
  if (!material) throw new Error('无法计算 Windows 机器指纹');
  return createHash('sha256').update(material).digest('hex');
}

export function windowsProtectedActivationStore() {
  return {
    async readProtectedState(licenseId: string) {
      try { const { stdout } = await execFileAsync('reg.exe', ['query', REGISTRY_KEY, '/v', licenseId], { windowsHide: true });
        return stdout.trim().split(/\s{2,}/).at(-1) ?? null; } catch { return null; }
    },
    async writeProtectedState(licenseId: string, state: string) {
      await execFileAsync('reg.exe', ['add', REGISTRY_KEY, '/v', licenseId, '/t', 'REG_SZ', '/d', state, '/f'], { windowsHide: true });
    },
  };
}

export async function enforceUsbLicenseFromEnvironment(): Promise<void> {
  const licensePath = process.env.OTTO_USB_LICENSE_PATH?.trim();
  if (!licensePath) return;
  const userDir = process.env.OTTO_USER_DIR?.trim() || path.join(os.homedir(), '.otto-user');
  let configuredKeys = process.env.OTTO_LICENSE_PUBLIC_KEYS || process.env.OTTO_LICENSE_PUBLIC_KEY || '';
  const keyFile = process.env.OTTO_LICENSE_PUBLIC_KEY_FILE?.trim();
  if (!configuredKeys && keyFile) {
    try { configuredKeys = await readFile(keyFile, 'utf8'); }
    catch { throw new Error('U 盘许可证公钥文件不存在或无法读取'); }
  }
  const publicKeys = configuredKeys
    .split(/\r?\n\s*\r?\n|\s*\|\|\s*/).map((key) => key.trim()).filter(Boolean);
  if (publicKeys.length === 0) throw new Error('U 盘许可证未配置可信公钥');
  const registry = windowsProtectedActivationStore();
  await activateUsbLicense({ licensePath, statePath: path.join(userDir, 'license-state.json') }, {
    publicKeys, fingerprint: windowsMachineFingerprint, ...registry,
  });
}
