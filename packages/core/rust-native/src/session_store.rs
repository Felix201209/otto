/// Session Store - sled 嵌入式 KV + LRU 缓存
///
/// 类似 Linux 内核的 VFS 层：
/// - trait 定义接口（可替换后端）
/// - sled 是默认实现（类似 ext4）
/// - LRU 缓存加速热数据读取
///
use std::path::Path;
use std::sync::Arc;

use lru::LruCache;
use parking_lot::RwLock;
use serde_json;
use sha2::{Digest, Sha256};

use crate::protocol::{SessionIndex, SessionMetadata};

/// 存储后端 trait — 类似 VFS，可以替换实现
pub trait SessionBackend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String>;
    fn put(&self, key: &str, value: &[u8]) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
    fn list_prefix(&self, prefix: &str) -> Result<Vec<(String, Vec<u8>)>, String>;
    fn flush(&self) -> Result<(), String>;
}

/// sled 实现
pub struct SledBackend {
    db: sled::Db,
}

impl SledBackend {
    pub fn open(path: &Path) -> Result<Self, String> {
        let db = sled::open(path).map_err(|e| format!("sled open failed: {}", e))?;
        Ok(Self { db })
    }
}

impl SessionBackend for SledBackend {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        self.db
            .get(key.as_bytes())
            .map(|v| v.map(|iv| iv.to_vec()))
            .map_err(|e| format!("sled get: {}", e))
    }

    fn put(&self, key: &str, value: &[u8]) -> Result<(), String> {
        self.db
            .insert(key.as_bytes(), value)
            .map(|_| ())
            .map_err(|e| format!("sled put: {}", e))
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.db
            .remove(key.as_bytes())
            .map(|_| ())
            .map_err(|e| format!("sled delete: {}", e))
    }

    fn list_prefix(&self, prefix: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
        let mut results = Vec::new();
        for item in self.db.scan_prefix(prefix.as_bytes()) {
            let (k, v) = item.map_err(|e| format!("sled scan: {}", e))?;
            let key_str = String::from_utf8_lossy(&k).to_string();
            results.push((key_str, v.to_vec()));
        }
        Ok(results)
    }

    fn flush(&self) -> Result<(), String> {
        self.db.flush().map(|_| ()).map_err(|e| format!("sled flush: {}", e))
    }
}

/// 内存后端（用于测试或临时场景）
pub struct MemoryBackend {
    data: RwLock<std::collections::HashMap<String, Vec<u8>>>,
}

impl MemoryBackend {
    pub fn new() -> Self {
        Self {
            data: RwLock::new(std::collections::HashMap::new()),
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
        let results: Vec<_> = data
            .iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        Ok(results)
    }

    fn flush(&self) -> Result<(), String> {
        Ok(())
    }
}

/// SessionStore — 核心存储引擎
///
/// 架构：
/// ```text
///   SessionStore
///   ├── LRU Cache (热数据, 内存)
///   ├── Backend trait (sled / memory / rocksdb)
///   └── Index (session 列表 + lastActive)
/// ```
pub struct SessionStore {
    backend: Arc<dyn SessionBackend>,
    cache: RwLock<LruCache<String, String>>,
    index: RwLock<SessionIndex>,
}

impl SessionStore {
    /// 打开 sled 后端
    pub fn open_sled(path: &Path, cache_size: usize) -> Result<Self, String> {
        let backend: Arc<dyn SessionBackend> = Arc::new(SledBackend::open(path)?);
        let index = Self::load_index_from_backend(&backend)?;
        Ok(Self {
            backend,
            cache: RwLock::new(LruCache::new(
                std::num::NonZeroUsize::new(cache_size).unwrap_or(std::num::NonZeroUsize::new(1000).unwrap()),
            )),
            index: RwLock::new(index),
        })
    }

    /// 打开内存后端
    pub fn open_memory(cache_size: usize) -> Self {
        let backend = Arc::new(MemoryBackend::new());
        Self {
            backend,
            cache: RwLock::new(LruCache::new(
                std::num::NonZeroUsize::new(cache_size).unwrap_or(std::num::NonZeroUsize::new(1000).unwrap()),
            )),
            index: RwLock::new(SessionIndex {
                last_active_session: None,
                sessions: Vec::new(),
            }),
        }
    }

    fn load_index_from_backend(backend: &Arc<dyn SessionBackend>) -> Result<SessionIndex, String> {
        match backend.get("__index__")? {
            Some(data) => {
                let json = String::from_utf8_lossy(&data);
                serde_json::from_str(&json).map_err(|e| format!("index parse: {}", e))
            }
            None => Ok(SessionIndex {
                last_active_session: None,
                sessions: Vec::new(),
            }),
        }
    }

