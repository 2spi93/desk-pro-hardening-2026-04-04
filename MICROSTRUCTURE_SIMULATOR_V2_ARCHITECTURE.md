# Microstructure Simulator V2 Architecture

Date: 2026-04-02
Status: design cible, repo-aligned
Decision: hot path en Rust, orchestration et replay en Python

## Objective

Construire un simulateur microstructure V2 qui reduit le gap simulation -> reel en modelant:

- queue priority reelle
- matching engine par venue
- hidden liquidity
- partial fills dynamiques
- latency jitter
- cancel / liquidity fade / spoof-like pressure
- reality-gap feedback vers predictor-v8

Le but n'est pas de remplacer le stack actuel. Le but est de brancher une couche de simulation execution-aware sous feature flag, en shadow mode d'abord, puis comme source de preview/validation pour le RL offline.

## Repo Mapping

Le repo a deja les briques utiles:

- `apps/market_data_plane`: ingestion et diffusion market data
- `apps/execution_router`: profils venue, routing et premier niveau de simulation execution
- `apps/control_plane`: orchestration systeme et endpoints UI
- `apps/predictor_v8`: world model, friction, latent features, replay enrichi
- `rust-execution-engine`: hot path preview/execute, HFT runtime, future kernel microstructure
- `shared/models.py`: contrats Pydantic partages
- `database/migrations`: schemas persistants

La bonne architecture pour ce repo est donc:

- laisser le temps reel et l'event sourcing en Python
- deplacer la logique de matching, queue et fill simulation en Rust
- fermer la boucle avec `predictor-v8` via un Reality Gap Engine

## Design Principles

1. Environment quality > model complexity
2. Le simulateur doit etre venue-aware, pas generic-only
3. Le hot path doit rester lock-free ou previsible en cout
4. Toute activation commence en shadow mode
5. Les contrats de messages doivent etre append-only et versionnes
6. Le systeme doit apprendre du reel via `predicted_execution - real_execution`

## Service Decomposition

### 1. Market Data Event Publisher

Service: existant, extension de `apps/market_data_plane`

Responsabilite:

- normaliser snapshots et deltas L2/L3 selon venue
- publier un flux d'evenements append-only
- etiqueter les trous de donnees, resyncs et quality flags

Entrees:

- WebSocket venue
- REST backfill venue

Sorties:

- `MarketEventEnvelope`
- `VenueStateSnapshot`
- `TradePrintEvent`

Repo touchpoints:

- `apps/market_data_plane/main.py`
- `shared/models.py` ou nouveau `shared/microstructure_models.py`
- `database/migrations/*_market_event_log.sql`

Transport v1 dans ce repo:

- WebSocket existant pour stream live
- table Postgres append-only pour replay et audit
- endpoint HTTP pour backfill/replay slices

### 2. Microstructure Simulator Coordinator

Service: nouveau, `apps/microstructure_simulator`

Responsabilite:

- orchestrer replay, scenarios et simulation runs
- hydrater le kernel Rust avec le contexte de marche
- piloter mode replay vs synthetic perturbation
- persister les resultats de run

Entrees:

- `MarketEventEnvelope`
- `ExecutionIntentEvent`
- commandes control-plane

Sorties:

- `SimulationRunStarted`
- `SimulationRunCompleted`
- `SimExecutionReport`
- `RealityGapSample`

Repo touchpoints:

- `apps/microstructure_simulator/main.py` nouveau
- `docker-compose.yml` nouveau service `microstructure-simulator`
- `apps/control_plane/main.py` pour orchestration

Port propose:

- `8009`

Env propose:

- `MICROSTRUCTURE_SIMULATOR_URL=http://microstructure-simulator:8009`

### 3. Venue Profile and Routing Adapter

Service: existant, extension de `apps/execution_router`

Responsabilite:

- exposer les profils venue utilisables par le simulateur
- transformer les infos de routing en `ExecutionIntentEvent`
- fournir un premier score execution-aware quand le kernel Rust n'est pas actif

Entrees:

- `ExecutionRequest`
- state market data

Sorties:

- `ExecutionIntentEvent`
- `VenueProfileSnapshot`

Repo touchpoints:

- `apps/execution_router/main.py`
- `shared/models.py`

Note:

Les profils deja presents dans `VENUE_EXECUTION_PROFILES` deviennent la base du registre venue V2. Il faut les externaliser progressivement vers configuration + snapshot persiste.

### 4. Rust Matching and Fill Kernel

Service: existant, extension de `rust-execution-engine`

Responsabilite:

- maintenir l'etat microstructure court-terme par symbole / venue
- modeler la queue par niveau de prix
- simuler insertion, avancee de queue, cancels et fills
- calculer slippage, impact, survivability et fill probability

Entrees:

