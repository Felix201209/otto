/// JSON-RPC protocol types for Node.js ↔ Rust communication
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct RpcResponse {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

impl RpcResponse {
    pub fn success(id: u64, result: serde_json::Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: u64, code: i32, message: impl Into<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
            }),
        }
    }
}

// ─── Session Store Types ───

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionMetadata {
    pub session_id: String,
    pub title: String,
    pub created_at: String,
    pub last_active_at: String,
    pub message_count: u64,
    pub total_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub has_checkpoint: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_user_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_assistant_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workdir_hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionIndex {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_active_session: Option<String>,
    pub sessions: Vec<SessionMetadata>,
}

// ─── Encryption Types ───

#[derive(Debug, Deserialize)]
pub struct StoreSecretParams {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct LoadSecretParams {
    pub key: String,
}

// ─── Tokenizer Types ───

#[derive(Debug, Deserialize)]
pub struct CountTokensParams {
    pub text: String,
    #[serde(default = "default_model")]
    pub model: String,
}

fn default_model() -> String {
    "gpt-4".to_string()
}

#[derive(Debug, Serialize)]
pub struct CountTokensResult {
    pub tokens: usize,
}

// ─── Agent Pool Types ───

#[derive(Debug, Deserialize)]
pub struct AcquireAgentParams {
    pub agent_id: String,
    #[serde(default = "default_memory_limit")]
    pub memory_limit_mb: u64,
}

fn default_memory_limit() -> u64 {
    256
}

#[derive(Debug, Deserialize)]
pub struct ReleaseAgentParams {
    pub agent_id: String,
}

#[derive(Debug, Serialize)]
pub struct AgentPoolStats {
    pub active_agents: usize,
    pub total_memory_mb: u64,
    pub peak_memory_mb: u64,
    pub lru_size: usize,
}
