use tiktoken_rs::{CoreBPE, get_bpe_from_model};

pub struct Tokenizer {
    bpe: CoreBPE,
    model: String,
}

impl Tokenizer {
    pub fn new(model: String) -> Result<Self, String> {
        let bpe = get_bpe_from_model(&model)
            .map_err(|e| format!("Failed to load tokenizer for {}: {}", model, e))?;
        Ok(Self { bpe, model })
    }

    pub fn count(&self, text: &str) -> u32 {
        self.bpe.encode_with_special_tokens(text).len() as u32
    }

    pub fn truncate(&self, text: &str, max_tokens: u32) -> String {
        let tokens = self.bpe.encode_with_special_tokens(text);
        if tokens.len() <= max_tokens as usize {
            return text.to_string();
        }
        let truncated = &tokens[..max_tokens as usize];
        self.bpe.decode(truncated.to_vec())
            .unwrap_or_else(|_| text.chars().take(max_tokens as usize * 4).collect())
    }
}

pub fn supported_models() -> Vec<String> {
    vec![
        "gpt-4".to_string(),
        "gpt-4o".to_string(),
        "gpt-3.5-turbo".to_string(),
        "claude-3-opus-20240229".to_string(),
        "claude-3-sonnet-20240229".to_string(),
        "claude-3-haiku-20240307".to_string(),
        "text-davinci-003".to_string(),
    ]
}
