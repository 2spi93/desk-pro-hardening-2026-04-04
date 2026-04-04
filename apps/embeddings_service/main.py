from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from shared.db import ensure_schema, execute, fetch_all, fetch_one, json_dumps

app = FastAPI(title="Embeddings Service", version="0.1.0")


class MemoryCase(BaseModel):
    symbol: str
    regime: str
    strategy_id: str
    timeframe: str | None = None
    market_features: dict[str, float] = Field(default_factory=dict)
    decision: dict[str, Any] = Field(default_factory=dict)
    outcome: dict[str, Any] = Field(default_factory=dict)
    timestamp: str


class IndexRequest(BaseModel):
    strategy_id: str | None = None
    content: str | None = Field(default=None, min_length=3)
    memory_case: MemoryCase | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    serialization: str = Field(default="stable_json")


class RetrieveRequest(BaseModel):
    query: str | None = Field(default=None, min_length=2)
    query_case: MemoryCase | None = None
    strategy_id: str | None = None
    symbol: str | None = None
    regime: str | None = None
    timeframe: str | None = None
    compatible_strategies: list[str] = Field(default_factory=list)
    max_age_hours: int | None = Field(default=None, ge=1, le=24 * 90)
    query_market_features: dict[str, float] = Field(default_factory=dict)
    top_k: int = Field(default=5, ge=1, le=50)
    candidates_limit: int = Field(default=500, ge=10, le=2000)
    weights: dict[str, float] = Field(default_factory=dict)


class BatchIndexRequest(BaseModel):
    items: list[IndexRequest] = Field(min_length=1, max_length=100)


def _model_name() -> str:
    return os.getenv("EMBEDDING_MODEL_PRIMARY", "nomic-embed-text")


def _ollama_url() -> str:
    return os.getenv("MISTRAL_LOCAL_URL", "http://host.docker.internal:11434").rstrip("/")


def _as_float_vector(raw: Any) -> list[float]:
    if not isinstance(raw, list):
        return []
    return [float(v) for v in raw]


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    n = min(len(a), len(b))
    dot = sum(a[i] * b[i] for i in range(n))
    na = math.sqrt(sum(a[i] * a[i] for i in range(n)))
    nb = math.sqrt(sum(b[i] * b[i] for i in range(n)))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _content_hash(model: str, text: str) -> str:
    return hashlib.sha256(f"{model}|{text}".encode("utf-8")).hexdigest()


def _parse_ts(raw: str | None) -> datetime | None:
    if not raw:
        return None
    fixed = raw.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(fixed)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _memory_case_to_record(case: MemoryCase) -> tuple[str, dict[str, Any], str | None]:
    payload = {
        "symbol": case.symbol,
        "regime": case.regime,
        "strategy_id": case.strategy_id,
        "timeframe": case.timeframe or "",
        "market_features": case.market_features,
        "decision": case.decision,
        "outcome": case.outcome,
        "timestamp": case.timestamp,
    }
    return _stable_json(payload), payload, case.timeframe


def _feature_distance_score(query_features: dict[str, float], candidate_features: dict[str, Any]) -> float:
    if not query_features or not candidate_features:
        return 0.5
    keys = [k for k in query_features.keys() if k in candidate_features]
    if not keys:
        return 0.5
    diffs: list[float] = []
    for key in keys:
        qv = float(query_features[key])
        cv = float(candidate_features[key])
        scale = max(abs(qv), abs(cv), 1e-9)
        diffs.append(abs(qv - cv) / scale)
    avg = sum(diffs) / len(diffs)
    return _clamp01(1.0 - avg)


def _recency_weight(case_timestamp: datetime | None, half_life_hours: float = 72.0) -> float:
    if not case_timestamp:
        return 0.4
    age_hours = max(0.0, (datetime.now(UTC) - case_timestamp).total_seconds() / 3600.0)
    return _clamp01(math.exp(-math.log(2.0) * age_hours / max(1.0, half_life_hours)))


def _weights(request_weights: dict[str, float]) -> dict[str, float]:
    base = {
        "vector": 0.5,
        "regime": 0.2,
        "feature": 0.2,
        "recency": 0.1,
    }
    for key in base:
        if key in request_weights:
            base[key] = max(0.0, float(request_weights[key]))
    total = sum(base.values())
    if total <= 0:
        return {"vector": 0.5, "regime": 0.2, "feature": 0.2, "recency": 0.1}
    return {key: value / total for key, value in base.items()}


