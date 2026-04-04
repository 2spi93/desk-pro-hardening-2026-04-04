#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-/opt/txt}"
BACKUP_DIR="${ROOT_DIR}/.migration-backup-$(date +%Y%m%d-%H%M%S)"

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "[error] Root directory not found: $ROOT_DIR" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[error] Run as root (sudo)" >&2
  exit 1
fi

echo "[1/8] Backup compose and scripts"
mkdir -p "$BACKUP_DIR"
cp -a "$ROOT_DIR/docker-compose.yml" "$BACKUP_DIR/" || true
cp -a "$ROOT_DIR/docker-compose.distributed.yml" "$BACKUP_DIR/" || true
cp -a "$ROOT_DIR/scripts" "$BACKUP_DIR/" || true

echo "[2/8] Detect Docker"
command -v docker >/dev/null 2>&1 || { echo "[error] docker is not installed" >&2; exit 1; }
docker --version

echo "[3/8] Install Compose v2 plugin if missing"
if docker compose version >/dev/null 2>&1; then
  echo "[ok] docker compose v2 already available"
else
  apt-get update -y
  if apt-get install -y docker-compose-plugin; then
    echo "[ok] docker-compose-plugin installed from apt"
  elif apt-get install -y docker-compose-v2; then
    echo "[ok] docker-compose-v2 installed from apt"
  else
    echo "[warn] apt package unavailable, installing compose plugin manually"
    arch="$(uname -m)"
    case "$arch" in
      x86_64) compose_arch="x86_64" ;;
      aarch64|arm64) compose_arch="aarch64" ;;
      *) echo "[error] unsupported architecture: $arch" >&2; exit 1 ;;
    esac
    compose_version="v2.29.7"
    install_dir="/usr/local/lib/docker/cli-plugins"
    mkdir -p "$install_dir"
    curl -fL "https://github.com/docker/compose/releases/download/${compose_version}/docker-compose-linux-${compose_arch}" -o "$install_dir/docker-compose"
    chmod +x "$install_dir/docker-compose"
  fi
  docker compose version
fi

echo "[4/8] Freeze legacy v1 binary if present"
if command -v docker-compose >/dev/null 2>&1; then
  LEGACY_PATH="$(command -v docker-compose)"
  mv "$LEGACY_PATH" "${LEGACY_PATH}.v1.bak.$(date +%s)" || true
  cat >/usr/local/bin/docker-compose <<'EOF'
#!/usr/bin/env bash
exec docker compose "$@"
EOF
  chmod +x /usr/local/bin/docker-compose
  echo "[ok] docker-compose now forwards to docker compose"
fi

echo "[5/8] Compose config validation"
cd "$ROOT_DIR"
docker compose -f docker-compose.yml config >/dev/null
if [[ -f docker-compose.distributed.yml ]]; then
  docker compose -f docker-compose.yml -f docker-compose.distributed.yml config >/dev/null
fi

echo "[5b/8] Clean legacy compose v1 containers (name conflicts)"
legacy_regex='^[a-f0-9]{12,}_(txt-postgres|mission-control-ui|mission-control-gateway|mission-control-tls|control-plane|market-data|risk-gateway|broker-adapter|ai-orchestrator|embeddings-service|mt5-bridge|execution-router)$'
mapfile -t legacy_containers < <(docker ps -a --format '{{.Names}}' | grep -E "$legacy_regex" || true)
if [[ ${#legacy_containers[@]} -gt 0 ]]; then
  echo "[info] Removing legacy containers: ${legacy_containers[*]}"
  docker rm -f "${legacy_containers[@]}" >/dev/null || true
else
  echo "[ok] No legacy conflicting containers"
fi

echo "[6/8] Controlled restart core stack"
if [[ "${SKIP_REDEPLOY:-0}" == "1" ]]; then
  echo "[skip] SKIP_REDEPLOY=1, skipping compose up"
else
  docker compose -f docker-compose.yml up -d --remove-orphans
fi

echo "[7/8] Health checks"
curl -fsS http://127.0.0.1:3000/ >/dev/null && echo "[ok] gateway"
curl -fsS http://127.0.0.1:8000/health >/dev/null && echo "[ok] control-plane"
curl -fsS http://127.0.0.1:8003/health >/dev/null && echo "[ok] market-data"

echo "[8/8] Done"
echo "Backup: $BACKUP_DIR"
echo "Compose v2 migration completed successfully."
