FROM rust:1.77-bookworm AS builder

WORKDIR /app

COPY rust-execution-engine/Cargo.toml rust-execution-engine/Cargo.lock ./
COPY rust-execution-engine/src ./src

RUN cargo build --release && cargo build --release --bin hft_ring_bench

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/rust-execution-engine /usr/local/bin/rust-execution-engine

EXPOSE 8011

ENTRYPOINT ["/usr/local/bin/rust-execution-engine"]