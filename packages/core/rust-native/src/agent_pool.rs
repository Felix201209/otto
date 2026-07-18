use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use parking_lot::RwLock;
use serde::Serialize;

struct AgentState {
    id: String,
    created_at: Instant,
    last_accessed: Instant,
    memory_bytes: usize,
    execution_log: Vec<String>,
    pending_results: Vec<String>,
}

pub struct AgentPool {
    max_memory_bytes: usize,
    max_agents: usize,
    agents: Arc<RwLock<HashMap<String, AgentState>>>,
    current_memory: Arc<RwLock<usize>>,
}

#[derive(Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub memory_mb: f64,
    pub log_count: u32,
    pub pending_count: u32,
    pub created_secs_ago: u64,
    pub last_accessed_secs_ago: u64,
}

impl AgentPool {
    pub fn new(max_memory_mb: u32, max_agents: u32) -> Self {
        Self {
            max_memory_bytes: max_memory_mb as usize * 1024 * 1024,
            max_agents: max_agents as usize,
            agents: Arc::new(RwLock::new(HashMap::new())),
            current_memory: Arc::new(RwLock::new(0)),
        }
    }

    pub fn register(&self, id: String, initial_memory_mb: u32) -> Result<bool, String> {
        let mut agents = self.agents.write();
        let mut current_memory = self.current_memory.write();
        let initial_memory = initial_memory_mb as usize * 1024 * 1024;

        // 淘汰最久未使用的 agent
        if agents.len() >= self.max_agents {
            let oldest = agents.iter()
                .min_by_key(|(_, a)| a.last_accessed)
                .map(|(id, _)| id.clone());
            if let Some(oldest_id) = oldest {
                if let Some(removed) = agents.remove(&oldest_id) {
                    *current_memory -= removed.memory_bytes;
                }
            } else {
                return Ok(false);
            }
        }

        if *current_memory + initial_memory > self.max_memory_bytes {
            return Ok(false);
        }

        let now = Instant::now();
        agents.insert(id.clone(), AgentState {
            id,
            created_at: now,
            last_accessed: now,
            memory_bytes: initial_memory,
            execution_log: Vec::new(),
            pending_results: Vec::new(),
        });
        *current_memory += initial_memory;
        Ok(true)
    }

    pub fn update_memory(&self, id: &str, new_memory_mb: u32) -> Result<bool, String> {
        let mut agents = self.agents.write();
        let mut current_memory = self.current_memory.write();
        let new_memory = new_memory_mb as usize * 1024 * 1024;

        if let Some(agent) = agents.get_mut(id) {
            let old_memory = agent.memory_bytes;
            if *current_memory - old_memory + new_memory > self.max_memory_bytes {
                return Ok(false);
            }
            agent.memory_bytes = new_memory;
            agent.last_accessed = Instant::now();
            *current_memory = *current_memory - old_memory + new_memory;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn add_log(&self, id: &str, log: String) -> bool {
        let mut agents = self.agents.write();
        if let Some(agent) = agents.get_mut(id) {
            agent.execution_log.push(log);
            agent.last_accessed = Instant::now();
            if agent.execution_log.len() > 200 {
                agent.execution_log.remove(0);
            }
            true
        } else {
            false
        }
    }

    pub fn drain_pending_results(&self, id: &str) -> Vec<String> {
        let mut agents = self.agents.write();
        if let Some(agent) = agents.get_mut(id) {
            agent.last_accessed = Instant::now();
            std::mem::take(&mut agent.pending_results)
        } else {
            Vec::new()
        }
    }

    pub fn unregister(&self, id: &str) -> Result<bool, String> {
        let mut agents = self.agents.write();
        let mut current_memory = self.current_memory.write();
        if let Some(removed) = agents.remove(id) {
            *current_memory -= removed.memory_bytes;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn current_memory_mb(&self) -> f64 {
        *self.current_memory.read() as f64 / 1024.0 / 1024.0
    }

    pub fn max_memory_mb(&self) -> f64 {
        self.max_memory_bytes as f64 / 1024.0 / 1024.0
    }

    pub fn agent_count(&self) -> u32 {
        self.agents.read().len() as u32
    }

    pub fn list_agents(&self) -> Vec<AgentInfo> {
        self.agents.read().values().map(|a| AgentInfo {
            id: a.id.clone(),
            memory_mb: a.memory_bytes as f64 / 1024.0 / 1024.0,
            log_count: a.execution_log.len() as u32,
            pending_count: a.pending_results.len() as u32,
            created_secs_ago: a.created_at.elapsed().as_secs(),
            last_accessed_secs_ago: a.last_accessed.elapsed().as_secs(),
        }).collect()
    }

    pub fn cleanup_idle(&self, idle_seconds: u32) -> u32 {
        let mut agents = self.agents.write();
        let mut current_memory = self.current_memory.write();
        let idle_duration = std::time::Duration::from_secs(idle_seconds as u64);
        let to_remove: Vec<String> = agents.iter()
            .filter(|(_, a)| a.last_accessed.elapsed() > idle_duration)
            .map(|(id, _)| id.clone())
            .collect();
        let count = to_remove.len() as u32;
        for id in to_remove {
            if let Some(removed) = agents.remove(&id) {
                *current_memory -= removed.memory_bytes;
            }
        }
        count
    }
}
