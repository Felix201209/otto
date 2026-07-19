# otto-rust-core

Otto 的 Rust 原生核心层 — 类似 Linux 内核的模块化架构。

## 架构

```
┌─────────────────────────────────────────────┐
│            Node.js / Electron               │
│         (用户态 - 不变的部分)                │
├─────────────────────────────────────────────┤
│         JSON-RPC 稳定接口层                  │  ← syscall ABI
│    (method + params → result, 永远不变)      │
├──────┬──────┬──────┬──────┬──────┬──────────┤
│Session│Encrypt│Token │Agent │Memory│ ...    │  ← 可插拔子系统
│ Store │ Store │izer  │ Pool │Store │        │
├──────┴──────┴──────┴──────┴──────┴──────────┤
│         Trait 抽象层 (Rust)                  │  ← VFS 层
│  每个子系统定义 trait，后端可替换             │
├──────┬──────┬──────┬──────┬──────────────────┤
│ sled │ AES  │tiktoken│ LRU │ rocksdb/自定义  │  ← 具体实现
└──────┴──────┴──────┴──────┴──────────────────┘
```

## 设计原则

1. **接口冻结** — JSON-RPC method 名和参数格式一旦发布就不改
2. **Trait 隔离** — 每个子系统是 trait，换实现不改接口
3. **子系统独立** — SessionStore 重写不影响 Tokenizer
4. **渐进式替换** — JS 实现和 Rust 实现可以并存，逐步迁移

## 模块

### SessionStore (`session_store.rs`)
- **后端**: sled 嵌入式 KV（类似 ext4）
- **缓存**: LRU 内存缓存（热数据加速）
- **接口**: `SessionBackend` trait（可替换为 rocksdb/memory）
- **性能**: 写入 ~5ms（原 JS ~50ms），**10x 提升**

### EncryptionStore (`encryption_store.rs`)
- **算法**: AES-256-GCM（认证加密）
- **密钥**: 从 machine-id 派生（跨重启稳定）
- **后端**: `EncryptionBackend` trait（file/vault/memory）
- **功能**: API key 等敏感数据加密存储

### Tokenizer (`tokenizer.rs`)
- **精确模式**: tiktoken（离线可用，~1ms/次）
- **快速模式**: 字符统计估算（~0.01ms/次）
- **智能模式**: 短文本精确，长文本快速+校准
- **性能**: 比 API 调用 **200x 快**

### AgentPool (`agent_pool.rs`)
- **池化**: 预分配 agent 槽位，避免频繁分配
- **LRU 淘汰**: 最久不用的 agent 优先回收
- **内存追踪**: 防止 OOM，限制总内存使用
- **统计**: 峰值内存、淘汰次数、活跃数

## JSON-RPC 接口

### 初始化
```json
→ {"id":1,"method":"init","params":{"data_dir":"./.otto","cache_size":1000}}
← {"id":1,"result":{"status":"ok"}}
```

### Session Store
```json
→ {"id":2,"method":"session.put","params":{"session_id":"abc","title":"Test",...}}
← {"id":2,"result":{"status":"ok"}}

→ {"id":3,"method":"session.get","params":{"session_id":"abc"}}
← {"id":3,"result":{"session_id":"abc","title":"Test",...}}

→ {"id":4,"method":"session.list","params":{}}
← {"id":4,"result":[...]}

→ {"id":5,"method":"session.delete","params":{"session_id":"abc"}}
← {"id":5,"result":{"status":"ok"}}
```

### Encryption Store
```json
→ {"id":6,"method":"secret.store","params":{"key":"api-key","value":"sk-..."}}
← {"id":6,"result":{"status":"ok"}}

→ {"id":7,"method":"secret.load","params":{"key":"api-key"}}
← {"id":7,"result":{"value":"sk-..."}}
```

### Tokenizer
```json
→ {"id":8,"method":"token.count","params":{"text":"Hello world","model":"gpt-4"}}
← {"id":8,"result":{"tokens":2}}
```

### Agent Pool
```json
→ {"id":9,"method":"pool.acquire","params":{"agent_id":"agent-1","memory_limit_mb":256}}
← {"id":9,"result":{"agent_id":"agent-1","status":"Active",...}}

→ {"id":10,"method":"pool.release","params":{"agent_id":"agent-1"}}
← {"id":10,"result":{"status":"ok"}}

→ {"id":11,"method":"pool.stats","params":{}}
← {"id":11,"result":{"active_agents":1,"total_memory_mb":256,...}}
```

## Node.js 使用

```typescript
import { initNativeUtils, countTokensLocal, storeSecret, loadSecret } from './utils/nativeUtils.js';

// 启动时初始化
await initNativeUtils(projectRoot);

// Token 计数（本地，~1ms）
const tokens = await countTokensLocal('Hello world', 'gpt-4');

// 加密存储
await storeSecret('api-key', 'sk-...');
const key = await loadSecret('api-key');
```

## 编译

```bash
# Windows (需要 MinGW-w64)
cd packages/core/rust-native
cargo build --release

# 二进制位置
# packages/core/rust-native/target/release/otto-native.exe
# packages/core/bin/otto-native.exe (副本)
```

## 性能对比

| 功能 | 原 JS 实现 | Rust 实现 | 提升 |
|------|-----------|-----------|------|
| Token 计数 | ~200ms (网络) | ~1ms (本地) | **200x** |
| Session 写入 | ~50ms | ~5ms | **10x** |
| 加密存储 | 无 | AES-256-GCM | **新增** |
| Agent 内存 | ~80MB | ~30MB | **60%↓** |

## 扩展

添加新模块：
1. 在 `src/` 下创建新 `.rs` 文件
2. 定义 trait 接口（可替换后端）
3. 在 `main.rs` 中添加 JSON-RPC method
4. 在 `protocol.rs` 中添加类型定义
5. 在 `native/index.ts` 中添加 Node.js 封装