- `MarketEventEnvelope`
- `ExecutionIntentEvent`
- `VenueProfileSnapshot`

Sorties:

- `QueueStateSnapshot`
- `SimFillEvent`
- `SimExecutionReport`

Repo touchpoints:

- `rust-execution-engine/src/types.rs`
- `rust-execution-engine/src/hft.rs`
- `rust-execution-engine/src/core.rs`
- nouveau `rust-execution-engine/src/microstructure.rs`
- nouveau `rust-execution-engine/src/queue_model.rs`
- nouveau `rust-execution-engine/src/impact.rs`

Decision de design:

- `hft.rs` reste le runtime lock-free / ring buffer
- `microstructure.rs` porte le state machine venue/symbol
- `core.rs` choisit entre path legacy et path microstructure via feature flag

### 5. Reality Gap Engine

Service: extension de `apps/predictor_v8`

Responsabilite:

- comparer execution predite et execution reelle
- produire des features de biais du simulateur
- recalibrer hidden liquidity, cancel intensity, latency jitter et impact coefficients

Entrees:

- `SimExecutionReport`
- execution reelle depuis control-plane / broker-adapter / rust-engine

Sorties:

- `RealityGapSample`
- `SimulatorCalibrationUpdate`

Repo touchpoints:

- `apps/predictor_v8/brain.py`
- nouveau `apps/predictor_v8/reality_gap.py`
- endpoint control-plane pour ingest replay compare

### 6. Control Plane and Replay API

Service: existant, extension de `apps/control_plane`

Responsabilite:

- creer et piloter les scenarios
- lancer replay/shadow runs
- servir les comparaisons simule vs reel
- exposer l'etat du calibrage au terminal/UI

Entrees:

- commandes UI
- demandes batch offline RL

Sorties:

- APIs `start-run`, `get-report`, `list-gap-samples`, `apply-calibration`

Repo touchpoints:

- `apps/control_plane/main.py`
- `ui/mission-control/app/api/*` si UI branchee plus tard

## End-to-End Flow

1. `market-data` recoit snapshots/deltas/trade prints et les normalise.
2. Les evenements sont persistants dans `market_event_log` et streamables.
3. `execution-router` produit un `ExecutionIntentEvent` avec route candidates et venue profile.
4. `microstructure-simulator` charge la fenetre d'evenements pertinente et initialise un run.
5. `rust-execution-engine` consomme les events, reconstruit la queue et simule les fills.
6. Le `SimExecutionReport` est stocke et compare a l'execution reelle.
7. `predictor-v8` produit un `RealityGapSample` et ajuste les coefficients du simulateur.
8. Le replay enrichi et l'offline RL consomment les rapports calibres, pas des fills fictifs simplistes.

## Message Schemas

Les schemas ci-dessous sont les contrats minimums a ajouter d'abord en Pydantic, puis en Rust via `serde`.

### A. MarketEventEnvelope

```json
{
  "schema_version": "micro.v2",
  "event_id": "uuid",
  "event_type": "book_delta",
  "venue": "binance",
  "symbol": "BTCUSDT",
  "event_ts_ns": 1712050000000000000,
  "ingest_ts_ns": 1712050000000100000,
  "sequence": 845120331,
  "source": "market-data-plane",
  "payload": {}
}
```

Types initiaux de `event_type`:

- `book_snapshot`
- `book_delta`
- `trade_print`
- `venue_state`
- `latency_tick`
- `liquidity_fade`

### B. BookDeltaPayload

```json
{
  "bids": [[68250.1, 1.25], [68250.0, 0.80]],
  "asks": [[68250.2, 0.95], [68250.3, 1.10]],
  "top_levels": 20,
  "is_resync": false,
  "checksum": "optional",
  "quality_flags": ["live"]
}
```

### C. ExecutionIntentEvent

```json
{
  "intent_id": "uuid",
  "decision_id": "decision-123",
  "origin": "execution-router",
  "symbol": "BTCUSDT",
  "side": "buy",
  "target_notional_usd": 25000.0,
  "limit_price": 68250.2,
  "time_in_force": "ioc",
  "preferred_venue": "binance",
  "route_candidates": [
    {
      "venue": "binance",
      "spread_bps": 1.8,
      "available_depth_usd": 420000.0,
      "latency_ms": 16.0,
      "fill_probability": 0.81,
      "matching_rule": "price-time",
      "queue_priority_risk": 0.12,
      "hidden_liquidity_ratio": 0.10,
      "partial_fill_risk": 0.10,
      "micro_latency_jitter_ms": 4.0
    }
  ],
  "metadata": {
    "regime": "high_vol",
    "execution_delay_ms": 140
  }
}
```

### D. QueueStateSnapshot

