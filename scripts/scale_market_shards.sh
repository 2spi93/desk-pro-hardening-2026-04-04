#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-/root/txt}"
TOTAL_SHARDS="${TOTAL_SHARDS:-8}"
CPU_PER_SHARD="${CPU_PER_SHARD:-0.75}"
MEM_PER_SHARD="${MEM_PER_SHARD:-1024m}"
MAIN_CPU="${MAIN_CPU:-2.5}"
MAIN_MEM="${MAIN_MEM:-3072m}"

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "[error] Root directory not found: $ROOT_DIR" >&2
  exit 1
fi

echo "[1/5] Ensure primary market-data shard 0/${TOTAL_SHARDS}"
docker rm -f market-data >/dev/null 2>&1 || true
docker run -d --name market-data \
  --restart unless-stopped \
  --cpus "$MAIN_CPU" \
  --memory "$MAIN_MEM" \
  --network txt_default \
  -p 8003:8003 \
  -v "${ROOT_DIR}:/workspace" \
  -w /workspace \
  -e DATABASE_URL='postgresql://txt:txt@postgres:5432/mission_control' \
  -e MARKET_SHARD_INDEX='0' \
  -e MARKET_SHARD_TOTAL="${TOTAL_SHARDS}" \
  -e MARKET_SYNC_SECONDS='12' \
  -e MARKET_DEPTH_STREAM_ENABLED='1' \
  txt-python:3.11 \
  sh -c "uvicorn apps.market_data_plane.main:app --host 0.0.0.0 --port 8003 --workers 4 --ws websockets" >/dev/null

echo "[2/5] Start shards 1..$((TOTAL_SHARDS-1)) with CPU/RAM tuning"
for i in $(seq 1 $((TOTAL_SHARDS-1))); do
  name="market-data-shard-${i}"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" \
    --restart unless-stopped \
    --cpus "$CPU_PER_SHARD" \
    --memory "$MEM_PER_SHARD" \
    --network txt_default \
    -v "${ROOT_DIR}:/workspace" \
    -w /workspace \
    -e DATABASE_URL='postgresql://txt:txt@postgres:5432/mission_control' \
    -e MARKET_SHARD_INDEX="$i" \
    -e MARKET_SHARD_TOTAL="${TOTAL_SHARDS}" \
    -e MARKET_SYNC_SECONDS='12' \
    -e MARKET_DEPTH_STREAM_ENABLED='1' \
    txt-python:3.11 \
    sh -c "uvicorn apps.market_data_plane.main:app --host 0.0.0.0 --port 8003 --workers 1 --ws websockets" >/dev/null
  echo "[ok] $name cpu=$CPU_PER_SHARD mem=$MEM_PER_SHARD"
done

echo "[3/5] Verify containers"
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'market-data($|-shard-)' || true

echo "[4/5] Verify shard health"
curl -fsS http://127.0.0.1:8003/health | python3 -m json.tool

echo "[5/5] Done"
echo "Shards active: 0..$((TOTAL_SHARDS-1))"
