use sled::Db;
use serde::{Serialize, Deserialize};
use std::sync::Arc;
use parking_lot::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub message_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    pub timestamp: i64,
    #[serde(default)]
    pub metadata: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionData {
    pub meta: SessionMeta,
    pub messages: Vec<Message>,
}

pub struct SessionStore {
    db: Arc<Db>,
    cache: Arc<RwLock<lru::LruCache<String, SessionData>>>,
}

impl SessionStore {
    pub fn new(path: String, cache_size: Option<usize>) -> Result<Self, String> {
        let db = sled::open(&path).map_err(|e| format!("Failed to open db: {}", e))?;
        let cache_size = cache_size.unwrap_or(100);
        let cache = Arc::new(RwLock::new(
            lru::LruCache::new(std::num::NonZeroUsize::new(cache_size).unwrap())
        ));
        Ok(Self { db: Arc::new(db), cache })
    }

    pub fn save(&self, id: String, title: String, messages: Vec<Message>) -> Result<(), String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let session = SessionData {
            meta: SessionMeta {
                id: id.clone(),
                title,
                updated_at: now,
                message_count: messages.len() as u32,
            },
            messages,
        };

        let value = serde_json::to_vec(&session).map_err(|e| format!("Serialize: {}", e))?;
        self.db.insert(id.as_bytes(), value).map_err(|e| format!("DB insert: {}", e))?;
        self.db.flush().map_err(|e| format!("DB flush: {}", e))?;
        self.cache.write().put(id, session);
        Ok(())
    }

    pub fn load(&self, id: &str) -> Result<Option<SessionData>, String> {
        if let Some(cached) = self.cache.write().get(id) {
            return Ok(Some(cached.clone()));
        }
        match self.db.get(id.as_bytes()) {
            Ok(Some(data)) => {
                let session: SessionData = serde_json::from_slice(&data)
                    .map_err(|e| format!("Deserialize: {}", e))?;
                self.cache.write().put(id.to_string(), session.clone());
                Ok(Some(session))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("DB get: {}", e)),
        }
    }

    pub fn delete(&mut self, id: &str) -> Result<bool, String> {
        self.cache.write().pop(id);
        let existed = self.db.remove(id.as_bytes()).map_err(|e| format!("DB remove: {}", e))?;
        Ok(existed.is_some())
    }

    pub fn list(&self) -> Result<Vec<SessionMeta>, String> {
        let mut sessions = Vec::new();
        for item in self.db.iter() {
            let (_, value) = item.map_err(|e| format!("DB iter: {}", e))?;
            if let Ok(session) = serde_json::from_slice::<SessionData>(&value) {
                sessions.push(session.meta);
            }
        }
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(sessions)
    }

    pub fn size_bytes(&self) -> u64 {
        self.db.size_on_disk().unwrap_or(0)
    }
}
