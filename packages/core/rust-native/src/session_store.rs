//! Session storage subsystem.
//!
//! This is the Rust-side VFS-like layer for Otto sessions: stable store API,
//! replaceable backends, sled persistence by default, and an LRU metadata cache.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use lru::LruCache;
use parking_lot::RwLock;
use sha2::{Digest, Sha256};

use crate::protocol::{SessionIndex, SessionMetadata};

pub trait SessionBackend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String>;
    fn put(&self, key: &str, value: &[u8]) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
    fn list_prefix(&self, prefix: &str) -> Result<Vec<(String, Vec<u8>)>, String>;
    fn flush(&self) -> Result<(), String>;
}

pub struct SledBackend {
    db: sled::Db,
}

impl SledBackend {
    pub fn open(path: &Path) -> Result<Self, String> {
        let db = sled::open(path).map_err(|e| format!("sled open failed: {e}"))?;
        Ok(Self { db })
    }
}

impl SessionBackend for SledBackend {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        self.db
            .get(key.as_bytes())
            .map(|value| value.map(|item| item.to_vec()))
            .map_err(|e| format!("sled get: {e}"))
    }

    fn put(&self, key: &str, value: &[u8]) -> Result<(), String> {
        self.db
            .insert(key.as_bytes(), value)
            .map(|_| ())
            .map_err(|e| format!("sled put: {e}"))
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.db
            .remove(key.as_bytes())
            .map(|_| ())
            .map_err(|e| format!("sled delete: {e}"))
    }

    fn list_prefix(&self, prefix: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
        let mut results = Vec::new();
        for item in self.db.scan_prefix(prefix.as_bytes()) {
            let (key, value) = item.map_err(|e| format!("sled scan: {e}"))?;
            results.push((String::from_utf8_lossy(&key).to_string(), value.to_vec()));
        }
        Ok(results)
    }

    fn flush(&self) -> Result<(), String> {
        self.db
            .flush()
            .map(|_| ())
            .map_err(|e| format!("sled flush: {e}"))
    }
}

pub struct MemoryBackend {
    data: RwLock<HashMap<String, Vec<u8>>>,
}

impl MemoryBackend {
    pub fn new() -> Self {
        Self {
            data: RwLock::new(HashMap::new()),
        }
    }
}

impl SessionBackend for MemoryBackend {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.data.read().get(key).cloned())
    }

    fn put(&self, key: &str, value: &[u8]) -> Result<(), String> {
        self.data.write().insert(key.to_string(), value.to_vec());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.data.write().remove(key);
        Ok(())
    }

    fn list_prefix(&self, prefix: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
        let data = self.data.read();
        Ok(data
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect())
    }

    fn flush(&self) -> Result<(), String> {
        Ok(())
    }
}

pub struct SessionStore {
    backend: Arc<dyn SessionBackend>,
    cache: RwLock<LruCache<String, String>>,
    index: RwLock<SessionIndex>,
}

impl SessionStore {
    pub fn open_sled(path: &Path, cache_size: usize) -> Result<Self, String> {
        let backend: Arc<dyn SessionBackend> = Arc::new(SledBackend::open(path)?);
        let index = Self::load_index_from_backend(&backend)?;
        Ok(Self::new(backend, cache_size, index))
    }

    pub fn open_memory(cache_size: usize) -> Self {
        Self::new(
            Arc::new(MemoryBackend::new()),
            cache_size,
            SessionIndex {
                last_active_session: None,
                sessions: Vec::new(),
            },
        )
    }

    fn new(backend: Arc<dyn SessionBackend>, cache_size: usize, index: SessionIndex) -> Self {
        let capacity = std::num::NonZeroUsize::new(cache_size)
            .unwrap_or_else(|| std::num::NonZeroUsize::new(1000).unwrap());
        Self {
            backend,
            cache: RwLock::new(LruCache::new(capacity)),
            index: RwLock::new(index),
        }
    }

    fn load_index_from_backend(backend: &Arc<dyn SessionBackend>) -> Result<SessionIndex, String> {
        match backend.get("__index__")? {
            Some(data) => {
                let json = String::from_utf8_lossy(&data);
                serde_json::from_str(&json).map_err(|e| format!("index parse: {e}"))
            }
            None => Ok(SessionIndex {
                last_active_session: None,
                sessions: Vec::new(),
            }),
        }
    }

    fn save_index(&self) -> Result<(), String> {
        let index = self.index.read();
        let json = serde_json::to_string(&*index).map_err(|e| format!("index serialize: {e}"))?;
        self.backend.put("__index__", json.as_bytes())?;
        self.backend.flush()
    }

