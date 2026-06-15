#!/usr/bin/env bash
# TXT Clean Cycles Accrual Guard v1 (autonome, READ-ONLY sur le trading).
# Transforme `clean_cycles` d'une env var posable-à-la-main en PREUVE temporelle :
# lance le gate scan, +1 si le verdict probe est propre, RESET 0 dès qu'un blocker
# revient. Écrit un rapport JSON auditable + un fichier .env consommable par le gate.
#
# Le scan de mesure force CONTROLLED_LIVE_GATE_CURRENT_CLEAN_CYCLES=0 → le gate est
# toujours évalué au tier BASE (probe), donc la mesure est stable et ne se sabote pas
# elle-même une fois 3/3 atteint. La var écrite est une SORTIE, jamais réinjectée ici.
#
# N'AGIT JAMAIS : pas de reset KS, pas de dry-run, pas de funding, pas de live,
# pas de managed_live, pas de modif policy. Il observe et compte. Point.
set -uo pipefail

ROOT_DIR="${TXT_ROOT_DIR:-/opt/txt}"
UI_DIR="$ROOT_DIR/ui/mission-control"
REPORT="${TXT_CLEAN_CYCLE_REPORT:-$ROOT_DIR/logs/controlled-live-clean-cycles.json}"
ENV_OUT="${TXT_CLEAN_CYCLE_ENV:-$ROOT_DIR/logs/controlled-live-clean-cycles.env}"
GATE_REPORT="${TXT_GATE_REPORT:-$UI_DIR/artifacts/controlled-live-ramp-gate.ops-docker.report.json}"
REQUIRED="${CONTROLLED_LIVE_REQUIRED_CLEAN_CYCLES:-3}"
SKIP_SCAN="${TXT_CLEAN_CYCLE_SKIP_SCAN:-0}"   # 1 = test sur un GATE_REPORT fourni, sans relancer le scan
HISTORY_MAX=24

# Telegram (réutilise les secrets existants).
# TELEGRAM_DRY_RUN=1 → n'envoie rien (logge seulement) : à utiliser dans les tests/fixtures
# pour ne JAMAIS toucher le vrai bot (le fallback `:-` relit sinon le fichier secret).
TELEGRAM_DRY_RUN="${TELEGRAM_DRY_RUN:-0}"
TELEGRAM_API_BASE_URL="${TELEGRAM_API_BASE_URL:-https://api.telegram.org}"
TELEGRAM_BOT_TOKEN_FILE="${TELEGRAM_BOT_TOKEN_FILE:-$ROOT_DIR/secrets/telegram_bot_token}"
TELEGRAM_CHAT_ID_FILE="${TELEGRAM_CHAT_ID_FILE:-$ROOT_DIR/secrets/telegram_chat_id}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$( [ -r "$TELEGRAM_BOT_TOKEN_FILE" ] && tr -d '\r\n' < "$TELEGRAM_BOT_TOKEN_FILE" )}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-$( [ -r "$TELEGRAM_CHAT_ID_FILE" ] && tr -d '\r\n' < "$TELEGRAM_CHAT_ID_FILE" )}"

prev_cycles=0; prev_status="unknown"
if [ -f "$REPORT" ]; then
  prev_cycles="$(python3 -c "import json;print(int(json.load(open('$REPORT')).get('clean_cycles',0)))" 2>/dev/null || echo 0)"
  prev_status="$(python3 -c "import json;print(json.load(open('$REPORT')).get('last_status','unknown'))" 2>/dev/null || echo unknown)"
fi

# --- lancer le gate scan au tier BASE (clean_cycles=0 forcé) ---
if [ "$SKIP_SCAN" != "1" ]; then
  ( cd "$UI_DIR" && CONTROLLED_LIVE_GATE_CURRENT_CLEAN_CYCLES=0 timeout 300 npm run scan:controlled-live-ramp-gate:ops-docker ) >/dev/null 2>&1
fi

# --- évaluer la propreté + accruer (python) ---
report_json="$(GATE_REPORT="$GATE_REPORT" REPORT="$REPORT" PREV_CYCLES="$prev_cycles" REQUIRED="$REQUIRED" HISTORY_MAX="$HISTORY_MAX" python3 <<'PY'
import json, os, datetime

gate_path = os.environ["GATE_REPORT"]
prev_report_path = os.environ["REPORT"]
prev_cycles = int(os.environ.get("PREV_CYCLES", "0") or 0)
required = int(os.environ.get("REQUIRED", "3") or 3)
hist_max = int(os.environ.get("HISTORY_MAX", "24") or 24)

def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

reasons = []
g = {}
try:
    d = json.load(open(gate_path))
    g = d.get("controlled_live_ramp_gate", {}) or {}
except Exception as exc:
    reasons.append(f"gate_report_unreadable:{exc!r}")

