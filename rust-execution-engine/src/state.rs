use crate::{config::Config, hft::HftRuntime};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub hft_runtime: Option<HftRuntime>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let hft_runtime = HftRuntime::from_config(&config);
        Self { config, hft_runtime }
    }
}