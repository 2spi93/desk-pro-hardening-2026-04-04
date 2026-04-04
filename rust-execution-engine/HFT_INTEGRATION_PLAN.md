# Rust HFT Integration Plan

Objectif: preparer une integration HFT progressive sans casser le moteur d'execution actuel.

## Etape 1 - Bench

- Binaire de bench local: `cargo run --release --bin hft_ring_bench`
- Mesure le cout moyen push/pop d'une queue lock-free basee sur `ArrayQueue`
- Sert de baseline avant toute insertion dans le hot path execute/preview

## Etape 2 - Ring Buffer / Queue

- Runtime prepare dans `src/hft.rs`
- Queue lock-free en memoire avec stats `enqueued / dropped / processed`
- Aucun remplacement du path decisionnel actuel pour l'instant

## Etape 3 - Worker epingle CPU

- Worker dedie lance au boot si `RUST_EXECUTION_ENGINE_HFT_ENABLED=1`
- Pinning CPU Linux via `sched_setaffinity`
- Health expose `hft_worker_started`, `hft_queue_depth`, `hft_processed`, `hft_dropped`

## Etape 4 - Adapter execution

- Hook deja place dans `core.rs` pour enregistrer chaque preview/execute dans le runtime HFT
- Phase suivante: convertir `record_request()` en `record_market_event()` + `record_execution_intent()`
- Puis remplacer les estimations de route/fill par un kernel HFT dedie, sous feature flag

## Variables d'environnement

- `RUST_EXECUTION_ENGINE_HFT_ENABLED=1`
- `RUST_EXECUTION_ENGINE_HFT_RING_CAPACITY=4096`
- `RUST_EXECUTION_ENGINE_HFT_WORKER_CORE=2`

## Regle de deploiement

- Activer en shadow mode d'abord
- Comparer health + bench + drop rate
- Seulement ensuite brancher le kernel decisionnel HFT reel