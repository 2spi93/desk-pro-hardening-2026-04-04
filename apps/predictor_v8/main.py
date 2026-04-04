from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query

from .brain import AutonomousBrain
from .calibration_history import build_failure_lr_calibration_history, load_failure_lr_calibration_history
from .config import BRAIN_BATCH_SIZE, BRAIN_BOOTSTRAP_EXPERIENCES, BRAIN_MIN_LEARN_BATCH, BRAIN_REPLAY_CAPACITY, BRAIN_STATE_PATH, EXPERIENCES_LOG_PATH, FAILURE_LR_CALIBRATION_HISTORY_LIMIT, KAIROS_FEATURE_FLAGS_PATH, MAX_ALLOWED_BACKLOG, MAX_ALLOWED_LATENCY_MS, MIN_RENDERABLE_ROWS, MODEL_PATH, REALITY_GAP_STATE_PATH, SAMPLES_LOG_PATH, SERVICE_NAME, SERVICE_VERSION
from .model import V8Model
from .reality_gap import RealityGapEngine
from .storage import append_jsonl, load_json, load_jsonl_tail, save_json
from .trainer import Trainer

app = FastAPI(title="Predictor V8", version=SERVICE_VERSION)

MODEL = V8Model()
TRAINER = Trainer(MODEL, SAMPLES_LOG_PATH, lambda: save_json(MODEL_PATH, MODEL.dump_state()))
BRAIN = AutonomousBrain(
    MODEL,
    replay_capacity=BRAIN_REPLAY_CAPACITY,
    batch_size=BRAIN_BATCH_SIZE,
    min_learn_batch=BRAIN_MIN_LEARN_BATCH,
    feature_flags_path=KAIROS_FEATURE_FLAGS_PATH,
)
REALITY_GAP = RealityGapEngine()
APP_STARTED_AT = datetime.now(timezone.utc)


def _effective_experiences_log_path() -> Path:
    if EXPERIENCES_LOG_PATH.exists():
        return EXPERIENCES_LOG_PATH
    fallback = Path(__file__).resolve().parents[2] / "data" / "predictor_v8" / "experiences.jsonl"
    if str(EXPERIENCES_LOG_PATH).startswith("/workspace/") and fallback.exists():
        return fallback
    return EXPERIENCES_LOG_PATH


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _build_reliability(payload: dict[str, Any]) -> dict[str, Any]:
    latency_ms = _to_float(payload.get("latency_ms"), 0.0)
    backlog = _to_float(payload.get("backlog"), 0.0)
    renderable_rows = _to_float(payload.get("renderable_rows"), 0.0)
    depth_imbalance = payload.get("depth_imbalance")
    volume_30s = _to_float(payload.get("volume_30s"), 0.0)

    reasons: list[str] = []
    if renderable_rows < MIN_RENDERABLE_ROWS:
        reasons.append("insufficient_renderable_bars")
    if depth_imbalance is None:
        reasons.append("missing_depth_imbalance")
    if latency_ms >= MAX_ALLOWED_LATENCY_MS:
        reasons.append("latency_guard")
    if backlog >= MAX_ALLOWED_BACKLOG:
        reasons.append("kernel_backlog_guard")
    if volume_30s <= 0:
        reasons.append("missing_volume")

    return {
        "data_reliable": len(reasons) == 0,
        "reasons": reasons,
        "limits": {
            "max_latency_ms": MAX_ALLOWED_LATENCY_MS,
            "max_backlog": MAX_ALLOWED_BACKLOG,
            "min_renderable_rows": MIN_RENDERABLE_ROWS,
        },
    }


