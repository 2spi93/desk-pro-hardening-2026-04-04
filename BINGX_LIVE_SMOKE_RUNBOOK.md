# BingX Live Smoke Runbook

This runbook is the shortest known path to rerun the BingX live smoke in this environment without redoing the prior investigation.

Current validated target in this workspace:

- API host: `https://api.txt.gtixt.com`
- Linked BingX account: `29586394`
- Smoke symbol: `BTCUSDT`
- Smoke notional: `10 USD`

The live smoke was validated with this expected end-state:

- `create_status=open`
- `create_order_id=<numeric id>`
- `cancel_status=cancelled`

## 1. Two-Minute Smoke

### 1.1 Open the temporary live window

```bash
cd /opt/txt

python3 - <<'PY'
from pathlib import Path
import json

env_path = Path('.env')
lines = env_path.read_text(encoding='utf-8').splitlines()
key = 'TXT_ENABLE_LIVE_ROUTING='
found = False
new_lines = []
for line in lines:
    if line.startswith(key):
        new_lines.append(f'{key}1')
        found = True
    else:
        new_lines.append(line)
if not found:
    new_lines.append(f'{key}1')
env_path.write_text('\n'.join(new_lines) + '\n', encoding='utf-8')

policy_path = Path('config/live_execution_policy.json')
policy = json.loads(policy_path.read_text(encoding='utf-8'))
policy['enabled'] = True
policy.setdefault('providers', {}).setdefault('bingx', {})['enabled'] = True
policy_path.write_text(json.dumps(policy, indent=2) + '\n', encoding='utf-8')
PY

docker compose up -d --no-deps --force-recreate control-plane
docker exec control-plane sh -lc 'printenv | grep -E "TXT_ENABLE_LIVE_ROUTING|SYSTEM_MODE" || true'
```

Expected runtime check:

- `TXT_ENABLE_LIVE_ROUTING=1`
- `SYSTEM_MODE=guarded_auto`

`guarded_auto` is correct for the smoke. Do not switch to `managed_live` just to run the smoke.

### 1.2 Run the smoke

```bash
cd /opt/txt

bash scripts/bingx_live_smoke.sh \
  --control-plane-url https://api.txt.gtixt.com \
  --account-id 29586394 \
  --symbol BTCUSDT \
  --side buy \
  --notional-usd 10 \
  --confirm-live BINGX_LIVE_SMOKE \
  --insecure
```

Expected success shape:

```text
status=ok
provider=bingx
account_id=29586394
symbol=BTCUSDT
side=buy
notional_usd=10.0
reference_price=...
limit_price=...
create_status=open
create_order_id=...
cancel_status=cancelled
```

### 1.3 Close the temporary live window immediately after the smoke

```bash
cd /opt/txt

python3 - <<'PY'
from pathlib import Path
import json

env_path = Path('.env')
lines = env_path.read_text(encoding='utf-8').splitlines()
key = 'TXT_ENABLE_LIVE_ROUTING='
new_lines = [line for line in lines if not line.startswith(key)]
env_path.write_text('\n'.join(new_lines) + '\n', encoding='utf-8')

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

Expected post-smoke lock state:

- no `TXT_ENABLE_LIVE_ROUTING` in the running `control-plane`
- `SYSTEM_MODE=guarded_auto`
- `config/live_execution_policy.json` back to `enabled=false`

## 2. Pre-Agent Activation Sequence

These checks are for enabling actual BingX agent routing after the smoke, not for the smoke itself.

### 2.1 Get an operator token

```bash
cd /opt/txt

OPERATOR_PASSWORD="$(tr -d '\n' < secrets/default_operator_password)"
TOKEN="$({
  curl -k -sS \
    -H 'content-type: application/json' \
    -X POST https://api.txt.gtixt.com/v1/auth/login \
    --data "{\"username\":\"operator\",\"password\":\"$OPERATOR_PASSWORD\"}"
} | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token", ""))')"

test -n "$TOKEN"
```

### 2.2 Check the linked connector account

```bash
curl -k -sS \
  -H "Authorization: Bearer $TOKEN" \
  https://api.txt.gtixt.com/v1/connectors/accounts \
  | python3 -m json.tool
```

Required result for the BingX account used by the agent:

- `provider = bingx`
- `account_id = 29586394`
- `mode = trade`
- `has_credentials = true`

### 2.3 Check the canonical account entry

```bash
curl -k -sS \
  -H "Authorization: Bearer $TOKEN" \
  'https://api.txt.gtixt.com/v1/accounts?venue=bingx' \
  | python3 -m json.tool
```

Required result:

- canonical account `29586394`
- `venue = bingx`
- `mode = live`
- `status = active`

### 2.4 Check the route flag

The agent path uses route-level `live_enabled`. The smoke path does not depend on this.

```bash
curl -k -sS \
  -H "Authorization: Bearer $TOKEN" \
  https://api.txt.gtixt.com/v1/integrations/routes \
  | python3 -m json.tool
