/// Agent Pool - 内存池化 + LRU 淘汰
///
/// 类似 Linux 内核的 slab allocator：
/// - 预分配 agent 槽位，避免频繁 malloc
/// - LRU 淘汰最久不用的 agent
/// - 内存使用追踪，防止 OOM
///
use lru::LruCache;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;

/// Agent 状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub agent_id: String,
    pub memory_limit_mb: u64,
    pub created_at: String,
    pub last_active: String,
    pub turn_count: u64,
    pub status: AgentStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AgentStatus {
    Active,
    Idle,
    Evicted,
}

/// Agent 槽位 — 类似 slab
struct AgentSlot {
    info: AgentInfo,
    created_at: Instant,
    last_access: Instant,
}

/// AgentPool — 内存池化引擎
///
/// 架构：
/// ```text
///   AgentPool
///   ├── LRU 淘汰器 (控制并发数)
///   ├── 内存追踪器 (防止 OOM)
///   └── 统计收集器 (metrics)
/// ```
pub struct AgentPool {
    /// 活跃 agents
    agents: RwLock<HashMap<String, AgentSlot>>,
    /// LRU 顺序追踪
    lru_order: RwLock<Vec<String>>,
    /// 配置
    max_concurrent: usize,
    max_total_memory_mb: u64,
    /// 统计
    stats: RwLock<PoolStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PoolStats {
    pub total_acquired: u64,
    pub total_released: u64,
    pub total_evicted: u64,
    pub peak_active: usize,
    pub peak_memory_mb: u64,
}

impl AgentPool {
    pub fn new(max_concurrent: usize, max_total_memory_mb: u64) -> Self {
        Self {
            agents: RwLock::new(HashMap::new()),
            lru_order: RwLock::new(Vec::new()),
            max_concurrent,
            max_total_memory_mb,
            stats: RwLock::new(PoolStats::default()),
        }
    }

    /// 获取/创建一个 agent 槽位
    pub fn acquire(&self, agent_id: &str, memory_limit_mb: u64) -> Result<AgentInfo, String> {
        let now = Instant::now();
        let now_str = chrono::Utc::now().to_rfc3339();

        // 检查是否已存在
        {
            let mut agents = self.agents.write();
            if let Some(slot) = agents.get_mut(agent_id) {
                slot.last_access = now;
                slot.info.last_active = now_str.clone();
                slot.info.turn_count += 1;
                slot.info.status = AgentStatus::Active;

                // 更新 LRU 顺序
                let mut order = self.lru_order.write();
                order.retain(|id| id != agent_id);
                order.push(agent_id.to_string());

                return Ok(slot.info.clone());
            }
        }

        // 需要新建 — 先检查是否需要淘汰
        self.evict_if_needed(memory_limit_mb)?;

        // 创建新槽位
        let info = AgentInfo {
            agent_id: agent_id.to_string(),
            memory_limit_mb,
            created_at: now_str.clone(),
            last_active: now_str,
            turn_count: 1,
            status: AgentStatus::Active,
        };

        let slot = AgentSlot {
            info: info.clone(),
            created_at: now,
            last_access: now,
        };

        {
            let mut agents = self.agents.write();
            agents.insert(agent_id.to_string(), slot);

            let mut order = self.lru_order.write();
            order.push(agent_id.to_string());

            // 更新统计
            let mut stats = self.stats.write();
            stats.total_acquired += 1;
            let current = agents.len();
            if current > stats.peak_active {
                stats.peak_active = current;
            }
            let total_mem: u64 = agents.values().map(|s| s.info.memory_limit_mb).sum();
            if total_mem > stats.peak_memory_mb {
                stats.peak_memory_mb = total_mem;
            }
        }

        Ok(info)
    }

    /// 释放 agent（标记为 idle，不立即删除）
    pub fn release(&self, agent_id: &str) -> Result<(), String> {
        let mut agents = self.agents.write();
        if let Some(slot) = agents.get_mut(agent_id) {
            slot.info.status = AgentStatus::Idle;
            slot.last_access = Instant::now();
            slot.info.last_active = chrono::Utc::now().to_rfc3339();
        }

        let mut stats = self.stats.write();
        stats.total_released += 1;

        Ok(())
    }

    /// 完全移除 agent
    pub fn remove(&self, agent_id: &str) -> Result<(), String> {
        self.agents.write().remove(agent_id);
        self.lru_order.write().retain(|id| id != agent_id);
        Ok(())
    }

    /// 需要时淘汰最久不用的 agent
    fn evict_if_needed(&self, new_memory_mb: u64) -> Result<(), String> {
        let agents = self.agents.read();
        let current_count = agents.len();
        let current_memory: u64 = agents.values().map(|s| s.info.memory_limit_mb).sum();

        let needs_evict_count = current_count >= self.max_concurrent;
        let needs_evict_memory = current_memory + new_memory_mb > self.max_total_memory_mb;

        if !needs_evict_count && !needs_evict_memory {
            return Ok(());
        }

        // 找 LRU 的 idle agent 淘汰
        let order = self.lru_order.read();
        let victim = order
            .iter()
            .find(|id| {
                agents
                    .get(*id)
                    .map(|s| s.info.status == AgentStatus::Idle)
                    .unwrap_or(false)
            })
            .cloned();

        if let Some(victim_id) = victim {
            drop(agents);
            drop(order);
            self.remove(&victim_id)?;
            self.stats.write().total_evicted += 1;
            return Ok(());
        }

        // 没有 idle 的，淘汰最久不用的 active
        let order = self.lru_order.read();
        if let Some(victim_id) = order.first().cloned() {
            drop(order);
            self.remove(&victim_id)?;
            self.stats.write().total_evicted += 1;
            return Ok(());
        }

        Err("agent pool: cannot evict, pool may be corrupted".to_string())
    }

    /// 获取统计信息
    pub fn get_stats(&self) -> serde_json::Value {
        let agents = self.agents.read();
        let stats = self.stats.read();
        let total_memory: u64 = agents.values().map(|s| s.info.memory_limit_mb).sum();
        let active_count = agents.values().filter(|s| s.info.status == AgentStatus::Active).count();

        serde_json::json!({
            "active_agents": active_count,
            "total_agents": agents.len(),
            "total_memory_mb": total_memory,
            "max_concurrent": self.max_concurrent,
            "max_total_memory_mb": self.max_total_memory_mb,
            "stats": {
                "total_acquired": stats.total_acquired,
                "total_released": stats.total_released,
                "total_evicted": stats.total_evicted,
                "peak_active": stats.peak_active,
                "peak_memory_mb": stats.peak_memory_mb,
            },
            "agents": agents.values().map(|s| &s.info).collect::<Vec<_>>(),
        })
    }

    /// 列出所有 agents
    pub fn list_agents(&self) -> Vec<AgentInfo> {
        self.agents.read().values().map(|s| s.info.clone()).collect()
    }

    /// 清理所有 idle agents
    pub fn cleanup_idle(&self) -> usize {
        let mut agents = self.agents.write();
        let idle_ids: Vec<String> = agents
            .iter()
            .filter(|(_, s)| s.info.status == AgentStatus::Idle)
            .map(|(id, _)| id.clone())
            .collect();

        for id in &idle_ids {
            agents.remove(id);
        }
        self.lru_order.write().retain(|id| !idle_ids.contains(id));

        idle_ids.len()
    }
}