def _build_execution_gate(payload: dict[str, Any], prediction: dict[str, Any], reliability: dict[str, Any]) -> dict[str, Any]:
    route_mode = str(payload.get("route_mode") or "bestSingleVenue")
    v7_should_execute = bool(payload.get("v7_should_execute"))
    v7_reasons = [str(reason) for reason in payload.get("v7_reasons", []) if isinstance(reason, str)]
    model_should_execute = bool(prediction.get("model_should_execute", prediction.get("should_execute")))
    model_reasons = [str(reason) for reason in prediction.get("model_reasons", []) if isinstance(reason, str)]
    reliable = bool(reliability.get("data_reliable"))

    reasons: list[str] = []
    reasons.extend(str(reason) for reason in reliability.get("reasons", []) if isinstance(reason, str))
    if route_mode == "dualVenueExecution" and not v7_should_execute:
        reasons.extend(v7_reasons)
    if not model_should_execute:
        reasons.extend(model_reasons)

    deduped_reasons: list[str] = []
    for reason in reasons:
        if reason and reason not in deduped_reasons:
            deduped_reasons.append(reason)

    final_should_execute = reliable and model_should_execute and (route_mode != "dualVenueExecution" or v7_should_execute)
    return {
        "route_mode": route_mode,
        "v7_should_execute": v7_should_execute,
        "v7_reasons": v7_reasons,
        "model_should_execute": model_should_execute,
        "model_reasons": model_reasons,
        "should_execute": final_should_execute,
        "reasons": deduped_reasons,
    }


def _persist_brain_state() -> None:
    save_json(BRAIN_STATE_PATH, BRAIN.dump_state())


def _persist_reality_gap_state() -> None:
    save_json(REALITY_GAP_STATE_PATH, REALITY_GAP.dump_state())


def _looks_like_predictor_training_item(item: dict[str, Any]) -> bool:
    if isinstance(item.get("features"), dict):
        return True
    predictor_keys = {
        "latency_ms",
        "spread_bps",
        "arb_edge_bps",
        "available_depth_usd",
        "depth_imbalance",
        "volume_30s",
        "volatility_bps",
        "fill_probability",
        "backlog_pressure",
        "render_pressure",
    }
    return any(key in item for key in predictor_keys)


@app.on_event("startup")
async def startup() -> None:
    saved = load_json(MODEL_PATH)
    if isinstance(saved, dict):
        MODEL.load_state(saved)
    brain_state = load_json(BRAIN_STATE_PATH)
    if isinstance(brain_state, dict):
        BRAIN.load_state(brain_state)
    reality_gap_state = load_json(REALITY_GAP_STATE_PATH)
    if isinstance(reality_gap_state, dict):
        REALITY_GAP.load_state(reality_gap_state)
    BRAIN.bootstrap_experiences(load_jsonl_tail(_effective_experiences_log_path(), BRAIN_BOOTSTRAP_EXPERIENCES))
    asyncio.create_task(TRAINER.loop())


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "uptime_sec": max(0, int((datetime.now(timezone.utc) - APP_STARTED_AT).total_seconds())),
    }


@app.post("/predict")
async def predict(payload: dict[str, Any]) -> dict[str, Any]:
    reliability = _build_reliability(payload)
    prediction = MODEL.predict(payload)
    prediction["data_reliable"] = reliability["data_reliable"]
    gate = _build_execution_gate(payload, prediction, reliability)
    prediction.update(gate)
    prediction["limits"] = reliability["limits"]
    prediction["autonomous_brain"] = BRAIN.decide(payload, prediction=prediction, reliability=reliability)
    return prediction


@app.post("/train")
async def train(payload: dict[str, Any]) -> dict[str, Any]:
    items = payload.get("items") if isinstance(payload.get("items"), list) else [payload]
    predictor_items = [item for item in items if isinstance(item, dict) and _looks_like_predictor_training_item(item)]
    accepted = await TRAINER.add_samples(predictor_items)
    brain_result = BRAIN.learn_from_payloads([item for item in items if isinstance(item, dict)])
    if brain_result["experience_rows"]:
        append_jsonl(_effective_experiences_log_path(), brain_result["experience_rows"])
        _persist_brain_state()
    return {
        "status": "queued",
        "accepted": accepted,
        "pending": await TRAINER.pending_count(),
        "brain": {
            "accepted": brain_result["accepted"],
            "learned": brain_result["learned"],
            "sampled": brain_result["sampled"],
            "experience_rows": brain_result["experience_rows"],
        },
    }


@app.post("/brain/decide")
async def brain_decide(payload: dict[str, Any]) -> dict[str, Any]:
    reliability = _build_reliability(payload)
    prediction = MODEL.predict(payload)
    prediction["data_reliable"] = reliability["data_reliable"]
    prediction.update(_build_execution_gate(payload, prediction, reliability))
    return BRAIN.decide(payload, prediction=prediction, reliability=reliability)


