import { expect, test } from "@playwright/test";

test("runtime smoke covers terminal, live ops, connectors and connections", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/login", { waitUntil: "domcontentloaded" });
  const origin = new URL(page.url()).origin;
  const payload = Buffer.from(JSON.stringify({ role: "operator", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  await page.context().addCookies([
    {
      name: "mc_token",
      value: `${payload}.signature`,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https://"),
    },
    {
      name: "mc_token_compat",
      value: `${payload}.signature`,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https://"),
    },
  ]);

  await page.route("**/api/system/mode", async (route) => {
    await route.fulfill({ json: { detail: "Mode systeme mis a jour" } });
  });

  await page.route("**/api/system/live-ops", async (route) => {
    await route.fulfill({
      json: {
        watchdog_state: { status: "OK" },
        governance: { backend_mode: "guarded_auto" },
        recovery: {},
        memory_gap: {},
        alerts: [],
        risk_snapshot: { dd_pct: 0.6 },
      },
    });
  });

  await page.route("**/api/dashboard/overview", async (route) => {
    await route.fulfill({
      json: {
        system_mode: "guarded_auto",
        kill_switch_active: false,
        open_alerts: 0,
      },
    });
  });

  await page.route("**/api/execution/optimizer/live-state", async (route) => {
    await route.fulfill({
      json: {
        state: "stable",
        summary: { latency_budget_ms: 80, slippage_budget_bps: 1.5 },
      },
    });
  });

  await page.route("**/api/market/venues/telemetry", async (route) => {
    await route.fulfill({
      json: {
        items: [
          {
            venue: "binance-public",
            freshness_ms: 45,
            spread_bps: 0.9,
            fill_quality: "good",
          },
        ],
      },
    });
  });

  await page.route("**/api/execution/routing/venues/telemetry**", async (route) => {
    await route.fulfill({
      json: {
        items: [
          {
            venue: "binance-public",
            score_gap: 0.11,
            latency_ms: 42,
          },
        ],
      },
    });
  });

  await page.route("**/api/outcomes/recent**", async (route) => {
    await route.fulfill({
      json: [
        {
          decision_id: "outcome-1",
          symbol: "BTCUSD",
          side: "buy",
          net_result_usd: 24.5,
          created_at: new Date().toISOString(),
        },
      ],
    });
  });

  await page.route("**/api/execution/replay/**", async (route) => {
    await route.fulfill({
      json: {
        decision_id: "outcome-1",
        steps: [],
        summary: { status: "ok" },
      },
    });
  });

  await page.route("**/api/market/quotes", async (route) => {
    await route.fulfill({
      json: [
        {
          instrument: "BTCUSD",
          bid: 68000.1,
          ask: 68000.7,
          last: 68000.4,
        },
      ],
    });
  });

  await page.route("**/api/broker/positions", async (route) => {
    await route.fulfill({
      json: [
        {
          symbol: "BTCUSD",
          side: "long",
          qty: 0.01,
          unrealized_pnl_usd: 4.2,
        },
      ],
    });
  });

  await page.route("**/api/broker/balance", async (route) => {
    await route.fulfill({
      json: {
        equity_usd: 25000,
        free_margin_usd: 18000,
      },
    });
  });

  await page.route("**/api/performance/summary**", async (route) => {
    await route.fulfill({
      json: {
        realized_pnl_usd: 132.5,
        win_rate_pct: 62.5,
      },
    });
  });

  await page.route("**/api/performance/attribution**", async (route) => {
    await route.fulfill({
      json: {
        rows: [
          {
            strategy: "mt5-live",
            symbol: "BTCUSD",
            venue: "binance-public",
            pnl_usd: 132.5,
          },
        ],
      },
    });
  });

  await page.route("**/api/investor-reports**", async (route) => {
    await route.fulfill({ json: { items: [] } });
  });

  await page.route("**/api/execution/reality-gap/recent**", async (route) => {
    await route.fulfill({ json: { items: [] } });
  });

  await page.route("**/api/execution/pnl-analyzer**", async (route) => {
    await route.fulfill({
      json: {
        summary: {
          trade_count: 8,
          avg_latency_ms: 42,
          avg_slippage_bps: 0.8,
          net_pnl_usd: 132.5,
          high_confidence_loss_count: 0,
          no_trade_dominance_count: 3,
          win_rate_pct: 62.5,
          avg_pnl_usd: 16.5,
        },
        trades: [
          {
            net_result_usd: 42.5,
            latency_ms: 38,
            slippage_real_bps: 0.6,
            confidence: 0.74,
            fallback_mode: "normal",
            no_trade_dominance: false,
          },
        ],
      },
    });
  });

  await page.route("**/api/execution/ai/v6/state", async (route) => {
    await route.fulfill({ json: { snapshot: { guardrails: { learning_frozen: false } } } });
  });

  await page.route("**/api/terminal/v2-risk-journal**", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        json: {
          entries: [
            {
              id: "journal-1",
              createdAtIso: new Date().toISOString(),
              symbol: "BTCUSD",
              timeframe: "1m",
              strategy: "scalp",
              action: "override-visible-on",
              detail: "micro-size pour test strict",
              meta: { forced_action: "ENTRY SMALL" },
            },
          ],
        },
      });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      json: {
        ok: true,
        entry: {
          id: `journal-${Date.now()}`,
          createdAtIso: new Date().toISOString(),
          symbol: String(body.symbol || "BTCUSD"),
          timeframe: String(body.timeframe || "1m"),
          strategy: String(body.strategy || "scalp"),
          action: String(body.action || "note"),
          detail: String(body.detail || ""),
          meta: body.meta && typeof body.meta === "object" ? body.meta : {},
        },
      },
    });
  });

  await page.route("**/api/connectors/status", async (route) => {
    await route.fulfill({ json: { alerts: [], connector_status: [], degradation_rows: [] } });
  });
  await page.route("**/api/mt5/health", async (route) => {
    await route.fulfill({ json: { status: "ok", latency_ms: 12 } });
  });
  await page.route("**/api/mt5/accounts", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({ json: [{ account_id: "mt5-demo-01", broker: "metaquotes", server: "MetaQuotes-Demo", login: "10001234", mode: "paper" }] });
      return;
    }
    await route.fulfill({ json: { ok: true, account_id: "mt5-smoke" } });
  });
  await page.route("**/api/accounts", async (route) => {
    await route.fulfill({ json: [{ account_id: "mt5-demo-01", account_type: "broker", display_name: "MT5 Demo", latest_equity_usd: 25000, gross_exposure_usd: 0, net_exposure_usd: 0 }] });
  });
  await page.route("**/api/portfolios/pf-internal-main/risk", async (route) => {
    await route.fulfill({ json: { risk_budget_usd: 1500, heat: "clean" } });
  });
  await page.route("**/api/mt5/orders/live-pending", async (route) => {
    await route.fulfill({ json: [{ approval_id: "approval-1", symbol: "EURUSD", side: "buy", lots: 0.1 }] });
  });
  await page.route("**/api/auth/ws-token", async (route) => {
    await route.fulfill({ json: { token: "smoke-token", controlPlaneUrl: "http://127.0.0.1:3000" } });
  });
  await page.route("**/api/system/mt5-rebuild", async (route) => {
    await route.fulfill({ json: { ok: true, detail: "rebuild queued" } });
  });
  await page.route("**/api/mt5/orders/filter", async (route) => {
    await route.fulfill({ json: { ok: true, order_id: "filter-1" } });
  });
  await page.route("**/api/ai/regimes/detect", async (route) => {
    await route.fulfill({ json: { regime: "trend", confidence: 0.72 } });
  });
  await page.route("**/api/ai/backtests/geopolitical", async (route) => {
    await route.fulfill({ json: { scenario: "Fed emergency hike", pnl_usd: -42 } });
  });
  await page.route("**/api/incidents", async (route) => {
    await route.fulfill({ json: { ok: true, incident_id: "INC-SMOKE" } });
  });

  await page.route("**/api/connectors/accounts", async (route) => {
    await route.fulfill({
      json: {
        accounts: [
          {
            provider: "bitget",
            provider_type: "exchange",
            account_id: "bitget-primary",
            label: "Bitget Primary",
            mode: "trade",
            auth_method: "api_key",
            client_id: "client-live",
            owner_username: "operator",
            has_credentials: true,
            address: null,
          },
          {
            provider: "ledger",
            provider_type: "wallet",
            account_id: "wallet-treasury",
            label: "Treasury Wallet",
            mode: "read",
            auth_method: "wallet_public_key",
            client_id: "client-live",
            owner_username: "operator",
            has_credentials: true,
            address: "0xabc",
          },
        ],
      },
    });
  });
  await page.route("**/api/integrations/routes", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({ json: { routes: [{ source: "kairos", route_key: "default", account_id: "bitget-primary", preferred_venue: "bitget", notional_usd: 7, live_enabled: true }] } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/connectors/exchange-capabilities", async (route) => {
    await route.fulfill({ json: { bitget: { api_key_requires_passphrase: true } } });
  });
  await page.route("**/api/connectors/accounts/link-api-key", async (route) => {
    await route.fulfill({ json: { ok: true, account_id: "bitget-smoke" } });
  });
  await page.route("**/api/connectors/accounts/link", async (route) => {
    await route.fulfill({ json: { ok: true, account_id: "wallet-smoke" } });
  });

  await page.goto("/terminal?v2=1&boot=full", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mission-control-terminal-page")).toBeVisible();
  await expect(page.getByTestId("terminal-brain-stats")).toBeVisible({ timeout: 30_000 });

  await page.goto("/live-ops", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mission-control-live-ops-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "H24 Control Room" })).toBeVisible();
  await page.getByRole("button", { name: "Recaler le sprint a aujourd'hui", exact: true }).click();
  await page.getByRole("button", { name: "Suggest", exact: true }).click();

  await page.goto("/connectors", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mission-control-connectors-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connecteurs trading augmentes" })).toBeVisible();
  await page.getByPlaceholder("scenario").fill("Smoke macro shock");
  await page.getByRole("button", { name: "Lancer backtest", exact: true }).click();
  await page.getByPlaceholder("account_id").fill("mt5-smoke-01");
  await page.getByRole("button", { name: "Connecter le compte", exact: true }).click();

  await page.goto("/connections", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("mission-control-connections-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Vos connexions de trading" })).toBeVisible();
  await page.getByPlaceholder("Identifiant du compte sur l'exchange ou sous-compte").fill("bitget-smoke");
  await page.getByPlaceholder("Clé API").fill("key-smoke");
  await page.getByPlaceholder("Secret API").fill("secret-smoke");
  await page.getByPlaceholder(/Passphrase API/).fill("pass-smoke");
  await page.getByRole("button", { name: "Enregistrer le compte", exact: true }).click();
  await page.getByPlaceholder("adresse publique / custody ref").fill("0xfeedbeef");
  await page.getByPlaceholder("account label / wallet / API ref").fill("wallet-smoke-ref");
  await page.getByRole("button", { name: "Creer demande d'onboarding", exact: true }).click();
});