//! otto-native Rust core entrypoint.
//!
//! Node/Electron talks to this process over newline-delimited JSON-RPC.
//! Keep the process loop small; subsystem dispatch lives in `syscall`.

mod agent_pool;
mod encryption_store;
mod protocol;
mod session_store;
mod syscall;
mod tokenizer;

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;

use agent_pool::AgentPool;
use encryption_store::{EncryptionStore, FileBackend};
use protocol::{RpcRequest, RpcResponse};
use session_store::SessionStore;
use syscall::dispatch;
use tokenizer::Tokenizer;

pub(crate) struct OttoCore {
    pub(crate) session_store: Option<SessionStore>,
    pub(crate) encryption_store: Option<EncryptionStore>,
    pub(crate) tokenizer: Tokenizer,
    pub(crate) agent_pool: AgentPool,
}

impl OttoCore {
    fn new() -> Self {
        Self {
            session_store: None,
            encryption_store: None,
            tokenizer: Tokenizer::new(),
            agent_pool: AgentPool::new(32, 4096),
        }
    }

    pub(crate) fn init_session_store(
        &mut self,
        data_dir: &str,
        cache_size: usize,
    ) -> Result<(), String> {
        let path = PathBuf::from(data_dir).join("sessions.db");
        let store = SessionStore::open_sled(&path, cache_size)?;
        self.session_store = Some(store);
        Ok(())
    }

    pub(crate) fn init_encryption_store(&mut self, data_dir: &str) -> Result<(), String> {
        let secrets_dir = PathBuf::from(data_dir).join("secrets");
        let backend = Arc::new(FileBackend::open(&secrets_dir)?);
        let store = EncryptionStore::from_machine_id(backend)?;
        self.encryption_store = Some(store);
        Ok(())
    }
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    let mut core = OttoCore::new();

    eprintln!("[otto-native] ready, waiting for JSON-RPC on stdin");

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(e) => {
                eprintln!("[otto-native] stdin error: {e}");
                break;
            }
        };

        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let req: RpcRequest = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                let resp = RpcResponse::error(0, -100, format!("parse error: {e}"));
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