allowed = bool(g.get("allowed"))
mode = g.get("mode")
block_reasons = g.get("block_reasons") or []
ops_ok = bool(g.get("ops_verdict_available"))
ks_active = bool((g.get("kill_switch") or {}).get("active"))
degraded = g.get("degraded_runtime_truth_sources") or []
obs_source = g.get("observation_source")
backend_flags = g.get("backend_flags") or []

# Conditions de propreté (un seul point qui casse => reset 0)
if not allowed: reasons.append("not_allowed")
if mode not in ("probe", "micro_live", "reduced_live", "normal_controlled"): reasons.append(f"mode:{mode}")
if block_reasons: reasons.append("block_reasons_present")
if not ops_ok: reasons.append("ops_verdict_unavailable")
if ks_active: reasons.append("kill_switch_active")
if degraded: reasons.append("degraded_runtime_truth_sources")
if obs_source != "execution_router": reasons.append(f"observation_source:{obs_source}")
if backend_flags: reasons.append("backend_flags_present")

clean = len(reasons) == 0
clean_cycles = min(prev_cycles + 1, required) if clean else 0
status = "clean" if clean else "dirty"

# history (append, garder les derniers hist_max)
history = []
try:
    prev = json.load(open(prev_report_path))
    history = prev.get("history", []) or []
except Exception:
    history = []
history.append({
    "at": now_iso(), "status": status, "clean_cycles": clean_cycles,
    "allowed": allowed, "mode": mode, "ops_verdict_available": ops_ok,
    "block_reasons": block_reasons, "reset_reasons": reasons,
})
history = history[-hist_max:]

report = {
    "schema_version": "controlled-live-clean-cycles/v1",
    "clean_cycles": clean_cycles,
    "required_clean_cycles": required,
    "promotable": clean_cycles >= required,
    "last_status": status,
    "last_scan_at": now_iso(),
    "last_gate_mode": mode,
    "last_allowed": allowed,
    "last_block_reasons": block_reasons,
    "last_ops_verdict_available": ops_ok,
    "last_reset_reasons": reasons,
    "observation_source": obs_source,
    "backend_bus_seq": g.get("backend_bus_seq"),
    "history": history,
}
print(json.dumps(report, indent=2))
PY
)"

if [ -z "$report_json" ]; then
  echo "[clean-accrual] FAILED to build report" >&2
  exit 1
fi
printf '%s\n' "$report_json" > "$REPORT"

clean_cycles="$(printf '%s' "$report_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['clean_cycles'])" 2>/dev/null || echo 0)"
status="$(printf '%s' "$report_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['last_status'])" 2>/dev/null || echo dirty)"

# fichier .env de sortie (consommé par le gate en aval, JAMAIS réinjecté dans la mesure)
printf 'CONTROLLED_LIVE_GATE_CURRENT_CLEAN_CYCLES=%s\n' "$clean_cycles" > "$ENV_OUT"

# --- alertes Telegram sur transitions significatives uniquement (anti-spam) ---
notify() {
  local text="$1"
  if [ "$TELEGRAM_DRY_RUN" = "1" ]; then
    echo "[clean-accrual] telegram (dry-run, suppressed): $text"
    return 0
  fi
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    local payload
    payload="$(python3 -c "import json,sys;print(json.dumps({'chat_id':'$TELEGRAM_CHAT_ID','text':sys.argv[1],'disable_web_page_preview':True}))" "$text")"
    curl -fsS -m 15 -H 'Content-Type: application/json' -X POST \
      --data "$payload" "${TELEGRAM_API_BASE_URL%/}/bot${TELEGRAM_BOT_TOKEN}/sendMessage" >/dev/null \
      && echo "[clean-accrual] telegram sent" || echo "[clean-accrual] telegram FAILED" >&2
  fi
}

# régression : on avait accumulé (>0) et on retombe à 0
if [ "$status" = "dirty" ] && [ "${prev_cycles:-0}" -gt 0 ]; then
  rr="$(printf '%s' "$report_json" | python3 -c "import json,sys;print(', '.join(json.load(sys.stdin).get('last_reset_reasons',[])) or 'unknown')")"
  notify "⚠️ TXT clean-cycles REGRESSION: reset $prev_cycles → 0/$REQUIRED · cause: $rr"
fi
# jalon : on atteint le requis pour la première fois (transition)
if [ "$status" = "clean" ] && [ "$clean_cycles" -ge "$REQUIRED" ] && [ "${prev_cycles:-0}" -lt "$REQUIRED" ]; then
  notify "✅ TXT clean-cycles $REQUIRED/$REQUIRED atteint — gate promotable (probe → micro_live). Prochaine étape = dry-run dry_run=true, PAS live."
fi

echo "[clean-accrual] status=$status clean_cycles=${clean_cycles}/${REQUIRED} (was ${prev_cycles}) mode=$(printf '%s' "$report_json" | python3 -c "import json,sys;print(json.load(sys.stdin).get('last_gate_mode'))" 2>/dev/null)"
