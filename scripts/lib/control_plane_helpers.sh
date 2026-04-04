#!/usr/bin/env bash

txt_source_repo_env() {
  if [ -f /opt/txt/.env ]; then
    set -a
    # shellcheck disable=SC1091
    . /opt/txt/.env
    set +a
  fi
}

txt_trim_trailing_slash() {
  local value="${1:-}"
  printf "%s" "${value%/}"
}

txt_resolve_control_plane_url() {
  local explicit="${1:-}"
  local resolved="${explicit:-${CONTROL_PLANE_URL:-${CONTROL_PLANE_FALLBACK_URL:-${KAIROS_CONTROL_PLANE_URL:-http://127.0.0.1:8000}}}}"
  txt_trim_trailing_slash "$resolved"
}

txt_resolve_secret() {
  local value="${1:-}"
  local file_path="${2:-}"
  if [ -n "$value" ]; then
    printf "%s" "$value"
    return 0
  fi
  if [ -n "$file_path" ] && [ -f "$file_path" ]; then
    tr -d '\n' < "$file_path"
    return 0
  fi
  if [ -n "$file_path" ]; then
    local file_name
    file_name="$(basename "$file_path")"
    for alt in "/opt/txt/secrets/$file_name" "/root/txt/secrets/$file_name"; do
      if [ -f "$alt" ]; then
        tr -d '\n' < "$alt"
        return 0
      fi
    done
  fi
  return 1
}

txt_resolve_user_password() {
  local username="${1:-}"
  local explicit_password="${2:-}"
  if [ -n "$explicit_password" ]; then
    printf "%s" "$explicit_password"
    return 0
  fi
  case "$username" in
    operator)
      txt_resolve_secret "${DEFAULT_OPERATOR_PASSWORD:-}" "${DEFAULT_OPERATOR_PASSWORD_FILE:-}"
      ;;
    admin)
      txt_resolve_secret "${DEFAULT_ADMIN_PASSWORD:-}" "${DEFAULT_ADMIN_PASSWORD_FILE:-}"
      ;;
    viewer)
      txt_resolve_secret "${DEFAULT_VIEWER_PASSWORD:-}" "${DEFAULT_VIEWER_PASSWORD_FILE:-}"
      ;;
    *)
      return 1
      ;;
  esac
}

txt_init_curl_tls_flag() {
  local insecure="${1:-0}"
  CURL_TLS_FLAG=()
  if [ "$insecure" = "1" ]; then
    CURL_TLS_FLAG=(-k)
  fi
}

txt_control_plane_login_token() {
  local control_plane_url username password insecure request_body login_body token
  control_plane_url="$(txt_resolve_control_plane_url "${1:-}")"
  username="${2:-}"
  password="${3:-}"
  insecure="${4:-0}"

  if [ -z "$username" ] || [ -z "$password" ]; then
    return 1
  fi

  request_body="$(TXT_LOGIN_USERNAME="$username" TXT_LOGIN_PASSWORD="$password" python3 - <<'PY'
import json
import os

print(json.dumps({
    "username": os.environ["TXT_LOGIN_USERNAME"],
    "password": os.environ["TXT_LOGIN_PASSWORD"],
}))
PY
)"

  txt_init_curl_tls_flag "$insecure"
  login_body="$(curl "${CURL_TLS_FLAG[@]}" --max-time 20 -sS \
    -H 'content-type: application/json' \
    -X POST "$control_plane_url/v1/auth/login" \
    --data "$request_body")" || return 1

  token="$(printf '%s' "$login_body" | python3 - <<'PY'
import json
import sys

try:
    body = json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit(0)

print(body.get("access_token", ""))
PY
)"

  if [ -z "$token" ]; then
    return 1
  fi

  printf "%s" "$token"
}