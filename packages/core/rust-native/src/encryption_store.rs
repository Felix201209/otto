/// Encryption Store - AES-256-GCM 加密存储
///
/// 类似 Linux 内核的 crypto API：
/// - trait 定义加密接口
/// - AES-256-GCM 是默认实现
/// - 密钥从 machine-id 派生，跨重启稳定
///
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use rand::Rng;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;

use parking_lot::RwLock;

/// 加密后端 trait
pub trait EncryptionBackend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String>;
    fn put(&self, key: &str, value: &[u8]) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

/// 文件后端 — 每个 key 一个文件
pub struct FileBackend {
    dir: std::path::PathBuf,
}

impl FileBackend {
    pub fn open(path: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(path).map_err(|e| format!("create secrets dir: {}", e))?;
        Ok(Self {
            dir: path.to_path_buf(),
        })
    }

    fn key_to_filename(key: &str) -> String {
        // 用 sha256 避免文件名特殊字符
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        format!("{:x}.enc", hasher.finalize())
    }
}

impl EncryptionBackend for FileBackend {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let path = self.dir.join(Self::key_to_filename(key));
        match std::fs::read(&path) {
            Ok(data) => Ok(Some(data)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("read secret: {}", e)),
        }
    }

    fn put(&self, key: &str, value: &[u8]) -> Result<(), String> {
        let path = self.dir.join(Self::key_to_filename(key));
        std::fs::write(&path, value).map_err(|e| format!("write secret: {}", e))
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let path = self.dir.join(Self::key_to_filename(key));
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("delete secret: {}", e)),
        }
    }
}

/// EncryptionStore — 加密存储引擎
///
/// 架构：
/// ```text
///   EncryptionStore
///   ├── AES-256-GCM cipher (由 key 派生)
///   ├── Backend trait (file / memory / vault)
///   └── 12-byte random nonce per write
/// ```
pub struct EncryptionStore {
    cipher: Aes256Gcm,
    backend: Arc<dyn EncryptionBackend>,
}

impl EncryptionStore {
    /// 从 master key 创建
    pub fn new(master_key: &[u8; 32], backend: Arc<dyn EncryptionBackend>) -> Self {
        let cipher = Aes256Gcm::new_from_slice(master_key)
            .expect("AES-256 key must be 32 bytes");
        Self { cipher, backend }
    }

    /// 从字符串派生 key（SHA-256）
    pub fn from_passphrase(passphrase: &str, backend: Arc<dyn EncryptionBackend>) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(passphrase.as_bytes());
        let key_bytes: [u8; 32] = hasher.finalize().into();
        Self::new(&key_bytes, backend)
    }

    /// 从 machine-id 派生（跨重启稳定）
    pub fn from_machine_id(backend: Arc<dyn EncryptionBackend>) -> Result<Self, String> {
        let machine_id = Self::get_machine_id()?;
        Ok(Self::from_passphrase(&machine_id, backend))
    }

    /// 加密并存储
    pub fn store_secret(&self, key: &str, value: &str) -> Result<(), String> {
        let mut rng = rand::thread_rng();
        let nonce_bytes: [u8; 12] = rng.gen();
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = self
            .cipher
            .encrypt(nonce, value.as_bytes())
            .map_err(|e| format!("encrypt: {}", e))?;

        // 格式: [12-byte nonce][ciphertext]
        let mut stored = Vec::with_capacity(12 + ciphertext.len());
        stored.extend_from_slice(&nonce_bytes);
        stored.extend_from_slice(&ciphertext);

        self.backend.put(key, &stored)
    }

    /// 读取并解密
    pub fn load_secret(&self, key: &str) -> Result<Option<String>, String> {
        match self.backend.get(key)? {
            None => Ok(None),
            Some(data) => {
                if data.len() < 12 {
                    return Err("corrupted secret: too short".to_string());
                }
                let nonce = Nonce::from_slice(&data[..12]);
                let ciphertext = &data[12..];

                let plaintext = self
                    .cipher
                    .decrypt(nonce, ciphertext)
                    .map_err(|e| format!("decrypt (wrong key?): {}", e))?;

                let value = String::from_utf8(plaintext)
                    .map_err(|e| format!("utf8 decode: {}", e))?;

                Ok(Some(value))
            }
        }
    }

    /// 删除 secret
    pub fn delete_secret(&self, key: &str) -> Result<(), String> {
        self.backend.delete(key)
    }

    /// 列出所有 key（不解密）
    pub fn list_keys(&self) -> Result<Vec<String>, String> {
        // FileBackend 不支持 list，返回空
        // 如果需要 list，可以用 sled 或加一个 index
        Ok(Vec::new())
    }

    /// 获取 machine-id（跨重启稳定）
    fn get_machine_id() -> Result<String, String> {
        // Windows: 用 ComputerName + ProcessorId
        #[cfg(target_os = "windows")]
        {
            use std::process::Command;
            let output = Command::new("wmic")
                .args(&["csproduct", "get", "UUID"])
                .output()
                .map_err(|e| format!("wmic: {}", e))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let uuid = stdout
                .lines()
                .skip(1) // skip header
                .find(|l| !l.trim().is_empty())
                .unwrap_or("default-machine-id")
                .trim()
                .to_string();
            return Ok(uuid);
        }

        // Linux: /etc/machine-id
        #[cfg(target_os = "linux")]
        {
            match std::fs::read_to_string("/etc/machine-id") {
                Ok(id) => return Ok(id.trim().to_string()),
                Err(_) => return Ok("default-machine-id".to_string()),
            }
        }

        // macOS: IOPlatformUUID
        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            let output = Command::new("ioreg")
                .args(&["-rd1", "-c", "IOPlatformExpertDevice"])
                .output()
                .map_err(|e| format!("ioreg: {}", e))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.contains("IOPlatformUUID") {
                    if let Some(uuid) = line.split('=').nth(1) {
                        return Ok(uuid.trim().trim_matches('"').to_string());
                    }
                }
            }
            return Ok("default-machine-id".to_string());
        }

        #[allow(unreachable_code)]
        Ok("default-machine-id".to_string())
    }
}

/// 内存后端（测试用）
pub struct MemoryEncBackend {
    data: RwLock<std::collections::HashMap<String, Vec<u8>>>,
}

impl MemoryEncBackend {
    pub fn new() -> Self {
        Self {
            data: RwLock::new(std::collections::HashMap::new()),
        }
    }
}

impl EncryptionBackend for MemoryEncBackend {
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
}
