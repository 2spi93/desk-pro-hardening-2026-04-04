use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crossbeam::queue::ArrayQueue;

use crate::config::Config;
use crate::types::ExecutionRequest;

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct FastTradeSample {
    pub estimated_notional_usd: f64,
    pub max_spread_bps: f64,
    pub timestamp_ns: u64,
    pub side: u8,
    pub preview_only: u8,
    pub _pad: [u8; 6],
}

#[derive(Debug, Clone)]
pub struct HftRuntimeConfig {
    pub enabled: bool,
    pub ring_capacity: usize,
    pub worker_core: Option<usize>,
}

#[derive(Debug)]
struct HftStats {
    enqueued: AtomicU64,
    dropped: AtomicU64,
    processed: AtomicU64,
    last_edge_bps: AtomicU64,
    worker_core: AtomicUsize,
    worker_started: AtomicBool,
}

#[derive(Clone)]
pub struct HftRuntime {
    queue: Arc<ArrayQueue<FastTradeSample>>,
    stats: Arc<HftStats>,
    config: HftRuntimeConfig,
}

#[derive(Debug, Clone)]
pub struct HftHealthSnapshot {
    pub enabled: bool,
    pub ring_capacity: usize,
    pub queue_depth: usize,
    pub worker_core: Option<usize>,
    pub worker_started: bool,
    pub enqueued: u64,
    pub dropped: u64,
    pub processed: u64,
    pub last_edge_bps: f64,
}

impl HftRuntimeConfig {
    pub fn from_config(config: &Config) -> Self {
        Self {
            enabled: config.hft_enabled,
            ring_capacity: config.hft_ring_capacity.max(256),
            worker_core: config.hft_worker_core,
        }
    }
}

impl HftRuntime {
    pub fn from_config(config: &Config) -> Option<Self> {
        let runtime_config = HftRuntimeConfig::from_config(config);
        if !runtime_config.enabled {
          return None;
        }

        let runtime = Self {
            queue: Arc::new(ArrayQueue::new(runtime_config.ring_capacity)),
            stats: Arc::new(HftStats {
                enqueued: AtomicU64::new(0),
                dropped: AtomicU64::new(0),
                processed: AtomicU64::new(0),
                last_edge_bps: AtomicU64::new(0),
                worker_core: AtomicUsize::new(runtime_config.worker_core.unwrap_or(usize::MAX)),
                worker_started: AtomicBool::new(false),
            }),
            config: runtime_config,
        };

        runtime.spawn_worker();
        Some(runtime)
    }

    pub fn record_request(&self, request: &ExecutionRequest, preview_only: bool) {
        let sample = FastTradeSample {
            estimated_notional_usd: request.estimated_notional_usd.max(0.0),
            max_spread_bps: request.max_spread_bps.max(0.0),
            timestamp_ns: unix_time_ns(),
            side: if request.side.eq_ignore_ascii_case("sell") { 1 } else { 0 },
            preview_only: if preview_only { 1 } else { 0 },
            _pad: [0; 6],
        };

        if self.queue.push(sample).is_ok() {
            self.stats.enqueued.fetch_add(1, Ordering::Relaxed);
        } else {
            self.stats.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn health_snapshot(&self) -> HftHealthSnapshot {
        HftHealthSnapshot {
            enabled: self.config.enabled,
            ring_capacity: self.config.ring_capacity,
            queue_depth: self.queue.len(),
            worker_core: self.config.worker_core,
            worker_started: self.stats.worker_started.load(Ordering::Relaxed),
            enqueued: self.stats.enqueued.load(Ordering::Relaxed),
            dropped: self.stats.dropped.load(Ordering::Relaxed),
            processed: self.stats.processed.load(Ordering::Relaxed),
            last_edge_bps: f64::from_bits(self.stats.last_edge_bps.load(Ordering::Relaxed)),
        }
    }

    fn spawn_worker(&self) {
        let queue = Arc::clone(&self.queue);
        let stats = Arc::clone(&self.stats);
        let worker_core = self.config.worker_core;

        thread::spawn(move || {
            if let Some(core_id) = worker_core {
                pin_to_core(core_id);
            }
            stats.worker_started.store(true, Ordering::Relaxed);

            loop {
                match queue.pop() {
                    Some(sample) => {
                        let edge_bps = compute_edge_bps(sample.estimated_notional_usd, sample.max_spread_bps);
                        stats.last_edge_bps.store(edge_bps.to_bits(), Ordering::Relaxed);
                        stats.processed.fetch_add(1, Ordering::Relaxed);
                    }
                    None => thread::sleep(Duration::from_micros(50)),
                }
            }
        });
    }
}

#[inline(always)]
fn unix_time_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0)
}

#[inline(always)]
fn compute_edge_bps(notional_usd: f64, spread_bps: f64) -> f64 {
    let fee_bps = 0.10;
    let latency_cost_bps = if notional_usd > 0.0 { (notional_usd / 10_000.0) * 0.08 } else { 0.0 };
    (spread_bps * 0.32) - fee_bps - latency_cost_bps
}

pub fn pin_to_core(core_id: usize) {
    #[cfg(target_os = "linux")]
    unsafe {
        let mut set: libc::cpu_set_t = std::mem::zeroed();
        libc::CPU_SET(core_id, &mut set);
        let _ = libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set);
    }

    #[cfg(not(target_os = "linux"))]
    let _ = core_id;
}