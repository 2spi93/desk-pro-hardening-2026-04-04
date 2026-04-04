mod adapters;
mod config;
mod core;
mod hft;
mod state;
mod types;

use axum::{extract::State, routing::{get, post}, Json, Router};
use tokio::time::{sleep, Duration};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::{
    config::Config,
    core::{execute, preview},
    state::AppState,
    types::{ExecutionRequest, ExecutionResponse, HealthResponse},
};

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env();
    let bind_addr = config.bind_addr();
    let state = AppState::new(config.clone());
    let app = Router::new()
        .route("/health", get(health))
        .route("/preview", post(preview_handler))
        .route("/execute", post(execute_handler))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("failed to bind rust execution engine");
    tracing::info!(bind_addr, "rust execution engine listening");
    axum::serve(listener, app)
        .await
        .expect("rust execution engine exited unexpectedly");
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let hft = state.hft_runtime.as_ref().map(|runtime| runtime.health_snapshot());
    Json(HealthResponse {
        status: "ok".to_string(),
        engine: state.config.engine_name.clone(),
        port: state.config.port,
        hft_enabled: hft.as_ref().map(|snapshot| snapshot.enabled).unwrap_or(false),
        hft_worker_started: hft.as_ref().map(|snapshot| snapshot.worker_started).unwrap_or(false),
        hft_queue_depth: hft.as_ref().map(|snapshot| snapshot.queue_depth).unwrap_or(0),
        hft_ring_capacity: hft.as_ref().map(|snapshot| snapshot.ring_capacity).unwrap_or(0),
        hft_processed: hft.as_ref().map(|snapshot| snapshot.processed).unwrap_or(0),
        hft_dropped: hft.as_ref().map(|snapshot| snapshot.dropped).unwrap_or(0),
    })
}

async fn execute_handler(
    State(state): State<AppState>,
    Json(request): Json<ExecutionRequest>,
) -> Json<ExecutionResponse> {
    if request.execution_delay_ms > 0 {
        sleep(Duration::from_millis(request.execution_delay_ms.min(5_000))).await;
    }
    Json(execute(&state, request))
}

async fn preview_handler(
    State(state): State<AppState>,
    Json(request): Json<ExecutionRequest>,
) -> Json<ExecutionResponse> {
    Json(preview(&state, request))
}