```json
{
  "run_id": "uuid",
  "venue": "binance",
  "symbol": "BTCUSDT",
  "price": 68250.2,
  "visible_ahead_qty": 1.84,
  "estimated_hidden_ahead_qty": 0.22,
  "cancel_intensity": 0.18,
  "trade_intensity": 0.41,
  "queue_position_pct": 0.63,
  "snapshot_ts_ns": 1712050000000300000
}
```

### E. SimFillEvent

```json
{
  "run_id": "uuid",
  "intent_id": "uuid",
  "venue": "binance",
  "fill_id": "uuid",
  "fill_ts_ns": 1712050000000410000,
  "fill_price": 68250.25,
  "fill_qty": 0.11,
  "remaining_qty": 0.25,
  "fill_type": "partial",
  "depth_level": 0,
  "queue_ahead_qty": 0.48,
  "hidden_liquidity_used_qty": 0.03,
  "slippage_bps": 2.4,
  "impact_bps": 0.9
}
```

### F. SimExecutionReport

```json
{
  "run_id": "uuid",
  "decision_id": "decision-123",
  "intent_id": "uuid",
  "status": "completed",
  "venue": "binance",
  "accepted": true,
  "predicted_fill_probability": 0.78,
  "realized_fill_ratio": 0.64,
  "predicted_slippage_bps": 3.8,
  "realized_slippage_bps": 5.1,
  "predicted_latency_ms": 19.0,
  "realized_latency_ms": 27.0,
  "predicted_impact_bps": 1.4,
  "realized_impact_bps": 2.2,
  "survivability_score": 0.71,
  "reason_codes": ["partial_fill", "latency_jitter_high"],
  "fills": []
}
```

### G. RealityGapSample

```json
{
  "sample_id": "uuid",
  "decision_id": "decision-123",
  "symbol": "BTCUSDT",
  "venue": "binance",
  "regime": "high_vol_low_liquidity",
  "gap_fill_probability": -0.14,
  "gap_slippage_bps": 1.3,
  "gap_latency_ms": 8.0,
  "gap_impact_bps": 0.8,
  "gap_hidden_liquidity_ratio": -0.05,
  "failure_source": "execution",
  "calibration_action": "increase_latency_jitter_and_partial_fill_risk",
  "created_at": "2026-04-02T12:00:00Z"
}
```

## Storage Model

Tables a ajouter:

1. `market_event_log`
   Append-only, partitionnable par jour et venue.

2. `simulation_runs`
   Metadonnees de run: scenario, symbole, venue, debut/fin, status.

3. `simulation_fills`
   Fills simules par run.

4. `reality_gap_samples`
   Ecart simule vs reel, utile pour calibration et offline RL.

5. `venue_profile_snapshots`
   Versionnage des profils venue et coefficients calibres.

Schema minimal recommande:

- cle primaire UUID
- `created_at` UTC
- `schema_version`
- JSONB pour payload detaille
- index `(venue, symbol, event_ts_ns)` sur `market_event_log`
- index `(decision_id)` sur `simulation_runs` et `reality_gap_samples`

## API Surface

### Microstructure Simulator API

Service: `apps/microstructure_simulator`

Endpoints proposes:

- `POST /v1/sim/runs`
  Cree un run a partir d'une `ExecutionIntentEvent` et d'une fenetre de marche.

- `POST /v1/sim/runs/replay`
  Lance un replay historique sur `[start_ts, end_ts]`.

- `GET /v1/sim/runs/{run_id}`
  Retourne `SimExecutionReport` + queue snapshots.

- `POST /v1/sim/reality-gap`
  Ingest d'une execution reelle pour comparaison.

- `GET /v1/sim/venue-profiles`
  Retourne les profils venue calibres.

- `POST /v1/sim/calibration/apply`
  Applique une mise a jour de coefficients sous feature flag.

### Rust Engine Internal API

Ajouter sous feature flag microstructure:

- `POST /preview-microstructure`
- `POST /execute-microstructure`
- `POST /record-market-event`
- `GET /microstructure/health`

## Feature Flags

Flags recommandes:

- `RUST_EXECUTION_ENGINE_MICROSTRUCTURE_ENABLED=0|1`
- `MICROSTRUCTURE_SIMULATOR_ENABLED=0|1`
- `MICROSTRUCTURE_SIMULATOR_SHADOW_ONLY=1`
- `MICROSTRUCTURE_REPLAY_PERSIST_EVENTS=1`
- `PREDICTOR_REALITY_GAP_ENABLED=1`

Strategie d'activation:

1. persist-only
2. shadow preview
3. compare simule vs reel
4. preview path branche au terminal
5. execute path seulement apres calibration stable

## Order of Implementation in This Repo

### Phase 0 - Contracts and Migrations

Objectif:

- figer les schemas avant d'ajouter du comportement

Fichiers:

