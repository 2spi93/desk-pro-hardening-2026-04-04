# TXT-GTIXT-COMPRESSION-ISOLATION-001

Status: CLOSED / CROSS-SERVICE-COMPRESSION-AUDITED / NO-TXT-IMPACT-OBSERVED

Date: 2026-06-18

## Purpose

GTIXT enabled gzip for firm detail JSON at the shared TLS ingress in
`OPS-COMPRESSION-002`. TXT runs on the same host and shares the
`mission-control-tls` container for public TLS termination, so this audit checks
whether GTIXT compression leaked into TXT routes.

No TXT trading, broker, execution, market-data, order, strategy, route, or
runtime behavior changed.

## Scope

Checked:

- shared TLS ingress config ownership
- active gzip directive placement
- TXT mission-control TLS config
- TXT bridge TLS config
- TXT gateway WebSocket config
- live TXT public health/API headers
- live TXT WebSocket-upgrade probe headers
- GTIXT/TXT ingress container health

Not changed:

- TXT compression policy
- GTIXT compression policy
- any app code
- any trading runtime
- any broker adapter
- any market-data stream

## Findings

### GTIXT gzip scope

GTIXT gzip is active only in:

```text
/opt/shared-ingress/gtixt-tls.conf
```

inside the HTTPS server block for:

```text
gtixt.com admin.gtixt.com data.gtixt.com
```

The global nginx `http {}` gzip directive remains commented in
`mission-control-tls`.

### TXT ingress config

TXT public configs mounted into `mission-control-tls` do not contain an active
`gzip on;` directive:

- `/opt/txt/docker/mission-control-tls.conf`
- `/opt/txt/docker/bridge-tls.conf`

TXT mission-control gateway also does not contain active gzip:

- `/opt/txt/docker/mission-control-gateway.conf`

### TXT live headers

The tested TXT routes did not return `Content-Encoding: gzip` when called with
`Accept-Encoding: br,gzip,zstd`.

| URL | Result | Content-Encoding | Notes |
|---|---:|---:|---|
| `https://bridge.txt.gtixt.com/healthz` | `200` | none | bridge health |
| `https://app.txt.gtixt.com/healthz` | `200` | none | app health |
| `https://api.txt.gtixt.com/healthz` | `200` | none | API health |
| `https://txt.gtixt.com/healthz` | `308` | none | canonical redirect |
| `https://api.txt.gtixt.com/` | `404` | none | JSON error, no gzip |
| `https://bridge.txt.gtixt.com/status` | `405` | none | JSON error, no gzip |

### TXT WebSocket probes

WebSocket-upgrade probes to TXT API routes did not return
`Content-Encoding: gzip`.

The probes returned `400 Bad Request` with an incomplete manual handshake, which
is acceptable for this audit: the important result is that no HTTP gzip was
injected into the WebSocket path by the GTIXT change.

Checked paths:

- `https://api.txt.gtixt.com/ws/v1/market/quotes`
- `https://api.txt.gtixt.com/ws/v1/market/orderbook/depth/EURUSD`
- `https://api.txt.gtixt.com/ws/v1/market/trades/EURUSD`
- `https://api.txt.gtixt.com/v1/connectors/ws`

## Decision

The GTIXT compression change does not currently cause an observed TXT problem.

Verdict:

```text
GTIXT gzip scope: isolated to GTIXT server block
TXT REST accidental gzip: not observed
TXT WebSocket accidental gzip: not observed
Double compression: not observed
Action required: none
```

## Guardrails

- Do not move GTIXT `gzip on;` into the global nginx `http {}` block without a
  new cross-service audit.
- Do not enable gzip on TXT WebSocket or live stream routes.
- If TXT later enables compression, enable it only on stable REST JSON routes
  after measuring payload size and latency.
- TXT trading/control routes must remain explicit; compression must never be
  introduced as a side effect of a GTIXT delivery optimization.

## Closure

TXT is not affected by the GTIXT firm-detail JSON gzip fix. GTIXT can compress
its public proof/data payloads, while TXT remains isolated from accidental
compression on critical public routes.
