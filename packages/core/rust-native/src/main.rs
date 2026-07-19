/// otto-native — Rust 核心层入口
///
/// 架构类似 Linux 内核：
/// - 稳定的 JSON-RPC 接口（syscall ABI）
/// - 可插拔子系统（session / encrypt / token / pool）
/// - stdin/stdout 通信（Node.js 子进程调用）
///
/// 接口协议：
/// ```json
/// → {"id": 1, "method": "session.get", "params": {"session_id": "abc"}}
/// ← {"id": 1, "result": {...}}
/// ```
///
mod protocol;
mod session_store;
mod encryption_store;
mod tokenizer;
mod agent_pool;

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;

use protocol::*;
use session_store::SessionStore;
use encryption_store::{EncryptionStore, FileBackend};
use tokenizer::Tokenizer;
use agent_pool::AgentPool;

/// 全局状态 — 所有子系统的持有者
struct OttoCore {
    session_store: Option<SessionStore>,
    encryption_store: Option<EncryptionStore>,
    tokenizer: Tokenizer,
    agent_pool: AgentPool,
}

impl OttoCore {
    fn new() -> Self {
        Self {
            session_store: None,
            encryption_store: None,
            tokenizer: Tokenizer::new(),
            agent_pool: AgentPool::new(32, 4096), // 32 agents, 4GB max
        }
    }

    /// 初始化 session store
    fn init_session_store(&mut self, data_dir: &str, cache_size: usize) -> Result<(), String> {
        let path = PathBuf::from(data_dir).join("sessions.db");
        let store = SessionStore::open_sled(&path, cache_size)?;
        self.session_store = Some(store);
        Ok(())
    }

    /// 初始化 encryption store
    fn init_encryption_store(&mut self, data_dir: &str) -> Result<(), String> {
        let secrets_dir = PathBuf::from(data_dir).join("secrets");
        let backend = Arc::new(FileBackend::open(&secrets_dir)?);
        let store = EncryptionStore::from_machine_id(backend)?;
        self.encryption_store = Some(store);
        Ok(())
    }
}