@app.post("/brain/learn")
async def brain_learn(payload: dict[str, Any]) -> dict[str, Any]:
    items = payload.get("items") if isinstance(payload.get("items"), list) else [payload]
    result = BRAIN.learn_from_payloads([item for item in items if isinstance(item, dict)])
    if result["experience_rows"]:
        append_jsonl(_effective_experiences_log_path(), result["experience_rows"])
        _persist_brain_state()
    return {
        "status": "ok",
        "accepted": result["accepted"],
        "causal_dreams_generated": result.get("causal_dreams_generated", 0),
        "learned": result["learned"],
        "sampled": result["sampled"],
        "experience_rows": result["experience_rows"],
        "stats": result["stats"],
    }


@app.get("/brain/stats")
async def brain_stats() -> dict[str, Any]:
    payload = BRAIN.get_stats()
    payload["service"] = SERVICE_NAME
    return payload


@app.get("/brain/memory-v2")
async def brain_memory_v2() -> dict[str, Any]:
    payload = BRAIN.memory_engine_v2.summary()
    payload["service"] = SERVICE_NAME
    return payload


@app.post("/brain/memory-v2/query")
async def brain_memory_v2_query(payload: dict[str, Any]) -> dict[str, Any]:
    result = BRAIN.query_memory_engine_v2(payload)
    result["service"] = SERVICE_NAME
    return result


@app.post("/brain/strategy-arena")
async def brain_strategy_arena(payload: dict[str, Any]) -> dict[str, Any]:
    result = BRAIN.build_strategy_arena(
        payload,
        prediction=payload.get("prediction") if isinstance(payload.get("prediction"), dict) else None,
    )
    result["service"] = SERVICE_NAME
    return result


@app.get("/brain/calibration/history")
async def brain_calibration_history(
    refresh: bool = Query(False),
    history_limit: int = Query(FAILURE_LR_CALIBRATION_HISTORY_LIMIT, ge=8, le=240),
) -> dict[str, Any]:
    if refresh:
        payload = build_failure_lr_calibration_history(
            experiences_path=_effective_experiences_log_path(),
            history_limit=history_limit,
        )
    else:
        payload = load_failure_lr_calibration_history(history_limit=history_limit)
        if payload is None:
            payload = build_failure_lr_calibration_history(
                experiences_path=_effective_experiences_log_path(),
                history_limit=history_limit,
            )
    payload["service"] = SERVICE_NAME
    return payload


@app.post("/brain/reality-gap/ingest")
async def brain_reality_gap_ingest(payload: dict[str, Any]) -> dict[str, Any]:
    items = payload.get("items") if isinstance(payload.get("items"), list) else [payload]
    apply_calibration = bool(payload.get("apply_calibration", True))
    train_brain = bool(payload.get("train_brain", True))
    result = REALITY_GAP.ingest_payloads([item for item in items if isinstance(item, dict)], apply_calibration=apply_calibration)
    brain_result: dict[str, Any] | None = None
    if train_brain and result["learning_payloads"]:
        brain_result = BRAIN.learn_from_payloads(result["learning_payloads"])
        if brain_result["experience_rows"]:
            append_jsonl(_effective_experiences_log_path(), brain_result["experience_rows"])
            _persist_brain_state()
    if result["accepted"]:
        _persist_reality_gap_state()
    return {
        "status": "ok",
        "accepted": result["accepted"],
        "samples": result["samples"],
        "profiles": result["profiles"],
        "brain": {
            "trained": bool(brain_result),
            "result": brain_result,
        },
        "stats": result["stats"],
    }


@app.get("/brain/reality-gap/profiles")
async def brain_reality_gap_profiles() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "last_ingested_at": REALITY_GAP.last_ingested_at,
        "profiles": REALITY_GAP.profile_rows(),
    }


@app.get("/stats")
async def stats() -> dict[str, Any]:
    payload = MODEL.get_stats()
    payload["pending"] = await TRAINER.pending_count()
    payload["service"] = SERVICE_NAME
    payload["brain"] = BRAIN.get_stats()
    payload["reality_gap"] = {
        "profile_count": len(REALITY_GAP.profiles),
        "last_ingested_at": REALITY_GAP.last_ingested_at,
    }
    return payload