- `shared/models.py` ou nouveau `shared/microstructure_models.py`
- `rust-execution-engine/src/types.rs`
- `database/migrations/*_microstructure_v2.sql`

Deliverables:

- contrats Pydantic et Rust
- tables `market_event_log`, `simulation_runs`, `simulation_fills`, `reality_gap_samples`, `venue_profile_snapshots`

### Phase 1 - Event Logging in Market Data Plane

Objectif:

- capturer snapshots, deltas et trade prints sous forme append-only

Fichiers:

- `apps/market_data_plane/main.py`
- `shared/db.py`

Deliverables:

- persistance des market events
- endpoint replay slice `GET /v1/market/events`
- quality flags et resync markers

### Phase 2 - Execution Intent Normalization

Objectif:

- sortir du path ad hoc par service et standardiser l'intent execution-aware

Fichiers:

- `apps/execution_router/main.py`
- `shared/models.py`
- `apps/control_plane/main.py`

Deliverables:

- `ExecutionIntentEvent`
- venue profiles versionnes
- emission vers simulateur

### Phase 3 - Rust Kernel V2

Objectif:

- introduire le state machine microstructure sans casser `execute/preview`

Fichiers:

- `rust-execution-engine/src/hft.rs`
- `rust-execution-engine/src/core.rs`
- `rust-execution-engine/src/types.rs`
- nouveaux modules `microstructure.rs`, `queue_model.rs`, `impact.rs`

Deliverables:

- ingestion `record_market_event()`
- reconstruction du carnet court-terme
- queue advance model
- partial fill simulation
- slippage + impact estimates

Regle:

- aucun remplacement du path legacy avant shadow diff acceptable

### Phase 4 - Microstructure Simulator Service

Objectif:

- orchestrer replay, scenarios et execution reports

Fichiers:

- nouveau `apps/microstructure_simulator/main.py`
- `docker-compose.yml`

Deliverables:

- API `runs`, `replay`, `report`, `reality-gap`
- service compose `microstructure-simulator:8009`

### Phase 5 - Reality Gap Engine

Objectif:

- apprendre du reel, pas seulement du replay

Fichiers:

- `apps/predictor_v8/brain.py`
- nouveau `apps/predictor_v8/reality_gap.py`
- `apps/control_plane/main.py`

Deliverables:

- calcul `predicted - real`
- update des coefficients `latency_jitter`, `partial_fill_risk`, `hidden_liquidity_ratio`, `impact`
- score de qualite du simulateur par venue/regime

### Phase 6 - UI and Replay Integration

Objectif:

- brancher les rapports au terminal et a l'offline RL

Fichiers:

- `ui/mission-control/app/api/execution/*`
- `ui/mission-control/app/terminal/*`
- `apps/control_plane/main.py`

Deliverables:

- replay compare simule vs reel
- forensic view des reason codes
- export dataset pour offline RL

## Non-Goals for V2

Ces points ne doivent pas bloquer la V2:

- ordre de grandeur ABIDES complet des le jour 1
- vrai L3 exhaustif sur toutes les venues
- multi-broker direct live training
- exploration RL online

La V2 doit d'abord etre:

- execution-aware
- calibrable
- comparable au reel
- utilisable pour replay/offline RL

## Acceptance Criteria

Le design est considere utile quand:

1. Un replay `decision_id -> SimExecutionReport` existe pour chaque decision importante.
2. Le rust kernel sait expliquer `why blocked / why partial / why high slippage`.
3. Le reality gap est stocke et consultable par venue, symbole et regime.
4. Le simulateur bat le path legacy sur prediction de fill/slippage en out-of-sample.
5. Le terminal peut visualiser `predicted vs real` sans toucher au live path.

## Recommended First Slice

Premier slice a forte valeur, faible risque:

1. ajouter les contrats + migrations
2. persister `book_delta` et `trade_print`
3. emettre `ExecutionIntentEvent` depuis `execution-router`
4. ajouter `record_market_event()` au runtime Rust
5. produire un `SimExecutionReport` shadow-only pour `preview`
6. enregistrer le `RealityGapSample` sans recalibration automatique

Ce slice donne deja:

- replay execution-aware
- mesure du gap reel
- base propre pour l'offline RL

## Bottom Line

Dans ce repo, la bonne forme de simulateur microstructure V2 n'est pas un gros service monolithique neuf. C'est une chaine simple:

- `market-data` capture et rejoue les evenements
- `execution-router` normalise l'intent execution-aware
- `rust-execution-engine` simule la microstructure et les fills
- `predictor-v8` apprend l'ecart au reel
- `control-plane` orchestre

Le vrai edge vient ensuite du `Reality Gap Engine`, pas d'un modele plus gros. Le simulateur doit donc etre concu comme un systeme calibrable par le live, pas comme une verite figee.