#!/usr/bin/env bash
# TXT Disk & Compactor monitor (D, autonome).
# Collecte disque / journal / compactor / watcher / runtime_reliability, écrit un rapport JSON,
# et alerte sur Telegram UNIQUEMENT lors d'un changement d'état (anti-spam).
# Volontairement sans `set -e` : un sous-check qui échoue ne doit pas tuer la garde.
set -uo pipefail

ROOT_DIR="${TXT_ROOT_DIR:-/opt/txt}"
REPORT="${TXT_MONITOR_REPORT:-$ROOT_DIR/logs/txt-disk-compactor-monitor.json}"
JOURNAL="${TXT_RISK_JOURNAL:-$ROOT_DIR/logs/mission-control-v2-risk-journal.jsonl}"
SLOT_FILE="$ROOT_DIR/data/mission-control/ui-active-slot.conf"

# Seuils (overridables par env pour tester avec un seuil bas)
DISK_WARN="${TXT_DISK_WARN_PCT:-85}"
DISK_CRIT="${TXT_DISK_CRIT_PCT:-90}"
DISK_EMERG="${TXT_DISK_EMERG_PCT:-95}"
JOURNAL_WARN_GB="${TXT_JOURNAL_WARN_GB:-1}"
JOURNAL_CRIT_GB="${TXT_JOURNAL_CRIT_GB:-2}"
WATCHER_STALE_SEC="${TXT_WATCHER_STALE_SEC:-300}"

# Telegram
TELEGRAM_API_BASE_URL="${TELEGRAM_API_BASE_URL:-https://api.telegram.org}"
TELEGRAM_BOT_TOKEN_FILE="${TELEGRAM_BOT_TOKEN_FILE:-$ROOT_DIR/secrets/telegram_bot_token}"
TELEGRAM_CHAT_ID_FILE="${TELEGRAM_CHAT_ID_FILE:-$ROOT_DIR/secrets/telegram_chat_id}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$( [ -r "$TELEGRAM_BOT_TOKEN_FILE" ] && tr -d '\r\n' < "$TELEGRAM_BOT_TOKEN_FILE" )}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-$( [ -r "$TELEGRAM_CHAT_ID_FILE" ] && tr -d '\r\n' < "$TELEGRAM_CHAT_ID_FILE" )}"

prev_status="ok"
[ -f "$REPORT" ] && prev_status="$(python3 -c "import json;print(json.load(open('$REPORT')).get('status','ok'))" 2>/dev/null || echo ok)"

# --- collecte (best effort) ---
disk_used_pct="$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')"; disk_used_pct="${disk_used_pct:-0}"
disk_free_gb="$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')"; disk_free_gb="${disk_free_gb:-0}"
journal_bytes="$(stat -c %s "$JOURNAL" 2>/dev/null || echo 0)"
build_cache="$(docker system df --format '{{.Type}}\t{{.Size}}' 2>/dev/null | awk -F'\t' '/Build Cache/{print $2}' | head -1)"
comp_exit="$(systemctl show txt-jsonl-compactor.service -p ExecMainStatus --value 2>/dev/null || echo '')"
comp_active="$(systemctl show txt-jsonl-compactor.service -p ActiveState --value 2>/dev/null || echo '')"
comp_last="$(systemctl show txt-jsonl-compactor.service -p ExecMainExitTimestamp --value 2>/dev/null || echo '')"

watcher_age_sec="$(python3 - "$ROOT_DIR/logs/controlled_collection_session_console.log" <<'PY' 2>/dev/null || echo -1
import sys, re, datetime
try:
    lines=[l for l in open(sys.argv[1]) if re.match(r'\d{4}-', l)]
    t=datetime.datetime.fromisoformat(re.match(r'(\S+)', lines[-1]).group(1).replace('Z','+00:00'))
    print(int((datetime.datetime.now(datetime.timezone.utc)-t).total_seconds()))
except Exception:
    print(-1)
PY
)"

# runtime_reliability + coveredHours via le slot UI actif (best effort)
active_slot="$(grep -o 'mission-control-ui-[a-z]*' "$SLOT_FILE" 2>/dev/null | head -1)"
case "$active_slot" in
  *green) slot_port=3002 ;;
  *) slot_port=3001 ;;
esac
rd_json="$(timeout 12 docker exec "${active_slot:-mission-control-ui-blue}" sh -c "wget -qO- --header \"Authorization: Bearer \$CONTROL_PLANE_TOKEN\" \"http://127.0.0.1:${slot_port}/api/system/runtime-decision?samples=1\"" 2>/dev/null || echo '')"

