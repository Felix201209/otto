# otto-rust-core

Otto 的高性能 Rust 核心层，提供 Session 存储、加密、Token 计算和 Agent 内存池管理。

## 功能模块

| 模块 | 功能 | 性能提升 |
|------|------|----------|
| **SessionStore** | sled 嵌入式 KV + LRU 缓存 | 写入 10x，内存 -60% |
| **EncryptionStore** | AES-256-GCM 加密存储 | 新增安全特性 |
| **Tokenizer** | tiktoken 本地 token 计数 | 零延迟，离线可用 |
| **AgentPool** | 内存池化 + LRU 淘汰 | 并发 agent 内存 -50% |

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    Node.js Application                   │
│  ┌─────────────────────────────────────────────────┐    │
│  │           @otto/native (JavaScript)              │    │
│  │  SessionStore | EncryptionStore | Tokenizer | ... │    │
│  └─────────────────────────────────────────────────┘    │
│                         │ stdin/stdout                   │
│                         ▼                                │
│  ┌─────────────────────────────────────────────────┐    │
│  │              otto-native (Rust)                  │    │
│  │  sled | aes-gcm | tiktoken-rs | lru | parking_lot│    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## 快速开始

### 编译 Rust 二进制

```bash
# Windows (需要 MinGW-w64 或 MSVC)
cargo build --release

# Linux
cargo build --release --target x86_64-unknown-linux-gnu

# macOS
cargo build --release --target x86_64-apple-darwin
```

### Node.js 使用

```javascript
const { SessionStore, EncryptionStore, Tokenizer, AgentPool } = require('./src/index');

// Session Store
const store = new SessionStore('./sessions.db', 100);
await store.save('session-1', 'My Session', [
  { role: 'user', content: 'Hello', timestamp: Date.now() }
]);
const loaded = await store.load('session-1');

// Encryption Store
const key = EncryptionStore.generateKey();
const encStore = new EncryptionStore('./encrypted.db', key);
await encStore.save('secret', 'sensitive data');
const decrypted = await encStore.load('secret');

// Tokenizer
const tokenizer = new Tokenizer('gpt-4');
const count = await tokenizer.count('Hello, world!');
const truncated = await tokenizer.truncate('Long text...', 100);

// Agent Pool
const pool = new AgentPool(256, 10); // 256MB max, 10 agents max
await pool.register('agent-1', 50); // 50MB initial
await pool.addLog('agent-1', 'Processing...');
const stats = await pool.stats();
```

## API 参考

### SessionStore

```typescript
class SessionStore {
  constructor(dbPath: string, cacheSize?: number, binaryPath?: string);
  
  async save(id: string, title: string, messages: Message[]): Promise<void>;
  async load(id: string): Promise<SessionData | null>;
  async delete(id: string): Promise<boolean>;
  async list(): Promise<SessionMeta[]>;
  async sizeBytes(): Promise<number>;
  async close(): Promise<void>;
}
```

### EncryptionStore

```typescript
class EncryptionStore {
  constructor(dbPath: string, key: string, binaryPath?: string);
  
  static generateKey(): string; // 生成 64 位 hex 密钥
  async save(id: string, data: string): Promise<void>;
  async load(id: string): Promise<string | null>;
  async delete(id: string): Promise<boolean>;
  async listIds(): Promise<string[]>;
  async close(): Promise<void>;
}
```

### Tokenizer

```typescript
class Tokenizer {
  constructor(model: string, binaryPath?: string);
  
  async count(text: string): Promise<number>;
  async truncate(text: string, maxTokens: number): Promise<string>;
  static supportedModels(binaryPath?: string): Promise<string[]>;
  async close(): Promise<void>;
}
```

### AgentPool

```typescript
class AgentPool {
  constructor(maxMemoryMb?: number, maxAgents?: number, binaryPath?: string);
  
  async register(id: string, memoryMb?: number): Promise<boolean>;
  async unregister(id: string): Promise<boolean>;
  async updateMemory(id: string, memoryMb: number): Promise<boolean>;
  async addLog(id: string, log: string): Promise<boolean>;
  async drainPending(id: string): Promise<string[]>;
  async stats(): Promise<{ current_memory_mb: number; max_memory_mb: number; agent_count: number }>;
  async listAgents(): Promise<AgentInfo[]>;
  async cleanupIdle(idleSeconds?: number): Promise<number>;
  async close(): Promise<void>;
}
```

## 性能基准

| 操作 | JS 实现 | Rust 实现 | 提升 |
|------|---------|-----------|------|
| Session 写入 | ~50ms | ~5ms | **10x** |
| Session 读取 | ~30ms | ~3ms | **10x** |
| Token 计数 | ~200ms (网络) | ~1ms (本地) | **200x** |
| 内存占用 | ~80MB | ~30MB | **60%↓** |

## 依赖

### Rust
- `sled` - 嵌入式 KV 数据库
- `aes-gcm` - AES-256-GCM 加密
- `tiktoken-rs` - Token 计算
- `lru` - LRU 缓存
- `parking_lot` - 高性能锁

### Node.js
- 无外部依赖（纯 stdlib）

## 许可证

MIT
