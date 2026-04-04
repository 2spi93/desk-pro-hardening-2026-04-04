use std::time::Instant;

use crossbeam::queue::ArrayQueue;

#[derive(Copy, Clone, Debug, Default)]
struct FastTradeSample {
    estimated_notional_usd: f64,
    max_spread_bps: f64,
    timestamp_ns: u64,
    side: u8,
}

fn main() {
    const ITERATIONS: usize = 1_000_000;
    let queue = ArrayQueue::new(8192);
    let start = Instant::now();

    for index in 0..ITERATIONS {
        let sample = FastTradeSample {
            estimated_notional_usd: 100.0 + (index % 5) as f64,
            max_spread_bps: 12.0,
            timestamp_ns: index as u64,
            side: (index % 2) as u8,
        };
        while queue.push(sample).is_err() {
            let _ = queue.pop();
        }
        let _ = queue.pop();
    }

    let elapsed = start.elapsed();
    let per_iteration_ns = elapsed.as_nanos() as f64 / ITERATIONS as f64;
    println!(
        "{{\"iterations\":{},\"elapsed_ms\":{:.3},\"per_iteration_ns\":{:.3}}}",
        ITERATIONS,
        elapsed.as_secs_f64() * 1000.0,
        per_iteration_ns
    );
}