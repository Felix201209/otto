/**
 * otto-native Node.js 封装层
 *
 * 通过 stdin/stdout JSON-RPC 与 Rust 二进制通信
 * 类似 Linux 系统调用封装：用户态 → syscall → 内核态
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 二进制路径 — 优先用预编译的 bin，其次用 cargo 构建的
function findBinary(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'bin', 'otto-native.exe'),
    path.join(__dirname, '..', '..', 'rust-native', 'target', 'release', 'otto-native.exe'),
  ];
  return candidates.find((p) => {
    try {
      require('fs').accessSync(p);
      return true;
    } catch {
      return false;
    }
  }) || candidates[0]; // fallback to bin path even if missing
}

const BINARY_PATH = findBinary();

interface RpcRequest {
  id: number;
  method: string;
  params: Record<string, any>;
}

interface RpcResponse {
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

export class OttoNative {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private rl: any = null;
  private initialized = false;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * 启动 Rust 进程并初始化
   */
  async start(): Promise<void> {
    if (this.process) return;

    this.process = spawn(BINARY_PATH, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.process.on('exit', (code) => {
      console.error(`[otto-native] process exited with code ${code}`);
      this.process = null;
    });

    this.process.on('error', (err) => {
      console.error(`[otto-native] process error:`, err);
    });

    // stderr 输出日志
    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[otto-native] ${msg}`);
    });

    // stdout 读取 JSON-RPC 响应
    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on('line', (line: string) => {
      try {
        const resp: RpcResponse = JSON.parse(line);
        const pending = this.pending.get(resp.id);
        if (!pending) return;

        this.pending.delete(resp.id);

        if (resp.error) {
          pending.reject(new Error(`RPC error ${resp.error.code}: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      } catch (e) {
        console.error(`[otto-native] failed to parse response: ${line}`);
      }
    });

    // 初始化
    await this.call('init', { data_dir: this.dataDir, cache_size: 1000 });
    this.initialized = true;
  }

  /**
   * 停止 Rust 进程
   */
  stop(): void {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.initialized = false;
  }

  /**
   * 发送 JSON-RPC 请求
   */
  private call(method: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        reject(new Error('otto-native process not running'));
        return;
      }

      const id = this.nextId++;
      const req: RpcRequest = { id, method, params };

      this.pending.set(id, { resolve, reject });

      const line = JSON.stringify(req) + '\n';
      this.process.stdin.write(line);
    });
  }

  // ─── Session Store API ───

  async sessionGet(sessionId: string): Promise<any> {
    return this.call('session.get', { session_id: sessionId });
  }

  async sessionPut(metadata: {
    session_id: string;
    title: string;
    created_at: string;
    last_active_at: string;
    message_count: number;
    total_tokens: number;
    has_checkpoint: boolean;
    model?: string;
    workdir_hash?: string;
  }): Promise<void> {
    await this.call('session.put', metadata);
  }

  async sessionList(): Promise<any[]> {
    return this.call('session.list');
  }

  async sessionDelete(sessionId: string): Promise<void> {
    await this.call('session.delete', { session_id: sessionId });
  }

  async sessionGetHistory(sessionId: string): Promise<any> {
    return this.call('session.get_history', { session_id: sessionId });
  }

  async sessionPutHistory(sessionId: string, history: any[]): Promise<void> {
    await this.call('session.put_history', { session_id: sessionId, history });
  }

  async sessionStats(): Promise<any> {
    return this.call('session.stats');
  }

  // ─── Encryption Store API ───

  async secretStore(key: string, value: string): Promise<void> {
    await this.call('secret.store', { key, value });
  }

  async secretLoad(key: string): Promise<string | null> {
    const result = await this.call('secret.load', { key });
    return result?.value ?? null;
  }

  async secretDelete(key: string): Promise<void> {
    await this.call('secret.delete', { key });
  }

  // ─── Tokenizer API ───

  async countTokens(text: string, model: string = 'gpt-4'): Promise<number> {
    const result = await this.call('token.count', { text, model });
    return result.tokens;
  }

  async countTokensPrecise(text: string, model: string = 'gpt-4'): Promise<number> {
    const result = await this.call('token.count_precise', { text, model });
    return result.tokens;
  }

  async countTokensFast(text: string, model: string = 'gpt-4'): Promise<number> {
    const result = await this.call('token.count_fast', { text, model });
    return result.tokens;
  }

  // ─── Agent Pool API ───

  async poolAcquire(agentId: string, memoryLimitMb: number = 256): Promise<any> {
    return this.call('pool.acquire', { agent_id: agentId, memory_limit_mb: memoryLimitMb });
  }

  async poolRelease(agentId: string): Promise<void> {
    await this.call('pool.release', { agent_id: agentId });
  }

  async poolStats(): Promise<any> {
    return this.call('pool.stats');
  }

  async poolList(): Promise<any[]> {
    return this.call('pool.list');
  }

  async poolCleanup(): Promise<number> {
    const result = await this.call('pool.cleanup');
    return result.cleaned;
  }

  // ─── System ───

  async ping(): Promise<boolean> {
    const result = await this.call('ping');
    return result.pong;
  }

  async version(): Promise<any> {
    return this.call('version');
  }
}

// 单例
let instance: OttoNative | null = null;

export function getNativeInstance(dataDir?: string): OttoNative {
  if (!instance) {
    const dir = dataDir || path.join(process.cwd(), '.otto-native');
    instance = new OttoNative(dir);
  }
  return instance;
}

export async function initNativeUtils(dataDir?: string): Promise<OttoNative> {
  const inst = getNativeInstance(dataDir);
  await inst.start();
  return inst;
}