```

Required result on the route that will drive BingX live execution:

- `provider = bingx`
- `account_id = 29586394`
- `live_enabled = true`
- `preferred_venue = bingx`

If needed, upsert a route explicitly:

```bash
SOURCE='<your-source>'
ROUTE_KEY='default'

curl -k -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -X POST https://api.txt.gtixt.com/v1/integrations/routes \
  --data "{
    \"source\": \"$SOURCE\",
    \"route_key\": \"$ROUTE_KEY\",
    \"provider\": \"bingx\",
    \"account_id\": \"29586394\",
    \"live_enabled\": true,
    \"preferred_venue\": \"bingx\",
    \"notional_usd\": 10
  }" \
  | python3 -m json.tool
```

### 2.5 Check the system mode

For the smoke, `guarded_auto` is allowed.

For real agent live execution, the live policy requires `managed_live`.

Check current runtime mode:

```bash
curl -k -sS https://api.txt.gtixt.com/health | python3 -m json.tool
docker exec control-plane sh -lc 'printenv | grep SYSTEM_MODE'
```

Agent live routing must not be enabled while `system_mode != managed_live`.

### 2.6 Check the live gates

Before agent activation, all three gates must be true at the same time:

1. Runtime env gate: `TXT_ENABLE_LIVE_ROUTING=1`
2. Policy gate: `config/live_execution_policy.json` has global and BingX `enabled=true`
3. Route gate: target route has `live_enabled=true`

If any one of the three is off, the webhook route should stay blocked.

## 3. Immediate Rollback

If anything looks wrong before or after agent activation, rollback in this order:

### 3.1 Kill the route gate

Set the relevant integration route back to `live_enabled=false`.

```bash
SOURCE='<your-source>'
ROUTE_KEY='default'

curl -k -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -X POST https://api.txt.gtixt.com/v1/integrations/routes \
  --data "{
    \"source\": \"$SOURCE\",
    \"route_key\": \"$ROUTE_KEY\",
    \"provider\": \"bingx\",
    \"account_id\": \"29586394\",
    \"live_enabled\": false,
    \"preferred_venue\": \"paper-bingx\",
    \"notional_usd\": 10
  }" \
  | python3 -m json.tool
```

### 3.2 Kill the policy gate and env gate

Use the same disable block from section 1.3.

### 3.3 Recreate control-plane

```bash
docker compose up -d --no-deps --force-recreate control-plane
docker exec control-plane sh -lc 'printenv | grep -E "TXT_ENABLE_LIVE_ROUTING|SYSTEM_MODE" || true'
```

### 3.4 Verify lock state

Expected final state:

- route no longer `live_enabled=true`
- policy disabled
- no `TXT_ENABLE_LIVE_ROUTING` in runtime
- `system_mode` no longer relied upon for live routing

## 4. Capability Status

### 4.1 Kairos Trading Agent (always-on market AI)

Verdict: `partial`, not fully in place as an always-on runtime trading loop.

What exists:

- `apps/ai_orchestrator/agents_framework.py` contains the trading-agent framework and agent taxonomy.
- `apps/ai_orchestrator/agents_specialized.py` contains specialized trading agents.

What is missing from a strict `Kairos always-on` claim:

- no dedicated `Kairos` component name found in the repo
- no explicit always-on market loop wired as the running `ai-orchestrator` service
- `apps/ai_orchestrator/main.py` is an API service, not a continuously running market-execution agent loop

### 4.2 Reality Gap -> auto strategy mutation

Verdict: `partial-to-implemented` at calibration level, not full strategy-genome mutation.

What exists:

- `apps/predictor_v8/reality_gap.py` compares predicted vs realized execution and builds calibration factors.
- `apps/predictor_v8/reality_gap.py` also recommends calibration actions and emits learning payloads.
- `ui/mission-control/app/advanced/reality-gap/page.tsx` exposes the reality-gap view in Mission Control.

What is not fully proven from the current code:

- I do not see a full autonomous strategy mutator that rewrites strategy configs or rotates strategy definitions end-to-end.
- What is clearly implemented is execution/predictor profile recalibration, not a full self-mutating strategy catalog.

### 4.3 Execution-aware RL (reward based on real fills)

Verdict: `implemented`.

Evidence:

- `apps/predictor_v8/reality_gap.py` builds reward from realized execution gaps, slippage, fill probability, latency, impact, and queue features.
- The learning payload explicitly writes `experience.reward`, `raw_reward`, `state`, and `next_state` using predicted vs realized execution fields.
- `apps/execution_router/main.py` and the live/paper execution path provide the fill-aware execution surface that this learning loop consumes.

This means the RL/replay side is execution-aware and tied to realized execution data, not only paper intent outputs.