    fn save_index(&self) -> Result<(), String> {
        let index = self.index.read();
        let json = serde_json::to_string(&*index).map_err(|e| format!("index serialize: {}", e))?;
        self.backend.put("__index__", json.as_bytes())?;
        self.backend.flush()?;
        Ok(())
    }

    /// 获取 session 元数据（缓存优先）
    pub fn get_metadata(&self, session_id: &str) -> Result<Option<SessionMetadata>, String> {
        let cache_key = format!("meta:{}", session_id);

        // L1: 内存缓存
        {
            let mut cache = self.cache.write();
            if let Some(cached) = cache.get(&cache_key) {
                let meta: SessionMetadata =
                    serde_json::from_str(&cached).map_err(|e| format!("cache parse: {}", e))?;
                return Ok(Some(meta));
            }
        }

        // L2: 持久化后端
        match self.backend.get(&cache_key)? {
            Some(data) => {
                let json = String::from_utf8_lossy(&data);
                let meta: SessionMetadata =
                    serde_json::from_str(&json).map_err(|e| format!("meta parse: {}", e))?;
                // 回填缓存
                self.cache.write().put(cache_key, json.to_string());
                Ok(Some(meta))
            }
            None => Ok(None),
        }
    }

    /// 保存 session 元数据
    pub fn put_metadata(&self, meta: &SessionMetadata) -> Result<(), String> {
        let cache_key = format!("meta:{}", meta.session_id);
        let json = serde_json::to_string(meta).map_err(|e| format!("meta serialize: {}", e))?;

        // 写后端
        self.backend.put(&cache_key, json.as_bytes())?;

        // 更新缓存
        self.cache.write().put(cache_key, json);

        // 更新索引
        {
            let mut index = self.index.write();
            if let Some(existing) = index
                .sessions
                .iter_mut()
                .find(|s| s.session_id == meta.session_id)
            {
                *existing = meta.clone();
            } else {
                index.sessions.push(meta.clone());
            }
            // 按最后活跃时间排序
            index.sessions.sort_by(|a, b| {
                b.last_active_at.cmp(&a.last_active_at)
            });
            index.last_active_session = Some(meta.session_id.clone());
        }

        self.save_index()?;
        Ok(())
    }

    /// 获取 session 历史
    pub fn get_history(&self, session_id: &str) -> Result<Option<String>, String> {
        let key = format!("history:{}", session_id);
        match self.backend.get(&key)? {
            Some(data) => Ok(Some(String::from_utf8_lossy(&data).to_string())),
            None => Ok(None),
        }
    }

    /// 保存 session 历史
    pub fn put_history(&self, session_id: &str, history_json: &str) -> Result<(), String> {
        let key = format!("history:{}", session_id);
        self.backend.put(&key, history_json.as_bytes())?;
        Ok(())
    }

    /// 获取 session token 数据
    pub fn get_tokens(&self, session_id: &str) -> Result<Option<String>, String> {
        let key = format!("tokens:{}", session_id);
        match self.backend.get(&key)? {
            Some(data) => Ok(Some(String::from_utf8_lossy(&data).to_string())),
            None => Ok(None),
        }
    }

    /// 保存 session token 数据
    pub fn put_tokens(&self, session_id: &str, tokens_json: &str) -> Result<(), String> {
        let key = format!("tokens:{}", session_id);
        self.backend.put(&key, tokens_json.as_bytes())?;
        Ok(())
    }

    /// 列出所有 sessions
    pub fn list_sessions(&self) -> Vec<SessionMetadata> {
        self.index.read().sessions.clone()
    }

    /// 获取最后活跃 session
    pub fn last_active_session(&self) -> Option<String> {
        self.index.read().last_active_session.clone()
    }

    /// 删除 session
    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        // 删后端数据
        let _ = self.backend.delete(&format!("meta:{}", session_id));
        let _ = self.backend.delete(&format!("history:{}", session_id));
        let _ = self.backend.delete(&format!("tokens:{}", session_id));
        let _ = self.backend.delete(&format!("checkpoints:{}", session_id));

        // 清缓存
        self.cache.write().pop(&format!("meta:{}", session_id));

        // 更新索引
        {
            let mut index = self.index.write();
            index.sessions.retain(|s| s.session_id != session_id);
            if index.last_active_session.as_deref() == Some(session_id) {
                index.last_active_session = index.sessions.first().map(|s| s.session_id.clone());
            }
        }

        self.save_index()?;
        Ok(())
    }

    /// 计算 workdir hash
    pub fn compute_workdir_hash(workdir: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(workdir.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    /// 统计信息
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

    /// 刷盘
    pub fn flush(&self) -> Result<(), String> {
        self.backend.flush()
    }
}