# --- évaluation + JSON (python) ---
report_json="$(python3 - <<PY
import json
disk_pct=int("${disk_used_pct}" or 0)
disk_free=int("${disk_free_gb}" or 0)
jbytes=int("${journal_bytes}" or 0)
jwarn=${JOURNAL_WARN_GB}*(1024**3); jcrit=${JOURNAL_CRIT_GB}*(1024**3)
dwarn,dcrit,demerg=${DISK_WARN},${DISK_CRIT},${DISK_EMERG}
watcher_age=int("${watcher_age_sec}" or -1)
comp_exit="""${comp_exit}""".strip()
rd=None
try:
    rd=json.loads('''${rd_json}''') if '''${rd_json}'''.strip() else None
except Exception:
    rd=None
reliability=None; covered=None
if isinstance(rd,dict):
    reliability=(rd.get("reliability") or {}).get("state")
    covered=((rd.get("observation") or {}).get("integrity") or {}).get("coveredHours")

alerts=[]
def add(sev,code,msg): alerts.append({"severity":sev,"code":code,"message":msg})

if disk_pct>=demerg: add("emergency","disk_emergency",f"disk {disk_pct}% >= {demerg}%")
elif disk_pct>=dcrit: add("critical","disk_critical",f"disk {disk_pct}% >= {dcrit}%")
elif disk_pct>=dwarn: add("warning","disk_warning",f"disk {disk_pct}% >= {dwarn}%")

if jbytes>=jcrit: add("critical","journal_critical",f"risk journal {jbytes/1e9:.2f}GB >= {${JOURNAL_CRIT_GB}}GB")
elif jbytes>=jwarn: add("warning","journal_warning",f"risk journal {jbytes/1e9:.2f}GB >= {${JOURNAL_WARN_GB}}GB")

if comp_exit not in ("0","",None): add("critical","compactor_failed",f"compactor ExecMainStatus={comp_exit}")

if covered is not None and int(covered or 0)==0: add("critical","covered_zero","coveredHours fell back to 0")
if watcher_age is not None and watcher_age>=0 and watcher_age>${WATCHER_STALE_SEC}: add("warning","watcher_stale",f"watcher snapshot stale {watcher_age}s")

order={"ok":0,"warning":1,"critical":2,"emergency":3}
status="ok"
for a in alerts:
    if order[a["severity"]]>order[status]: status=a["severity"]

import datetime
report={
  "schema_version":"txt-disk-compactor-monitor/v1",
  "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"),
  "status":status,
  "disk":{"used_pct":disk_pct,"free_gb":disk_free,"build_cache":"""${build_cache}""".strip() or None},
  "risk_journal":{"size_bytes":jbytes,"size_gb":round(jbytes/1e9,3)},
  "compactor":{"exec_main_status":comp_exit or None,"active_state":"""${comp_active}""".strip() or None,"last_exit_at":"""${comp_last}""".strip() or None,"parquet_status":"skipped_missing_pyarrow","archive_format":"jsonl_gzip"},
  "watcher":{"snapshot_age_sec":watcher_age},
  "runtime":{"reliability":reliability,"coveredHours":covered},
  "alerts":alerts,
}
print(json.dumps(report,indent=2))
PY
)"

# écrire le rapport
printf '%s\n' "$report_json" > "$REPORT"
status="$(printf '%s' "$report_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])" 2>/dev/null || echo ok)"

# alerte Telegram seulement sur transition d'état (anti-spam)
if [ "$status" != "$prev_status" ]; then
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    text="$(printf '%s' "$report_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
emoji={'ok':'✅','warning':'⚠️','critical':'🔴','emergency':'🚨'}.get(d['status'],'')
lines=[f\"{emoji} TXT monitor: {d['status'].upper()} (était ${prev_status})\",
       f\"disk {d['disk']['used_pct']}% · free {d['disk']['free_gb']}GB\",
       f\"risk journal {d['risk_journal']['size_gb']}GB\",
       f\"compactor exit={d['compactor']['exec_main_status']} · reliability={d['runtime']['reliability']} · coveredHours={d['runtime']['coveredHours']}\"]
for a in d['alerts']: lines.append(f\"• [{a['severity']}] {a['message']}\")
print(chr(10).join(lines))
")"
    payload="$(python3 -c "import json,sys;print(json.dumps({'chat_id':'$TELEGRAM_CHAT_ID','text':sys.argv[1],'disable_web_page_preview':True}))" "$text")"
    curl -fsS -m 15 -H 'Content-Type: application/json' -X POST \
      --data "$payload" "${TELEGRAM_API_BASE_URL%/}/bot${TELEGRAM_BOT_TOKEN}/sendMessage" >/dev/null \
      && echo "[monitor] telegram sent: $status (was $prev_status)" \
      || echo "[monitor] telegram delivery FAILED" >&2
  else
    echo "[monitor] telegram secrets missing, skipping alert" >&2
  fi
fi

echo "[monitor] status=$status disk=${disk_used_pct}% journal=$(python3 -c "print(round($journal_bytes/1e9,3))")GB"
