//! JSON-RPC syscall table for the native core.
//!
//! Method names are the stable ABI consumed by the Node wrapper. Add new
//! capabilities here without changing existing method payloads.

use crate::protocol::*;
use crate::session_store::SessionStore;
use crate::OttoCore;

fn session_store<'a>(core: &'a OttoCore, id: u64) -> Result<&'a SessionStore, RpcResponse> {
    core.session_store
        .as_ref()
        .ok_or_else(|| RpcResponse::error(id, -10, "session store not initialized"))
}

fn session_id(req: &RpcRequest) -> Result<&str, RpcResponse> {
    req.params
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcResponse::error(req.id, -11, "missing session_id"))
}

fn json_param<'a>(
    req: &'a RpcRequest,
    name: &str,
    error_code: i32,
) -> Result<&'a serde_json::Value, RpcResponse> {
    req.params
        .get(name)
        .ok_or_else(|| RpcResponse::error(req.id, error_code, format!("missing {name}")))
}

fn ok(id: u64) -> RpcResponse {
    RpcResponse::success(id, serde_json::json!({ "status": "ok" }))
}

fn json_or_null(json: String) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(&json).unwrap_or(serde_json::Value::Null)
}

pub(crate) fn dispatch(core: &mut OttoCore, req: &RpcRequest) -> RpcResponse {
    match req.method.as_str() {
        "init" => {
            let data_dir = req
                .params
                .get("data_dir")
                .and_then(|v| v.as_str())
                .unwrap_or(".otto-native");
            let cache_size = req
                .params
                .get("cache_size")
                .and_then(|v| v.as_u64())
                .unwrap_or(1000) as usize;

            if let Err(e) = core.init_session_store(data_dir, cache_size) {
                return RpcResponse::error(req.id, -1, format!("session store init: {e}"));
            }
            if let Err(e) = core.init_encryption_store(data_dir) {
                return RpcResponse::error(req.id, -2, format!("encryption store init: {e}"));
            }

            ok(req.id)
        }

        "session.get" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            let session_id = match session_id(req) {
                Ok(session_id) => session_id,
                Err(resp) => return resp,
            };

            match store.get_metadata(session_id) {
                Ok(Some(meta)) => RpcResponse::success(req.id, serde_json::to_value(meta).unwrap()),
                Ok(None) => RpcResponse::success(req.id, serde_json::Value::Null),
                Err(e) => RpcResponse::error(req.id, -12, e),
            }
        }

        "session.put" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            let meta: SessionMetadata = match serde_json::from_value(req.params.clone()) {
                Ok(meta) => meta,
                Err(e) => {
                    return RpcResponse::error(req.id, -13, format!("invalid metadata: {e}"));
                }
            };

            match store.put_metadata(&meta) {
                Ok(()) => ok(req.id),
                Err(e) => RpcResponse::error(req.id, -14, e),
            }
        }

        "session.list" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            RpcResponse::success(req.id, serde_json::to_value(store.list_sessions()).unwrap())
        }

        "session.delete" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            let session_id = match session_id(req) {
                Ok(session_id) => session_id,
                Err(resp) => return resp,
            };

            match store.delete_session(session_id) {
                Ok(()) => ok(req.id),
                Err(e) => RpcResponse::error(req.id, -15, e),
            }
        }

        "session.get_history" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            let session_id = match session_id(req) {
                Ok(session_id) => session_id,
                Err(resp) => return resp,
            };

            match store.get_history(session_id) {
                Ok(Some(json)) => RpcResponse::success(
                    req.id,
                    serde_json::json!({ "history": json_or_null(json) }),
                ),
                Ok(None) => RpcResponse::success(req.id, serde_json::json!({ "history": null })),
                Err(e) => RpcResponse::error(req.id, -16, e),
            }
        }

        "session.put_history" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            let session_id = match session_id(req) {
                Ok(session_id) => session_id,
                Err(resp) => return resp,
            };
            let history = match json_param(req, "history", -17) {
                Ok(history) => history.to_string(),
                Err(resp) => return resp,
            };

            match store.put_history(session_id, &history) {
                Ok(()) => ok(req.id),
                Err(e) => RpcResponse::error(req.id, -18, e),
            }
        }

        "session.get_tokens" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            let session_id = match session_id(req) {
                Ok(session_id) => session_id,
                Err(resp) => return resp,
            };

            match store.get_tokens(session_id) {
                Ok(Some(json)) => RpcResponse::success(
                    req.id,
                    serde_json::json!({ "tokens": json_or_null(json) }),
                ),
                Ok(None) => RpcResponse::success(req.id, serde_json::json!({ "tokens": null })),
                Err(e) => RpcResponse::error(req.id, -19, e),
            }
        }

        "session.put_tokens" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            let session_id = match session_id(req) {
                Ok(session_id) => session_id,
                Err(resp) => return resp,
            };
            let tokens = match json_param(req, "tokens", -17) {
                Ok(tokens) => tokens.to_string(),
                Err(resp) => return resp,
            };

            match store.put_tokens(session_id, &tokens) {
                Ok(()) => ok(req.id),
                Err(e) => RpcResponse::error(req.id, -18, e),
            }
        }

        "session.get_context" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            let session_id = match session_id(req) {
                Ok(session_id) => session_id,
                Err(resp) => return resp,
            };

            match store.get_context(session_id) {
                Ok(Some(json)) => RpcResponse::success(
                    req.id,
                    serde_json::json!({ "context": json_or_null(json) }),
                ),
                Ok(None) => RpcResponse::success(req.id, serde_json::json!({ "context": null })),
                Err(e) => RpcResponse::error(req.id, -25, e),
            }
        }

        "session.put_context" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            let session_id = match session_id(req) {
                Ok(session_id) => session_id,
                Err(resp) => return resp,
            };
            let context = match json_param(req, "context", -26) {
                Ok(context) => context.to_string(),
                Err(resp) => return resp,
            };

            match store.put_context(session_id, &context) {
                Ok(()) => ok(req.id),
                Err(e) => RpcResponse::error(req.id, -27, e),
            }
        }

        "session.get_checkpoints" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            let session_id = match session_id(req) {
                Ok(session_id) => session_id,
                Err(resp) => return resp,
            };

            match store.get_checkpoints(session_id) {
                Ok(Some(json)) => RpcResponse::success(
                    req.id,
                    serde_json::json!({ "checkpoints": json_or_null(json) }),
                ),
                Ok(None) => RpcResponse::success(req.id, serde_json::json!({ "checkpoints": [] })),
                Err(e) => RpcResponse::error(req.id, -28, e),
            }
        }

        "session.put_checkpoint" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            let session_id = match session_id(req) {
                Ok(session_id) => session_id,
                Err(resp) => return resp,
            };
            let checkpoint = match json_param(req, "checkpoint", -29) {
                Ok(checkpoint) => checkpoint.clone(),
                Err(resp) => return resp,
            };

            match store.put_checkpoint(session_id, checkpoint) {
                Ok(()) => ok(req.id),
                Err(e) => RpcResponse::error(req.id, -30, e),
            }
        }

        "session.stats" => {
            let store = match session_store(core, req.id) {
                Ok(store) => store,
                Err(resp) => return resp,
            };
            RpcResponse::success(req.id, store.stats())
        }

        "secret.store" => {
            let store = match &core.encryption_store {
                Some(store) => store,
                None => {
                    return RpcResponse::error(req.id, -20, "encryption store not initialized");
                }
            };
            let params: StoreSecretParams = match serde_json::from_value(req.params.clone()) {
                Ok(params) => params,
                Err(e) => return RpcResponse::error(req.id, -21, format!("invalid params: {e}")),
            };

            match store.store_secret(&params.key, &params.value) {
                Ok(()) => ok(req.id),
                Err(e) => RpcResponse::error(req.id, -22, e),
            }
        }

        "secret.load" => {
            let store = match &core.encryption_store {
                Some(store) => store,
                None => {
                    return RpcResponse::error(req.id, -20, "encryption store not initialized");
                }
            };
            let params: LoadSecretParams = match serde_json::from_value(req.params.clone()) {
                Ok(params) => params,
                Err(e) => return RpcResponse::error(req.id, -21, format!("invalid params: {e}")),
            };

            match store.load_secret(&params.key) {
                Ok(Some(value)) => {
                    RpcResponse::success(req.id, serde_json::json!({ "value": value }))
                }
                Ok(None) => RpcResponse::success(req.id, serde_json::Value::Null),
                Err(e) => RpcResponse::error(req.id, -23, e),
            }
        }

        "secret.delete" => {
            let store = match &core.encryption_store {
                Some(store) => store,
                None => {
                    return RpcResponse::error(req.id, -20, "encryption store not initialized");
                }
            };
            let params: LoadSecretParams = match serde_json::from_value(req.params.clone()) {
                Ok(params) => params,
                Err(e) => return RpcResponse::error(req.id, -21, format!("invalid params: {e}")),
            };

            match store.delete_secret(&params.key) {
                Ok(()) => ok(req.id),
                Err(e) => RpcResponse::error(req.id, -24, e),
            }
        }

        "token.count" => {
            let params: CountTokensParams = match serde_json::from_value(req.params.clone()) {
                Ok(params) => params,
                Err(e) => return RpcResponse::error(req.id, -40, format!("invalid params: {e}")),
            };

            match core.tokenizer.count_smart(&params.text, &params.model) {
                Ok(tokens) => RpcResponse::success(req.id, serde_json::json!({ "tokens": tokens })),
                Err(e) => RpcResponse::error(req.id, -41, e),
            }
        }

        "token.count_precise" => {
            let params: CountTokensParams = match serde_json::from_value(req.params.clone()) {
                Ok(params) => params,
                Err(e) => return RpcResponse::error(req.id, -40, format!("invalid params: {e}")),
            };

            match core.tokenizer.count_precise(&params.text, &params.model) {
                Ok(tokens) => RpcResponse::success(req.id, serde_json::json!({ "tokens": tokens })),
                Err(e) => RpcResponse::error(req.id, -41, e),
            }
        }

        "token.count_fast" => {
            let params: CountTokensParams = match serde_json::from_value(req.params.clone()) {
                Ok(params) => params,
                Err(e) => return RpcResponse::error(req.id, -40, format!("invalid params: {e}")),
            };

            match core.tokenizer.count_fast(&params.text, &params.model) {
                Ok(tokens) => RpcResponse::success(req.id, serde_json::json!({ "tokens": tokens })),
                Err(e) => RpcResponse::error(req.id, -41, e),
            }
        }

        "pool.acquire" => {
            let params: AcquireAgentParams = match serde_json::from_value(req.params.clone()) {
                Ok(params) => params,
                Err(e) => return RpcResponse::error(req.id, -50, format!("invalid params: {e}")),
            };

            match core
                .agent_pool
                .acquire(&params.agent_id, params.memory_limit_mb)
            {
                Ok(info) => RpcResponse::success(req.id, serde_json::to_value(info).unwrap()),
                Err(e) => RpcResponse::error(req.id, -51, e),
            }
        }

        "pool.release" => {
            let params: ReleaseAgentParams = match serde_json::from_value(req.params.clone()) {
                Ok(params) => params,
                Err(e) => return RpcResponse::error(req.id, -50, format!("invalid params: {e}")),
            };

            match core.agent_pool.release(&params.agent_id) {
                Ok(()) => ok(req.id),
                Err(e) => RpcResponse::error(req.id, -52, e),
            }
        }

        "pool.stats" => RpcResponse::success(req.id, core.agent_pool.get_stats()),

        "pool.list" => RpcResponse::success(
            req.id,
            serde_json::to_value(core.agent_pool.list_agents()).unwrap(),
        ),

        "pool.cleanup" => {
            let cleaned = core.agent_pool.cleanup_idle();
            RpcResponse::success(req.id, serde_json::json!({ "cleaned": cleaned }))
        }

        "ping" => RpcResponse::success(req.id, serde_json::json!({ "pong": true })),

        "version" => RpcResponse::success(
            req.id,
            serde_json::json!({
                "version": "1.0.0",
                "build": "release",
            }),
        ),

        _ => RpcResponse::error(req.id, -99, format!("unknown method: {}", req.method)),
    }
}