/// JSON-RPC 方法分发
fn dispatch(core: &mut OttoCore, req: &RpcRequest) -> RpcResponse {
    match req.method.as_str() {
        // ─── 初始化 ───
        "init" => {
            let data_dir = req.params.get("data_dir")
                .and_then(|v| v.as_str())
                .unwrap_or(".otto-native");
            let cache_size = req.params.get("cache_size")
                .and_then(|v| v.as_u64())
                .unwrap_or(1000) as usize;

            if let Err(e) = core.init_session_store(data_dir, cache_size) {
                return RpcResponse::error(req.id, -1, format!("session store init: {}", e));
            }
            if let Err(e) = core.init_encryption_store(data_dir) {
                return RpcResponse::error(req.id, -2, format!("encryption store init: {}", e));
            }

            RpcResponse::success(req.id, serde_json::json!({"status": "ok"}))
        }

        // ─── Session Store ───
        "session.get" => {
            let store = match &core.session_store {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -10, "session store not initialized"),
            };
            let session_id = match req.params.get("session_id").and_then(|v| v.as_str()) {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -11, "missing session_id"),
            };

            match store.get_metadata(session_id) {
                Ok(Some(meta)) => RpcResponse::success(req.id, serde_json::to_value(meta).unwrap()),
                Ok(None) => RpcResponse::success(req.id, serde_json::Value::Null),
                Err(e) => RpcResponse::error(req.id, -12, e),
            }
        }

        "session.put" => {
            let store = match &core.session_store {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -10, "session store not initialized"),
            };
            let meta: SessionMetadata = match serde_json::from_value(req.params.clone()) {
                Ok(m) => m,
                Err(e) => return RpcResponse::error(req.id, -13, format!("invalid metadata: {}", e)),
            };

            match store.put_metadata(&meta) {
                Ok(()) => RpcResponse::success(req.id, serde_json::json!({"status": "ok"})),
                Err(e) => RpcResponse::error(req.id, -14, e),
            }
        }

        "session.list" => {
            let store = match &core.session_store {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -10, "session store not initialized"),
            };
            let sessions = store.list_sessions();
            RpcResponse::success(req.id, serde_json::to_value(sessions).unwrap())
        }

        "session.delete" => {
            let store = match &core.session_store {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -10, "session store not initialized"),
            };
            let session_id = match req.params.get("session_id").and_then(|v| v.as_str()) {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -11, "missing session_id"),
            };

            match store.delete_session(session_id) {
                Ok(()) => RpcResponse::success(req.id, serde_json::json!({"status": "ok"})),
                Err(e) => RpcResponse::error(req.id, -15, e),
            }
        }

        "session.get_history" => {
            let store = match &core.session_store {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -10, "session store not initialized"),
            };
            let session_id = match req.params.get("session_id").and_then(|v| v.as_str()) {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -11, "missing session_id"),
            };

            match store.get_history(session_id) {
                Ok(Some(json)) => RpcResponse::success(req.id, serde_json::json!({"history": serde_json::from_str::<serde_json::Value>(&json).unwrap_or(serde_json::Value::Null)})),
                Ok(None) => RpcResponse::success(req.id, serde_json::json!({"history": null})),
                Err(e) => RpcResponse::error(req.id, -16, e),
            }
        }

        "session.put_history" => {
            let store = match &core.session_store {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -10, "session store not initialized"),
            };
            let session_id = match req.params.get("session_id").and_then(|v| v.as_str()) {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -11, "missing session_id"),
            };
            let history = match req.params.get("history") {
                Some(h) => h.to_string(),
                None => return RpcResponse::error(req.id, -17, "missing history"),
            };

            match store.put_history(session_id, &history) {
                Ok(()) => RpcResponse::success(req.id, serde_json::json!({"status": "ok"})),
                Err(e) => RpcResponse::error(req.id, -18, e),
            }
        }

        "session.stats" => {
            let store = match &core.session_store {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -10, "session store not initialized"),
            };
            RpcResponse::success(req.id, store.stats())
        }

        // ─── Encryption Store ───
        "secret.store" => {
            let store = match &core.encryption_store {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -20, "encryption store not initialized"),
            };
            let params: StoreSecretParams = match serde_json::from_value(req.params.clone()) {
                Ok(p) => p,
                Err(e) => return RpcResponse::error(req.id, -21, format!("invalid params: {}", e)),
            };

            match store.store_secret(&params.key, &params.value) {
                Ok(()) => RpcResponse::success(req.id, serde_json::json!({"status": "ok"})),
                Err(e) => RpcResponse::error(req.id, -22, e),
            }
        }

        "secret.load" => {
            let store = match &core.encryption_store {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -20, "encryption store not initialized"),
            };
            let params: LoadSecretParams = match serde_json::from_value(req.params.clone()) {
                Ok(p) => p,
                Err(e) => return RpcResponse::error(req.id, -21, format!("invalid params: {}", e)),
            };

            match store.load_secret(&params.key) {
                Ok(Some(value)) => RpcResponse::success(req.id, serde_json::json!({"value": value})),
                Ok(None) => RpcResponse::success(req.id, serde_json::Value::Null),
                Err(e) => RpcResponse::error(req.id, -23, e),
            }
        }

        "secret.delete" => {
            let store = match &core.encryption_store {
                Some(s) => s,
                None => return RpcResponse::error(req.id, -20, "encryption store not initialized"),
            };
            let params: LoadSecretParams = match serde_json::from_value(req.params.clone()) {
                Ok(p) => p,
                Err(e) => return RpcResponse::error(req.id, -21, format!("invalid params: {}", e)),
            };

            match store.delete_secret(&params.key) {
                Ok(()) => RpcResponse::success(req.id, serde_json::json!({"status": "ok"})),
                Err(e) => RpcResponse::error(req.id, -24, e),
            }
        }

        // ─── Tokenizer ───
        "token.count" => {
            let params: CountTokensParams = match serde_json::from_value(req.params.clone()) {
                Ok(p) => p,
                Err(e) => return RpcResponse::error(req.id, -30, format!("invalid params: {}", e)),
            };

            match core.tokenizer.count_smart(&params.text, &params.model) {
                Ok(tokens) => RpcResponse::success(req.id, serde_json::json!({"tokens": tokens})),
                Err(e) => RpcResponse::error(req.id, -31, e),
            }
        }

        "token.count_precise" => {
            let params: CountTokensParams = match serde_json::from_value(req.params.clone()) {
                Ok(p) => p,
                Err(e) => return RpcResponse::error(req.id, -30, format!("invalid params: {}", e)),
            };

            match core.tokenizer.count_precise(&params.text, &params.model) {
                Ok(tokens) => RpcResponse::success(req.id, serde_json::json!({"tokens": tokens})),
                Err(e) => RpcResponse::error(req.id, -31, e),
            }
        }

        "token.count_fast" => {
            let params: CountTokensParams = match serde_json::from_value(req.params.clone()) {
                Ok(p) => p,
                Err(e) => return RpcResponse::error(req.id, -30, format!("invalid params: {}", e)),
            };

            match core.tokenizer.count_fast(&params.text, &params.model) {
                Ok(tokens) => RpcResponse::success(req.id, serde_json::json!({"tokens": tokens})),
                Err(e) => RpcResponse::error(req.id, -31, e),
            }
        }

        // ─── Agent Pool ───
        "pool.acquire" => {
            let params: AcquireAgentParams = match serde_json::from_value(req.params.clone()) {
                Ok(p) => p,
                Err(e) => return RpcResponse::error(req.id, -40, format!("invalid params: {}", e)),
            };

            match core.agent_pool.acquire(&params.agent_id, params.memory_limit_mb) {
                Ok(info) => RpcResponse::success(req.id, serde_json::to_value(info).unwrap()),
                Err(e) => RpcResponse::error(req.id, -41, e),
            }
        }

        "pool.release" => {
            let params: ReleaseAgentParams = match serde_json::from_value(req.params.clone()) {
                Ok(p) => p,
                Err(e) => return RpcResponse::error(req.id, -40, format!("invalid params: {}", e)),
            };

            match core.agent_pool.release(&params.agent_id) {
                Ok(()) => RpcResponse::success(req.id, serde_json::json!({"status": "ok"})),
                Err(e) => RpcResponse::error(req.id, -42, e),
            }
        }

        "pool.stats" => {
            RpcResponse::success(req.id, core.agent_pool.get_stats())
        }

        "pool.list" => {
            RpcResponse::success(req.id, serde_json::to_value(core.agent_pool.list_agents()).unwrap())
        }

        "pool.cleanup" => {
            let cleaned = core.agent_pool.cleanup_idle();
            RpcResponse::success(req.id, serde_json::json!({"cleaned": cleaned}))
        }

        // ─── 系统 ───
        "ping" => {
            RpcResponse::success(req.id, serde_json::json!({"pong": true}))
        }

        "version" => {
            RpcResponse::success(req.id, serde_json::json!({
                "version": "1.0.0",
                "build": "release",
            }))
        }

        _ => {
            RpcResponse::error(req.id, -99, format!("unknown method: {}", req.method))
        }
    }
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    let mut core = OttoCore::new();

    // 启动信号
    eprintln!("[otto-native] ready, waiting for JSON-RPC on stdin");

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[otto-native] stdin error: {}", e);
                break;
            }
        };

        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let req: RpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = RpcResponse::error(0, -100, format!("parse error: {}", e));
                let _ = writeln!(out, "{}", serde_json::to_string(&resp).unwrap());
                let _ = out.flush();
                continue;
            }
        };

        let resp = dispatch(&mut core, &req);
        let _ = writeln!(out, "{}", serde_json::to_string(&resp).unwrap());
        let _ = out.flush();
    }

    eprintln!("[otto-native] shutting down");
}
