use aes_gcm::{Aes256Gcm, Key, Nonce};
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::aead::rand_core::RngCore;
use sled::Db;
use std::sync::Arc;
use parking_lot::RwLock;

pub struct EncryptionStore {
    db: Arc<Db>,
    cipher: Arc<Aes256Gcm>,
    cache: Arc<RwLock<lru::LruCache<String, Vec<u8>>>>,
}

impl EncryptionStore {
    pub fn new(path: String, key_hex: String) -> Result<Self, String> {
        let db = sled::open(&path).map_err(|e| format!("Failed to open db: {}", e))?;
        let key_bytes = hex::decode(&key_hex).map_err(|e| format!("Invalid hex key: {}", e))?;
        if key_bytes.len() != 32 {
            return Err("Key must be 32 bytes (64 hex chars)".to_string());
        }
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        let cipher = Aes256Gcm::new(key);
        let cache = Arc::new(RwLock::new(
            lru::LruCache::new(std::num::NonZeroUsize::new(50).unwrap())
        ));
        Ok(Self { db: Arc::new(db), cipher: Arc::new(cipher), cache })
    }

    pub fn save_encrypted(&self, id: String, data: String) -> Result<(), String> {
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = self.cipher.encrypt(nonce, data.as_bytes())
            .map_err(|e| format!("Encrypt: {}", e))?;
        let mut stored = Vec::with_capacity(12 + ciphertext.len());
        stored.extend_from_slice(&nonce_bytes);
        stored.extend_from_slice(&ciphertext);
        
        // Clone for cache before moving into db
        let stored_clone = stored.clone();
        self.db.insert(id.as_bytes(), stored).map_err(|e| format!("DB insert: {}", e))?;
        self.db.flush().map_err(|e| format!("DB flush: {}", e))?;
        self.cache.write().put(id, stored_clone);
        Ok(())
    }

    pub fn load_decrypted(&self, id: &str) -> Result<Option<String>, String> {
        if let Some(cached) = self.cache.write().get(id) {
            return self.decrypt_data(cached.clone()).map(Some);
        }
        match self.db.get(id.as_bytes()) {
            Ok(Some(stored)) => {
                let stored_vec = stored.to_vec();
                let decrypted = self.decrypt_data(stored_vec.clone())?;
                self.cache.write().put(id.to_string(), stored_vec);
                Ok(Some(decrypted))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("DB get: {}", e)),
        }
    }

    pub fn delete(&self, id: &str) -> Result<bool, String> {
        self.cache.write().pop(id);
        let existed = self.db.remove(id.as_bytes()).map_err(|e| format!("DB remove: {}", e))?;
        Ok(existed.is_some())
    }

    pub fn list_ids(&self) -> Result<Vec<String>, String> {
        let mut ids = Vec::new();
        for item in self.db.iter() {
            let (key, _) = item.map_err(|e| format!("DB iter: {}", e))?;
            if let Ok(id) = String::from_utf8(key.to_vec()) {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    pub fn generate_key() -> String {
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        hex::encode(key)
    }

    fn decrypt_data(&self, stored: Vec<u8>) -> Result<String, String> {
        if stored.len() < 12 {
            return Err("Invalid encrypted data".to_string());
        }
        let (nonce_bytes, ciphertext) = stored.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = self.cipher.decrypt(nonce, ciphertext)
            .map_err(|e| format!("Decrypt: {}", e))?;
        String::from_utf8(plaintext).map_err(|e| format!("UTF-8: {}", e))
    }
}
