const http = require("node:http");

const port = Number.parseInt(process.env.MOCK_CONTROL_PLANE_PORT || "18011", 10);
const fallbackBaseUrl = String(process.env.MOCK_CONTROL_PLANE_FALLBACK_URL || "https://api.txt.gtixt.com").trim();
const mockAccountId = String(process.env.MOCK_CONTROL_PLANE_ACCOUNT_ID || "acc-e2e-cancel-replace").trim();
const requests = [];
let createCount = 0;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function parseJsonBody(buffer) {
  const text = buffer.toString("utf8").trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function recordRequest(req, body) {
  requests.push({
    method: req.method,
    path: req.url,
    body,
    at: new Date().toISOString(),
  });
}

function buildBrokerCapabilities() {
  return {
    provider: "bingx",
    preferred_venue: "bingx-perp",
    supports_modify: false,
    supports_cancel_replace: true,
    supports_live_cancel: true,
    replace_strategy: "cancel_replace",
    capability_source: "mock-e2e",
  };
}

function buildConnectorsStatusResponse() {
  const linkedAccount = {
    account_id: mockAccountId,
    provider: "bingx",
    mode: "trade",
    provider_type: "manual",
    venue: "bingx-perp",
    has_credentials: true,
    broker_capabilities: buildBrokerCapabilities(),
    permissions_view: {
      scopes: ["read", "trade"],
      permissions: {
        read: true,
        trade: true,
        withdraw: false,
        transfer: false,
        sign: false,
      },
      rate_limits: {},
      subaccount_restrictions: [],
      withdraw_whitelist: [],
      signature_policy: "api-hmac",
    },
  };
  return {
    status: "ok",
    observed_at: new Date().toISOString(),
    pending_live_approvals: 0,
    incident_unassigned_sla_count: 0,
    kill_switch: { active: false, reason: null },
    recent_live_approvals: [],
    alerts: [],
    linked_accounts_count: 1,
    linked_accounts: [linkedAccount],
    connectors: [
      {
        name: "bingx",
        type: "exchange",
        transport: "rest",
        healthy: true,
        rest_latency_ms: 12,
        websocket_latency_ms: 18,
        error_rate_pct: 0,
        throttling_rate_pct: 0,
        uptime_24h_pct: 100,
        uptime_7d_pct: 100,
        market_feed_venue: "bingx-perp",
        market_feed_instrument: "BTCUSDT",
        depth_levels: 40,
        messages_per_sec: 12,
        feed_quality: {
          status: "watch",
          score: 84,
          gap_count: 0,
          desync_ms: 0,
          spread_bps: 1.1,
        },
        permissions_summary: {
          aggregate: {
            read: true,
            trade: true,
            withdraw: false,
            transfer: false,
            sign: false,
          },
          linked_accounts: [],
        },
        broker_capabilities: {
          ...buildBrokerCapabilities(),
          linked_trade_accounts: 1,
        },
        capital_summary: {
          account_count: 1,
          actual_equivalent_usd: 50,
        },
        incident_summary: {},
        degradation_engine: { status: "nominal" },
        latest_sync_age_sec: 2,
      },
    ],
  };
}

async function proxyFallback(req, res, bodyBuffer, url) {
  if (!fallbackBaseUrl) {
    return false;
  }
  const target = new URL(`${url.pathname}${url.search}`, fallbackBaseUrl);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];
  const response = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyBuffer,
    redirect: "manual",
  });
  const payload = Buffer.from(await response.arrayBuffer());
  const responseHeaders = Object.fromEntries(response.headers.entries());
  delete responseHeaders["content-length"];
  delete responseHeaders["content-encoding"];
  res.writeHead(response.status, {
    ...responseHeaders,
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
  return true;
}

function buildCreateResponse(body) {
  createCount += 1;
  const orderId = `mock-order-${createCount}`;
  const clientOrderId = String(
    body?.metadata?.client_order_id
    || body?.order_intent?.broker_aware_scheduler?.child_id
    || `mock-client-${createCount}`,
  );
  return {
    status: "working",
    order_id: orderId,
    client_order_id: clientOrderId,
    provider: "bingx",
    symbol: String(body.symbol || "BTCUSDT"),
    side: String(body.side || "buy"),
    estimated_notional_usd: Number(body.estimated_notional_usd || 0),
    routed_execution: {
      venue: String(body.preferred_venue || "bingx-perp"),
      provider: "bingx",
      order_id: orderId,
      client_order_id: clientOrderId,
      symbol: String(body.symbol || "BTCUSDT"),
      side: String(body.side || "buy"),
    },
    order_intent: body.order_intent || null,
    metadata: body.metadata || null,
    cancel_replace_hint: createCount === 1 ? "await_cancel" : "replacement_live",
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const bodyBuffer = await readBody(req);
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, port });
      return;
    }
    if (req.method === "GET" && url.pathname === "/__mock/requests") {
      sendJson(res, 200, { requests });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/connectors/status") {
      sendJson(res, 200, buildConnectorsStatusResponse());
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/live-readiness/overview") {
      sendJson(res, 200, {
        status: "ok",
        drift: { suspended_strategies: [], items: [] },
        memory_kpi: { summary: {} },
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/dashboard/overview") {
      sendJson(res, 200, { status: "ok", kill_switch_active: false });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/incidents") {
      sendJson(res, 200, { status: "ok", items: [] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/mt5/orders/live-pending") {
      sendJson(res, 200, []);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/outcomes/recent") {
      sendJson(res, 200, []);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/mt5/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/broker/positions") {
      sendJson(res, 200, []);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/broker/balance") {
      sendJson(res, 200, {
        mode: "read-only",
        provider: "bingx",
        source: "mock-e2e",
        balances: [{ currency: "USDT", free: 50, locked: 0 }],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/performance/summary") {
      sendJson(res, 200, {
        trade_count: 0,
        realized_pnl_usd: 0,
        win_rate_pct: 0,
        avg_slippage_bps: 0,
        avg_latency_ms: 0,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/performance/attribution") {
      sendJson(res, 200, { rows: [] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/accounts") {
      sendJson(res, 200, [{ account_id: mockAccountId, account_type: "broker", venue: "bingx-perp", connector_type: "bingx", display_name: "Mock BingX" }]);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/connectors/accounts") {
      sendJson(res, 200, {
        status: "ok",
        accounts: [{ account_id: mockAccountId, provider: "bingx", mode: "trade", venue: "bingx-perp", broker_capabilities: buildBrokerCapabilities() }],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/investor-reports") {
      sendJson(res, 200, { items: [] });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/mt5/orders/filter") {
      const body = parseJsonBody(bodyBuffer);
      recordRequest(req, body);
      sendJson(res, 200, buildCreateResponse(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/live/orders/cancel") {
      const body = parseJsonBody(bodyBuffer);
      recordRequest(req, body);
      sendJson(res, 200, {
        status: "ok",
        provider: "bingx",
        account_id: String(body.account_id || ""),
        cancel: {
          status: "cancelled",
          order_id: String(body.order_id || ""),
          client_order_id: String(body.client_order_id || ""),
          symbol: String(body.symbol || "BTCUSDT"),
          side: String(body.side || "buy"),
        },
      });
      return;
    }
    if (await proxyFallback(req, res, bodyBuffer, url)) {
      return;
    }
    sendJson(res, 404, {
      detail: `mock control-plane route not implemented: ${req.method} ${url.pathname}`,
    });
  } catch (error) {
    sendJson(res, 500, {
      detail: error instanceof Error ? error.message : "mock_control_plane_failure",
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-control-plane-cancel-replace listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);