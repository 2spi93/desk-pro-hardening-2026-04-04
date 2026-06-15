#!/usr/bin/env bash
# TXT Docker Build Cache Guard v1 (autonome).
# Cible UNIQUEMENT le build cache Docker qui regonfle à chaque rebuild Next blue/green.
# Prune SEULEMENT `docker builder prune` (la commande dédiée au cache de build inutilisé),
# jamais `docker system prune`, jamais `--volumes`, jamais `image prune -a` automatique :
# volumes = zone rouge (Postgres / Redis / artefacts / logs / runtime).
# DRY_RUN=1 par défaut : mesure + rapport, sans rien supprimer.
# Le `status` est calculé sur l'état POST-prune → l'auto-guérison du cache reste silencieuse ;
# Telegram n'alerte que si le prune n'a PAS résolu (disque saturé par images/volumes = opérateur).
# Volontairement sans `set -e` : un sous-check qui échoue ne doit pas tuer la garde.
set -uo pipefail

ROOT_DIR="${TXT_ROOT_DIR:-/opt/txt}"
REPORT="${TXT_BUILD_CACHE_GUARD_REPORT:-$ROOT_DIR/logs/txt-docker-build-cache-guard.json}"
DRY_RUN="${TXT_BUILD_CACHE_GUARD_DRY_RUN:-1}"

# Seuils (overridables par env pour tester avec un seuil bas)
DISK_WARN="${TXT_DISK_WARN_PCT:-80}"
DISK_CRIT="${TXT_DISK_CRIT_PCT:-90}"
DISK_EMERG="${TXT_DISK_EMERG_PCT:-95}"
CACHE_WARN_GB="${TXT_BUILD_CACHE_WARN_GB:-50}"
CACHE_CRIT_GB="${TXT_BUILD_CACHE_CRIT_GB:-100}"

# Paramètres de prune par sévérité (overridables)
WARN_UNTIL="${TXT_BUILD_CACHE_WARN_UNTIL:-24h}"
CRIT_UNTIL="${TXT_BUILD_CACHE_CRIT_UNTIL:-12h}"
CRIT_KEEP="${TXT_BUILD_CACHE_CRIT_KEEP:-20GB}"
EMERG_KEEP="${TXT_BUILD_CACHE_EMERG_KEEP:-10GB}"

# Telegram
TELEGRAM_API_BASE_URL="${TELEGRAM_API_BASE_URL:-https://api.telegram.org}"
TELEGRAM_BOT_TOKEN_FILE="${TELEGRAM_BOT_TOKEN_FILE:-$ROOT_DIR/secrets/telegram_bot_token}"
TELEGRAM_CHAT_ID_FILE="${TELEGRAM_CHAT_ID_FILE:-$ROOT_DIR/secrets/telegram_chat_id}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$( [ -r "$TELEGRAM_BOT_TOKEN_FILE" ] && tr -d '\r\n' < "$TELEGRAM_BOT_TOKEN_FILE" )}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-$( [ -r "$TELEGRAM_CHAT_ID_FILE" ] && tr -d '\r\n' < "$TELEGRAM_CHAT_ID_FILE" )}"

prev_status="ok"
[ -f "$REPORT" ] && prev_status="$(python3 -c "import json;print(json.load(open('$REPORT')).get('status','ok'))" 2>/dev/null || echo ok)"

# --- helper: docker system df -> GB par catégorie (env DF_RAW) ---
df_to_gb() {
  DF_RAW="$1" python3 - <<'PY'
import os, re
units={"B":1,"KB":1e3,"K":1e3,"MB":1e6,"M":1e6,"GB":1e9,"G":1e9,"TB":1e12,"T":1e12,"KIB":1024,"MIB":1024**2,"GIB":1024**3,"TIB":1024**4}
def gb(s):
    m=re.match(r'\s*([0-9.]+)\s*([A-Za-z]+)',s or "")
    if not m: return 0.0
    return float(m.group(1))*units.get(m.group(2).upper(),1)/1e9
cats={"Images":0.0,"Build Cache":0.0,"Local Volumes":0.0}
for line in (os.environ.get("DF_RAW","").splitlines()):
    parts=line.split("\t")
    if len(parts)>=2 and parts[0].strip() in cats:
        cats[parts[0].strip()]=round(gb(parts[1]),2)
print(f"{cats['Build Cache']} {cats['Images']} {cats['Local Volumes']}")
PY
}

