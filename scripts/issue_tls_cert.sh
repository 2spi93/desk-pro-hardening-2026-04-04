#!/usr/bin/env bash
set -euo pipefail

DOMAINS_RAW="${DOMAINS:-${DOMAIN:-app.txt.gtixt.com,txt.gtixt.com,api.txt.gtixt.com,staging.txt.gtixt.com,api.staging.txt.gtixt.com}}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBROOT_DIR="${WEBROOT_DIR:-$ROOT_DIR/data/certbot/www}"
CONFIG_DIR="${CONFIG_DIR:-$ROOT_DIR/secrets/tls}"
WORK_DIR="${WORK_DIR:-$ROOT_DIR/data/certbot/work}"
LOGS_DIR="${LOGS_DIR:-$ROOT_DIR/logs/certbot}"
EMAIL="${TLS_ACME_EMAIL:-}"
IFS=', ' read -r -a DOMAINS <<< "$DOMAINS_RAW"
DOMAINS=("${DOMAINS[@]}")
if [[ ${#DOMAINS[@]} -eq 0 || -z "${DOMAINS[0]}" ]]; then
  echo "[fail] no domains specified" >&2
  exit 1
fi
CERT_NAME="${CERT_NAME:-${DOMAINS[0]}}"
PRIMARY_DOMAIN="${DOMAINS[0]}"
LIVE_DIR="$CONFIG_DIR/live/$CERT_NAME"
ARCHIVE_DIR="$CONFIG_DIR/archive/$CERT_NAME"
RENEWAL_CONF="$CONFIG_DIR/renewal/$CERT_NAME.conf"

mkdir -p "$WEBROOT_DIR" "$WORK_DIR" "$LOGS_DIR" "$CONFIG_DIR/live" "$CONFIG_DIR/renewal"

if [[ -d "$LIVE_DIR" && -f "$LIVE_DIR/fullchain.pem" && ! -L "$LIVE_DIR/fullchain.pem" && ! -d "$ARCHIVE_DIR" ]]; then
  backup_dir="$CONFIG_DIR/live/${CERT_NAME}.selfsigned.$(date +%Y%m%d%H%M%S)"
  mv "$LIVE_DIR" "$backup_dir"
  rm -f "$RENEWAL_CONF"
fi

if ! command -v certbot >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y certbot
fi

cd "$ROOT_DIR"

docker compose -f docker-compose.yml up -d mission-control-gateway mission-control-tls

request_args=(
  certonly
  --webroot
  -w "$WEBROOT_DIR"
  --non-interactive
  --agree-tos
  --config-dir "$CONFIG_DIR"
  --work-dir "$WORK_DIR"
  --logs-dir "$LOGS_DIR"
  --keep-until-expiring
  --cert-name "$CERT_NAME"
)

for domain in "${DOMAINS[@]}"; do
  request_args+=( -d "$domain" )
done

if [[ -f "$RENEWAL_CONF" || -d "$ARCHIVE_DIR" ]]; then
  request_args+=( --expand )
fi

if [[ -n "$EMAIL" ]]; then
  request_args+=(--email "$EMAIL")
else
  request_args+=(--register-unsafely-without-email)
fi

certbot "${request_args[@]}"

if [[ ! -s "$CONFIG_DIR/live/$CERT_NAME/fullchain.pem" || ! -s "$CONFIG_DIR/live/$CERT_NAME/privkey.pem" ]]; then
  echo "[fail] missing issued certificate files for $CERT_NAME" >&2
  exit 1
fi

docker compose -f docker-compose.yml up -d mission-control-tls

echo "[ok] certificate available at $CONFIG_DIR/live/$CERT_NAME for domains: ${DOMAINS[*]}"