def _to_insights(top: list[dict[str, Any]]) -> list[str]:
    insights: list[str] = []
    wins = 0
    losses = 0
    for item in top:
        outcome = ((item.get("metadata") or {}).get("outcome") or {})
        label = str(outcome.get("label", "")).lower()
        if label == "win":
            wins += 1
        if label == "loss":
            losses += 1
    if wins > losses:
        insights.append("Historical memory leans bullish for this context.")
    if losses > wins:
        insights.append("Historical memory flags elevated failure risk in similar setups.")
    if not insights:
        insights.append("Historical memory is mixed; keep strict risk constraints.")
    return insights


def _format_memory_cases(top: list[dict[str, Any]]) -> list[str]:
    lines: list[str] = []
    for idx, item in enumerate(top[:3], start=1):
        metadata = item.get("metadata") or {}
        decision = metadata.get("decision") or {}
        outcome = metadata.get("outcome") or {}
        lines.append(
            f"Case {idx}: {item.get('symbol', 'n/a')} {item.get('regime', 'n/a')} "
            f"{decision.get('action', 'n/a')} -> {outcome.get('pnl_24h', 'n/a')} ({outcome.get('label', 'n/a')})"
        )
    return lines


async def _embed(text: str) -> list[float]:
    payload = {"model": _model_name(), "prompt": text}
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(f"{_ollama_url()}/api/embeddings", json=payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail="Embedding backend unavailable")
        data = response.json()
        vec = _as_float_vector(data.get("embedding", []))
        if not vec:
            raise HTTPException(status_code=502, detail="Empty embedding vector")
        return vec


async def _embed_many(texts: list[str]) -> list[list[float]]:
    semaphore = asyncio.Semaphore(4)

    async def _run(one: str) -> list[float]:
        async with semaphore:
            return await _embed(one)

    return await asyncio.gather(*[_run(text) for text in texts])


@app.on_event("startup")
async def startup() -> None:
    ensure_schema()


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "embeddings-service",
        "model": _model_name(),
        "backend": _ollama_url(),
    }