# --- collecte PRE ---
disk_used_pct="$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')"; disk_used_pct="${disk_used_pct:-0}"
disk_free_gb="$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')"; disk_free_gb="${disk_free_gb:-0}"
df_raw="$(docker system df --format '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}' 2>/dev/null)"
read -r cache_gb images_gb volumes_gb <<<"$(df_to_gb "$df_raw")"
cache_gb="${cache_gb:-0}"; images_gb="${images_gb:-0}"; volumes_gb="${volumes_gb:-0}"

# --- décision de sévérité déclenchante (PRE) ---
trigger="$(python3 - <<PY
disk=int("${disk_used_pct}" or 0); cache=float("${cache_gb}" or 0)
dw,dc,de=${DISK_WARN},${DISK_CRIT},${DISK_EMERG}
cw,cc=${CACHE_WARN_GB},${CACHE_CRIT_GB}
if disk>=de: print("emergency")
elif disk>=dc or cache>=cc: print("critical")
elif disk>=dw or cache>=cw: print("warning")
else: print("ok")
PY
)"

# --- action: docker builder prune ciblé selon la sévérité ---
prune_cmd=""
case "$trigger" in
  emergency) prune_cmd="docker builder prune -f -a --reserved-space ${EMERG_KEEP}" ;;
  critical)  prune_cmd="docker builder prune -f --filter until=${CRIT_UNTIL} --reserved-space ${CRIT_KEEP}" ;;
  warning)   prune_cmd="docker builder prune -f --filter until=${WARN_UNTIL}" ;;
  *)         prune_cmd="" ;;
esac

prune_ran="false"; prune_reason="below_threshold"; prune_reclaimed=""; prune_dry="false"
if [ -n "$prune_cmd" ]; then
  if [ "$DRY_RUN" = "0" ]; then
    out="$(eval "$prune_cmd" 2>&1)"; rc=$?
    prune_reclaimed="$(printf '%s\n' "$out" | grep -iE 'Total' | tail -1 | sed 's/^[[:space:]]*//')"
    if [ "$rc" -eq 0 ]; then prune_ran="true"; prune_reason="pruned_${trigger}"; else prune_reason="prune_failed_rc${rc}"; fi
    echo "[guard] prune ($trigger): $prune_cmd -> rc=$rc ${prune_reclaimed}"
  else
    prune_dry="true"; prune_reason="dry_run_${trigger}"
    echo "[guard] DRY_RUN: would run ($trigger): $prune_cmd"
  fi
fi

# --- collecte POST (re-mesure après prune) ---
disk_used_pct_post="$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')"; disk_used_pct_post="${disk_used_pct_post:-$disk_used_pct}"
disk_free_gb_post="$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')"; disk_free_gb_post="${disk_free_gb_post:-$disk_free_gb}"
df_raw_post="$(docker system df --format '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}' 2>/dev/null)"
read -r cache_gb_post images_gb_post volumes_gb_post <<<"$(df_to_gb "$df_raw_post")"
cache_gb_post="${cache_gb_post:-$cache_gb}"; images_gb_post="${images_gb_post:-$images_gb}"; volumes_gb_post="${volumes_gb_post:-$volumes_gb}"

# --- évaluation finale + JSON (status sur état POST) ---
report_json="$(python3 - <<PY
import json, datetime
disk=int("${disk_used_pct_post}" or 0); free=int("${disk_free_gb_post}" or 0)
cache=float("${cache_gb_post}" or 0); images=float("${images_gb_post}" or 0); volumes=float("${volumes_gb_post}" or 0)
dw,dc,de=${DISK_WARN},${DISK_CRIT},${DISK_EMERG}
cw,cc=${CACHE_WARN_GB},${CACHE_CRIT_GB}

