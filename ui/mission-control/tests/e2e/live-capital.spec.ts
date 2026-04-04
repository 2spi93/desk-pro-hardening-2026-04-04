import { expect, test } from "@playwright/test";

test("live capital desk distinguishes source types and supports portfolio creation plus allocation", async ({ page }) => {
  test.setTimeout(120_000);

  const accounts = [
    {
      account_id: "mt5-live-main",
      client_id: "client-live",
      account_type: "broker",
      venue: "MT5",
      connector_type: "mt5",
      mode: "live",
      status: "active",
      display_name: "MT5 Live Main",
      portfolio_id: "pf-live-core",
      latest_equity_usd: 125000,
      gross_exposure_usd: 54000,
      net_exposure_usd: 28000,
      metadata: {},
    },
    {
      account_id: "mt5-paper-lab",
      client_id: "client-live",
      account_type: "broker",
      venue: "MT5",
      connector_type: "mt5",
      mode: "paper",
      status: "active",
      display_name: "MT5 Paper Lab",
      portfolio_id: null,
      latest_equity_usd: 25000,
      gross_exposure_usd: 0,
      net_exposure_usd: 0,
      metadata: {},
    },
  ];
  const connectorAccounts = [
    {
      provider: "Bitget",
      provider_type: "exchange",
      account_id: "bitget-primary",
      label: "Bitget Primary",
      mode: "trade",
      client_id: "client-live",
      owner_username: "operator",
      has_credentials: true,
      address: null,
    },
    {
      provider: "Ledger",
      provider_type: "wallet",
      account_id: "wallet-treasury",
      label: "Treasury Wallet",
      mode: "read",
      client_id: "client-live",
      owner_username: "operator",
      has_credentials: true,
      address: "0xabc",
    },
  ];
  const portfolios = [
    {
      portfolio_id: "pf-live-core",
      client_id: "client-live",
      name: "Live Core",
      mandate_type: "discretionary",
      risk_profile: "balanced",
      status: "active",
    },
  ];
  const strategies = [
    {
      strategy_id: "agent-live-primary",
      name: "Agent Live Primary",
      market: "fx",
      setup_type: "regime-execution",
      status: "shadow",
      current_level: 2,
    },
  ];
  const attachments: Array<{ portfolio_id: string; account_id: string; allocation_cap_usd: number; allocation_weight: number; status: string }> = [];

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

  await page.route("**/api/accounts", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({ json: accounts });
      return;
    }

    const payload = request.postDataJSON() as Record<string, unknown>;
    accounts.push({
      account_id: String(payload.account_id || ""),
      client_id: String(payload.client_id || "client-live"),
      account_type: String(payload.account_type || "exchange"),
      venue: String(payload.venue || payload.connector_type || "exchange"),
      connector_type: String(payload.connector_type || "exchange"),
      mode: String(payload.mode || "live"),
      status: String(payload.status || "active"),
      display_name: String(payload.display_name || payload.account_id || ""),
      portfolio_id: null,
      latest_equity_usd: null,
      gross_exposure_usd: null,
      net_exposure_usd: null,
      metadata: (payload.metadata as Record<string, unknown> | undefined) || {},
    });
    await route.fulfill({ json: payload });
  });

  await page.route("**/api/connectors/accounts", async (route) => {
    await route.fulfill({ json: { accounts: connectorAccounts } });
  });

  await page.route("**/api/portfolios", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({ json: portfolios });
      return;
    }

    const payload = request.postDataJSON() as Record<string, unknown>;
    portfolios.push({
      portfolio_id: String(payload.portfolio_id || ""),
      client_id: String(payload.client_id || "client-live"),
      name: String(payload.name || ""),
      mandate_type: String(payload.mandate_type || "discretionary"),
      risk_profile: String(payload.risk_profile || "balanced"),
      status: String(payload.status || "active"),
    });
    await route.fulfill({ json: payload });
  });

  await page.route(/\/api\/portfolios\/[^/]+\/accounts$/, async (route, request) => {
    const payload = request.postDataJSON() as Record<string, unknown>;
    const portfolioId = request.url().split("/").slice(-2)[0] || "";
    attachments.push({
      portfolio_id: portfolioId,
      account_id: String(payload.account_id || ""),
      allocation_cap_usd: Number(payload.allocation_cap_usd || 0),
      allocation_weight: Number(payload.allocation_weight || 0),
      status: String(payload.status || "active"),
    });
    const account = accounts.find((row) => row.account_id === payload.account_id);
    if (account) {
      account.portfolio_id = portfolioId;
    }
    await route.fulfill({ json: { ok: true, ...payload, portfolio_id: portfolioId } });
  });

  await page.route("**/api/strategies", async (route) => {
    await route.fulfill({ json: strategies });
  });

  await page.route("**/api/mt5/orders/live-pending", async (route) => {
    await route.fulfill({ json: [] });
  });

  await page.route(/\/api\/accounts\/[^/]+\/balances$/, async (route) => {
    await route.fulfill({ json: [{ asset_symbol: "USDT", available_qty: 18000, locked_qty: 0, mark_price_usd: 1, equity_usd: 18000 }] });
  });

  await page.route(/\/api\/accounts\/[^/]+\/positions$/, async (route) => {
    await route.fulfill({ json: [{ symbol: "BTCUSDT", qty: 0.5 }] });
  });

  await page.route(/\/api\/internal\/accounts\/[^/]+\/verification$/, async (route) => {
    await route.fulfill({
      json: {
        status: "ok",
        portfolio_links: [{ portfolio_id: "pf-live-core" }],
        connector_account: {
          provider: "Bitget",
          auth_method: "api_key",
          mode: "trade",
        },
        balances: [{ asset_symbol: "USDT", available_qty: 18000, locked_qty: 0, mark_price_usd: 1, equity_usd: 18000 }],
        positions: [{ symbol: "BTCUSDT", qty: 0.5 }],
      },
    });
  });

  await page.goto("/live-capital", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Sources connectées → capital gouverné → agents live" })).toBeVisible();
  await expect(page.getByText("Broker live").first()).toBeVisible();
  await expect(page.getByText("Broker paper").first()).toBeVisible();
  await expect(page.getByText("Exchange").first()).toBeVisible();
  await expect(page.getByText("Wallet").first()).toBeVisible();
  await expect(page.getByText("Bitget Primary").first()).toBeVisible();
  await expect(page.getByText("Treasury Wallet").first()).toBeVisible();

  await page.locator('input[placeholder="portfolio_id"]').fill("pf-live-client");
  await page.locator('input[placeholder="client_id"]').fill("client-live");
  await page.locator('input[placeholder="portfolio name"]').fill("Client Live Portfolio");
  await page.getByRole("button", { name: "Créer le portefeuille" }).click();
  await expect(page.getByText('"portfolio_id": "pf-live-client"')).toBeVisible();

  const allocationDesk = page.getByTestId("live-capital-allocation-desk");
  await allocationDesk.locator("select").nth(0).selectOption({ label: "Bitget Primary · exchange · exchange live" });
  await allocationDesk.locator("select").nth(1).selectOption("pf-live-client");

  await page.getByRole("button", { name: "Appeler et vérifier le compte" }).click();
  await expect(page.getByText("Total compte").first()).toBeVisible();
  await expect(page.getByText("USDT").first()).toBeVisible();

  await allocationDesk.locator('input[placeholder="allocation_weight"]').fill("0.8");
  await allocationDesk.locator('input[placeholder="allocation_cap_usd"]').fill("18000");
  await allocationDesk.getByRole("button", { name: "Allouer la source" }).click();

  await expect.poll(() => attachments.length).toBe(1);
  await expect.poll(() => accounts.some((row) => row.account_id === "bitget-primary" && row.account_type === "exchange")).toBeTruthy();
  await expect(page.getByText('"account_id": "bitget-primary"')).toBeVisible();
  await expect(page.getByText("Bitget Primary").first()).toBeVisible();
});