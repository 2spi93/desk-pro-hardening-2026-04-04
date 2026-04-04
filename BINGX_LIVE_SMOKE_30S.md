# BingX Live Smoke 30s

Use this only for the validated create-then-cancel smoke.

Validated target:

- API: `https://api.txt.gtixt.com`
- account_id: `29586394`
- symbol: `BTCUSDT`
- notional_usd: `10`

## 1. Open live window

```bash
cd /opt/txt && python3 - <<'PY'
from pathlib import Path
import json

env_path = Path('.env')
lines = env_path.read_text(encoding='utf-8').splitlines() if env_path.exists() else []
key = 'TXT_ENABLE_LIVE_ROUTING='
out = []
seen = False
for line in lines:
    if line.startswith(key):
        out.append(f'{key}1')
        seen = True
    else:
        out.append(line)
if not seen:
    out.append(f'{key}1')
env_path.write_text('\n'.join(out) + '\n', encoding='utf-8')

policy_path = Path('config/live_execution_policy.json')
policy = json.loads(policy_path.read_text(encoding='utf-8'))
policy['enabled'] = True
policy.setdefault('providers', {}).setdefault('bingx', {})['enabled'] = True
policy_path.write_text(json.dumps(policy, indent=2) + '\n', encoding='utf-8')
PY
docker compose up -d --no-deps --force-recreate control-plane
docker exec control-plane sh -lc 'printenv | grep -E "TXT_ENABLE_LIVE_ROUTING|SYSTEM_MODE" || true'
```

Expected:

- `TXT_ENABLE_LIVE_ROUTING=1`
- `SYSTEM_MODE=guarded_auto`

## 2. Run smoke

```bash
cd /opt/txt && bash scripts/bingx_live_smoke.sh \
  --control-plane-url https://api.txt.gtixt.com \
  --account-id 29586394 \
  --symbol BTCUSDT \
  --side buy \
  --notional-usd 10 \
  --confirm-live BINGX_LIVE_SMOKE \
  --insecure
```

Success shape:

```text
status=ok
create_status=open
create_order_id=<numeric>
cancel_status=cancelled
```

## 3. Close live window immediately

```bash
cd /opt/txt && python3 - <<'PY'
from pathlib import Path
import json

env_path = Path('.env')
lines = env_path.read_text(encoding='utf-8').splitlines() if env_path.exists() else []
key = 'TXT_ENABLE_LIVE_ROUTING='
env_path.write_text('\n'.join(line for line in lines if not line.startswith(key)) + '\n', encoding='utf-8')

policy_path = Path('config/live_execution_policy.json')
policy = json.loads(policy_path.read_text(encoding='utf-8'))
policy['enabled'] = False
policy.setdefault('providers', {}).setdefault('bingx', {})['enabled'] = False
policy_path.write_text(json.dumps(policy, indent=2) + '\n', encoding='utf-8')
PY
docker compose up -d --no-deps --force-recreate control-plane
docker exec control-plane sh -lc 'printenv | grep -E "TXT_ENABLE_LIVE_ROUTING|SYSTEM_MODE" || true'
cat config/live_execution_policy.json
```

Locked state expected:

- no `TXT_ENABLE_LIVE_ROUTING`
- `config/live_execution_policy.json` back to disabled