alerts=[]
def add(sev,code,msg): alerts.append({"severity":sev,"code":code,"message":msg})
if disk>=de: add("emergency","disk_emergency",f"disk {disk}% >= {de}% (build-cache prune insufficient — check images/volumes)")
elif disk>=dc: add("critical","disk_critical",f"disk {disk}% >= {dc}% after guard")
elif disk>=dw: add("warning","disk_warning",f"disk {disk}% >= {dw}% after guard")
if cache>=cc: add("critical","build_cache_critical",f"build cache {cache}GB >= {cc}GB after prune")
elif cache>=cw: add("warning","build_cache_warning",f"build cache {cache}GB >= {cw}GB after prune")

order={"ok":0,"warning":1,"critical":2,"emergency":3}
status="ok"
for a in alerts:
    if order[a["severity"]]>order[status]: status=a["severity"]

report={
  "schema_version":"txt-docker-build-cache-guard/v1",
  "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"),
  "status":status,
  "dry_run": "${DRY_RUN}"!="0",
  "disk":{"used_pct":disk,"free_gb":free},
  "docker":{"build_cache_gb":cache,"images_gb":images,"volumes_gb":volumes},
  "pre_action":{"disk_used_pct":int("${disk_used_pct}" or 0),"build_cache_gb":float("${cache_gb}" or 0)},
  "action":{
    "trigger_severity":"${trigger}",
    "prune_ran": "${prune_ran}"=="true",
    "dry_run": "${prune_dry}"=="true",
    "reason":"${prune_reason}",
    "command": """${prune_cmd}""" or None,
    "reclaimed": """${prune_reclaimed}""".strip() or None,
  },
  "alerts":alerts,
}
print(json.dumps(report,indent=2))
PY
)"

printf '%s\n' "$report_json" > "$REPORT"
status="$(printf '%s' "$report_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])" 2>/dev/null || echo ok)"

# alerte Telegram seulement sur transition d'état (anti-spam)
if [ "$status" != "$prev_status" ]; then
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    text="$(printf '%s' "$report_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
emoji={'ok':'✅','warning':'⚠️','critical':'🔴','emergency':'🚨'}.get(d['status'],'')
a=d['action']
lines=[f\"{emoji} TXT build-cache guard: {d['status'].upper()} (était ${prev_status})\",
       f\"disk {d['disk']['used_pct']}% · free {d['disk']['free_gb']}GB\",
       f\"build cache {d['docker']['build_cache_gb']}GB · images {d['docker']['images_gb']}GB · volumes {d['docker']['volumes_gb']}GB\",
       f\"action: trigger={a['trigger_severity']} prune_ran={a['prune_ran']} dry_run={a['dry_run']} {a['reclaimed'] or ''}\"]
for al in d['alerts']: lines.append(f\"• [{al['severity']}] {al['message']}\")
print(chr(10).join(lines))
")"
    payload="$(python3 -c "import json,sys;print(json.dumps({'chat_id':'$TELEGRAM_CHAT_ID','text':sys.argv[1],'disable_web_page_preview':True}))" "$text")"
    curl -fsS -m 15 -H 'Content-Type: application/json' -X POST \
      --data "$payload" "${TELEGRAM_API_BASE_URL%/}/bot${TELEGRAM_BOT_TOKEN}/sendMessage" >/dev/null \
      && echo "[guard] telegram sent: $status (was $prev_status)" \
      || echo "[guard] telegram delivery FAILED" >&2
  else
    echo "[guard] telegram secrets missing, skipping alert" >&2
  fi
fi

echo "[guard] status=$status disk=${disk_used_pct_post}% build_cache=${cache_gb_post}GB trigger=${trigger} prune_ran=${prune_ran} dry_run=${DRY_RUN}"
