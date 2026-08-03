use std::io::{self, BufRead, Write};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Serialize, Deserialize};

mod session_store;
mod encryption;
mod tokenizer;
mod agent_pool;
mod mls;

use session_store::SessionStore;
use encryption::EncryptionStore;
use tokenizer::Tokenizer;
use agent_pool::AgentPool;
use mls::MlsKernel;

#[derive(Deserialize)]
struct Request {
    id: Option<u64>,
    method: String,
    params: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::mls::MlsKernel;
    use super::{
        handle_request, AgentPool, EncryptionStore, Request, SessionStore, Tokenizer, BASE64,
    };
    use base64::Engine as _;

    fn call_mls(request: Request, kernel: &mut MlsKernel) -> serde_json::Value {
        let mut store: Option<SessionStore> = None;
        let mut encryption: Option<EncryptionStore> = None;
        let mut tokenizer: Option<Tokenizer> = None;
        let mut pool: Option<AgentPool> = None;
        handle_request(
            &request,
            &mut store,
            &mut encryption,
            &mut tokenizer,
            &mut pool,
            kernel,
        )
        .expect("MLS RPC request must succeed")
    }

    #[test]
    fn mls_refuses_key_packages_before_device_initialization() {
        let mut kernel = MlsKernel::default();
        let error = kernel
            .create_key_package("server-a/org-a/alice/device-a")
            .expect_err("uninitialized MLS kernel must fail closed");
        assert!(error.contains("not initialized"));
    }

    #[test]
    fn mls_key_packages_are_real_and_one_time() {
        let mut kernel = MlsKernel::default();
        kernel
            .initialize("server-a/org-a/alice/device-a")
            .expect("MLS device initialization must succeed");
        let package = kernel
            .create_key_package("server-a/org-a/alice/device-a")
            .expect("MLS key package generation must succeed");
        assert_eq!(package.protocol, "mls10-openmls-0.8");
        assert!(!package.key_package.is_empty());
        kernel
            .consume_key_package(&package.reference)
            .expect("first key package consumption must succeed");
        assert!(kernel.consume_key_package(&package.reference).is_err());
    }

    #[test]
    fn mls_rpc_exports_only_public_key_package_fields() {
        let scope = "server-a/org-a/alice/device-a";
        let mut kernel = MlsKernel::default();
        call_mls(
            Request {
                id: Some(1),
                method: "mls.initialize".into(),
                params: Some(serde_json::json!({"device_scope": scope})),
            },
            &mut kernel,
        );
        let result = call_mls(
            Request {
                id: Some(2),
                method: "mls.key_package.create".into(),
                params: Some(serde_json::json!({"device_scope": scope})),
            },
            &mut kernel,
        );
        let fields = result
            .as_object()
            .expect("MLS KeyPackage response must be an object");
        assert_eq!(fields.len(), 4);
        for field in ["protocol", "ciphersuite", "reference", "key_package"] {
            assert!(fields.contains_key(field), "missing public field: {field}");
        }
        for forbidden in ["private", "secret", "signature_key", "init_private_key"] {
            assert!(!fields.contains_key(forbidden));
        }
    }

