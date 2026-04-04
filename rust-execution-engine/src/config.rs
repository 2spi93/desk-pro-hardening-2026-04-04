use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub engine_name: String,
    pub default_latency_ms: u64,
    pub hedge_depth_ratio: f64,
    pub hft_enabled: bool,
    pub hft_ring_capacity: usize,
    pub hft_worker_core: Option<usize>,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            host: env::var("RUST_EXECUTION_ENGINE_HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            port: env::var("RUST_EXECUTION_ENGINE_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(8011),
            engine_name: env::var("RUST_EXECUTION_ENGINE_NAME")
                .unwrap_or_else(|_| "rust-execution-engine".to_string()),
            default_latency_ms: env::var("RUST_EXECUTION_ENGINE_DEFAULT_LATENCY_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(9),
            hedge_depth_ratio: env::var("RUST_EXECUTION_ENGINE_HEDGE_DEPTH_RATIO")
                .ok()
                .and_then(|value| value.parse::<f64>().ok())
                .unwrap_or(1.15),
            hft_enabled: env::var("RUST_EXECUTION_ENGINE_HFT_ENABLED")
                .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
                .unwrap_or(false),
            hft_ring_capacity: env::var("RUST_EXECUTION_ENGINE_HFT_RING_CAPACITY")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(4096),
            hft_worker_core: env::var("RUST_EXECUTION_ENGINE_HFT_WORKER_CORE")
                .ok()
                .and_then(|value| value.parse::<usize>().ok()),
        }
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}