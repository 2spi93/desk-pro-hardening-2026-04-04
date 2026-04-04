#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/opt/txt"
cd "$ROOT_DIR"

echo "[1/6] Build and update stack"
docker compose -f docker-compose.yml up -d --build

echo "[2/6] Apply distributed market-data single-writer overlay"
docker compose -f docker-compose.yml -f docker-compose.distributed.yml up -d market-data

echo "[3/6] Reload gateway/tls after proxy fix"
docker compose -f docker-compose.yml up -d mission-control-gateway mission-control-tls

echo "[4/6] Wait for services"
sleep 5

echo "[5/6] Health checks"
curl -fsS http://127.0.0.1:3000/ >/dev/null && echo "gateway: ok"
curl -fsS http://127.0.0.1:8000/health >/dev/null && echo "control-plane: ok"
curl -fsS http://127.0.0.1:8003/health >/dev/null && echo "market-data: ok"

echo "[6/6] Connector and venue checks"
curl -fsS http://127.0.0.1:8000/v1/connectors/status | head -c 400 && echo
curl -fsS http://127.0.0.1:8003/v1/market/venues | head -c 400 && echo

echo "Deploy done."
