import { NextResponse } from "next/server";

import { requireControlPlaneSession } from "../../../../../lib/apiAuth";
import { cpFetchJsonSafe } from "../../../../../lib/controlPlane";
import { runMetaHarnessSafeCycle, type MetaHarnessSafeInput } from "../../../../../lib/metaHarnessSafe";
import { writeSelfLearningV5State } from "../../../../../lib/selfLearningV5Store";

function decisionIdFromOutcome(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  return String(record.decision_id || record.decisionId || "").trim();
}

async function fetchReplayPayloads(decisionIds: string[]): Promise<Record<string, unknown>[]> {
  const uniqueIds = Array.from(new Set(decisionIds.filter(Boolean))).slice(-120);
  if (!uniqueIds.length) {
    return [];
  }
  const payloads = await Promise.all(uniqueIds.map(async (decisionId) => {
    try {
      const { response, payload } = await cpFetchJsonSafe(`/v1/execution/replay/${encodeURIComponent(decisionId)}`, { method: "GET" });
      if (!response.ok || !payload || typeof payload !== "object") {
        return null;
      }
      return payload as Record<string, unknown>;
    } catch {
      return null;
    }
  }));
  return payloads.filter((item): item is Record<string, unknown> => Boolean(item));
}

export async function POST(request: Request): Promise<NextResponse> {
  const authError = await requireControlPlaneSession();
  if (authError) {
    return authError;
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ status: "error", message: "invalid payload" }, { status: 400 });
  }
  const payload = body as MetaHarnessSafeInput;
  if (!payload.accountId || !payload.symbol || !payload.timeframe) {
    return NextResponse.json({ status: "error", message: "accountId, symbol and timeframe are required" }, { status: 400 });
  }

  const replayPayloads = await fetchReplayPayloads(
    (Array.isArray(payload.outcomes) ? payload.outcomes : []).map((item) => decisionIdFromOutcome(item)),
  );

  const state = runMetaHarnessSafeCycle({
    ...payload,
    replayPayloads,
  });
  try {
    const { response: cpResponse, payload: cpPayload } = await cpFetchJsonSafe("/v1/strategies/self-learning-v5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    if (cpResponse.ok) {
      const safePayload = cpPayload && typeof cpPayload === "object" ? cpPayload as Record<string, unknown> : {};
      return NextResponse.json({
        status: "ok",
        state: safePayload.state ?? state,
        updatedAt: typeof safePayload.updated_at === "string" ? safePayload.updated_at : state.updatedAt,
        storage: "control-plane",
      });
    }
  } catch {
    // Fall through to local persistence.
  }

  const persisted = await writeSelfLearningV5State(state);
  return NextResponse.json({ status: "ok", state: persisted, updatedAt: persisted.updatedAt, storage: "local-fallback" });
}