@app.post("/v1/index")
async def index_memory(request: IndexRequest) -> dict[str, Any]:
    if request.memory_case is None and not request.content:
        raise HTTPException(status_code=400, detail="content or memory_case is required")

    strategy_id = request.strategy_id or (request.memory_case.strategy_id if request.memory_case else None)
    if not strategy_id:
        raise HTTPException(status_code=400, detail="strategy_id is required")

    if request.memory_case:
        normalized_content, normalized_metadata, timeframe = _memory_case_to_record(request.memory_case)
    else:
        normalized_content = (request.content or "").strip()
        normalized_metadata = {}
        timeframe = None

    merged_metadata = dict(normalized_metadata)
    merged_metadata.update(request.metadata)

    text_to_embed = normalized_content
    if len(text_to_embed) > 6000:
        text_to_embed = text_to_embed[:6000]
        merged_metadata["doc_truncated"] = True

    content_hash = _content_hash(_model_name(), text_to_embed)
    cached = fetch_one(
        """
        SELECT embedding_id, vector
        FROM strategy_embeddings
        WHERE content_hash = %s AND model_name = %s
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (content_hash, _model_name()),
    )

    if cached and cached.get("vector"):
        vector = _as_float_vector(cached["vector"])
        from_cache = True
    else:
        vector = await _embed(text_to_embed)
        from_cache = False

    embedding_id = str(uuid4())
    symbol = str(merged_metadata.get("symbol", "")) or None
    regime = str(merged_metadata.get("regime", "")) or None
    tf = str(merged_metadata.get("timeframe", timeframe or "")) or None
    decision = merged_metadata.get("decision") or {}
    outcome = merged_metadata.get("outcome") or {}
    case_ts = _parse_ts(str(merged_metadata.get("timestamp", "")))

    execute(
        """
        INSERT INTO strategy_embeddings (
            embedding_id, strategy_id, content, content_hash, symbol, regime, timeframe,
            case_timestamp, decision_action, outcome_label, metadata, model_name, vector
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s::jsonb, %s, %s::jsonb)
        """,
        (
            embedding_id,
            strategy_id,
            text_to_embed,
            content_hash,
            symbol,
            regime,
            tf,
            case_ts,
            str(decision.get("action", "")) or None,
            str(outcome.get("label", "")) or None,
            json_dumps(merged_metadata),
            _model_name(),
            json_dumps(vector),
        ),
    )
    return {
        "status": "indexed",
        "embedding_id": embedding_id,
        "strategy_id": strategy_id,
        "dimension": len(vector),
        "cached_vector": from_cache,
        "content_hash": content_hash,
    }


@app.post("/v1/index/batch")
async def index_memory_batch(request: BatchIndexRequest) -> dict[str, Any]:
    prepared: list[tuple[IndexRequest, str, dict[str, Any], str]] = []
    for item in request.items:
        if item.memory_case is None and not item.content:
            continue
        strategy_id = item.strategy_id or (item.memory_case.strategy_id if item.memory_case else "")
        if not strategy_id:
            continue
        if item.memory_case:
            normalized_content, normalized_metadata, _ = _memory_case_to_record(item.memory_case)
        else:
            normalized_content = (item.content or "").strip()
            normalized_metadata = {}
        merged_metadata = dict(normalized_metadata)
        merged_metadata.update(item.metadata)
        text = normalized_content[:6000]
        prepared.append((item, strategy_id, merged_metadata, text))

    vectors = await _embed_many([row[3] for row in prepared]) if prepared else []
    created = 0
    for i, (item, strategy_id, merged_metadata, text) in enumerate(prepared):
        vector = vectors[i]
        decision = merged_metadata.get("decision") or {}
        outcome = merged_metadata.get("outcome") or {}
        execute(
            """
            INSERT INTO strategy_embeddings (
                embedding_id, strategy_id, content, content_hash, symbol, regime, timeframe,
                case_timestamp, decision_action, outcome_label, metadata, model_name, vector
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s::jsonb, %s, %s::jsonb)
            """,
            (
                str(uuid4()),
                strategy_id,
                text,
                _content_hash(_model_name(), text),
                str(merged_metadata.get("symbol", "")) or None,
                str(merged_metadata.get("regime", "")) or None,
                str(merged_metadata.get("timeframe", "")) or None,
                _parse_ts(str(merged_metadata.get("timestamp", ""))),
                str(decision.get("action", "")) or None,
                str(outcome.get("label", "")) or None,
                json_dumps(merged_metadata),
                _model_name(),
                json_dumps(vector),
            ),
        )
        created += 1

    return {"status": "ok", "indexed": created, "received": len(request.items)}


@app.post("/v1/retrieve")
async def retrieve_memory(request: RetrieveRequest) -> dict[str, Any]:
    if request.query_case is None and not request.query:
        raise HTTPException(status_code=400, detail="query or query_case is required")

    symbol = request.symbol
    regime = request.regime
    timeframe = request.timeframe
    query_text = request.query or ""
    query_features = dict(request.query_market_features)

    if request.query_case:
        query_text, case_meta, inferred_tf = _memory_case_to_record(request.query_case)
        symbol = symbol or case_meta.get("symbol")
        regime = regime or case_meta.get("regime")
        timeframe = timeframe or inferred_tf
        query_features = query_features or dict(case_meta.get("market_features") or {})

    query_vec = await _embed(query_text)

    filters: list[str] = []
    params: list[Any] = []
    if request.strategy_id:
        filters.append("strategy_id = %s")
        params.append(request.strategy_id)
    if symbol:
        filters.append("symbol = %s")
        params.append(symbol)
    if regime:
        filters.append("regime = %s")
        params.append(regime)
    if timeframe:
        filters.append("timeframe = %s")
        params.append(timeframe)
    if request.compatible_strategies:
        placeholders = ", ".join(["%s"] * len(request.compatible_strategies))
        filters.append(f"strategy_id IN ({placeholders})")
        params.extend(request.compatible_strategies)
    if request.max_age_hours:
        filters.append("created_at >= NOW() - (%s * INTERVAL '1 hour')")
        params.append(int(request.max_age_hours))

    where_clause = "WHERE " + " AND ".join(filters) if filters else ""
    params.append(int(request.candidates_limit))
    rows = fetch_all(
        f"""
        SELECT embedding_id, strategy_id, symbol, regime, timeframe, content, metadata, model_name, vector, case_timestamp, created_at
        FROM strategy_embeddings
        {where_clause}
        ORDER BY created_at DESC
        LIMIT %s
        """,
        tuple(params),
    )

    ws = _weights(request.weights)
    ranked: list[dict[str, Any]] = []
    for row in rows:
        metadata = row.get("metadata") or {}
        vector_sim = _cosine(query_vec, _as_float_vector(row.get("vector", [])))
        regime_match = 1.0 if regime and str(row.get("regime", "")) == str(regime) else 0.0
        candidate_features = metadata.get("market_features") or {}
        feature_score = _feature_distance_score(query_features, candidate_features)
        case_ts = row.get("case_timestamp")
        recency_score = _recency_weight(case_ts)
        final_sim = (
            ws["vector"] * vector_sim
            + ws["regime"] * regime_match
            + ws["feature"] * feature_score
            + ws["recency"] * recency_score
        )
        ranked.append(
            {
                "embedding_id": row["embedding_id"],
                "strategy_id": row["strategy_id"],
                "symbol": row.get("symbol"),
                "regime": row.get("regime"),
                "timeframe": row.get("timeframe"),
                "content": row["content"],
                "metadata": metadata,
                "similarity": round(final_sim, 6),
                "vector_similarity": round(vector_sim, 6),
                "regime_match": round(regime_match, 6),
                "feature_distance": round(feature_score, 6),
                "recency_weight": round(recency_score, 6),
                "created_at": row["created_at"],
            }
        )

    ranked.sort(key=lambda item: item["similarity"], reverse=True)
    top = ranked[: request.top_k]

    wins = 0
    losses = 0
    for item in top:
        outcome = ((item.get("metadata") or {}).get("outcome") or {})
        label = str(outcome.get("label", "")).lower()
        if label == "win":
            wins += 1
        elif label == "loss":
            losses += 1
        elif float(outcome.get("pnl_24h", 0.0) or 0.0) > 0:
            wins += 1
        elif float(outcome.get("pnl_24h", 0.0) or 0.0) < 0:
            losses += 1
    denom = max(1, wins + losses)
    win_rate = wins / denom
    avg_vec = sum(item["vector_similarity"] for item in top) / max(1, len(top))
    avg_final = sum(item["similarity"] for item in top) / max(1, len(top))

    execute(
        """
        INSERT INTO retrieval_events (
            query_hash, strategy_id, symbol, regime, timeframe,
            requested_top_k, candidates_count, results_count,
            avg_vector_similarity, avg_final_similarity, win_rate_top_results,
            memory_impact_score_delta, payload
        )
        VALUES (%s, %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s::jsonb)
        """,
        (
            hashlib.sha256(query_text.encode("utf-8")).hexdigest(),
            request.strategy_id,
            symbol,
            regime,
            timeframe,
            request.top_k,
            len(rows),
            len(top),
            avg_vec,
            avg_final,
            win_rate,
            (win_rate - 0.5),
            json_dumps({
                "weights": ws,
                "query_market_features": query_features,
                "compatible_strategies": request.compatible_strategies,
            }),
        ),
    )

    high_drawdown = False
    for item in top:
        outcome = ((item.get("metadata") or {}).get("outcome") or {})
        drawdown = float(outcome.get("drawdown", 0.0) or 0.0)
        if drawdown <= -0.05:
            high_drawdown = True

    return {
        "status": "ok",
        "query": query_text,
        "filters": {
            "strategy_id": request.strategy_id,
            "symbol": symbol,
            "regime": regime,
            "timeframe": timeframe,
            "compatible_strategies": request.compatible_strategies,
            "max_age_hours": request.max_age_hours,
        },
        "weights": ws,
        "kpis": {
            "candidates_count": len(rows),
            "results_count": len(top),
            "avg_vector_similarity": round(avg_vec, 6),
            "avg_final_similarity": round(avg_final, 6),
            "win_rate_top_results": round(win_rate, 6),
            "memory_impact_score_delta": round(win_rate - 0.5, 6),
        },
        "historical_alignment_score": round(win_rate, 6),
        "risk_flags": {
            "high_drawdown": high_drawdown,
        },
        "formatted_memory": _format_memory_cases(top),
        "insights": _to_insights(top),
        "results": top,
    }


@app.get("/v1/kpi/retrieval")
async def retrieval_kpi(window_hours: int = 24) -> dict[str, Any]:
    window = max(1, min(window_hours, 24 * 30))
    rows = fetch_all(
        """
        SELECT
            COUNT(*) AS samples,
            AVG(COALESCE(avg_vector_similarity, 0)) AS avg_vector_similarity,
            AVG(COALESCE(avg_final_similarity, 0)) AS avg_final_similarity,
            AVG(COALESCE(memory_impact_score_delta, 0)) AS avg_memory_impact,
            AVG(COALESCE(win_rate_top_results, 0)) AS avg_win_rate_top
        FROM retrieval_events
        WHERE created_at >= NOW() - (%s * INTERVAL '1 hour')
        """,
        (window,),
    )
    sample = rows[0] if rows else {}
    clusters = fetch_all(
        """
        SELECT symbol, regime,
               COUNT(*) AS samples,
               AVG(COALESCE(win_rate_top_results, 0)) AS win_rate
        FROM retrieval_events
        WHERE created_at >= NOW() - (%s * INTERVAL '1 hour')
        GROUP BY symbol, regime
        ORDER BY samples DESC
        LIMIT 20
        """,
        (window,),
    )
    return {
        "status": "ok",
        "window_hours": window,
        "summary": sample,
        "clusters": clusters,
    }