    #[test]
    fn mls_rpc_supports_two_device_group_and_message_interop() {
        let alice_scope = "server-a/org-a/alice/alice-device";
        let bob_scope = "server-a/org-a/bob/bob-device";
        let conversation = "conversation-a";
        let mut alice = MlsKernel::default();
        let mut bob = MlsKernel::default();
        for (kernel, scope) in [(&mut alice, alice_scope), (&mut bob, bob_scope)] {
            call_mls(
                Request {
                    id: None,
                    method: "mls.initialize".into(),
                    params: Some(serde_json::json!({"device_scope": scope})),
                },
                kernel,
            );
        }
        let bob_key_package = call_mls(
            Request {
                id: None,
                method: "mls.key_package.create".into(),
                params: Some(serde_json::json!({"device_scope": bob_scope})),
            },
            &mut bob,
        );
        call_mls(
            Request {
                id: None,
                method: "mls.group.create".into(),
                params: Some(serde_json::json!({
                    "device_scope": alice_scope,
                    "conversation_id": conversation
                })),
            },
            &mut alice,
        );
        let invitation = call_mls(
            Request {
                id: None,
                method: "mls.group.add_member".into(),
                params: Some(serde_json::json!({
                    "device_scope": alice_scope,
                    "conversation_id": conversation,
                    "key_package": bob_key_package["key_package"]
                })),
            },
            &mut alice,
        );
        let committed = call_mls(
            Request {
                id: None,
                method: "mls.group.merge_pending_commit".into(),
                params: Some(serde_json::json!({
                    "device_scope": alice_scope,
                    "conversation_id": conversation,
                    "peer_account_id": "bob"
                })),
            },
            &mut alice,
        );
        call_mls(
            Request {
                id: None,
                method: "mls.group.join".into(),
                params: Some(serde_json::json!({
                    "device_scope": bob_scope,
                    "conversation_id": conversation,
                    "peer_account_id": "alice",
                    "key_package_reference": bob_key_package["reference"],
                    "expected_group_id": committed["group_id"],
                    "welcome": invitation["welcome"]
                })),
            },
            &mut bob,
        );
        let encrypted = call_mls(
            Request {
                id: None,
                method: "mls.application.encrypt_transport".into(),
                params: Some(serde_json::json!({
                    "device_scope": alice_scope,
                    "conversation_id": conversation,
                    "peer_account_id": "bob",
                    "plaintext": BASE64.encode(b"hello over rpc")
                })),
            },
            &mut alice,
        );
        let pending = call_mls(
            Request {
                id: None,
                method: "mls.application.outbox.list".into(),
                params: Some(serde_json::json!({
                    "device_scope": alice_scope,
                    "conversation_id": conversation,
                    "peer_account_id": "bob"
                })),
            },
            &mut alice,
        );
        assert_eq!(pending.as_array().unwrap().len(), 1);
        assert_eq!(pending[0]["event_id"], encrypted["event_id"]);
        let stage_params = serde_json::json!({
            "device_scope": bob_scope,
            "conversation_id": conversation,
            "peer_account_id": "alice",
            "event_id": encrypted["event_id"],
            "ciphertext": encrypted["ciphertext"],
            "sequence": 1,
            "expected_group_id": committed["group_id"],
            "expected_epoch": committed["epoch"],
            "sender_device_id": "alice-device",
            "created_at": "2026-08-02T00:00:00.000Z"
        });
        let staged = call_mls(
            Request {
                id: None,
                method: "mls.application.inbox.stage".into(),
                params: Some(stage_params.clone()),
            },
            &mut bob,
        );
        assert!(staged.get("plaintext").is_none());
        assert_eq!(staged["event_id"], encrypted["event_id"]);
        let staged_again = call_mls(
            Request {
                id: None,
                method: "mls.application.inbox.stage".into(),
                params: Some(stage_params),
            },
            &mut bob,
        );
        assert!(staged_again.get("plaintext").is_none());
        assert_eq!(staged_again, staged);
        let received = call_mls(
            Request {
                id: None,
                method: "mls.application.inbox.list".into(),
                params: Some(serde_json::json!({
                    "device_scope": bob_scope,
                    "conversation_id": conversation,
                    "peer_account_id": "alice"
                })),
            },
            &mut bob,
        );
        assert_eq!(received.as_array().unwrap().len(), 1);
        assert_eq!(
            BASE64
                .decode(received[0]["plaintext"].as_str().unwrap())
                .unwrap(),
            b"hello over rpc"
        );
        call_mls(
            Request {
                id: None,
                method: "mls.application.outbox.ack".into(),
                params: Some(serde_json::json!({
                    "device_scope": alice_scope,
                    "conversation_id": conversation,
                    "peer_account_id": "bob",
                    "event_id": encrypted["event_id"]
                })),
            },
            &mut alice,
        );
        let pending = call_mls(
            Request {
                id: None,
                method: "mls.application.outbox.list".into(),
                params: Some(serde_json::json!({
                    "device_scope": alice_scope,
                    "conversation_id": conversation,
                    "peer_account_id": "bob"
                })),
            },
            &mut alice,
        );
        assert!(pending.as_array().unwrap().is_empty());
    }
}