    pub fn get_metadata(&self, session_id: &str) -> Result<Option<SessionMetadata>, String> {
        let cache_key = format!("meta:{session_id}");

        {
            let mut cache = self.cache.write();
            if let Some(cached) = cache.get(&cache_key) {
                let meta = serde_json::from_str(cached).map_err(|e| format!("cache parse: {e}"))?;
                return Ok(Some(meta));
            }
        }

        match self.backend.get(&cache_key)? {
            Some(data) => {
                let json = String::from_utf8_lossy(&data).to_string();
                let meta = serde_json::from_str(&json).map_err(|e| format!("meta parse: {e}"))?;
                self.cache.write().put(cache_key, json);
                Ok(Some(meta))
            }
            None => Ok(None),
        }
    }

    pub fn put_metadata(&self, meta: &SessionMetadata) -> Result<(), String> {
        let cache_key = format!("meta:{}", meta.session_id);
        let json = serde_json::to_string(meta).map_err(|e| format!("meta serialize: {e}"))?;

        self.backend.put(&cache_key, json.as_bytes())?;
        self.cache.write().put(cache_key, json);

        {
            let mut index = self.index.write();
            if let Some(existing) = index
                .sessions
                .iter_mut()
                .find(|session| session.session_id == meta.session_id)
            {
                *existing = meta.clone();
            } else {
                index.sessions.push(meta.clone());
            }
            index
                .sessions
                .sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
            index.last_active_session = Some(meta.session_id.clone());
        }

        self.save_index()
    }

    pub fn get_history(&self, session_id: &str) -> Result<Option<String>, String> {
        self.get_json_string(&format!("history:{session_id}"))
    }

    pub fn put_history(&self, session_id: &str, history_json: &str) -> Result<(), String> {
        self.put_json_string(&format!("history:{session_id}"), history_json)
    }

    pub fn get_tokens(&self, session_id: &str) -> Result<Option<String>, String> {
        self.get_json_string(&format!("tokens:{session_id}"))
    }

    pub fn put_tokens(&self, session_id: &str, tokens_json: &str) -> Result<(), String> {
        self.put_json_string(&format!("tokens:{session_id}"), tokens_json)
    }

    pub fn get_context(&self, session_id: &str) -> Result<Option<String>, String> {
        self.get_json_string(&format!("context:{session_id}"))
    }

    pub fn put_context(&self, session_id: &str, context_json: &str) -> Result<(), String> {
        self.put_json_string(&format!("context:{session_id}"), context_json)
    }

    pub fn get_checkpoints(&self, session_id: &str) -> Result<Option<String>, String> {
        self.get_json_string(&format!("checkpoints:{session_id}"))
    }

    pub fn put_checkpoint(
        &self,
        session_id: &str,
        checkpoint: serde_json::Value,
    ) -> Result<(), String> {
        let key = format!("checkpoints:{session_id}");
        let mut checkpoints = match self.backend.get(&key)? {
            Some(data) => {
                let json = String::from_utf8_lossy(&data);
                serde_json::from_str::<Vec<serde_json::Value>>(&json)
                    .map_err(|e| format!("checkpoints parse: {e}"))?
            }
            None => Vec::new(),
        };

        checkpoints.push(checkpoint);
        let json = serde_json::to_string(&checkpoints)
            .map_err(|e| format!("checkpoints serialize: {e}"))?;
        self.backend.put(&key, json.as_bytes())
    }

    fn get_json_string(&self, key: &str) -> Result<Option<String>, String> {
        match self.backend.get(key)? {
            Some(data) => Ok(Some(String::from_utf8_lossy(&data).to_string())),
            None => Ok(None),
        }
    }

    fn put_json_string(&self, key: &str, json: &str) -> Result<(), String> {
        self.backend.put(key, json.as_bytes())
    }

    pub fn list_sessions(&self) -> Vec<SessionMetadata> {
        self.index.read().sessions.clone()
    }

    pub fn last_active_session(&self) -> Option<String> {
        self.index.read().last_active_session.clone()
    }

    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let _ = self.backend.delete(&format!("meta:{session_id}"));
        let _ = self.backend.delete(&format!("history:{session_id}"));
        let _ = self.backend.delete(&format!("tokens:{session_id}"));
        let _ = self.backend.delete(&format!("context:{session_id}"));
        let _ = self.backend.delete(&format!("checkpoints:{session_id}"));

        self.cache.write().pop(&format!("meta:{session_id}"));

        {
            let mut index = self.index.write();
            index
                .sessions
                .retain(|session| session.session_id != session_id);
            if index.last_active_session.as_deref() == Some(session_id) {
                index.last_active_session = index.sessions.first().map(|s| s.session_id.clone());
            }
        }

        self.save_index()
    }

    pub fn compute_workdir_hash(workdir: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(workdir.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    pub fn stats(&self) -> serde_json::Value {
        let index = self.index.read();
        let cache = self.cache.read();
        serde_json::json!({
            "session_count": index.sessions.len(),
            "cache_size": cache.len(),
            "cache_capacity": cache.cap(),
            "last_active": index.last_active_session,
        })
    }

    pub fn flush(&self) -> Result<(), String> {
        self.backend.flush()
    }
}
