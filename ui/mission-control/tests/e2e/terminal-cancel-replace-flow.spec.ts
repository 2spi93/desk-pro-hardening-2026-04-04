import { expect, test } from "@playwright/test";

test("cancel/replace flow proxies through the local mock control-plane", async ({ request }) => {
  test.setTimeout(120_000);

  const createPayload = {
    account_id: "acc-e2e-cancel-replace",
    symbol: "BTCUSDT",
    side: "buy",
    estimated_notional_usd: 50,
    preferred_venue: "bingx-perp",
    rationale: "playwright cancel/replace create",
    order_intent: {
      source: "playwright-e2e",
      mode: "cancel-replace",
      broker_aware_scheduler: {
        mode: "CANCEL_REPLACE",
        action: "CANCEL_REPLACE",
        child_id: "BTCUSDT-buy-1",
        child_index: 1,
        child_count: 2,
        schedule_score: 0.71,
      },
    },
    metadata: {
      scenario: "cancel-replace-e2e",
      client_order_id: "mock-client-create-1",
    },
  };

  const createResponse = await request.post("/api/mt5/orders/filter", { data: createPayload });
  expect(createResponse.ok()).toBeTruthy();
  const created = await createResponse.json();
  expect(created.order_id).toBe("mock-order-1");
  expect(created.client_order_id).toBe("mock-client-create-1");

  const cancelResponse = await request.post("/api/live/orders/cancel", {
    data: {
      provider: "bingx",
      account_id: "acc-e2e-cancel-replace",
      symbol: "BTCUSDT",
      side: "buy",
      order_id: created.order_id,
      client_order_id: created.client_order_id,
      notional_usd: 50,
    },
  });
  expect(cancelResponse.ok()).toBeTruthy();
  const cancelled = await cancelResponse.json();
  expect(cancelled.cancel?.status).toBe("cancelled");
  expect(cancelled.cancel?.order_id).toBe("mock-order-1");

  const replaceResponse = await request.post("/api/mt5/orders/filter", {
    data: {
      ...createPayload,
      rationale: "playwright cancel/replace replace",
      order_intent: {
        ...createPayload.order_intent,
        broker_aware_scheduler: {
          ...createPayload.order_intent.broker_aware_scheduler,
          child_id: "BTCUSDT-buy-1-r1",
          replace_count: 1,
          replaces_order_id: created.order_id,
        },
      },
      metadata: {
        ...createPayload.metadata,
        client_order_id: "mock-client-replace-1",
        replaces_order_id: created.order_id,
      },
    },
  });
  expect(replaceResponse.ok()).toBeTruthy();
  const replaced = await replaceResponse.json();
  expect(replaced.order_id).toBe("mock-order-2");
  expect(replaced.client_order_id).toBe("mock-client-replace-1");

  const mockControlPlaneUrl = process.env.PLAYWRIGHT_CONTROL_PLANE_URL || process.env.CONTROL_PLANE_URL;
  expect(mockControlPlaneUrl).toBeTruthy();
  const recordedResponse = await request.get(`${mockControlPlaneUrl}/__mock/requests`);
  expect(recordedResponse.ok()).toBeTruthy();
  const recorded = await recordedResponse.json();
  expect(Array.isArray(recorded.requests)).toBeTruthy();
  expect(recorded.requests).toHaveLength(3);
  expect(recorded.requests[0].path).toBe("/v1/mt5/orders/filter");
  expect(recorded.requests[1].path).toBe("/v1/live/orders/cancel");
  expect(recorded.requests[2].path).toBe("/v1/mt5/orders/filter");
  expect(recorded.requests[1].body.order_id).toBe("mock-order-1");
  expect(recorded.requests[2].body.metadata.replaces_order_id).toBe("mock-order-1");
});