#[derive(Serialize)]
struct Response {
    id: Option<u64>,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    let mut store: Option<SessionStore> = None;
    let mut enc_store: Option<EncryptionStore> = None;
    let mut tok: Option<Tokenizer> = None;
    let mut pool: Option<AgentPool> = None;
    let mut mls_kernel = MlsKernel::default();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        if line.trim().is_empty() {
            continue;
        }

        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = Response { id: None, result: None, error: Some(format!("Parse error: {}", e)) };
                let _ = writeln!(stdout, "{}", serde_json::to_string(&resp).unwrap());
                continue;
            }
        };

        let resp = match handle_request(
            &req,
            &mut store,
            &mut enc_store,
            &mut tok,
            &mut pool,
            &mut mls_kernel,
        ) {
            Ok(v) => Response { id: req.id, result: Some(v), error: None },
            Err(e) => Response { id: req.id, result: None, error: Some(e) },
        };
        
        let _ = writeln!(stdout, "{}", serde_json::to_string(&resp).unwrap());
        let _ = stdout.flush();
    }
}

fn handle_request(
    req: &Request,
    store: &mut Option<SessionStore>,
    enc_store: &mut Option<EncryptionStore>,
    tok: &mut Option<Tokenizer>,
    pool: &mut Option<AgentPool>,
    mls_kernel: &mut MlsKernel,
) -> Result<serde_json::Value, String> {
    let params = req.params.as_ref();
    
    match req.method.as_str() {
        // === No-params methods ===
        "ping" => Ok(serde_json::json!({"pong": true})),
        
        "session_store.list" => {
            let s = store.as_ref().ok_or("Store not opened")?;
            let sessions = s.list()?;
            Ok(serde_json::to_value(sessions).unwrap())
        }
        "session_store.size_bytes" => {
            let s = store.as_ref().ok_or("Store not opened")?;
            Ok(serde_json::json!({"size": s.size_bytes()}))
        }
        
        "encryption.generate_key" => {
            Ok(serde_json::json!({"key": EncryptionStore::generate_key()}))
        }
        "encryption.list_ids" => {
            let es = enc_store.as_ref().ok_or("EncStore not opened")?;
            let ids = es.list_ids()?;
            Ok(serde_json::json!({"ids": ids}))
        }
        
        "tokenizer.supported_models" => {
            Ok(serde_json::json!({"models": tokenizer::supported_models()}))
        }
        
        "agent_pool.stats" => {
            let p = pool.as_ref().ok_or("Pool not created")?;
            Ok(serde_json::json!({
                "current_memory_mb": p.current_memory_mb(),
                "max_memory_mb": p.max_memory_mb(),
                "agent_count": p.agent_count(),
            }))
        }
        "agent_pool.list_agents" => {
            let p = pool.as_ref().ok_or("Pool not created")?;
            let agents = p.list_agents();
            Ok(serde_json::to_value(agents).unwrap())
        }

        // === Session Store ===
        "session_store.open" => {
            let p = params.ok_or("Missing params")?;
            let path = p["path"].as_str().ok_or("Missing path")?;
            let cache_size = p["cache_size"].as_u64().map(|v| v as usize);
            let s = SessionStore::new(path.to_string(), cache_size)?;
            *store = Some(s);
            Ok(serde_json::json!({"status": "ok"}))
        }
        "session_store.save" => {
            let p = params.ok_or("Missing params")?;
            let s = store.as_ref().ok_or("Store not opened")?;
            let id = p["id"].as_str().ok_or("Missing id")?.to_string();
            let title = p["title"].as_str().unwrap_or("").to_string();
            let messages: Vec<session_store::Message> = serde_json::from_value(
                p["messages"].clone()
            ).map_err(|e| format!("Bad messages: {}", e))?;
            s.save(id, title, messages)?;
            Ok(serde_json::json!({"status": "ok"}))
        }
        "session_store.load" => {
            let p = params.ok_or("Missing params")?;
            let s = store.as_ref().ok_or("Store not opened")?;
            let id = p["id"].as_str().ok_or("Missing id")?;
            let data = s.load(id)?;
            Ok(serde_json::to_value(data).unwrap_or(serde_json::Value::Null))
        }
        "session_store.delete" => {
            let p = params.ok_or("Missing params")?;
            let s = store.as_mut().ok_or("Store not opened")?;
            let id = p["id"].as_str().ok_or("Missing id")?;
            let deleted = s.delete(id)?;
            Ok(serde_json::json!({"deleted": deleted}))
        }

        // === Encryption Store ===
        "encryption.open" => {
            let p = params.ok_or("Missing params")?;
            let path = p["path"].as_str().ok_or("Missing path")?;
            let key = p["key"].as_str().ok_or("Missing key")?;
            let es = EncryptionStore::new(path.to_string(), key.to_string())?;
            *enc_store = Some(es);
            Ok(serde_json::json!({"status": "ok"}))
        }
        "encryption.save" => {
            let p = params.ok_or("Missing params")?;
            let es = enc_store.as_ref().ok_or("EncStore not opened")?;
            let id = p["id"].as_str().ok_or("Missing id")?;
            let data = p["data"].as_str().ok_or("Missing data")?;
            es.save_encrypted(id.to_string(), data.to_string())?;
            Ok(serde_json::json!({"status": "ok"}))
        }
        "encryption.load" => {
            let p = params.ok_or("Missing params")?;
            let es = enc_store.as_ref().ok_or("EncStore not opened")?;
            let id = p["id"].as_str().ok_or("Missing id")?;
            let data = es.load_decrypted(id)?;
            Ok(serde_json::json!({"data": data}))
        }
        "encryption.delete" => {
            let p = params.ok_or("Missing params")?;
            let es = enc_store.as_ref().ok_or("EncStore not opened")?;
            let id = p["id"].as_str().ok_or("Missing id")?;
            let deleted = es.delete(id)?;
            Ok(serde_json::json!({"deleted": deleted}))
        }

        // === Tokenizer ===
        "tokenizer.create" => {
            let p = params.ok_or("Missing params")?;
            let model = p["model"].as_str().ok_or("Missing model")?;
            let t = Tokenizer::new(model.to_string())?;
            *tok = Some(t);
            Ok(serde_json::json!({"status": "ok"}))
        }
        "tokenizer.count" => {
            let p = params.ok_or("Missing params")?;
            let t = tok.as_ref().ok_or("Tokenizer not created")?;
            let text = p["text"].as_str().ok_or("Missing text")?;
            let count = t.count(text);
            Ok(serde_json::json!({"tokens": count}))
        }
        "tokenizer.truncate" => {
            let p = params.ok_or("Missing params")?;
            let t = tok.as_ref().ok_or("Tokenizer not created")?;
            let text = p["text"].as_str().ok_or("Missing text")?;
            let max = p["max_tokens"].as_u64().ok_or("Missing max_tokens")? as u32;
            let result = t.truncate(text, max);
            Ok(serde_json::json!({"text": result}))
        }

        // === Agent Pool ===
        "agent_pool.create" => {
            let p = params.ok_or("Missing params")?;
            let max_mem = p["max_memory_mb"].as_u64().unwrap_or(256) as u32;
            let max_agents = p["max_agents"].as_u64().unwrap_or(10) as u32;
            let pool_instance = AgentPool::new(max_mem, max_agents);
            *pool = Some(pool_instance);
            Ok(serde_json::json!({"status": "ok"}))
        }
        "agent_pool.register" => {
            let p = params.ok_or("Missing params")?;
            let pool_ref = pool.as_ref().ok_or("Pool not created")?;
            let id = p["id"].as_str().ok_or("Missing id")?;
            let mem = p["memory_mb"].as_u64().unwrap_or(10) as u32;
            let ok = pool_ref.register(id.to_string(), mem)?;
            Ok(serde_json::json!({"registered": ok}))
        }
        "agent_pool.unregister" => {
            let p = params.ok_or("Missing params")?;
            let pool_ref = pool.as_ref().ok_or("Pool not created")?;
            let id = p["id"].as_str().ok_or("Missing id")?;
            let ok = pool_ref.unregister(id)?;
            Ok(serde_json::json!({"unregistered": ok}))
        }
        "agent_pool.update_memory" => {
            let p = params.ok_or("Missing params")?;
            let pool_ref = pool.as_ref().ok_or("Pool not created")?;
            let id = p["id"].as_str().ok_or("Missing id")?;
            let mem = p["memory_mb"].as_u64().ok_or("Missing memory_mb")? as u32;
            let ok = pool_ref.update_memory(id, mem)?;
            Ok(serde_json::json!({"updated": ok}))
        }
        "agent_pool.add_log" => {
            let p = params.ok_or("Missing params")?;
            let pool_ref = pool.as_ref().ok_or("Pool not created")?;
            let id = p["id"].as_str().ok_or("Missing id")?;
            let log = p["log"].as_str().ok_or("Missing log")?;
            let ok = pool_ref.add_log(id, log.to_string());
            Ok(serde_json::json!({"added": ok}))
        }
        "agent_pool.drain_pending" => {
            let p = params.ok_or("Missing params")?;
            let pool_ref = pool.as_ref().ok_or("Pool not created")?;
            let id = p["id"].as_str().ok_or("Missing id")?;
            let results = pool_ref.drain_pending_results(id);
            Ok(serde_json::json!({"results": results}))
        }
        "agent_pool.cleanup_idle" => {
            let p = params.ok_or("Missing params")?;
            let pool_ref = pool.as_ref().ok_or("Pool not created")?;
            let secs = p["idle_seconds"].as_u64().unwrap_or(300) as u32;
            let count = pool_ref.cleanup_idle(secs);
            Ok(serde_json::json!({"cleaned": count}))
        }

        // === OpenMLS ===
        "mls.initialize" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            mls_kernel.initialize(scope)?;
            Ok(serde_json::json!({
                "status": "initialized",
                "protocol": "mls10-openmls-0.8"
            }))
        }
        "mls.persistence.configure" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let state_key = p["state_key"].as_str().ok_or("Missing state_key")?;
            mls_kernel.configure_persistence(scope, state_key)?;
            Ok(serde_json::json!({"status": "configured"}))
        }
        "mls.persistence.export" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            Ok(serde_json::json!({
                "format": 1,
                "encrypted_state": mls_kernel.export_encrypted_state(scope)?
            }))
        }
        "mls.persistence.restore" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let encrypted_state = p["encrypted_state"]
                .as_str()
                .ok_or("Missing encrypted_state")?;
            mls_kernel.restore_encrypted_state(scope, encrypted_state)?;
            Ok(serde_json::json!({
                "status": "restored",
                "protocol": "mls10-openmls-0.8"
            }))
        }
        "mls.key_package.create" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            serde_json::to_value(mls_kernel.create_key_package(scope)?)
                .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.key_package.list" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            serde_json::to_value(mls_kernel.list_key_packages(scope)?)
                .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.key_package.consume" => {
            let p = params.ok_or("Missing params")?;
            let reference = p["reference"].as_str().ok_or("Missing reference")?;
            mls_kernel.consume_key_package(reference)?;
            Ok(serde_json::json!({"status": "consumed"}))
        }
        "mls.group.create" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            serde_json::to_value(mls_kernel.create_group(scope, conversation)?)
                .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.group.add_member" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let key_package = p["key_package"]
                .as_str()
                .ok_or("Missing key_package")?;
            serde_json::to_value(mls_kernel.add_member(scope, conversation, key_package)?)
                .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.group.merge_pending_commit" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let peer_account_id = p["peer_account_id"]
                .as_str()
                .ok_or("Missing peer_account_id")?;
            serde_json::to_value(mls_kernel.merge_pending_commit(
                scope,
                conversation,
                peer_account_id,
            )?)
                .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.group.inspect" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            serde_json::to_value(mls_kernel.inspect_group(scope, conversation)?)
                .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.transport.cursor" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            Ok(serde_json::json!({
                "sequence": mls_kernel.transport_cursor(scope, conversation)?
            }))
        }
        "mls.transport.ack" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let sequence = p["sequence"].as_u64().ok_or("Missing sequence")?;
            Ok(serde_json::json!({
                "sequence": mls_kernel.acknowledge_transport_event(
                    scope,
                    conversation,
                    sequence,
                )?
            }))
        }
        "mls.commit.receive" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let peer_account_id = p["peer_account_id"]
                .as_str()
                .ok_or("Missing peer_account_id")?;
            let commit = p["commit"].as_str().ok_or("Missing commit")?;
            let sequence = p["sequence"].as_u64().ok_or("Missing sequence")?;
            let expected_group_id = p["expected_group_id"]
                .as_str()
                .ok_or("Missing expected_group_id")?;
            let expected_epoch = p["expected_epoch"]
                .as_u64()
                .ok_or("Missing expected_epoch")?;
            let sender_device_id = p["sender_device_id"]
                .as_str()
                .ok_or("Missing sender_device_id")?;
            let expected_added_device_id = p["expected_added_device_id"].as_str();
            let expected_added_key_package_reference =
                p["expected_added_key_package_reference"].as_str();
            serde_json::to_value(mls_kernel.receive_transport_commit(
                scope,
                conversation,
                peer_account_id,
                commit,
                sequence,
                expected_group_id,
                expected_epoch,
                sender_device_id,
                expected_added_device_id,
                expected_added_key_package_reference,
            )?)
            .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.group.join" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let peer_account_id = p["peer_account_id"]
                .as_str()
                .ok_or("Missing peer_account_id")?;
            let reference = p["key_package_reference"]
                .as_str()
                .ok_or("Missing key_package_reference")?;
            let group_id = p["expected_group_id"]
                .as_str()
                .ok_or("Missing expected_group_id")?;
            let welcome = p["welcome"].as_str().ok_or("Missing welcome")?;
            serde_json::to_value(mls_kernel.join_group(
                scope,
                conversation,
                peer_account_id,
                reference,
                group_id,
                welcome,
            )?)
            .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.application.encrypt_transport" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let peer_account_id = p["peer_account_id"]
                .as_str()
                .ok_or("Missing peer_account_id")?;
            let encoded = p["plaintext"].as_str().ok_or("Missing plaintext")?;
            if encoded.len() > 1_398_104 {
                return Err("MLS application plaintext size is invalid".into());
            }
            let plaintext = BASE64
                .decode(encoded)
                .map_err(|_| "MLS application plaintext is not valid base64")?;
            serde_json::to_value(mls_kernel.encrypt_transport_application(
                scope,
                conversation,
                peer_account_id,
                &plaintext,
            )?)
            .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.application.outbox.list" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let peer_account_id = p["peer_account_id"]
                .as_str()
                .ok_or("Missing peer_account_id")?;
            serde_json::to_value(
                mls_kernel.list_pending_applications(scope, conversation, peer_account_id)?,
            )
            .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.application.outbox.list_peers" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            serde_json::to_value(mls_kernel.list_pending_application_peers(scope)?)
                .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.application.outbox.ack" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let peer_account_id = p["peer_account_id"]
                .as_str()
                .ok_or("Missing peer_account_id")?;
            let event_id = p["event_id"].as_str().ok_or("Missing event_id")?;
            mls_kernel.acknowledge_pending_application(
                scope,
                conversation,
                peer_account_id,
                event_id,
            )?;
            Ok(serde_json::json!({"event_id": event_id}))
        }
        "mls.conversation.list_peers" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            serde_json::to_value(mls_kernel.list_conversation_peers(scope)?)
                .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.conversation.bind_peer" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let peer_account_id = p["peer_account_id"]
                .as_str()
                .ok_or("Missing peer_account_id")?;
            Ok(serde_json::json!({
                "changed": mls_kernel.bind_conversation_peer(
                    scope,
                    conversation,
                    peer_account_id,
                )?
            }))
        }
        "mls.application.inbox.receive" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let peer_account_id = p["peer_account_id"]
                .as_str()
                .ok_or("Missing peer_account_id")?;
            let event_id = p["event_id"].as_str().ok_or("Missing event_id")?;
            let ciphertext = p["ciphertext"].as_str().ok_or("Missing ciphertext")?;
            let sequence = p["sequence"].as_u64().ok_or("Missing sequence")?;
            let group_id = p["expected_group_id"]
                .as_str()
                .ok_or("Missing expected_group_id")?;
            let epoch = p["expected_epoch"]
                .as_u64()
                .ok_or("Missing expected_epoch")?;
            let sender_device_id = p["sender_device_id"]
                .as_str()
                .ok_or("Missing sender_device_id")?;
            let created_at = p["created_at"].as_str().ok_or("Missing created_at")?;
            serde_json::to_value(mls_kernel.receive_transport_application(
                scope,
                conversation,
                peer_account_id,
                event_id,
                ciphertext,
                sequence,
                group_id,
                epoch,
                sender_device_id,
                created_at,
            )?)
            .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.application.inbox.stage" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let peer_account_id = p["peer_account_id"]
                .as_str()
                .ok_or("Missing peer_account_id")?;
            let event_id = p["event_id"].as_str().ok_or("Missing event_id")?;
            let ciphertext = p["ciphertext"].as_str().ok_or("Missing ciphertext")?;
            let sequence = p["sequence"].as_u64().ok_or("Missing sequence")?;
            let group_id = p["expected_group_id"]
                .as_str()
                .ok_or("Missing expected_group_id")?;
            let epoch = p["expected_epoch"].as_u64().ok_or("Missing expected_epoch")?;
            let sender_device_id = p["sender_device_id"]
                .as_str()
                .ok_or("Missing sender_device_id")?;
            let created_at = p["created_at"].as_str().ok_or("Missing created_at")?;
            serde_json::to_value(mls_kernel.stage_transport_application(
                scope,
                conversation,
                peer_account_id,
                event_id,
                ciphertext,
                sequence,
                group_id,
                epoch,
                sender_device_id,
                created_at,
            )?)
            .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.application.inbox.list" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let peer_account_id = p["peer_account_id"]
                .as_str()
                .ok_or("Missing peer_account_id")?;
            serde_json::to_value(mls_kernel.list_pending_received_applications(
                scope,
                conversation,
                peer_account_id,
            )?)
            .map_err(|error| format!("MLS response serialization failed: {error}"))
        }
        "mls.application.inbox.ack" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            let conversation = p["conversation_id"]
                .as_str()
                .ok_or("Missing conversation_id")?;
            let peer_account_id = p["peer_account_id"]
                .as_str()
                .ok_or("Missing peer_account_id")?;
            let event_id = p["event_id"].as_str().ok_or("Missing event_id")?;
            mls_kernel.acknowledge_received_application(
                scope,
                conversation,
                peer_account_id,
                event_id,
            )?;
            Ok(serde_json::json!({"event_id": event_id}))
        }
        "mls.reset" => {
            let p = params.ok_or("Missing params")?;
            let scope = p["device_scope"].as_str().ok_or("Missing device_scope")?;
            mls_kernel.reset(scope)?;
            Ok(serde_json::json!({"status": "reset"}))
        }

        _ => Err(format!("Unknown method: {}", req.method)),
    }
}
