import { NextResponse } from "next/server";

import { requireControlPlaneSession } from "../../../../../lib/apiAuth";
import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";
import { promoteSelfLearningV5State } from "../../../../../lib/metaHarnessSafe";
import { parseSelfLearningV5Scope, readSelfLearningV5State, writeSelfLearningV5State } from "../../../../../lib/selfLearningV5Store";

function noStoreJson(payload: unknown, status = 200): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const authError = await requireControlPlaneSession();
  if (authError) {
    return authError;
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return noStoreJson({ status: "error", message: "invalid payload" }, 400);
  }

  const payload = body as Record<string, unknown>;
  const scope = parseSelfLearningV5Scope({
    accountId: payload.accountId,
    symbol: payload.symbol,
    timeframe: payload.timeframe,
  });
  const strategyId = String(payload.strategyId || "").trim();
  const rationale = String(payload.rationale || "manual_shadow_to_live").trim() || "manual_shadow_to_live";
  if (!scope || !strategyId) {
    return noStoreJson({ status: "error", message: "accountId, symbol, timeframe and strategyId are required" }, 400);
  }

  try {
    const { response: cpResponse, payload: cpPayload } = await cpFetchJsonSafe("/v1/strategies/self-learning-v5/promote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId: scope.accountId,
        symbol: scope.symbol,
        timeframe: scope.timeframe,
        strategyId,
        rationale,
      }),
    });
    if (cpResponse.ok) {
      const safePayload = cpPayload && typeof cpPayload === "object" ? cpPayload as Record<string, unknown> : {};
      return noStoreJson({
        status: "ok",
        state: safePayload.state ?? null,
        updatedAt: typeof safePayload.updated_at === "string" ? safePayload.updated_at : null,
        observation: safePayload.observation ?? null,
        audit: safePayload.audit ?? null,
        storage: "control-plane",
      }, 200);
    }
    if (cpResponse.status === 400 || cpResponse.status === 401 || cpResponse.status === 403 || cpResponse.status === 404 || cpResponse.status === 409) {
      const safePayload = cpPayload && typeof cpPayload === "object" ? cpPayload as Record<string, unknown> : {};
      const detail = safePayload.detail ?? "upstream_error";
      return noStoreJson({ status: "error", detail }, cpResponse.status);
    }
  } catch {
    // Fall through to local fallback.
  }

  const currentState = await readSelfLearningV5State(scope);
  if (!currentState) {
    return noStoreJson({ status: "error", message: "self-learning-v5 state not found" }, 404);
  }

  try {
    const result = promoteSelfLearningV5State({
      state: currentState,
      strategyId,
      promotedBy: "local-fallback",
      rationale,
    });
    const persisted = await writeSelfLearningV5State(result.state);
    return noStoreJson({
      status: "ok",
      state: persisted,
      updatedAt: persisted.updatedAt,
      observation: result.observation,
      audit: result.audit,
      storage: "local-fallback",
    }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "promotion_blocked";
    return noStoreJson({ status: "error", message }, 409);
  }
}