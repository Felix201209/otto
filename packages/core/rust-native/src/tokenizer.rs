/// Tokenizer - tiktoken 本地 token 计数
///
/// 类似 Linux 内核的字符编码层：
/// - trait 定义计数接口
/// - tiktoken 是默认实现（精确，离线）
/// - 支持多模型 encoding 切换
///
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use tiktoken_rs::{get_bpe_from_model, CoreBPE};

/// Tokenizer trait — 可替换实现
pub trait TokenCounter: Send + Sync {
    fn count(&self, text: &str, model: &str) -> Result<usize, String>;
}

/// tiktoken 实现 — 精确计数，离线可用
pub struct TiktokenCounter {
    /// 缓存已加载的 BPE（Arc 包装，CoreBPE 不 Clone）
    cache: RwLock<HashMap<String, Arc<CoreBPE>>>,
}

impl TiktokenCounter {
    pub fn new() -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
        }
    }

    fn get_bpe(&self, model: &str) -> Result<Arc<CoreBPE>, String> {
        // 先查缓存
        {
            let cache = self.cache.read();
            if let Some(bpe) = cache.get(model) {
                return Ok(Arc::clone(bpe));
            }
        }

        // 加载并缓存
        let bpe = get_bpe_from_model(model).map_err(|e| format!("load bpe for '{}': {}", model, e))?;
        let bpe = Arc::new(bpe);
        {
            let mut cache = self.cache.write();
            cache.insert(model.to_string(), Arc::clone(&bpe));
        }
        Ok(bpe)
    }
}

impl TokenCounter for TiktokenCounter {
    fn count(&self, text: &str, model: &str) -> Result<usize, String> {
        let bpe = self.get_bpe(model)?;
        Ok(bpe.encode_with_special_tokens(text).len())
    }
}

/// 快速估算器 — 不依赖 tiktoken，纯字符统计
/// 精度约 ±10%，但零开销
pub struct FastEstimator;

impl TokenCounter for FastEstimator {
    fn count(&self, text: &str, _model: &str) -> Result<usize, String> {
        let mut cjk = 0usize;
        let mut other = 0usize;

        for ch in text.chars() {
            let cp = ch as u32;
            if is_cjk(cp) {
                cjk += 1;
            } else {
                other += 1;
            }
        }

        // CJK ≈ 2 char/token, 其他 ≈ 4 char/token
        Ok((cjk + 1) / 2 + (other + 3) / 4)
    }
}

fn is_cjk(cp: u32) -> bool {
    (0x4E00..=0x9FFF).contains(&cp)      // CJK Unified
        || (0x3400..=0x4DBF).contains(&cp) // Extension A
        || (0x20000..=0x2A6DF).contains(&cp) // Extension B
        || (0xF900..=0xFAFF).contains(&cp) // Compatibility
        || (0xFF00..=0xFFEF).contains(&cp) // Fullwidth
        || (0x3000..=0x303F).contains(&cp) // CJK Punctuation
        || (0xAC00..=0xD7AF).contains(&cp) // Hangul
}

/// Tokenizer 引擎 — 对外统一接口
pub struct Tokenizer {
    precise: TiktokenCounter,
    fast: FastEstimator,
}

impl Tokenizer {
    pub fn new() -> Self {
        Self {
            precise: TiktokenCounter::new(),
            fast: FastEstimator,
        }
    }

    /// 精确计数（tiktoken，首次加载模型 ~50ms，后续 ~1ms）
    pub fn count_precise(&self, text: &str, model: &str) -> Result<usize, String> {
        self.precise.count(text, model)
    }

    /// 快速估算（纯字符统计，~0.01ms）
    pub fn count_fast(&self, text: &str, model: &str) -> Result<usize, String> {
        self.fast.count(text, model)
    }

    /// 智能计数 — 短文本用精确，长文本用快速
    pub fn count_smart(&self, text: &str, model: &str) -> Result<usize, String> {
        if text.len() < 1000 {
            self.precise.count(text, model)
        } else {
            // 长文本用快速估算 + 校准
            let fast_estimate = self.fast.count(text, model)?;
            // 取前 200 字符做精确计数，算出比例
            let sample = &text[..text.char_indices().take(200).last().map(|(i, _)| i).unwrap_or(text.len())];
            let precise_sample = self.precise.count(sample, model)?;
            let fast_sample = self.fast.count(sample, model)?;

            if fast_sample > 0 {
                let ratio = precise_sample as f64 / fast_sample as f64;
                Ok((fast_estimate as f64 * ratio).ceil() as usize)
            } else {
                Ok(fast_estimate)
            }
        }
    }

    /// 批量计数
    pub fn count_batch(&self, texts: &[&str], model: &str) -> Result<Vec<usize>, String> {
        texts.iter().map(|t| self.precise.count(t, model)).collect()
    }

    /// 支持的模型列表
    pub fn supported_models() -> Vec<&'static str> {
        vec![
            "gpt-4", "gpt-4-turbo", "gpt-4o", "gpt-4o-mini",
            "gpt-3.5-turbo", "gpt-3.5",
            "text-embedding-ada-002", "text-embedding-3-small", "text-embedding-3-large",
            "claude-3-opus", "claude-3-sonnet", "claude-3-haiku",
            "claude-3.5-sonnet", "claude-sonnet-4-20250514",
        ]
    }
}
